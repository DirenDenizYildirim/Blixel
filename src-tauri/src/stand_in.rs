//! The stand-in: a small agent program that speaks ACP over stdio like
//! Claude Code's adapter, but follows the instructions in each message
//! instead of a model, so the whole real-agent path (the protocol, the
//! workspace's tool server, the connector gateway, permission requests,
//! Stop, spending) can be tested without an API key. It is this app's own
//! binary started with `STAND_IN_FLAG`, and exists in debug builds only.
//!
//! Like Claude Code with its built-in edit and shell tools off, it changes
//! files and runs commands only through the MCP tools its session names for
//! Edit, Write and Bash (`toolAliases`), reached over streamable HTTP with
//! the Authorization header it was given. It reads files itself, asking
//! first for files outside its folder as Claude Code does, and keeps a small
//! transcript per session in its config folder (CLAUDE_CONFIG_DIR), so a
//! resumed session remembers.
//!
//! A message holds one instruction per line; a leading "(Chat message, not a
//! task.)" is ignored:
//!
//! - `say <text>`: streams a message.
//! - `read <path>`: reads a file, reported like Claude Code's Read.
//! - `edit <path>`, then the lines `<<<`, the old text, `===`, the new text, `>>>`.
//! - `write <path>`, then the lines `<<<`, the content, `>>>` (it gets a final line break).
//! - `run <command>`: runs it with the workspace's shell tool.
//! - `call <server> <tool> <json>`: calls a connector's tool.
//! - `ask <title>`: asks the user's permission for a made-up tool.
//! - `cost <usd>`: reports this as the session's cost so far, as Claude Code
//!   does after each turn.
//! - `sleep <ms>`: waits ("2s" and "500ms" work too); Stop ends it.
//! - `settings`: says the model and effort it runs on.
//! - `fail <text>`: ends the turn with an error.
//!
//! Lines it does not know are echoed back. A message with no instruction at
//! all gets "Stand-in got your message: …" and adds $0.01 to the session's cost.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    AgentCapabilities, CancelNotification, ContentBlock, ContentChunk, Cost, Implementation, InitializeRequest,
    InitializeResponse, LoadSessionRequest, LoadSessionResponse, McpCapabilities, McpServer, Meta, NewSessionRequest,
    NewSessionResponse, PermissionOption, PermissionOptionKind, PromptRequest, PromptResponse, RequestPermissionOutcome,
    RequestPermissionRequest, ResumeSessionRequest, ResumeSessionResponse, SessionCapabilities, SessionConfigOption,
    SessionConfigOptionCategory, SessionConfigOptionValue, SessionConfigSelectOption, SessionId, SessionNotification,
    SessionResumeCapabilities, SessionUpdate, SetSessionConfigOptionRequest, SetSessionConfigOptionResponse, StopReason,
    TextContent, ToolCall, ToolCallId, ToolCallLocation, ToolCallStatus, ToolCallUpdate, ToolCallUpdateFields, ToolKind,
    UsageUpdate,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{Agent, Client, ConnectionTo, Error, Responder, Stdio};
use rmcp::model::{CallToolRequest, CallToolRequestParams, CallToolResult, CancelledNotificationParam, ClientRequest, ServerResult};
use rmcp::service::{PeerRequestOptions, RunningService};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::{Peer, RoleClient, ServiceExt};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

/// What the interface puts before a chat message (as opposed to a task).
const CHAT_PREFIX: &str = "(Chat message, not a task.)";
/// The models it pretends to offer, as (id, name); the first is the default.
const MODELS: [(&str, &str); 2] = [("stand-in", "Stand-in"), ("stand-in-2", "Stand-in 2")];
const EFFORTS: [&str; 3] = ["low", "medium", "high"];
/// What a message without instructions adds to the session's cost, in US dollars.
const CHAT_COST: f64 = 0.01;
/// Transcript entries are cut to this many characters.
const MAX_REMEMBERED_CHARS: usize = 2000;

/// Runs the stand-in on this process's standard input and output until the
/// app closes them. Returns the exit code.
pub fn main() -> i32 {
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(e) => {
            eprintln!("stand-in: {e}");
            return 1;
        }
    };
    match runtime.block_on(serve()) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("stand-in: {e}");
            1
        }
    }
}

async fn serve() -> Result<(), Error> {
    let dir = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join("stand-in");
    let me = Arc::new(StandIn { dir, sessions: Mutex::default(), next: AtomicU64::new(1) });
    Agent
        .builder()
        .name("stand-in")
        .on_receive_request(
            async |request: InitializeRequest, responder: Responder<InitializeResponse>, _cx| responder.respond(initialize(&request)),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let me = me.clone();
                async move |request: NewSessionRequest, responder: Responder<NewSessionResponse>, _cx| {
                    let (id, options) = me.open(None, request.cwd, &request.mcp_servers, request.meta.as_ref())?;
                    responder.respond(NewSessionResponse::new(id).config_options(options))
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let me = me.clone();
                async move |request: ResumeSessionRequest, responder: Responder<ResumeSessionResponse>, _cx| {
                    let opened = me.open(Some(request.session_id), request.cwd, &request.mcp_servers, request.meta.as_ref());
                    responder.respond_with_result(opened.map(|(_, options)| ResumeSessionResponse::new().config_options(options)))
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let me = me.clone();
                // Advertised like the adapter does; it carries on like a resume, without replaying anything.
                async move |request: LoadSessionRequest, responder: Responder<LoadSessionResponse>, _cx| {
                    let opened = me.open(Some(request.session_id), request.cwd, &request.mcp_servers, request.meta.as_ref());
                    responder.respond_with_result(opened.map(|(_, options)| LoadSessionResponse::new().config_options(options)))
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let me = me.clone();
                async move |request: SetSessionConfigOptionRequest, responder: Responder<SetSessionConfigOptionResponse>, _cx| {
                    responder.respond_with_result(me.set_option(&request))
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let me = me.clone();
                async move |request: PromptRequest, responder: Responder<PromptResponse>, cx: ConnectionTo<Client>| {
                    // The turn's stop is set before anything else is read, so a
                    // cancel right behind this prompt reaches it.
                    let Some((session, stop)) = me.begin(&request.session_id) else {
                        return responder.respond_with_error(Error::invalid_params().data("This stand-in has no such session."));
                    };
                    let me = me.clone();
                    let turn_cx = cx.clone();
                    cx.spawn(async move {
                        me.prompt(&turn_cx, session, stop, &request, responder).await;
                        Ok(())
                    })
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_notification(
            {
                let me = me.clone();
                async move |cancel: CancelNotification, _cx| {
                    if let Some(session) = me.session(&cancel.session_id) {
                        session.state.lock().expect("session lock").turn.cancel();
                    }
                    Ok(())
                }
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .connect_to(Stdio::new())
        .await
}

/// Capabilities as the adapter advertises them: sessions can be loaded and
/// resumed, and MCP servers are reached over HTTP.
fn initialize(_request: &InitializeRequest) -> InitializeResponse {
    let capabilities = AgentCapabilities::new()
        .load_session(true)
        .session_capabilities(SessionCapabilities::new().resume(SessionResumeCapabilities::new()))
        .mcp_capabilities(McpCapabilities::new().http(true));
    InitializeResponse::new(ProtocolVersion::V1)
        .agent_capabilities(capabilities)
        .agent_info(Implementation::new("stand-in", env!("CARGO_PKG_VERSION")))
}

struct StandIn {
    /// Where session transcripts are kept.
    dir: PathBuf,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    /// Numbers sessions and tool calls.
    next: AtomicU64,
}

/// An MCP server the session was given.
struct Server {
    url: String,
    /// From its `Authorization: Bearer <token>` header.
    token: Option<String>,
}

struct Session {
    id: SessionId,
    cwd: PathBuf,
    servers: HashMap<String, Server>,
    /// What stands for Claude Code's own Bash, Edit and Write: (server, tool).
    aliases: HashMap<String, (String, String)>,
    /// Connected on first use, then kept for the session.
    clients: tokio::sync::Mutex<HashMap<String, RunningService<RoleClient, ()>>>,
    transcript: PathBuf,
    state: Mutex<State>,
}

struct State {
    model: String,
    effort: String,
    /// The session's cost so far, reported as Claude Code reports it.
    cost: f64,
    /// Earlier messages of a resumed session, said once at its next turn.
    remembered: Option<usize>,
    /// Cancelled by session/cancel.
    turn: CancellationToken,
}

impl StandIn {
    fn session(&self, id: &SessionId) -> Option<Arc<Session>> {
        self.sessions.lock().expect("sessions lock").get(&*id.0).cloned()
    }

    /// Opens a new session (`resume` None) or carries on one from its
    /// transcript. A carried-on session counts its cost from zero, like a
    /// rebuilt Claude Code session, and keeps its model and effort while this
    /// process runs.
    fn open(
        &self,
        resume: Option<SessionId>,
        cwd: PathBuf,
        servers: &[McpServer],
        meta: Option<&Meta>,
    ) -> Result<(SessionId, Vec<SessionConfigOption>), Error> {
        let (id, earlier) = match resume {
            Some(id) => {
                let path = transcript_path(&self.dir, &id.0).ok_or_else(|| Error::invalid_params().data("Not a stand-in session id."))?;
                let earlier = read_transcript(&path).ok_or_else(|| Error::resource_not_found(Some(id.0.to_string())))?;
                (id.0.to_string(), earlier.len())
            }
            None => {
                let millis = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
                (format!("stand-in-{millis:x}-{:x}", self.next.fetch_add(1, Ordering::Relaxed)), 0)
            }
        };
        let transcript = transcript_path(&self.dir, &id).ok_or_else(Error::internal_error)?;
        if earlier == 0 {
            write_transcript(&transcript, &[]).map_err(|e| Error::internal_error().data(e))?;
        }
        let (model, effort) = match self.sessions.lock().expect("sessions lock").get(&id) {
            Some(s) => {
                let state = s.state.lock().expect("session lock");
                (state.model.clone(), state.effort.clone())
            }
            None => (MODELS[0].0.to_string(), "medium".to_string()),
        };
        let options = options(&model, &effort);
        let session = Session {
            id: SessionId::new(id.clone()),
            cwd,
            servers: servers_of(servers),
            aliases: aliases_of(meta),
            clients: tokio::sync::Mutex::default(),
            transcript,
            state: Mutex::new(State {
                model,
                effort,
                cost: 0.0,
                remembered: (earlier > 0).then_some(earlier),
                turn: CancellationToken::new(),
            }),
        };
        self.sessions.lock().expect("sessions lock").insert(id.clone(), Arc::new(session));
        Ok((SessionId::new(id), options))
    }

    fn set_option(&self, request: &SetSessionConfigOptionRequest) -> Result<SetSessionConfigOptionResponse, Error> {
        let session = self.session(&request.session_id).ok_or_else(|| Error::invalid_params().data("This stand-in has no such session."))?;
        let SessionConfigOptionValue::ValueId { value } = &request.value else {
            return Err(Error::invalid_params().data("The stand-in's options take a value id."));
        };
        let value = value.0.to_string();
        {
            let mut state = session.state.lock().expect("session lock");
            match &*request.config_id.0 {
                "model" if MODELS.iter().any(|(id, _)| *id == value) => state.model = value,
                "effort" if EFFORTS.contains(&value.as_str()) => state.effort = value,
                id => return Err(Error::invalid_params().data(format!("The stand-in has no {id} {value}."))),
            }
        }
        Ok(SetSessionConfigOptionResponse::new(session.options()))
    }

    /// Starts a turn on a session: its earlier stop is replaced.
    fn begin(&self, id: &SessionId) -> Option<(Arc<Session>, CancellationToken)> {
        let session = self.session(id)?;
        let stop = CancellationToken::new();
        session.state.lock().expect("session lock").turn = stop.clone();
        Some((session, stop))
    }

    async fn prompt(
        &self,
        cx: &ConnectionTo<Client>,
        session: Arc<Session>,
        stop: CancellationToken,
        request: &PromptRequest,
        responder: Responder<PromptResponse>,
    ) {
        let text: Vec<&str> = request
            .prompt
            .iter()
            .filter_map(|block| match block {
                ContentBlock::Text(t) => Some(t.text.as_str()),
                _ => None,
            })
            .collect();
        let text = without_chat_prefix(&text.join("\n"));
        session.remember(&text);
        let mut turn = Turn { cx, session: &session, stop, next: &self.next, talking: false };
        let _ = match turn.run(&text).await {
            Ok(()) => responder.respond(PromptResponse::new(StopReason::EndTurn)),
            Err(Halt::Stopped) => responder.respond(PromptResponse::new(StopReason::Cancelled)),
            Err(Halt::Failed(reason)) => responder.respond_with_error(Error::new(-32603, reason)),
        };
    }
}

impl Session {
    fn options(&self) -> Vec<SessionConfigOption> {
        let state = self.state.lock().expect("session lock");
        options(&state.model, &state.effort)
    }

    /// Adds a message to the transcript.
    fn remember(&self, text: &str) {
        let mut messages = read_transcript(&self.transcript).unwrap_or_default();
        messages.push(text.chars().take(MAX_REMEMBERED_CHARS).collect());
        if let Err(e) = write_transcript(&self.transcript, &messages) {
            eprintln!("stand-in: {e}");
        }
    }

    /// A path as given, or relative to the session's folder.
    fn full_path(&self, path: &str) -> PathBuf {
        let path = Path::new(path);
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.cwd.join(path)
        }
    }

    /// The session's client for an MCP server it was given.
    async fn client(&self, name: &str) -> Result<Peer<RoleClient>, String> {
        let mut clients = self.clients.lock().await;
        if let Some(running) = clients.get(name).filter(|c| !c.is_closed()) {
            return Ok(running.peer().clone());
        }
        let server = self.servers.get(name).ok_or_else(|| format!("This session has no MCP server named {name}."))?;
        let mut config = StreamableHttpClientTransportConfig::with_uri(server.url.clone());
        if let Some(token) = &server.token {
            config = config.auth_header(token.clone());
        }
        let running = ().serve(StreamableHttpClientTransport::from_config(config)).await.map_err(|e| format!("Cannot reach {name}: {e}"))?;
        let peer = running.peer().clone();
        clients.insert(name.to_string(), running);
        Ok(peer)
    }

    /// Calls an MCP tool. Stop cancels the call on the server too, as Claude
    /// Code does when it is interrupted.
    async fn call(&self, server: &str, tool: &str, args: Value, stop: &CancellationToken) -> Result<CallToolResult, Halt> {
        let Value::Object(args) = args else { return Err(Halt::Failed("Tool arguments must be a JSON object.".into())) };
        let peer = self.client(server).await.map_err(Halt::Failed)?;
        let params = CallToolRequestParams::new(tool.to_string()).with_arguments(args);
        let request = ClientRequest::CallToolRequest(CallToolRequest::new(params));
        let handle = peer.send_cancellable_request(request, PeerRequestOptions::no_options()).await.map_err(|e| Halt::Failed(e.to_string()))?;
        let id = handle.id.clone();
        tokio::select! {
            response = handle.await_response() => match response {
                Ok(ServerResult::CallToolResult(result)) => Ok(result),
                Ok(_) => Err(Halt::Failed(format!("{server} gave an unexpected answer to {tool}."))),
                Err(e) => Err(Halt::Failed(e.to_string())),
            },
            _ = stop.cancelled() => {
                let _ = peer.notify_cancelled(CancelledNotificationParam::new(Some(id), Some("Stopped by the user".into()))).await;
                Err(Halt::Stopped)
            }
        }
    }
}

/// What ends a turn early.
#[derive(Debug)]
enum Halt {
    /// session/cancel.
    Stopped,
    /// `fail`, or the connection to the app broke.
    Failed(String),
}

struct Turn<'a> {
    cx: &'a ConnectionTo<Client>,
    session: &'a Session,
    stop: CancellationToken,
    next: &'a AtomicU64,
    /// A message is under way: more text starts a new paragraph of it.
    talking: bool,
}

impl Turn<'_> {
    async fn run(&mut self, text: &str) -> Result<(), Halt> {
        let remembered = self.session.state.lock().expect("session lock").remembered.take();
        if let Some(n) = remembered {
            self.say(&format!("I remember {n} earlier message{}.", if n == 1 { "" } else { "s" })).await?;
        }
        let steps = parse(text);
        if steps.iter().all(|s| matches!(s, Step::Unknown(_))) {
            self.say(&format!("Stand-in got your message: {}", text.trim())).await?;
            let cost = {
                let mut state = self.session.state.lock().expect("session lock");
                state.cost += CHAT_COST;
                state.cost
            };
            return self.report_cost(cost);
        }
        for step in steps {
            if self.stop.is_cancelled() {
                return Err(Halt::Stopped);
            }
            match step {
                Step::Say(text) => self.say(&text).await?,
                Step::Read(path) => self.read(&path).await?,
                Step::Edit { path, old, new } => {
                    let file = self.session.full_path(&path).display().to_string();
                    let args = json!({ "file_path": file, "old_string": old, "new_string": new });
                    self.builtin("Edit", args, &format!("Edit {path}"), ToolKind::Edit, false).await?;
                }
                Step::Write { path, content } => {
                    let file = self.session.full_path(&path).display().to_string();
                    self.builtin("Write", json!({ "file_path": file, "content": content }), &format!("Write {path}"), ToolKind::Edit, false)
                        .await?;
                }
                Step::Run(command) => self.builtin("Bash", json!({ "command": command }), &command, ToolKind::Execute, true).await?,
                Step::Call { server, tool, args } => self.tool(&server, &tool, args, &format!("{server}: {tool}"), ToolKind::Other, false).await?,
                Step::Ask(title) => {
                    let fields = ToolCallUpdateFields::new().title(title.clone()).kind(ToolKind::Other).name("StandInTool".to_string());
                    let allowed = self.permission(fields).await?;
                    self.say(&format!("{}: {title}", if allowed { "Allowed" } else { "Not allowed" })).await?;
                }
                Step::Cost(usd) => {
                    self.session.state.lock().expect("session lock").cost = usd;
                    self.report_cost(usd)?;
                }
                Step::Sleep(ms) => self.wait(Duration::from_millis(ms)).await?,
                Step::Settings => {
                    let said = {
                        let state = self.session.state.lock().expect("session lock");
                        format!("Model: {}. Effort: {}.", state.model, state.effort)
                    };
                    self.say(&said).await?;
                }
                Step::Fail(reason) => {
                    let reason = if reason.is_empty() { "The stand-in failed, as asked.".to_string() } else { reason };
                    return Err(Halt::Failed(reason));
                }
                Step::Unknown(line) => self.say(&format!("I don't know how to do “{line}”, so I skipped it.")).await?,
            }
        }
        Ok(())
    }

    fn update(&self, update: SessionUpdate) -> Result<(), Halt> {
        self.cx.send_notification(SessionNotification::new(self.session.id.clone(), update)).map_err(|e| Halt::Failed(e.to_string()))
    }

    /// Streams text as a message, in a few pieces as a model would.
    async fn say(&mut self, text: &str) -> Result<(), Halt> {
        let text = if self.talking { format!("\n\n{text}") } else { text.to_string() };
        self.talking = true;
        for piece in pieces(&text, (text.len() / 8).max(24)) {
            self.update(SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::Text(TextContent::new(piece)))))?;
            self.wait(Duration::from_millis(5)).await?;
        }
        Ok(())
    }

    async fn wait(&self, time: Duration) -> Result<(), Halt> {
        tokio::select! {
            _ = tokio::time::sleep(time) => Ok(()),
            _ = self.stop.cancelled() => Err(Halt::Stopped),
        }
    }

    fn report_cost(&self, total: f64) -> Result<(), Halt> {
        self.update(SessionUpdate::UsageUpdate(UsageUpdate::new(1_000, 200_000).cost(Cost::new(total, "USD"))))
    }

    fn start_call(&mut self, name: &str, title: &str, kind: ToolKind, place: Option<&Path>) -> Result<ToolCallId, Halt> {
        self.talking = false;
        let id = ToolCallId::new(format!("call-{}", self.next.fetch_add(1, Ordering::Relaxed)));
        let mut call = ToolCall::new(id.clone(), title).name(name.to_string()).kind(kind).status(ToolCallStatus::InProgress);
        if let Some(place) = place {
            call = call.locations(vec![ToolCallLocation::new(place)]);
        }
        self.update(SessionUpdate::ToolCall(call))?;
        Ok(id)
    }

    fn end_call(&self, id: ToolCallId, ok: bool) -> Result<(), Halt> {
        let status = if ok { ToolCallStatus::Completed } else { ToolCallStatus::Failed };
        self.update(SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(id, ToolCallUpdateFields::new().status(status))))
    }

    /// Claude Code's own Edit, Write or Bash: the tool its session routes it to.
    async fn builtin(&mut self, builtin: &str, args: Value, title: &str, kind: ToolKind, fenced: bool) -> Result<(), Halt> {
        let Some((server, tool)) = self.session.aliases.get(builtin).cloned() else {
            return self.say(&format!("This session gives me no tool for {builtin}.")).await;
        };
        self.tool(&server, &tool, args, title, kind, fenced).await
    }

    /// Calls an MCP tool, reported as a tool call, and says what it returned.
    async fn tool(&mut self, server: &str, tool: &str, args: Value, title: &str, kind: ToolKind, fenced: bool) -> Result<(), Halt> {
        let id = self.start_call(&format!("mcp__{server}__{tool}"), title, kind, None)?;
        match self.session.call(server, tool, args, &self.stop).await {
            Ok(result) => {
                let failed = result.is_error == Some(true);
                self.end_call(id, !failed)?;
                let text: Vec<&str> = result.content.iter().filter_map(|c| c.as_text().map(|t| t.text.as_str())).collect();
                let text = text.join("\n");
                self.say(&if fenced { format!("```\n{}\n```", text.trim_end()) } else { text }).await
            }
            Err(Halt::Stopped) => {
                self.end_call(id, false)?;
                Err(Halt::Stopped)
            }
            Err(Halt::Failed(reason)) => {
                self.end_call(id, false)?;
                self.say(&format!("{title} failed: {reason}")).await
            }
        }
    }

    /// Reads a file itself, like Claude Code's Read: one outside the
    /// session's folder needs the user's permission first.
    async fn read(&mut self, path: &str) -> Result<(), Halt> {
        let full = self.session.full_path(path);
        let title = format!("Read {path}");
        let id = self.start_call("Read", &title, ToolKind::Read, Some(&full))?;
        if !full.starts_with(&self.session.cwd) {
            let fields = ToolCallUpdateFields::new().title(title.clone()).kind(ToolKind::Read).name("Read".to_string()).locations(vec![
                ToolCallLocation::new(&full),
            ]);
            if !self.permission(fields).await? {
                self.end_call(id, false)?;
                return self.say(&format!("Not allowed to read {path}.")).await;
            }
        }
        let read = tokio::fs::read_to_string(&full).await;
        self.end_call(id, read.is_ok())?;
        match read {
            Ok(text) => {
                let lines = text.lines().count();
                self.say(&format!("{path} has {lines} line{}.", if lines == 1 { "" } else { "s" })).await
            }
            Err(e) => self.say(&format!("Cannot read {path}: {e}")).await,
        }
    }

    /// Asks the app (the user) whether a tool may run. True for yes.
    async fn permission(&mut self, fields: ToolCallUpdateFields) -> Result<bool, Halt> {
        let id = ToolCallId::new(format!("ask-{}", self.next.fetch_add(1, Ordering::Relaxed)));
        let options = vec![
            PermissionOption::new("allow", "Allow", PermissionOptionKind::AllowOnce),
            PermissionOption::new("always", "Always allow", PermissionOptionKind::AllowAlways),
            PermissionOption::new("reject", "Reject", PermissionOptionKind::RejectOnce),
        ];
        let request = RequestPermissionRequest::new(self.session.id.clone(), ToolCallUpdate::new(id, fields), options);
        let response = tokio::select! {
            r = self.cx.send_request(request).block_task() => r.map_err(|e| Halt::Failed(e.to_string()))?,
            _ = self.stop.cancelled() => return Err(Halt::Stopped),
        };
        Ok(matches!(&response.outcome, RequestPermissionOutcome::Selected(s) if &*s.option_id.0 != "reject"))
    }
}

/// The model and effort options, as the adapter reports its own.
fn options(model: &str, effort: &str) -> Vec<SessionConfigOption> {
    let models: Vec<SessionConfigSelectOption> = MODELS.iter().map(|(id, name)| SessionConfigSelectOption::new(*id, *name)).collect();
    let efforts: Vec<SessionConfigSelectOption> = EFFORTS
        .iter()
        .map(|e| SessionConfigSelectOption::new(*e, format!("{}{}", e[..1].to_uppercase(), &e[1..])))
        .collect();
    vec![
        SessionConfigOption::select("model", "Model", model.to_string(), models).category(SessionConfigOptionCategory::Model),
        SessionConfigOption::select("effort", "Effort", effort.to_string(), efforts).category(SessionConfigOptionCategory::ThoughtLevel),
    ]
}

/// The HTTP servers a session was given, by name, with their bearer token.
fn servers_of(list: &[McpServer]) -> HashMap<String, Server> {
    list.iter()
        .filter_map(|server| match server {
            McpServer::Http(http) => {
                let token = http
                    .headers
                    .iter()
                    .find(|h| h.name.eq_ignore_ascii_case("authorization"))
                    .and_then(|h| h.value.strip_prefix("Bearer "))
                    .map(str::to_string);
                Some((http.name.clone(), Server { url: http.url.clone(), token }))
            }
            _ => None,
        })
        .collect()
}

/// `toolAliases` from the options the app passes Claude Code, e.g. Edit →
/// mcp__blixel__edit, as (server, tool) by built-in name.
fn aliases_of(meta: Option<&Meta>) -> HashMap<String, (String, String)> {
    let aliases = meta.and_then(|m| m.get("claudeCode")).and_then(|c| c.pointer("/options/toolAliases")).and_then(Value::as_object);
    aliases
        .into_iter()
        .flatten()
        .filter_map(|(builtin, target)| {
            let (server, tool) = target.as_str()?.strip_prefix("mcp__")?.split_once("__")?;
            Some((builtin.clone(), (server.to_string(), tool.to_string())))
        })
        .collect()
}

/// A session's transcript file; None for an id that is not a plain name.
fn transcript_path(dir: &Path, id: &str) -> Option<PathBuf> {
    let plain = !id.is_empty() && id.len() <= 100 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    plain.then(|| dir.join(format!("{id}.json")))
}

fn read_transcript(path: &Path) -> Option<Vec<String>> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn write_transcript(path: &Path, messages: &[String]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    let text = serde_json::to_string(messages).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

/// The text without the prefix the interface puts before chat messages.
fn without_chat_prefix(text: &str) -> String {
    text.lines()
        .map(|line| line.trim_start().strip_prefix(CHAT_PREFIX).map(str::trim_start).unwrap_or(line))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Text cut into pieces of about `size` bytes, at spaces.
fn pieces(text: &str, size: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut piece = String::new();
    for c in text.chars() {
        piece.push(c);
        if piece.len() >= size && c.is_whitespace() {
            out.push(std::mem::take(&mut piece));
        }
    }
    if !piece.is_empty() {
        out.push(piece);
    }
    out
}

#[derive(Debug, PartialEq)]
enum Step {
    Say(String),
    Read(String),
    Edit { path: String, old: String, new: String },
    Write { path: String, content: String },
    Run(String),
    Call { server: String, tool: String, args: Value },
    Ask(String),
    Cost(f64),
    Sleep(u64),
    Settings,
    Fail(String),
    Unknown(String),
}

fn parse(text: &str) -> Vec<Step> {
    let lines: Vec<&str> = text.lines().collect();
    let mut steps = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i].trim();
        i += 1;
        if line.is_empty() {
            continue;
        }
        let (word, rest) = match line.split_once(char::is_whitespace) {
            Some((word, rest)) => (word, rest.trim()),
            None => (line, ""),
        };
        let unknown = || Step::Unknown(line.to_string());
        let step = match word {
            "say" => Step::Say(rest.to_string()),
            "read" if !rest.is_empty() => Step::Read(rest.to_string()),
            "edit" if !rest.is_empty() => match block(&lines, &mut i, true).as_deref() {
                Some([old, new]) => Step::Edit { path: rest.to_string(), old: old.clone(), new: new.clone() },
                _ => unknown(),
            },
            "write" if !rest.is_empty() => match block(&lines, &mut i, false).as_deref() {
                Some([content]) => Step::Write { path: rest.to_string(), content: format!("{content}\n") },
                _ => unknown(),
            },
            "run" if !rest.is_empty() => Step::Run(rest.to_string()),
            "call" => call_of(rest).unwrap_or_else(unknown),
            "ask" if !rest.is_empty() => Step::Ask(rest.to_string()),
            "cost" => match rest.trim_start_matches('$').parse::<f64>() {
                Ok(usd) if usd.is_finite() && usd >= 0.0 => Step::Cost(usd),
                _ => unknown(),
            },
            "sleep" => millis(rest).map(Step::Sleep).unwrap_or_else(unknown),
            "settings" if rest.is_empty() => Step::Settings,
            "fail" => Step::Fail(rest.to_string()),
            _ => unknown(),
        };
        steps.push(step);
    }
    steps
}

/// The text after an edit or write: a `<<<` line, the text, for an edit a
/// `===` line and the new text, then a `>>>` line. Moves `i` past it.
fn block(lines: &[&str], i: &mut usize, edit: bool) -> Option<Vec<String>> {
    if lines.get(*i)?.trim() != "<<<" {
        return None;
    }
    let parts_wanted = if edit { 2 } else { 1 };
    let mut parts: Vec<Vec<&str>> = vec![Vec::new()];
    let mut j = *i + 1;
    loop {
        let line = *lines.get(j)?;
        j += 1;
        match line.trim() {
            "===" if edit && parts.len() == 1 => parts.push(Vec::new()),
            ">>>" if parts.len() == parts_wanted => break,
            _ => parts.last_mut()?.push(line),
        }
    }
    *i = j;
    Some(parts.into_iter().map(|p| p.join("\n")).collect())
}

/// `<server> <tool> <json object>`; the arguments may be left out.
fn call_of(rest: &str) -> Option<Step> {
    let (server, rest) = rest.split_once(char::is_whitespace)?;
    let rest = rest.trim();
    let (tool, args) = match rest.split_once(char::is_whitespace) {
        Some((tool, args)) => (tool, args.trim()),
        None => (rest, ""),
    };
    let args: Value = if args.is_empty() { json!({}) } else { serde_json::from_str(args).ok()? };
    (args.is_object() && !tool.is_empty()).then(|| Step::Call { server: server.to_string(), tool: tool.to_string(), args })
}

/// "500" and "500ms" are milliseconds; "2s" and "1.5s" seconds.
fn millis(text: &str) -> Option<u64> {
    let text = text.trim();
    let (number, scale) = match text.strip_suffix("ms") {
        Some(number) => (number, 1.0),
        None => match text.strip_suffix('s') {
            Some(number) => (number, 1000.0),
            None => (text, 1.0),
        },
    };
    let value: f64 = number.trim().parse().ok()?;
    (value.is_finite() && value >= 0.0).then_some((value * scale) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instructions_are_read_one_per_line() {
        let text = without_chat_prefix(
            "(Chat message, not a task.) say Hello there\nread src/a.rs\nedit a.txt\n<<<\none\n  two\n===\nthree\n>>>\n\
             write b.txt\n<<<\nfirst\n\nlast\n>>>\nrun echo hi && ls\ncall stub echo {\"text\": \"a b\"}\ncall stub list\n\
             ask Fetch the docs\ncost 0.25\ncost $1\nsleep 500\nsleep 2s\nsettings\nfail Oops\nwave hello\nsleep soon",
        );
        assert_eq!(parse(&text), [
            Step::Say("Hello there".into()),
            Step::Read("src/a.rs".into()),
            Step::Edit { path: "a.txt".into(), old: "one\n  two".into(), new: "three".into() },
            Step::Write { path: "b.txt".into(), content: "first\n\nlast\n".into() },
            Step::Run("echo hi && ls".into()),
            Step::Call { server: "stub".into(), tool: "echo".into(), args: json!({ "text": "a b" }) },
            Step::Call { server: "stub".into(), tool: "list".into(), args: json!({}) },
            Step::Ask("Fetch the docs".into()),
            Step::Cost(0.25),
            Step::Cost(1.0),
            Step::Sleep(500),
            Step::Sleep(2000),
            Step::Settings,
            Step::Fail("Oops".into()),
            Step::Unknown("wave hello".into()),
            Step::Unknown("sleep soon".into()),
        ]);
        // A block that never closes is not an instruction; what follows is read on its own.
        assert_eq!(parse("edit a.txt\n<<<\nold\n>>>\nsay hi"), [
            Step::Unknown("edit a.txt".into()),
            Step::Unknown("<<<".into()),
            Step::Unknown("old".into()),
            Step::Unknown(">>>".into()),
            Step::Say("hi".into()),
        ]);
        assert!(parse("Hello, how are you?").iter().all(|s| matches!(s, Step::Unknown(_))));
        assert_eq!(millis("1.5s"), Some(1500));
        assert_eq!(millis("250ms"), Some(250));
        assert_eq!(pieces("one two three four", 4).concat(), "one two three four");
    }

    #[test]
    fn sessions_are_named_safely_and_routed_like_claude_code() {
        let dir = Path::new("/data");
        assert_eq!(transcript_path(dir, "stand-in-1a-2"), Some(PathBuf::from("/data/stand-in-1a-2.json")));
        for bad in ["", "../x", "a/b", "a b"] {
            assert_eq!(transcript_path(dir, bad), None, "{bad:?}");
        }
        let meta: Meta = serde_json::from_value(json!({
            "claudeCode": { "options": { "toolAliases": { "Edit": "mcp__blixel__edit", "Bash": "mcp__blixel__bash", "Odd": "Bash" } } }
        }))
        .unwrap();
        let aliases = aliases_of(Some(&meta));
        assert_eq!(aliases.len(), 2);
        assert_eq!(aliases["Edit"], ("blixel".to_string(), "edit".to_string()));
        assert!(aliases_of(None).is_empty());
    }
}
