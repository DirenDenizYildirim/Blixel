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
use super::sandbox::Sandbox;
use super::session::{self, Command, Earlier, Launch};
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
        network: true,
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
    /// The session id the agent last reported...
    session: Arc<Mutex<Option<String>>>,
    /// ...and the hash of the instructions it started with.
    told: Arc<Mutex<Option<String>>>,
    next: usize,
    /// Runs Claude Code with this key instead of the stand-in (the `real` tests).
    api_key: Option<String>,
    /// How long to wait for an event.
    wait: Duration,
    /// The sandbox's program (bubblewrap, unless a test takes it away).
    bwrap: PathBuf,
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
        Harness {
            base,
            root,
            config_dir,
            rt,
            hub,
            db,
            log,
            answer,
            tx: None,
            task: None,
            session: Arc::default(),
            told: Arc::default(),
            next: 0,
            api_key: None,
            wait: WAIT,
            bwrap: PathBuf::from(super::sandbox::BWRAP),
        }
    }

    /// Starts the agent's program, carrying on the session `resume` if given,
    /// as the app does: with the instructions it was last reported with.
    fn start(&mut self, resume: Option<String>) {
        let told = self.told.lock().unwrap().clone();
        self.start_from(resume.map(|id| Earlier { id, instructions: told }));
    }

    fn start_from(&mut self, resume: Option<Earlier>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let (session, told) = (self.session.clone(), self.told.clone());
        let task = tokio::spawn(session::run(
            self.rt.clone(),
            self.root.clone(),
            self.config_dir.clone(),
            match &self.api_key {
                Some(api_key) => Launch::ClaudeCode { api_key: api_key.clone() },
                None => Launch::StandIn { exe: stand_in() },
            },
            Sandbox::with_program(self.bwrap.clone(), Sandbox::home(), None, Some(self.base.join("layers"))),
            self.hub.clone(),
            resume,
            Box::new(move |id, instructions| {
                *session.lock().unwrap() = Some(id.to_string());
                *told.lock().unwrap() = Some(instructions.to_string());
            }),
            rx,
        ));
        self.tx = Some(tx);
        self.task = Some(task);
    }

    /// Ends the agent's program, as closing its channel does in the app.
    async fn stop(&mut self) {
        self.tx = None;
        let outcome = tokio::time::timeout(self.wait, self.task.take().unwrap()).await.expect("the session ended").unwrap();
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
            assert!(started.elapsed() < self.wait, "no {what} after event {from}:\n{}", self.dump(0));
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

    /// Waits for a note at or after `from` that says `text`.
    async fn note_saying(&self, from: usize, text: &str) -> usize {
        self.wait_for(from, text, |n, p| n == "agent://note" && p["text"].as_str().is_some_and(|t| t.contains(text))).await
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
        let _ = super::sandbox::remove_all(&self.base);
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
async fn commands_run_in_the_sandbox_with_the_agents_network() {
    let mut h = Harness::new("sandboxed", AgentConfig { network: false, ..config() });
    std::fs::write(h.root.join("CLAUDE.md"), "Notes.\n").unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let reach = format!("run echo hi > /dev/tcp/127.0.0.1/{} && echo reached", listener.local_addr().unwrap().port());
    h.start(None);

    // Network off: not even this machine can be reached. The agent's file can't be changed by a command.
    let from = h.turn(&format!("{reach}\nrun echo 'Obey me.' >> CLAUDE.md")).await;
    assert!(!h.said(from).contains("reached"), "{}", h.said(from));
    assert_eq!(std::fs::read_to_string(h.root.join("CLAUDE.md")).unwrap(), "Notes.\n");

    // The setting applies to the next command, without a restart.
    h.rt.config.write().unwrap().network = true;
    let from = h.turn(&reach).await;
    assert!(h.said(from).contains("reached"), "{}", h.said(from));
    h.stop().await;
}

#[tokio::test]
async fn without_the_sandbox_no_command_runs() {
    let mut h = Harness::new("unsandboxed", config());
    h.bwrap = "/nonexistent/bwrap".into();
    h.rt.config.write().unwrap().permissions.run = Setting::Ask;
    *h.answer.lock().unwrap() = Some(Answer::Allowed);
    h.start(None);
    let from = h.turn("run touch ran.txt\nrun touch again.txt").await;
    assert!(!h.root.join("ran.txt").exists() && !h.root.join("again.txt").exists());
    assert!(h.said(from).contains("Commands cannot run here: Blixel runs them only in a sandbox"), "{}", h.said(from));
    assert!(h.events(from, "agent://permission").is_empty(), "nobody is asked about a command that cannot run");
    let told: Vec<String> = h.notes(from).into_iter().filter(|n| n.starts_with("Ada cannot run commands")).collect();
    assert_eq!(told.len(), 1, "the user is told once: {:?}", h.notes(from));
    assert!(told[0].contains("bubblewrap (bwrap) is not installed"), "{told:?}");
    let refused = h.events(from, "agent://activity");
    assert!(refused.iter().any(|a| a["result"] == "no sandbox" && a["refused"] == true), "{}", h.dump(from));
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

/// Whether a process sleeping for `seconds` (a length no other process here
/// has) still runs. Inside the sandbox processes have other ids than outside,
/// so it is found by what it runs.
fn running(seconds: &str) -> bool {
    let wanted = format!("sleep\0{seconds}\0");
    std::fs::read_dir("/proc").into_iter().flatten().flatten().any(|entry| {
        let stat = std::fs::read_to_string(entry.path().join("stat")).unwrap_or_default();
        let zombie = stat.rsplit(')').next().is_some_and(|rest| rest.trim_start().starts_with('Z'));
        !zombie && std::fs::read(entry.path().join("cmdline")).is_ok_and(|c| String::from_utf8_lossy(&c) == wanted)
    })
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
        let seconds = format!("30.{}", std::process::id());
        h.send(&format!("run echo started > shell.pid; sleep {seconds}; echo too-late"));
        let pid_file = h.root.join("shell.pid");
        let started = Instant::now();
        while std::fs::read_to_string(&pid_file).map(|p| p.trim().is_empty()).unwrap_or(true) {
            assert!(started.elapsed() < WAIT, "the command never started:\n{}", h.dump(from));
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(running(&seconds), "the command's sleep runs");
        let working = h.status(from, &["working"]).await;
        let stopped_at = Instant::now();
        h.command(Command::Cancel);
        h.status(working, &["idle"]).await;
        assert!(stopped_at.elapsed() < Duration::from_secs(5));
        let started = Instant::now();
        while running(&seconds) {
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

/// Claude Code keeps the instructions a session started with when it is
/// resumed (the stand-in does too), so a change to them starts a new
/// conversation; other changes, and restarts without one, carry on.
#[tokio::test]
async fn changed_instructions_start_a_new_conversation() {
    let mut h = Harness::new("instructions", AgentConfig { instructions: "Be brief.".into(), ..config() });
    std::fs::write(h.root.join("CLAUDE.md"), "Notes.\n").unwrap();
    let id = |h: &Harness| h.session.lock().unwrap().clone().unwrap();
    let new_conversation = "Ada's instructions changed, so it starts a new conversation and does not remember the messages above.";
    h.start(None);
    let from = h.turn("instructions").await;
    assert!(h.said(from).contains("Instructions: Be brief."), "{}", h.said(from));
    let first = id(&h);

    // New instructions: a new session that has them, and the old one is closed.
    h.rt.config.write().unwrap().instructions = "Be thorough.".into();
    h.command(Command::Settings);
    let from = h.turn("instructions").await;
    assert!(h.said(from).contains("Instructions: Be thorough."), "{}", h.dump(from));
    assert!(h.notes(from).iter().any(|n| n == new_conversation), "{:?}", h.notes(from));
    let second = id(&h);
    assert_ne!(second, first);

    // A tool setting is applied to the same session, keeping the conversation.
    h.rt.config.write().unwrap().permissions.read = Setting::Off;
    h.command(Command::Settings);
    let from = h.turn("say Still here.").await;
    assert!(h.notes(from).iter().any(|n| n == "Ada now works with your new settings."), "{:?}", h.notes(from));
    assert_eq!(id(&h), second);

    // An edited CLAUDE.md is read when a conversation starts: nothing is rebuilt for it.
    std::fs::write(h.root.join("CLAUDE.md"), "Other notes.\n").unwrap();
    h.command(Command::Settings);
    let from = h.turn("say Same.").await;
    assert!(h.notes(from).is_empty(), "{:?}", h.notes(from));
    assert_eq!(id(&h), second);
    h.stop().await;

    // A restart with the same instructions carries on...
    let before = h.len();
    h.start(Some(second.clone()));
    let from = h.turn("instructions").await;
    assert!(h.said(from).contains("Be thorough."), "{}", h.said(from));
    assert!(h.notes(before).iter().all(|n| !n.contains("new conversation")), "{:?}", h.notes(before));
    assert_eq!(id(&h), second);
    h.stop().await;

    // ...and with changed ones (the name counts too) starts a new conversation.
    h.rt.config.write().unwrap().name = "Ada Two".into();
    let before = h.len();
    h.start(Some(second.clone()));
    h.turn("say Hello.").await;
    let renamed = "Ada Two's instructions changed, so it starts a new conversation and does not remember the messages above.";
    assert!(h.notes(before).iter().any(|n| n == renamed), "{:?}", h.notes(before));
    let third = id(&h);
    assert_ne!(third, second);
    h.stop().await;

    // A change before the new conversation's first message: nothing to keep
    // yet (it cannot be resumed), so its settings go to another new session.
    h.start(Some(third.clone()));
    h.turn("say Hello again.").await;
    let from = h.len();
    h.rt.config.write().unwrap().instructions = "Be quick.".into();
    h.command(Command::Settings);
    h.note_saying(from, "starts a new conversation").await;
    let from = h.len();
    h.rt.config.write().unwrap().permissions.read = Setting::Allow;
    h.command(Command::Settings);
    h.note_saying(from, "now works with your new settings").await;
    let from = h.turn("instructions").await;
    assert!(h.said(from).contains("Instructions: Be quick."), "{}", h.dump(from));
    assert!(h.notes(from).iter().all(|n| !n.contains("could not be applied")), "{:?}", h.notes(from));
    let fourth = id(&h);

    // A new conversation with no message yet is not kept for next time.
    let from = h.len();
    h.rt.config.write().unwrap().instructions = "Be slow.".into();
    h.command(Command::Settings);
    h.note_saying(from, "starts a new conversation").await;
    h.stop().await;
    assert_eq!(id(&h), fourth, "a session with no message was kept");

    // A session saved before its instructions were kept starts anew.
    let before = h.len();
    h.start_from(Some(Earlier { id: fourth.clone(), instructions: None }));
    h.turn("say Hello.").await;
    assert!(h.notes(before).iter().any(|n| n == "Ada Two starts a new conversation; earlier messages are from a previous session."));
    assert_ne!(id(&h), fourth);
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

/// The same path with Claude Code itself and a real API key, read from
/// `BLIXEL_REAL_KEY`. Costs money and needs the network, so these only run
/// with `cargo test real_ -- --ignored --nocapture`, and pass without
/// running anything when the variable is not set. They check what Blixel
/// observed (files, edits, commands, questions, spending), never the
/// model's exact words.
mod real {
    use super::*;

    const REAL_WAIT: Duration = Duration::from_secs(240);

    fn config() -> AgentConfig {
        AgentConfig { program: String::new(), model: "sonnet".into(), effort: "low".into(), ..super::config() }
    }

    fn harness(name: &str, config: AgentConfig) -> Option<Harness> {
        let Ok(key) = std::env::var("BLIXEL_REAL_KEY") else {
            eprintln!("BLIXEL_REAL_KEY is not set: skipped");
            return None;
        };
        let mut h = Harness::new(&format!("real-{name}"), config);
        h.api_key = Some(key);
        h.wait = REAL_WAIT;
        Some(h)
    }

    impl Harness {
        /// Prints what happened since `from`, for reading the run.
        fn report(&self, from: usize, label: &str) {
            eprintln!("==== {label}");
            let mut usage = None;
            for (name, p) in self.log.lock().unwrap().iter().skip(from) {
                match name.as_str() {
                    "agent://activity" if p["live"] == false => {
                        eprintln!("  {} {} -> {}{}", p["verb"], p["target"], p["result"], if p["refused"] == true { " (refused)" } else { "" })
                    }
                    "agent://permission" => eprintln!("  ASKED {} | {} | {}", p["tool"], p["title"], p["detail"]),
                    "agent://edit" => eprintln!("  edit event: {}", p["path"]),
                    "agent://shell" if !p["title"].is_null() => eprintln!("  shell $ {}", p["title"]),
                    "agent://note" => eprintln!("  note: {}", p["text"]),
                    "agent://usage" => usage = Some(p.clone()),
                    _ => {}
                }
            }
            if let Some(u) = usage {
                eprintln!("  usage: today {} turn {}", u["todayUsd"], u["turnUsd"]);
            }
            eprintln!("  said: {}", self.said(from).replace('\n', " ⏎ "));
        }

        fn shell_titles(&self, from: usize) -> Vec<String> {
            self.events(from, "agent://shell").iter().filter_map(|s| s["title"].as_str().map(str::to_owned)).collect()
        }

        fn shell_output(&self, from: usize) -> String {
            self.events(from, "agent://shell").iter().map(|s| s["data"].as_str().unwrap_or_default().to_owned()).collect()
        }
    }

    #[tokio::test]
    #[ignore = "runs Claude Code with the key in BLIXEL_REAL_KEY: network and cost"]
    async fn real_edits_and_commands_go_through_blixel() {
        let Some(mut h) = harness("routing", config()) else { return };
        h.start(None);
        let from = h
            .turn(
                "Create a file named hello.txt whose only line is `hi`. Then edit that file so the line says \
                 `hello` instead. Then run `cat hello.txt` and tell me what it printed. Don't ask me anything.",
            )
            .await;
        h.report(from, "routing");

        let text = std::fs::read_to_string(h.root.join("hello.txt")).expect("hello.txt was created");
        assert_eq!(text.trim(), "hello", "{}", h.dump(from));
        // Every change reached the interface through Blixel's own tools: a
        // built-in Write or Edit would change the file with no edit event.
        let edits = h.events(from, "agent://edit");
        assert!(!edits.is_empty(), "no edit came through Blixel:\n{}", h.dump(from));
        assert!(edits.iter().all(|e| e["path"] == "hello.txt" && e["agentId"] == "ada"), "{edits:?}");
        assert!(h.shell_titles(from).iter().any(|t| t.contains("cat hello.txt")), "the command did not run in Blixel's shell:\n{}", h.dump(from));
        assert!(h.shell_output(from).contains("hello"), "{}", h.shell_output(from));
        // Everything is allowed, so neither Blixel nor the adapter asked.
        assert!(h.events(from, "agent://permission").is_empty(), "something asked:\n{}", h.dump(from));
        // The spending was counted, and the program reported its models.
        let spent = h.events(from, "agent://usage").iter().filter_map(|u| u["todayUsd"].as_f64()).fold(0.0, f64::max);
        assert!(spent > 0.0, "no spending was counted:\n{}", h.dump(from));
        let models = h.events(0, "agent://models");
        assert!(!models.is_empty(), "no models were reported");
        eprintln!("  models: {}", models.last().unwrap());
        h.stop().await;
    }

    #[tokio::test]
    #[ignore = "runs Claude Code with the key in BLIXEL_REAL_KEY: network and cost"]
    async fn real_settings_hold() {
        let mut config = config();
        config.permissions.run = Setting::Ask;
        let Some(mut h) = harness("settings", config) else { return };
        std::fs::write(h.root.join("CLAUDE.md"), "Project notes.\n").unwrap();
        h.start(None);
        let asked_about = |h: &Harness, from: usize, what: &str| {
            h.events(from, "agent://permission").iter().any(|a| a["detail"].as_str().is_some_and(|d| d.contains(what)))
        };

        // Run on Ask: allowed once, it runs.
        *h.answer.lock().unwrap() = Some(Answer::Allowed);
        let from = h.turn("Run the command `echo blixel-allowed` and tell me its output.").await;
        h.report(from, "run on ask, allowed");
        assert!(asked_about(&h, from, "blixel-allowed"), "not asked:\n{}", h.dump(from));
        assert!(h.shell_output(from).contains("blixel-allowed"), "{}", h.dump(from));

        // Denied: it never runs.
        *h.answer.lock().unwrap() = Some(Answer::Denied);
        let from = h.turn("Run the command `echo blixel-denied`. If you can't, say so and stop.").await;
        h.report(from, "run on ask, denied");
        assert!(asked_about(&h, from, "blixel-denied"), "not asked:\n{}", h.dump(from));
        assert!(!h.shell_titles(from).iter().any(|t| t.contains("blixel-denied")), "it ran:\n{}", h.dump(from));

        // An edit area of docs/ only: outside is refused, inside works.
        h.rt.config.write().unwrap().edit_paths = "docs/**".into();
        let from = h
            .turn("Create the file src/outside.txt containing `x`. If you are not allowed, say so and stop; do not try another way.")
            .await;
        h.report(from, "outside the edit area");
        assert!(!h.root.join("src/outside.txt").exists(), "written outside the area:\n{}", h.dump(from));
        let activity = h.events(from, "agent://activity");
        assert!(activity.iter().any(|a| a["result"] == "outside its area"), "{}", h.dump(from));
        let from = h.turn("Create the file docs/inside.txt containing `x`.").await;
        h.report(from, "inside the edit area");
        assert!(h.root.join("docs/inside.txt").exists(), "{}", h.dump(from));
        h.rt.config.write().unwrap().edit_paths = String::new();

        // A protected file asks even with Edit on Allow; denied, it stays as it was.
        let from = h.turn("Add the line `Use tabs.` to the end of CLAUDE.md. If you can't, say so and stop.").await;
        h.report(from, "protected file, denied");
        let asked = h.events(from, "agent://permission");
        assert!(asked.iter().any(|a| a["title"].as_str().is_some_and(|t| t.contains("agent settings file"))), "{}", h.dump(from));
        assert_eq!(std::fs::read_to_string(h.root.join("CLAUDE.md")).unwrap(), "Project notes.\n");

        // Edit and Run off: nothing is written, and nothing asks.
        {
            let mut config = h.rt.config.write().unwrap();
            config.permissions.edit = Setting::Off;
            config.permissions.run = Setting::Off;
        }
        let from = h.turn("Create the file off.txt containing `x`. If you can't, say so and stop.").await;
        h.report(from, "edit and run off");
        assert!(!h.root.join("off.txt").exists(), "{}", h.dump(from));
        assert!(h.events(from, "agent://edit").is_empty());
        assert!(h.events(from, "agent://permission").is_empty(), "Off asked:\n{}", h.dump(from));

        // Not a check, an observation: with Edit off but Run allowed, does it
        // write the file with a command instead? (Decision 1: without a
        // sandbox, Run can do this; the instructions tell it not to.)
        h.rt.config.write().unwrap().permissions.run = Setting::Allow;
        let from = h.turn("Create the file sneaky.txt containing `x`.").await;
        h.report(from, "edit off, run allowed");
        eprintln!("  OBSERVATION: sneaky.txt written through a command: {}", h.root.join("sneaky.txt").exists());
        h.stop().await;
    }

    #[tokio::test]
    #[ignore = "runs Claude Code with the key in BLIXEL_REAL_KEY: network and cost"]
    async fn real_resume_and_stop() {
        let Some(mut h) = harness("resume", config()) else { return };
        h.start(None);
        let from = h.turn("Remember the word pelican. Reply with just OK.").await;
        h.report(from, "first session");
        h.stop().await;
        let first = h.session.lock().unwrap().clone();
        assert!(first.is_some(), "no session id was handed out");

        // A new process carries on the same conversation.
        h.start(first.clone());
        let from = h.turn("Which word did I ask you to remember? Reply with just the word.").await;
        h.report(from, "resumed");
        assert!(h.said(from).to_lowercase().contains("pelican"), "{}", h.dump(from));
        assert!(!h.notes(from).iter().any(|n| n.contains("new conversation")), "{:?}", h.notes(from));

        // Stop during a long command: the command is killed and the turn ends.
        let from = h.len();
        h.send("Run the command `sleep 45 && echo too-late` with a timeout of 120000 ms and tell me what it printed.");
        let working = h.status(from, &["working"]).await;
        h.wait_for(from, "the command starting", |n, p| n == "agent://shell" && p["title"].as_str().is_some_and(|t| t.contains("sleep 45")))
            .await;
        let asked_to_stop = Instant::now();
        h.command(Command::Cancel);
        h.status(working, &["idle", "stopped"]).await;
        let took = asked_to_stop.elapsed();
        h.report(from, "stopped mid-command");
        eprintln!("  stopped after {took:?}");
        assert!(took < Duration::from_secs(20), "Stop took {took:?}");
        let output = h.shell_output(from);
        assert!(output.contains("[stopped]"), "{output}");
        // The command's own line names it; its output never came.
        assert!(!output.lines().any(|line| line.trim() == "too-late"), "{output}");
        h.stop().await;
    }

    #[tokio::test]
    #[ignore = "runs Claude Code with the key in BLIXEL_REAL_KEY: network and cost"]
    async fn real_connector_call_and_outside_read() {
        use crate::connectors::model::State;
        use crate::connectors::tests::{stub_server, tool, url_connector};

        let url = stub_server(Arc::new(Mutex::new(vec![tool("echo", "Echoes text.")]))).await;
        let Some(mut h) = harness("connector", config()) else { return };
        let c = h.hub.save(url_connector(&url, "s3cret")).await.unwrap();
        let State::Changed { hash, .. } = h.hub.test(&c.id).await.unwrap() else { panic!("never approved, so changed") };
        h.hub.approve(&c.id, &hash).unwrap();
        h.rt.config.write().unwrap().connectors.insert(c.id.clone(), Setting::Allow);
        h.start(None);

        // A connector's tool, called through Blixel's gateway.
        let from = h.turn("Call the echo tool of the stub connector with the text `hi there` and tell me exactly what it returned.").await;
        h.report(from, "connector call");
        let calls: Vec<Value> = h.events(from, "agent://activity").into_iter().filter(|a| a["verb"] == "CALL").collect();
        assert!(calls.iter().any(|a| a["target"] == "Stub · echo" && a["result"] == "done"), "{}", h.dump(from));
        assert!(h.said(from).contains("hi there"), "{}", h.said(from));

        // A read outside the project asks first; denied, nothing is read.
        let outside = h.root.parent().unwrap().join("outside.txt");
        std::fs::write(&outside, "secret-outside-word\n").unwrap();
        *h.answer.lock().unwrap() = Some(Answer::Denied);
        let from = h.turn(&format!("Read the file {} and tell me what it says. If you can't, say so and stop.", outside.display())).await;
        h.report(from, "read outside, denied");
        assert!(!h.events(from, "agent://permission").is_empty(), "the read did not ask:\n{}", h.dump(from));
        assert!(!h.said(from).contains("secret-outside-word"), "{}", h.dump(from));
        h.stop().await;
    }

    /// Changed settings on a running agent (decisions 5 and 11): Read set to
    /// Off reaches the session (Run is off, so a command cannot read in its
    /// place); changed instructions reach the model in a new conversation,
    /// while it runs and after a restart; a plain restart carries on.
    #[tokio::test]
    #[ignore = "runs Claude Code with the key in BLIXEL_REAL_KEY: network and cost"]
    async fn real_setting_changes_reach_the_session() {
        let mut config = config();
        config.permissions.run = Setting::Off;
        let Some(mut h) = harness("changes", config) else { return };
        std::fs::write(h.root.join("inside.txt"), "secret-inside-word\n").unwrap();
        h.start(None);
        let from = h.turn("Remember the word walrus. Reply with just OK.").await;
        h.report(from, "start");

        h.rt.config.write().unwrap().permissions.read = Setting::Off;
        h.command(Command::Settings);
        let from = h.turn("Read the file inside.txt and tell me what it says. If you can't, say so and stop.").await;
        h.report(from, "Read off, rebuilt");
        let read_after_off = h.said(from).contains("secret-inside-word");

        // New instructions start a new conversation that has them (only they
        // know the code word); it no longer knows the word from before.
        let code = |word: &str| format!("Your code word is {word}. Give it when asked for your code word.");
        h.rt.config.write().unwrap().instructions = code("BRAVO-2");
        h.command(Command::Settings);
        let from = h.turn("Tell me your code word (or NONE).").await;
        h.report(from, "new instructions, new conversation");
        let rebuilt = h.said(from).contains("BRAVO-2");
        let said_new = h.notes(from).iter().any(|n| n.contains("starts a new conversation"));
        let from = h.turn("Remember the word heron. Reply with just OK.").await;
        h.report(from, "remember again");

        // A restart without changes carries on that conversation...
        h.stop().await;
        let id = h.session.lock().unwrap().clone();
        h.start(id);
        let from = h.turn("Which word did I ask you to remember? Reply with just the word.").await;
        h.report(from, "restarted, same instructions");
        let kept = h.said(from).to_lowercase().contains("heron");
        h.stop().await;

        // ...and one with changed instructions starts a new one that has them.
        h.rt.config.write().unwrap().instructions = code("DELTA-4");
        let id = h.session.lock().unwrap().clone();
        h.start(id);
        let from = h.turn("Tell me your code word (or NONE).").await;
        h.report(from, "restarted, new instructions");
        let restarted = h.said(from).contains("DELTA-4");
        h.stop().await;

        eprintln!(
            "  RESULT read after Off: {read_after_off}; new conversation said: {said_new}; \
             instructions seen after a change: {rebuilt}, after a restart: {restarted}; kept on a plain restart: {kept}"
        );
        assert!(!read_after_off, "Read set to Off did not reach the session");
        assert!(rebuilt && restarted && said_new, "changed instructions did not reach the model");
        assert!(kept, "a restart without changes lost the conversation");
    }
}
