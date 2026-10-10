//! Connectors: MCP servers the user added, shared by every project. The core
//! runs each one's client itself and serves its tools to an agent through
//! that agent's own tool server, so the app checks, logs and can stop every
//! call, and secrets never reach the agent.

pub mod client;
pub mod gateway;
pub mod hash;
pub mod model;
pub mod store;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, Weak};

use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use crate::events::Events;
use crate::store::Db;

use client::{Live, StartError};
use gateway::{approval_differs, Gateway};
use model::{Connector, State as ConnectorState, Trust};
use store::Keys;

/// After this many failed starts in a row a connector stays stopped until the user tests it.
const MAX_TRIES: u32 = 3;

#[derive(Default)]
struct Known {
    state: ConnectorState,
    failures: u32,
}

/// Connector records, their last known state, and the agent sessions using them.
pub struct Hub {
    /// Set once in setup, so the hub can reach managed state (the database, events).
    app: OnceLock<AppHandle>,
    events: OnceLock<Events>,
    /// Tests give a database and a folder here instead of the app's.
    db: OnceLock<Db>,
    work: OnceLock<PathBuf>,
    keys: Box<dyn Keys>,
    /// Loaded from the database on first use, then kept in step with it.
    records: Mutex<Option<Vec<Connector>>>,
    known: Mutex<HashMap<String, Known>>,
    gateways: Mutex<Vec<Weak<Gateway>>>,
}

impl Default for Hub {
    fn default() -> Self {
        Self {
            app: OnceLock::new(),
            events: OnceLock::new(),
            db: OnceLock::new(),
            work: OnceLock::new(),
            keys: Box::new(store::Keychain),
            records: Mutex::default(),
            known: Mutex::default(),
            gateways: Mutex::default(),
        }
    }
}

impl Hub {
    pub fn attach(&self, app: AppHandle) {
        let _ = self.events.set(Events::new(app.clone()));
        let _ = self.app.set(app);
    }

    #[allow(dead_code, reason = "kept for callers outside this module")]
    pub fn app(&self) -> Option<&AppHandle> {
        self.app.get()
    }

    #[cfg(test)]
    pub fn detached(db: Db, keys: Box<dyn Keys>, events: Events, work: PathBuf) -> Self {
        let hub = Hub { keys, ..Default::default() };
        let _ = hub.db.set(db);
        let _ = hub.events.set(events);
        let _ = hub.work.set(work);
        hub
    }

    fn with_db<R>(&self, f: impl FnOnce(&Db) -> Result<R, String>) -> Result<R, String> {
        if let Some(db) = self.db.get() {
            return f(db);
        }
        let app = self.app.get().ok_or("The app is still starting.")?;
        let db = app.try_state::<Db>().ok_or("The database is not open.")?;
        f(db.inner())
    }

    /// Where a local server runs: the app's own folder, never a project.
    fn workdir(&self, id: &str) -> PathBuf {
        let base = match (self.work.get(), self.app.get().and_then(|a| a.path().app_data_dir().ok())) {
            (Some(work), _) => work.clone(),
            (None, Some(data)) => data.join("connectors"),
            (None, None) => std::env::temp_dir().join("connectors"),
        };
        base.join(id)
    }

    pub fn connectors(&self) -> Result<Vec<Connector>, String> {
        let mut records = self.records.lock().expect("records lock");
        if records.is_none() {
            *records = Some(self.with_db(store::load_all)?);
        }
        Ok(records.clone().unwrap_or_default())
    }

    pub fn connector(&self, id: &str) -> Option<Connector> {
        self.connectors().ok()?.into_iter().find(|c| c.id == id)
    }

    fn keep(&self, c: &Connector) {
        let mut records = self.records.lock().expect("records lock");
        let list = records.get_or_insert_with(Vec::new);
        match list.iter_mut().find(|r| r.id == c.id) {
            Some(r) => *r = c.clone(),
            None => list.push(c.clone()),
        }
    }

    pub fn state(&self, id: &str) -> ConnectorState {
        self.known.lock().expect("known lock").get(id).map(|k| k.state.clone()).unwrap_or_default()
    }

    fn set_state(&self, id: &str, state: ConnectorState, failures: Option<u32>) {
        {
            let mut known = self.known.lock().expect("known lock");
            let k = known.entry(id.to_string()).or_default();
            if k.state == state && failures.is_none_or(|f| f == k.failures) {
                return;
            }
            k.state = state.clone();
            if let Some(f) = failures {
                k.failures = f;
            }
        }
        if let Some(events) = self.events.get() {
            events.connector_state(id, &state);
        }
    }

    /// One start, recorded in the connector's state and its count of failures.
    /// The reason goes into the state, which only the user sees.
    async fn attempt(&self, c: &Connector) -> Result<Live, StartError> {
        match client::start(c, &*self.keys, &self.workdir(&c.id)).await {
            Ok(live) => {
                let tools = hash::infos(&live.tools);
                let state = if approval_differs(c, &live.hash) {
                    ConnectorState::Changed { tools, hash: live.hash.clone() }
                } else {
                    ConnectorState::Ok { tools, hash: live.hash.clone() }
                };
                self.set_state(&c.id, state, Some(0));
                Ok(live)
            }
            Err(e) => {
                match &e {
                    // Trying again would not help: the user has to act.
                    StartError::SignIn(reason) => {
                        self.set_state(&c.id, ConnectorState::SignIn { reason: reason.clone() }, Some(MAX_TRIES))
                    }
                    StartError::Failed(reason) => self.fail(&c.id, reason),
                }
                Err(e)
            }
        }
    }

    fn fail(&self, id: &str, reason: &str) {
        let failures = self.known.lock().expect("known lock").get(id).map_or(0, |k| k.failures) + 1;
        let state = ConnectorState::Failed { reason: reason.to_string(), retries_left: MAX_TRIES.saturating_sub(failures) };
        self.set_state(id, state, Some(failures));
    }

    /// Starts a connector for an agent, unless it failed too often or needs a
    /// sign-in. The error is what the agent is told: never the reason the
    /// user sees, which can quote what the server printed.
    pub async fn start(&self, id: &str) -> Result<Live, String> {
        let c = self.connector(id).ok_or("This connector was removed.")?;
        let stopped = self.known.lock().expect("known lock").get(id).is_some_and(|k| k.failures >= MAX_TRIES);
        if stopped {
            return Err(match self.state(id) {
                ConnectorState::SignIn { .. } => StartError::SignIn(String::new()).for_agent().into(),
                _ => format!(
                    "It stopped after {MAX_TRIES} failed starts. The user can see why, and test it again, on the Connectors page."
                ),
            });
        }
        self.attempt(&c).await.map_err(|e| e.for_agent().to_string())
    }

    /// A running client stopped by itself; the next call starts it again.
    pub fn lost(&self, id: &str, reason: &str) {
        self.fail(id, &format!("It stopped: {reason}"));
    }

    fn register(&self, gw: &Arc<Gateway>) {
        let mut gateways = self.gateways.lock().expect("gateways lock");
        gateways.retain(|g| g.strong_count() > 0);
        gateways.push(Arc::downgrade(gw));
    }

    /// Stops a connector's clients in every session, after it changed or went.
    async fn forget(&self, id: &str) {
        let gateways: Vec<Arc<Gateway>> = self.gateways.lock().expect("gateways lock").iter().filter_map(Weak::upgrade).collect();
        for gw in gateways {
            gw.stop_client(id).await;
        }
    }

    /// The record as the interface sees it: secrets only as set or not.
    fn shown(&self, c: &Connector) -> Connector {
        let mut c = c.clone();
        let id = c.id.clone();
        let vars = match &mut c.transport {
            model::Transport::Command { env, .. } => env,
            model::Transport::Url { headers, .. } => headers,
        };
        for var in vars.iter_mut() {
            var.is_set = None;
            if var.secret {
                var.value.clear();
                var.is_set = Some(matches!(self.keys.secret(&model::secret_name(&id, &var.name)), Ok(Some(_))));
            }
        }
        c
    }

    pub fn list(&self) -> Result<Vec<Value>, String> {
        Ok(self
            .connectors()?
            .iter()
            .map(|c| serde_json::json!({ "connector": self.shown(c), "state": self.state(&c.id) }))
            .collect())
    }

    pub async fn save(&self, connector: Connector) -> Result<Connector, String> {
        let (mut c, secrets) = model::check(connector)?;
        if c.id.is_empty() {
            c.id = crate::events::new_id("c");
        }
        model::check_id(&c.id)?;
        let existing = self.connector(&c.id);
        match &existing {
            Some(old) => {
                if old.slug != c.slug {
                    return Err("The short name cannot change once a connector is made.".into());
                }
                c.created = old.created;
                c.approved_hash = old.approved_hash.clone();
            }
            None => {
                c.created = crate::store::data::now();
                c.approved_hash = None;
            }
        }
        if self.connectors()?.iter().any(|o| o.slug == c.slug && o.id != c.id) {
            return Err(format!("Another connector already uses the short name \"{}\".", c.slug));
        }
        // Saving is the user's review: the record is signed again.
        c.trust = Trust::Ok;
        self.with_db(|db| store::put(db, &c))?;
        for (name, value) in &secrets {
            self.keys.set_secret(&model::secret_name(&c.id, name), Some(value))?;
        }
        // Secrets of variables that are gone or no longer secret are removed.
        if let Some(old) = &existing {
            for var in old.transport.vars().iter().filter(|v| v.secret) {
                if !c.transport.vars().iter().any(|n| n.secret && n.name == var.name) {
                    self.keys.set_secret(&model::secret_name(&c.id, &var.name), None)?;
                }
            }
        }
        self.keep(&c);
        self.forget(&c.id).await;
        if existing.is_some_and(|old| old.transport != c.transport) {
            // Another server, perhaps: what was seen of the old one no longer says anything.
            self.set_state(&c.id, ConnectorState::Unchecked, Some(0));
        }
        Ok(self.shown(&c))
    }

    pub async fn remove(&self, id: &str) -> Result<(), String> {
        self.forget(id).await;
        if let Some(c) = self.connector(id) {
            for var in c.transport.vars().iter().filter(|v| v.secret) {
                self.keys.set_secret(&model::secret_name(id, &var.name), None)?;
            }
        }
        self.with_db(|db| store::delete(db, id))?;
        if let Some(list) = self.records.lock().expect("records lock").as_mut() {
            list.retain(|c| c.id != id);
        }
        self.known.lock().expect("known lock").remove(id);
        Ok(())
    }

    pub async fn set_secret(&self, id: &str, name: &str, value: Option<String>) -> Result<(), String> {
        let c = self.connector(id).ok_or("No such connector.")?;
        if !c.transport.vars().iter().any(|v| v.secret && v.name == name) {
            return Err(format!("{name} is not one of this connector's secrets."));
        }
        let value = value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        self.keys.set_secret(&model::secret_name(id, name), value.as_deref())?;
        // Running clients have the old value.
        self.forget(id).await;
        Ok(())
    }

    /// The user's test: clears the failure count, starts it, lists its tools, stops it.
    pub async fn test(&self, id: &str) -> Result<ConnectorState, String> {
        let c = self.connector(id).ok_or("No such connector.")?;
        self.set_state(id, ConnectorState::Checking, Some(0));
        if let Ok(live) = self.attempt(&c).await {
            live.stop().await;
        }
        Ok(self.state(id))
    }

    pub fn approve(&self, id: &str, hash: &str) -> Result<Connector, String> {
        let mut c = self.connector(id).ok_or("No such connector.")?;
        // Approving signs the whole record again, so it would vouch for
        // settings the user has not seen: its command, URL, variables.
        if c.trust == Trust::ChangedOutside {
            return Err("Review and save this connector first: its saved settings were changed outside the app.".into());
        }
        let tools = match self.state(id) {
            ConnectorState::Ok { tools, hash: h } | ConnectorState::Changed { tools, hash: h } if h == hash => tools,
            ConnectorState::Ok { .. } | ConnectorState::Changed { .. } => {
                return Err("Its tools changed since they were shown. Look at them again.".into())
            }
            _ => return Err("Test the connector first, to see its tools.".into()),
        };
        c.approved_hash = Some(hash.to_string());
        c.trust = Trust::Ok;
        self.with_db(|db| store::put(db, &c))?;
        self.keep(&c);
        self.set_state(id, ConnectorState::Ok { tools, hash: hash.to_string() }, None);
        Ok(self.shown(&c))
    }
}

fn to_value<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn connectors_list(hub: State<'_, Arc<Hub>>) -> Result<Vec<Value>, String> {
    hub.list()
}

#[tauri::command]
pub async fn connector_save(connector: Connector, hub: State<'_, Arc<Hub>>) -> Result<Value, String> {
    to_value(hub.save(connector).await?)
}

#[tauri::command]
pub async fn connector_remove(id: String, hub: State<'_, Arc<Hub>>) -> Result<(), String> {
    hub.remove(&id).await
}

#[tauri::command]
pub async fn connector_set_secret(id: String, name: String, value: Option<String>, hub: State<'_, Arc<Hub>>) -> Result<(), String> {
    hub.set_secret(&id, &name, value).await
}

#[tauri::command]
pub async fn connector_test(id: String, hub: State<'_, Arc<Hub>>) -> Result<Value, String> {
    to_value(hub.test(&id).await?)
}

#[tauri::command]
pub async fn connector_approve(id: String, hash: String, hub: State<'_, Arc<Hub>>) -> Result<Value, String> {
    to_value(hub.approve(&id, &hash)?)
}

#[cfg(test)]
pub mod tests;
