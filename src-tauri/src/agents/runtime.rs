//! One running agent: its enforced settings, its status, and the checks every
//! tool call goes through.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use tokio_util::sync::CancellationToken;

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
    /// Cancelled when the user stops the agent, so its running commands stop
    /// even if its program does not cancel them; then renewed for later ones.
    commands: Mutex<CancellationToken>,
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
            commands: Mutex::new(CancellationToken::new()),
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

    /// What stops the commands the agent runs from now on.
    pub fn commands_stop(&self) -> CancellationToken {
        self.commands.lock().expect("commands lock").clone()
    }

    /// Stops every command the agent is running (the user pressed Stop, or
    /// its session is closing). Commands started later run normally.
    pub fn stop_commands(&self) {
        let running = std::mem::replace(&mut *self.commands.lock().expect("commands lock"), CancellationToken::new());
        running.cancel();
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
        self.ask_with(tool.as_str(), title, detail, false).await
    }

    /// `tool` is a tool's id or `connector:<id>`, which the interface shows.
    async fn ask_with(&self, tool: &str, title: &str, detail: &str, always_offered: bool) -> Answer {
        let reply = self.broker.open(&self.events, &self.id, tool, title, detail, always_offered);
        self.refresh_status();
        let answer = reply.await.unwrap_or(Answer::Denied);
        self.refresh_status();
        answer
    }

    /// The agent's access to a connector; one it was not given is Off.
    pub fn connector_setting(&self, connector_id: &str) -> Setting {
        self.config.read().expect("config lock").connectors.get(connector_id).copied().unwrap_or(Setting::Off)
    }

    /// Applies the agent's setting for a connector to one of its calls. Off
    /// refuses, Ask asks, Allow passes. While the connector's tools differ
    /// from the ones the user approved (`changed`), every call asks and the
    /// answer is not remembered.
    pub async fn gate_connector(&self, connector_id: &str, changed: bool, title: &str, detail: &str) -> Gate {
        let tool = format!("connector:{connector_id}");
        let setting = self.connector_setting(connector_id);
        let always_offered = match setting {
            Setting::Off => return Gate::Off,
            _ if changed => false,
            Setting::Allow => return Gate::Allowed,
            Setting::Ask => true,
        };
        match self.ask_with(&tool, title, detail, always_offered).await {
            Answer::Denied => Gate::Denied,
            Answer::Allowed => Gate::Allowed,
            Answer::Always if !always_offered => Gate::Allowed,
            Answer::Always => {
                let (permissions, connectors) = {
                    let mut config = self.config.write().expect("config lock");
                    config.connectors.insert(connector_id.to_string(), Setting::Allow);
                    (
                        serde_json::to_value(&config.permissions).unwrap_or_default(),
                        serde_json::to_value(&config.connectors).unwrap_or_default(),
                    )
                };
                self.events.settings(&self.id, &permissions, Some(&connectors));
                Gate::Allowed
            }
        }
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
        match self.ask_with(strictest.as_str(), title, detail, true).await {
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
                self.events.settings(&self.id, &permissions, None);
                Gate::Allowed
            }
        }
    }
}
