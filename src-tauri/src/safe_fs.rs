//! Reading and writing files inside a project folder so that no part of the
//! path is a link and nothing outside the folder can be reached, checked as
//! each file is opened rather than before.
//!
//! A path checked earlier (`workspace::resolve_under`) can change before it
//! is used: while the user decides on an agent's edit, a command may swap a
//! folder in the project for a link to anywhere. Opening the path again
//! here refuses that link instead of following it.

use std::ffi::OsStr;
use std::fs::File;
use std::io::{self, Read, Write};
use std::path::{Component, Path};

/// The text of the file at `rel`, a path relative to `root`.
pub fn read_to_string(root: &Path, rel: &Path) -> io::Result<String> {
    let mut text = String::new();
    open(root, rel, Access::Read)?.read_to_string(&mut text)?;
    Ok(text)
}

/// Writes `content` to the file at `rel` inside `root`, creating it or
/// replacing what it held. Its folder must exist: see `create_parents`.
pub fn write(root: &Path, rel: &Path, content: &[u8]) -> io::Result<()> {
    open(root, rel, Access::Write)?.write_all(content)
}

/// Creates the folders above `rel` inside `root` that are missing, one at a
/// time, each inside the folder opened before it.
pub fn create_parents(root: &Path, rel: &Path) -> io::Result<()> {
    let names = names(rel)?;
    sys::create_dirs(root, &names[..names.len() - 1])
}

#[derive(Clone, Copy)]
enum Access {
    Read,
    /// Create or truncate.
    Write,
}

/// Opens a regular file only: a pipe put there by a command would otherwise
/// keep the caller waiting while it holds the file lock.
fn open(root: &Path, rel: &Path, access: Access) -> io::Result<File> {
    let file = sys::open(root, &names(rel)?, access)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "it is not a regular file"));
    }
    Ok(file)
}

/// The names `rel` is made of. `.` is skipped; `..`, a root or a drive
/// could climb out, so they are refused before anything is opened.
fn names(rel: &Path) -> io::Result<Vec<&OsStr>> {
    let mut names = Vec::new();
    for c in rel.components() {
        match c {
            Component::Normal(name) => names.push(name),
            Component::CurDir => {}
            _ => return Err(outside()),
        }
    }
    if names.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "the path names no file"));
    }
    Ok(names)
}

fn through_link() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "the path goes through a symbolic link, which is never followed when a file is changed",
    )
}

fn outside() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "the path leads outside the project")
}

#[cfg(target_os = "linux")]
mod sys {
    use std::ffi::{CString, OsStr};
    use std::fs::{File, OpenOptions};
    use std::io;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::OpenOptionsExt;
    use std::path::Path;

    use super::{outside, through_link, Access};

    /// No link anywhere on the path (the magic ones in /proc included), and
    /// no way above the folder it is opened from.
    const RESOLVE: u64 = libc::RESOLVE_BENEATH | libc::RESOLVE_NO_SYMLINKS | libc::RESOLVE_NO_MAGICLINKS;

    /// A folder to open and create names in, without reading it.
    const DIR: libc::c_int = libc::O_PATH | libc::O_DIRECTORY;

    pub fn open(root: &Path, names: &[&OsStr], access: Access) -> io::Result<File> {
        let flags = match access {
            Access::Read => libc::O_RDONLY,
            Access::Write => libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC,
        };
        // Not blocking, so a pipe opens at once and is then refused as no regular file.
        let fd = open_beneath(&open_root(root)?, names, flags | libc::O_NONBLOCK)?;
        Ok(File::from(fd))
    }

    pub fn create_dirs(root: &Path, names: &[&OsStr]) -> io::Result<()> {
        let mut dir = open_root(root)?;
        for &name in names {
            let opened = match open_beneath(&dir, &[name], DIR) {
                Err(e) if e.kind() == io::ErrorKind::NotFound => {
                    let c = c_string(name.as_bytes())?;
                    if unsafe { libc::mkdirat(dir.as_raw_fd(), c.as_ptr(), 0o777) } != 0 {
                        let e = io::Error::last_os_error();
                        // Made meanwhile by someone else will do, once opened as safely.
                        if e.kind() != io::ErrorKind::AlreadyExists {
                            return Err(e);
                        }
                    }
                    open_beneath(&dir, &[name], DIR)
                }
                other => other,
            };
            dir = opened?;
        }
        Ok(())
    }

    /// The project folder, as the folder every path is opened beneath. It
    /// was made canonical when the project was opened.
    fn open_root(root: &Path) -> io::Result<OwnedFd> {
        Ok(OpenOptions::new().read(true).custom_flags(DIR).open(root)?.into())
    }

    /// Opens `names` beneath `dir`, refusing a link at any step and any way out.
    fn open_beneath(dir: &OwnedFd, names: &[&OsStr], flags: libc::c_int) -> io::Result<OwnedFd> {
        let opened = match openat2(dir, names, flags) {
            Some(opened) => opened,
            None => walk(dir, names, flags),
        };
        opened.map_err(|e| match e.raw_os_error() {
            Some(libc::ELOOP) => through_link(),
            Some(libc::EXDEV) => outside(),
            _ => e,
        })
    }

    #[cfg(test)]
    thread_local! {
        /// Set by tests to take the way kernels without openat2 take.
        pub static WITHOUT_OPENAT2: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    }

    /// The whole path in one call, which the kernel resolves under `RESOLVE`;
    /// None where it has no openat2 (before Linux 5.6).
    fn openat2(dir: &OwnedFd, names: &[&OsStr], flags: libc::c_int) -> Option<io::Result<OwnedFd>> {
        #[cfg(test)]
        if WITHOUT_OPENAT2.with(std::cell::Cell::get) {
            return None;
        }
        let path = match c_string(&names.iter().map(|n| n.as_bytes()).collect::<Vec<_>>().join(&b'/')) {
            Ok(path) => path,
            Err(e) => return Some(Err(e)),
        };
        // Filled in field by field: libc marks the struct as one that may grow.
        let mut how: libc::open_how = unsafe { std::mem::zeroed() };
        how.flags = (flags | libc::O_CLOEXEC) as u64;
        how.mode = if flags & libc::O_CREAT != 0 { 0o666 } else { 0 };
        how.resolve = RESOLVE;
        let fd = unsafe {
            libc::syscall(
                libc::SYS_openat2,
                dir.as_raw_fd(),
                path.as_ptr(),
                &how as *const libc::open_how,
                std::mem::size_of::<libc::open_how>(),
            )
        };
        if fd >= 0 {
            return Some(Ok(unsafe { OwnedFd::from_raw_fd(fd as libc::c_int) }));
        }
        let e = io::Error::last_os_error();
        (e.raw_os_error() != Some(libc::ENOSYS)).then_some(Err(e))
    }

    /// Without openat2: one name at a time, each opened inside the folder
    /// opened before it, and none followed if it is a link.
    fn walk(dir: &OwnedFd, names: &[&OsStr], flags: libc::c_int) -> io::Result<OwnedFd> {
        let mut held: Option<OwnedFd> = None;
        for (i, name) in names.iter().enumerate() {
            let at = held.as_ref().unwrap_or(dir);
            if i + 1 == names.len() && flags & libc::O_PATH == 0 {
                // The file itself: a link there fails with ELOOP.
                return openat(at, name, flags | libc::O_NOFOLLOW);
            }
            held = Some(folder(at, name)?);
        }
        held.ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "the path names no file"))
    }

    /// The folder `name` inside `at`; a link or anything but a folder is refused.
    fn folder(at: &OwnedFd, name: &OsStr) -> io::Result<OwnedFd> {
        if name == ".." {
            return Err(outside());
        }
        // With O_PATH and O_NOFOLLOW a link opens as itself, so it can be told from a folder.
        let file = File::from(openat(at, name, libc::O_PATH | libc::O_NOFOLLOW)?);
        let kind = file.metadata()?.file_type();
        if kind.is_symlink() {
            return Err(io::Error::from_raw_os_error(libc::ELOOP));
        }
        if !kind.is_dir() {
            return Err(io::Error::from_raw_os_error(libc::ENOTDIR));
        }
        Ok(file.into())
    }

    fn openat(at: &OwnedFd, name: &OsStr, flags: libc::c_int) -> io::Result<OwnedFd> {
        let c = c_string(name.as_bytes())?;
        let mode: libc::c_uint = if flags & libc::O_CREAT != 0 { 0o666 } else { 0 };
        let fd = unsafe { libc::openat(at.as_raw_fd(), c.as_ptr(), flags | libc::O_CLOEXEC, mode) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }

    fn c_string(bytes: &[u8]) -> io::Result<CString> {
        CString::new(bytes).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "the path holds a NUL byte"))
    }
}

/// Elsewhere (not built for now) each name is checked just before opening,
/// which a swap in between could still get past.
#[cfg(not(target_os = "linux"))]
mod sys {
    use std::ffi::OsStr;
    use std::fs::{self, File};
    use std::io;
    use std::path::{Path, PathBuf};

    use super::{through_link, Access};

    pub fn open(root: &Path, names: &[&OsStr], access: Access) -> io::Result<File> {
        let path = checked(root, names)?;
        match access {
            Access::Read => File::open(path),
            Access::Write => File::create(path),
        }
    }

    pub fn create_dirs(root: &Path, names: &[&OsStr]) -> io::Result<()> {
        fs::create_dir_all(checked(root, names)?)
    }

    /// `names` under `root`, with no link among them as the disk is now.
    fn checked(root: &Path, names: &[&OsStr]) -> io::Result<PathBuf> {
        let mut path = root.to_path_buf();
        for name in names {
            path.push(name);
            if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
                return Err(through_link());
            }
        }
        Ok(path)
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use std::fmt::Debug;
    use std::os::unix::fs::symlink;
    use std::path::PathBuf;

    use super::*;

    /// Runs `check` once with openat2 and once the way older kernels go,
    /// each time in a fresh project folder and a folder beside it.
    fn both_ways(name: &str, check: impl Fn(&Path, &Path)) {
        for without in [false, true] {
            sys::WITHOUT_OPENAT2.with(|w| w.set(without));
            let base = std::env::temp_dir().join(format!("blixel-safe-fs-{name}-{without}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&base);
            std::fs::create_dir_all(base.join("project")).unwrap();
            std::fs::create_dir_all(base.join("outside")).unwrap();
            let base = base.canonicalize().unwrap();
            check(&base.join("project"), &base.join("outside"));
            let _ = std::fs::remove_dir_all(&base);
        }
    }

    fn p(path: &str) -> PathBuf {
        PathBuf::from(path)
    }

    fn refused_as_link<T: Debug>(result: io::Result<T>, what: &str) {
        let e = result.expect_err(what);
        assert!(e.to_string().contains("symbolic link"), "{what}: {e}");
    }

    fn is_empty(dir: &Path) -> bool {
        std::fs::read_dir(dir).unwrap().next().is_none()
    }

    #[test]
    fn nested_files_are_written_and_read() {
        both_ways("nested", |root, _| {
            create_parents(root, &p("a/b/c.txt")).unwrap();
            write(root, &p("a/b/c.txt"), b"one").unwrap();
            assert_eq!(read_to_string(root, &p("./a/b/c.txt")).unwrap(), "one");
            write(root, &p("a/b/c.txt"), b"2").unwrap();
            assert_eq!(std::fs::read_to_string(root.join("a/b/c.txt")).unwrap(), "2", "a write replaces the old content");
            create_parents(root, &p("a/b/c.txt")).unwrap();
            create_parents(root, &p("top.txt")).unwrap();
            write(root, &p("top.txt"), b"top").unwrap();
            assert_eq!(std::fs::read_to_string(root.join("top.txt")).unwrap(), "top");

            assert_eq!(read_to_string(root, &p("missing.txt")).unwrap_err().kind(), io::ErrorKind::NotFound);
            assert_eq!(read_to_string(root, &p("gone/missing.txt")).unwrap_err().kind(), io::ErrorKind::NotFound);
            assert_eq!(write(root, &p("new/x.txt"), b"x").unwrap_err().kind(), io::ErrorKind::NotFound, "only create_parents makes folders");
            assert!(read_to_string(root, &p("a")).is_err(), "a folder is no file");
            assert!(write(root, &p(""), b"x").is_err() && write(root, &p("."), b"x").is_err(), "no file named");
        });
    }

    #[test]
    fn links_are_refused_wherever_they_are() {
        both_ways("links", |root, out| {
            std::fs::write(out.join("secret.txt"), "secret").unwrap();
            std::fs::create_dir_all(root.join("docs")).unwrap();
            std::fs::write(root.join("docs/a.md"), "a").unwrap();
            symlink(out.join("secret.txt"), root.join("file-link.txt")).unwrap();
            symlink(out.join("not-yet.txt"), root.join("dangling.txt")).unwrap();
            symlink(out, root.join("folder-link")).unwrap();
            symlink("docs", root.join("inside-link")).unwrap();
            for path in [
                "file-link.txt",          // the file itself
                "dangling.txt",           // writing would create the file it points to
                "folder-link/secret.txt", // a middle folder
                "folder-link/new.txt",
                "inside-link/a.md",       // even a link that stays inside
            ] {
                refused_as_link(read_to_string(root, &p(path)), path);
                refused_as_link(write(root, &p(path), b"x"), path);
            }
            refused_as_link(create_parents(root, &p("folder-link/x.txt")), "a link as the folder");
            refused_as_link(create_parents(root, &p("folder-link/new/x.txt")), "a link above a new folder");
            refused_as_link(create_parents(root, &p("inside-link/new/x.txt")), "an inside link above a new folder");

            assert_eq!(std::fs::read_to_string(out.join("secret.txt")).unwrap(), "secret");
            assert_eq!(std::fs::read_dir(out).unwrap().count(), 1, "nothing was made outside");
            assert!(!root.join("docs/new").exists());
            assert_eq!(std::fs::read_to_string(root.join("docs/a.md")).unwrap(), "a");
        });
    }

    /// What a command can do between a check and a write: swap a folder that
    /// was written through a moment ago, or the file itself, for a link.
    #[test]
    fn a_link_swapped_in_after_a_write_is_refused() {
        both_ways("swap", |root, out| {
            create_parents(root, &p("docs/x.txt")).unwrap();
            write(root, &p("docs/x.txt"), b"first").unwrap();

            std::fs::rename(root.join("docs"), root.join("docs.real")).unwrap();
            symlink(out, root.join("docs")).unwrap();
            refused_as_link(write(root, &p("docs/x.txt"), b"second"), "the folder swapped");
            refused_as_link(read_to_string(root, &p("docs/x.txt")), "the folder swapped");
            refused_as_link(create_parents(root, &p("docs/sub/x.txt")), "the folder swapped");

            std::fs::remove_file(root.join("docs")).unwrap();
            std::fs::rename(root.join("docs.real"), root.join("docs")).unwrap();
            std::fs::rename(root.join("docs/x.txt"), root.join("docs/x.real")).unwrap();
            symlink(out.join("x.txt"), root.join("docs/x.txt")).unwrap();
            refused_as_link(write(root, &p("docs/x.txt"), b"second"), "the file swapped");

            assert!(is_empty(out), "nothing was written outside");
            assert_eq!(std::fs::read_to_string(root.join("docs/x.real")).unwrap(), "first");
        });
    }

    #[test]
    fn dot_dot_cannot_climb_out() {
        both_ways("dotdot", |root, out| {
            std::fs::create_dir_all(root.join("a")).unwrap();
            for path in ["../outside/x.txt", "a/../../outside/x.txt", "a/../x.txt", "..", "a/.."] {
                assert!(read_to_string(root, &p(path)).is_err(), "{path}");
                assert!(write(root, &p(path), b"x").is_err(), "{path}");
                assert!(create_parents(root, &p(&format!("{path}/y/z.txt"))).is_err(), "{path}");
            }
            assert!(write(root, &out.join("x.txt"), b"x").is_err(), "an absolute path is refused too");
            // The open itself refuses it as well, below the check on names.
            let climb = [OsStr::new(".."), OsStr::new("outside"), OsStr::new("x.txt")];
            assert!(sys::open(root, &climb, Access::Write).is_err());
            assert!(sys::create_dirs(root, &climb).is_err());
            assert!(is_empty(out), "nothing was written outside");
            assert!(!root.join("x.txt").exists());
        });
    }
}
