//! The project folder the user opened. Every path the interface sends is
//! relative to it, and nothing outside it can be read or written.

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

    /// Joins a relative path onto the root, refusing anything that could
    /// leave it: absolute paths, `..`, or a symlink pointing outside.
    fn resolve(&self, rel: &str) -> Result<PathBuf, String> {
        let root = self.root()?;
        if Path::new(rel).is_absolute() {
            return Err(format!("path is outside the project: {rel}"));
        }
        resolve_under(&root, rel).map(|(full, _)| full)
    }

    /// The open folder, for the agents' tools.
    pub fn current_root(&self) -> Option<PathBuf> {
        self.root.lock().ok()?.clone()
    }
}

/// Resolves `path` (relative, or absolute inside `root`) to a full path and a
/// `/`-separated path relative to `root`. Refuses `..`, paths outside `root`
/// and symlinks that lead out of it. `root` must already be canonical.
pub fn resolve_under(root: &Path, path: &str) -> Result<(PathBuf, String), String> {
    let given = Path::new(path);
    let rel = if given.is_absolute() {
        given.strip_prefix(root).map_err(|_| format!("path is outside the project: {path}"))?
    } else {
        given
    };
    if rel.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
        return Err(format!("path is outside the project: {path}"));
    }
    let full = root.join(rel);
    // The file may not exist yet, so check the deepest existing ancestor.
    let mut existing = full.as_path();
    while !existing.exists() {
        existing = existing.parent().ok_or("path has no parent")?;
    }
    let real = existing.canonicalize().map_err(|e| e.to_string())?;
    if !real.starts_with(root) {
        return Err(format!("path is outside the project: {path}"));
    }
    let rel = rel
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/");
    Ok((full, rel))
}

#[tauri::command]
pub fn open_workspace(path: String, ws: State<Workspace>, agents: State<crate::agents::Agents>) -> Result<WorkspaceInfo, String> {
    let root = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| format!("cannot open {path}: {e}"))?;
    if !root.is_dir() {
        return Err(format!("{path} is not a folder"));
    }
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.display().to_string());
    let info = WorkspaceInfo { root: root.display().to_string(), name };
    *ws.root.lock().map_err(|_| "workspace lock poisoned")? = Some(root);
    // Running agents work in the old folder; they restart here on their next message.
    agents.stop_all();
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
    let full = ws.resolve(&path)?;
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
