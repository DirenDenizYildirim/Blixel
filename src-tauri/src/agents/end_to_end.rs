//! End to end: real agent sessions (`session::run`) with the stand-in
//! (`crate::stand_in`) as the agent program, so the protocol, the
//! workspace's tool server, the connector gateway, permission requests, Stop,
//! resuming and spending are all exercised as with Claude Code, without a
//! key or the network. The stand-in is the app's binary, which `cargo test`
//! builds because of `tests/stand_in.rs`.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::connectors::Hub;
use crate::events::Events;
use crate::store::{Db, DbRef};

use super::permissions::{Answer, Broker};
use super::runtime::AgentRuntime;
use super::session::{self, Command, Launch};
use super::settings::{AgentConfig, Permissions, Setting, STAND_IN};
use super::usage::{self, Books};

const WAIT: Duration = Duration::from_secs(30);

/// The app's binary beside this test's (target/debug/deps/..).
fn stand_in() -> PathBuf {
    let exe = std::env::current_exe().unwrap();
    let app = exe.parent().and_then(|deps| deps.parent()).unwrap().join(format!("blixel{}", std::env::consts::EXE_SUFFIX));
    assert!(app.exists(), "{} is missing: run `cargo test` without --lib, so cargo builds the app's binary", app.display());
    app
}

fn config() -> AgentConfig {
    AgentConfig {
        id: "ada".into(),
        name: "Ada".into(),
        instructions: String::new(),
        read_notes: false,
        permissions: Permissions { read: Setting::Allow, edit: Setting::Allow, run: Setting::Allow, commit: Setting::Off, push: Setting::Off },
        edit_paths: String::new(),
        rule_packs: vec![],
        connectors: Default::default(),
        model: "stand-in".into(),
        effort: "medium".into(),
        program: STAND_IN.into(),
        daily_limit: String::new(),
    }
}

/// One agent with the stand-in as its program, in a folder of its own, and
/// everything the core tells the interface. Permission requests are answered
/// with `answer`, when set.
struct Harness {
    /// Everything of the test's own, removed at the end.
    base: PathBuf,
    root: PathBuf,
    config_dir: PathBuf,
    rt: Arc<AgentRuntime>,
    hub: Arc<Hub>,
    db: Arc<Db>,
    log: Arc<Mutex<Vec<(String, Value)>>>,
    answer: Arc<Mutex<Option<Answer>>>,
    tx: Option<mpsc::UnboundedSender<Command>>,
    task: Option<JoinHandle<Result<(), String>>>,
    /// The session id the agent last reported.
    session: Arc<Mutex<Option<String>>>,
    next: usize,
}

impl Harness {
    fn new(name: &str, config: AgentConfig) -> Self {
        let base = std::env::temp_dir().join(format!("blixel-e2e-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("project")).unwrap();
        let root = base.join("project").canonicalize().unwrap();
        let broker = Arc::new(Broker::default());
        let log: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
        let answer: Arc<Mutex<Option<Answer>>> = Arc::default();
        let events = Events::to_sink({
            let (log, answer, broker) = (log.clone(), answer.clone(), broker.clone());
            move |name, payload| {
                log.lock().unwrap().push((name.to_string(), payload.clone()));
                if name == "agent://permission" {
                    if let Some(answer) = *answer.lock().unwrap() {
                        broker.answer(payload["requestId"].as_str().unwrap(), answer);
                    }
                }
            }
        });
        let hub = Arc::new(Hub::detached(
            Db::open(&base.join("data")).unwrap(),
            Box::new(crate::connectors::store::testing::MemoryKeys::default()),
            events.clone(),
            base.join("work"),
        ));
        // Spending goes to a project's rows, as in the app.
        let db = Arc::new(Db::memory());
        db.lock().unwrap().execute("INSERT INTO projects (id, name, folder, created, last_opened) VALUES ('p1', 'p1', '/p1', 1, 1)", []).unwrap();
        let rt = AgentRuntime::new(config, events, broker);
        rt.usage.keep_in(Books { db: DbRef::Own(db.clone()), project: "p1".into() });
        let config_dir = base.join("config");
        Harness { base, root, config_dir, rt, hub, db, log, answer, tx: None, task: None, session: Arc::default(), next: 0 }
    }

    /// Starts the agent's program, carrying on `resume` if given.
    fn start(&mut self, resume: Option<String>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let session = self.session.clone();
        let task = tokio::spawn(session::run(
            self.rt.clone(),
            self.root.clone(),
            self.config_dir.clone(),
            Launch::StandIn { exe: stand_in() },
            self.hub.clone(),
            resume,
            Box::new(move |id| *session.lock().unwrap() = Some(id.to_string())),
            rx,
        ));
        self.tx = Some(tx);
        self.task = Some(task);
    }

    /// Ends the agent's program, as closing its channel does in the app.
    async fn stop(&mut self) {
        self.tx = None;
        let outcome = tokio::time::timeout(WAIT, self.task.take().unwrap()).await.expect("the session ended").unwrap();
        assert!(outcome.is_ok(), "{outcome:?}");
    }

    fn send(&mut self, text: &str) -> String {
        self.next += 1;
        let id = format!("u{}", self.next);
        self.command(Command::Prompt { id: id.clone(), text: text.into() });
        id
    }

    fn command(&self, command: Command) {
        assert!(self.tx.as_ref().unwrap().send(command).is_ok(), "the session is gone:\n{}", self.dump(0));
    }

    fn len(&self) -> usize {
        self.log.lock().unwrap().len()
    }

    fn dump(&self, from: usize) -> String {
        self.log.lock().unwrap().iter().skip(from).map(|(name, payload)| format!("{name} {payload}")).collect::<Vec<_>>().join("\n")
    }

    /// Waits for an event at or after `from` that `matches`, and returns its index.
    async fn wait_for(&self, from: usize, what: &str, matches: impl Fn(&str, &Value) -> bool) -> usize {
        let started = Instant::now();
        loop {
            let found = self.log.lock().unwrap().iter().enumerate().skip(from).find(|(_, (n, p))| matches(n, p)).map(|(i, _)| i);
            if let Some(i) = found {
                return i;
            }
            assert!(started.elapsed() < WAIT, "no {what} after event {from}:\n{}", self.dump(0));
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn status(&self, from: usize, wanted: &[&str]) -> usize {
        self.wait_for(from, &format!("status {wanted:?}"), |n, p| n == "agent://status" && wanted.contains(&p["status"].as_str().unwrap_or_default()))
            .await
    }

    /// Sends a message and waits for the turn it starts to end. Returns
    /// where its events start.
    async fn turn(&mut self, text: &str) -> usize {
        let from = self.len();
        self.send(text);
        let working = self.status(from, &["working"]).await;
        self.status(working, &["idle", "limited"]).await;
        from
    }

    /// Everything the agent said since `from`.
    fn said(&self, from: usize) -> String {
        self.events(from, "agent://message").iter().map(|p| p["text"].as_str().unwrap_or_default().to_string()).collect()
    }

    fn notes(&self, from: usize) -> Vec<String> {
        self.events(from, "agent://note").iter().map(|p| p["text"].as_str().unwrap_or_default().to_string()).collect()
    }

    fn events(&self, from: usize, name: &str) -> Vec<Value> {
        self.log.lock().unwrap().iter().skip(from).filter(|(n, _)| n == name).map(|(_, p)| p.clone()).collect()
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

#[tokio::test]
async fn edits_and_writes_go_through_the_workspaces_tools() {
    let mut h = Harness::new("edits", config());
    h.start(None);
    let from = h
        .turn("write notes/a.txt\n<<<\none\ntwo\n>>>\nedit notes/a.txt\n<<<\ntwo\n===\nthree\n>>>\nread notes/a.txt\nsay Done.")
        .await;
    assert_eq!(std::fs::read_to_string(h.root.join("notes/a.txt")).unwrap(), "one\nthree\n");
    let said = h.said(from);
    assert!(said.contains("File created successfully") && said.contains("has been updated successfully"), "{said}");
    assert!(said.contains("notes/a.txt has 2 lines.") && said.ends_with("Done."), "{said}");

    // Each change was shown to the interface by the workspace's tools...
    let edits = h.events(from, "agent://edit");
    assert_eq!(edits.len(), 2, "{}", h.dump(from));
    assert!(edits.iter().all(|e| e["path"] == "notes/a.txt" && e["agentId"] == "ada"));
    assert_eq!((edits[1]["find"].as_str(), edits[1]["replace"].as_str()), (Some("two"), Some("three")));
    // ...and logged once: the stand-in's own reports of those calls are not logged again,
    // while its built-in Read is, like Claude Code's.
    let activity = h.events(from, "agent://activity");
    let verbs: Vec<&str> = activity.iter().map(|a| a["verb"].as_str().unwrap()).collect();
    assert!(!verbs.contains(&"TOOL"), "{verbs:?}");
    let read = activity.iter().find(|a| a["verb"] == "READ" && a["target"] == "Read notes/a.txt").expect("the read was logged");
    assert!(activity.iter().any(|a| a["entryId"] == read["entryId"] && a["result"] == "done"), "{}", h.dump(from));

    // With Edit off nothing is written, and the agent is told why.
    h.rt.config.write().unwrap().permissions.edit = Setting::Off;
    let from = h.turn("write notes/b.txt\n<<<\nno\n>>>").await;
    assert!(!h.root.join("notes/b.txt").exists());
    assert!(h.said(from).contains("Ada is not allowed to edit files in this workspace."), "{}", h.said(from));

    // A read outside the project asks first; Read set to Off refuses it without asking.
    let outside = h.root.parent().unwrap().join("outside.txt");
    std::fs::write(&outside, "secret\n").unwrap();
    *h.answer.lock().unwrap() = Some(Answer::Denied);
    let from = h.turn(&format!("read {}", outside.display())).await;
    assert_eq!(h.events(from, "agent://permission").len(), 1);
    assert!(h.said(from).contains("Not allowed to read"), "{}", h.said(from));
    h.rt.config.write().unwrap().permissions.read = Setting::Off;
    let from = h.turn(&format!("read {}", outside.display())).await;
    assert!(h.events(from, "agent://permission").is_empty());
    assert!(h.said(from).contains("Not allowed to read"), "{}", h.said(from));
    h.stop().await;
}

#[tokio::test]
async fn commands_and_questions_follow_the_agents_settings() {
    let mut h = Harness::new("commands", config());
    h.start(None);

    // Allow: it runs without a question, shown in the agent's shell.
    let from = h.turn("run echo hello-from-run").await;
    assert!(h.said(from).contains("hello-from-run"), "{}", h.said(from));
    assert!(h.events(from, "agent://permission").is_empty());
    assert!(h.events(from, "agent://shell").iter().any(|s| s["title"] == "echo hello-from-run"));

    // Ask: the user is asked; yes runs it, no refuses it.
    h.rt.config.write().unwrap().permissions.run = Setting::Ask;
    *h.answer.lock().unwrap() = Some(Answer::Allowed);
    let from = h.turn("run echo asked-and-allowed").await;
    let asked = h.events(from, "agent://permission");
    assert_eq!(asked.len(), 1);
    assert_eq!((asked[0]["tool"].as_str(), asked[0]["detail"].as_str()), (Some("run"), Some("echo asked-and-allowed")));
    assert!(h.said(from).contains("asked-and-allowed"));
    *h.answer.lock().unwrap() = Some(Answer::Denied);
    let from = h.turn("run echo never").await;
    assert!(h.said(from).contains("The user denied this command."), "{}", h.said(from));

    // Off: refused without asking.
    h.rt.config.write().unwrap().permissions.run = Setting::Off;
    let from = h.turn("run echo off").await;
    assert!(h.events(from, "agent://permission").is_empty());
    assert!(h.said(from).contains("Ada is not allowed to run in this workspace."), "{}", h.said(from));

    // A tool the workspace does not know asks the user through decide(), whatever Run says.
    *h.answer.lock().unwrap() = Some(Answer::Allowed);
    let from = h.turn("ask Look up the weather").await;
    let asked = h.events(from, "agent://permission");
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0]["title"], "Ada is asking to use Look up the weather");
    assert!(h.said(from).contains("Allowed: Look up the weather"));
    *h.answer.lock().unwrap() = Some(Answer::Denied);
    let from = h.turn("ask Delete the cache").await;
    assert!(h.said(from).contains("Not allowed: Delete the cache"));

    // A failing turn says why.
    let from = h.turn("say Trying.\nfail Broken on purpose").await;
    assert!(h.notes(from).iter().any(|n| n == "The turn failed: Broken on purpose"), "{:?}", h.notes(from));
    h.stop().await;
}

#[tokio::test]
async fn connector_calls_go_through_the_gateway() {
    use crate::connectors::model::State;
    use crate::connectors::tests::{stub_server, tool, url_connector};

    let url = stub_server(Arc::new(Mutex::new(vec![tool("echo", "Echoes text.")]))).await;
    let mut h = Harness::new("connector", config());
    let c = h.hub.save(url_connector(&url, "s3cret")).await.unwrap();
    let State::Changed { hash, .. } = h.hub.test(&c.id).await.unwrap() else { panic!("never approved, so changed") };
    h.hub.approve(&c.id, &hash).unwrap();
    h.rt.config.write().unwrap().connectors.insert(c.id.clone(), Setting::Allow);
    h.start(None);

    let from = h.turn(r#"call stub echo {"text": "hi there"}"#).await;
    assert!(h.said(from).contains(r#"echo {"text":"hi there"}"#), "{}", h.said(from));
    let calls: Vec<Value> = h.events(from, "agent://activity").into_iter().filter(|a| a["verb"] == "CALL").collect();
    assert!(calls.iter().any(|a| a["target"] == "Stub · echo" && a["result"] == "done"), "{calls:?}");

    // Ask: the gateway asks the user first.
    h.rt.config.write().unwrap().connectors.insert(c.id.clone(), Setting::Ask);
    *h.answer.lock().unwrap() = Some(Answer::Denied);
    let from = h.turn(r#"call stub echo {"text": "again"}"#).await;
    assert_eq!(h.events(from, "agent://permission").len(), 1);
    assert!(h.said(from).contains("The user denied this call."), "{}", h.said(from));
    // A server the session was not given cannot be reached at all.
    let from = h.turn("call elsewhere echo").await;
    assert!(h.said(from).contains("no MCP server named elsewhere"), "{}", h.said(from));
    h.stop().await;
}

#[tokio::test]
async fn spending_adds_up_across_restarts_and_the_limit_holds() {
    let mut h = Harness::new("spending", AgentConfig { daily_limit: "0.50".into(), ..config() });
    let today = || usage::today();
    let usd = |v: &Value, key: &str| (v[key].as_f64().unwrap() * 1000.0).round() / 1000.0;
    h.start(None);

    // The session reports a running total; each report adds the difference.
    let from = h.turn("cost 0.10\ncost 0.25").await;
    let reports = h.events(from, "agent://usage");
    assert_eq!(reports.iter().map(|r| usd(r, "todayUsd")).collect::<Vec<_>>(), [0.1, 0.25]);
    assert_eq!(reports.iter().map(|r| usd(r, "turnUsd")).collect::<Vec<_>>(), [0.1, 0.25]);
    assert_eq!(reports[0]["limitUsd"], 0.5);
    // A plain message costs the stand-in a cent; the turn's cost starts again.
    let from = h.turn("hello").await;
    let report = h.events(from, "agent://usage").pop().unwrap();
    assert_eq!((usd(&report, "todayUsd"), usd(&report, "turnUsd")), (0.26, 0.01));
    // The turn's cost is told before the turn ends, so the interface can give it to its task.
    let reported = h.wait_for(from, "usage", |n, _| n == "agent://usage").await;
    let working = h.status(from, &["working"]).await;
    assert!(reported < h.status(working, &["idle"]).await);
    assert!(h.said(from).contains("Stand-in got your message: hello"));

    // A restarted program counts from zero again: all of its first report is new.
    h.stop().await;
    let session = h.session.lock().unwrap().clone();
    h.start(session);
    let from = h.turn("cost 0.05").await;
    assert_eq!(usd(&h.events(from, "agent://usage").pop().unwrap(), "todayUsd"), 0.31);
    assert!((crate::store::usage::spent(&h.db, "p1", "ada", &today()).unwrap() - 0.31).abs() < 1e-9, "kept in the project's rows");

    // The turn that crosses the limit finishes; what was queued during it
    // goes back to the message box, and no new turn starts.
    let from = h.len();
    h.send("sleep 400\ncost 0.60\nsay Still finishing.");
    h.status(from, &["working"]).await;
    let queued = h.send("say This waits.");
    h.status(from, &["limited"]).await;
    let refusal = "Ada reached today's limit of $0.50 ($0.86 spent). Raise the limit in its settings, or it can work again tomorrow.";
    assert!(h.said(from).contains("Still finishing."), "not cut off: {}", h.said(from));
    assert_eq!(h.events(from, "agent://unqueued").pop().unwrap()["ids"], serde_json::json!([queued]));
    let reported = h.wait_for(from, "usage", |n, _| n == "agent://usage").await;
    let unqueued = h.wait_for(from, "unqueued", |n, _| n == "agent://unqueued").await;
    assert!(reported < unqueued && unqueued < h.status(from, &["limited"]).await, "{}", h.dump(from));
    assert!(h.notes(from).iter().any(|n| n == refusal), "{:?}", h.notes(from));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!h.said(from).contains("This waits."), "{}", h.dump(from));
    assert_eq!(h.events(from, "agent://status").iter().filter(|s| s["status"] == "working").count(), 1, "{}", h.dump(from));
    // What send_prompt refuses with.
    assert_eq!(h.rt.over_limit().as_deref(), Some(refusal));

    // A raised limit lets it work again at once.
    let from = h.len();
    h.rt.config.write().unwrap().daily_limit = "$5".into();
    h.rt.refresh_status();
    assert_eq!(h.events(from, "agent://status").pop().unwrap()["status"], "idle");
    assert_eq!(h.rt.over_limit(), None);
    // So does a new day, with the old one's total kept.
    h.rt.config.write().unwrap().daily_limit = "0,50".into();
    assert!(h.rt.over_limit().is_some());
    h.rt.usage.set_clock(|| "2999-01-01".into());
    assert_eq!(h.rt.over_limit(), None);
    let from = h.turn("cost 0.70").await;
    assert_eq!(usd(&h.events(from, "agent://usage").pop().unwrap(), "todayUsd"), 0.1, "0.60 to 0.70 on the new day");
    assert!((crate::store::usage::spent(&h.db, "p1", "ada", &today()).unwrap() - 0.86).abs() < 1e-9);
    h.stop().await;
}

/// Whether a process has ended (or is only waiting to be reaped).
fn ended(pid: &str) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Err(_) => true,
        Ok(stat) => stat.rsplit(')').next().is_some_and(|rest| rest.trim_start().starts_with('Z')),
    }
}

#[tokio::test]
async fn stop_ends_a_wait_and_kills_a_running_command() {
    let mut h = Harness::new("stop", config());
    h.start(None);

    let from = h.len();
    h.send("sleep 30000\nsay Too late.");
    let working = h.status(from, &["working"]).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let stopped_at = Instant::now();
    h.command(Command::Cancel);
    h.status(working, &["idle"]).await;
    assert!(stopped_at.elapsed() < Duration::from_secs(5));
    assert!(h.notes(from).iter().any(|n| n == "Stopped."), "{:?}", h.notes(from));
    assert!(!h.said(from).contains("Too late."));

    if cfg!(target_os = "linux") {
        let from = h.len();
        h.send("run echo $$ > shell.pid; sleep 30; echo too-late");
        let pid_file = h.root.join("shell.pid");
        let started = Instant::now();
        while std::fs::read_to_string(&pid_file).map(|p| p.trim().is_empty()).unwrap_or(true) {
            assert!(started.elapsed() < WAIT, "the command never started:\n{}", h.dump(from));
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let pid = std::fs::read_to_string(&pid_file).unwrap().trim().to_string();
        assert!(!ended(&pid));
        let working = h.status(from, &["working"]).await;
        let stopped_at = Instant::now();
        h.command(Command::Cancel);
        h.status(working, &["idle"]).await;
        assert!(stopped_at.elapsed() < Duration::from_secs(5));
        let started = Instant::now();
        while !ended(&pid) {
            assert!(started.elapsed() < Duration::from_secs(5), "the command still runs");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(h.events(from, "agent://activity").iter().any(|a| a["verb"] == "RUN" && a["result"] == "stopped"), "{}", h.dump(from));
        assert!(!h.said(from).contains("too-late"));
    }
    h.stop().await;
}

#[tokio::test]
async fn a_restarted_agent_carries_on_its_session() {
    let mut h = Harness::new("resume", config());
    h.start(None);
    h.turn("say First.").await;
    let first = h.session.lock().unwrap().clone().expect("the session id was handed out");
    h.stop().await;

    // The next run resumes it: same session, and the stand-in remembers.
    let before = h.len();
    h.start(Some(first.clone()));
    let from = h.turn("hello again").await;
    assert!(h.said(from).starts_with("I remember 1 earlier message."), "{}", h.said(from));
    assert_eq!(h.session.lock().unwrap().as_deref(), Some(first.as_str()));
    assert!(!h.notes(before).iter().any(|n| n.contains("starts a new conversation")), "{:?}", h.notes(before));
    h.stop().await;

    // A session the program does not know starts a new conversation, and says so.
    let before = h.len();
    h.start(Some("stand-in-unknown".into()));
    h.turn("hello").await;
    assert!(h.notes(before).iter().any(|n| n == "Ada starts a new conversation; earlier messages are from a previous session."));
    assert_ne!(h.session.lock().unwrap().as_deref(), Some(first.as_str()));
    h.stop().await;
}

#[tokio::test]
async fn model_and_effort_are_set_on_the_live_session() {
    let mut h = Harness::new("options", AgentConfig { model: "stand-in-2".into(), effort: "high".into(), ..config() });
    h.start(None);
    let from = h.turn("settings").await;
    assert!(h.said(from).contains("Model: stand-in-2. Effort: high."), "{}", h.said(from));
    let models = h.events(0, "agent://models").pop().expect("the models were reported");
    assert_eq!(models["current"], "stand-in-2");
    assert_eq!(models["models"].as_array().unwrap().len(), 2);

    // A changed effort applies between turns, on the same session.
    h.rt.config.write().unwrap().effort = "low".into();
    let from = h.len();
    h.command(Command::Settings);
    h.turn("settings").await;
    assert!(h.said(from).contains("Model: stand-in-2. Effort: low."), "{}", h.said(from));

    // One the program does not offer is not applied, and the user is told.
    h.rt.config.write().unwrap().model = "sonnet".into();
    let from = h.len();
    h.command(Command::Settings);
    h.turn("settings").await;
    assert!(h.notes(from).iter().any(|n| n.starts_with("Could not set the model to sonnet")), "{:?}", h.notes(from));
    assert!(h.said(from).contains("Model: stand-in-2."));
    h.stop().await;
}
