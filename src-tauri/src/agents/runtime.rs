//! One running agent: its enforced settings, its status, and the checks every
//! tool call goes through.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use crate::events::{Events, Status};

use super::permissions::{Answer, Broker};
use super::settings::{AgentConfig, Setting, Tool};

pub struct AgentRuntime {
    pub id: String,
    pub config: RwLock<AgentConfig>,
    pub events: Events,
    pub broker: Arc<Broker>,
    turn_active: AtomicBool,
    stopped: AtomicBool,
    last_status: Mutex<Option<Status>>,
}

/// The outcome of checking a tool call against the agent's settings.
pub enum Gate {
    Allowed,
    /// Refused without asking (the setting is Off).
    Off,
    /// The user said no.
    Denied,
}

impl AgentRuntime {
    pub fn new(config: AgentConfig, events: Events, broker: Arc<Broker>) -> Arc<Self> {
        Arc::new(Self {
            id: config.id.clone(),
            config: RwLock::new(config),
            events,
            broker,
            turn_active: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            last_status: Mutex::new(None),
        })
    }

    pub fn name(&self) -> String {
        self.config.read().expect("config lock").name.clone()
    }

    pub fn config(&self) -> AgentConfig {
        self.config.read().expect("config lock").clone()
    }

    pub fn set_turn_active(&self, active: bool) {
        self.turn_active.store(active, Ordering::SeqCst);
        self.refresh_status();
    }

    pub fn set_stopped(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.broker.deny_all(&self.events, &self.id);
        self.refresh_status();
    }

    /// Clears the stopped state before the agent's process starts again.
    pub fn restart(&self) {
        self.stopped.store(false, Ordering::SeqCst);
        self.turn_active.store(false, Ordering::SeqCst);
        self.refresh_status();
    }

    /// Status comes from what the core observes, never from what the agent says.
    pub fn refresh_status(&self) {
        let status = if self.stopped.load(Ordering::SeqCst) {
            Status::Stopped
        } else if self.broker.waiting_for(&self.id) > 0 {
            Status::Waiting
        } else if self.turn_active.load(Ordering::SeqCst) {
            Status::Working
        } else {
            Status::Idle
        };
        let mut last = self.last_status.lock().expect("status lock");
        if *last != Some(status) {
            *last = Some(status);
            self.events.status(&self.id, status);
        }
    }

    /// Asks the user directly, whatever the setting says. Nothing records the
    /// answer, so the request offers no "Always allow".
    pub async fn ask(&self, tool: Tool, title: &str, detail: &str) -> Answer {
        self.ask_with(tool, title, detail, false).await
    }

    async fn ask_with(&self, tool: Tool, title: &str, detail: &str, always_offered: bool) -> Answer {
        let reply = self.broker.open(&self.events, &self.id, tool.as_str(), title, detail, always_offered);
        self.refresh_status();
        let answer = reply.await.unwrap_or(Answer::Denied);
        self.refresh_status();
        answer
    }

    /// Applies the settings for every tool a call needs: any Off refuses, any
    /// Ask asks once, and "Always allow" sets each asked tool to Allow.
    pub async fn gate(&self, tools: &[Tool], title: &str, detail: &str) -> Gate {
        let settings: Vec<(Tool, Setting)> = {
            let config = self.config.read().expect("config lock");
            tools.iter().map(|&t| (t, config.permissions.get(t))).collect()
        };
        if settings.iter().any(|(_, s)| *s == Setting::Off) {
            return Gate::Off;
        }
        let asked: Vec<Tool> = settings.iter().filter(|(_, s)| *s == Setting::Ask).map(|(t, _)| *t).collect();
        if asked.is_empty() {
            return Gate::Allowed;
        }
        let strictest = *asked.last().expect("non-empty");
        match self.ask_with(strictest, title, detail, true).await {
            Answer::Denied => Gate::Denied,
            Answer::Allowed => Gate::Allowed,
            Answer::Always => {
                let permissions = {
                    let mut config = self.config.write().expect("config lock");
                    for tool in &asked {
                        config.permissions.set(*tool, Setting::Allow);
                    }
                    serde_json::to_value(&config.permissions).unwrap_or_default()
                };
                self.events.settings(&self.id, &permissions);
                Gate::Allowed
            }
        }
    }
}
