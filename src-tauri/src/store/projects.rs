//! Projects: a name and a folder on disk, with their own agents, chats and
//! tasks. Removing a project forgets what the app saved for it; its folder is
//! never touched.
//!
//! Each row has a keyed check over its name and folder (`mac`): a row
//! pointed at another folder outside the app would have its agents work
//! there. One that fails is marked and does not open until the user confirms
//! its folder (`update` with a folder, as "Locate…" does).

use std::path::{Component, Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;

use super::data::{err, now, project_scope};
use super::mac::{self, UNTRUSTED};
use crate::workspace;

const MAX_NAME_CHARS: usize = 80;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub folder: String,
    pub created: i64,
    pub last_opened: i64,
    /// Its folder is gone or moved.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub missing: bool,
    /// "ok", or "changed-outside" when its saved record failed its check:
    /// its name or folder may not be what the user chose.
    pub trust: &'static str,
}

pub const TRUSTED: &str = "ok";
pub const CHANGED: &str = "changed-outside";

const COLUMNS: &str = "id, name, folder, created, last_opened, mac";

/// A project as read, with its row's check, not yet checked.
fn from_row(r: &Row) -> rusqlite::Result<(Project, String)> {
    let folder: String = r.get(2)?;
    let project = Project {
        id: r.get(0)?,
        name: r.get(1)?,
        missing: !Path::new(&folder).is_dir(),
        folder,
        created: r.get(3)?,
        last_opened: r.get(4)?,
        trust: TRUSTED,
    };
    Ok((project, r.get(5)?))
}

fn parts<'a>(id: &'a str, name: &'a str, folder: &'a str) -> [&'a str; 4] {
    ["project", id, name, folder]
}

/// Checks a project's row. One that fails is marked untrusted, so it stays
/// so even if changed back; without the key it is untrusted, not marked.
fn checked(conn: &Connection, (mut project, mac): (Project, String)) -> Result<Project, String> {
    let passes = match mac::check(&parts(&project.id, &project.name, &project.folder), &mac) {
        Ok(passes) => passes,
        Err(e) => {
            eprintln!("could not check project {}: {e}", project.id);
            return Ok(Project { trust: CHANGED, ..project });
        }
    };
    if !passes {
        project.trust = CHANGED;
        if mac != UNTRUSTED {
            conn.execute("UPDATE projects SET mac = ?2 WHERE id = ?1", (&project.id, UNTRUSTED)).map_err(err)?;
        }
    }
    Ok(project)
}

/// Signs a project's row as it is now, once the user chose or confirmed it.
fn sign(conn: &Connection, id: &str) -> Result<(), String> {
    let (name, folder): (String, String) = conn
        .query_row("SELECT name, folder FROM projects WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(err)?;
    let mac = mac::sign(&parts(id, &name, &folder)).map_err(|e| format!("Cannot save this project: {e}"))?;
    conn.execute("UPDATE projects SET mac = ?2 WHERE id = ?1", (id, mac)).map_err(err)?;
    Ok(())
}

/// A project's name as the user typed it, trimmed, on one line.
pub fn clean_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Give the project a name.".into());
    }
    if name.chars().any(char::is_control) {
        return Err("A project's name fits on one line.".into());
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(format!("A project's name is at most {MAX_NAME_CHARS} characters."));
    }
    Ok(name.to_string())
}

/// Most recently opened first.
pub fn list(conn: &Connection) -> Result<Vec<Project>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {COLUMNS} FROM projects ORDER BY last_opened DESC, created DESC"))
        .map_err(err)?;
    let rows = stmt.query_map([], from_row).map_err(err)?.collect::<Result<Vec<_>, _>>().map_err(err)?;
    rows.into_iter().map(|row| checked(conn, row)).collect()
}

pub fn get(conn: &Connection, id: &str) -> Result<Project, String> {
    if id == "demo" {
        return Err("The demo project is not saved.".into());
    }
    let row = conn
        .query_row(&format!("SELECT {COLUMNS} FROM projects WHERE id = ?1"), [id], from_row)
        .optional()
        .map_err(err)?
        .ok_or_else(|| format!("No saved project has the id “{id}”."))?;
    checked(conn, row)
}

pub fn by_folder(conn: &Connection, folder: &Path) -> Result<Option<Project>, String> {
    conn.query_row(&format!("SELECT {COLUMNS} FROM projects WHERE folder = ?1"), [folder.to_string_lossy()], from_row)
        .optional()
        .map_err(err)?
        .map(|row| checked(conn, row))
        .transpose()
}

fn folder_free(conn: &Connection, folder: &Path, except: Option<&str>) -> Result<(), String> {
    match by_folder(conn, folder)? {
        Some(other) if Some(other.id.as_str()) != except => {
            Err(format!("That folder is already the project “{}”.", other.name))
        }
        _ => Ok(()),
    }
}

/// Saves a new project for a folder that is already checked (`workspace::project_root`).
pub fn insert(conn: &Connection, name: &str, folder: &Path) -> Result<Project, String> {
    let name = clean_name(name)?;
    folder_free(conn, folder, None)?;
    let id = crate::events::new_id("p");
    let folder = folder.to_string_lossy();
    let mac = mac::sign(&parts(&id, &name, &folder)).map_err(|e| format!("Cannot save this project: {e}"))?;
    conn.execute(
        "INSERT INTO projects (id, name, folder, created, last_opened, mac) VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
        params![id, name, folder, now(), mac],
    )
    .map_err(err)?;
    get(conn, &id)
}

/// The project for a folder, saved on the spot (named after the folder) if
/// the folder is not one yet.
pub fn for_folder(conn: &Connection, folder: &Path) -> Result<Project, String> {
    if let Some(project) = by_folder(conn, folder)? {
        return Ok(project);
    }
    let name = folder
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| folder.display().to_string());
    // A folder's name can be longer than a project's may be.
    let name: String = name.chars().filter(|c| !c.is_control()).take(MAX_NAME_CHARS).collect();
    insert(conn, if name.trim().is_empty() { "Project" } else { &name }, folder)
}

/// Notes that the project was opened now.
pub fn opened(conn: &Connection, id: &str) -> Result<Project, String> {
    conn.execute("UPDATE projects SET last_opened = ?2 WHERE id = ?1", params![id, now()]).map_err(err)?;
    get(conn, id)
}

/// Renames a project or points it at another folder (checked already). A
/// folder, even the one it has, is the user confirming it, so the row is
/// trusted again; a rename alone keeps a changed row untrusted.
pub fn update(conn: &mut Connection, id: &str, name: Option<&str>, folder: Option<&Path>) -> Result<Project, String> {
    let trusted = get(conn, id)?.trust == TRUSTED;
    let tx = conn.transaction().map_err(err)?;
    if let Some(name) = name {
        let name = clean_name(name)?;
        tx.execute("UPDATE projects SET name = ?2 WHERE id = ?1", params![id, name]).map_err(err)?;
    }
    if let Some(folder) = folder {
        folder_free(&tx, folder, Some(id))?;
        tx.execute("UPDATE projects SET folder = ?2 WHERE id = ?1", params![id, folder.to_string_lossy()]).map_err(err)?;
    }
    if trusted || folder.is_some() {
        sign(&tx, id)?;
    }
    tx.commit().map_err(err)?;
    get(conn, id)
}

/// Forgets a project: its row, its agents, and every document and item in its scope.
pub fn remove(conn: &mut Connection, id: &str) -> Result<(), String> {
    get(conn, id)?;
    let scope = project_scope(id);
    let tx = conn.transaction().map_err(err)?;
    tx.execute("DELETE FROM docs WHERE scope = ?1", [&scope]).map_err(err)?;
    tx.execute("DELETE FROM items WHERE scope = ?1", [&scope]).map_err(err)?;
    tx.execute("DELETE FROM agents WHERE project_id = ?1", [id]).map_err(err)?;
    tx.execute("DELETE FROM projects WHERE id = ?1", [id]).map_err(err)?;
    tx.commit().map_err(err)
}

/// The folder for a new project. With `make`, it is created first, and must
/// not exist yet or be empty. Either way it must be a folder the app allows
/// as a project (`workspace::project_root`); the answer is its canonical path.
pub fn prepare_folder(folder: &str, make: bool, app_data: &Path) -> Result<PathBuf, String> {
    let path = PathBuf::from(folder);
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) {
        return Err(format!("“{folder}” is not a full path to a folder."));
    }
    if make {
        // Refused before anything is made, so no folder appears where it may not be.
        workspace::check_apart_from(&planned(&path)?, app_data)?;
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_dir() => {
                let mut entries = std::fs::read_dir(&path).map_err(|e| format!("Cannot read {folder}: {e}"))?;
                if entries.next().is_some() {
                    return Err(format!("“{folder}” already exists and has files in it. Choose another name, or use that folder as it is."));
                }
            }
            Ok(_) => return Err(format!("“{folder}” already exists and is not a folder.")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir_all(&path).map_err(|e| format!("Cannot make {folder}: {e}"))?;
            }
            Err(e) => return Err(format!("Cannot read {folder}: {e}")),
        }
    }
    workspace::project_root(&path, app_data)
}

/// Where a path that may not exist yet would be: its deepest existing
/// ancestor, with links resolved, and the rest of it.
fn planned(path: &Path) -> Result<PathBuf, String> {
    let mut existing = path;
    let mut rest = Vec::new();
    while !existing.exists() {
        rest.push(existing.file_name().ok_or("path has no parent")?);
        existing = existing.parent().ok_or("path has no parent")?;
    }
    let mut full = existing.canonicalize().map_err(|e| e.to_string())?;
    full.extend(rest.iter().rev());
    Ok(full)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Db;

    /// A fresh folder under the system's temp folder, and a stand-in for the app's data folder.
    pub fn temp(name: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("blixel-store-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("app-data")).unwrap();
        let dir = dir.canonicalize().unwrap();
        (dir.clone(), dir.join("app-data"))
    }

    #[test]
    fn a_project_is_made_found_and_forgotten() {
        let (dir, data) = temp("projects");
        let db = Db::memory();
        let mut conn = db.conn.lock().unwrap();

        // A new folder is made; one that has files is refused.
        let folder = dir.join("site");
        let root = prepare_folder(folder.to_str().unwrap(), true, &data).unwrap();
        assert!(root.is_dir());
        let project = insert(&conn, "  Site  ", &root).unwrap();
        assert_eq!(project.name, "Site");
        assert_eq!(project.folder, root.to_string_lossy());
        assert!(!project.missing);
        assert_eq!(get(&conn, &project.id).unwrap(), project);
        std::fs::write(root.join("index.html"), "<p>").unwrap();
        assert!(prepare_folder(folder.to_str().unwrap(), true, &data).unwrap_err().contains("has files"));
        // Using an existing folder needs no new one, and an empty one may be "made".
        assert_eq!(prepare_folder(folder.to_str().unwrap(), false, &data).unwrap(), root);
        std::fs::create_dir(dir.join("empty")).unwrap();
        prepare_folder(dir.join("empty").to_str().unwrap(), true, &data).unwrap();
        assert!(prepare_folder(dir.join("nope").to_str().unwrap(), false, &data).is_err(), "a missing folder is refused");
        assert!(prepare_folder("relative/path", true, &data).is_err());
        assert!(prepare_folder(dir.join("a/../b").to_str().unwrap(), true, &data).is_err());

        // One project per folder: the same folder finds the same project.
        assert!(insert(&conn, "Again", &root).unwrap_err().contains("already the project “Site”"));
        assert_eq!(for_folder(&conn, &root).unwrap().id, project.id);
        let other_root = dir.join("empty").canonicalize().unwrap();
        let other = for_folder(&conn, &other_root).unwrap();
        assert_eq!(other.name, "empty", "named after its folder");
        assert_ne!(other.id, project.id);

        // Most recently opened first.
        std::thread::sleep(std::time::Duration::from_millis(5));
        opened(&conn, &project.id).unwrap();
        assert_eq!(list(&conn).unwrap().iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), [&project.id, &other.id]);

        // Renaming, and pointing at another folder that is not a project yet.
        assert!(update(&mut conn, &project.id, Some(" "), None).is_err());
        assert!(update(&mut conn, &project.id, None, Some(&other_root)).unwrap_err().contains("already the project"));
        let moved = dir.join("moved");
        std::fs::rename(&root, &moved).unwrap();
        assert!(get(&conn, &project.id).unwrap().missing, "its folder is gone");
        let moved = moved.canonicalize().unwrap();
        let updated = update(&mut conn, &project.id, Some("Site, moved"), Some(&moved)).unwrap();
        assert_eq!((updated.name.as_str(), updated.folder.as_str(), updated.missing), ("Site, moved", &*moved.to_string_lossy(), false));

        // Forgetting a project removes its rows and data, never its folder.
        let scope = project_scope(&project.id);
        super::super::data::doc_set(&conn, &scope, "ui", Some(&serde_json::json!(1))).unwrap();
        super::super::data::items_put(&mut conn, &scope, "tasks", &[("t".into(), serde_json::json!(1))], 10).unwrap();
        super::super::data::doc_set(&conn, &project_scope(&other.id), "ui", Some(&serde_json::json!(2))).unwrap();
        remove(&mut conn, &project.id).unwrap();
        assert!(get(&conn, &project.id).is_err());
        assert!(super::super::data::doc_get(&conn, &scope, "ui").is_err(), "its scope is gone");
        let left: i64 = conn.query_row("SELECT COUNT(*) FROM docs", [], |r| r.get(0)).unwrap();
        let items: i64 = conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
        assert_eq!((left, items), (1, 0), "only the other project's data stays");
        assert!(moved.join("index.html").exists(), "the folder is untouched");
        assert!(remove(&mut conn, &project.id).is_err(), "it is gone");
        assert!(get(&conn, "demo").unwrap_err().contains("demo"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_project_changed_outside_the_app_waits_for_its_folder_to_be_confirmed() {
        let (dir, data) = temp("trust");
        let db = Db::memory();
        let mut conn = db.conn.lock().unwrap();
        let site = prepare_folder(dir.join("site").to_str().unwrap(), true, &data).unwrap();
        let elsewhere = prepare_folder(dir.join("elsewhere").to_str().unwrap(), true, &data).unwrap();
        let project = insert(&conn, "Site", &site).unwrap();
        assert_eq!(project.trust, TRUSTED);
        assert_eq!(serde_json::to_value(&project).unwrap()["trust"], "ok");
        let id = project.id.as_str();

        // Something outside the app points it at another folder.
        conn.execute("UPDATE projects SET folder = ?2 WHERE id = ?1", (id, elsewhere.to_string_lossy())).unwrap();
        assert_eq!(get(&conn, id).unwrap().trust, CHANGED);
        assert_eq!(serde_json::to_value(get(&conn, id).unwrap()).unwrap()["trust"], "changed-outside");
        assert_eq!(list(&conn).unwrap()[0].trust, CHANGED);
        assert_eq!(by_folder(&conn, &elsewhere).unwrap().unwrap().trust, CHANGED);

        // Marked: putting it back, or renaming it, does not trust it again.
        conn.execute("UPDATE projects SET folder = ?2 WHERE id = ?1", (id, site.to_string_lossy())).unwrap();
        assert_eq!(get(&conn, id).unwrap().trust, CHANGED);
        let renamed = update(&mut conn, id, Some("Renamed"), None).unwrap();
        assert_eq!((renamed.name.as_str(), renamed.trust), ("Renamed", CHANGED));

        // The user confirming its folder (Locate…, even the same one) does.
        assert_eq!(update(&mut conn, id, None, Some(&site)).unwrap().trust, TRUSTED);
        assert_eq!(get(&conn, id).unwrap().trust, TRUSTED);
        assert_eq!(update(&mut conn, id, Some("Site again"), None).unwrap().trust, TRUSTED, "a trusted rename stays trusted");
        assert_eq!(update(&mut conn, id, None, Some(&elsewhere)).unwrap().trust, TRUSTED);

        // A name changed outside, a check without the key, and a row from
        // before checks (none) all fail.
        conn.execute("UPDATE projects SET name = 'Evil' WHERE id = ?1", [id]).unwrap();
        assert_eq!(get(&conn, id).unwrap().trust, CHANGED);
        update(&mut conn, id, None, Some(&elsewhere)).unwrap();
        conn.execute("UPDATE projects SET mac = 'ab' WHERE id = ?1", [id]).unwrap();
        assert_eq!(get(&conn, id).unwrap().trust, CHANGED);
        conn.execute("INSERT INTO projects (id, name, folder, created, last_opened) VALUES ('old', 'Old', '/old', 1, 1)", []).unwrap();
        assert_eq!(get(&conn, "old").unwrap().trust, CHANGED);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_apps_own_data_is_never_a_project() {
        let (dir, data) = temp("app-data");
        assert!(prepare_folder(data.join("mine").to_str().unwrap(), true, &data).is_err());
        assert!(!data.join("mine").exists(), "nothing was made there");
        assert!(prepare_folder(data.to_str().unwrap(), false, &data).is_err());
        assert!(prepare_folder(dir.to_str().unwrap(), false, &data).unwrap_err().contains("holds the app's own data"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn names_are_one_short_line() {
        assert_eq!(clean_name(" A name ").unwrap(), "A name");
        assert!(clean_name("").is_err());
        assert!(clean_name("two\nlines").is_err());
        assert!(clean_name(&"x".repeat(81)).is_err());
        assert!(clean_name(&"x".repeat(80)).is_ok());
    }
}
