//! The sandbox every agent command runs in: bubblewrap, on Linux. A command
//! may change the project folder and nothing else that lasts. It sees the
//! system's folders read-only, and of the home folder only the folders tools
//! live in; what it adds to tool caches goes to a layer of this agent's own,
//! so the real caches other projects use never change. It cannot see other
//! processes (whose environment can hold keys), the keychain, the kernel's
//! keyrings or Blixel's own data. In the project, git's folders and the
//! files that instruct agents are read-only; where they are missing, a
//! command cannot make a repository (a read-only placeholder `.git` stands
//! there while commands run), and the other names it creates are moved
//! aside afterwards. Network access is the agent's own setting.
//!
//! Two rules keep a command from reaching outside through Blixel itself:
//! nothing a command can change is ever handed to bubblewrap as a path (a
//! link there would be followed outside; protected entries are opened by
//! Blixel without following links and bound by handle), and bubblewrap is a
//! root-owned system program started from `/` with an empty environment (so
//! no program or library a command wrote can stand in for it).
//!
//! Where bubblewrap is missing or does not work, agents run no commands at all.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs::File;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, OnceLock};

use tokio::sync::{Mutex, MutexGuard};

/// The bubblewrap program's name; it is looked up once, among root-owned programs.
pub const BWRAP: &str = "bwrap";

/// Folders under the home folder that commands may read: where tools are
/// installed. Missing ones are skipped. Folders on the PATH under home are
/// added too. Not git's own settings: they can hold credentials, and commands
/// do not commit (git's folder is read-only to them).
const TOOLS: &[&str] = &[
    ".rustup",
    ".local/bin",
    ".local/lib",
    ".nvm",
    ".volta",
    ".deno",
    ".pyenv",
    ".rbenv",
    ".asdf",
    ".sdkman",
    ".local/share/mise",
    ".local/share/fnm",
];

/// Tool folders that builds also write to (downloads and caches). Commands
/// see them, and what they add goes to this agent's own layer over them.
const CACHES: &[&str] = &[
    ".cargo",
    ".npm",
    ".bun",
    ".yarn",
    "go",
    ".m2",
    ".gradle",
    ".local/share/pnpm",
    ".cache/pip",
    ".cache/uv",
    ".cache/pypoetry",
    ".cache/go-build",
    ".cache/yarn",
    ".cache/pnpm",
    ".cache/deno",
    ".cache/node-gyp",
    ".cache/ms-playwright",
];

/// Files inside those folders that hold credentials: commands see them empty.
const MASKED: &[&str] = &[
    ".cargo/credentials.toml",
    ".cargo/credentials",
    ".m2/settings.xml",
    ".m2/settings-security.xml",
    ".gradle/gradle.properties",
];

/// Where keys, tokens, agents' logins and browser data usually are: never
/// shown, even when a folder on the PATH lies inside one.
const SECRETS: &[&str] = &[
    ".ssh",
    ".gnupg",
    ".local/share",
    ".local/state",
    ".password-store",
    ".aws",
    ".kube",
    ".docker",
    ".config",
    ".claude",
    ".claude.json",
    ".codex",
    ".gemini",
    ".mozilla",
    ".netrc",
    ".git-credentials",
    ".npmrc",
    ".pypirc",
];

/// Folders of the system that hold sockets, other disks or other programs'
/// temporary files: each command gets them empty instead.
const EMPTIED: &[&str] = &["/tmp", "/var/tmp", "/run", "/mnt", "/media"];

/// Variables commands get from Blixel's environment: what tools need to be
/// found and to behave, never what looks like a secret (`secret_name`).
const KEPT_VARS: &[&str] = &[
    "PATH", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TZ", "TERM", "COLORTERM", "EDITOR", "VISUAL", "PAGER",
    "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "CC", "CXX", "CFLAGS", "CXXFLAGS",
    "CPPFLAGS", "LDFLAGS", "PKG_CONFIG_PATH", "LD_LIBRARY_PATH", "VIRTUAL_ENV", "PNPM_HOME", "BUNDLE_PATH",
    "BUNDLE_GEMFILE", "BUNDLE_BIN", "BUNDLE_WITH", "BUNDLE_WITHOUT", "BUNDLE_JOBS", "BUNDLE_APP_CONFIG",
    "BUNDLE_DEPLOYMENT", "BUNDLE_FROZEN",
];
/// Prefixes of tools' own variables. Not Bundler's (BUNDLE_<HOST> holds
/// credentials), and none ending in _OPTS or _ARGS (Java and Maven flags can
/// carry passwords).
const KEPT_PREFIXES: &[&str] = &[
    "LC_", "CARGO_", "RUSTUP_", "RUST", "NVM_", "NODE_", "GO", "JAVA_", "GRADLE_", "MAVEN_", "PYENV_", "PYTHON",
    "CONDA_", "GEM_", "DENO_", "BUN_", "VOLTA_", "ASDF_", "MISE_",
];

/// Whether a variable's name says it holds a secret, or may.
fn secret_name(name: &str) -> bool {
    let name = name.to_ascii_uppercase();
    let words = ["TOKEN", "SECRET", "PASSW", "CREDENTIAL", "AUTH", "KEY", "COOKIE", "SESSION"];
    words.iter().any(|word| name.contains(word)) || ["_OPTS", "_OPTIONS", "_ARGS"].iter().any(|end| name.ends_with(end))
}

/// A value with the user and password taken out of every address in it:
/// "https://user:pass@host" becomes "https://host", and "user:pass@proxy:3128"
/// (a proxy written without a scheme) becomes "proxy:3128".
fn without_credentials(value: &str) -> String {
    let parts: Vec<String> = value
        .split(',')
        .map(|part| {
            let mut out = String::with_capacity(part.len());
            let mut rest = part;
            if !rest.contains("://") {
                // No scheme: only "user:pass@" counts, so an e-mail address stays.
                let start = rest.len() - rest.trim_start().len();
                out.push_str(&rest[..start]);
                rest = without_userinfo(&rest[start..], true);
            }
            while let Some(i) = rest.find("://") {
                out.push_str(&rest[..i + 3]);
                rest = without_userinfo(&rest[i + 3..], false);
            }
            out.push_str(rest);
            out
        })
        .collect();
    parts.join(",")
}

/// `text` without a leading "user@" or "user:pass@" (with `password`, only
/// the latter), looked for up to where the address ends.
fn without_userinfo(text: &str, password: bool) -> &str {
    let end = text.find(|c: char| c == '/' || c == ';' || c == '"' || c == '\'' || c.is_whitespace()).unwrap_or(text.len());
    match text[..end].rfind('@') {
        Some(at) if !password || text[..at].contains(':') => &text[at + 1..],
        _ => text,
    }
}

pub struct Sandbox {
    /// A bubblewrap of the caller's choice (tests); None: the system's.
    program: Option<PathBuf>,
    /// The home folder as its real path, for what the sandbox shows...
    home: PathBuf,
    /// ...and as the environment names it, for the commands.
    home_var: PathBuf,
    /// Blixel's own data folder (its real path).
    app_data: Option<PathBuf>,
    /// Where this agent's layers over the cache folders are kept. Without
    /// one, or where layers do not work, the cache folders are read-only.
    layers: Option<PathBuf>,
    /// Once the sandbox worked: whether cache layers work too. A failed
    /// check is made again next time, so installing bubblewrap is enough.
    ready: Mutex<Option<bool>>,
    /// bubblewrap and bash, as found when the sandbox was checked.
    programs: OnceLock<(PathBuf, PathBuf)>,
    /// One command at a time: a layer cannot be used by two at once.
    turn: Mutex<()>,
    /// Whether the user was told that commands cannot run.
    told: AtomicBool,
}

/// A command ready to start, with what must stay open until it has. Pass it
/// to `Sandbox::after` once the command has ended (dropping it does the same,
/// without the list of what was moved).
pub struct Prepared {
    pub command: tokio::process::Command,
    /// Handles bound by bubblewrap (the protected entries, the filter).
    _held: Vec<File>,
    root: PathBuf,
    /// This command among the project's running ones.
    id: u64,
    /// Protected names (relative paths) that were missing, or made by another
    /// running command, when this one started: moved aside if there after.
    absent: Vec<String>,
    /// Links the user made at protected names, as (name, device and inode):
    /// moved aside if a command put something else there.
    links: Vec<(String, (u64, u64))>,
    /// Where bubblewrap reports the sandbox's first process (`--json-status-fd`),
    /// to wait for the sandbox to be empty before anything is moved.
    status: Option<File>,
    /// The sandbox's first process, once read from `status`.
    pid: Option<i32>,
    ended: AtomicBool,
}

impl Prepared {
    /// The host's id of the sandbox's first process, if bubblewrap reported it.
    fn sandbox_pid(&mut self) -> Option<i32> {
        if self.pid.is_none() {
            self.pid = self.status.as_mut().and_then(child_pid);
        }
        self.pid
    }
}

impl Drop for Prepared {
    fn drop(&mut self) {
        if self.ended.swap(true, Ordering::SeqCst) {
            return;
        }
        // Dropped without `after` (a call given up midway): the same, once the
        // sandbox is empty, without holding up the caller.
        let pid = self.sandbox_pid();
        let (root, id, absent, links) = (self.root.clone(), self.id, std::mem::take(&mut self.absent), std::mem::take(&mut self.links));
        std::thread::spawn(move || {
            if let Some(pid) = pid {
                let started = std::time::Instant::now();
                while sandbox_alive(pid) && started.elapsed() < EMPTY_WAIT {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            }
            for (name, aside) in end(&root, id, &absent, &links) {
                eprintln!("blixel: {name} made by a command: {aside}");
            }
        });
    }
}

/// How long to wait for a stopped sandbox's processes to be gone.
const EMPTY_WAIT: std::time::Duration = std::time::Duration::from_secs(3);

/// The host's id of the sandbox's first process, from what bubblewrap wrote
/// to its status pipe (read without waiting: it is written at the start).
fn child_pid(status: &mut File) -> Option<i32> {
    use std::io::Read;
    let mut text = Vec::new();
    let mut buf = [0u8; 4096];
    while let Ok(n) = status.read(&mut buf) {
        if n == 0 {
            break;
        }
        text.extend_from_slice(&buf[..n]);
    }
    let text = String::from_utf8_lossy(&text);
    let at = text.find("\"child-pid\"")?;
    let rest = text[at + 11..].trim_start_matches(|c: char| c == ':' || c.is_whitespace());
    rest.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()
}

/// Whether the sandbox's first process still runs. It ends only once every
/// process in its namespace has (the kernel kills and waits for them), so
/// after that nothing in the sandbox can touch the project. A process of
/// another name under that id is not ours (the id was given again).
fn sandbox_alive(pid: i32) -> bool {
    let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else { return false };
    let named = stat.split_once('(').and_then(|(_, r)| r.rsplit_once(')'));
    matches!(named, Some((name, rest)) if name == "bwrap" && !rest.trim_start().starts_with('Z'))
}

/// A pipe for bubblewrap's status: (read end, never blocking; write end).
fn status_pipe() -> Option<(File, File)> {
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::FromRawFd;
        let mut fds = [0i32; 2];
        // SAFETY: two ints for the pipe's ends, each then owned by a File.
        if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
            return None;
        }
        let (read, write) = unsafe { (File::from_raw_fd(fds[0]), File::from_raw_fd(fds[1])) };
        // SAFETY: an open fd of ours.
        unsafe { libc::fcntl(fds[0], libc::F_SETFL, libc::O_NONBLOCK) };
        Some((read, write))
    }
    #[cfg(not(target_os = "linux"))]
    None
}

impl Sandbox {
    /// The sandbox for one agent: `home` is the user's home folder,
    /// `app_data` Blixel's data folder, `layers` where the agent's cache
    /// layers go.
    pub fn new(home: PathBuf, app_data: Option<PathBuf>, layers: Option<PathBuf>) -> Self {
        Self::with_program(PathBuf::from(BWRAP), home, app_data, layers)
    }

    /// The same with another bubblewrap (tests); `BWRAP` means the system's.
    pub fn with_program(program: PathBuf, home: PathBuf, app_data: Option<PathBuf>, layers: Option<PathBuf>) -> Self {
        // Real paths, so a link in the way (/home to /var/home, say) changes no comparison.
        let real = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        Self {
            program: (program != Path::new(BWRAP)).then_some(program),
            home: real(&home),
            home_var: home,
            app_data: app_data.as_deref().map(real),
            layers,
            ready: Mutex::new(None),
            programs: OnceLock::new(),
            turn: Mutex::new(()),
            told: AtomicBool::new(false),
        }
    }

    /// The user's home folder, from the environment.
    pub fn home() -> PathBuf {
        std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
    }

    /// Whether commands can run in `root`: Ok with whether cache layers
    /// work, or why not, written to be read after "Commands cannot run: ".
    pub async fn ready(&self, root: &Path) -> Result<bool, String> {
        let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        let holds = |inner: &Path| inner.starts_with(&root);
        if holds(&self.home) || self.app_data.as_deref().is_some_and(holds) {
            return Err("Blixel runs them only in a sandbox, and no sandbox can keep your files from a command when \
                        the project folder holds your home folder or Blixel's data. Open a folder inside it instead."
                .into());
        }
        let mut ready = self.ready.lock().await;
        if let Some(layers) = *ready {
            return Ok(layers);
        }
        let layers = self.check().await.map_err(|reason| {
            format!(
                "Blixel runs them only in a sandbox, and {reason}. Install bubblewrap (the package is usually \
                 called bubblewrap), then send your message again."
            )
        })?;
        *ready = Some(layers);
        Ok(layers)
    }

    /// True the first time it is asked: the user is told once that commands cannot run.
    pub fn first_refusal(&self) -> bool {
        !self.told.swap(true, Ordering::SeqCst)
    }

    /// Waits until no other command of this agent runs.
    pub async fn turn(&self) -> MutexGuard<'_, ()> {
        self.turn.lock().await
    }

    async fn check(&self) -> Result<bool, String> {
        if !cfg!(target_os = "linux") {
            return Err("the sandbox for commands works only on Linux so far".into());
        }
        let bwrap = match &self.program {
            Some(program) => program.clone(),
            None => system_program(BWRAP).ok_or("bubblewrap (bwrap) is not installed")?,
        };
        system_program("bash").ok_or("bash is not installed")?;
        let base = [
            "--unshare-user", "--disable-userns", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
            "--unshare-pid", "--unshare-net", "--die-with-parent",
        ];
        probe(&bwrap, base.iter().map(OsString::from).collect()).await?;
        let _ = self.programs.set(self.find_programs());
        let Some(layers) = &self.layers else { return Ok(false) };
        // A layer over an empty folder, where the real ones will be kept.
        let probe_dir = layers.join("probe");
        let made = ["lower", "upper", "work"].iter().all(|d| std::fs::create_dir_all(probe_dir.join(d)).is_ok());
        let mut args: Vec<OsString> = base.iter().map(OsString::from).collect();
        args.extend(["--overlay-src".into(), probe_dir.join("lower").into()]);
        args.extend(["--overlay".into(), probe_dir.join("upper").into(), probe_dir.join("work").into(), probe_dir.join("lower").into()]);
        let layered = made && probe(&bwrap, args).await.is_ok();
        let _ = remove_all(&probe_dir);
        if !layered {
            eprintln!("blixel: cache layers do not work here; commands see tool caches read-only");
        }
        Ok(layered)
    }

    /// bubblewrap and bash: root-owned system programs (or the caller's
    /// bubblewrap). One not found becomes a path that does not exist, so
    /// nothing else is ever started in its place.
    fn find_programs(&self) -> (PathBuf, PathBuf) {
        let missing = || PathBuf::from("/nonexistent/system-program");
        let bwrap = self.program.clone().or_else(|| system_program(BWRAP)).unwrap_or_else(missing);
        (bwrap, system_program("bash").unwrap_or_else(missing))
    }

    /// `bash -c command` inside the sandbox, in `root`: the project folder
    /// (as a real path). `layers` is what `ready` said. Keep the result
    /// until the command has ended, then pass it to `after`.
    pub fn command(&self, root: &Path, command: &str, network: bool, layers: bool) -> Prepared {
        // Found by `ready`; looked up the same way if a command comes first.
        let (bwrap, bash) = self.programs.get_or_init(|| self.find_programs()).clone();
        let begun = begin(root);
        let filter = seccomp_filter();
        let mut refusal = begun.refusal.clone();
        if filter.is_none() && refusal.is_none() {
            refusal = Some("Blixel could not set up the sandbox's filter, so this command did not run.".into());
        }
        let (status, status_write) = status_pipe().unzip();
        let mut handles: Vec<&File> = begun.held.iter().chain(&begun.pins).map(|(file, _)| file).collect();
        handles.extend(filter.as_ref());
        handles.extend(status_write.as_ref());

        let mut args = self.args(root, network, layers, &begun.held, &begun.pins, filter.as_ref());
        #[cfg(target_os = "linux")]
        if let Some(write) = &status_write {
            use std::os::fd::AsRawFd;
            args.extend(["--json-status-fd".into(), write.as_raw_fd().to_string().into()]);
        }
        args.push("--clearenv".into());
        for (name, value) in self.env(std::env::vars_os()) {
            args.extend(["--setenv".into(), name, value]);
        }
        // Refused: the command does not run; the sandbox only says why.
        let script = match &refusal {
            Some(reason) => format!("echo {} >&2; exit 126", shell_quoted(reason)),
            None => command.to_string(),
        };
        let mut cmd = tokio::process::Command::new(&bwrap);
        cmd.args(args).arg("--").arg(&bash).arg("-c").arg(script);
        // bubblewrap itself gets nothing a command could have set or written.
        cmd.env_clear().current_dir("/");
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::AsRawFd;
            let fds: Vec<i32> = handles.iter().map(|file| file.as_raw_fd()).collect();
            // SAFETY: only async-signal-safe calls (fcntl, keyctl) between fork and exec.
            unsafe {
                cmd.pre_exec(move || {
                    // The handles reach bubblewrap.
                    for &fd in &fds {
                        if libc::fcntl(fd, libc::F_SETFD, 0) == -1 {
                            return Err(std::io::Error::last_os_error());
                        }
                    }
                    // A session keyring of its own (the filter keeps commands
                    // from the kernel's keyrings; this is a second wall).
                    const KEYCTL_JOIN_SESSION_KEYRING: libc::c_long = 1;
                    let joined = libc::syscall(libc::SYS_keyctl, KEYCTL_JOIN_SESSION_KEYRING, std::ptr::null::<libc::c_char>());
                    if joined == -1 {
                        let e = std::io::Error::last_os_error();
                        // A kernel without keyrings has none to keep from it.
                        if e.raw_os_error() != Some(libc::ENOSYS) {
                            return Err(e);
                        }
                    }
                    Ok(())
                });
            }
        }
        let mut held: Vec<File> = begun.held.into_iter().chain(begun.pins).map(|(file, _)| file).collect();
        held.extend(filter);
        held.extend(status_write);
        Prepared {
            command: cmd,
            _held: held,
            root: root.to_path_buf(),
            id: begun.id,
            absent: begun.absent,
            links: begun.links,
            status,
            pid: None,
            ended: AtomicBool::new(false),
        }
    }

    /// After a command, once its sandbox is empty (a stopped command's
    /// processes can outlive bubblewrap for a moment): protected names it
    /// created (a CLAUDE.md, a link at such a name, a submodule's `.git`) are
    /// moved aside under a new name, since they may change only through the
    /// edit tool, which asks the user. Returns (name, where it is now, or why
    /// it could not be moved) for each.
    pub async fn after(&self, _root: &Path, prepared: &mut Prepared) -> Vec<(String, String)> {
        if prepared.ended.load(Ordering::SeqCst) {
            return Vec::new();
        }
        if let Some(pid) = prepared.sandbox_pid() {
            let started = std::time::Instant::now();
            while sandbox_alive(pid) && started.elapsed() < EMPTY_WAIT {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }
        // Marked only now: given up while waiting, it is still ended on drop.
        if prepared.ended.swap(true, Ordering::SeqCst) {
            return Vec::new();
        }
        end(&prepared.root, prepared.id, &prepared.absent, &prepared.links)
    }

    /// The environment commands get: the kept variables, without credentials
    /// in their addresses, with this home.
    fn env(&self, vars: impl Iterator<Item = (OsString, OsString)>) -> Vec<(OsString, OsString)> {
        let mut kept: Vec<(OsString, OsString)> = vars
            .filter_map(|(name, value)| {
                let (name, value) = (name.to_str()?, value.to_str()?);
                let wanted = KEPT_VARS.contains(&name) || KEPT_PREFIXES.iter().any(|p| name.starts_with(p));
                (wanted && !secret_name(name)).then(|| (name.into(), without_credentials(value).into()))
            })
            .collect();
        kept.push(("HOME".into(), self.home_var.clone().into()));
        kept
    }

    fn args(&self, root: &Path, network: bool, layers: bool, held: &[(File, String)], pins: &[(File, String)], filter: Option<&File>) -> Vec<OsString> {
        let mut a = Args::default();
        a.add(&["--die-with-parent", "--new-session", "--unshare-user", "--disable-userns", "--unshare-pid"]);
        a.add(&["--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try"]);
        if !network {
            a.add(&["--unshare-net"]);
        }
        #[cfg(target_os = "linux")]
        if let Some(filter) = filter {
            use std::os::fd::AsRawFd;
            a.add_os(["--seccomp".into(), filter.as_raw_fd().to_string().into()]);
        }
        #[cfg(not(target_os = "linux"))]
        let _ = filter;
        a.add(&["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"]);
        for dir in EMPTIED.iter().map(Path::new) {
            if dir.is_dir() && !dir.is_symlink() {
                a.tmpfs(dir);
            }
        }
        // Names are looked up through /etc/resolv.conf, which often points into /run.
        if let Ok(resolv) = std::fs::canonicalize("/etc/resolv.conf") {
            if resolv.starts_with("/run") {
                a.ro_bind(&resolv);
            }
        }
        // NixOS keeps its programs there.
        if Path::new("/run/current-system").exists() {
            a.ro_bind(Path::new("/run/current-system"));
        }

        // The home folder, empty but for the tool folders. Nothing in it can
        // be changed by a command (caches change only in their layers), so
        // its paths are safe to hand to bubblewrap.
        let home = &self.home;
        a.tmpfs(home);
        let mut shown: Vec<PathBuf> = Vec::new();
        for rel in TOOLS {
            let path = home.join(rel);
            if path.exists() {
                a.ro_bind(&path);
                shown.push(path);
            }
        }
        // Credential files read empty: an empty file of our own is bound over
        // them (the sandbox's mounts do not allow /dev/null there). Without
        // one, a folder holding such a file is not shown at all.
        let empty = self.empty_file();
        for rel in CACHES {
            let path = home.join(rel);
            if !path.is_dir() {
                continue;
            }
            let holds_secret = MASKED.iter().any(|m| m.starts_with(&format!("{rel}/")) && home.join(m).is_file());
            if holds_secret && empty.is_none() {
                continue;
            }
            match self.layer(rel).filter(|_| layers) {
                Some((upper, work)) => {
                    a.add_os(["--overlay-src".into(), path.clone().into()]);
                    a.add_os(["--overlay".into(), upper.into(), work.into(), path.clone().into()]);
                }
                None => a.ro_bind(&path),
            }
            shown.push(path);
        }
        if let Some(empty) = &empty {
            for rel in MASKED {
                let path = home.join(rel);
                if path.is_file() && shown.iter().any(|s| path.starts_with(s)) {
                    a.add_os(["--ro-bind".into(), empty.into(), path.into()]);
                }
            }
        }
        // Folders on the PATH under home, read-only, unless shown already or
        // secret. Never one in the project, or one written relative to where
        // Blixel runs: a command could make those lead anywhere.
        let path_var = std::env::var_os("PATH").unwrap_or_default();
        for entry in std::env::split_paths(&path_var) {
            if !entry.is_absolute() || entry.starts_with(root) {
                continue;
            }
            let Ok(dir) = std::fs::canonicalize(&entry) else { continue };
            let inside = dir.starts_with(home) && dir != *home;
            let secret = dir.starts_with(root)
                || SECRETS.iter().any(|s| dir.starts_with(home.join(s)))
                || self.app_data.as_ref().is_some_and(|d| dir.starts_with(d) || d.starts_with(&dir))
                || self.layers.as_ref().is_some_and(|l| dir.starts_with(l));
            if inside && !secret && dir.is_dir() && !shown.iter().any(|s| dir.starts_with(s)) {
                a.ro_bind(&dir);
                shown.push(dir);
            }
        }

        // The project, which commands may change, but for the protected
        // entries: bound read-only by the handles Blixel opened, after the
        // folders on the way to them (shallowest first) are pinned in place.
        a.add_os(["--bind".into(), root.into(), root.into()]);
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::AsRawFd;
            let mut pins: Vec<&(File, String)> = pins.iter().collect();
            pins.sort_by_key(|(_, rel)| rel.matches('/').count());
            for (file, rel) in pins {
                a.add_os(["--bind-fd".into(), file.as_raw_fd().to_string().into(), root.join(rel).into()]);
            }
            for (file, rel) in held {
                a.add_os(["--ro-bind-fd".into(), file.as_raw_fd().to_string().into(), root.join(rel).into()]);
            }
        }
        #[cfg(not(target_os = "linux"))]
        let _ = (held, pins);
        a.add_os(["--chdir".into(), root.into()]);
        a.0
    }

    /// An empty file of this agent's, to show in place of a secret one.
    fn empty_file(&self) -> Option<PathBuf> {
        let path = self.layers.as_ref()?.join("empty");
        std::fs::create_dir_all(self.layers.as_ref()?).ok()?;
        std::fs::write(&path, b"").ok()?;
        Some(path)
    }

    /// The upper and work folders of this agent's layer over a cache folder.
    fn layer(&self, rel: &str) -> Option<(PathBuf, PathBuf)> {
        let dir = self.layers.as_ref()?.join(rel.replace('/', "_"));
        let (upper, work) = (dir.join("upper"), dir.join("work"));
        (std::fs::create_dir_all(&upper).is_ok() && std::fs::create_dir_all(&work).is_ok()).then_some((upper, work))
    }
}

async fn probe(bwrap: &Path, args: Vec<OsString>) -> Result<(), String> {
    let output = tokio::process::Command::new(bwrap)
        .args(args)
        .arg("true")
        .env_clear()
        .current_dir("/")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output()
        .await;
    match output {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => {
            let said = String::from_utf8_lossy(&o.stderr).trim().chars().take(300).collect::<String>();
            Err(format!("bubblewrap does not work here: {}", if said.is_empty() { o.status.to_string() } else { said }))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err("bubblewrap (bwrap) is not installed".into()),
        Err(e) => Err(format!("bubblewrap could not start: {e}")),
    }
}

/// A program of the system, by name: the first on Blixel's own PATH whose
/// real path, and every folder above it, belongs to root and can be changed
/// by nobody else. So nothing a command wrote is ever run outside the sandbox.
fn system_program(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .filter(|dir| dir.is_absolute())
        .filter_map(|dir| std::fs::canonicalize(dir.join(name)).ok())
        .find(|real| real.is_file() && owned_by_root(real))
}

fn owned_by_root(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        path.ancestors().all(|p| std::fs::metadata(p).is_ok_and(|m| m.uid() == 0 && m.mode() & 0o022 == 0))
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        false
    }
}

/// `text` as one word for bash.
fn shell_quoted(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

// ---- The project's running commands ----

/// Each project's running commands, across all agents: what each found
/// missing, and the placeholder `.git` while one stands.
#[derive(Default)]
struct Running {
    next: u64,
    commands: HashMap<u64, Vec<String>>,
    /// (device, inode) of the placeholder `.git` Blixel made.
    placeholder: Option<(u64, u64)>,
    /// The permissions of the project folder ("") and of the folders on the
    /// way to protected entries, as the first running command found them: a
    /// command may change them to keep Blixel from checking or moving
    /// anything, so each end puts them back.
    modes: HashMap<String, u32>,
}

static PROJECTS: LazyLock<std::sync::Mutex<HashMap<PathBuf, Running>>> = LazyLock::new(Default::default);

/// The protected names that a running command may have made: they are not
/// to be trusted (as project notes, say) until it has ended.
pub fn pending(root: &Path) -> HashSet<String> {
    let projects = PROJECTS.lock().expect("projects lock");
    projects.get(root).map(|r| r.commands.values().flatten().cloned().collect()).unwrap_or_default()
}

struct Begun {
    id: u64,
    held: Vec<(File, String)>,
    /// The folders on the way to a protected entry deeper in the project, to
    /// be bound onto themselves: a mount cannot be renamed, so none of them
    /// can be swapped for another (they stay writable).
    pins: Vec<(File, String)>,
    absent: Vec<String>,
    links: Vec<(String, (u64, u64))>,
    refusal: Option<String>,
}

/// Registers a command in its project and opens the protected entries.
fn begin(root: &Path) -> Begun {
    let mut projects = PROJECTS.lock().expect("projects lock");
    let running = projects.entry(root.to_path_buf()).or_default();
    // Names another running command found missing may be its own making.
    let pending: HashSet<String> = running.commands.values().flatten().cloned().collect();
    // No repository here: a read-only empty `.git` stands in while commands
    // run, so none can make one that git (the user's, or an agent program's
    // own when it starts) would use outside the sandbox.
    if running.placeholder.is_none() && std::fs::symlink_metadata(root.join(".git")).is_err() {
        running.placeholder = make_placeholder(&root.join(".git"));
    }
    let (folders, files) = crate::rules::protected_names();
    let mut names: Vec<String> = folders.iter().chain(files).cloned().collect();
    let (git_dirs, mut refusal) = git_entries(root);
    names.extend(git_dirs.iter().cloned());
    let (mut held, mut absent, mut links) = (Vec::new(), Vec::new(), Vec::new());
    for rel in names {
        if pending.contains(&rel) {
            absent.push(rel);
            continue;
        }
        match open_beneath(root, &rel) {
            Entry::Opened(file) => held.push((file, rel)),
            Entry::Missing => absent.push(rel),
            // A git folder reached through a link cannot be kept read-only.
            Entry::Link if git_dirs.contains(&rel) => {
                refusal.get_or_insert_with(|| {
                    format!("Commands cannot run: {rel} is reached through a link, which the sandbox cannot keep read-only.")
                });
            }
            // A link the user made at a protected name: never bound (it leads
            // elsewhere), and left as it is unless a command replaces it.
            Entry::Link => links.extend(identity(&root.join(&rel)).map(|id| (rel, id))),
            Entry::Blocked(why) => {
                refusal.get_or_insert_with(|| {
                    format!("Commands cannot run: {rel} cannot be checked ({why}). Its folder's permissions may have changed; put them back.")
                });
            }
        }
    }
    let mut pins: Vec<(File, String)> = Vec::new();
    for (_, rel) in &held {
        let parts: Vec<&str> = rel.split('/').collect();
        for depth in 1..parts.len() {
            let folder = parts[..depth].join("/");
            if pins.iter().any(|(_, p)| *p == folder) {
                continue;
            }
            match open_beneath(root, &folder) {
                Entry::Opened(file) => pins.push((file, folder)),
                _ => {
                    refusal.get_or_insert_with(|| {
                        format!("Commands cannot run: {folder}, on the way to {rel}, is a link or cannot be checked, which the sandbox cannot keep in place.")
                    });
                }
            }
        }
    }
    // The folders whose permissions are put back after each command: the
    // project's, the pinned ones, and those holding names to move aside.
    let mut watched: Vec<String> = vec![String::new()];
    watched.extend(pins.iter().map(|(_, rel)| rel.clone()));
    for rel in &absent {
        if let Some((parent, _)) = rel.rsplit_once('/') {
            watched.push(parent.to_string());
        }
    }
    for rel in watched {
        if !running.modes.contains_key(&rel) {
            if let Some(mode) = folder_mode(root, &rel) {
                running.modes.insert(rel, mode);
            }
        }
    }
    let id = running.next;
    running.next += 1;
    running.commands.insert(id, absent.clone());
    Begun { id, held, pins, absent, links, refusal }
}

/// (device, inode) of the entry at `path` itself.
fn identity(path: &Path) -> Option<(u64, u64)> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        std::fs::symlink_metadata(path).ok().map(|m| (m.dev(), m.ino()))
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

/// The permissions of the folder at `rel` ("" for the project folder).
fn folder_mode(root: &Path, rel: &str) -> Option<u32> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let meta = if rel.is_empty() {
            std::fs::metadata(root).ok()?
        } else {
            match open_beneath(root, rel) {
                Entry::Opened(file) => file.metadata().ok()?,
                _ => return None,
            }
        };
        meta.is_dir().then(|| meta.permissions().mode() & 0o7777)
    }
    #[cfg(not(unix))]
    {
        let _ = (root, rel);
        None
    }
}

/// Puts back a folder's permissions, through a handle opened without
/// following links (so a link swapped in is never followed).
fn restore_mode(root: &Path, rel: &str, mode: u32) {
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::PermissionsExt;
        if folder_mode(root, rel).is_none_or(|now| now == mode) {
            return;
        }
        let set = std::fs::Permissions::from_mode(mode);
        if rel.is_empty() {
            let _ = std::fs::set_permissions(root, set);
        } else if let Entry::Opened(file) = open_beneath(root, rel) {
            // A handle without access rights is changed through its /proc name.
            let _ = std::fs::set_permissions(format!("/proc/self/fd/{}", file.as_raw_fd()), set);
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = (root, rel, mode);
}

/// Ends a command: what it made at protected names goes aside, the project
/// folder's permissions come back, and the placeholder goes with the last one.
fn end(root: &Path, id: u64, absent: &[String], links: &[(String, (u64, u64))]) -> Vec<(String, String)> {
    let mut projects = PROJECTS.lock().expect("projects lock");
    let Some(running) = projects.get_mut(root) else { return Vec::new() };
    running.commands.remove(&id);
    // A command may have changed folders' permissions, so nothing could be
    // checked or moved: put them back, shallowest first.
    let mut modes: Vec<(&String, &u32)> = running.modes.iter().collect();
    modes.sort_by_key(|(rel, _)| if rel.is_empty() { 0 } else { rel.matches('/').count() + 1 });
    for (rel, mode) in modes {
        restore_mode(root, rel, *mode);
    }
    // A link the user made, replaced by a command with something else.
    let replaced = links.iter().filter(|(rel, id)| identity(&root.join(rel)).is_some_and(|now| now != *id)).map(|(rel, _)| rel);
    let mut moved = Vec::new();
    for rel in absent.iter().chain(replaced) {
        if matches!(open_beneath(root, rel), Entry::Missing) {
            continue;
        }
        let (name, kept) = match move_aside(root, rel) {
            Ok(aside) => (rel.clone(), format!("now {aside}")),
            Err(e) => (rel.clone(), format!("could not be moved aside ({e}): check it before using git or starting an agent")),
        };
        moved.push((name, kept));
    }
    if running.commands.is_empty() {
        if let Some(placeholder) = running.placeholder.take() {
            remove_placeholder(&root.join(".git"), placeholder);
        }
        projects.remove(root);
    }
    moved
}

fn make_placeholder(path: &Path) -> Option<(u64, u64)> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        let file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o444).custom_flags(libc::O_NOFOLLOW).open(path).ok()?;
        let meta = file.metadata().ok()?;
        Some((meta.dev(), meta.ino()))
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

/// Removes the placeholder, if it is still Blixel's own: the same file, empty.
fn remove_placeholder(path: &Path, (dev, ino): (u64, u64)) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let ours = std::fs::symlink_metadata(path).is_ok_and(|m| m.is_file() && m.dev() == dev && m.ino() == ino && m.len() == 0);
        if ours {
            let _ = std::fs::remove_file(path);
        }
    }
    #[cfg(not(unix))]
    let _ = (path, dev, ino);
}

/// Folders git reaches from the project other than `.git` itself, which are
/// protected too (relative paths): the folder a `.git` file points to inside
/// the project (`gitdir: ./.bare`), and each submodule's `.git` (a file
/// pointing to its folder in `.git/modules`; rewritten, it could point git
/// at a folder with code to run). Refused (with why) when they are reached
/// through a link, which no sandbox could keep read-only.
fn git_entries(root: &Path) -> (Vec<String>, Option<String>) {
    let mut found = Vec::new();
    let dot_git = root.join(".git");
    let Ok(meta) = std::fs::symlink_metadata(&dot_git) else { return (found, None) };
    let inside = |p: &Path| p.strip_prefix(root).ok().map(|r| r.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/"));
    let gitdir = if meta.file_type().is_symlink() {
        let target = std::fs::canonicalize(&dot_git).ok();
        if target.as_deref().is_some_and(|t| t.starts_with(root)) {
            return (found, Some("Commands cannot run: the project's .git is a link into the project, which the sandbox cannot keep read-only. Make .git a folder or a gitdir file.".into()));
        }
        return (found, None);
    } else if meta.is_file() {
        let text = std::fs::read_to_string(&dot_git).unwrap_or_default();
        let Some(target) = text.lines().find_map(|l| l.strip_prefix("gitdir:")).map(str::trim) else { return (found, None) };
        let target = normalize(&root.join(target));
        match inside(&target) {
            Some(rel) if !rel.is_empty() => {
                found.push(rel);
                target
            }
            _ => return (found, None),
        }
    } else {
        dot_git
    };
    // Linked work trees (git worktree add): each one's `.git` file, as the
    // read-only git folder records it.
    for entry in std::fs::read_dir(gitdir.join("worktrees")).into_iter().flatten().flatten() {
        let recorded = std::fs::read_to_string(entry.path().join("gitdir")).unwrap_or_default();
        let recorded = recorded.trim();
        if !recorded.is_empty() {
            if let Some(rel) = inside(&normalize(&entry.path().join(recorded))) {
                found.push(rel);
            }
        }
    }
    // Submodules, from the read-only modules folder: each one's work tree.
    let mut stack = vec![(gitdir.join("modules"), 0)];
    while let Some((dir, depth)) = stack.pop() {
        if depth > 4 || found.len() > 200 {
            break;
        }
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let module = entry.path();
            if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let config = std::fs::read_to_string(module.join("config")).unwrap_or_default();
            let worktree = config.lines().find_map(|l| {
                let (key, value) = l.split_once('=')?;
                (key.trim() == "worktree").then(|| value.trim().to_string())
            });
            if let Some(worktree) = worktree {
                if let Some(rel) = inside(&normalize(&module.join(worktree)).join(".git")) {
                    found.push(rel);
                }
            }
            stack.push((module.join("modules"), depth + 1));
            if module.join("config").is_file() {
                continue;
            }
            // A name with slashes: its folders hold the module.
            stack.push((module, depth + 1));
        }
    }
    (found, None)
}

/// A path with `.` and `..` worked out by its text, without the disk.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

enum Entry {
    Opened(File),
    Missing,
    /// A link at the name, or on the way to it.
    Link,
    /// It cannot be looked at (a folder without permission, say): why.
    Blocked(String),
}

/// The entry at `rel` beneath `root`, opened without following a link at
/// any step (`root` itself is trusted: commands cannot change it).
fn open_beneath(root: &Path, rel: &str) -> Entry {
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::{AsRawFd, FromRawFd};
        use std::os::unix::ffi::OsStrExt;
        let open = |dir: i32, name: &std::ffi::OsStr, flags: i32| -> Result<File, std::io::Error> {
            let name = std::ffi::CString::new(name.as_bytes()).map_err(|_| std::io::ErrorKind::InvalidInput)?;
            // SAFETY: a valid C string; the fd returned is owned by the File.
            let fd = unsafe { libc::openat(dir, name.as_ptr(), flags | libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
            if fd < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(unsafe { File::from_raw_fd(fd) })
        };
        let mut dir = match open(libc::AT_FDCWD, root.as_os_str(), libc::O_DIRECTORY) {
            Ok(dir) => dir,
            Err(e) => return Entry::Blocked(e.to_string()),
        };
        let parts: Vec<&std::ffi::OsStr> = Path::new(rel).components().map(|c| c.as_os_str()).collect();
        for (i, part) in parts.iter().enumerate() {
            let last = i + 1 == parts.len();
            match open(dir.as_raw_fd(), part, if last { 0 } else { libc::O_DIRECTORY }) {
                Ok(file) if last => {
                    return match file.metadata() {
                        Ok(m) if m.file_type().is_symlink() => Entry::Link,
                        Ok(_) => Entry::Opened(file),
                        Err(e) => Entry::Blocked(e.to_string()),
                    };
                }
                Ok(file) => dir = file,
                Err(e) => {
                    return match e.raw_os_error() {
                        Some(libc::ENOENT) => Entry::Missing,
                        // O_DIRECTORY on a link (or a file) on the way.
                        Some(libc::ENOTDIR) | Some(libc::ELOOP) => Entry::Link,
                        // Anything else (no permission): it cannot be checked.
                        _ => Entry::Blocked(e.to_string()),
                    };
                }
            }
        }
        Entry::Missing
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (root, rel);
        Entry::Missing
    }
}

/// Moves `rel` aside to a new name beside it that no one could have taken
/// beforehand; returns the new relative path. The folder holding it is
/// opened without following links, so the move stays in the project.
fn move_aside(root: &Path, rel: &str) -> std::io::Result<String> {
    let path = Path::new(rel);
    let name = path.file_name().ok_or(std::io::ErrorKind::InvalidInput)?;
    let parent = path.parent().filter(|p| !p.as_os_str().is_empty());
    let mut random = [0u8; 6];
    getrandom::fill(&mut random).map_err(|_| std::io::ErrorKind::Other)?;
    let tag: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let aside = format!("{}.from-command-{tag}", name.to_string_lossy());
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        use std::os::unix::ffi::OsStrExt;
        let dir = match parent {
            None => std::fs::File::open(root)?,
            Some(parent) => match open_beneath(root, &parent.to_string_lossy()) {
                Entry::Opened(dir) => dir,
                _ => return Err(std::io::Error::other("the folder holding it is a link")),
            },
        };
        let from = std::ffi::CString::new(name.as_bytes()).map_err(|_| std::io::ErrorKind::InvalidInput)?;
        let to = std::ffi::CString::new(aside.as_bytes()).map_err(|_| std::io::ErrorKind::InvalidInput)?;
        // SAFETY: valid C strings and an open folder.
        let done = unsafe { libc::renameat2(dir.as_raw_fd(), from.as_ptr(), dir.as_raw_fd(), to.as_ptr(), libc::RENAME_NOREPLACE) };
        if done != 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let base = parent.map(|p| root.join(p)).unwrap_or_else(|| root.to_path_buf());
        std::fs::rename(base.join(name), base.join(&aside))?;
    }
    Ok(match parent {
        Some(parent) => format!("{}/{aside}", parent.to_string_lossy()),
        None => aside,
    })
}

// ---- The filter ----

/// A seccomp filter, as bubblewrap reads it, that refuses the kernel's
/// keyring calls (add_key, request_key, keyctl) for every way a program on
/// this machine can make them: the user's keyrings can hold tickets and keys.
fn seccomp_filter() -> Option<File> {
    #[cfg(target_os = "linux")]
    {
        use std::io::{Seek, Write};
        use std::os::fd::FromRawFd;
        let bytes = filter_program();
        // SAFETY: a valid C string; the fd returned is owned by the File.
        let fd = unsafe { libc::memfd_create(c"blixel-filter".as_ptr(), libc::MFD_CLOEXEC) };
        if fd < 0 {
            return None;
        }
        let mut file = unsafe { File::from_raw_fd(fd) };
        file.write_all(&bytes).ok()?;
        file.rewind().ok()?;
        Some(file)
    }
    #[cfg(not(target_os = "linux"))]
    None
}

/// The filter's instructions (classic BPF, 8 bytes each).
fn filter_program() -> Vec<u8> {
    const LD_ABS: u16 = 0x20; // BPF_LD | BPF_W | BPF_ABS
    const JEQ: u16 = 0x15; // BPF_JMP | BPF_JEQ | BPF_K
    const JGE: u16 = 0x35; // BPF_JMP | BPF_JGE | BPF_K
    const RET: u16 = 0x06; // BPF_RET | BPF_K
    const ALLOW: u32 = 0x7fff_0000;
    const DENY: u32 = 0x0005_0000 | 1; // SECCOMP_RET_ERRNO | EPERM
    const NR: u32 = 0; // offsetof(struct seccomp_data, nr)
    const ARCH: u32 = 4; // offsetof(struct seccomp_data, arch)
    const X32_BIT: u32 = 0x4000_0000;
    // (audit arch, add_key, request_key, keyctl, has x32)
    let arches: [(u32, [u32; 3], bool); 5] = [
        (0xC000_003E, [248, 249, 250], true), // x86_64
        (0x4000_0003, [286, 287, 288], false), // i386
        (0xC000_00B7, [217, 218, 219], false), // aarch64
        (0x4000_0028, [309, 310, 311], false), // arm
        (0xC000_00F3, [217, 218, 219], false), // riscv64
    ];
    // (code, jt, jf, k); a jt of u8::MAX means "to the refusal", patched below.
    const TO_DENY: u8 = u8::MAX;
    let mut prog: Vec<(u16, u8, u8, u32)> = vec![(LD_ABS, 0, 0, ARCH)];
    for (arch, calls, x32) in arches {
        let body = 1 + usize::from(x32) + calls.len() + 1;
        prog.push((JEQ, 0, body as u8, arch));
        prog.push((LD_ABS, 0, 0, NR));
        if x32 {
            prog.push((JGE, TO_DENY, 0, X32_BIT));
        }
        for call in calls {
            prog.push((JEQ, TO_DENY, 0, call));
        }
        prog.push((RET, 0, 0, ALLOW));
    }
    prog.push((RET, 0, 0, ALLOW)); // another architecture: nothing of this machine's
    let deny = prog.len();
    prog.push((RET, 0, 0, DENY));
    let mut bytes = Vec::with_capacity(prog.len() * 8);
    for (i, (code, jt, jf, k)) in prog.into_iter().enumerate() {
        let jt = if jt == TO_DENY { (deny - i - 1) as u8 } else { jt };
        bytes.extend(code.to_ne_bytes());
        bytes.push(jt);
        bytes.push(jf);
        bytes.extend(k.to_ne_bytes());
    }
    bytes
}

// ---- Removing layers ----

/// Removes a folder that may hold cache layers. The kernel leaves a folder
/// nobody may enter in each layer's work folder, which `remove_dir_all`
/// cannot remove, so folders are opened up first.
pub fn remove_all(path: &Path) -> std::io::Result<()> {
    open_up(path);
    std::fs::remove_dir_all(path)
}

fn open_up(dir: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Never follows a link: only the folders of this tree are touched.
        let Ok(meta) = std::fs::symlink_metadata(dir) else { return };
        if !meta.is_dir() {
            return;
        }
        if meta.permissions().mode() & 0o700 != 0o700 {
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                open_up(&entry.path());
            }
        }
    }
}

#[derive(Default)]
struct Args(Vec<OsString>);

impl Args {
    fn add(&mut self, args: &[&str]) {
        self.0.extend(args.iter().map(OsString::from));
    }

    fn add_os<const N: usize>(&mut self, args: [OsString; N]) {
        self.0.extend(args);
    }

    fn ro_bind(&mut self, path: &Path) {
        self.add_os(["--ro-bind".into(), path.into(), path.into()]);
    }

    fn tmpfs(&mut self, path: &Path) {
        self.add_os(["--tmpfs".into(), path.into()]);
    }
}

#[cfg(test)]
mod tests;
