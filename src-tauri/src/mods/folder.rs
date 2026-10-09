//! A mod's folder on disk: the files it holds, within limits and without
//! links; a hash of them; a copy of them; and safe lookups of one file.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

/// A mod folder may hold at most this much.
pub const MAX_BYTES: u64 = 20 * 1024 * 1024;
pub const MAX_FILES: usize = 2000;
/// Folders count separately, so a tree of empty folders cannot grow forever.
const MAX_FOLDERS: usize = 2000;

/// Every file under `dir` as a sorted, `/`-separated relative path. Refuses
/// links anywhere (they could point outside the folder), anything that is not
/// a plain file or folder, and folders over the limits.
pub fn list(dir: &Path) -> Result<Vec<String>, String> {
    let meta = std::fs::symlink_metadata(dir).map_err(|e| format!("Cannot read its folder: {e}"))?;
    if meta.file_type().is_symlink() {
        return Err("Its folder is a link. Mods cannot contain links.".into());
    }
    if !meta.is_dir() {
        return Err("It is not a folder.".into());
    }
    let mut files = Vec::new();
    let mut folders = 0;
    let mut total = 0u64;
    let mut stack = vec![(dir.to_path_buf(), String::new())];
    while let Some((path, rel)) = stack.pop() {
        let entries = std::fs::read_dir(&path).map_err(|e| format!("Cannot read {}: {e}", shown(&rel)))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("Cannot read {}: {e}", shown(&rel)))?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                return Err(format!("{} holds a name that is not valid text.", shown(&rel)));
            };
            let child = if rel.is_empty() { name.to_string() } else { format!("{rel}/{name}") };
            // file_type() does not follow links, so a link is seen as one.
            let kind = entry.file_type().map_err(|e| format!("Cannot read {child}: {e}"))?;
            if kind.is_symlink() {
                return Err(format!("{child} is a link. Mods cannot contain links."));
            } else if kind.is_dir() {
                folders += 1;
                if folders > MAX_FOLDERS {
                    return Err(format!("It has more than {MAX_FOLDERS} folders."));
                }
                stack.push((entry.path(), child));
            } else if kind.is_file() {
                total += entry.metadata().map_err(|e| format!("Cannot read {child}: {e}"))?.len();
                files.push(child);
                if files.len() > MAX_FILES {
                    return Err(format!("It has more than {MAX_FILES} files."));
                }
                if total > MAX_BYTES {
                    return Err(format!("It is larger than {} MB.", MAX_BYTES / (1024 * 1024)));
                }
            } else {
                return Err(format!("{child} is not a plain file."));
            }
        }
    }
    files.sort();
    Ok(files)
}

fn shown(rel: &str) -> &str {
    if rel.is_empty() {
        "its folder"
    } else {
        rel
    }
}

/// One file's SHA-256.
pub type FileHash = [u8; 32];

pub fn file_hash(bytes: &[u8]) -> FileHash {
    Sha256::digest(bytes).into()
}

/// A folder's files hashed in one read: the folder's hash, which the user
/// approves, and each file's own, which the scheme checks before serving it.
pub struct Hashes {
    pub folder: String,
    pub files: HashMap<String, FileHash>,
}

/// The folder's hash is SHA-256 over the sorted relative paths and their
/// contents, each framed by its length so no two different folders can hash
/// alike by shifting bytes.
pub fn hash(dir: &Path, files: &[String]) -> Result<Hashes, String> {
    let mut hasher = Sha256::new();
    let mut each = HashMap::with_capacity(files.len());
    for rel in files {
        let bytes = std::fs::read(dir.join(rel)).map_err(|e| format!("Cannot read {rel}: {e}"))?;
        hasher.update((rel.len() as u64).to_le_bytes());
        hasher.update(rel.as_bytes());
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(&bytes);
        each.insert(rel.clone(), file_hash(&bytes));
    }
    let folder = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    Ok(Hashes { folder, files: each })
}

/// Copies the listed files from one folder into another, creating folders.
pub fn copy(from: &Path, files: &[String], to: &Path) -> Result<(), String> {
    for rel in files {
        let target = to.join(rel);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Cannot copy {rel}: {e}"))?;
        }
        std::fs::copy(from.join(rel), &target).map_err(|e| format!("Cannot copy {rel}: {e}"))?;
    }
    Ok(())
}

/// Whether `name` is one plain path part: not empty, not `.` or `..`, no
/// separators, and nothing Windows would read as a drive or stream.
pub fn is_part(name: &str) -> bool {
    !name.is_empty()
        && !name.contains(['/', '\\', ':', '\0'])
        && matches!(Path::new(name).components().next(), Some(Component::Normal(_)))
        && Path::new(name).components().count() == 1
}

/// Whether `path` is relative, `/`-separated and made only of plain parts,
/// so joined onto a folder it stays inside it.
pub fn is_inside(path: &str) -> bool {
    path.split('/').all(is_part)
}

/// The file that `parts` names inside `dir`, which must be canonical. Refuses
/// anything but plain parts, links anywhere along the way, and a result that
/// is not a file inside `dir`.
pub fn resolve(dir: &Path, parts: &[String]) -> Option<PathBuf> {
    if parts.is_empty() || !parts.iter().all(|p| is_part(p)) {
        return None;
    }
    let mut path = dir.to_path_buf();
    for part in parts {
        path.push(part);
        if std::fs::symlink_metadata(&path).ok()?.file_type().is_symlink() {
            return None;
        }
    }
    let real = path.canonicalize().ok()?;
    (real.starts_with(dir) && real.is_file()).then_some(real)
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A fresh, empty folder for one test.
    pub fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mods-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    pub fn write(dir: &Path, rel: &str, text: &str) {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn listing_is_sorted_and_relative() {
        let dir = temp_dir("list");
        write(&dir, "mod.json", "{}");
        write(&dir, "src/b.js", "b");
        write(&dir, "src/a.js", "a");
        assert_eq!(list(&dir).unwrap(), vec!["mod.json", "src/a.js", "src/b.js"]);
    }

    #[cfg(unix)]
    #[test]
    fn links_are_refused_anywhere() {
        let dir = temp_dir("links");
        write(&dir, "mod.json", "{}");
        std::fs::create_dir_all(dir.join("deep")).unwrap();
        std::os::unix::fs::symlink("/etc/hostname", dir.join("deep/host")).unwrap();
        assert!(list(&dir).unwrap_err().contains("deep/host is a link"));

        let linked = temp_dir("linked-folder");
        std::fs::remove_dir(&linked).unwrap();
        std::os::unix::fs::symlink(&dir, &linked).unwrap();
        assert!(list(&linked).unwrap_err().contains("link"));
    }

    #[test]
    fn folders_over_the_limits_are_refused() {
        let dir = temp_dir("big");
        let file = std::fs::File::create(dir.join("huge.bin")).unwrap();
        file.set_len(MAX_BYTES + 1).unwrap(); // sparse, so the test stays quick
        assert!(list(&dir).unwrap_err().contains("larger than 20 MB"));

        let dir = temp_dir("many");
        for i in 0..=MAX_FILES {
            std::fs::write(dir.join(format!("{i}.txt")), "").unwrap();
        }
        assert!(list(&dir).unwrap_err().contains("more than 2000 files"));
    }

    #[test]
    fn the_hash_follows_names_and_contents() {
        let dir = temp_dir("hash");
        write(&dir, "a.js", "one");
        let files = list(&dir).unwrap();
        let folder = |dir: &Path, files: &[String]| hash(dir, files).unwrap().folder;
        let first = folder(&dir, &files);
        assert_eq!(first.len(), 64);
        assert_eq!(folder(&dir, &files), first, "stable");
        write(&dir, "a.js", "two");
        assert_ne!(folder(&dir, &files), first, "contents count");
        write(&dir, "a.js", "one");
        std::fs::rename(dir.join("a.js"), dir.join("b.js")).unwrap();
        assert_ne!(folder(&dir, &list(&dir).unwrap()), first, "names count");
        // Moving bytes between a name and its contents changes the hash too.
        let other = temp_dir("hash-shift");
        write(&other, "a.jso", "ne");
        assert_ne!(folder(&other, &list(&other).unwrap()), first);
    }

    #[test]
    fn each_file_is_hashed_too() {
        let dir = temp_dir("hash-each");
        write(&dir, "a.js", "one");
        write(&dir, "views/b.html", "<p>");
        let hashes = hash(&dir, &list(&dir).unwrap()).unwrap();
        assert_eq!(hashes.files.len(), 2);
        assert_eq!(hashes.files["a.js"], file_hash(b"one"));
        assert_eq!(hashes.files["views/b.html"], file_hash(b"<p>"));
        assert_ne!(file_hash(b"one"), file_hash(b"two"));
    }

    #[test]
    fn manifest_paths_must_stay_inside() {
        assert!(is_inside("main.js"));
        assert!(is_inside("src/views/panel.html"));
        for bad in ["", "../main.js", "src/../../x.js", "/etc/passwd", "./main.js", "src//a.js", "src\\a.js", "C:x.js", "a/"] {
            assert!(!is_inside(bad), "{bad}");
        }
    }

    #[test]
    fn resolving_stays_inside_the_folder() {
        let dir = temp_dir("resolve");
        write(&dir, "views/panel.html", "<p>");
        let parts = |p: &str| p.split('/').map(str::to_string).collect::<Vec<_>>();
        assert_eq!(resolve(&dir, &parts("views/panel.html")), Some(dir.join("views/panel.html")));
        assert_eq!(resolve(&dir, &parts("views")), None, "folders are not served");
        assert_eq!(resolve(&dir, &parts("views/missing.html")), None);
        assert_eq!(resolve(&dir, &parts("../resolve/views/panel.html")), None);
        assert_eq!(resolve(&dir, &parts("views/../views/panel.html")), None);
        assert_eq!(resolve(&dir, &["/etc/passwd".to_string()]), None);
        assert_eq!(resolve(&dir, &[]), None);
    }

    #[cfg(unix)]
    #[test]
    fn resolving_refuses_links() {
        let dir = temp_dir("resolve-links");
        write(&dir, "real.txt", "x");
        std::os::unix::fs::symlink(dir.join("real.txt"), dir.join("inside-link.txt")).unwrap();
        std::os::unix::fs::symlink("/etc", dir.join("etc")).unwrap();
        assert_eq!(resolve(&dir, &["inside-link.txt".to_string()]), None, "even a link that stays inside");
        assert_eq!(resolve(&dir, &["etc".to_string(), "hostname".to_string()]), None);
    }
}
