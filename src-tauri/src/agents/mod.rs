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

use crate::events::Events;
use crate::secrets;
use crate::workspace::Workspace;

use permissions::{Answer, Broker};
use runtime::AgentRuntime;
use session::Command;
use settings::AgentConfig;

struct Entry {
    rt: Arc<AgentRuntime>,
    /// Present while the agent's process runs.
    session: Option<mpsc::UnboundedSender<Command>>,
}

pub struct Agents {
    events: Events,
    broker: Arc<Broker>,
    entries: Mutex<HashMap<String, Entry>>,
}

impl Agents {
    pub fn new(events: Events) -> Self {
        Self { events, broker: Arc::default(), entries: Mutex::default() }
    }

    /// Ends every agent's process, e.g. when the user opens another folder.
    /// They start again, in the new folder, on their next message.
    pub fn stop_all(&self) {
        for entry in self.entries.lock().expect("agents lock").values_mut() {
            entry.session = None; // closing the channel ends the session
        }
    }
}

fn config_dir(app: &AppHandle, agent_id: &str) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let safe: String = agent_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    Ok(base.join("agents").join(safe).join("claude"))
}

/// Creates an agent or updates its settings. Edit, Run, Commit, Push, the
/// edit area and the areas and protected paths of its rule packs apply to the
/// running agent at once, since Blixel's own tools check them on every call.
/// The rest (model, effort, instructions including the rule packs', project
/// notes, Read) is applied to its session between turns, keeping the
/// conversation.
#[tauri::command]
pub fn upsert_agent(config: AgentConfig, agents: State<Agents>) {
    let mut entries = agents.entries.lock().expect("agents lock");
    match entries.get(&config.id) {
        Some(entry) => {
            *entry.rt.config.write().expect("config lock") = config;
            if let Some(tx) = &entry.session {
                let _ = tx.send(Command::Settings);
            }
        }
        None => {
            let rt = AgentRuntime::new(config.clone(), agents.events.clone(), agents.broker.clone());
            entries.insert(config.id, Entry { rt, session: None });
        }
    }
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
    let entry = entries.get_mut(&agent_id).ok_or("This agent is not set up in the core yet.")?;
    if entry.session.as_ref().is_some_and(|tx| tx.is_closed()) {
        entry.session = None;
    }
    if entry.session.is_none() {
        let root = workspace.current_root().ok_or("Open a project folder first: real agents work on files on disk.")?;
        let key = secrets::api_key("anthropic")?.ok_or("No Anthropic API key is saved. Add one in this agent's settings.")?;
        let dir = config_dir(&app, &agent_id)?;
        let (tx, rx) = mpsc::unbounded_channel();
        let rt = entry.rt.clone();
        rt.restart();
        rt.events.note(&rt.id, &format!("Starting Claude Code in {}. The first start downloads it, which can take a minute.", root.display()));
        // The session ends when the agent exits or when every sender is dropped
        // (stop_all), so the task holds only the receiver.
        tauri::async_runtime::spawn(async move {
            let outcome = session::run(rt.clone(), root, dir, key, rx).await;
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
