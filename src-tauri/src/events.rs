//! Everything the core tells the interface about agents goes through here, so
//! the event names and payload shapes live in one place.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

type Sink = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

/// Sends events to the interface (or, in tests, to whatever sink is given).
#[derive(Clone)]
pub struct Events {
    sink: Sink,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Idle,
    Working,
    Waiting,
    Stopped,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Activity<'a> {
    pub agent_id: &'a str,
    pub entry_id: &'a str,
    pub verb: &'a str,
    pub target: &'a str,
    pub result: &'a str,
    pub live: bool,
    pub refused: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Edit<'a> {
    pub agent_id: &'a str,
    /// The activity log line for this edit, shown as typing while it replays.
    pub entry_id: &'a str,
    pub path: &'a str,
    /// The whole file before the edit, so the interface can check its buffer
    /// is based on the same text, and replay the edit even if the file was not
    /// open. None for files too large to open in the editor.
    pub before: Option<&'a str>,
    pub find: &'a str,
    pub replace: &'a str,
    pub replace_all: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PermissionAsk<'a> {
    pub agent_id: &'a str,
    pub request_id: &'a str,
    pub tool: &'a str,
    pub title: &'a str,
    pub detail: &'a str,
    /// Whether "Always allow" is offered: only where the answer sets a setting.
    pub always_offered: bool,
}

impl Events {
    pub fn new(app: AppHandle) -> Self {
        Self::to_sink(move |name, payload| {
            if let Err(e) = app.emit(name, payload) {
                eprintln!("blixel: could not emit {name}: {e}");
            }
        })
    }

    pub fn to_sink(sink: impl Fn(&str, serde_json::Value) + Send + Sync + 'static) -> Self {
        Self { sink: Arc::new(sink) }
    }

    fn emit<S: Serialize>(&self, name: &str, payload: S) {
        match serde_json::to_value(payload) {
            Ok(value) => (self.sink)(name, value),
            Err(e) => eprintln!("blixel: could not encode {name}: {e}"),
        }
    }

    pub fn status(&self, agent_id: &str, status: Status) {
        self.emit("agent://status", serde_json::json!({ "agentId": agent_id, "status": status }));
    }

    /// A piece of the agent's reply. `done` closes the message.
    pub fn message(&self, agent_id: &str, message_id: &str, text: &str, done: bool) {
        self.emit(
            "agent://message",
            serde_json::json!({ "agentId": agent_id, "messageId": message_id, "text": text, "done": done }),
        );
    }

    pub fn activity(&self, a: Activity) {
        self.emit("agent://activity", a);
    }

    pub fn edit(&self, e: Edit) {
        self.emit("agent://edit", e);
    }

    /// Output for the agent's shell panel. A title starts a new command.
    pub fn shell(&self, agent_id: &str, title: Option<&str>, data: &str) {
        self.emit("agent://shell", serde_json::json!({ "agentId": agent_id, "title": title, "data": data }));
    }

    pub fn permission(&self, p: PermissionAsk) {
        self.emit("agent://permission", p);
    }

    /// A permission request that no longer needs an answer.
    pub fn permission_closed(&self, agent_id: &str, request_id: &str, answer: &str) {
        self.emit(
            "agent://permission-closed",
            serde_json::json!({ "agentId": agent_id, "requestId": request_id, "answer": answer }),
        );
    }

    /// The core changed a setting itself, e.g. after "Always allow".
    pub fn settings(&self, agent_id: &str, permissions: &serde_json::Value) {
        self.emit("agent://settings", serde_json::json!({ "agentId": agent_id, "permissions": permissions }));
    }

    /// The chat bubbles of the user's messages waiting for the current turn to end.
    pub fn queued(&self, agent_id: &str, ids: &[&str]) {
        self.emit("agent://queue", serde_json::json!({ "agentId": agent_id, "queued": ids }));
    }

    /// Queued messages handed back to the user unsent.
    pub fn unqueued(&self, agent_id: &str, ids: &[&str]) {
        self.emit("agent://unqueued", serde_json::json!({ "agentId": agent_id, "ids": ids }));
    }

    /// The models the agent's program offers, as (id, name, description), and the one it runs.
    pub fn models(&self, agent_id: &str, current: &str, offered: &[(String, String, Option<String>)]) {
        let models: Vec<_> = offered
            .iter()
            .map(|(id, name, description)| serde_json::json!({ "id": id, "name": name, "description": description }))
            .collect();
        self.emit("agent://models", serde_json::json!({ "agentId": agent_id, "current": current, "models": models }));
    }

    pub fn note(&self, agent_id: &str, text: &str) {
        self.emit("agent://note", serde_json::json!({ "agentId": agent_id, "text": text }));
    }

    pub fn files_changed(&self) {
        self.emit("workspace://changed", ());
    }
}

/// Short unique ids for messages, log entries and requests.
pub fn new_id(prefix: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{prefix}{t:x}{n:x}")
}
