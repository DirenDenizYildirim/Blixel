//! One agent session's connectors. Each one the agent may use is served on
//! the agent's own tool server at `/c/<slug>/mcp`; its calls are checked
//! against the agent's setting, logged, and only then passed to the core's
//! own client for the connector, which the agent never sees.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock, Weak};

use axum::extract::{Path, Request};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ListToolsResult, PaginatedRequestParams,
    ServerCapabilities, ServerConfig,
};
use rmcp::service::RequestContext;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData, RoleServer, ServerHandler};
use tokio_util::sync::CancellationToken;

use crate::agents::runtime::{AgentRuntime, Gate};
use crate::agents::settings::Setting;
use crate::events::{new_id, Activity};

use super::client::{Live, CALL_TIMEOUT};
use super::model::{Connector, Trust};
use super::Hub;

/// A call's arguments are shown up to this many characters.
const MAX_DETAIL_CHARS: usize = 4000;
/// Text in a result is cut to this many characters (start and end kept), like a command's output.
const MAX_RESULT_CHARS: usize = 30_000;
/// A result bigger than this (images included) is refused.
const MAX_RESULT_BYTES: usize = 5 * 1024 * 1024;

/// A connector an agent is given: its endpoint is passed to the session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Exposed {
    pub id: String,
    pub slug: String,
}

type Slot = Arc<tokio::sync::Mutex<Option<Arc<Live>>>>;

pub struct Gateway {
    hub: Arc<Hub>,
    rt: Arc<AgentRuntime>,
    me: Weak<Gateway>,
    exposed: RwLock<Vec<Exposed>>,
    services: Mutex<HashMap<String, StreamableHttpService<Proxy, LocalSessionManager>>>,
    clients: Mutex<HashMap<String, Slot>>,
    cancel: CancellationToken,
}

impl Gateway {
    pub fn new(hub: Arc<Hub>, rt: Arc<AgentRuntime>) -> Arc<Self> {
        let gw = Arc::new_cyclic(|me| Gateway {
            hub: hub.clone(),
            rt,
            me: me.clone(),
            exposed: RwLock::default(),
            services: Mutex::default(),
            clients: Mutex::default(),
            cancel: CancellationToken::new(),
        });
        hub.register(&gw);
        gw
    }

    /// Works out which connectors the agent is given now (Ask or Allow, and
    /// not changed outside the app), stops clients it no longer may use, and
    /// returns them.
    pub async fn refresh(&self) -> Vec<Exposed> {
        let connectors = self.hub.connectors().unwrap_or_else(|e| {
            self.rt.events.note(&self.rt.id, &format!("Connectors could not be loaded: {e}"));
            Vec::new()
        });
        let exposed: Vec<Exposed> = connectors
            .iter()
            .filter(|c| c.trust == Trust::Ok && self.rt.connector_setting(&c.id) != Setting::Off)
            .map(|c| Exposed { id: c.id.clone(), slug: c.slug.clone() })
            .collect();
        *self.exposed.write().expect("exposed lock") = exposed.clone();
        let gone: Vec<String> =
            self.clients.lock().expect("clients lock").keys().filter(|id| !exposed.iter().any(|e| &e.id == *id)).cloned().collect();
        self.services.lock().expect("services lock").retain(|id, _| exposed.iter().any(|e| &e.id == id));
        for id in gone {
            self.stop_client(&id).await;
        }
        exposed
    }

    pub fn exposed(&self) -> Vec<Exposed> {
        self.exposed.read().expect("exposed lock").clone()
    }

    /// The routes for the agent's tool server.
    pub fn router(self: &Arc<Self>) -> axum::Router {
        let gw = self.clone();
        axum::Router::new().route(
            "/c/{slug}/mcp",
            axum::routing::any(move |Path(slug): Path<String>, req: Request| {
                let gw = gw.clone();
                async move {
                    match gw.service(&slug) {
                        Some(service) => service.handle(req).await.map(axum::body::Body::new),
                        None => StatusCode::NOT_FOUND.into_response(),
                    }
                }
            }),
        )
    }

    fn service(&self, slug: &str) -> Option<StreamableHttpService<Proxy, LocalSessionManager>> {
        let id = self.exposed().into_iter().find(|e| e.slug == slug)?.id;
        let mut services = self.services.lock().expect("services lock");
        let service = services.entry(id.clone()).or_insert_with(|| {
            let proxy = Proxy { gw: self.me.clone(), id };
            StreamableHttpService::new(
                move || Ok(proxy.clone()),
                Arc::new(LocalSessionManager::default()),
                StreamableHttpServerConfig::default().with_cancellation_token(self.cancel.child_token()),
            )
        });
        Some(service.clone())
    }

    /// The running client for a connector, started (or restarted) if needed.
    async fn live(&self, id: &str) -> Result<Arc<Live>, String> {
        let slot = self.clients.lock().expect("clients lock").entry(id.to_string()).or_default().clone();
        let mut slot = slot.lock().await;
        if let Some(live) = slot.as_ref() {
            if !live.is_closed() {
                return Ok(live.clone());
            }
            live.stop().await;
            *slot = None;
        }
        let live = Arc::new(self.hub.start(id).await?);
        *slot = Some(live.clone());
        Ok(live)
    }

    /// Stops a connector's client, e.g. after it was changed or removed. The
    /// next call starts it again; the agent's endpoint stays up meanwhile.
    pub async fn stop_client(&self, id: &str) {
        let slot = self.clients.lock().expect("clients lock").remove(id);
        if let Some(slot) = slot {
            if let Some(live) = slot.lock().await.take() {
                live.stop().await;
            }
        }
    }

    /// Stops every client, when the session ends.
    pub async fn stop(&self) {
        self.cancel.cancel();
        let ids: Vec<String> = self.clients.lock().expect("clients lock").keys().cloned().collect();
        for id in ids {
            self.stop_client(&id).await;
        }
    }

    fn log(&self, entry_id: &str, target: &str, result: &str, live: bool, refused: bool, detail: &str) {
        self.rt.events.activity(Activity {
            agent_id: &self.rt.id,
            entry_id,
            verb: "CALL",
            target,
            result,
            live,
            refused,
            detail: Some(detail),
        });
    }

    async fn call(&self, id: &str, request: CallToolRequestParams, ct: CancellationToken) -> CallToolResult {
        let fail = |text: String| CallToolResult::error(vec![ContentBlock::text(text)]);
        let Some(c) = self.hub.connector(id) else {
            return fail("This connector was removed.".into());
        };
        let agent = self.rt.name();
        let tool = super::hash::clean_text(&request.name);
        let target = format!("{} · {tool}", c.name);
        let detail = clip(&request.arguments.as_ref().map(|a| serde_json::to_string_pretty(a).unwrap_or_default()).unwrap_or_default(), MAX_DETAIL_CHARS);
        let entry = new_id("e");
        if self.rt.connector_setting(id) == Setting::Off || c.trust != Trust::Ok {
            self.log(&entry, &target, "not allowed", false, true, &detail);
            return fail(format!("{agent} is not allowed to use {}. Ask the user.", c.name));
        }
        let live = match self.live(id).await {
            Ok(live) => live,
            Err(reason) => {
                self.log(&entry, &target, "failed", false, true, &detail);
                return fail(format!("{} is not available: {reason}", c.name));
            }
        };
        if !live.tools.iter().any(|t| t.name == request.name) {
            return fail(format!("{} has no tool named {tool}.", c.name));
        }
        let changed = approval_differs(&c, &live.hash);
        let title = format!("{agent} wants to use {}: {tool}", c.name);
        let gate = tokio::select! {
            g = self.rt.gate_connector(id, changed, &title, &detail) => g,
            _ = ct.cancelled() => Gate::Denied,
        };
        match gate {
            Gate::Allowed => {}
            Gate::Off => {
                self.log(&entry, &target, "not allowed", false, true, &detail);
                return fail(format!("{agent} is not allowed to use {}. Ask the user.", c.name));
            }
            Gate::Denied => {
                self.log(&entry, &target, "denied", false, true, &detail);
                return fail("The user denied this call.".into());
            }
        }
        self.log(&entry, &target, "running", true, false, &detail);
        let mut params = CallToolRequestParams::new(request.name.clone());
        params.arguments = request.arguments;
        let outcome = tokio::select! {
            r = tokio::time::timeout(CALL_TIMEOUT, live.call(params)) => r,
            _ = ct.cancelled() => {
                self.log(&entry, &target, "stopped", false, false, &detail);
                return fail("Stopped.".into());
            }
        };
        match outcome {
            Ok(Ok(result)) => {
                let shown = if result.is_error == Some(true) { "error" } else { "done" };
                self.log(&entry, &target, shown, false, false, &detail);
                cap(result)
            }
            Ok(Err(e)) => {
                self.log(&entry, &target, "failed", false, false, &detail);
                if live.is_closed() {
                    self.hub.lost(id, &e.to_string());
                }
                fail(format!("{} failed: {e}", c.name))
            }
            Err(_) => {
                self.log(&entry, &target, "timed out", false, false, &detail);
                fail(format!("{} did not answer within {} seconds.", c.name, CALL_TIMEOUT.as_secs()))
            }
        }
    }
}

/// Whether the connector's tools are not the ones the user approved.
pub fn approval_differs(c: &Connector, hash: &str) -> bool {
    c.trust != Trust::Ok || c.approved_hash.as_deref() != Some(hash)
}

/// Keeps the start and end of long text.
fn clip(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.to_string();
    }
    let half = max / 2;
    let head: String = text.chars().take(half).collect();
    let tail: String = text.chars().skip(count - half).collect();
    format!("{head}\n\n[{} characters cut]\n\n{tail}", count - 2 * half)
}

/// A result as the model gets it: text cut like a command's output, large
/// structured copies dropped (the text carries the same), nothing huge.
fn cap(mut result: CallToolResult) -> CallToolResult {
    let mut budget = MAX_RESULT_CHARS;
    result.content = result
        .content
        .into_iter()
        .map(|block| {
            let Ok(mut value) = serde_json::to_value(&block) else { return block };
            let Some(text) = value.get("text").and_then(|t| t.as_str()).map(str::to_owned) else { return block };
            let clipped = clip(&text, budget.max(200));
            budget = budget.saturating_sub(clipped.chars().count());
            value["text"] = clipped.into();
            serde_json::from_value(value).unwrap_or(block)
        })
        .collect();
    if result.structured_content.as_ref().is_some_and(|v| v.to_string().len() > MAX_RESULT_CHARS) {
        result.structured_content = None;
    }
    let size = serde_json::to_string(&result).map(|s| s.len()).unwrap_or(0);
    if size > MAX_RESULT_BYTES {
        return CallToolResult::error(vec![ContentBlock::text(format!(
            "The result was too large to pass on ({} MB).",
            size / (1024 * 1024)
        ))]);
    }
    result
}

/// The MCP server an agent talks to for one connector.
#[derive(Clone)]
pub struct Proxy {
    gw: Weak<Gateway>,
    id: String,
}

impl ServerHandler for Proxy {
    fn get_info(&self) -> ServerConfig {
        // The real server's instructions are not passed on: the user never approved them.
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let gw = self.gw.upgrade().ok_or_else(|| ErrorData::internal_error("The session ended.", None))?;
        match gw.live(&self.id).await {
            Ok(live) => Ok(ListToolsResult::with_all_items(live.tools.clone())),
            Err(reason) => Err(ErrorData::internal_error(reason, None)),
        }
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let gw = self.gw.upgrade().ok_or_else(|| ErrorData::internal_error("The session ended.", None))?;
        Ok(gw.call(&self.id, request, context.ct).await.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn results_are_capped() {
        let long = "x".repeat(100_000);
        let r = cap(CallToolResult::success(vec![ContentBlock::text(long), ContentBlock::text("tail")]));
        let text = serde_json::to_string(&r).unwrap();
        assert!(text.len() < 40_000 && text.contains("characters cut"), "{}", text.len());
        let huge = CallToolResult::success(vec![ContentBlock::image("A".repeat(6 * 1024 * 1024), "image/png")]);
        assert_eq!(cap(huge).is_error, Some(true));
    }
}
