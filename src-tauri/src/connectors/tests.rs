//! Connectors end to end: records, secrets, a real MCP server reached through
//! an agent's tool server, and the agent's settings applied to each call.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::IntoResponse;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ListToolsResult, PaginatedRequestParams,
    ServerCapabilities, ServerConfig, Tool,
};
use rmcp::service::RequestContext;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::{ErrorData, RoleServer, ServerHandler, ServiceExt};
use tokio_util::sync::CancellationToken;

use crate::agents::permissions::{Answer, Broker};
use crate::agents::runtime::AgentRuntime;
use crate::agents::settings::{AgentConfig, Permissions, Setting};
use crate::agents::tools::{self, BlixelTools};
use crate::events::Events;
use crate::store::Db;

use super::gateway::Gateway;
use super::model::{Connector, State, Transport, Trust, Var};
use super::store::testing::MemoryKeys;
use super::Hub;

/// A small MCP server over HTTP that wants `X-Key: s3cret`.
#[derive(Clone)]
struct Stub {
    tools: Arc<Mutex<Vec<Tool>>>,
}

impl ServerHandler for Stub {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
    }

    async fn list_tools(&self, _: Option<PaginatedRequestParams>, _: RequestContext<RoleServer>) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(self.tools.lock().unwrap().clone()))
    }

    async fn call_tool(&self, request: CallToolRequestParams, _: RequestContext<RoleServer>) -> Result<CallToolResponse, ErrorData> {
        let args = serde_json::to_string(&request.arguments).unwrap();
        Ok(CallToolResult::success(vec![ContentBlock::text(format!("echo {args}"))]).into())
    }
}

fn tool(name: &str, description: &str) -> Tool {
    let serde_json::Value::Object(schema) = serde_json::json!({ "type": "object", "properties": { "text": { "type": "string" } } })
    else {
        unreachable!()
    };
    Tool::new(name.to_string(), description.to_string(), schema)
}

async fn stub_server(tools: Arc<Mutex<Vec<Tool>>>) -> String {
    let stub = Stub { tools };
    let service = StreamableHttpService::new(
        move || Ok(stub.clone()),
        Arc::new(LocalSessionManager::default()),
        StreamableHttpServerConfig::default(),
    );
    let router = axum::Router::new().nest_service("/mcp", service).layer(axum::middleware::from_fn(|req: Request, next: Next| async move {
        if req.headers().get("x-key").and_then(|v| v.to_str().ok()) == Some("s3cret") {
            next.run(req).await
        } else {
            (StatusCode::UNAUTHORIZED, [("www-authenticate", "Bearer")]).into_response()
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await });
    format!("http://{addr}/mcp")
}

/// Everything the core told the interface, answering every permission
/// request with the answer set in `answer` and noting whether "Always
/// allow" was offered.
struct Seen {
    log: Arc<Mutex<Vec<String>>>,
    answer: Arc<Mutex<Answer>>,
    asked: Arc<Mutex<Vec<bool>>>,
}

fn events(broker: Arc<Broker>) -> (Events, Seen) {
    let seen = Seen { log: Arc::default(), answer: Arc::new(Mutex::new(Answer::Allowed)), asked: Arc::default() };
    let (log, answer, asked) = (seen.log.clone(), seen.answer.clone(), seen.asked.clone());
    let events = Events::to_sink(move |name, payload| {
        log.lock().unwrap().push(format!("{name} {payload}"));
        if name == "agent://permission" {
            asked.lock().unwrap().push(payload["alwaysOffered"].as_bool().unwrap());
            broker.answer(payload["requestId"].as_str().unwrap(), *answer.lock().unwrap());
        }
    });
    (events, seen)
}

fn temp(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("blixel-conn-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn hub(dir: &std::path::Path, events: Events) -> Arc<Hub> {
    Arc::new(Hub::detached(Db::open(dir).unwrap(), Box::new(MemoryKeys::default()), events, dir.join("work")))
}

fn url_connector(url: &str, key: &str) -> Connector {
    Connector {
        id: String::new(),
        slug: "stub".into(),
        name: "Stub".into(),
        template: None,
        created: 0,
        transport: Transport::Url {
            url: url.into(),
            headers: vec![Var { name: "X-Key".into(), value: key.into(), secret: true, is_set: None }],
        },
        approved_hash: None,
        trust: Trust::Ok,
    }
}

fn agent(connectors: &[(&str, Setting)]) -> AgentConfig {
    AgentConfig {
        id: "a".into(),
        name: "Ada".into(),
        instructions: String::new(),
        read_notes: false,
        permissions: Permissions { read: Setting::Allow, edit: Setting::Ask, run: Setting::Ask, commit: Setting::Off, push: Setting::Off },
        edit_paths: String::new(),
        rule_packs: vec![],
        connectors: connectors.iter().map(|(id, s)| (id.to_string(), *s)).collect(),
        model: "test".into(),
        effort: "medium".into(),
    }
}

#[tokio::test]
async fn records_keep_secrets_out_and_notice_changes_from_outside() {
    let dir = temp("records");
    let hub = hub(&dir, Events::to_sink(|_, _| {}));
    let saved = hub.save(url_connector("https://mcp.example.com/mcp", "s3cret")).await.unwrap();
    assert!(!saved.id.is_empty() && saved.created > 0);
    let listed = serde_json::to_string(&hub.list().unwrap()).unwrap();
    assert!(!listed.contains("s3cret"), "{listed}");
    assert!(listed.contains("\"isSet\":true"), "{listed}");
    assert_eq!(hub.keys.secret(&format!("connector:{}:X-Key", saved.id)).unwrap().as_deref(), Some("s3cret"));

    // The slug is fixed and unique.
    let mut renamed = saved.clone();
    renamed.slug = "other".into();
    assert!(hub.save(renamed).await.is_err());
    let twin = url_connector("https://x.dev/mcp", "");
    assert!(hub.save(twin).await.unwrap_err().contains("already uses"));

    // Approval needs the tools seen first.
    assert!(hub.approve(&saved.id, "abc").is_err());

    // Something other than the app edits the row: its approval no longer counts.
    {
        let db = hub.db.get().unwrap();
        let conn = db.conn.lock().unwrap();
        conn.execute("UPDATE connectors SET approved_hash = 'forged'", []).unwrap();
    }
    let fresh = Hub::detached(Db::open(&dir).unwrap(), Box::new(MemoryKeys::default()), Events::to_sink(|_, _| {}), dir.join("work"));
    let c = fresh.connector(&saved.id).unwrap();
    assert_eq!(c.trust, Trust::ChangedOutside);
    assert_eq!(c.approved_hash, None);

    // Approving its tools would sign settings the user has not seen: refused until the user saves it.
    fresh.set_state(&saved.id, State::Changed { tools: vec![], hash: "h".into() }, None);
    let refused = fresh.approve(&saved.id, "h").unwrap_err();
    assert!(refused.starts_with("Review and save this connector first"), "{refused}");
    assert_eq!(fresh.connector(&saved.id).unwrap().trust, Trust::ChangedOutside, "nothing was signed");
    fresh.save(c).await.unwrap();
    assert_eq!(fresh.approve(&saved.id, "h").unwrap().trust, Trust::Ok, "saved, so reviewed");

    // Removing it removes its secret too.
    hub.remove(&saved.id).await.unwrap();
    assert!(hub.connectors().unwrap().is_empty());
    assert!(hub.keys.secret(&format!("connector:{}:X-Key", saved.id)).unwrap().is_none());
}

/// An agent reaches a real MCP server only through its own tool server, and
/// each call follows its setting for the connector.
#[tokio::test]
async fn calls_go_through_the_gateway_and_follow_the_agents_setting() {
    let dir = temp("gateway");
    let tools = Arc::new(Mutex::new(vec![tool("echo", "Echoes text.")]));
    let url = stub_server(tools.clone()).await;
    let broker = Arc::new(Broker::default());
    let (events, seen) = events(broker.clone());
    let hub = hub(&dir, events.clone());

    let c = hub.save(url_connector(&url, "s3cret")).await.unwrap();
    let State::Changed { hash, tools: listed } = hub.test(&c.id).await.unwrap() else { panic!("never approved, so changed") };
    assert_eq!(listed[0].name, "echo");
    hub.approve(&c.id, &hash).unwrap();
    assert!(matches!(hub.state(&c.id), State::Ok { .. }));
    assert!(seen.log.lock().unwrap().iter().any(|l| l.starts_with("connector://state")));

    let rt = AgentRuntime::new(agent(&[(&c.id, Setting::Ask)]), events, broker);
    let gw = Gateway::new(hub.clone(), rt.clone());
    assert_eq!(gw.refresh().await.len(), 1);
    let cancel = CancellationToken::new();
    let root = dir.canonicalize().unwrap();
    let addr = tools::serve(BlixelTools::new(rt.clone(), root), gw.router(), "tok".into(), cancel.clone()).await.unwrap();
    let endpoint = format!("http://{addr}/c/stub/mcp");

    let wrong = StreamableHttpClientTransport::from_config(StreamableHttpClientTransportConfig::with_uri(endpoint.clone()).auth_header("nope"));
    assert!(().serve(wrong).await.is_err(), "the token is needed here too");
    let client = ().serve(StreamableHttpClientTransport::from_config(StreamableHttpClientTransportConfig::with_uri(endpoint.clone()).auth_header("tok")))
        .await
        .unwrap();
    let names: Vec<String> = client.list_all_tools().await.unwrap().into_iter().map(|t| t.name.to_string()).collect();
    assert_eq!(names, vec!["echo"]);

    let call = |text: &str| CallToolRequestParams::new("echo").with_arguments(serde_json::json!({ "text": text }).as_object().unwrap().clone());
    let ok = |r: &CallToolResult| r.is_error != Some(true);

    // Ask: the user is asked, with "Always allow" offered; No refuses.
    *seen.answer.lock().unwrap() = Answer::Denied;
    let r = client.call_tool(call("one")).await.unwrap();
    assert!(!ok(&r), "{r:?}");
    assert_eq!(*seen.asked.lock().unwrap(), vec![true]);

    // "Always allow" sets the connector to Allow and tells the interface.
    *seen.answer.lock().unwrap() = Answer::Always;
    let r = client.call_tool(call("two")).await.unwrap();
    assert!(ok(&r) && format!("{r:?}").contains("two"), "{r:?}");
    assert_eq!(rt.connector_setting(&c.id), Setting::Allow);
    assert!(seen.log.lock().unwrap().iter().any(|l| l.starts_with("agent://settings") && l.contains("\"connectors\"")));

    // Allow: no question.
    let r = client.call_tool(call("three")).await.unwrap();
    assert!(ok(&r));
    assert_eq!(seen.asked.lock().unwrap().len(), 2);

    // The server's tools change: every call asks again, without "Always allow".
    tools.lock().unwrap().push(tool("wipe", "Deletes everything."));
    gw.stop_client(&c.id).await;
    let r = client.call_tool(call("four")).await.unwrap();
    assert!(ok(&r));
    assert_eq!(*seen.asked.lock().unwrap(), vec![true, true, false]);
    assert!(matches!(hub.state(&c.id), State::Changed { .. }));

    // Every call is logged, with its arguments.
    let log = seen.log.lock().unwrap().join("\n");
    assert!(log.contains("\"verb\":\"CALL\"") && log.contains("Stub · echo") && log.contains("four"), "{log}");
    assert!(log.contains("\"result\":\"denied\""));

    // Off: the endpoint goes away, and a call that still arrives is refused.
    rt.config.write().unwrap().connectors.insert(c.id.clone(), Setting::Off);
    let r = client.call_tool(call("five")).await.unwrap();
    assert!(!ok(&r) && format!("{r:?}").contains("not allowed"), "{r:?}");
    assert!(gw.refresh().await.is_empty());
    let late = StreamableHttpClientTransport::from_config(StreamableHttpClientTransportConfig::with_uri(endpoint).auth_header("tok"));
    assert!(().serve(late).await.is_err(), "not exposed when Off");

    gw.stop().await;
    cancel.cancel();
}

#[tokio::test]
async fn a_rejected_token_needs_sign_in_and_stops_retries() {
    let dir = temp("signin");
    let url = stub_server(Arc::new(Mutex::new(vec![tool("echo", "")]))).await;
    let hub = hub(&dir, Events::to_sink(|_, _| {}));

    let unset = hub.save(url_connector(&url, "")).await.unwrap();
    let State::Failed { reason, retries_left } = hub.test(&unset.id).await.unwrap() else { panic!() };
    assert!(reason.contains("X-Key is not set"), "{reason}");
    assert_eq!(retries_left, 2);
    assert!(hub.start(&unset.id).await.is_err());
    assert!(hub.start(&unset.id).await.is_err());
    let stopped = hub.start(&unset.id).await.err().unwrap();
    assert!(stopped.contains("stopped after 3 failed starts"), "{stopped}");

    hub.set_secret(&unset.id, "X-Key", Some("wrong".into())).await.unwrap();
    assert!(matches!(hub.test(&unset.id).await.unwrap(), State::SignIn { .. }), "{:?}", hub.state(&unset.id));
    hub.set_secret(&unset.id, "X-Key", Some("s3cret".into())).await.unwrap();
    assert!(matches!(hub.test(&unset.id).await.unwrap(), State::Changed { .. }), "testing again starts over");
    assert!(hub.set_secret(&unset.id, "Other", Some("x".into())).await.is_err(), "only declared secrets");
}

/// A tiny MCP server for bash: one tool, `whoami`, that says $STUB_TOKEN and
/// its working folder. Anything it does not know gets "no such method".
pub const STUB_SCRIPT: &str = r#"while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"stub","version":"1"}}}\n' "$id" ;;
    *'"method":"tools/list"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"whoami","description":"Says the token.","inputSchema":{"type":"object"}}]}}\n' "$id" ;;
    *'"method":"tools/call"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"token=%s pwd=%s"}]}}\n' "$id" "$STUB_TOKEN" "$PWD" ;;
    *) [ -n "$id" ] && printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32601,"message":"no such method"}}\n' "$id" ;;
  esac
done
"#;

/// A local server: started by command, given its secret in its environment,
/// spoken to over stdio, and stopped with everything it started.
#[cfg(unix)]
#[tokio::test]
async fn a_local_server_runs_with_its_secret_and_stops() {
    let dir = temp("stdio");
    let script = dir.join("server.sh");
    std::fs::write(&script, STUB_SCRIPT).unwrap();
    let hub = hub(&dir, Events::to_sink(|_, _| {}));
    let c = hub
        .save(Connector {
            id: String::new(),
            slug: "local".into(),
            name: "Local".into(),
            template: None,
            created: 0,
            transport: Transport::Command {
                command: "bash".into(),
                args: vec![script.display().to_string()],
                env: vec![Var { name: "STUB_TOKEN".into(), value: "tkn-42".into(), secret: true, is_set: None }],
            },
            approved_hash: None,
            trust: Trust::Ok,
        })
        .await
        .unwrap();
    let live = tokio::time::timeout(Duration::from_secs(30), hub.start(&c.id)).await.unwrap().unwrap();
    assert_eq!(live.tools[0].name, "whoami");
    let r = live.call(CallToolRequestParams::new("whoami")).await.unwrap();
    let text = format!("{r:?}");
    assert!(text.contains("token=tkn-42"), "{text}");
    assert!(text.contains(&format!("pwd={}", dir.join("work").join(&c.id).display())), "runs outside any project: {text}");
    live.stop().await;
    assert!(live.is_closed());
}

/// What a local server prints is for the user: an agent is never told it,
/// since a server may print its token or connection string.
#[cfg(unix)]
#[tokio::test]
async fn what_a_server_prints_never_reaches_the_agent() {
    let dir = temp("stderr");
    let hub = hub(&dir, Events::to_sink(|_, _| {}));
    let c = hub
        .save(Connector {
            id: String::new(),
            slug: "leaky".into(),
            name: "Leaky".into(),
            template: None,
            created: 0,
            transport: Transport::Command {
                command: "bash".into(),
                args: vec!["-c".into(), "echo \"connecting to postgres://app:hunter2@db/prod\" >&2; exit 1".into()],
                env: vec![],
            },
            approved_hash: None,
            trust: Trust::Ok,
        })
        .await
        .unwrap();
    let told = tokio::time::timeout(Duration::from_secs(30), hub.start(&c.id)).await.unwrap().err().unwrap();
    assert!(!told.contains("hunter2") && told.contains("Connectors page"), "{told}");
    let State::Failed { reason, .. } = hub.state(&c.id) else { panic!("{:?}", hub.state(&c.id)) };
    assert!(reason.contains("hunter2"), "the user still sees why: {reason}");
    for _ in 0..2 {
        let _ = hub.start(&c.id).await;
    }
    let stopped = hub.start(&c.id).await.err().unwrap();
    assert!(stopped.contains("stopped after 3 failed starts") && !stopped.contains("hunter2"), "{stopped}");
}
