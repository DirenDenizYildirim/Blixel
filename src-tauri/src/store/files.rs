//! Bringing files into a project: copies of files and folders the user
//! picked, placed in the project's folder. Nothing there is ever
//! overwritten (a taken name gets " (2)" and so on), and links and special
//! files are skipped, so a copy can never reach outside what was picked.
//! The app's own data folder (the database, agents' sessions) is never
//! copied: agents read a project freely.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::workspace;

/// Most files and folders together, and bytes, one copy may bring in.
pub const MAX_ENTRIES: u64 = 50_000;
pub const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Serialize, Default, Debug, PartialEq)]
pub struct Measured {
    pub files: u64,
    /// Folders a copy would make, the picked ones included.
    pub folders: u64,
    pub bytes: u64,
    /// Links, special files and entries that could not be read.
    pub skipped: u64,
}

#[derive(Serialize, Default, Debug, PartialEq)]
pub struct Copied {
    pub copied: u64,
    /// Placed under a new name because the name was taken.
    pub renamed: u64,
    pub skipped: u64,
}

fn absolute(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(format!("“{}” is not a full path.", path.display()));
    }
    Ok(path)
}

/// Refuses a picked path that is the app's data folder, inside it, or holds
/// it. Checked on the real path, so a link to it is caught too.
fn check_not_app_data(path: &Path, app_data: &Path) -> Result<(), String> {
    let Ok(real) = path.canonicalize() else { return Ok(()) }; // missing: skipped later
    let data = app_data.canonicalize().unwrap_or_else(|_| app_data.to_path_buf());
    if real.starts_with(&data) || data.starts_with(&real) {
        return Err(format!(
            "{} holds the app's own data, which is never copied into a project, where agents could read it. Pick files elsewhere.",
            path.display()
        ));
    }
    Ok(())
}

/// Counts the files, folders and bytes under the given paths, without
/// following links. Counting stops once past the limits, since such a copy
/// is refused. A path that is or holds the app's data folder is refused.
pub fn measure(paths: &[String], app_data: &Path) -> Result<Measured, String> {
    let mut total = Measured::default();
    for path in paths {
        let path = absolute(path)?;
        check_not_app_data(&path, app_data)?;
        let mut stack = vec![path];
        while let Some(path) = stack.pop() {
            if too_much(&total).is_some() {
                return Ok(total);
            }
            let Ok(meta) = fs::symlink_metadata(&path) else {
                total.skipped += 1;
                continue;
            };
            if meta.is_file() {
                total.files += 1;
                total.bytes += meta.len();
            } else if meta.is_dir() {
                total.folders += 1;
                match fs::read_dir(&path) {
                    Ok(entries) => stack.extend(entries.flatten().map(|e| e.path())),
                    Err(_) => total.skipped += 1,
                }
            } else {
                total.skipped += 1; // links, sockets, devices
            }
        }
    }
    Ok(total)
}

fn too_much(m: &Measured) -> Option<String> {
    (m.files + m.folders > MAX_ENTRIES || m.bytes > MAX_BYTES).then(|| {
        format!(
            "That is more than one copy can bring in: at most {MAX_ENTRIES} files and folders, and {} GB, at a time.",
            MAX_BYTES / (1024 * 1024 * 1024)
        )
    })
}

/// "name (2).ext" for files, "name (2)" for folders and names without an extension.
fn numbered(name: &str, n: u32, dir: bool) -> String {
    if n == 1 {
        return name.to_string();
    }
    match name.rfind('.') {
        Some(dot) if !dir && dot > 0 => format!("{} ({n}){}", &name[..dot], &name[dot..]),
        _ => format!("{name} ({n})"),
    }
}

/// Makes a new file or folder in `dir` under the first free name. Creating
/// with "must not exist" is what checks the name, so nothing that appears
/// meanwhile is overwritten, and a link planted there is never followed.
fn create_unique(dir: &Path, name: &str, is_dir: bool) -> Result<(PathBuf, Option<File>, bool), String> {
    for n in 1..10_000 {
        let path = dir.join(numbered(name, n, is_dir));
        let made = if is_dir {
            fs::create_dir(&path).map(|()| None)
        } else {
            OpenOptions::new().write(true).create_new(true).open(&path).map(Some)
        };
        match made {
            Ok(file) => return Ok((path, file, n > 1)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Cannot make {}: {e}", path.display())),
        }
    }
    Err(format!("No free name for {name} in {}.", dir.display()))
}

/// Copies one file's content into a file just made for it.
fn copy_file(from: &Path, to_path: &Path, mut to: File, total: &mut Copied) -> Result<(), String> {
    let mut source = match File::open(from) {
        Ok(f) => f,
        Err(_) => {
            // Unreadable: skipped, and the empty file made for it removed.
            drop(to);
            let _ = fs::remove_file(to_path);
            total.skipped += 1;
            return Ok(());
        }
    };
    if let Err(e) = io::copy(&mut source, &mut to) {
        drop(to);
        let _ = fs::remove_file(to_path);
        return Err(format!("Copying {} stopped: {e}", from.display()));
    }
    if let Ok(meta) = source.metadata() {
        let _ = fs::set_permissions(to_path, meta.permissions());
    }
    total.copied += 1;
    Ok(())
}

/// Copies the picked files and folders into `into` (relative to `root`,
/// "" for its top). `root` must be canonical.
pub fn copy_in(root: &Path, paths: &[String], into: &str, app_data: &Path) -> Result<Copied, String> {
    if Path::new(into).is_absolute() {
        return Err(format!("“{into}” is not a path inside the project."));
    }
    let (target, _) = workspace::resolve_under(root, into)?;
    match fs::symlink_metadata(&target) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => return Err(format!("“{into}” is not a folder.")),
        Err(_) => fs::create_dir_all(&target).map_err(|e| format!("Cannot make {into}: {e}"))?,
    }
    let target = target.canonicalize().map_err(|e| e.to_string())?;
    if !target.starts_with(root) {
        return Err(format!("path is outside the project: {into}"));
    }

    let sources = paths.iter().map(|p| absolute(p)).collect::<Result<Vec<_>, _>>()?;
    for source in &sources {
        check_not_app_data(source, app_data)?;
    }
    // A folder copied into itself would never end.
    for source in &sources {
        if let Ok(real) = source.canonicalize() {
            if fs::symlink_metadata(source).is_ok_and(|m| m.is_dir()) && target.starts_with(&real) {
                return Err(format!("{} cannot be copied into itself.", source.display()));
            }
        }
    }
    if let Some(reason) = too_much(&measure(paths, app_data)?) {
        return Err(reason);
    }

    let mut total = Copied::default();
    for source in &sources {
        let meta = match fs::symlink_metadata(source) {
            Ok(meta) if meta.is_file() || meta.is_dir() => meta,
            _ => {
                total.skipped += 1;
                continue;
            }
        };
        let Some(name) = source.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            total.skipped += 1;
            continue;
        };
        let (dest, file, renamed) = create_unique(&target, &name, meta.is_dir())?;
        total.renamed += u64::from(renamed);
        match file {
            Some(file) => copy_file(source, &dest, file, &mut total)?,
            None => copy_tree(source, &dest, &mut total)?,
        }
    }
    Ok(total)
}

/// Copies a folder's content into a folder just made for it, so nothing there clashes.
fn copy_tree(from: &Path, to: &Path, total: &mut Copied) -> Result<(), String> {
    let mut stack = vec![(from.to_path_buf(), to.to_path_buf())];
    while let Some((from, to)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&from) else {
            total.skipped += 1;
            continue;
        };
        for entry in entries {
            let Ok(entry) = entry else {
                total.skipped += 1;
                continue;
            };
            // The entry's own type: a link is a link, never what it points to.
            let Ok(kind) = entry.file_type() else {
                total.skipped += 1;
                continue;
            };
            let dest = to.join(entry.file_name());
            if kind.is_dir() {
                fs::create_dir(&dest).map_err(|e| format!("Cannot make {}: {e}", dest.display()))?;
                stack.push((entry.path(), dest));
            } else if kind.is_file() {
                let file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&dest)
                    .map_err(|e| format!("Cannot make {}: {e}", dest.display()))?;
                copy_file(&entry.path(), &dest, file, total)?;
            } else {
                total.skipped += 1;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("blixel-files-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("project")).unwrap();
        fs::create_dir_all(dir.join("picked")).unwrap();
        fs::create_dir_all(dir.join("app-data")).unwrap();
        dir.canonicalize().unwrap()
    }

    /// The stand-in for the app's data folder in `temp`.
    fn data(dir: &Path) -> PathBuf {
        dir.join("app-data")
    }

    fn s(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn names_are_numbered_before_the_extension() {
        assert_eq!(numbered("notes.md", 1, false), "notes.md");
        assert_eq!(numbered("notes.md", 2, false), "notes (2).md");
        assert_eq!(numbered("archive.tar.gz", 3, false), "archive.tar (3).gz");
        assert_eq!(numbered(".env", 2, false), ".env (2)");
        assert_eq!(numbered("Makefile", 2, false), "Makefile (2)");
        assert_eq!(numbered("site.v2", 2, true), "site.v2 (2)", "folders keep their whole name");
    }

    #[test]
    fn files_and_folders_are_copied_without_overwriting() {
        let dir = temp("copy");
        let (root, picked) = (dir.join("project"), dir.join("picked"));
        fs::write(picked.join("notes.md"), "mine").unwrap();
        fs::create_dir_all(picked.join("assets/icons")).unwrap();
        fs::write(picked.join("assets/logo.svg"), "<svg/>").unwrap();
        fs::write(picked.join("assets/icons/a.png"), [1, 2, 3]).unwrap();
        fs::write(root.join("notes.md"), "theirs").unwrap();

        let paths = [s(&picked.join("notes.md")), s(&picked.join("assets"))];
        assert_eq!(measure(&paths, &data(&dir)).unwrap(), Measured { files: 3, folders: 2, bytes: 4 + 6 + 3, skipped: 0 });

        let copied = copy_in(&root, &paths, "", &data(&dir)).unwrap();
        assert_eq!(copied, Copied { copied: 3, renamed: 1, skipped: 0 });
        assert_eq!(fs::read_to_string(root.join("notes.md")).unwrap(), "theirs", "never overwritten");
        assert_eq!(fs::read_to_string(root.join("notes (2).md")).unwrap(), "mine");
        assert_eq!(fs::read(root.join("assets/icons/a.png")).unwrap(), [1, 2, 3]);

        // Again: every name is taken now.
        let copied = copy_in(&root, &paths, "", &data(&dir)).unwrap();
        assert_eq!(copied, Copied { copied: 3, renamed: 2, skipped: 0 });
        assert!(root.join("notes (3).md").exists());
        assert!(root.join("assets (2)/logo.svg").exists());

        // Into a folder inside, made if missing.
        copy_in(&root, &[s(&picked.join("notes.md"))], "docs/imported", &data(&dir)).unwrap();
        assert_eq!(fs::read_to_string(root.join("docs/imported/notes.md")).unwrap(), "mine");
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn links_are_skipped_and_never_followed() {
        let dir = temp("links");
        let (root, picked) = (dir.join("project"), dir.join("picked"));
        let secret = dir.join("secret.txt");
        fs::write(&secret, "secret").unwrap();
        fs::create_dir_all(picked.join("folder")).unwrap();
        fs::write(picked.join("folder/plain.txt"), "plain").unwrap();
        std::os::unix::fs::symlink(&secret, picked.join("folder/link.txt")).unwrap();
        std::os::unix::fs::symlink(&dir, picked.join("folder/loop")).unwrap();
        std::os::unix::fs::symlink(&secret, picked.join("top-link.txt")).unwrap();

        let paths = [s(&picked.join("folder")), s(&picked.join("top-link.txt"))];
        assert_eq!(measure(&paths, &data(&dir)).unwrap(), Measured { files: 1, folders: 1, bytes: 5, skipped: 3 });
        let copied = copy_in(&root, &paths, "", &data(&dir)).unwrap();
        assert_eq!(copied, Copied { copied: 1, renamed: 0, skipped: 3 });
        assert!(root.join("folder/plain.txt").exists());
        assert!(fs::symlink_metadata(root.join("folder/link.txt")).is_err());
        assert!(fs::symlink_metadata(root.join("folder/loop")).is_err());
        assert!(fs::symlink_metadata(root.join("top-link.txt")).is_err());

        // A link in the project where a copy would go is never written through.
        std::os::unix::fs::symlink(&secret, root.join("notes.txt")).unwrap();
        fs::write(picked.join("notes.txt"), "new").unwrap();
        copy_in(&root, &[s(&picked.join("notes.txt"))], "", &data(&dir)).unwrap();
        assert_eq!(fs::read_to_string(&secret).unwrap(), "secret");
        assert_eq!(fs::read_to_string(root.join("notes (2).txt")).unwrap(), "new");

        // Nor is a link that leads out of the project, as the place to copy into.
        std::os::unix::fs::symlink(&dir, root.join("out")).unwrap();
        assert!(copy_in(&root, &[s(&picked.join("notes.txt"))], "out", &data(&dir)).is_err());
        assert!(copy_in(&root, &[s(&picked.join("notes.txt"))], "out/new", &data(&dir)).is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn copies_stay_inside_the_project() {
        let dir = temp("escape");
        let (root, picked) = (dir.join("project"), dir.join("picked"));
        fs::write(picked.join("a.txt"), "a").unwrap();
        let a = [s(&picked.join("a.txt"))];
        let data = data(&dir);
        for into in ["..", "../picked", "docs/../../x", "/tmp", &s(&root)] {
            assert!(copy_in(&root, &a, into, &data).is_err(), "{into:?}");
        }
        assert!(!dir.join("x").exists());
        assert!(copy_in(&root, &["relative/a.txt".into()], "", &data).is_err(), "sources are full paths");

        // A folder cannot be copied into itself.
        fs::create_dir_all(root.join("sub")).unwrap();
        assert!(copy_in(&root, &[s(&root)], "sub", &data).unwrap_err().contains("into itself"));
        // A missing source is skipped, not an error.
        let copied = copy_in(&root, &[s(&picked.join("gone.txt")), a[0].clone()], "", &data).unwrap();
        assert_eq!(copied, Copied { copied: 1, renamed: 0, skipped: 1 });
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn too_much_is_refused_before_anything_is_copied() {
        let m = |files, folders, bytes| Measured { files, folders, bytes, skipped: 0 };
        assert!(too_much(&m(MAX_ENTRIES + 1, 0, 0)).is_some());
        assert!(too_much(&m(1, 0, MAX_BYTES + 1)).is_some());
        assert!(too_much(&m(MAX_ENTRIES, 0, MAX_BYTES)).is_none());
        // Folders count too: an empty tree of many folders is still a large copy.
        assert!(too_much(&m(0, MAX_ENTRIES + 1, 0)).is_some());
        assert!(too_much(&m(MAX_ENTRIES / 2, MAX_ENTRIES / 2 + 1, 0)).is_some());
        assert!(too_much(&m(MAX_ENTRIES / 2, MAX_ENTRIES / 2, 0)).is_none());
    }

    #[test]
    fn folders_are_counted() {
        let dir = temp("folders");
        let picked = dir.join("picked");
        for i in 0..5 {
            fs::create_dir_all(picked.join(format!("tree/{i}/deeper"))).unwrap();
        }
        let measured = measure(&[s(&picked.join("tree"))], &data(&dir)).unwrap();
        assert_eq!(measured, Measured { files: 0, folders: 11, bytes: 0, skipped: 0 });
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_apps_own_data_is_never_copied() {
        let dir = temp("app-data");
        let (root, data) = (dir.join("project"), data(&dir));
        fs::write(data.join("workspace.db"), "saved").unwrap();
        fs::create_dir_all(data.join("projects/p1")).unwrap();
        fs::write(dir.join("picked/fine.txt"), "fine").unwrap();
        let refused = [
            s(&data),                         // the folder itself
            s(&data.join("workspace.db")),    // a file in it
            s(&data.join("projects")),        // a folder in it
            s(&dir),                          // a folder that holds it
            s(&data.join("projects/../workspace.db")),
        ];
        for path in &refused {
            assert!(measure(std::slice::from_ref(path), &data).unwrap_err().contains("app's own data"), "{path}");
            let both = [s(&dir.join("picked/fine.txt")), path.clone()];
            assert!(copy_in(&root, &both, "", &data).unwrap_err().contains("app's own data"), "{path}");
        }
        assert!(!root.join("fine.txt").exists(), "nothing is copied when one path is refused");
        assert!(fs::read_dir(&root).unwrap().next().is_none());
        // A link to it is caught by its real path.
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&data, dir.join("picked/data-link")).unwrap();
            assert!(measure(&[s(&dir.join("picked/data-link"))], &data).is_err());
        }
        assert_eq!(copy_in(&root, &[s(&dir.join("picked/fine.txt"))], "", &data).unwrap().copied, 1);
        let _ = fs::remove_dir_all(dir);
    }
}
