//! Agents hosted by Blixel: each one an agent program running as a child
//! process over ACP, with its built-in edit and shell tools replaced by
//! Blixel's own.

pub mod permissions;
pub mod runtime;
pub mod session;
pub mod settings;
pub mod tools;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager, State};
use tokio::sync::mpsc;

use serde_json::Value;

use crate::events::Events;
use crate::secrets;
use crate::store::{self, Db};
use crate::workspace::Workspace;

use permissions::{Answer, Broker};
use runtime::AgentRuntime;
use session::Command;
use settings::AgentConfig;

/// Hears an agent's session id once its program reports it.
type OnSession = Box<dyn Fn(&str) + Send + Sync>;

struct Entry {
    rt: Arc<AgentRuntime>,
    /// Present while the agent's process runs.
    session: Option<mpsc::UnboundedSender<Command>>,
    /// False while its saved settings are untrusted (changed outside the
    /// app): its settings are lowered and it may not run until the user
    /// reviews them.
    trusted: bool,
}

/// Why an untrusted agent does not start. The interface shows it as is.
fn review_first(name: &str) -> String {
    format!("Review {name}'s settings before it runs: they were changed outside the app.")
}

pub struct Agents {
    events: Events,
    hub: Arc<crate::connectors::Hub>,
    broker: Arc<Broker>,
    entries: Mutex<HashMap<String, Entry>>,
    /// The open project, whose agents `entries` holds.
    project: Mutex<Option<String>>,
}

impl Agents {
    pub fn new(events: Events, hub: Arc<crate::connectors::Hub>) -> Self {
        Self { events, hub, broker: Arc::default(), entries: Mutex::default(), project: Mutex::default() }
    }

    pub fn project(&self) -> Option<String> {
        self.project.lock().expect("project lock").clone()
    }

    /// Replaces the core's agents with an opened project's (or none), ending
    /// every running one first so none keeps working in the old folder.
    /// Each comes with whether its saved settings are trusted.
    pub fn open_project(&self, project: Option<String>, configs: Vec<(AgentConfig, bool)>) {
        let mut entries = self.entries.lock().expect("agents lock");
        for (id, entry) in entries.drain() {
            drop(entry.session); // closing the channel ends the session
            self.broker.deny_all(&self.events, &id);
        }
        for (mut config, trusted) in configs {
            if !trusted {
                config.lower_untrusted();
            }
            let rt = AgentRuntime::new(config.clone(), self.events.clone(), self.broker.clone());
            entries.insert(config.id, Entry { rt, session: None, trusted });
        }
        *self.project.lock().expect("project lock") = project;
    }

    /// A folder opened without a project (`open_workspace`): agents stop, and
    /// nothing is kept per project.
    pub fn leave_project(&self) {
        self.stop_all();
        *self.project.lock().expect("project lock") = None;
    }

    /// Applies an agent's settings: at once for Edit, Run and the other checks
    /// Blixel's tools make on every call, between turns for the rest.
    /// `trusted` is what its saved row says now; None keeps what the core
    /// knew (a new agent is trusted). Untrusted settings are lowered, and the
    /// agent stops.
    fn put(&self, mut config: AgentConfig, trusted: Option<bool>) {
        let mut entries = self.entries.lock().expect("agents lock");
        let trusted = trusted.or_else(|| entries.get(&config.id).map(|e| e.trusted)).unwrap_or(true);
        if !trusted {
            config.lower_untrusted();
        }
        match entries.get_mut(&config.id) {
            Some(entry) => {
                *entry.rt.config.write().expect("config lock") = config;
                entry.trusted = trusted;
                if !trusted {
                    self.stop_untrusted(entry);
                } else if let Some(tx) = &entry.session {
                    let _ = tx.send(Command::Settings);
                }
            }
            None => {
                let rt = AgentRuntime::new(config.clone(), self.events.clone(), self.broker.clone());
                entries.insert(config.id, Entry { rt, session: None, trusted });
            }
        }
    }

    /// Stops an agent and forgets it.
    fn remove(&self, agent_id: &str) {
        if self.entries.lock().expect("agents lock").remove(agent_id).is_some() {
            self.broker.deny_all(&self.events, agent_id);
        }
    }

    /// Its saved settings were found changed outside the app: they are
    /// lowered and the agent stops until the user reviews them.
    fn distrust(&self, agent_id: &str) {
        if let Some(entry) = self.entries.lock().expect("agents lock").get_mut(agent_id) {
            entry.rt.config.write().expect("config lock").lower_untrusted();
            entry.trusted = false;
            self.stop_untrusted(entry);
        }
    }

    fn stop_untrusted(&self, entry: &mut Entry) {
        if entry.session.take().is_some() {
            // Closing the channel ends the session; what it asked is refused.
            self.broker.deny_all(&self.events, &entry.rt.id);
            entry.rt.events.note(&entry.rt.id, &review_first(&entry.rt.name()));
        }
    }

    /// Ends every agent's process, e.g. when the user opens another folder.
    /// They start again, in the new folder, on their next message.
    pub fn stop_all(&self) {
        for entry in self.entries.lock().expect("agents lock").values_mut() {
            entry.session = None; // closing the channel ends the session
        }
    }
}

/// The agent program's own folder (its settings and sessions), in the app's
/// data: per project, or, for a folder opened without one, per agent.
fn config_dir(app: &AppHandle, project: Option<&str>, agent_id: &str) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    match project {
        Some(project) => Ok(store::agents::agent_dir(&base, project, agent_id)?.join("claude")),
        None => {
            let safe: String = agent_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
            Ok(base.join("agents").join(safe).join("claude"))
        }
    }
}

/// Creates an agent or updates its settings without saving them. Edit, Run,
/// Commit, Push, the edit area and the areas and protected paths of its rule
/// packs apply to the running agent at once, since Blixel's own tools check
/// them on every call. The rest (model, effort, instructions including the
/// rule packs', project notes, Read) is applied to its session between turns,
/// keeping the conversation. Kept until the interface uses `agent_save`.
#[tauri::command]
pub fn upsert_agent(config: AgentConfig, agents: State<Agents>) {
    agents.put(config, None);
}

/// Sends the user's message, starting the agent first if it is not running.
#[tauri::command]
pub fn send_prompt(
    agent_id: String,
    message_id: String,
    text: String,
    app: AppHandle,
    agents: State<Agents>,
    workspace: State<Workspace>,
) -> Result<(), String> {
    let mut entries = agents.entries.lock().expect("agents lock");
    // Read under the agents' lock, so a project opening meanwhile cannot mix the two.
    let project = agents.project();
    let entry = entries.get_mut(&agent_id).ok_or("This agent is not set up in the core yet.")?;
    if !entry.trusted {
        return Err(review_first(&entry.rt.name()));
    }
    if entry.session.as_ref().is_some_and(|tx| tx.is_closed()) {
        entry.session = None;
    }
    if entry.session.is_none() {
        let root = workspace.current_root().ok_or("Open a project folder first: real agents work on files on disk.")?;
        let key = secrets::api_key("anthropic")?.ok_or("No Anthropic API key is saved. Add one in this agent's settings.")?;
        let dir = config_dir(&app, project.as_deref(), &agent_id)?;
        // Carry on from the agent's last session, and keep each new one for next time.
        let (resume, on_session): (Option<String>, OnSession) = match project {
            Some(project) => {
                let resume = app.state::<Db>().lock().and_then(|conn| store::agents::resume(&conn, &project, &agent_id));
                let resume = match resume {
                    Ok(store::agents::Resume::Session(id)) => Some(id),
                    // Its row changed since the project opened: it waits for the user's review.
                    Ok(store::agents::Resume::Changed) => {
                        entry.rt.config.write().expect("config lock").lower_untrusted();
                        entry.trusted = false;
                        return Err(review_first(&entry.rt.name()));
                    }
                    Ok(store::agents::Resume::Fresh) => None,
                    Err(e) => {
                        eprintln!("could not read the session of {agent_id}: {e}");
                        None
                    }
                };
                let (app, agent_id) = (app.clone(), agent_id.clone());
                let keep = move |session_id: &str| {
                    let kept = app
                        .state::<Db>()
                        .lock()
                        .and_then(|mut conn| store::agents::set_session(&mut conn, &project, &agent_id, session_id));
                    if let Err(e) = kept {
                        eprintln!("could not keep the session of {agent_id}: {e}");
                    }
                };
                (resume, Box::new(keep))
            }
            None => (None, Box::new(|_: &str| {})),
        };
        let (tx, rx) = mpsc::unbounded_channel();
        let rt = entry.rt.clone();
        let hub = agents.hub.clone();
        rt.restart();
        rt.events.note(&rt.id, &format!("Starting Claude Code in {}. The first start downloads it, which can take a minute.", root.display()));
        // The session ends when the agent exits or when every sender is dropped
        // (stop_all), so the task holds only the receiver.
        tauri::async_runtime::spawn(async move {
            let outcome = session::run(rt.clone(), root, dir, key, hub, resume, on_session, rx).await;
            if let Err(e) = outcome {
                rt.events.note(&rt.id, &format!("{} stopped: {e}", rt.name()));
            }
            rt.set_stopped();
        });
        entry.session = Some(tx);
    }
    entry.rt.set_turn_active(true);
    entry
        .session
        .as_ref()
        .expect("session just set")
        .send(Command::Prompt { id: message_id, text })
        .map_err(|_| "The agent stopped before it got the message.".to_string())
}

#[tauri::command]
pub fn cancel_turn(agent_id: String, agents: State<Agents>) -> Result<(), String> {
    let entries = agents.entries.lock().expect("agents lock");
    let entry = entries.get(&agent_id).ok_or("unknown agent")?;
    // Anything it was waiting on you for is now moot.
    agents.broker.deny_all(&agents.events, &agent_id);
    if let Some(tx) = &entry.session {
        let _ = tx.send(Command::Cancel);
    }
    entry.rt.refresh_status();
    Ok(())
}

/// The user's answer to a permission request. False if it had already closed.
#[tauri::command]
pub fn answer_permission(request_id: String, answer: Answer, agents: State<Agents>) -> bool {
    agents.broker.answer(&request_id, answer)
}

// ---- Saved agents (the core keeps the copy it enforces) ----

/// Saves an agent's settings for a project, signed (see `store::agents`).
/// `reviewed` is true only for the agent form's own Save: only that trusts
/// settings that were changed outside the app again. Any other save of such
/// an agent stores its settings lowered, and it still may not run.
///
/// When the project is open, the settings apply as with `upsert_agent`, and
/// before the save, so a permission the user lowered holds even if saving
/// fails; then again as saved, which may be lowered.
#[tauri::command]
pub async fn agent_save(project_id: String, agent: Value, reviewed: Option<bool>, app: AppHandle) -> Result<Value, String> {
    let reviewed = reviewed.unwrap_or(false);
    let config: AgentConfig = serde_json::from_value(agent.clone()).map_err(|e| format!("This agent's settings are incomplete: {e}"))?;
    store::agents::check_id("agent", &config.id)?;
    let agents = app.state::<Agents>();
    let placeholder = agent["placeholder"] == Value::Bool(true);
    let apply = |config: AgentConfig, trusted: Option<bool>| {
        if agents.project().as_deref() != Some(project_id.as_str()) {
            return;
        }
        if placeholder {
            agents.remove(&config.id); // scripted agents never run in the core
        } else {
            agents.put(config, trusted);
        }
    };
    apply(config, reviewed.then_some(true));
    let id = project_id.clone();
    let saved = store::blocking(&app, move |db| store::agents::save(&mut *db.lock()?, &id, &agent, reviewed)).await?;
    if let Some(config) = saved.config() {
        apply(config, Some(saved.trusted));
    }
    Ok(saved.to_json())
}

/// A project's saved agents in the order they were made. One whose record
/// was changed outside the app comes back lowered, with trust
/// "changed-outside", and may not run until the user reviews and saves it.
#[tauri::command]
pub async fn agents_list(project_id: String, app: AppHandle) -> Result<Vec<Value>, String> {
    let id = project_id.clone();
    let saved = store::blocking(&app, move |db| store::agents::load(&*db.lock()?, &id)).await?;
    let agents = app.state::<Agents>();
    if agents.project().as_deref() == Some(project_id.as_str()) {
        for changed in saved.iter().filter(|s| !s.trusted) {
            agents.distrust(changed.id());
        }
    }
    Ok(saved.iter().map(store::agents::Saved::to_json).collect())
}

/// Stops the agent, deletes its record and chat, and its program's own folder.
#[tauri::command]
pub async fn agent_remove(project_id: String, agent_id: String, app: AppHandle) -> Result<(), String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = store::agents::agent_dir(&base, &project_id, &agent_id)?;
    let agents = app.state::<Agents>();
    if agents.project().as_deref() == Some(project_id.as_str()) {
        agents.remove(&agent_id);
    }
    store::blocking(&app, move |db| store::agents::remove(&mut *db.lock()?, &project_id, &agent_id)).await?;
    if let Err(e) = std::fs::remove_dir_all(&dir) {
        if e.kind() != std::io::ErrorKind::NotFound {
            eprintln!("could not remove {}: {e}", dir.display());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use settings::Setting;

    fn config(id: &str) -> AgentConfig {
        serde_json::from_value(serde_json::json!({
            "id": id, "name": id, "instructions": "", "readNotes": false, "editPaths": "",
            "permissions": { "read": "allow", "edit": "allow", "run": "ask", "commit": "off", "push": "off" },
            "connectors": { "c1": "allow" }, "model": "sonnet", "effort": "low"
        }))
        .unwrap()
    }

    fn entry(agents: &Agents, id: &str) -> (AgentConfig, bool, bool) {
        let entries = agents.entries.lock().unwrap();
        let entry = &entries[id];
        (entry.rt.config(), entry.trusted, entry.session.is_some())
    }

    #[test]
    fn untrusted_settings_stay_lowered_until_reviewed() {
        let agents = Agents::new(Events::to_sink(|_, _| {}), Arc::default());
        agents.open_project(Some("p1".into()), vec![(config("a"), false), (config("b"), true)]);
        let (a, trusted, _) = entry(&agents, "a");
        assert!(!trusted);
        assert_eq!((a.permissions.edit, a.connectors["c1"]), (Setting::Ask, Setting::Off), "lowered on open");
        assert!(entry(&agents, "b").1);

        // Settings from anything but a review keep it untrusted and lowered.
        agents.put(config("a"), None);
        let (a, trusted, _) = entry(&agents, "a");
        assert!(!trusted);
        assert_eq!((a.permissions.edit, a.connectors["c1"]), (Setting::Ask, Setting::Off));
        agents.put(config("a"), Some(true));
        let (a, trusted, _) = entry(&agents, "a");
        assert!(trusted);
        assert_eq!((a.permissions.edit, a.connectors["c1"]), (Setting::Allow, Setting::Allow), "reviewed");

        // Found changed while running: lowered, and its session ends.
        let (tx, mut rx) = mpsc::unbounded_channel();
        agents.entries.lock().unwrap().get_mut("b").unwrap().session = Some(tx);
        agents.distrust("b");
        let (b, trusted, running) = entry(&agents, "b");
        assert!(!trusted && !running);
        assert_eq!((b.permissions.read, b.permissions.run, b.connectors["c1"]), (Setting::Ask, Setting::Ask, Setting::Off));
        assert!(matches!(rx.try_recv(), Err(mpsc::error::TryRecvError::Disconnected)));

        // A new agent is trusted.
        agents.put(config("n"), None);
        assert!(entry(&agents, "n").1);
        assert_eq!(review_first("Ada"), "Review Ada's settings before it runs: they were changed outside the app.");
    }

    fn ids(agents: &Agents) -> Vec<String> {
        let mut ids: Vec<String> = agents.entries.lock().unwrap().keys().cloned().collect();
        ids.sort();
        ids
    }

    #[test]
    fn opening_a_project_replaces_the_agents_the_core_runs() {
        let agents = Agents::new(Events::to_sink(|_, _| {}), Arc::default());
        agents.open_project(Some("p1".into()), vec![(config("a"), true), (config("b"), true)]);
        assert_eq!((agents.project().as_deref(), ids(&agents)), (Some("p1"), vec!["a".to_string(), "b".into()]));

        // A running session ends when its project closes.
        let (tx, mut rx) = mpsc::unbounded_channel();
        agents.entries.lock().unwrap().get_mut("a").unwrap().session = Some(tx);
        agents.open_project(Some("p2".into()), vec![(config("c"), true)]);
        assert!(matches!(rx.try_recv(), Err(mpsc::error::TryRecvError::Disconnected)), "its session was told to end");
        assert_eq!(ids(&agents), ["c"]);

        agents.remove("c");
        agents.open_project(None, Vec::new());
        assert_eq!((agents.project(), ids(&agents)), (None, Vec::<String>::new()));
    }
}
