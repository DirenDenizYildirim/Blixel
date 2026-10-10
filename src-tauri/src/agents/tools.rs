//! Blixel's own file and command tools, served to one agent over local HTTP.
//! The agent's built-in edit and shell tools are switched off, so every edit
//! and command passes through here: checked against the agent's settings and
//! area, logged, shown in the editor and shell, and only then done.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::task::Poll;
use std::time::Duration;

use axum::extract::{ConnectInfo, Request};
use axum::http::{header::AUTHORIZATION, StatusCode};
use axum::middleware::Next;
use axum::response::IntoResponse;
use rmcp::handler::server::{router::tool::ToolRouter, wrapper::Parameters};
use rmcp::model::{CallToolResult, ContentBlock, MetaObject, ServerCapabilities, ServerConfig};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{schemars, tool, tool_handler, tool_router, ErrorData, ServerHandler};
use serde::Deserialize;
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

use crate::events::{new_id, Activity, Edit};
use crate::workspace::{resolve_under, FILE_LOCK, MAX_FILE_BYTES};

use super::runtime::{AgentRuntime, Gate};
use super::settings::{EditCheck, Setting, Tool};

/// The name agents see this server under; tools become `mcp__blixel__<tool>`.
pub const SERVER_NAME: &str = "blixel";
pub const TOOL_NAMES: [&str; 3] = ["edit", "write", "bash"];

const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const MAX_TIMEOUT_MS: u64 = 600_000;
/// Output returned to the model is cut to this many characters (head and tail kept).
const MAX_OUTPUT_CHARS: usize = 30_000;

#[derive(Clone)]
pub struct BlixelTools {
    rt: Arc<AgentRuntime>,
    root: PathBuf,
    /// The tool server's stop: cancelled when the session ends (Stop, a
    /// project switch, the agent exiting), and commands still running stop with it.
    stop: CancellationToken,
    #[allow(dead_code, reason = "read by the tool_handler macro")]
    tool_router: ToolRouter<Self>,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct EditArgs {
    /// The absolute path to the file to modify
    file_path: String,
    /// The text to replace
    old_string: String,
    /// The text to replace it with (must be different from old_string)
    new_string: String,
    /// Replace all occurrences of old_string (default false)
    #[serde(default)]
    replace_all: bool,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct WriteArgs {
    /// The absolute path to the file to write (must be absolute, not relative)
    file_path: String,
    /// The content to write to the file
    content: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct BashArgs {
    /// The command to execute
    command: String,
    /// Optional timeout in milliseconds (max 600000)
    timeout: Option<u64>,
    /// Clear, concise description of what this command does
    description: Option<String>,
    /// Not available in Blixel yet; leave unset.
    #[serde(default)]
    run_in_background: bool,
}

/// Claude Code hides MCP tools behind its tool search unless a tool asks to be
/// loaded. These stand in for its own Bash, Edit and Write, so they always are.
fn always_load() -> MetaObject {
    let mut meta = serde_json::Map::new();
    meta.insert("anthropic/alwaysLoad".into(), true.into());
    MetaObject(meta)
}

fn fail(text: impl Into<String>) -> Result<CallToolResult, ErrorData> {
    Ok(CallToolResult::error(vec![ContentBlock::text(text)]))
}

fn done(text: impl Into<String>) -> Result<CallToolResult, ErrorData> {
    Ok(CallToolResult::success(vec![ContentBlock::text(text)]))
}

#[tool_router]
impl BlixelTools {
    pub fn new(rt: Arc<AgentRuntime>, root: PathBuf) -> Self {
        Self { rt, root, stop: CancellationToken::new(), tool_router: Self::tool_router() }
    }

    #[tool(
        description = "Performs exact string replacement in a file. old_string must match the file exactly \
            and be unique unless replace_all is true. The change appears live in the user's editor.",
        meta = always_load()
    )]
    async fn edit(&self, Parameters(a): Parameters<EditArgs>) -> Result<CallToolResult, ErrorData> {
        if a.old_string == a.new_string {
            return fail("No changes to make: old_string and new_string are exactly the same.");
        }
        let (full, rel) = match self.allow_edit(&a.file_path).await {
            Ok(v) => v,
            Err(message) => return fail(message),
        };
        // Read and write under the file lock, so a save by the user cannot land in between.
        let before = {
            let _held = FILE_LOCK.lock().expect("file lock");
            let before = match std::fs::read_to_string(&full) {
                Ok(text) => text,
                Err(_) if a.old_string.is_empty() => String::new(),
                Err(e) => return fail(format!("Cannot read {rel}: {e}")),
            };
            let after = if a.old_string.is_empty() {
                if !before.is_empty() {
                    return fail("old_string is empty but the file is not; use write to replace a whole file.");
                }
                a.new_string.clone()
            } else {
                let count = before.matches(&a.old_string).count();
                if count == 0 {
                    return fail(format!("String to replace not found in file.\nString: {}", a.old_string));
                }
                if count > 1 && !a.replace_all {
                    return fail(format!(
                        "Found {count} matches of the string to replace, but replace_all is false. To replace all \
                         occurrences, set replace_all to true. To replace only one occurrence, please provide more \
                         context to uniquely identify the instance."
                    ));
                }
                if a.replace_all {
                    before.replace(&a.old_string, &a.new_string)
                } else {
                    before.replacen(&a.old_string, &a.new_string, 1)
                }
            };
            if let Err(e) = write_file(&full, &after) {
                return fail(format!("Cannot write {rel}: {e}"));
            }
            before
        };
        let at = before.find(&a.old_string).unwrap_or(0);
        self.announce_edit(&rel, &before, &a.old_string, &a.new_string, a.replace_all, at);
        done(format!("The file {} has been updated successfully.", a.file_path))
    }

    #[tool(
        description = "Writes a file, creating it (and its folders) or replacing its contents. \
            The change appears live in the user's editor.",
        meta = always_load()
    )]
    async fn write(&self, Parameters(a): Parameters<WriteArgs>) -> Result<CallToolResult, ErrorData> {
        let (full, rel) = match self.allow_edit(&a.file_path).await {
            Ok(v) => v,
            Err(message) => return fail(message),
        };
        let (existed, before) = {
            let _held = FILE_LOCK.lock().expect("file lock");
            let existed = full.exists();
            let before = if existed { std::fs::read_to_string(&full).unwrap_or_default() } else { String::new() };
            if let Err(e) = write_file(&full, &a.content) {
                return fail(format!("Cannot write {rel}: {e}"));
            }
            (existed, before)
        };
        self.announce_edit(&rel, &before, &before, &a.content, false, 0);
        if !existed {
            self.rt.events.files_changed();
        }
        done(if existed {
            format!("The file {} has been updated successfully.", a.file_path)
        } else {
            format!("File created successfully at: {}", a.file_path)
        })
    }

    #[tool(
        description = "Runs a shell command in the project folder with bash and returns its output and exit \
            code. Each call starts a fresh shell, so cd does not carry over. The command cannot read input. \
            The user watches the output live in this agent's shell.",
        meta = always_load()
    )]
    async fn bash(&self, Parameters(a): Parameters<BashArgs>, ct: CancellationToken) -> Result<CallToolResult, ErrorData> {
        // rmcp runs each call in its own task and only signals a cancel, so the
        // command watches for each way it can be stopped: the agent's program
        // cancelling the call, the user's Stop, and the session ending. Taken
        // now: Stop renews the agent's token for the commands after it.
        let stop = [ct, self.rt.commands_stop(), self.stop.clone()];
        if a.run_in_background {
            return fail("Background commands are not available in Blixel yet. Run the command in the foreground with a timeout.");
        }
        let name = self.rt.name();
        let tools = command_tools(&a.command);
        let title = format!("{name} is asking to run a command");
        match self.rt.gate(&tools, &title, &a.command).await {
            Gate::Allowed => {}
            Gate::Off => {
                let off: Vec<&str> = {
                    let config = self.rt.config.read().expect("config lock");
                    tools.iter().filter(|t| config.permissions.get(**t) == Setting::Off).map(|t| t.as_str()).collect()
                };
                self.log("RUN", &a.command, "not allowed", false, true);
                return fail(format!("{name} is not allowed to {} in this workspace. Ask the user.", off.join(" or ")));
            }
            Gate::Denied => {
                self.log("RUN", &a.command, "denied", false, true);
                return fail("The user denied this command.");
            }
        }
        // Stopped while the user was deciding: nobody waits for the output any more.
        if stop.iter().any(CancellationToken::is_cancelled) {
            self.log("RUN", &a.command, "stopped", false, false);
            return fail("Stopped.");
        }
        let timeout = a.timeout.unwrap_or(DEFAULT_TIMEOUT_MS).min(MAX_TIMEOUT_MS);
        let entry = self.log("RUN", &a.command, "running", true, false);
        let shown = a.description.as_deref().map(|d| format!("{} ({d})", a.command)).unwrap_or_else(|| a.command.clone());
        self.rt.events.shell(&self.rt.id, Some(&a.command), &format!("\x1b[90m$ {shown}\x1b[0m\r\n"));

        let outcome = run_command(&self.root, &a.command, Duration::from_millis(timeout), &stop, |chunk| {
            self.rt.events.shell(&self.rt.id, None, &to_terminal(chunk));
        })
        .await;

        let (result, text) = match outcome {
            Ok(Ran { stopped: true, .. }) => {
                self.update_log(&entry, "RUN", &a.command, "stopped", false);
                self.rt.events.files_changed();
                return fail("Stopped.");
            }
            Ok(Ran { output, code: Some(0), .. }) => ("exit 0".to_string(), clip(&strip_ansi(&output))),
            Ok(Ran { output, code, timed_out, .. }) => {
                let tail = if timed_out {
                    format!("\nCommand timed out after {} seconds", timeout / 1000)
                } else {
                    format!("\nExit code {}", code.map(|c| c.to_string()).unwrap_or_else(|| "unknown (killed)".into()))
                };
                let result = if timed_out { "timed out".to_string() } else { format!("exit {}", code.unwrap_or(-1)) };
                (result, clip(&strip_ansi(&output)) + &tail)
            }
            Err(e) => ("failed to start".to_string(), format!("Could not run the command: {e}")),
        };
        self.update_log(&entry, "RUN", &a.command, &result, false);
        self.rt.events.files_changed();
        done(if text.trim().is_empty() { "(no output)".to_string() } else { text })
    }
}

impl BlixelTools {
    /// Resolves the path and applies the areas (the agent's own and its rule
    /// packs'), the protected paths and the Edit setting.
    async fn allow_edit(&self, path: &str) -> Result<(PathBuf, String), String> {
        let (full, rel) = resolve_under(&self.root, path)?;
        let name = self.rt.name();
        let (check, edit) = {
            let config = self.rt.config.read().expect("config lock");
            (config.edit_check(Path::new(&rel)), config.permissions.edit)
        };
        let ask_title = match check {
            EditCheck::Outside(pack) => {
                self.log("EDIT", &rel, "outside its area", false, true);
                return Err(match pack {
                    None => format!("{rel} is outside the area {name} may edit. Ask the user, or hand this to an agent that may."),
                    Some(label) => format!(
                        "{rel} is outside the area the rules from {label} let {name} edit. Ask the user, or hand this to an agent that may."
                    ),
                });
            }
            EditCheck::AlwaysAsk(None) => Some(format!("{name} wants to change an agent settings file")),
            EditCheck::AlwaysAsk(Some(label)) => Some(format!("{name} wants to change a file the rules from {label} protect")),
            EditCheck::Setting => None,
        };
        let gate = match ask_title {
            // Off refuses even protected paths: protection adds a question, it never allows more.
            Some(_) if edit == Setting::Off => Gate::Off,
            // Protected paths always ask, whatever the Edit setting, and the answer is not remembered.
            Some(title) => match self.rt.ask(Tool::Edit, &title, &rel).await {
                super::permissions::Answer::Denied => Gate::Denied,
                _ => Gate::Allowed,
            },
            None => self.rt.gate(&[Tool::Edit], &format!("{name} is asking to edit a file"), &rel).await,
        };
        match gate {
            Gate::Allowed => Ok((full, rel)),
            Gate::Off => {
                self.log("EDIT", &rel, "not allowed", false, true);
                Err(format!("{name} is not allowed to edit files in this workspace."))
            }
            Gate::Denied => {
                self.log("EDIT", &rel, "denied", false, true);
                Err("The user denied this edit.".into())
            }
        }
    }

    fn announce_edit(&self, rel: &str, before: &str, find: &str, replace: &str, replace_all: bool, at: usize) {
        let common = find.bytes().zip(replace.bytes()).take_while(|(a, b)| a == b).count();
        let lead = replace[common.min(replace.len())..].bytes().take_while(|b| *b == b'\n').count();
        let offset = (at + common + lead).min(before.len());
        let line = before.as_bytes()[..offset].iter().filter(|b| **b == b'\n').count() + 1;
        let file = rel.rsplit('/').next().unwrap_or(rel);
        let entry_id = self.log("EDIT", &format!("{file}, line {line}"), "done", false, false);
        self.rt.events.edit(Edit {
            agent_id: &self.rt.id,
            entry_id: &entry_id,
            path: rel,
            before: (before.len() as u64 <= MAX_FILE_BYTES).then_some(before),
            find,
            replace,
            replace_all,
        });
    }

    fn log(&self, verb: &str, target: &str, result: &str, live: bool, refused: bool) -> String {
        let entry_id = new_id("e");
        self.rt.events.activity(Activity { agent_id: &self.rt.id, entry_id: &entry_id, verb, target, result, live, refused, detail: None });
        entry_id
    }

    fn update_log(&self, entry_id: &str, verb: &str, target: &str, result: &str, live: bool) {
        self.rt.events.activity(Activity { agent_id: &self.rt.id, entry_id, verb, target, result, live, refused: false, detail: None });
    }
}

#[tool_handler]
impl ServerHandler for BlixelTools {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build()).with_instructions(
            "Blixel's file and command tools. Use edit and write for every file change and bash for every \
             command; the user sees them live.",
        )
    }
}

/// Serves the tools on 127.0.0.1 at a free port, with `extra` routes beside
/// them (the agent's connectors). Requests must carry `Bearer <token>` and,
/// on Linux, come from a process of the same user: the token is visible to
/// other local users in the adapter's command line.
pub async fn serve(tools: BlixelTools, extra: axum::Router, token: String, cancel: CancellationToken) -> std::io::Result<SocketAddr> {
    // Commands stop with the server.
    let tools = BlixelTools { stop: cancel.clone(), ..tools };
    let service = StreamableHttpService::new(
        move || Ok(tools.clone()),
        Arc::new(LocalSessionManager::default()),
        StreamableHttpServerConfig::default().with_cancellation_token(cancel.child_token()),
    );
    let expected = Arc::new(format!("Bearer {token}"));
    let router = axum::Router::new().nest_service("/mcp", service).merge(extra).layer(axum::middleware::from_fn(
        move |req: Request, next: Next| {
            let expected = expected.clone();
            async move {
                let same_user = req.extensions().get::<ConnectInfo<peer::Peer>>().is_some_and(|c| c.0.same_user);
                let given = req.headers().get(AUTHORIZATION).and_then(|v| v.to_str().ok());
                if !same_user {
                    StatusCode::FORBIDDEN.into_response()
                } else if given == Some(expected.as_str()) {
                    next.run(req).await
                } else {
                    StatusCode::UNAUTHORIZED.into_response()
                }
            }
        },
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    tokio::spawn(async move {
        let shutdown = cancel.cancelled_owned();
        let app = router.into_make_service_with_connect_info::<peer::Peer>();
        if let Err(e) = axum::serve(listener, app).with_graceful_shutdown(shutdown).await {
            eprintln!("blixel: tool server stopped: {e}");
        }
    });
    Ok(addr)
}

/// Who is on the other end of a connection to the tool server.
mod peer {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

    use axum::extract::connect_info::Connected;
    use axum::serve::IncomingStream;
    use tokio::net::TcpListener;

    /// Worked out once per connection, when it is accepted.
    #[derive(Clone, Debug)]
    pub struct Peer {
        pub same_user: bool,
    }

    impl Connected<IncomingStream<'_, TcpListener>> for Peer {
        fn connect_info(stream: IncomingStream<'_, TcpListener>) -> Self {
            let remote = *stream.remote_addr();
            let same_user = stream.io().local_addr().is_ok_and(|local| same_user(remote, local));
            Peer { same_user }
        }
    }

    /// Whether the socket at `remote` (connected to our `local`) belongs to
    /// this process's user: the kernel's socket table names each socket's owner.
    #[cfg(target_os = "linux")]
    pub fn same_user(remote: SocketAddr, local: SocketAddr) -> bool {
        let table = if remote.is_ipv4() { "/proc/net/tcp" } else { "/proc/net/tcp6" };
        let me = unsafe { libc::getuid() };
        std::fs::read_to_string(table).ok().and_then(|t| owner(&t, remote, local)) == Some(me)
    }

    /// Elsewhere only the token protects the server.
    #[cfg(not(target_os = "linux"))]
    pub fn same_user(_remote: SocketAddr, _local: SocketAddr) -> bool {
        true
    }

    /// The uid of the socket whose own address is `local` and whose other end
    /// is `remote`, from the text of /proc/net/tcp or tcp6.
    pub fn owner(table: &str, local: SocketAddr, remote: SocketAddr) -> Option<u32> {
        table.lines().skip(1).find_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            let matches = fields.len() > 7 && parse(fields[1]) == Some(local) && parse(fields[2]) == Some(remote);
            if matches {
                fields[7].parse().ok()
            } else {
                None
            }
        })
    }

    /// "0100007F:1F90" is 127.0.0.1:8080: each 32-bit word of the address is
    /// printed as a number in the machine's byte order, the port in hex.
    fn parse(text: &str) -> Option<SocketAddr> {
        let (ip, port) = text.split_once(':')?;
        let port = u16::from_str_radix(port, 16).ok()?;
        let mut bytes = Vec::with_capacity(16);
        for i in (0..ip.len()).step_by(8) {
            bytes.extend(u32::from_str_radix(ip.get(i..i + 8)?, 16).ok()?.to_ne_bytes());
        }
        let ip = match bytes.len() {
            4 => IpAddr::V4(Ipv4Addr::from(<[u8; 4]>::try_from(bytes).ok()?)),
            16 => IpAddr::V6(Ipv6Addr::from(<[u8; 16]>::try_from(bytes).ok()?)),
            _ => return None,
        };
        Some(SocketAddr::new(ip, port))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn the_socket_table_names_each_sockets_owner() {
            let w = |b: [u8; 4]| format!("{:08X}", u32::from_ne_bytes(b));
            let lo = w([127, 0, 0, 1]);
            let table = format!(
                "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   \
                 0: {lo}:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1\n   \
                 1: {lo}:C350 {lo}:1F90 01 00000000:00000000 00:00000000 00000000  1001        0 2 1\n   \
                 2: {lo}:1F90 {lo}:C350 01 00000000:00000000 00:00000000 00000000  1000        0 3 1\n"
            );
            let server: SocketAddr = "127.0.0.1:8080".parse().unwrap();
            let client: SocketAddr = "127.0.0.1:50000".parse().unwrap();
            assert_eq!(owner(&table, client, server), Some(1001), "the client's own socket, not ours");
            assert_eq!(owner(&table, "127.0.0.1:50001".parse().unwrap(), server), None);
            let v6 = format!("{}{}{}{}:0050", w([0, 0, 0, 0]), w([0, 0, 0, 0]), w([0, 0, 0, 0]), w([0, 0, 0, 1]));
            assert_eq!(parse(&v6), Some("[::1]:80".parse().unwrap()));
        }

        /// The real table finds a real connection's owner: this test's user.
        #[cfg(target_os = "linux")]
        #[test]
        fn a_connection_from_this_user_is_recognised() {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let client = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
            let (accepted, remote) = listener.accept().unwrap();
            assert_eq!(remote, client.local_addr().unwrap());
            assert!(same_user(remote, accepted.local_addr().unwrap()));
            assert!(!same_user("127.0.0.1:1".parse().unwrap(), accepted.local_addr().unwrap()), "unknown sockets are refused");
        }
    }
}

fn write_file(full: &Path, content: &str) -> std::io::Result<()> {
    if let Some(dir) = full.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(full, content)
}

/// Which settings a command needs. Every command needs Run; committing and
/// pushing also need their own setting. This reads the command text, so a
/// script can get around it: without a sandbox it is a check, not a guarantee.
pub fn command_tools(command: &str) -> Vec<Tool> {
    let mut tools = vec![Tool::Run];
    let words = |segment: &str| segment.split_whitespace().map(str::to_owned).collect::<Vec<_>>();
    for segment in command.split(['&', '|', ';', '\n', '(', ')']) {
        let w = words(segment);
        let git = w.iter().position(|x| x == "git" || x.ends_with("/git"));
        if let Some(i) = git {
            // The subcommand is the first word that is neither an option nor an option's value.
            let mut args = w[i + 1..].iter().map(String::as_str);
            let mut sub = None;
            while let Some(x) = args.next() {
                if matches!(x, "-C" | "-c" | "--git-dir" | "--work-tree" | "--namespace") {
                    args.next();
                } else if !x.starts_with('-') {
                    sub = Some(x);
                    break;
                }
            }
            match sub {
                Some("commit" | "merge" | "rebase" | "cherry-pick" | "revert") => tools.push(Tool::Commit),
                Some("push") => tools.push(Tool::Push),
                _ => {}
            }
        }
        if let Some(i) = w.iter().position(|x| x == "gh") {
            if w.get(i + 1).map(String::as_str) == Some("pr") {
                tools.push(Tool::Push);
            }
        }
    }
    tools.sort_by_key(|t| *t as u8);
    tools.dedup();
    tools
}

struct Ran {
    output: String,
    code: Option<i32>,
    timed_out: bool,
    /// Stopped by one of its stop tokens, and killed with everything it started.
    stopped: bool,
}

/// A command's output as kept for the model: its start and its end, so a
/// command that prints for minutes holds a bounded amount of memory.
#[derive(Default)]
struct Kept {
    head: String,
    head_chars: usize,
    tail: String,
    tail_chars: usize,
    dropped: usize,
}

impl Kept {
    const HALF: usize = MAX_OUTPUT_CHARS / 2;

    fn push(&mut self, mut text: &str) {
        if self.head_chars < Self::HALF {
            let take = text.char_indices().nth(Self::HALF - self.head_chars).map_or(text.len(), |(i, _)| i);
            self.head.push_str(&text[..take]);
            self.head_chars += text[..take].chars().count();
            text = &text[take..];
        }
        self.tail.push_str(text);
        self.tail_chars += text.chars().count();
        // Trim only once the tail is twice as long as kept, so trimming stays rare.
        if self.tail_chars > 2 * Self::HALF {
            let drop = self.tail_chars - Self::HALF;
            let at = self.tail.char_indices().nth(drop).map_or(self.tail.len(), |(i, _)| i);
            self.tail.drain(..at);
            self.tail_chars = Self::HALF;
            self.dropped += drop;
        }
    }

    fn finish(self) -> String {
        if self.dropped == 0 {
            return self.head + &self.tail;
        }
        format!("{}\n\n[{} characters cut]\n\n{}", self.head, self.dropped, self.tail)
    }
}

/// Shell output reaches the interface at most this often, in batches.
const SHELL_BATCH: Duration = Duration::from_millis(50);

/// Variables for what Blixel itself holds, which commands do not inherit:
/// Anthropic credentials, and the session bus, the way to the keychain where
/// Blixel keeps API keys and connector secrets. A speed bump, not a
/// guarantee: a command runs as the user and can still find the bus at its
/// usual path, or reach the keychain some other way. Keeping secrets from an
/// agent with Run needs a sandbox for its commands (future work).
const HELD_VARS: [&str; 4] = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "DBUS_SESSION_BUS_ADDRESS"];

/// `bash -c command` in `cwd`, with no input and in a process group of its own.
fn command_for(cwd: &Path, command: &str) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("bash");
    cmd.arg("-c").arg(command).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    for name in HELD_VARS {
        cmd.env_remove(name);
    }
    #[cfg(unix)]
    cmd.process_group(0);
    cmd
}

/// A command's process group, killed when this is dropped unless disarmed:
/// should the call be dropped mid-command, nothing it started keeps running
/// (`kill_on_drop` alone stops only bash).
struct Group(Option<u32>);

impl Group {
    /// After the command was waited for: its id may be given to a new process.
    fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for Group {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.0 {
            // Not yet waited for, so the group id is still the command's.
            unsafe { libc::killpg(pid as libc::pid_t, libc::SIGKILL) };
        }
    }
}

/// Resolves once any of the tokens is cancelled (never, for none).
async fn any_cancelled(tokens: &[CancellationToken]) {
    let mut waits: Vec<_> = tokens.iter().map(|t| Box::pin(t.cancelled())).collect();
    std::future::poll_fn(|cx| {
        if waits.iter_mut().any(|w| std::future::Future::poll(w.as_mut(), cx).is_ready()) {
            Poll::Ready(())
        } else {
            Poll::Pending
        }
    })
    .await
}

/// Runs `bash -c command` in `cwd` with no input, streaming output to
/// `on_output` in batches, until it ends, times out or any `stop` token is
/// cancelled. Timing out or stopping kills its whole process group.
async fn run_command(
    cwd: &Path,
    command: &str,
    timeout: Duration,
    stop: &[CancellationToken],
    mut on_output: impl FnMut(&str),
) -> std::io::Result<Ran> {
    let mut child = command_for(cwd, command).spawn()?;
    let mut group = Group(child.id());
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let (mut out_buf, mut err_buf) = ([0u8; 4096], [0u8; 4096]);
    let (mut out_open, mut err_open) = (true, true);
    let mut kept = Kept::default();
    let mut batch = String::new();
    let mut flush = tokio::time::interval(SHELL_BATCH);
    flush.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    let stopping = any_cancelled(stop);
    tokio::pin!(stopping);
    let (mut timed_out, mut stopped) = (false, false);

    while out_open || err_open {
        let read = tokio::select! {
            n = stdout.read(&mut out_buf), if out_open => match n {
                Ok(0) | Err(_) => { out_open = false; None }
                Ok(n) => Some(String::from_utf8_lossy(&out_buf[..n]).into_owned()),
            },
            n = stderr.read(&mut err_buf), if err_open => match n {
                Ok(0) | Err(_) => { err_open = false; None }
                Ok(n) => Some(String::from_utf8_lossy(&err_buf[..n]).into_owned()),
            },
            _ = flush.tick(), if !batch.is_empty() => {
                on_output(&batch);
                batch.clear();
                None
            }
            _ = &mut deadline => { timed_out = true; break; }
            _ = &mut stopping => { stopped = true; break; }
        };
        if let Some(text) = read {
            kept.push(&text);
            batch.push_str(&text);
        }
    }
    if !batch.is_empty() {
        on_output(&batch);
    }
    if timed_out || stopped {
        kill_group(&mut child).await;
        on_output(if stopped { "\n[stopped]\n" } else { "\n[timed out]\n" });
    }
    // Its output closed, but it may still run: wait a little, unless it is stopped meanwhile.
    let status = tokio::select! {
        s = tokio::time::timeout(Duration::from_secs(5), child.wait()) => s.ok().and_then(Result::ok),
        _ = &mut stopping, if !stopped => {
            stopped = true;
            on_output("\n[stopped]\n");
            None
        }
    };
    let code = match status {
        Some(s) => s.code(),
        None => {
            kill_group(&mut child).await;
            None
        }
    };
    group.disarm();
    Ok(Ran { output: kept.finish(), code, timed_out, stopped })
}

async fn kill_group(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // The command runs in its own process group, so this also stops anything it started.
        unsafe { libc::killpg(pid as libc::pid_t, libc::SIGKILL) };
    }
    let _ = child.kill().await;
}

/// Terminal output needs CR LF line ends.
fn to_terminal(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\n', "\r\n")
}

/// Removes terminal colour and cursor codes from text for the model.
pub fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            if c != '\r' {
                out.push(c);
            }
            continue;
        }
        match chars.peek() {
            Some('[') => {
                chars.next();
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            Some(']') => {
                chars.next();
                while let Some(c) = chars.next() {
                    if c == '\x07' || (c == '\x1b' && chars.peek() == Some(&'\\')) {
                        if c == '\x1b' {
                            chars.next();
                        }
                        break;
                    }
                }
            }
            _ => {
                chars.next();
            }
        }
    }
    out
}

/// Keeps the start and end of long output.
fn clip(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= MAX_OUTPUT_CHARS {
        return text.to_string();
    }
    let half = MAX_OUTPUT_CHARS / 2;
    let head: String = chars[..half].iter().collect();
    let tail: String = chars[chars.len() - half..].iter().collect();
    format!("{head}\n\n[{} characters cut]\n\n{tail}", chars.len() - MAX_OUTPUT_CHARS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_need_the_right_settings() {
        assert_eq!(command_tools("npm test"), vec![Tool::Run]);
        assert_eq!(command_tools("git status && git diff"), vec![Tool::Run]);
        assert_eq!(command_tools("git add -A && git commit -m 'x'"), vec![Tool::Run, Tool::Commit]);
        assert_eq!(command_tools("git -C repo push origin main"), vec![Tool::Run, Tool::Push]);
        assert_eq!(command_tools("git commit -m x; git push"), vec![Tool::Run, Tool::Commit, Tool::Push]);
        assert_eq!(command_tools("gh pr create --fill"), vec![Tool::Run, Tool::Push]);
    }

    #[test]
    fn ansi_codes_are_removed() {
        assert_eq!(strip_ansi("\x1b[41;30;1m FAIL \x1b[0m ok\r\n"), " FAIL  ok\n");
        assert_eq!(strip_ansi("\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\"), "link");
    }

    #[test]
    fn long_output_keeps_head_and_tail() {
        let long = "a".repeat(MAX_OUTPUT_CHARS) + &"b".repeat(100);
        let clipped = clip(&long);
        assert!(clipped.starts_with('a') && clipped.ends_with('b') && clipped.contains("characters cut"));
    }

    /// The whole path an agent's call takes: HTTP, token, MCP, settings, area, disk.
    #[tokio::test]
    async fn the_tool_server_enforces_settings_over_http() {
        use crate::agents::permissions::Broker;
        use crate::agents::settings::{AgentConfig, Permissions, RulePack};
        use crate::events::Events;
        use rmcp::model::CallToolRequestParams;
        use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
        use rmcp::transport::StreamableHttpClientTransport;
        use rmcp::ServiceExt;
        use std::sync::Mutex;

        let dir = std::env::temp_dir().join(format!("blixel-tools-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("docs/locked")).unwrap();
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("docs/a.md"), "hello\n").unwrap();
        std::fs::write(dir.join("docs/locked/c.md"), "keep\n").unwrap();
        std::fs::write(dir.join("src/b.ts"), "x\n").unwrap();
        let root = dir.canonicalize().unwrap();

        let seen: Arc<Mutex<Vec<String>>> = Arc::default();
        let events = Events::to_sink({
            let seen = seen.clone();
            move |name, payload| seen.lock().unwrap().push(format!("{name} {payload}"))
        });
        let config = AgentConfig {
            id: "t".into(),
            name: "Tester".into(),
            instructions: String::new(),
            read_notes: false,
            permissions: Permissions {
                read: Setting::Allow,
                edit: Setting::Allow,
                run: Setting::Allow,
                commit: Setting::Off,
                push: Setting::Off,
            },
            edit_paths: "docs/**".into(),
            rule_packs: vec![RulePack { label: "Locked docs".into(), edit_area: "!docs/locked/**".into(), ..Default::default() }],
            connectors: Default::default(),
            model: "test".into(),
            effort: "medium".into(),
            program: String::new(),
            daily_limit: String::new(),
        };
        let rt = AgentRuntime::new(config, events, Arc::new(Broker::default()));
        let cancel = CancellationToken::new();
        let addr = serve(BlixelTools::new(rt, root.clone()), axum::Router::new(), "secret".into(), cancel.clone()).await.unwrap();
        let url = format!("http://{addr}/mcp");

        let wrong = StreamableHttpClientTransport::from_config(
            StreamableHttpClientTransportConfig::with_uri(url.clone()).auth_header("wrong"),
        );
        assert!(().serve(wrong).await.is_err(), "a wrong token is refused");

        let client = ().serve(StreamableHttpClientTransport::from_config(
            StreamableHttpClientTransportConfig::with_uri(url).auth_header("secret"),
        ))
        .await
        .unwrap();
        let names: Vec<String> = client.list_all_tools().await.unwrap().into_iter().map(|t| t.name.to_string()).collect();
        assert!(TOOL_NAMES.iter().all(|t| names.contains(&t.to_string())), "{names:?}");

        let call = |name: &'static str, args: serde_json::Value| {
            CallToolRequestParams::new(name).with_arguments(args.as_object().unwrap().clone())
        };
        let ok = |r: &CallToolResult| r.is_error != Some(true);

        let r = client
            .call_tool(call("edit", serde_json::json!({ "file_path": root.join("docs/a.md"), "old_string": "hello", "new_string": "hi" })))
            .await
            .unwrap();
        assert!(ok(&r), "{r:?}");
        assert_eq!(std::fs::read_to_string(root.join("docs/a.md")).unwrap(), "hi\n");

        let r = client
            .call_tool(call("edit", serde_json::json!({ "file_path": root.join("src/b.ts"), "old_string": "x", "new_string": "y" })))
            .await
            .unwrap();
        assert!(!ok(&r), "outside the area is refused");
        assert_eq!(std::fs::read_to_string(root.join("src/b.ts")).unwrap(), "x\n");

        let r = client
            .call_tool(call("write", serde_json::json!({ "file_path": root.join("docs/locked/c.md"), "content": "changed" })))
            .await
            .unwrap();
        assert!(!ok(&r) && format!("{r:?}").contains("Locked docs"), "outside a rule pack's area is refused: {r:?}");
        assert_eq!(std::fs::read_to_string(root.join("docs/locked/c.md")).unwrap(), "keep\n");

        let r = client
            .call_tool(call("write", serde_json::json!({ "file_path": "/tmp/blixel-escape.txt", "content": "no" })))
            .await
            .unwrap();
        assert!(!ok(&r), "outside the project is refused");

        let r = client
            .call_tool(call("bash", serde_json::json!({ "command": "git commit -m nope" })))
            .await
            .unwrap();
        assert!(!ok(&r), "commit is Off");

        let r = client.call_tool(call("bash", serde_json::json!({ "command": "echo from-blixel" }))).await.unwrap();
        assert!(ok(&r) && format!("{r:?}").contains("from-blixel"), "{r:?}");

        let log = seen.lock().unwrap().join("\n");
        assert!(log.contains("agent://edit") && log.contains("docs/a.md"));
        assert!(log.contains("outside its area"));
        assert!(log.contains("agent://shell") && log.contains("from-blixel"));
        cancel.cancel();
    }

    /// A protected path adds a question; with Edit off it is refused, not asked.
    #[tokio::test]
    async fn protection_never_turns_off_into_ask() {
        use crate::agents::permissions::Broker;
        use crate::agents::settings::{AgentConfig, Permissions, RulePack};
        use crate::events::Events;

        let dir = std::env::temp_dir().join(format!("blixel-protect-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("db")).unwrap();
        let root = dir.canonicalize().unwrap();
        let config = AgentConfig {
            id: "t".into(),
            name: "Tester".into(),
            instructions: String::new(),
            read_notes: false,
            permissions: Permissions {
                read: Setting::Allow,
                edit: Setting::Off,
                run: Setting::Off,
                commit: Setting::Off,
                push: Setting::Off,
            },
            edit_paths: String::new(),
            rule_packs: vec![RulePack { label: "Schema".into(), protect: vec!["db/".into()], ..Default::default() }],
            connectors: Default::default(),
            model: "test".into(),
            effort: "medium".into(),
            program: String::new(),
            daily_limit: String::new(),
        };
        let rt = AgentRuntime::new(config, Events::to_sink(|_, _| {}), Arc::new(Broker::default()));
        let tools = BlixelTools::new(rt.clone(), root);
        for path in ["db/schema.sql", "CLAUDE.md", "src/a.ts"] {
            // Asking would wait for an answer that never comes.
            let outcome = tokio::time::timeout(Duration::from_secs(2), tools.allow_edit(path)).await;
            let refused = outcome.expect("refused at once, not asked");
            assert!(refused.unwrap_err().contains("not allowed"), "{path}");
        }
        assert_eq!(rt.broker.waiting_for("t"), 0);
    }

    #[tokio::test]
    async fn commands_run_without_input_and_time_out() {
        let dir = std::env::temp_dir();
        let ran = run_command(&dir, "echo hi; echo err >&2; exit 3", Duration::from_secs(5), &[], |_| {}).await.unwrap();
        assert!(ran.output.contains("hi") && ran.output.contains("err"));
        assert_eq!(ran.code, Some(3));
        let read = run_command(&dir, "read x; echo got:$x", Duration::from_secs(5), &[], |_| {}).await.unwrap();
        assert!(read.output.contains("got:"), "stdin is empty, so read returns at once");
        let slow = run_command(&dir, "sleep 30", Duration::from_millis(300), &[], |_| {}).await.unwrap();
        assert!(slow.timed_out);
    }

    /// Whether a process has ended (gone, or only waiting to be reaped).
    #[cfg(target_os = "linux")]
    fn ended(pid: &str) -> bool {
        match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Err(_) => true,
            Ok(stat) => stat.rsplit_once(") ").is_some_and(|(_, rest)| rest.starts_with('Z')),
        }
    }

    /// Waits for a command to write the id of a process it started.
    async fn started(pidfile: &Path) -> String {
        for _ in 0..100 {
            if let Ok(pid) = std::fs::read_to_string(pidfile) {
                if !pid.trim().is_empty() {
                    return pid.trim().to_string();
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("the command never started its child");
    }

    #[cfg(target_os = "linux")]
    async fn assert_ended(pid: &str) {
        for _ in 0..40 {
            if ended(pid) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("process {pid}, started by the command, still runs");
    }

    /// A command started in the background plus one in the foreground, both long.
    fn sleeper(pidfile: &Path) -> String {
        format!("sleep 300 & echo $! > '{}'; sleep 300", pidfile.display())
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_stopped_command_is_killed_with_what_it_started() {
        let dir = std::env::temp_dir().join(format!("blixel-stop-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let pidfile = dir.join("child.pid");
        let stop = CancellationToken::new();
        let shown = Arc::new(std::sync::Mutex::new(String::new()));
        let run = tokio::spawn({
            let (dir, command, stop, shown) = (dir.clone(), sleeper(&pidfile), stop.clone(), shown.clone());
            async move {
                run_command(&dir, &command, Duration::from_secs(60), &[CancellationToken::new(), stop], |s| {
                    shown.lock().unwrap().push_str(s)
                })
                .await
            }
        });
        let pid = started(&pidfile).await;
        stop.cancel();
        let ran = tokio::time::timeout(Duration::from_secs(5), run).await.expect("stops at once").unwrap().unwrap();
        assert!(ran.stopped && !ran.timed_out);
        assert!(shown.lock().unwrap().contains("[stopped]"), "the shell says so");
        assert_ended(&pid).await;

        // Already stopped: it is killed as soon as it starts.
        let ran = run_command(&dir, "sleep 300", Duration::from_secs(60), &[stop], |_| {}).await.unwrap();
        assert!(ran.stopped);
    }

    /// Each way a call can be stopped reaches the command: the agent's program
    /// cancelling it (over MCP), the user's Stop, and the tool server stopping.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn every_stop_reaches_a_running_command() {
        use crate::agents::permissions::Broker;
        use crate::agents::settings::{AgentConfig, Permissions};
        use crate::events::Events;
        use rmcp::model::{CallToolRequest, CallToolRequestParams, ClientRequest};
        use rmcp::service::PeerRequestOptions;
        use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
        use rmcp::transport::StreamableHttpClientTransport;
        use rmcp::ServiceExt;

        let dir = std::env::temp_dir().join(format!("blixel-stops-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.canonicalize().unwrap();
        let seen: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
        let events = Events::to_sink({
            let seen = seen.clone();
            move |name, payload| seen.lock().unwrap().push(format!("{name} {payload}"))
        });
        let config = AgentConfig {
            id: "t".into(),
            name: "Tester".into(),
            instructions: String::new(),
            read_notes: false,
            permissions: Permissions {
                read: Setting::Allow,
                edit: Setting::Allow,
                run: Setting::Allow,
                commit: Setting::Off,
                push: Setting::Off,
            },
            edit_paths: String::new(),
            rule_packs: vec![],
            connectors: Default::default(),
            model: "test".into(),
            effort: "medium".into(),
            program: String::new(),
            daily_limit: String::new(),
        };
        let rt = AgentRuntime::new(config, events, Arc::new(Broker::default()));
        let args = |pidfile: &Path| BashArgs { command: sleeper(pidfile), timeout: None, description: None, run_in_background: false };
        let text = |r: &CallToolResult| format!("{:?}", r.content);

        // The user's Stop, through the agent's runtime.
        let server = CancellationToken::new();
        let tools = BlixelTools { stop: server.clone(), ..BlixelTools::new(rt.clone(), root.clone()) };
        let pidfile = root.join("stop.pid");
        let call = tokio::spawn({
            let (tools, a) = (tools.clone(), args(&pidfile));
            async move { tools.bash(Parameters(a), CancellationToken::new()).await.unwrap() }
        });
        let pid = started(&pidfile).await;
        rt.stop_commands();
        let r = tokio::time::timeout(Duration::from_secs(5), call).await.expect("stops at once").unwrap();
        assert!(r.is_error == Some(true) && text(&r).contains("Stopped."), "{r:?}");
        assert_ended(&pid).await;

        // A later command runs normally.
        let after = BashArgs { command: "echo after".into(), timeout: None, description: None, run_in_background: false };
        let r = tools.bash(Parameters(after), CancellationToken::new()).await.unwrap();
        assert!(r.is_error != Some(true) && text(&r).contains("after"), "{r:?}");

        // The session ending stops the tool server.
        let pidfile = root.join("server.pid");
        let call = tokio::spawn({
            let (tools, a) = (tools.clone(), args(&pidfile));
            async move { tools.bash(Parameters(a), CancellationToken::new()).await.unwrap() }
        });
        let pid = started(&pidfile).await;
        server.cancel();
        let r = tokio::time::timeout(Duration::from_secs(5), call).await.expect("stops at once").unwrap();
        assert!(text(&r).contains("Stopped."), "{r:?}");
        assert_ended(&pid).await;

        // The agent's program cancels the call over MCP: rmcp hands the tool that cancel.
        let cancel = CancellationToken::new();
        let addr = serve(BlixelTools::new(rt.clone(), root.clone()), axum::Router::new(), "secret".into(), cancel.clone()).await.unwrap();
        let client = ().serve(StreamableHttpClientTransport::from_config(
            StreamableHttpClientTransportConfig::with_uri(format!("http://{addr}/mcp")).auth_header("secret"),
        ))
        .await
        .unwrap();
        let pidfile = root.join("mcp.pid");
        let params = CallToolRequestParams::new("bash")
            .with_arguments(serde_json::json!({ "command": sleeper(&pidfile) }).as_object().unwrap().clone());
        let handle = client
            .peer()
            .send_cancellable_request(ClientRequest::CallToolRequest(CallToolRequest::new(params)), PeerRequestOptions::no_options())
            .await
            .unwrap();
        let pid = started(&pidfile).await;
        handle.cancel(Some("the user pressed Stop".into())).await.unwrap();
        assert_ended(&pid).await;
        cancel.cancel();

        let log = seen.lock().unwrap().join("\n");
        assert!(log.contains("\"result\":\"stopped\""), "{log}");
        assert!(log.contains("[stopped]"), "{log}");
    }

    #[test]
    fn commands_do_not_inherit_what_blixel_holds() {
        let cmd = command_for(&std::env::temp_dir(), "env");
        let removed: Vec<String> = cmd
            .as_std()
            .get_envs()
            .filter(|(_, value)| value.is_none())
            .map(|(name, _)| name.to_string_lossy().into_owned())
            .collect();
        for name in ["DBUS_SESSION_BUS_ADDRESS", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] {
            assert!(removed.iter().any(|r| r == name), "{name} is passed on: {removed:?}");
        }
        assert!(!removed.iter().any(|r| r == "PATH" || r == "HOME" || r == "SSH_AUTH_SOCK"), "the user's own environment stays");
    }

    #[tokio::test]
    async fn long_output_is_kept_bounded() {
        let dir = std::env::temp_dir();
        let mut shown = 0;
        let ran = run_command(&dir, "head -c 3000000 /dev/zero | tr '\\0' x; echo; echo end", Duration::from_secs(20), &[], |s| {
            shown += s.len()
        })
        .await
        .unwrap();
        assert!(shown > 3_000_000, "the shell still sees everything");
        assert!(ran.output.chars().count() < 2 * MAX_OUTPUT_CHARS);
        assert!(ran.output.starts_with('x') && ran.output.trim_end().ends_with("end") && ran.output.contains("characters cut"));
    }
}
