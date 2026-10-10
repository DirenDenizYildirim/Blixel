//! The project folder the user opened. Every path the interface sends is
//! relative to it, and nothing outside it can be read or written.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

/// Files larger than this are not opened in the editor.
pub const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
/// Stop listing after this many entries so a huge folder cannot hang the app.
const MAX_ENTRIES: usize = 20_000;

/// Held while a file is read and written back, so the user's save and an
/// agent's edit never interleave.
pub static FILE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Default)]
pub struct Workspace {
    root: Mutex<Option<PathBuf>>,
}

#[derive(Serialize)]
pub struct WorkspaceInfo {
    root: String,
    name: String,
}

#[derive(Serialize)]
pub struct TreeEntry {
    path: String,
    dir: bool,
}

impl Workspace {
    fn root(&self) -> Result<PathBuf, String> {
        self.root
            .lock()
            .map_err(|_| "workspace lock poisoned".to_string())?
            .clone()
            .ok_or_else(|| "no folder is open".to_string())
    }

    /// Where a write to a relative path lands (`resolve_under`), refusing
    /// absolute paths, `..`, links as the file itself and links out.
    fn resolve(&self, rel: &str) -> Result<PathBuf, String> {
        let root = self.root()?;
        if Path::new(rel).is_absolute() {
            return Err(format!("path is outside the project: {rel}"));
        }
        resolve_under(&root, rel).map(|(full, _)| full)
    }

    /// A file to read: a link is followed as long as it stays in the project.
    fn resolve_read(&self, rel: &str) -> Result<PathBuf, String> {
        let root = self.root()?;
        if Path::new(rel).is_absolute() {
            return Err(format!("path is outside the project: {rel}"));
        }
        let full = root.join(relative(&root, rel)?);
        let real = full.canonicalize().map_err(|e| format!("cannot open {rel}: {e}"))?;
        if !real.starts_with(&root) {
            return Err(format!("path is outside the project: {rel}"));
        }
        Ok(real)
    }

    /// The open folder, for the agents' tools.
    pub fn current_root(&self) -> Option<PathBuf> {
        self.root.lock().ok()?.clone()
    }

    /// Opens a folder (canonical, checked with `project_root`) or, with None, closes it.
    pub fn set_root(&self, root: Option<PathBuf>) {
        *self.root.lock().expect("workspace lock") = root;
    }
}

/// Checks that a folder can be worked in: it exists, is a folder, and is
/// apart from the app's own data (`check_apart_from`). Returns its canonical path.
pub fn project_root(path: &Path, app_data: &Path) -> Result<PathBuf, String> {
    let root = path.canonicalize().map_err(|e| format!("cannot open {}: {e}", path.display()))?;
    if !root.is_dir() {
        return Err(format!("{} is not a folder", path.display()));
    }
    check_apart_from(&root, app_data)?;
    Ok(root)
}

/// The app's data folder holds the database, the agents' own folders and
/// the mods, which agents must never edit; so it may be neither the project
/// folder, nor inside it, nor around it. `root` must be canonical.
pub fn check_apart_from(root: &Path, app_data: &Path) -> Result<(), String> {
    let data = app_data.canonicalize().unwrap_or_else(|_| app_data.to_path_buf());
    if root.starts_with(&data) {
        return Err("That folder is inside the app's own data folder. Pick a folder elsewhere.".into());
    }
    if data.starts_with(root) {
        return Err(format!(
            "That folder holds the app's own data ({}), which agents must never edit. Pick a folder inside it instead.",
            data.display()
        ));
    }
    Ok(())
}

/// `path` (relative, or absolute inside `root`) as a path relative to
/// `root`, refusing `..` and anything else that could climb out of it.
fn relative<'a>(root: &Path, path: &'a str) -> Result<&'a Path, String> {
    let given = Path::new(path);
    let rel = if given.is_absolute() {
        given.strip_prefix(root).map_err(|_| format!("path is outside the project: {path}"))?
    } else {
        given
    };
    if rel.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
        return Err(format!("path is outside the project: {path}"));
    }
    Ok(rel)
}

/// Where a write to `path` (relative, or absolute inside `root`) would
/// really land: its full path with every link resolved, and that place
/// relative to `root`, `/`-separated. Edit areas and protected paths are
/// checked on the latter, so a link such as `docs/h -> ../.git/hooks`
/// cannot carry an edit past them.
///
/// Refused: `..`, paths outside `root`, a link as the file itself (a write
/// would follow it, even a dangling one, wherever it points), and a folder
/// link that leads out of `root` or nowhere. `root` must be canonical.
///
/// It checks the disk as it is now: a command run in between could still
/// swap a folder for a link, which only a sandbox for commands would stop.
pub fn resolve_under(root: &Path, path: &str) -> Result<(PathBuf, String), String> {
    let full = root.join(relative(root, path)?);
    if fs::symlink_metadata(&full).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(format!("{path} is a symbolic link. Blixel does not write through links; edit the file it points to."));
    }
    // The file may not exist yet: resolve its deepest existing ancestor
    // (without following a last link, so a dangling one is found here) and
    // add the rest, which does not exist and so holds no links.
    let mut existing = full.as_path();
    let mut rest = Vec::new();
    while fs::symlink_metadata(existing).is_err() {
        rest.push(existing.file_name().ok_or("path has no parent")?);
        existing = existing.parent().ok_or("path has no parent")?;
    }
    let mut real = existing.canonicalize().map_err(|_| format!("{path} goes through a link that leads nowhere."))?;
    real.extend(rest.iter().rev());
    let rel = real.strip_prefix(root).map_err(|_| format!("path is outside the project: {path}"))?;
    let rel = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
    Ok((real, rel))
}

/// The folder's own name, as the interface shows it.
pub fn folder_name(root: &Path) -> String {
    root.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.display().to_string())
}

/// Opens a folder without a project. Kept until the interface opens folders
/// as projects (`project_open`), which also loads the project's agents.
#[tauri::command]
pub fn open_workspace(
    path: String,
    app: tauri::AppHandle,
    ws: State<Workspace>,
    agents: State<crate::agents::Agents>,
) -> Result<WorkspaceInfo, String> {
    use tauri::Manager;
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let root = project_root(Path::new(&path), &data)?;
    let info = WorkspaceInfo { root: root.display().to_string(), name: folder_name(&root) };
    ws.set_root(Some(root));
    // Running agents work in the old folder; they restart here on their next message.
    agents.leave_project();
    Ok(info)
}

/// Every file and folder in the project, skipping `.git` and whatever the
/// project's ignore files exclude. Paths use `/` on every platform.
#[tauri::command]
pub fn list_tree(ws: State<Workspace>) -> Result<Vec<TreeEntry>, String> {
    let root = ws.root()?;
    let walker = ignore::WalkBuilder::new(&root)
        .hidden(false)
        .require_git(false)
        .filter_entry(|e| e.file_name() != ".git")
        .sort_by_file_name(|a, b| a.cmp(b))
        .build();
    let mut entries = Vec::new();
    for entry in walker.flatten() {
        let Ok(rel) = entry.path().strip_prefix(&root) else { continue };
        if rel.as_os_str().is_empty() {
            continue;
        }
        let path = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        let dir = entry.file_type().is_some_and(|t| t.is_dir());
        entries.push(TreeEntry { path, dir });
        if entries.len() >= MAX_ENTRIES {
            break;
        }
    }
    Ok(entries)
}

#[tauri::command]
pub fn read_file(path: String, ws: State<Workspace>) -> Result<String, String> {
    let full = ws.resolve_read(&path)?;
    let size = std::fs::metadata(&full).map_err(|e| e.to_string())?.len();
    if size > MAX_FILE_BYTES {
        return Err(format!("{path} is too large to open ({size} bytes)"));
    }
    let bytes = std::fs::read(&full).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|_| format!("{path} is not a text file"))
}

/// Saves the user's buffer. With `expected` (the disk text the buffer was
/// based on), nothing is written if the file changed on disk since, and the
/// answer is false: an agent or a command wrote it, and saving would undo that.
#[tauri::command]
pub fn write_file(path: String, content: String, expected: Option<String>, ws: State<Workspace>) -> Result<bool, String> {
    write_checked(&ws.resolve(&path)?, &content, expected.as_deref())
}

fn write_checked(full: &Path, content: &str, expected: Option<&str>) -> Result<bool, String> {
    let _held = FILE_LOCK.lock().map_err(|_| "file lock poisoned")?;
    if let Some(expected) = expected {
        let current = match std::fs::read_to_string(full) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e.to_string()),
        };
        if current != expected {
            return Ok(false);
        }
    }
    std::fs::write(full, content).map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace_in(name: &str) -> (Workspace, PathBuf) {
        let dir = std::env::temp_dir().join(format!("blixel-ws-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        let root = dir.canonicalize().unwrap();
        let ws = Workspace::default();
        *ws.root.lock().unwrap() = Some(root.clone());
        (ws, root)
    }

    #[test]
    fn paths_inside_the_project_resolve() {
        let (ws, root) = workspace_in("inside");
        assert_eq!(ws.resolve("src/new.ts").unwrap(), root.join("src/new.ts"));
        assert_eq!(ws.resolve("./README.md").unwrap(), root.join("README.md"));
    }

    #[test]
    fn paths_leaving_the_project_are_refused() {
        let (ws, root) = workspace_in("outside");
        assert!(ws.resolve("../escape.txt").is_err());
        assert!(ws.resolve("src/../../escape.txt").is_err());
        assert!(ws.resolve(root.join("src").to_str().unwrap()).is_err(), "absolute paths are refused");
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_pointing_outside_are_refused() {
        let (ws, root) = workspace_in("symlink");
        let outside = std::env::temp_dir();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        assert!(ws.resolve("link/anything.txt").is_err());
    }

    #[test]
    fn normal_paths_resolve_to_themselves() {
        let (_ws, root) = workspace_in("normal");
        std::fs::write(root.join("src/a.ts"), "a").unwrap();
        assert_eq!(resolve_under(&root, "src/a.ts").unwrap(), (root.join("src/a.ts"), "src/a.ts".to_string()));
        assert_eq!(resolve_under(&root, "./src/new/deep.ts").unwrap(), (root.join("src/new/deep.ts"), "src/new/deep.ts".to_string()));
        assert_eq!(resolve_under(&root, root.join("src/a.ts").to_str().unwrap()).unwrap().1, "src/a.ts");
        assert_eq!(resolve_under(&root, "").unwrap(), (root.clone(), String::new()));
        assert!(resolve_under(&root, "/elsewhere/a.ts").is_err());
    }

    /// A folder next to the project's, outside it.
    fn outside(root: &Path) -> PathBuf {
        let dir = root.with_file_name(format!("{}-outside", root.file_name().unwrap().to_string_lossy()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("secret.txt"), "secret").unwrap();
        dir
    }

    #[cfg(unix)]
    #[test]
    fn writes_never_go_through_links() {
        use std::os::unix::fs::symlink;
        let (ws, root) = workspace_in("links");
        let out = outside(&root);
        std::fs::write(root.join("src/a.ts"), "a").unwrap();
        symlink(out.join("secret.txt"), root.join("to-secret.txt")).unwrap();
        symlink(out.join("not-yet.txt"), root.join("dangling.txt")).unwrap();
        symlink(&out, root.join("out")).unwrap();
        symlink(root.join("gone"), root.join("src/nowhere")).unwrap();
        symlink(root.join("src/a.ts"), root.join("alias.ts")).unwrap();
        for path in [
            "to-secret.txt",     // a link to a file outside
            "dangling.txt",      // a link to nothing yet: writing would make it, outside
            "out",               // a folder link
            "out/secret.txt",    // through a folder link that leads out
            "out/new/x.txt",
            "src/nowhere",       // a folder link to nothing
            "src/nowhere/x.txt",
            "alias.ts",          // even a link that stays inside
        ] {
            assert!(resolve_under(&root, path).is_err(), "{path}");
            assert!(ws.resolve(path).is_err(), "{path}");
        }
        assert!(ws.resolve("dangling.txt").and_then(|full| write_checked(&full, "x", None)).is_err());
        assert!(!out.join("not-yet.txt").exists(), "nothing was written outside");
        assert_eq!(std::fs::read_to_string(out.join("secret.txt")).unwrap(), "secret");
        let _ = std::fs::remove_dir_all(out);
    }

    #[cfg(unix)]
    #[test]
    fn checks_see_where_a_write_really_lands() {
        use crate::agents::settings::{AgentConfig, EditCheck};
        let (_ws, root) = workspace_in("real");
        std::fs::create_dir_all(root.join(".git/hooks")).unwrap();
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::os::unix::fs::symlink("../.git/hooks", root.join("docs/h")).unwrap();

        // A new file and an existing one, through a folder link inside the project.
        let (full, rel) = resolve_under(&root, "docs/h/pre-commit").unwrap();
        assert_eq!((full, rel.as_str()), (root.join(".git/hooks/pre-commit"), ".git/hooks/pre-commit"));
        std::fs::write(root.join(".git/hooks/pre-commit"), "#!/bin/sh").unwrap();
        assert_eq!(resolve_under(&root, "docs/h/pre-commit").unwrap().1, ".git/hooks/pre-commit");

        // So a docs/** area refuses it, and without one it asks as protected.
        let agent = |area: &str| -> AgentConfig {
            serde_json::from_value(serde_json::json!({
                "id": "a", "name": "A", "instructions": "", "readNotes": false, "editPaths": area,
                "permissions": { "read": "allow", "edit": "allow", "run": "off", "commit": "off", "push": "off" },
                "model": "m", "effort": "low"
            }))
            .unwrap()
        };
        assert_eq!(agent("docs/**").edit_check(Path::new(&rel_of(&root, "docs/h/pre-commit"))), EditCheck::Outside(None));
        assert_eq!(agent("").edit_check(Path::new(&rel_of(&root, "docs/h/pre-commit"))), EditCheck::AlwaysAsk(None));
        assert_eq!(agent("docs/**").edit_check(Path::new(&rel_of(&root, "docs/a.md"))), EditCheck::Setting);
    }

    fn rel_of(root: &Path, path: &str) -> String {
        resolve_under(root, path).unwrap().1
    }

    #[cfg(unix)]
    #[test]
    fn reads_follow_links_only_inside() {
        let (ws, root) = workspace_in("reads");
        let out = outside(&root);
        std::fs::write(root.join("src/a.ts"), "a").unwrap();
        std::os::unix::fs::symlink(root.join("src/a.ts"), root.join("alias.ts")).unwrap();
        std::os::unix::fs::symlink(out.join("secret.txt"), root.join("secret.txt")).unwrap();
        assert_eq!(ws.resolve_read("alias.ts").unwrap(), root.join("src/a.ts"));
        assert!(ws.resolve_read("secret.txt").is_err());
        assert!(ws.resolve_read("../x").is_err());
        assert!(ws.resolve_read(root.join("src/a.ts").to_str().unwrap()).is_err(), "absolute paths are refused");
        let _ = std::fs::remove_dir_all(out);
    }

    #[test]
    fn a_save_never_overwrites_a_change_it_has_not_seen() {
        let (ws, root) = workspace_in("save");
        let file = ws.resolve("src/a.ts").unwrap();
        assert_eq!(write_checked(&file, "one", Some("")), Ok(true), "a new file matches empty");
        std::fs::write(root.join("src/a.ts"), "agent").unwrap();
        assert_eq!(write_checked(&file, "mine", Some("one")), Ok(false));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "agent");
        assert_eq!(write_checked(&file, "mine", Some("agent")), Ok(true));
        assert_eq!(write_checked(&file, "forced", None), Ok(true));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "forced");
    }

    #[test]
    fn nothing_resolves_before_a_folder_is_open() {
        assert!(Workspace::default().resolve("a.txt").is_err());
    }
}
