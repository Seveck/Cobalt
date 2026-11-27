//! Local HTTP server on `127.0.0.1:<port>` (default 7437):
//! - `POST/DELETE /mcp`: MCP streamable HTTP (JSON responses, `Mcp-Session-Id` sessions).
//! - `GET /sse` + `POST /messages?sessionId=`: legacy HTTP+SSE MCP transport.
//! - `/api/v1/*`: REST API (bearer token = `~/.cobalt/daemon.token`), OpenAPI JSON at
//!   `/api/v1/openapi.json`, Swagger UI at `/api/v1/docs`.
//! - `GET /api/v1/ws?token=`: WebSocket stream of live daemon events.
//!
//! Every request with an `Origin` header must come from a loopback origin (DNS-rebinding
//! protection required by the MCP spec).

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use cobalt_core::enums::McpTransport;
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::model::NewMemory;
use cobalt_core::search::SearchRequest;
use cobalt_core::telemetry::TelemetryRange;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{Mutex, mpsc};
use tokio_stream::StreamExt as _;
use tokio_stream::wrappers::ReceiverStream;
use utoipa::OpenApi;
use utoipa_swagger_ui::SwaggerUi;

use crate::daemon::Daemon;
use crate::project::ClientContext;
use crate::protocol::{Session, is_request, validate_envelope};

const SESSION_HEADER: &str = "mcp-session-id";

type SharedSession = Arc<Mutex<Session>>;
type SseSessions = HashMap<String, (SharedSession, mpsc::Sender<Value>)>;

#[derive(Clone)]
struct AppCtx {
    daemon: Arc<Daemon>,
    token: Arc<String>,
    sessions: Arc<Mutex<HashMap<String, Arc<Mutex<Session>>>>>,
    sse: Arc<Mutex<SseSessions>>,
}

/// Running HTTP server; dropping it shuts it down.
pub struct HttpServer {
    pub addr: SocketAddr,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for HttpServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl HttpServer {
    pub async fn start(daemon: Arc<Daemon>, token: String, port: u16) -> Result<Self> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
        let addr = listener.local_addr()?;
        daemon.set_http_port(Some(addr.port()));
        let app = router(AppCtx {
            daemon,
            token: Arc::new(token),
            sessions: Arc::default(),
            sse: Arc::default(),
        });
        let task = tokio::spawn(async move {
            if let Err(err) = axum::serve(listener, app).await {
                tracing::error!(%err, "http server stopped");
            }
        });
        Ok(Self { addr, task })
    }
}

#[derive(OpenApi)]
#[openapi(
    info(title = "Cobalt local API", description = "Local REST API of the Cobalt daemon. DTOs are documented in docs/CONTRACTS.md (snake_case JSON). Authenticate with `Authorization: Bearer <~/.cobalt/daemon.token>`."),
    paths(api_health, api_status, api_search, api_get_memory, api_save_memory, api_telemetry_summary,
          api_list_tools, api_call_tool, api_hook, api_guide),
    modifiers(&BearerAuth)
)]
struct ApiDoc;

struct BearerAuth;

impl utoipa::Modify for BearerAuth {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        use utoipa::openapi::security::{HttpAuthScheme, HttpBuilder, SecurityScheme};
        let components = openapi.components.get_or_insert_with(Default::default);
        components.add_security_scheme(
            "bearer",
            SecurityScheme::Http(HttpBuilder::new().scheme(HttpAuthScheme::Bearer).build()),
        );
    }
}

fn router(ctx: AppCtx) -> Router {
    let api = Router::new()
        .route("/health", get(api_health))
        .route("/status", get(api_status))
        .route("/search", post(api_search))
        .route("/memories", post(api_save_memory))
        .route("/memories/{id}", get(api_get_memory))
        .route("/telemetry/summary", get(api_telemetry_summary))
        .route("/tools", get(api_list_tools))
        .route("/tools/{name}", post(api_call_tool))
        .route("/hooks/{source}", post(api_hook))
        .route("/guide", get(api_guide))
        .route("/ws", get(api_ws));
    Router::new()
        .route("/mcp", post(mcp_post).delete(mcp_delete).get(mcp_get))
        .route("/sse", get(sse_open))
        .route("/messages", post(sse_message))
        .nest("/api/v1", api)
        .merge(SwaggerUi::new("/api/v1/docs").url("/api/v1/openapi.json", ApiDoc::openapi()))
        .with_state(ctx)
}

// ------------------------------------------------------------------------ guards

fn origin_allowed(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get("origin").and_then(|o| o.to_str().ok()) else {
        return true;
    };
    let host = origin
        .split("://")
        .nth(1)
        .unwrap_or_default()
        .split(['/', ':'])
        .next()
        .unwrap_or_default();
    matches!(
        host,
        "127.0.0.1" | "localhost" | "[::1]" | "tauri.localhost"
    ) || origin.starts_with("tauri://")
}

fn forbidden() -> Response {
    (StatusCode::FORBIDDEN, "forbidden origin").into_response()
}

fn authorized(ctx: &AppCtx, headers: &HeaderMap, query_token: Option<&str>) -> bool {
    let bearer = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    let given = bearer.or(query_token).unwrap_or_default();
    given.len() == ctx.token.len()
        && given
            .bytes()
            .zip(ctx.token.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

fn api_error(err: CobaltError) -> Response {
    let status = match err.kind() {
        cobalt_core::ErrorKind::NotFound => StatusCode::NOT_FOUND,
        cobalt_core::ErrorKind::InvalidInput => StatusCode::BAD_REQUEST,
        cobalt_core::ErrorKind::ReadOnly | cobalt_core::ErrorKind::Conflict => StatusCode::CONFLICT,
        cobalt_core::ErrorKind::FirewallBlocked => StatusCode::TOO_MANY_REQUESTS,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (status, Json(err.payload())).into_response()
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "kind": "unauthorized", "message": "missing or invalid bearer token" })),
    )
        .into_response()
}

// ------------------------------------------------------------------------ MCP streamable HTTP

async fn mcp_get() -> Response {
    // We do not offer a standalone server->client SSE stream on /mcp.
    StatusCode::METHOD_NOT_ALLOWED.into_response()
}

async fn mcp_delete(State(ctx): State<AppCtx>, headers: HeaderMap) -> Response {
    if !origin_allowed(&headers) {
        return forbidden();
    }
    match headers.get(SESSION_HEADER).and_then(|v| v.to_str().ok()) {
        Some(id) if ctx.sessions.lock().await.remove(id).is_some() => {
            StatusCode::OK.into_response()
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn mcp_post(State(ctx): State<AppCtx>, headers: HeaderMap, body: String) -> Response {
    if !origin_allowed(&headers) {
        return forbidden();
    }
    let msg = match validate_envelope(&body) {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_REQUEST, Json(e)).into_response(),
    };
    let is_init = msg.get("method").and_then(Value::as_str) == Some("initialize");
    let session_id = headers
        .get(SESSION_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);

    let (sid, session) = if is_init {
        let sid = uuid::Uuid::new_v4().to_string();
        let session = Arc::new(Mutex::new(Session::new(
            ctx.daemon.clone(),
            ClientContext::new(McpTransport::StreamableHttp),
        )));
        ctx.sessions
            .lock()
            .await
            .insert(sid.clone(), session.clone());
        (sid, session)
    } else {
        let Some(sid) = session_id else {
            return (StatusCode::BAD_REQUEST, "missing Mcp-Session-Id").into_response();
        };
        let Some(session) = ctx.sessions.lock().await.get(&sid).cloned() else {
            return (StatusCode::NOT_FOUND, "unknown session").into_response();
        };
        (sid, session)
    };

    let expects_response = match &msg {
        Value::Array(items) => items.iter().any(is_request),
        other => is_request(other),
    };
    let out = session.lock().await.handle_raw(&body).await;
    // Server-initiated requests (roots/list) need a stream; over plain JSON we drop them.
    let responses: Vec<Value> = out
        .into_iter()
        .filter(|m| m.get("method").is_none())
        .collect();

    let mut response = if !expects_response || responses.is_empty() {
        StatusCode::ACCEPTED.into_response()
    } else if responses.len() == 1 && !msg.is_array() {
        Json(responses.into_iter().next().unwrap_or(Value::Null)).into_response()
    } else {
        Json(Value::Array(responses)).into_response()
    };
    if let Ok(v) = HeaderValue::from_str(&sid) {
        response.headers_mut().insert(SESSION_HEADER, v);
    }
    response
}

// ------------------------------------------------------------------------ legacy SSE

#[derive(Deserialize)]
struct SessionQuery {
    #[serde(rename = "sessionId")]
    session_id: String,
}

async fn sse_open(State(ctx): State<AppCtx>, headers: HeaderMap) -> Response {
    if !origin_allowed(&headers) {
        return forbidden();
    }
    let sid = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel::<Value>(64);
    let session = Arc::new(Mutex::new(Session::new(
        ctx.daemon.clone(),
        ClientContext::new(McpTransport::Sse),
    )));
    ctx.sse.lock().await.insert(sid.clone(), (session, tx));
    let endpoint = Event::default()
        .event("endpoint")
        .data(format!("/messages?sessionId={sid}"));
    let messages = ReceiverStream::new(rx)
        .map(|v| Ok::<_, Infallible>(Event::default().event("message").data(v.to_string())));
    let stream = tokio_stream::once(Ok(endpoint)).chain(messages);
    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}

async fn sse_message(
    State(ctx): State<AppCtx>,
    headers: HeaderMap,
    Query(q): Query<SessionQuery>,
    body: String,
) -> Response {
    if !origin_allowed(&headers) {
        return forbidden();
    }
    let Some((session, tx)) = ctx.sse.lock().await.get(&q.session_id).cloned() else {
        return (StatusCode::NOT_FOUND, "unknown session").into_response();
    };
    let out = session.lock().await.handle_raw(&body).await;
    for msg in out {
        if tx.send(msg).await.is_err() {
            ctx.sse.lock().await.remove(&q.session_id);
            return StatusCode::GONE.into_response();
        }
    }
    StatusCode::ACCEPTED.into_response()
}

// ------------------------------------------------------------------------ REST API

#[utoipa::path(get, path = "/api/v1/health", responses((status = 200, description = "Daemon is alive")))]
async fn api_health() -> Json<Value> {
    Json(json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION") }))
}

#[utoipa::path(get, path = "/api/v1/status", security(("bearer" = [])),
    responses((status = 200, description = "DaemonStatus", body = Object)))]
async fn api_status(State(ctx): State<AppCtx>, headers: HeaderMap) -> Response {
    if !authorized(&ctx, &headers, None) {
        return unauthorized();
    }
    Json(ctx.daemon.status()).into_response()
}

#[utoipa::path(post, path = "/api/v1/search", security(("bearer" = [])),
    request_body(content = Object, description = "SearchRequest"),
    responses((status = 200, description = "SearchResponse", body = Object)))]
async fn api_search(
    State(ctx): State<AppCtx>,
    headers: HeaderMap,
    Json(req): Json<SearchRequest>,
) -> Response {
    if !authorized(&ctx, &headers, None) {
        return unauthorized();
    }
    match ctx.daemon.store().search(req).await {
        Ok(r) => Json(r).into_response(),
        Err(e) => api_error(e),
    }
}

#[utoipa::path(get, path = "/api/v1/memories/{id}", security(("bearer" = [])),
    params(("id" = String, Path, description = "Memory UUID")),
    responses((status = 200, description = "Memory", body = Object), (status = 404, description = "Not found")))]
async fn api_get_memory(
    State(ctx): State<AppCtx>,
    headers: HeaderMap,
    Path(id): Path<uuid::Uuid>,
) -> Response {
    if !authorized(&ctx, &headers, None) {
        return unauthorized();
    }
    match ctx.daemon.store().get_memory(id).await {
        Ok(Some(m)) => Json(m).into_response(),
        Ok(None) => api_error(CobaltError::NotFound(format!("memory {id}"))),
        Err(e) => api_error(e),
    }
}

#[utoipa::path(post, path = "/api/v1/memories", security(("bearer" = [])),
    request_body(content = Object, description = "NewMemory (scrubbed, firewalled, Check-Before-Write)"),
    responses((status = 200, description = "SaveOutcome", body = Object)))]
async fn api_save_memory(
    State(ctx): State<AppCtx>,
    headers: HeaderMap,
    Json(new): Json<NewMemory>,
) -> Response {
    if !authorized(&ctx, &headers, None) {
        return unauthorized();
    }
    match ctx.daemon.save_from_app(new, "rest-api").await {
        Ok(o) => Json(o).into_response(),
        Err(e) => api_error(e),
    }
}

#[utoipa::path(get, path = "/api/v1/telemetry/summary", security(("bearer" = [])),
    responses((status = 200, description = "TelemetrySummary", body = Object)))]
async fn api_telemetry_summary(State(ctx): State<AppCtx>, headers: HeaderMap) -> Response {
    if !authorized(&ctx, &headers, None) {
        return unauthorized();
    }
    match ctx
        .daemon
        .store()
        .telemetry_summary(TelemetryRange::default())
        .await
    {
        Ok(s) => Json(s).into_response(),
        Err(e) => api_error(e),
    }
}

// ------------------------------------------------------------------------ tools over REST

/// The AI guide, embedded so every installed Cobalt can teach any AI how to use it.
pub const AI_GUIDE: &str = include_str!("../../../docs/AI_GUIDE.md");

#[utoipa::path(get, path = "/api/v1/guide",
    responses((status = 200, description = "docs/AI_GUIDE.md (Markdown)", body = String)))]
async fn api_guide() -> Response {
    (
        [(
            axum::http::header::CONTENT_TYPE,
            HeaderValue::from_static("text/markdown; charset=utf-8"),
        )],
        AI_GUIDE,
    )
        .into_response()
}

#[derive(Deserialize)]
struct ToolsQuery {
    format: Option<String>,
}

#[utoipa::path(get, path = "/api/v1/tools", security(("bearer" = [])),
    params(("format" = Option<String>, Query, description = "`openai` = function-calling array (OpenAI / Ollama / llama.cpp)")),
    responses((status = 200, description = "Tool definitions with JSON Schemas", body = Object)))]
async fn api_list_tools(
    State(ctx): State<AppCtx>,
    headers: HeaderMap,
    Query(q): Query<ToolsQuery>,
) -> Response {
    if !authorized(&ctx, &headers, None) {
        return unauthorized();
    }
    let openai = q.format.as_deref() == Some("openai");
    let tools: Vec<Value> = crate::tools::TOOLS
        .iter()
        .map(|spec| {
            let description = ctx.daemon.tool_description(spec);
            let schema = crate::tools::input_schema(spec.name);
            if openai {
                json!({ "type": "function", "function": {
                    "name": spec.name, "description": description, "parameters": schema } })
            } else {
                json!({ "name": spec.name, "description": description,
                        "input_schema": schema, "read_only": spec.read_only })
            }
        })
        .collect();
    Json(json!({ "tools": tools })).into_response()
}

/// Caller identity for REST: `X-Cobalt-Client` (name shown to the user) and `X-Cobalt-Cwd`
/// (working directory used for project detection when `project` is omitted).
fn rest_context(headers: &HeaderMap) -> ClientContext {
    let mut ctx = ClientContext::new(McpTransport::StreamableHttp);
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            .filter(|v| !v.is_empty())
    };
    let client = header("x-cobalt-client")
        .map(crate::capture::client_label)
        .filter(|c| !c.is_empty());
    ctx.client_name = client.unwrap_or_else(|| "rest-api".into());
    ctx.cwd = header("x-cobalt-cwd").map(str::to_owned);
    ctx
}

#[utoipa::path(post, path = "/api/v1/tools/{name}", security(("bearer" = [])),
    params(("name" = String, Path, description = "Tool name, e.g. search_memory"),
           ("X-Cobalt-Client" = Option<String>, Header, description = "Your client name"),
           ("X-Cobalt-Cwd" = Option<String>, Header, description = "Working directory for project detection")),
    request_body(content = Object, description = "Tool arguments (same JSON Schema as MCP)"),
    responses((status = 200, description = "{ text, structured }", body = Object)))]
async fn api_call_tool(
    State(ctx): State<AppCtx>,
    headers: HeaderMap,
    Path(name): Path<String>,
    body: String,
) -> Response {
    if !authorized(&ctx, &headers, None) {
        return unauthorized();
    }
    if !crate::tools::TOOLS.iter().any(|t| t.name == name) {
        return api_error(CobaltError::NotFound(format!("tool '{name}'")));
    }
    let args: Value = if body.trim().is_empty() {
        json!({})
    } else {
        match serde_json::from_str(&body) {
            Ok(v) => v,
            Err(e) => return api_error(CobaltError::InvalidInput(format!("arguments: {e}"))),
        }
    };
    let client = rest_context(&headers);
    match ctx.daemon.call_tool(&name, args, &client).await {
        Ok(out) => Json(json!({ "text": out.text, "structured": out.structured })).into_response(),
        Err(e) => api_error(e),
    }
}

#[utoipa::path(post, path = "/api/v1/hooks/{source}", security(("bearer" = [])),
    params(("source" = String, Path, description = "Your tool name (generic event format) or claude/gemini/codex/git")),
    request_body(content = Object, description = "Event JSON (docs/CLI_CAPTURE.md §3.1)"),
    responses((status = 202, description = "Accepted")))]
async fn api_hook(
    State(ctx): State<AppCtx>,
    headers: HeaderMap,
    Path(source): Path<String>,
    Json(payload): Json<Value>,
) -> Response {
    if !authorized(&ctx, &headers, None) {
        return unauthorized();
    }
    let cwd = headers
        .get("x-cobalt-cwd")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let env = crate::capture::HookEnvelope {
        source,
        cwd,
        payload,
    };
    let daemon = ctx.daemon.clone();
    tokio::spawn(async move {
        if let Err(err) = daemon.handle_hook(env).await {
            tracing::debug!(%err, "REST hook ignored");
        }
    });
    StatusCode::ACCEPTED.into_response()
}

#[derive(Deserialize)]
struct WsQuery {
    token: Option<String>,
}

async fn api_ws(
    State(ctx): State<AppCtx>,
    headers: HeaderMap,
    Query(q): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    if !origin_allowed(&headers) {
        return forbidden();
    }
    if !authorized(&ctx, &headers, q.token.as_deref()) {
        return unauthorized();
    }
    let daemon = ctx.daemon.clone();
    ws.on_upgrade(move |socket| ws_loop(socket, daemon))
}

async fn ws_loop(mut socket: WebSocket, daemon: Arc<Daemon>) {
    let mut events = daemon.subscribe();
    loop {
        tokio::select! {
            ev = events.recv() => match ev {
                Ok(ev) => {
                    let Ok(text) = serde_json::to_string(&ev) else { continue };
                    if socket.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
        }
    }
}
