//! Blixel's own file and command tools, served to one agent over local HTTP.
//! The agent's built-in edit and shell tools are switched off, so every edit
//! and command passes through here: checked against the agent's settings and
//! area, logged, shown in the editor and shell, and only then done.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::Request;
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
        Self { rt, root, tool_router: Self::tool_router() }
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
    async fn bash(&self, Parameters(a): Parameters<BashArgs>) -> Result<CallToolResult, ErrorData> {
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
        let timeout = a.timeout.unwrap_or(DEFAULT_TIMEOUT_MS).min(MAX_TIMEOUT_MS);
        let entry = self.log("RUN", &a.command, "running", true, false);
        let shown = a.description.as_deref().map(|d| format!("{} ({d})", a.command)).unwrap_or_else(|| a.command.clone());
        self.rt.events.shell(&self.rt.id, Some(&a.command), &format!("\x1b[90m$ {shown}\x1b[0m\r\n"));

        let outcome = run_command(&self.root, &a.command, Duration::from_millis(timeout), |chunk| {
            self.rt.events.shell(&self.rt.id, None, &to_terminal(chunk));
        })
        .await;

        let (result, text) = match outcome {
            Ok(Ran { output, code: Some(0), .. }) => ("exit 0".to_string(), clip(&strip_ansi(&output))),
            Ok(Ran { output, code, timed_out }) => {
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
        self.rt.events.activity(Activity { agent_id: &self.rt.id, entry_id: &entry_id, verb, target, result, live, refused });
        entry_id
    }

    fn update_log(&self, entry_id: &str, verb: &str, target: &str, result: &str, live: bool) {
        self.rt.events.activity(Activity { agent_id: &self.rt.id, entry_id, verb, target, result, live, refused: false });
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

/// Serves the tools on 127.0.0.1 at a free port. Requests must carry `Bearer <token>`.
pub async fn serve(tools: BlixelTools, token: String, cancel: CancellationToken) -> std::io::Result<SocketAddr> {
    let service = StreamableHttpService::new(
        move || Ok(tools.clone()),
        Arc::new(LocalSessionManager::default()),
        StreamableHttpServerConfig::default().with_cancellation_token(cancel.child_token()),
    );
    let expected = Arc::new(format!("Bearer {token}"));
    let router = axum::Router::new().nest_service("/mcp", service).layer(axum::middleware::from_fn(
        move |req: Request, next: Next| {
            let expected = expected.clone();
            async move {
                let given = req.headers().get(AUTHORIZATION).and_then(|v| v.to_str().ok());
                if given == Some(expected.as_str()) {
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
        if let Err(e) = axum::serve(listener, router).with_graceful_shutdown(shutdown).await {
            eprintln!("blixel: tool server stopped: {e}");
        }
    });
    Ok(addr)
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

/// Runs `bash -c command` in `cwd` with no input, streaming output to `on_output` in batches.
async fn run_command(cwd: &Path, command: &str, timeout: Duration, mut on_output: impl FnMut(&str)) -> std::io::Result<Ran> {
    let mut cmd = tokio::process::Command::new("bash");
    cmd.arg("-c")
        .arg(command)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_remove("ANTHROPIC_API_KEY")
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd.spawn()?;
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
    let mut timed_out = false;

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
        };
        if let Some(text) = read {
            kept.push(&text);
            batch.push_str(&text);
        }
    }
    if !batch.is_empty() {
        on_output(&batch);
    }
    if timed_out {
        kill_group(&mut child).await;
        on_output("\n[timed out]\n");
    }
    let status = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
    let code = match status {
        Ok(Ok(s)) => s.code(),
        _ => {
            kill_group(&mut child).await;
            None
        }
    };
    Ok(Ran { output: kept.finish(), code, timed_out })
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
            model: "test".into(),
            effort: "medium".into(),
        };
        let rt = AgentRuntime::new(config, events, Arc::new(Broker::default()));
        let cancel = CancellationToken::new();
        let addr = serve(BlixelTools::new(rt, root.clone()), "secret".into(), cancel.clone()).await.unwrap();
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
            model: "test".into(),
            effort: "medium".into(),
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
        let ran = run_command(&dir, "echo hi; echo err >&2; exit 3", Duration::from_secs(5), |_| {}).await.unwrap();
        assert!(ran.output.contains("hi") && ran.output.contains("err"));
        assert_eq!(ran.code, Some(3));
        let read = run_command(&dir, "read x; echo got:$x", Duration::from_secs(5), |_| {}).await.unwrap();
        assert!(read.output.contains("got:"), "stdin is empty, so read returns at once");
        let slow = run_command(&dir, "sleep 30", Duration::from_millis(300), |_| {}).await.unwrap();
        assert!(slow.timed_out);
    }

    #[tokio::test]
    async fn long_output_is_kept_bounded() {
        let dir = std::env::temp_dir();
        let mut shown = 0;
        let ran = run_command(&dir, "head -c 3000000 /dev/zero | tr '\\0' x; echo; echo end", Duration::from_secs(20), |s| {
            shown += s.len()
        })
        .await
        .unwrap();
        assert!(shown > 3_000_000, "the shell still sees everything");
        assert!(ran.output.chars().count() < 2 * MAX_OUTPUT_CHARS);
        assert!(ran.output.starts_with('x') && ran.output.trim_end().ends_with("end") && ran.output.contains("characters cut"));
    }
}
