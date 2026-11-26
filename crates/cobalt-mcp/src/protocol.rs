//! MCP JSON-RPC session, shared by every transport (local socket/stdio bridge, streamable
//! HTTP, legacy SSE). Implements `initialize`, `ping`, `tools/list`, `tools/call`,
//! `logging/setLevel` and asks the client for its `roots/list` when supported.

use std::sync::Arc;

use cobalt_core::error::CobaltError;
use cobalt_core::mcp::{SERVER_NAME, UNKNOWN_CLIENT};
use serde_json::{Value, json};

use crate::daemon::Daemon;
use crate::project::{ClientContext, uri_to_path};
use crate::tools::TOOLS;

/// Protocol revisions we speak (newest first).
pub const SUPPORTED_PROTOCOL_VERSIONS: [&str; 4] =
    ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const ROOTS_REQUEST_ID: &str = "cobalt-roots";

const INSTRUCTIONS: &str = "Cobalt is the user's persistent memory shared by all their AI tools. \
At session start call list_project_rules. Call search_memory before reading large files or asking \
for context again, and search_reusable_assets before writing boilerplate. Save durable decisions, \
fixes and preferences with save_memory (atomic, 1-4 lines). Use create_handoff when stopping mid-task \
and resume_handoff when asked to continue.";

const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;

pub struct Session {
    daemon: Arc<Daemon>,
    pub ctx: ClientContext,
    client_id: u64,
    roots_supported: bool,
}

impl Session {
    pub fn new(daemon: Arc<Daemon>, ctx: ClientContext) -> Self {
        let client_id = daemon.register_client(&ctx.client_name, ctx.transport);
        Self {
            daemon,
            ctx,
            client_id,
            roots_supported: false,
        }
    }

    /// Handles one raw JSON-RPC payload (single message or batch). Returns messages to send
    /// back (responses and server-initiated requests), possibly empty.
    pub async fn handle_raw(&mut self, raw: &str) -> Vec<Value> {
        match serde_json::from_str::<Value>(raw) {
            Ok(Value::Array(batch)) => {
                let mut out = Vec::new();
                for msg in batch {
                    out.extend(self.handle(msg).await);
                }
                out
            }
            Ok(msg) => self.handle(msg).await,
            Err(e) => vec![error_response(
                Value::Null,
                PARSE_ERROR,
                &format!("parse error: {e}"),
            )],
        }
    }

    pub async fn handle(&mut self, msg: Value) -> Vec<Value> {
        let id = msg.get("id").cloned();
        let method = msg.get("method").and_then(Value::as_str).map(str::to_owned);
        let params = msg.get("params").cloned().unwrap_or(Value::Null);

        let Some(method) = method else {
            // A response to one of our requests.
            if id.as_ref().and_then(Value::as_str) == Some(ROOTS_REQUEST_ID) {
                self.apply_roots(msg.get("result"));
            }
            return Vec::new();
        };

        match (method.as_str(), id) {
            ("notifications/initialized", None) | ("notifications/roots/list_changed", None) => {
                if self.roots_supported {
                    vec![roots_request()]
                } else {
                    Vec::new()
                }
            }
            (_, None) => Vec::new(), // other notifications (cancelled, progress...) are ignored
            ("initialize", Some(id)) => vec![self.initialize(id, &params)],
            ("ping", Some(id)) => vec![ok_response(id, json!({}))],
            ("logging/setLevel", Some(id)) => vec![ok_response(id, json!({}))],
            ("tools/list", Some(id)) => vec![ok_response(id, self.tools_list())],
            ("tools/call", Some(id)) => vec![self.tools_call(id, params).await],
            (_, Some(id)) => vec![error_response(
                id,
                METHOD_NOT_FOUND,
                &format!("method not found: {method}"),
            )],
        }
    }

    fn initialize(&mut self, id: Value, params: &Value) -> Value {
        if let Some(name) = params.pointer("/clientInfo/name").and_then(Value::as_str) {
            let name = name.trim();
            if !name.is_empty() {
                self.ctx.client_name = name.chars().take(64).collect();
                self.daemon
                    .rename_client(self.client_id, &self.ctx.client_name);
            }
        }
        self.roots_supported = params.pointer("/capabilities/roots").is_some();
        let requested = params
            .get("protocolVersion")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let version = SUPPORTED_PROTOCOL_VERSIONS
            .iter()
            .find(|v| **v == requested)
            .copied()
            .unwrap_or(SUPPORTED_PROTOCOL_VERSIONS[0]);
        ok_response(
            id,
            json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false }, "logging": {} },
                "serverInfo": { "name": SERVER_NAME, "title": "Cobalt", "version": env!("CARGO_PKG_VERSION") },
                "instructions": INSTRUCTIONS,
            }),
        )
    }

    fn tools_list(&self) -> Value {
        let tools: Vec<Value> = TOOLS
            .iter()
            .map(|spec| {
                json!({
                    "name": spec.name,
                    "description": self.daemon.tool_description(spec),
                    "inputSchema": crate::tools::input_schema(spec.name),
                    "annotations": {
                        "readOnlyHint": spec.read_only,
                        "destructiveHint": false,
                        "idempotentHint": spec.read_only,
                        "openWorldHint": false,
                    },
                })
            })
            .collect();
        json!({ "tools": tools })
    }

    async fn tools_call(&mut self, id: Value, params: Value) -> Value {
        let Some(name) = params.get("name").and_then(Value::as_str) else {
            return error_response(id, INVALID_PARAMS, "tools/call requires a tool name");
        };
        if !TOOLS.iter().any(|t| t.name == name) {
            return error_response(id, INVALID_PARAMS, &format!("unknown tool: {name}"));
        }
        let args = params.get("arguments").cloned().unwrap_or(Value::Null);
        match self.daemon.call_tool(name, args, &self.ctx).await {
            Ok(out) => ok_response(
                id,
                json!({
                    "content": [{ "type": "text", "text": out.text }],
                    "structuredContent": out.structured,
                    "isError": false,
                }),
            ),
            Err(err) => ok_response(id, tool_error(&err)),
        }
    }

    fn apply_roots(&mut self, result: Option<&Value>) {
        let Some(roots) = result
            .and_then(|r| r.get("roots"))
            .and_then(Value::as_array)
        else {
            return;
        };
        self.ctx.roots = roots
            .iter()
            .filter_map(|r| r.get("uri").and_then(Value::as_str))
            .filter_map(uri_to_path)
            .collect();
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.daemon.unregister_client(self.client_id);
    }
}

fn roots_request() -> Value {
    json!({ "jsonrpc": "2.0", "id": ROOTS_REQUEST_ID, "method": "roots/list" })
}

pub fn ok_response(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

pub fn error_response(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Tool failures are reported inside the result (`isError: true`) so the model can react.
fn tool_error(err: &CobaltError) -> Value {
    let payload = err.payload();
    let hint = match err {
        CobaltError::Engine(_) | CobaltError::Embedding(_) => {
            " (open the Cobalt app to finish installing the embedding model)"
        }
        CobaltError::ReadOnly => " (the user enabled Read-Only mode; do not retry writes)",
        _ => "",
    };
    json!({
        "content": [{ "type": "text", "text": format!("{}: {}{hint}", payload.kind_str(), payload.message) }],
        "structuredContent": payload,
        "isError": true,
    })
}

trait KindStr {
    fn kind_str(&self) -> String;
}

impl KindStr for cobalt_core::ErrorPayload {
    fn kind_str(&self) -> String {
        serde_json::to_value(self.kind)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_else(|| "internal".into())
    }
}

/// A message is a JSON-RPC request (expects a response) when it has both `method` and `id`.
pub fn is_request(msg: &Value) -> bool {
    msg.get("method").is_some() && msg.get("id").is_some()
}

/// Rejects payloads that are not JSON-RPC 2.0 objects/batches (used by HTTP).
pub fn validate_envelope(raw: &str) -> Result<Value, Value> {
    match serde_json::from_str::<Value>(raw) {
        Ok(v @ (Value::Object(_) | Value::Array(_))) => Ok(v),
        Ok(_) => Err(error_response(
            Value::Null,
            INVALID_REQUEST,
            "invalid request",
        )),
        Err(e) => Err(error_response(
            Value::Null,
            PARSE_ERROR,
            &format!("parse error: {e}"),
        )),
    }
}

pub fn default_client() -> String {
    UNKNOWN_CLIENT.to_owned()
}
