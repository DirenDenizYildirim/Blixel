//! Mods: folders that add themes, rules for agents, layouts, commands and
//! views. The core keeps the installed folders, what the user approved and a
//! hash of each approved mod's files, and each mod's storage. It serves an
//! enabled mod's files to the sandboxed frames its code runs in (scheme.rs),
//! keeps every frame on the app or on mod files (navigation.rs) and sets up
//! the app's webview so mod frames cannot reach the network (webview.rs).
//!
//! On disk, under the app's data folder:
//! - `mods/<id>/`: installed mods, each folder named by its manifest id;
//! - `mods-state.json`: per mod, whether it is on, what was granted, the
//!   approved hash and, for a dev mod, the author's folder;
//! - `mods-data/<id>.json`: what each mod stored, at most 1 MB;
//! - `mods-running`: present while code mods may run, so a session that ends
//!   without a clean exit is noticed at the next start. A clean exit is one
//!   where the interface still answered (Mods::exit).

mod folder;
mod manifest;
pub mod navigation;
pub mod scheme;
pub mod webview;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use folder::{FileHash, Hashes};
use manifest::Checked;

/// Each mod's storage holds at most this much, as JSON.
const MAX_STORAGE_BYTES: usize = 1024 * 1024;
/// The interface says it is alive every 2 s (mods_heartbeat). An exit more
/// than this long after the last time followed a frozen or crashed page.
const HEARTBEAT_STALE: Duration = Duration::from_secs(6);

/// One mod as the interface sees it (ModRecord in src/mods/types.ts).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModRecord {
    id: String,
    dir: String,
    dev: bool,
    enabled: bool,
    granted: Vec<String>,
    manifest: Option<Value>,
    error: Option<String>,
    changed: bool,
}

/// ModsState in src/mods/types.ts.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModsState {
    mods: Vec<ModRecord>,
    disabled_by_flag: bool,
    safe_start_suggested: bool,
}

/// What the user decided about one mod, kept in mods-state.json.
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
struct Saved {
    enabled: bool,
    granted: Vec<String>,
    /// The hash of its files when the user last turned it on.
    approved_hash: Option<String>,
    /// Set for a dev mod: the author's folder, used in place.
    dev_path: Option<PathBuf>,
}

#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(default)]
struct SavedState {
    mods: BTreeMap<String, Saved>,
}

/// An enabled mod whose files the `mod` scheme may serve.
#[derive(Clone, Debug)]
pub struct Served {
    /// Canonical, so a resolved file can be checked to be inside it.
    pub dir: PathBuf,
    pub main: Option<String>,
    /// For an installed mod, each file's hash as approved: the scheme serves
    /// only these files with these contents. None for a dev mod.
    pub files: Option<Arc<HashMap<String, FileHash>>>,
}

/// One mod found by a scan.
struct Found {
    record: ModRecord,
    served: Option<Served>,
    /// Enabled and has code that runs.
    runs_code: bool,
}

pub struct Mods {
    data: PathBuf,
    disabled_by_flag: bool,
    safe_start_suggested: bool,
    /// Held while mods or their state change, so two changes never interleave.
    lock: Mutex<()>,
    storage_lock: Mutex<()>,
    served: RwLock<HashMap<String, Served>>,
    /// Installed mods with a file that changed while served: they show as
    /// changed until the user approves them again, even if it changes back.
    tampered: Mutex<HashSet<String>>,
    last_heartbeat: Mutex<Option<Instant>>,
    page_crashed: AtomicBool,
    /// The window's own page is loading (webview.rs): no mod file is served.
    window_loading: AtomicBool,
}

impl Mods {
    /// `data` is the app's data folder. A marker left by the last session
    /// means it ended while code mods could run.
    pub fn open(data: PathBuf, disabled_by_flag: bool) -> Self {
        let safe_start_suggested = !disabled_by_flag && data.join("mods-running").exists();
        Self {
            data,
            disabled_by_flag,
            safe_start_suggested,
            lock: Mutex::default(),
            storage_lock: Mutex::default(),
            served: RwLock::default(),
            tampered: Mutex::default(),
            last_heartbeat: Mutex::default(),
            page_crashed: AtomicBool::new(false),
            window_loading: AtomicBool::new(false),
        }
    }

    fn mods_dir(&self) -> PathBuf {
        self.data.join("mods")
    }

    fn marker(&self) -> PathBuf {
        self.data.join("mods-running")
    }

    /// The interface is alive: it calls this every 2 s while it runs.
    pub fn heartbeat(&self) {
        self.heartbeat_at(Instant::now());
    }

    fn heartbeat_at(&self, now: Instant) {
        *self.last_heartbeat.lock().expect("heartbeat lock") = Some(now);
    }

    /// The window's web process crashed, so this session ends uncleanly.
    pub fn page_crashed(&self) {
        self.page_crashed.store(true, Ordering::Relaxed);
    }

    /// The app is exiting. Closing the window from the window manager looks
    /// like a normal exit even when a mod view froze the page or the page
    /// crashed, so the marker goes only if the interface still answered.
    /// Otherwise the next start offers to leave mod code off.
    pub fn exit(&self) {
        self.exit_at(Instant::now());
    }

    fn exit_at(&self, now: Instant) {
        if self.answering_at(now) {
            let _ = std::fs::remove_file(self.marker());
        }
    }

    fn answering_at(&self, now: Instant) -> bool {
        let last = *self.last_heartbeat.lock().expect("heartbeat lock");
        let recent = last.is_some_and(|at| now.saturating_duration_since(at) <= HEARTBEAT_STALE);
        recent && !self.page_crashed.load(Ordering::Relaxed)
    }

    /// The window's own page started loading (true) or committed (false).
    /// Meanwhile a mod file asked for may be meant to become that page.
    pub fn set_window_loading(&self, loading: bool) {
        self.window_loading.store(loading, Ordering::Relaxed);
    }

    pub fn window_loading(&self) -> bool {
        self.window_loading.load(Ordering::Relaxed)
    }

    /// An enabled, runnable mod's folder, for the `mod` scheme.
    pub fn served(&self, id: &str) -> Option<Served> {
        self.served.read().expect("mods lock").get(id).cloned()
    }

    /// Whether `bytes`, just read from `path` for the scheme, may be served:
    /// for an installed mod, `path` must be one of its files as approved, with
    /// the same contents. Anything else means its folder changed while it
    /// ran: the whole mod stops being served and shows as changed.
    pub fn may_serve(&self, id: &str, served: &Served, path: &Path, bytes: &[u8]) -> bool {
        let Some(approved) = &served.files else { return true };
        let rel = path.strip_prefix(&served.dir).ok().and_then(|rel| {
            rel.components().map(|c| c.as_os_str().to_str()).collect::<Option<Vec<_>>>().map(|parts| parts.join("/"))
        });
        if rel.is_some_and(|rel| approved.get(&rel) == Some(&folder::file_hash(bytes))) {
            return true;
        }
        eprintln!("mod {id} changed while it ran: {} is not as approved", path.display());
        self.tampered.lock().expect("tampered lock").insert(id.to_string());
        self.served.write().expect("mods lock").remove(id);
        false
    }

    pub fn list(&self) -> ModsState {
        let _held = self.lock.lock().expect("mods lock");
        let mods = self.refresh(&self.load_state());
        ModsState {
            mods,
            disabled_by_flag: self.disabled_by_flag,
            safe_start_suggested: self.safe_start_suggested,
        }
    }

    /// Copies a mod folder in, replacing an installed mod with the same id.
    /// It starts off, so it needs the user's approval like a new one.
    pub fn install(&self, source: &str) -> Result<ModRecord, String> {
        let source = PathBuf::from(source).canonicalize().map_err(|e| format!("Cannot open {source}: {e}"))?;
        let files = folder::list(&source)?;
        let checked = manifest::check(&manifest::read(&source)?, &files)?;
        let _held = self.lock.lock().expect("mods lock");
        let mods_dir = self.mods_dir();
        std::fs::create_dir_all(&mods_dir).map_err(|e| format!("Cannot create the mods folder: {e}"))?;
        if mods_dir.canonicalize().is_ok_and(|m| source.starts_with(m)) {
            return Err("This folder is already in the mods folder.".into());
        }
        // Copy beside the target first, so a failed copy leaves the old one in place.
        let temp = mods_dir.join(format!(".installing-{}-{}", checked.id, std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        let copied = folder::copy(&source, &files, &temp).and_then(|()| {
            // What gets approved is the copy, so check the copy, in case the source changed meanwhile.
            let files = folder::list(&temp)?;
            manifest::check(&manifest::read(&temp)?, &files).map(|_| ())
        });
        if let Err(e) = copied {
            let _ = std::fs::remove_dir_all(&temp);
            return Err(e);
        }
        let target = mods_dir.join(&checked.id);
        remove_path(&target).map_err(|e| format!("Cannot replace the installed copy: {e}"))?;
        std::fs::rename(&temp, &target).map_err(|e| format!("Cannot install it: {e}"))?;
        let mut state = self.load_state();
        // Off, nothing granted; a dev mod with this id is replaced by the installed one.
        state.mods.insert(checked.id.clone(), Saved::default());
        self.tampered.lock().expect("tampered lock").remove(&checked.id);
        self.save_state(&state)?;
        self.record_after_change(&state, &checked.id)
    }

    /// Loads a mod in place from the author's folder. Its files may change
    /// without approval, so the author can work on it.
    pub fn dev_load(&self, source: &str) -> Result<ModRecord, String> {
        let source = PathBuf::from(source).canonicalize().map_err(|e| format!("Cannot open {source}: {e}"))?;
        if !source.is_dir() {
            return Err(format!("{} is not a folder.", source.display()));
        }
        let manifest = manifest::read(&source)?;
        let id = manifest::id_of(&manifest)
            .ok_or("Its mod.json needs an id like author.name: lower-case letters, digits and dashes, with one dot.")?
            .to_string();
        let _held = self.lock.lock().expect("mods lock");
        if std::fs::symlink_metadata(self.mods_dir().join(&id)).is_ok() {
            return Err(format!("A mod with the id {id} is installed. Remove it before loading your folder in its place."));
        }
        let mut state = self.load_state();
        state.mods.insert(id.clone(), Saved { dev_path: Some(source), ..Saved::default() });
        self.save_state(&state)?;
        self.record_after_change(&state, &id)
    }

    /// Removes an installed mod's folder, or forgets a dev mod, and its storage.
    pub fn uninstall(&self, id: &str) -> Result<(), String> {
        // Not only valid ids: a folder with a bad name must still be removable.
        if !folder::is_part(id) || id.starts_with('.') {
            return Err(format!("No mod with the id {id} is installed."));
        }
        let _held = self.lock.lock().expect("mods lock");
        let mut state = self.load_state();
        let target = self.mods_dir().join(id);
        let mut found = std::fs::symlink_metadata(&target).is_ok();
        if found {
            remove_path(&target).map_err(|e| format!("Cannot remove it: {e}"))?;
        }
        found |= state.mods.remove(id).is_some();
        if !found {
            return Err(format!("No mod with the id {id} is installed."));
        }
        self.tampered.lock().expect("tampered lock").remove(id);
        // Saved first: from then on storage refuses this id (storage_path), so
        // a late write from its code cannot bring the file back.
        self.save_state(&state)?;
        if manifest::is_valid_id(id) {
            let _storage = self.storage_lock.lock().expect("storage lock");
            let _ = std::fs::remove_file(self.storage_file(id)?);
        }
        self.refresh(&state);
        Ok(())
    }

    /// Turns a mod on with exactly `granted`, recording the hash of its files
    /// as approved; or turns it off.
    pub fn set_enabled(&self, id: &str, enabled: bool, granted: Vec<String>) -> Result<ModRecord, String> {
        let _held = self.lock.lock().expect("mods lock");
        let mut state = self.load_state();
        let (dir, dev) = self.locate(id, &state).ok_or_else(|| format!("No mod with the id {id} is installed."))?;
        if enabled {
            let (checked, hashes) = inspect(&dir, (!dev).then_some(id)).1.map_err(|e| format!("It cannot be turned on. {e}"))?;
            let mut granted_now = Vec::new();
            for g in granted {
                if !checked.permissions.contains(&g) {
                    return Err(format!("It did not ask for {g}, so it cannot be granted."));
                }
                if !granted_now.contains(&g) {
                    granted_now.push(g);
                }
            }
            let saved = state.mods.entry(id.to_string()).or_default();
            saved.enabled = true;
            saved.granted = granted_now;
            saved.approved_hash = Some(hashes.folder);
            // Approving again covers whatever changed while it ran.
            self.tampered.lock().expect("tampered lock").remove(id);
        } else if let Some(saved) = state.mods.get_mut(id) {
            saved.enabled = false;
        }
        self.save_state(&state)?;
        self.record_after_change(&state, id)
    }

    fn record_after_change(&self, state: &SavedState, id: &str) -> Result<ModRecord, String> {
        self.refresh(state).into_iter().find(|r| r.id == id).ok_or_else(|| format!("{id} could not be read back."))
    }

    /// Where a mod's files are, and whether it is a dev mod.
    fn locate(&self, id: &str, state: &SavedState) -> Option<(PathBuf, bool)> {
        let installed = self.mods_dir().join(id);
        if folder::is_part(id) && std::fs::symlink_metadata(&installed).is_ok() {
            return Some((installed, false));
        }
        state.mods.get(id)?.dev_path.clone().map(|p| (p, true))
    }

    /// Reads every mod, then updates what the scheme may serve and the
    /// marker. Needs `self.lock`.
    fn refresh(&self, state: &SavedState) -> Vec<ModRecord> {
        let found = self.scan(state);
        let runs_code = !self.disabled_by_flag && found.iter().any(|f| f.runs_code);
        if runs_code {
            let _ = std::fs::create_dir_all(&self.data);
            let _ = std::fs::write(self.marker(), "");
        } else {
            let _ = std::fs::remove_file(self.marker());
        }
        let served = if self.disabled_by_flag {
            HashMap::new()
        } else {
            found.iter().filter_map(|f| Some((f.record.id.clone(), f.served.clone()?))).collect()
        };
        *self.served.write().expect("mods lock") = served;
        found.into_iter().map(|f| f.record).collect()
    }

    fn scan(&self, state: &SavedState) -> Vec<Found> {
        let tampered = self.tampered.lock().expect("tampered lock").clone();
        let mut found = Vec::new();
        if let Ok(entries) = std::fs::read_dir(self.mods_dir()) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                // Folders being installed start with a dot; plain files are not mods.
                if name.starts_with('.') || entry.file_type().is_ok_and(|t| t.is_file()) {
                    continue;
                }
                found.push(judge(&name, &entry.path(), false, state.mods.get(&name), tampered.contains(&name)));
            }
        }
        for (id, saved) in &state.mods {
            if let Some(path) = &saved.dev_path {
                if !found.iter().any(|f| &f.record.id == id) {
                    found.push(judge(id, path, true, Some(saved), false));
                }
            }
        }
        found.sort_by(|a, b| a.record.id.cmp(&b.record.id));
        found
    }

    fn load_state(&self) -> SavedState {
        std::fs::read_to_string(self.data.join("mods-state.json"))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    fn save_state(&self, state: &SavedState) -> Result<(), String> {
        let text = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
        write_atomic(&self.data.join("mods-state.json"), text.as_bytes()).map_err(|e| format!("Cannot save the mods' state: {e}"))
    }

    fn storage_file(&self, id: &str) -> Result<PathBuf, String> {
        if !manifest::is_valid_id(id) {
            return Err(format!("{id} is not a mod id."));
        }
        Ok(self.data.join("mods-data").join(format!("{id}.json")))
    }

    /// Storage for a mod's own reads and writes. Only installed and dev mods
    /// have it, so a write arriving after a mod was removed cannot bring its
    /// storage back.
    fn storage_path(&self, id: &str) -> Result<PathBuf, String> {
        let path = self.storage_file(id)?;
        if self.locate(id, &self.load_state()).is_none() {
            return Err(format!("{id} is not installed."));
        }
        Ok(path)
    }

    pub fn storage_get(&self, id: &str, key: &str) -> Result<Option<Value>, String> {
        // Locked before the check, so an uninstall cannot pass between check and use.
        let _held = self.storage_lock.lock().expect("storage lock");
        let path = self.storage_path(id)?;
        Ok(read_storage(&path).remove(key))
    }

    /// Stores a value (None removes it), refusing to grow past 1 MB.
    pub fn storage_set(&self, id: &str, key: &str, value: Option<Value>) -> Result<(), String> {
        let _held = self.storage_lock.lock().expect("storage lock");
        let path = self.storage_path(id)?;
        let mut stored = read_storage(&path);
        match value {
            Some(value) => stored.insert(key.to_string(), value),
            None => stored.remove(key),
        };
        if stored.is_empty() {
            let _ = std::fs::remove_file(&path);
            return Ok(());
        }
        let text = serde_json::to_string(&stored).map_err(|e| e.to_string())?;
        if text.len() > MAX_STORAGE_BYTES {
            return Err("This mod's storage is full: each mod may keep at most 1 MB.".into());
        }
        write_atomic(&path, text.as_bytes()).map_err(|e| format!("Cannot save this mod's storage: {e}"))
    }
}

/// A mod's folder checked: its manifest as read (for the interface), and
/// either what the core relies on plus the hashes of its files, or why it
/// cannot run. `folder_id` is the folder's name, for installed mods.
fn inspect(dir: &Path, folder_id: Option<&str>) -> (Option<Value>, Result<(Checked, Hashes), String>) {
    let manifest = manifest::read(dir);
    let checked = folder::list(dir).and_then(|files| {
        let checked = manifest::check(manifest.as_ref().map_err(Clone::clone)?, &files)?;
        if let Some(name) = folder_id.filter(|name| *name != checked.id) {
            return Err(format!("Its folder is named {name}, but its id is {}.", checked.id));
        }
        let hashes = folder::hash(dir, &files)?;
        Ok((checked, hashes))
    });
    (manifest.ok().filter(Value::is_object), checked)
}

/// Builds the record for one mod: valid or not, on or off, changed or not.
/// `tampered`: a file of it changed while it was served.
fn judge(id: &str, dir: &Path, dev: bool, saved: Option<&Saved>, tampered: bool) -> Found {
    let (manifest, checked) = if std::fs::symlink_metadata(dir).is_ok() {
        inspect(dir, (!dev).then_some(id))
    } else {
        (None, Err(format!("Its folder is gone: {}", dir.display())))
    };
    let wanted = saved.is_some_and(|s| s.enabled);
    let approved = saved.and_then(|s| s.approved_hash.as_deref());
    let (error, changed, served, has_code, permissions) = match &checked {
        Err(e) => (Some(e.clone()), false, None, false, None),
        Ok((checked, hashes)) => {
            // A dev mod's files change as its author works; that is expected.
            let changed = !dev && wanted && (tampered || approved != Some(hashes.folder.as_str()));
            // Read in the same pass as the folder's hash, so when that is the
            // approved one, these are the approved files.
            let files = (!dev).then(|| Arc::new(hashes.files.clone()));
            let served = dir.canonicalize().ok().map(|dir| Served { dir, main: checked.main.clone(), files });
            (None, changed, served, checked.has_code(), Some(&checked.permissions))
        }
    };
    let enabled = wanted && error.is_none() && !changed;
    // Only what it still asks for counts as granted.
    let granted = saved
        .map(|s| s.granted.iter().filter(|g| permissions.is_none_or(|p| p.contains(g))).cloned().collect())
        .unwrap_or_default();
    Found {
        record: ModRecord {
            id: id.to_string(),
            dir: dir.display().to_string(),
            dev,
            enabled,
            granted,
            manifest,
            error,
            changed,
        },
        served: served.filter(|_| enabled),
        runs_code: enabled && has_code,
    }
}

fn read_storage(path: &Path) -> serde_json::Map<String, Value> {
    // Unreadable storage starts empty rather than blocking the mod for good.
    std::fs::read_to_string(path).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
}

/// Writes through a temporary file, so a crash never leaves half a file.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, bytes)?;
    std::fs::rename(&temp, path)
}

/// Removes a file, a link (not what it points to) or a folder, if present.
fn remove_path(path: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Runs mod work on a worker thread: it reads whole folders.
async fn on_worker<T: Send + 'static>(
    app: AppHandle,
    work: impl FnOnce(&Mods) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || work(&app.state::<Mods>())).await.map_err(|e| e.to_string())?
}

/// The interface calls this every 2 s while it runs; see Mods::exit.
#[tauri::command]
pub fn mods_heartbeat(mods: tauri::State<Mods>) {
    mods.heartbeat();
}

#[tauri::command]
pub async fn mods_list(app: AppHandle) -> Result<ModsState, String> {
    on_worker(app, |mods| Ok(mods.list())).await
}

#[tauri::command]
pub async fn mods_install(path: String, app: AppHandle) -> Result<ModRecord, String> {
    on_worker(app, move |mods| mods.install(&path)).await
}

#[tauri::command]
pub async fn mods_dev_load(path: String, app: AppHandle) -> Result<ModRecord, String> {
    on_worker(app, move |mods| mods.dev_load(&path)).await
}

#[tauri::command]
pub async fn mods_uninstall(id: String, app: AppHandle) -> Result<(), String> {
    on_worker(app, move |mods| mods.uninstall(&id)).await
}

#[tauri::command]
pub async fn mods_set_enabled(id: String, enabled: bool, granted: Vec<String>, app: AppHandle) -> Result<ModRecord, String> {
    on_worker(app, move |mods| mods.set_enabled(&id, enabled, granted)).await
}

#[tauri::command]
pub async fn mod_storage_get(id: String, key: String, app: AppHandle) -> Result<Option<Value>, String> {
    on_worker(app, move |mods| mods.storage_get(&id, &key)).await
}

#[tauri::command]
pub async fn mod_storage_set(id: String, key: String, value: Option<Value>, app: AppHandle) -> Result<(), String> {
    on_worker(app, move |mods| mods.storage_set(&id, &key, value)).await
}

#[cfg(test)]
mod tests {
    use super::folder::tests::{temp_dir, write};
    use super::*;

    const MANIFEST: &str = r#"{ "id": "ada.clock", "name": "Clock", "version": "1.0.0", "api": 1,
        "main": "main.js", "permissions": ["files:read"] }"#;

    /// An author's mod folder and an empty data folder.
    fn setup(name: &str) -> (PathBuf, Mods) {
        let source = temp_dir(&format!("{name}-src"));
        write(&source, "mod.json", MANIFEST);
        write(&source, "main.js", "host.log('hi')");
        let data = temp_dir(&format!("{name}-data"));
        (source, Mods::open(data, false))
    }

    fn only(mods: &Mods) -> ModRecord {
        let state = mods.list();
        assert_eq!(state.mods.len(), 1, "{:?}", state.mods);
        state.mods[0].clone()
    }

    #[test]
    fn an_installed_mod_starts_off_and_runs_once_approved() {
        let (source, mods) = setup("install");
        let record = mods.install(source.to_str().unwrap()).unwrap();
        assert_eq!(record.id, "ada.clock");
        assert!(!record.enabled && !record.dev && record.error.is_none());
        assert!(mods.data.join("mods/ada.clock/main.js").is_file());
        assert!(mods.served("ada.clock").is_none());

        let record = mods.set_enabled("ada.clock", true, vec!["files:read".into()]).unwrap();
        assert!(record.enabled && record.granted == vec!["files:read"]);
        assert!(mods.served("ada.clock").is_some_and(|s| s.main.as_deref() == Some("main.js")));
        assert!(mods.marker().exists(), "code may run, so the marker is there");

        mods.set_enabled("ada.clock", false, vec![]).unwrap();
        assert!(mods.served("ada.clock").is_none());
        assert!(!mods.marker().exists());
    }

    #[test]
    fn only_requested_capabilities_can_be_granted() {
        let (source, mods) = setup("grant");
        mods.install(source.to_str().unwrap()).unwrap();
        let e = mods.set_enabled("ada.clock", true, vec!["agents:read".into()]).unwrap_err();
        assert!(e.contains("did not ask for agents:read"), "{e}");
        assert!(!only(&mods).enabled);
    }

    #[test]
    fn a_changed_mod_stays_off_until_approved_again() {
        let (source, mods) = setup("changed");
        mods.install(source.to_str().unwrap()).unwrap();
        mods.set_enabled("ada.clock", true, vec!["files:read".into()]).unwrap();
        write(&mods.data, "mods/ada.clock/main.js", "host.log('changed')");

        let record = only(&mods);
        assert!(record.changed && !record.enabled);
        assert_eq!(record.granted, vec!["files:read"], "its state is kept for approving again");
        assert!(mods.served("ada.clock").is_none());

        let record = mods.set_enabled("ada.clock", true, vec!["files:read".into()]).unwrap();
        assert!(record.enabled && !record.changed);
    }

    #[test]
    fn installing_over_a_mod_replaces_it_and_turns_it_off() {
        let (source, mods) = setup("reinstall");
        mods.install(source.to_str().unwrap()).unwrap();
        mods.set_enabled("ada.clock", true, vec!["files:read".into()]).unwrap();
        std::fs::remove_file(source.join("main.js")).unwrap();
        write(&source, "mod.json", &MANIFEST.replace("\"main.js\"", "\"src/new.js\""));
        write(&source, "src/new.js", "new");

        let record = mods.install(source.to_str().unwrap()).unwrap();
        assert!(!record.enabled && record.granted.is_empty());
        assert!(!mods.data.join("mods/ada.clock/main.js").exists(), "the old copy is gone");
        assert!(mods.data.join("mods/ada.clock/src/new.js").exists());
    }

    #[test]
    fn invalid_mods_are_listed_with_their_error_and_cannot_run() {
        let (source, mods) = setup("invalid");
        assert!(mods.install(source.parent().unwrap().join("missing").to_str().unwrap()).is_err());
        write(&source, "mod.json", &MANIFEST.replace("\"api\": 1", "\"api\": 2"));
        assert!(mods.install(source.to_str().unwrap()).unwrap_err().contains("API version 2"));

        // Dropped into the mods folder by hand, under the wrong name.
        write(&mods.data, "mods/someone.else/mod.json", MANIFEST);
        write(&mods.data, "mods/someone.else/main.js", "x");
        let record = only(&mods);
        assert_eq!(record.id, "someone.else");
        assert!(record.error.as_deref().is_some_and(|e| e.contains("folder is named someone.else")));
        assert!(record.manifest.is_some(), "the manifest is still shown");
        assert!(mods.set_enabled("someone.else", true, vec![]).is_err());
        mods.uninstall("someone.else").unwrap();
        assert!(mods.list().mods.is_empty());
    }

    #[test]
    fn dev_mods_load_in_place_and_may_change() {
        let (source, mods) = setup("dev");
        let record = mods.dev_load(source.to_str().unwrap()).unwrap();
        assert!(record.dev && !record.enabled && record.dir == source.display().to_string());
        mods.set_enabled("ada.clock", true, vec![]).unwrap();
        write(&source, "main.js", "edited by its author");
        let record = only(&mods);
        assert!(record.enabled && !record.changed);

        // An installed mod with the same id is not shadowed by a dev folder.
        mods.install(source.to_str().unwrap()).unwrap();
        assert!(!only(&mods).dev, "installing replaces the dev mod");
        assert!(mods.dev_load(source.to_str().unwrap()).unwrap_err().contains("is installed"));

        mods.uninstall("ada.clock").unwrap();
        mods.dev_load(source.to_str().unwrap()).unwrap();
        std::fs::remove_dir_all(&source).unwrap();
        assert!(only(&mods).error.as_deref().is_some_and(|e| e.contains("gone")));
    }

    #[test]
    fn storage_is_capped_and_removed_with_its_mod() {
        let (source, mods) = setup("storage");
        mods.install(source.to_str().unwrap()).unwrap();
        mods.storage_set("ada.clock", "zone", Some(serde_json::json!("UTC"))).unwrap();
        assert_eq!(mods.storage_get("ada.clock", "zone").unwrap(), Some(serde_json::json!("UTC")));
        assert_eq!(mods.storage_get("ada.clock", "other").unwrap(), None);

        let big = "x".repeat(MAX_STORAGE_BYTES);
        assert!(mods.storage_set("ada.clock", "big", Some(big.into())).unwrap_err().contains("1 MB"));
        assert_eq!(mods.storage_get("ada.clock", "zone").unwrap(), Some(serde_json::json!("UTC")), "nothing was lost");
        assert!(mods.storage_set("../escape", "k", Some(1.into())).is_err());

        mods.uninstall("ada.clock").unwrap();
        assert!(mods.storage_get("ada.clock", "zone").is_err(), "gone with its mod");
        assert!(mods.storage_set("ada.clock", "zone", Some(1.into())).is_err(), "a late write cannot bring it back");
        assert!(!mods.data.join("mods-data/ada.clock.json").exists());
        assert!(mods.uninstall("ada.clock").is_err());
        assert!(mods.uninstall("../mods").is_err());
    }

    #[test]
    fn an_unclean_exit_suggests_starting_without_mods() {
        let (source, mods) = setup("marker");
        mods.install(source.to_str().unwrap()).unwrap();
        mods.set_enabled("ada.clock", true, vec![]).unwrap();
        assert!(!mods.list().safe_start_suggested);
        // The app stops without a clean exit: the marker stays.
        let next = Mods::open(mods.data.clone(), false);
        assert!(next.list().safe_start_suggested);
        next.heartbeat();
        next.exit();
        assert!(!Mods::open(mods.data.clone(), false).safe_start_suggested);

        let flagged = Mods::open(mods.data.clone(), true);
        let state = flagged.list();
        assert!(state.disabled_by_flag && !state.safe_start_suggested);
        assert!(flagged.served("ada.clock").is_none(), "nothing is served with --no-mods");
        assert!(!flagged.marker().exists());
    }

    #[test]
    fn an_exit_counts_as_clean_only_while_the_interface_answers() {
        let (source, mods) = setup("heartbeat");
        mods.install(source.to_str().unwrap()).unwrap();
        mods.set_enabled("ada.clock", true, vec![]).unwrap();
        let start = Instant::now();

        // No heartbeat at all, e.g. the page never came up.
        mods.exit_at(start);
        assert!(mods.marker().exists());

        mods.heartbeat_at(start);
        // The window was frozen for longer than the heartbeat allows, then closed.
        mods.exit_at(start + HEARTBEAT_STALE + Duration::from_secs(1));
        assert!(mods.marker().exists(), "a frozen window closed by the user is not a clean exit");
        mods.exit_at(start + HEARTBEAT_STALE);
        assert!(!mods.marker().exists(), "a recent heartbeat makes it clean");

        // The page crashed: never clean, however recent the last heartbeat.
        mods.list();
        assert!(mods.marker().exists());
        mods.page_crashed();
        mods.heartbeat_at(start);
        mods.exit_at(start);
        assert!(mods.marker().exists());
        assert!(Mods::open(mods.data.clone(), false).list().safe_start_suggested);
    }

    #[test]
    fn an_installed_mod_changed_while_served_is_refused_and_shows_changed() {
        let (source, mods) = setup("tamper");
        write(&source, "view.html", "<p>approved</p>");
        mods.install(source.to_str().unwrap()).unwrap();
        mods.set_enabled("ada.clock", true, vec!["files:read".into()]).unwrap();
        let served = mods.served("ada.clock").unwrap();
        let file = served.dir.join("view.html");
        assert!(mods.may_serve("ada.clock", &served, &file, b"<p>approved</p>"));
        assert!(mods.served("ada.clock").is_some());

        // Changed on disk while it runs: refused, and the mod stops being served.
        assert!(!mods.may_serve("ada.clock", &served, &file, b"<p>changed</p>"));
        assert!(mods.served("ada.clock").is_none());
        // It shows as changed even once the file is back as approved.
        let record = only(&mods);
        assert!(record.changed && !record.enabled);
        assert!(mods.served("ada.clock").is_none());

        // Approving again clears it; a file added since is refused too.
        mods.set_enabled("ada.clock", true, vec!["files:read".into()]).unwrap();
        let served = mods.served("ada.clock").unwrap();
        write(&served.dir, "added.js", "new");
        assert!(!mods.may_serve("ada.clock", &served, &served.dir.join("added.js"), b"new"));
        assert!(only(&mods).changed);
    }

    #[test]
    fn a_dev_mod_is_served_as_it_is_now() {
        let (source, mods) = setup("dev-serve");
        mods.dev_load(source.to_str().unwrap()).unwrap();
        mods.set_enabled("ada.clock", true, vec![]).unwrap();
        let served = mods.served("ada.clock").unwrap();
        assert!(served.files.is_none());
        assert!(mods.may_serve("ada.clock", &served, &served.dir.join("main.js"), b"edited"));
        assert!(mods.served("ada.clock").is_some());
    }
}
