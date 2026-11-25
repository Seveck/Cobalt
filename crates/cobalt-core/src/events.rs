//! Tauri event names (backend -> frontend) and their small payloads.
//! Payload types of the remaining events live next to their domain DTOs.

use serde::{Deserialize, Serialize};

use crate::enums::McpTransport;
use crate::ids::Timestamp;

/// Payload: [`crate::telemetry::McpActivity`].
pub const EVENT_MCP_ACTIVITY: &str = "cobalt://mcp-activity";
/// Payload: [`crate::model::MemoryChanged`].
pub const EVENT_MEMORY_CHANGED: &str = "cobalt://memory-changed";
/// Payload: [`crate::engine::DownloadProgress`].
pub const EVENT_DOWNLOAD_PROGRESS: &str = "cobalt://download-progress";
/// Payload: [`crate::engine::EngineSwapProgress`].
pub const EVENT_ENGINE_SWAP_PROGRESS: &str = "cobalt://engine-swap-progress";
/// Payload: [`crate::transfer::IngestProgress`].
pub const EVENT_INGEST_PROGRESS: &str = "cobalt://ingest-progress";
/// Payload: [`ReadOnlyChanged`].
pub const EVENT_READ_ONLY_CHANGED: &str = "cobalt://read-only-changed";
/// Payload: [`crate::model::VaultStatus`].
pub const EVENT_VAULT_STATUS: &str = "cobalt://vault-status";
/// Payload: [`DaemonStatus`].
pub const EVENT_DAEMON_STATUS: &str = "cobalt://daemon-status";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadOnlyChanged {
    pub read_only: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConnectedClient {
    pub client_name: String,
    pub transport: McpTransport,
    pub connected_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DaemonStatus {
    pub running: bool,
    pub started_at: Timestamp,
    pub read_only: bool,
    pub http_port: Option<u16>,
    pub queued_writes: u64,
    pub clients: Vec<ConnectedClient>,
}
