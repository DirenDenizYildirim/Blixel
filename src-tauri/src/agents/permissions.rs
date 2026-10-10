//! Questions for the user. A tool that needs an answer waits here while the
//! interface shows the request; the agent keeps waiting until the user
//! answers or the agent stops. Nothing an agent sends can answer one.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Deserialize;
use tokio::sync::oneshot;

use crate::connectors::hash::clean_text;
use crate::events::{new_id, Events, PermissionAsk};

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Answer {
    Allowed,
    Always,
    Denied,
}

struct Pending {
    agent_id: String,
    reply: oneshot::Sender<Answer>,
}

#[derive(Default)]
pub struct Broker {
    pending: Mutex<HashMap<String, Pending>>,
}

impl Broker {
    /// Shows a request to the user. Await the receiver for the answer; a
    /// dropped request counts as denied.
    pub fn open(
        &self,
        events: &Events,
        agent_id: &str,
        tool: &str,
        title: &str,
        detail: &str,
        always_offered: bool,
    ) -> oneshot::Receiver<Answer> {
        // Titles and details quote what the agent sent (a command, a tool's
        // title, a path), which could hide text from the user or make it read
        // differently: shown without hidden characters, titles on one line.
        let title = one_line(&clean_text(title));
        let detail = clean_text(detail);
        let request_id = new_id("p");
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .expect("permission lock")
            .insert(request_id.clone(), Pending { agent_id: agent_id.to_string(), reply: tx });
        events.permission(PermissionAsk { agent_id, request_id: &request_id, tool, title: &title, detail: &detail, always_offered });
        rx
    }

    /// The user's answer. False if the request is gone (answered or its agent stopped).
    pub fn answer(&self, request_id: &str, answer: Answer) -> bool {
        let pending = self.pending.lock().expect("permission lock").remove(request_id);
        match pending {
            Some(p) => p.reply.send(answer).is_ok(),
            None => false,
        }
    }

    pub fn waiting_for(&self, agent_id: &str) -> usize {
        self.pending.lock().expect("permission lock").values().filter(|p| p.agent_id == agent_id).count()
    }

    /// Denies everything an agent is waiting on, e.g. when it stops.
    pub fn deny_all(&self, events: &Events, agent_id: &str) {
        let mut pending = self.pending.lock().expect("permission lock");
        let ids: Vec<String> = pending.iter().filter(|(_, p)| p.agent_id == agent_id).map(|(id, _)| id.clone()).collect();
        for id in ids {
            if let Some(p) = pending.remove(&id) {
                let _ = p.reply.send(Answer::Denied);
                events.permission_closed(agent_id, &id, "denied");
            }
        }
    }
}

/// Text on one line, its runs of spaces, tabs and line breaks made one space.
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn requests_are_shown_without_hidden_characters() {
        let seen: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
        let events = Events::to_sink({
            let seen = seen.clone();
            move |_, payload| seen.lock().unwrap().push(payload)
        });
        let broker = Broker::default();
        let _reply = broker.open(
            &events,
            "a",
            "run",
            "Ada is asking to use\n\u{202E}Read\u{200B} notes\t",
            "rm -rf ./bu\u{200B}ild\u{E0041}\n\tsecond line\u{0007}\r\n",
            true,
        );
        let shown = seen.lock().unwrap()[0].clone();
        assert_eq!(shown["title"], "Ada is asking to use Read notes");
        assert_eq!(shown["detail"], "rm -rf ./build\n\tsecond line\n", "lines and tabs stay");
        assert_eq!(broker.waiting_for("a"), 1);
    }
}
