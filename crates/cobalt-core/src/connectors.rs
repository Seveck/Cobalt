//! 1-Click connector and MCP Doctor contracts.

use serde::{Deserialize, Serialize};

use crate::enums::{AiClient, CheckStatus, ConfigFormat};
use crate::ids::Timestamp;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConnectorStatus {
    pub client: AiClient,
    /// The client (or its config directory) was found on this machine.
    pub detected: bool,
    pub config_path: Option<String>,
    pub config_format: ConfigFormat,
    /// Cobalt's MCP entry is present and points to this binary.
    pub connected: bool,
    /// The entry exists but points to a missing / outdated binary.
    pub broken: bool,
    pub last_backup_path: Option<String>,
    pub error: Option<String>,
    /// Ready-to-paste block for `config_path` with this machine's real Cobalt executable and the
    /// client's own format (v1.9.0). Manual setup must show this, never a hand-written guess.
    #[serde(default)]
    pub manual_snippet: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConnectorToggleRequest {
    pub client: AiClient,
    pub enable: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConnectorToggleResult {
    pub status: ConnectorStatus,
    /// Timestamped `.bak` copy written before modifying the config.
    pub backup_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DoctorCheck {
    /// Stable id, e.g. `daemon.alive`, `sqlite.integrity`, `client.cursor.config`.
    pub id: String,
    /// i18n key of the human label.
    pub label_key: String,
    pub status: CheckStatus,
    pub detail: Option<String>,
    pub fixable: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DoctorReport {
    pub generated_at: Timestamp,
    pub healthy: bool,
    pub checks: Vec<DoctorCheck>,
}
