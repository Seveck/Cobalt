//! Tauri event names (backend -> frontend) and their small payloads.
//! Payload types of the remaining events live next to their domain DTOs.

use serde::{Deserialize, Serialize};

use crate::enums::{AiClient, CliActivityKind, McpTransport};
use crate::ids::{Id, Timestamp};

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
/// Payload: [`CliActivity`].
pub const EVENT_CLI_ACTIVITY: &str = "cobalt://cli-activity";
/// A theme was saved by the user or created by an AI (v1.12.0). Payload `ThemesChanged`.
pub const EVENT_THEMES_CHANGED: &str = "cobalt://themes-changed";
/// New or reviewed memory proposals (v1.14.0). Payload `ProposalsChanged`.
pub const EVENT_PROPOSALS_CHANGED: &str = "cobalt://proposals-changed";

/// Payload of `cobalt://proposals-changed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProposalsChanged {
    pub pending: u64,
}

/// Payload of `cobalt://themes-changed`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThemesChanged {
    pub theme_id: String,
    pub name: String,
    /// `cobalt-ui` for the editor, the AI client name for `create_theme`.
    pub source_client: String,
    pub applied: bool,
}

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

/// Something an AI CLI did, captured by hooks even if the AI never called Cobalt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CliActivity {
    pub timestamp: Timestamp,
    /// `claude-code`, `codex`, `git`…
    pub client_name: String,
    pub kind: CliActivityKind,
    pub project_id: Option<Id>,
    pub project_name: Option<String>,
    pub cwd: Option<String>,
    pub files: Vec<String>,
    /// Short human description (command line, commit subject, last message excerpt).
    pub detail: Option<String>,
}

/// State of one capture integration (Connectors panel).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CaptureStatus {
    pub integration: crate::enums::CaptureIntegration,
    /// `None` for project-level integrations (git).
    pub client: Option<AiClient>,
    pub project_id: Option<Id>,
    /// The client/project supports this integration on this machine.
    pub supported: bool,
    pub enabled: bool,
    /// File Cobalt edits to install it.
    pub path: Option<String>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CaptureToggleRequest {
    pub integration: crate::enums::CaptureIntegration,
    pub client: Option<AiClient>,
    pub project_id: Option<Id>,
    pub enable: bool,
}
