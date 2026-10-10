//! The core's own MCP client for one connector: started from its record,
//! with its secrets filled in here and nowhere else.

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use rmcp::model::{CallToolRequestParams, CallToolResult, ProtocolVersion, Tool};
use rmcp::service::RunningService;
use rmcp::transport::streamable_http_client::{AuthRequiredError, InsufficientScopeError, StreamableHttpClientTransportConfig};
use rmcp::transport::{ConfigureCommandExt, StreamableHttpClientTransport, TokioChildProcess};
use rmcp::{ClientLifecycleMode, ClientServiceExt, Peer, RoleClient};
use tokio::io::AsyncReadExt;

use super::hash;
use super::model::{secret_name, Connector, Transport};
use super::store::Keys;

/// Starting (handshake and tool list) takes at most this long; a first
/// `npx -y` may have to download the server.
pub const START_TIMEOUT: Duration = Duration::from_secs(60);
/// A call takes at most this long, like a command.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(600);

/// Why a start failed: the server wants a sign-in, or something else. The
/// reason is for the user only: it can quote what the server printed, and a
/// server may print its token or connection string.
#[derive(Debug)]
pub enum StartError {
    SignIn(String),
    Failed(String),
}

impl StartError {
    /// What an agent is told instead: never the reason.
    pub fn for_agent(&self) -> &'static str {
        match self {
            StartError::SignIn(_) => "It needs the user to sign in again on the Connectors page.",
            StartError::Failed(_) => "It could not start; the user can see why on the Connectors page.",
        }
    }
}

/// A running client and the tools it offered when it started.
pub struct Live {
    service: tokio::sync::Mutex<Option<RunningService<RoleClient, ()>>>,
    peer: Peer<RoleClient>,
    /// Cleaned, sorted, and what agents are given.
    pub tools: Vec<Tool>,
    pub hash: String,
    /// The local server's process group, to stop what it started too.
    group: Option<u32>,
}

fn lifecycle() -> ClientLifecycleMode {
    ClientLifecycleMode::Auto {
        preferred_versions: vec![ProtocolVersion::V_2026_07_28],
        legacy_version: Some(ProtocolVersion::LATEST_WITH_INITIALIZE),
    }
}

/// Whether an error means the server wants a (new) sign-in.
pub fn needs_sign_in(error: &(dyn std::error::Error + 'static)) -> bool {
    let mut current = Some(error);
    while let Some(e) = current {
        if e.is::<AuthRequiredError>() || e.is::<InsufficientScopeError>() {
            return true;
        }
        current = e.source();
    }
    let text = error.to_string();
    text.contains("401") || text.contains("Unauthorized")
}

/// A secret's value, or an error naming the one that is missing.
fn secret(keys: &dyn Keys, c: &Connector, var: &str) -> Result<String, StartError> {
    match keys.secret(&secret_name(&c.id, var)) {
        Ok(Some(v)) => Ok(v),
        Ok(None) => Err(StartError::Failed(format!("{var} is not set. Add its value on the Connectors page."))),
        Err(e) => Err(StartError::Failed(e)),
    }
}

/// Starts the connector and lists its tools. Local servers run in `workdir`
/// (outside any project, so files an agent wrote cannot change what starts).
pub async fn start(c: &Connector, keys: &dyn Keys, workdir: &Path) -> Result<Live, StartError> {
    start_within(c, keys, workdir, START_TIMEOUT).await
}

async fn start_within(c: &Connector, keys: &dyn Keys, workdir: &Path, limit: Duration) -> Result<Live, StartError> {
    // A start that times out is dropped here, and its Group guard with it.
    match tokio::time::timeout(limit, start_inner(c, keys, workdir)).await {
        Ok(result) => result,
        Err(_) => Err(StartError::Failed(format!("It did not answer within {} seconds.", limit.as_secs()))),
    }
}

/// A local server's process group, killed when this is dropped unless the
/// start succeeded: a start that fails or times out must not leave behind
/// what the server started (npx starts node, which `kill_on_drop` misses).
struct Group(Option<u32>);

impl Group {
    /// The start succeeded: from now on `Live::stop` ends the group.
    fn keep(mut self) -> Option<u32> {
        self.0.take()
    }
}

impl Drop for Group {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.0 {
            // A group id is not given out again while any process in the group lives.
            unsafe { libc::killpg(pid as libc::pid_t, libc::SIGKILL) };
        }
    }
}

async fn start_inner(c: &Connector, keys: &dyn Keys, workdir: &Path) -> Result<Live, StartError> {
    let (service, group) = match &c.transport {
        Transport::Command { command, args, env } => {
            let mut vars = Vec::new();
            for var in env {
                let value = if var.secret { secret(keys, c, &var.name)? } else { var.value.clone() };
                vars.push((var.name.clone(), value));
            }
            std::fs::create_dir_all(workdir).map_err(|e| StartError::Failed(format!("Cannot create {}: {e}", workdir.display())))?;
            let cmd = tokio::process::Command::new(command).configure(|cmd| {
                cmd.args(args).envs(vars).env_remove("ANTHROPIC_API_KEY").current_dir(workdir).kill_on_drop(true);
                // Its own process group, so stopping it stops what it started (npx starts node).
                #[cfg(unix)]
                cmd.process_group(0);
            });
            let (transport, stderr) = TokioChildProcess::builder(cmd)
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| StartError::Failed(format!("Could not start {command}: {e}")))?;
            let group = Group(transport.id());
            // Keep the last of its error output for the user's reason, and keep the pipe drained.
            let tail = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
            let mut reader = None;
            if let Some(mut stderr) = stderr {
                let tail = tail.clone();
                reader = Some(tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    while let Ok(n) = stderr.read(&mut buf).await {
                        if n == 0 {
                            break;
                        }
                        let mut t = tail.lock().expect("stderr lock");
                        t.push_str(&String::from_utf8_lossy(&buf[..n]));
                        if t.len() > 2000 {
                            let cut = t.len() - 1000;
                            let cut = (cut..t.len()).find(|i| t.is_char_boundary(*i)).unwrap_or(t.len());
                            t.drain(..cut);
                        }
                    }
                }));
            }
            let service = match ().serve_with_lifecycle(transport, lifecycle()).await {
                Ok(service) => service,
                Err(e) => {
                    // What it printed as it stopped, once the pipe has closed.
                    if let Some(reader) = reader {
                        let _ = tokio::time::timeout(Duration::from_millis(500), reader).await;
                    }
                    let said = tail.lock().expect("stderr lock").trim().to_string();
                    let last: Vec<&str> = said.lines().rev().take(3).collect::<Vec<_>>().into_iter().rev().collect();
                    return Err(if last.is_empty() {
                        StartError::Failed(format!("It stopped during the handshake: {e}"))
                    } else {
                        StartError::Failed(format!("It stopped during the handshake: {}", last.join("\n")))
                    });
                }
            };
            (service, group)
        }
        Transport::Url { url, headers } => {
            let mut map = HashMap::new();
            for var in headers {
                let value = if var.secret { secret(keys, c, &var.name)? } else { var.value.clone() };
                let name = axum::http::HeaderName::from_bytes(var.name.as_bytes()).map_err(|e| StartError::Failed(e.to_string()))?;
                let value = axum::http::HeaderValue::from_str(&value)
                    .map_err(|_| StartError::Failed(format!("The value of {} is not a valid header value.", var.name)))?;
                map.insert(name, value);
            }
            let config = StreamableHttpClientTransportConfig::with_uri(url.as_str()).custom_headers(map);
            let service = ().serve_with_lifecycle(StreamableHttpClientTransport::from_config(config), lifecycle()).await.map_err(|e| {
                if e.is_authorization_required() || needs_sign_in(&e) {
                    StartError::SignIn("The server asks for a sign-in. Check its token on the Connectors page.".into())
                } else {
                    StartError::Failed(format!("Could not connect: {e}"))
                }
            })?;
            (service, Group(None))
        }
    };
    let peer = service.peer().clone();
    let listed = peer.list_all_tools().await;
    let group = group.keep();
    let mut live = Live { service: tokio::sync::Mutex::new(Some(service)), peer, tools: Vec::new(), hash: String::new(), group };
    match listed {
        Ok(tools) => {
            live.tools = hash::clean_tools(&tools);
            live.hash = hash::hash(&live.tools);
            Ok(live)
        }
        Err(e) => {
            live.stop().await;
            if needs_sign_in(&e) {
                Err(StartError::SignIn("The server asks for a sign-in. Check its token on the Connectors page.".into()))
            } else {
                Err(StartError::Failed(format!("It did not list its tools: {e}")))
            }
        }
    }
}

impl Live {
    pub async fn call(&self, params: CallToolRequestParams) -> Result<CallToolResult, rmcp::ServiceError> {
        self.peer.call_tool(params).await
    }

    pub fn is_closed(&self) -> bool {
        self.peer.is_transport_closed()
    }

    /// Ends the client and, for a local server, everything it started.
    pub async fn stop(&self) {
        #[cfg(unix)]
        if let Some(pid) = self.group {
            // The leader is not reaped yet, so its group id is still ours.
            unsafe { libc::killpg(pid as libc::pid_t, libc::SIGTERM) };
        }
        if let Some(mut service) = self.service.lock().await.take() {
            let _ = service.close_with_timeout(Duration::from_secs(3)).await;
        }
        #[cfg(unix)]
        if let Some(pid) = self.group {
            // Anything that ignored the polite stop. A group id is never reused while the group exists.
            unsafe {
                if libc::killpg(pid as libc::pid_t, 0) == 0 {
                    libc::killpg(pid as libc::pid_t, libc::SIGKILL);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::model::Trust;
    use crate::connectors::store::testing::MemoryKeys;

    fn local(script: String) -> Connector {
        Connector {
            id: "c1".into(),
            slug: "local".into(),
            name: "Local".into(),
            template: None,
            created: 0,
            transport: Transport::Command { command: "bash".into(), args: vec!["-c".into(), script], env: vec![] },
            approved_hash: None,
            trust: Trust::Ok,
        }
    }

    /// Whether a process has ended (gone, or only waiting to be reaped).
    #[cfg(target_os = "linux")]
    async fn ended(pid: &str) -> bool {
        for _ in 0..40 {
            match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
                Err(_) => return true,
                Ok(stat) if stat.rsplit_once(") ").is_some_and(|(_, rest)| rest.starts_with('Z')) => return true,
                Ok(_) => tokio::time::sleep(Duration::from_millis(50)).await,
            }
        }
        false
    }

    /// A start that fails or times out leaves nothing the server started running.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_failed_start_stops_everything_the_server_started() {
        let dir = std::env::temp_dir().join(format!("blixel-start-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let keys = MemoryKeys::default();

        // It starts a helper, then exits before the handshake.
        let pidfile = dir.join("failed.pid");
        let script = format!("sleep 300 </dev/null >/dev/null 2>&1 & echo $! > '{}'; exit 1", pidfile.display());
        let outcome = start_within(&local(script), &keys, &dir.join("work"), Duration::from_secs(20)).await;
        assert!(matches!(outcome, Err(StartError::Failed(_))));
        let pid = std::fs::read_to_string(&pidfile).unwrap();
        assert!(ended(pid.trim()).await, "the helper of a failed start still runs");

        // It starts a helper, then never answers.
        let pidfile = dir.join("silent.pid");
        let script = format!("sleep 300 </dev/null >/dev/null 2>&1 & echo $! > '{}'; sleep 300", pidfile.display());
        let outcome = start_within(&local(script), &keys, &dir.join("work"), Duration::from_secs(1)).await;
        assert!(matches!(&outcome, Err(StartError::Failed(r)) if r.contains("did not answer")));
        let pid = std::fs::read_to_string(&pidfile).unwrap();
        assert!(ended(pid.trim()).await, "the helper of a start that timed out still runs");
    }
}
