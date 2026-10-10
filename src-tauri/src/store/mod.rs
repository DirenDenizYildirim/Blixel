//! What the app keeps between runs, in one SQLite database in the app data
//! folder (never in a project, where an agent could edit it): projects, each
//! project's agents, chats and tasks, the app's settings, and connectors.
//! Only the app's own page can reach these commands.

pub mod agents;
pub mod data;
pub mod files;
pub mod mac;
pub mod projects;
pub mod usage;

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::{Connection, ErrorCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use crate::workspace::{self, Workspace};
use projects::Project;

/// The database file's name, without the product's name in it.
pub const FILE: &str = "workspace.db";

/// How long a call waits for another connection's write before giving up.
const BUSY: Duration = if cfg!(test) { Duration::from_millis(200) } else { Duration::from_secs(3) };

/// The open database. One connection, held behind a lock; calls are short.
pub struct Db {
    pub conn: Mutex<Connection>,
    #[allow(dead_code, reason = "where the data is, for messages and backups")]
    pub path: PathBuf,
}

/// How opening the database went, for the interface (`store_status`).
#[derive(Serialize, Clone, Default, Debug, PartialEq)]
pub struct Status {
    /// Where a database that could not be opened was moved, before the app
    /// started with a new one.
    pub recovered: Option<String>,
    /// Why this run keeps its data in memory only, so nothing is saved:
    /// another program (most likely another copy of the app) holds the
    /// database, or no database could be made. A sentence for the user.
    pub unsaved: Option<String>,
}

/// Why the database did not open.
#[derive(Debug)]
struct Failure {
    /// Busy or locked by another connection: the file itself is fine.
    locked: bool,
    text: String,
}

impl From<rusqlite::Error> for Failure {
    fn from(e: rusqlite::Error) -> Self {
        let locked = matches!(e.sqlite_error_code(), Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked));
        Self { locked, text: e.to_string() }
    }
}

/// Runs a module's schema steps that have not run yet, in order.
fn run_steps(conn: &mut Connection, module: &str, steps: &[&str]) -> Result<(), Failure> {
    let tx = conn.transaction()?;
    for (i, sql) in steps.iter().enumerate() {
        let done: bool = tx
            .query_row("SELECT 1 FROM migrations WHERE module = ?1 AND step = ?2", (module, i as i64), |_| Ok(true))
            .unwrap_or(false);
        if !done {
            tx.execute_batch(sql).map_err(|e| {
                let failure = Failure::from(e);
                Failure { text: format!("{module} step {i}: {}", failure.text), ..failure }
            })?;
            tx.execute("INSERT INTO migrations (module, step) VALUES (?1, ?2)", (module, i as i64))?;
        }
    }
    Ok(tx.commit()?)
}

/// Settings every connection gets, then the store's own schema.
fn prepare(conn: &mut Connection, wal: bool) -> Result<(), Failure> {
    conn.busy_timeout(BUSY)?;
    if wal {
        conn.execute_batch("PRAGMA journal_mode = WAL;")?;
    }
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         CREATE TABLE IF NOT EXISTS migrations (module TEXT NOT NULL, step INTEGER NOT NULL, PRIMARY KEY (module, step));",
    )?;
    run_steps(conn, "store", data::SCHEMA)
}

impl Db {
    /// A database on disk, without recovery: for tests.
    #[cfg(test)]
    pub fn open(dir: &Path) -> Result<Self, String> {
        Self::try_open(dir).map_err(|f| f.text)
    }

    fn try_open(dir: &Path) -> Result<Self, Failure> {
        let locked = false;
        std::fs::create_dir_all(dir).map_err(|e| Failure { locked, text: format!("Cannot create {}: {e}", dir.display()) })?;
        let path = dir.join(FILE);
        let mut conn = Connection::open(&path)?;
        prepare(&mut conn, true)?;
        Ok(Self { conn: Mutex::new(conn), path })
    }

    /// Opens the database in `dir`, so that the app always starts. One that
    /// cannot be opened or brought up to date is moved aside, with its
    /// journal files, as `workspace.db.broken-<time>`, and a new one made.
    /// One that another program holds is left alone: this run then keeps
    /// its data in memory. Either way `Status` says what happened.
    pub fn open_or_recover(dir: &Path) -> (Self, Status) {
        let failure = match Self::try_open(dir) {
            Ok(db) => return (db, Status::default()),
            Err(failure) => failure,
        };
        let path = dir.join(FILE);
        eprintln!("could not open {}: {}", path.display(), failure.text);
        if failure.locked {
            let unsaved = format!(
                "The app's saved data ({}) is in use by another program, most likely another copy of the app. \
                 This window starts empty and keeps nothing: close the other copy and start the app again.",
                path.display()
            );
            return (Self::memory(), Status { recovered: None, unsaved: Some(unsaved) });
        }
        let fresh = move_aside(&path).and_then(|aside| match Self::try_open(dir) {
            Ok(db) => Ok((db, aside)),
            Err(f) => Err(f.text),
        });
        match fresh {
            Ok((db, aside)) => {
                eprintln!("moved the database aside to {}", aside.display());
                (db, Status { recovered: Some(aside.display().to_string()), unsaved: None })
            }
            Err(e) => {
                eprintln!("could not start a new database: {e}");
                let unsaved = format!(
                    "The app's saved data ({}) could not be opened ({}), nor a new one made ({e}). This window keeps nothing.",
                    path.display(),
                    failure.text
                );
                (Self::memory(), Status { recovered: None, unsaved: Some(unsaved) })
            }
        }
    }

    /// A database in memory with the store's schema: for tests, and for a
    /// run whose database cannot be used.
    pub fn memory() -> Self {
        let mut conn = Connection::open_in_memory().expect("a database in memory opens");
        prepare(&mut conn, false).expect("the store's schema applies to an empty database");
        Self { conn: Mutex::new(conn), path: PathBuf::new() }
    }

    pub fn lock(&self) -> Result<MutexGuard<'_, Connection>, String> {
        self.conn.lock().map_err(|_| "database lock poisoned".to_string())
    }

    /// Runs a module's schema steps that have not run yet, in order. Steps are
    /// only ever added at the end, never changed.
    pub fn migrate(&self, module: &str, steps: &[&str]) -> Result<(), String> {
        let mut conn = self.conn.lock().map_err(|_| "database lock poisoned")?;
        run_steps(&mut conn, module, steps).map_err(|f| f.text)
    }
}

/// The database for code that runs outside a command: the app's own, reached
/// through the app, or (in tests) one of their own.
#[derive(Clone)]
pub enum DbRef {
    App(AppHandle),
    #[cfg(test)]
    Own(std::sync::Arc<Db>),
}

impl DbRef {
    pub fn with<R>(&self, work: impl FnOnce(&Db) -> Result<R, String>) -> Result<R, String> {
        match self {
            DbRef::App(app) => work(app.try_state::<Db>().ok_or("The database is not open.")?.inner()),
            #[cfg(test)]
            DbRef::Own(db) => work(db),
        }
    }
}

/// Moves a database that cannot be opened, and its journal files, out of
/// the way under one new name. The journals go too: SQLite would apply a
/// leftover one to the new database.
fn move_aside(path: &Path) -> Result<PathBuf, String> {
    let aside = PathBuf::from(format!("{}.broken-{}", path.display(), data::now()));
    std::fs::rename(path, &aside).map_err(|e| format!("cannot move {}: {e}", path.display()))?;
    for suffix in ["-wal", "-shm", "-journal"] {
        let side = PathBuf::from(format!("{}{suffix}", path.display()));
        if std::fs::symlink_metadata(&side).is_ok() {
            let to = PathBuf::from(format!("{}{suffix}", aside.display()));
            std::fs::rename(&side, &to).map_err(|e| format!("cannot move {}: {e}", side.display()))?;
        }
    }
    Ok(aside)
}

/// How opening the database went this run: `recovered` (where a broken
/// database was moved) and `unsaved` (why nothing is saved this run).
#[tauri::command]
pub fn store_status(status: State<Status>) -> Status {
    status.inner().clone()
}

/// Runs database work off the main thread (sync commands run on it).
pub async fn blocking<T: Send + 'static>(
    app: &AppHandle,
    work: impl FnOnce(&Db) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || work(&app.state::<Db>()))
        .await
        .map_err(|e| e.to_string())?
}

pub fn app_data(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

// ---- Documents and item lists (the interface's own data) ----

#[tauri::command]
pub async fn store_get(scope: String, key: String, app: AppHandle) -> Result<Option<Value>, String> {
    blocking(&app, move |db| data::doc_get(&*db.lock()?, &scope, &key)).await
}

/// Stores a value; null removes it.
#[tauri::command]
pub async fn store_set(scope: String, key: String, value: Option<Value>, app: AppHandle) -> Result<(), String> {
    blocking(&app, move |db| data::doc_set(&*db.lock()?, &scope, &key, value.as_ref())).await
}

#[derive(Deserialize)]
pub struct ItemIn {
    pub id: String,
    pub value: Value,
}

/// The newest `limit` items, oldest first.
#[tauri::command]
pub async fn items_load(scope: String, list: String, limit: u32, app: AppHandle) -> Result<Vec<Value>, String> {
    blocking(&app, move |db| data::items_load(&*db.lock()?, &scope, &list, limit)).await
}

#[derive(Serialize)]
pub struct Put {
    /// Items left out (too large, or a bad id); the rest were stored.
    refused: Vec<String>,
}

#[tauri::command]
pub async fn items_put(scope: String, list: String, items: Vec<ItemIn>, keep: u32, app: AppHandle) -> Result<Put, String> {
    let items: Vec<(String, Value)> = items.into_iter().map(|i| (i.id, i.value)).collect();
    let refused = blocking(&app, move |db| data::items_put(&mut *db.lock()?, &scope, &list, &items, keep)).await?;
    Ok(Put { refused })
}

#[tauri::command]
pub async fn items_delete(scope: String, list: String, ids: Option<Vec<String>>, app: AppHandle) -> Result<(), String> {
    blocking(&app, move |db| data::items_delete(&mut *db.lock()?, &scope, &list, ids.as_deref())).await
}

// ---- Projects ----

#[tauri::command]
pub async fn projects_list(app: AppHandle) -> Result<Vec<Project>, String> {
    blocking(&app, |db| projects::list(&*db.lock()?)).await
}

/// Makes a project of `folder` (a full path), creating the folder first when `make_folder`.
#[tauri::command]
pub async fn project_create(name: String, folder: String, make_folder: bool, app: AppHandle) -> Result<Project, String> {
    let data = app_data(&app)?;
    blocking(&app, move |db| {
        let name = projects::clean_name(&name)?;
        let root = projects::prepare_folder(&folder, make_folder, &data)?;
        projects::insert(&*db.lock()?, &name, &root)
    })
    .await
}

/// The project for a folder, made on the spot if the folder is not one yet.
#[tauri::command]
pub async fn project_for_folder(path: String, app: AppHandle) -> Result<Project, String> {
    let data = app_data(&app)?;
    blocking(&app, move |db| {
        let root = workspace::project_root(Path::new(&path), &data)?;
        projects::for_folder(&*db.lock()?, &root)
    })
    .await
}

#[derive(Serialize)]
pub struct Opened {
    project: Project,
    /// The folder's own name.
    name: String,
}

/// Opens a project: its folder becomes the workspace, every running agent
/// stops, and the core takes this project's agents (checked, see
/// `agents::load`) as the ones it runs and enforces. A project whose record
/// was changed outside the app does not open until the user confirms its
/// folder (`project_update` with `folder`).
#[tauri::command]
pub async fn project_open(id: String, app: AppHandle) -> Result<Opened, String> {
    let data = app_data(&app)?;
    let (project, root, saved) = blocking(&app, move |db| {
        let conn = db.lock()?;
        let project = projects::get(&conn, &id)?;
        openable(&project)?;
        let root = workspace::project_root(Path::new(&project.folder), &data)?;
        let saved = agents::load(&conn, &id)?;
        Ok((projects::opened(&conn, &id)?, root, saved))
    })
    .await?;
    let name = workspace::folder_name(&root);
    app.state::<Workspace>().set_root(Some(root));
    let configs = saved.iter().filter_map(|s| Some((s.config()?, s.trusted))).collect();
    app.state::<crate::agents::Agents>().open_project(Some(project.id.clone()), configs);
    Ok(Opened { project, name })
}

/// A project opens once its folder is there and its record trusted: a record
/// pointed at another folder outside the app would have its agents work there.
fn openable(project: &Project) -> Result<(), String> {
    if project.trust != projects::TRUSTED {
        return Err(format!(
            "The saved record of “{}” was changed outside the app. Check that {} is its folder, then confirm it with Locate….",
            project.name, project.folder
        ));
    }
    if project.missing {
        return Err(format!(
            "The folder of “{}” is missing ({}). Use Locate… to point the project at it again.",
            project.name, project.folder
        ));
    }
    Ok(())
}

/// Closes the open project (the demo calls this): no folder is open, every
/// agent stops and the core holds no agents.
#[tauri::command]
pub async fn project_close(app: AppHandle) -> Result<(), String> {
    close(&app);
    Ok(())
}

fn close(app: &AppHandle) {
    app.state::<Workspace>().set_root(None);
    app.state::<crate::agents::Agents>().open_project(None, Vec::new());
}

#[derive(Deserialize)]
pub struct ProjectPatch {
    name: Option<String>,
    /// A full path: "Locate…" for a project whose folder moved. The user
    /// choosing it, even the folder it has, also trusts a project whose
    /// record was changed outside the app again.
    folder: Option<String>,
}

#[tauri::command]
pub async fn project_update(id: String, patch: ProjectPatch, app: AppHandle) -> Result<Project, String> {
    let data = app_data(&app)?;
    let project = blocking(&app, move |db| {
        let root = match &patch.folder {
            Some(folder) => Some(workspace::project_root(Path::new(folder), &data)?),
            None => None,
        };
        projects::update(&mut *db.lock()?, &id, patch.name.as_deref(), root.as_deref())
    })
    .await?;
    // The open project moved: its agents carry on in the new place on their next message.
    let agents = app.state::<crate::agents::Agents>();
    if agents.project().as_deref() == Some(project.id.as_str()) {
        let root = Path::new(&project.folder).to_path_buf();
        if app.state::<Workspace>().current_root().as_ref() != Some(&root) {
            app.state::<Workspace>().set_root(Some(root));
            agents.stop_all();
        }
    }
    Ok(project)
}

/// Forgets a project and everything saved for it, including its agents'
/// own folders in the app's data. Its folder is never touched.
#[tauri::command]
pub async fn project_remove(id: String, app: AppHandle) -> Result<(), String> {
    let dir = agents::project_dir(&app_data(&app)?, &id)?;
    if app.state::<crate::agents::Agents>().project().as_deref() == Some(id.as_str()) {
        close(&app);
    }
    blocking(&app, move |db| projects::remove(&mut *db.lock()?, &id)).await?;
    if let Err(e) = std::fs::remove_dir_all(&dir) {
        if e.kind() != std::io::ErrorKind::NotFound {
            eprintln!("could not remove {}: {e}", dir.display());
        }
    }
    Ok(())
}

// ---- Bringing files into a project ----

#[tauri::command]
pub async fn files_measure(paths: Vec<String>, app: AppHandle) -> Result<files::Measured, String> {
    let data = app_data(&app)?;
    tauri::async_runtime::spawn_blocking(move || files::measure(&paths, &data))
        .await
        .map_err(|e| e.to_string())?
}

/// Copies files and folders into the project's folder, at `into` (relative; "" is its top).
#[tauri::command]
pub async fn files_copy_in(project_id: String, paths: Vec<String>, into: String, app: AppHandle) -> Result<files::Copied, String> {
    let data = app_data(&app)?;
    blocking(&app, move |db| {
        let project = projects::get(&*db.lock()?, &project_id)?;
        // The lock is not held while copying.
        let root = workspace::project_root(Path::new(&project.folder), &data)?;
        files::copy_in(&root, &paths, &into, &data)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("blixel-db-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn names_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    #[test]
    fn a_broken_database_is_moved_aside_and_the_app_starts_afresh() {
        let dir = temp("broken");
        let garbage = b"not a database at all. ".repeat(100);
        std::fs::write(dir.join(FILE), &garbage).unwrap();
        std::fs::write(dir.join(format!("{FILE}-wal")), "stale journal").unwrap();

        let (db, status) = Db::open_or_recover(&dir);
        assert_eq!(status.unsaved, None);
        let aside = PathBuf::from(status.recovered.expect("moved aside"));
        assert!(aside.file_name().unwrap().to_string_lossy().starts_with("workspace.db.broken-"), "{}", aside.display());
        assert_eq!(aside.parent(), Some(dir.as_path()));
        assert_eq!(std::fs::read(&aside).unwrap(), garbage, "kept as it was");
        // SQLite may have dropped the journal itself; it never stays beside the new database.
        let wal = std::fs::read_to_string(dir.join(format!("{FILE}-wal"))).unwrap_or_default();
        assert!(!wal.contains("stale journal"));

        // The new one is on disk and keeps what is saved.
        data::doc_set(&db.lock().unwrap(), "app", "k", Some(&json!(1))).unwrap();
        drop(db);
        let (db, status) = Db::open_or_recover(&dir);
        assert_eq!(status, Status::default());
        assert_eq!(data::doc_get(&db.lock().unwrap(), "app", "k").unwrap(), Some(json!(1)));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn journals_move_aside_with_their_database() {
        let dir = temp("aside");
        for (suffix, text) in [("", "db"), ("-wal", "wal"), ("-shm", "shm"), ("-journal", "journal")] {
            std::fs::write(dir.join(format!("{FILE}{suffix}")), text).unwrap();
        }
        let aside = move_aside(&dir.join(FILE)).unwrap();
        let name = aside.file_name().unwrap().to_string_lossy().into_owned();
        let mut expected = vec![name.clone(), format!("{name}-journal"), format!("{name}-shm"), format!("{name}-wal")];
        expected.sort();
        assert_eq!(names_in(&dir), expected);
        assert_eq!(std::fs::read_to_string(format!("{}-wal", aside.display())).unwrap(), "wal");
        assert!(move_aside(&dir.join(FILE)).is_err(), "nothing left to move");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_database_in_use_is_left_alone() {
        let dir = temp("in-use");
        let (db, _) = Db::open_or_recover(&dir);
        data::doc_set(&db.lock().unwrap(), "app", "k", Some(&json!(1))).unwrap();
        drop(db);

        // Another program holds it, and keeps holding it.
        let holder = Connection::open(dir.join(FILE)).unwrap();
        holder
            .execute_batch("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; UPDATE docs SET value = '2' WHERE key = 'k';")
            .unwrap();
        let before = names_in(&dir);
        let (db, status) = Db::open_or_recover(&dir);
        assert_eq!(status.recovered, None);
        assert!(status.unsaved.as_deref().is_some_and(|s| s.contains("in use by another program")), "{status:?}");
        assert_eq!(names_in(&dir), before, "nothing was moved");
        // This run works, in memory.
        data::doc_set(&db.lock().unwrap(), "app", "x", Some(&json!(2))).unwrap();
        drop(db);

        drop(holder); // its change is rolled back
        let (db, status) = Db::open_or_recover(&dir);
        assert_eq!(status, Status::default());
        let conn = db.lock().unwrap();
        assert_eq!(data::doc_get(&conn, "app", "k").unwrap(), Some(json!(1)));
        assert_eq!(data::doc_get(&conn, "app", "x").unwrap(), None, "what the run in memory saved is gone");
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn only_a_trusted_project_with_its_folder_opens() {
        let project = |trust, missing| Project {
            id: "p1".into(),
            name: "Site".into(),
            folder: "/site".into(),
            created: 1,
            last_opened: 1,
            missing,
            trust,
        };
        assert!(openable(&project(projects::TRUSTED, false)).is_ok());
        let changed = openable(&project(projects::CHANGED, false)).unwrap_err();
        assert!(changed.contains("changed outside the app") && changed.contains("/site") && changed.contains("Locate"), "{changed}");
        assert!(openable(&project(projects::TRUSTED, true)).unwrap_err().contains("missing"));
    }
}
