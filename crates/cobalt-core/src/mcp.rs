//! MCP tool contracts: names, argument and structured-output DTOs of the 7 tools.
//! JSON Schemas and the exact docstrings live in `docs/MCP_SPEC.md`.

use serde::{Deserialize, Serialize};

use crate::enums::{MemoryCategory, SourceType, WriteAction};
use crate::ids::{Id, Timestamp};
use crate::model::Handoff;
use crate::search::{ReusableAsset, TokenSavings};

pub const TOOL_SEARCH_MEMORY: &str = "search_memory";
pub const TOOL_SEARCH_REUSABLE_ASSETS: &str = "search_reusable_assets";
pub const TOOL_SAVE_MEMORY: &str = "save_memory";
pub const TOOL_UPDATE_MEMORY: &str = "update_memory";
pub const TOOL_CREATE_HANDOFF: &str = "create_handoff";
pub const TOOL_RESUME_HANDOFF: &str = "resume_handoff";
pub const TOOL_LIST_PROJECT_RULES: &str = "list_project_rules";
pub const TOOL_ARCHIVE_MEMORY: &str = "archive_memory";

/// The 8 tools, in the order they are advertised by `tools/list`.
pub const ALL_TOOLS: [&str; 8] = [
    TOOL_SEARCH_MEMORY,
    TOOL_SEARCH_REUSABLE_ASSETS,
    TOOL_SAVE_MEMORY,
    TOOL_UPDATE_MEMORY,
    TOOL_CREATE_HANDOFF,
    TOOL_RESUME_HANDOFF,
    TOOL_LIST_PROJECT_RULES,
    TOOL_ARCHIVE_MEMORY,
];

/// A dry run must precede `archive_memory(confirm = true)` within this many seconds.
pub const ARCHIVE_CONFIRM_WINDOW_SECS: u64 = 600;

/// MCP server name advertised in `initialize`.
pub const SERVER_NAME: &str = "cobalt";
/// Handoff capsules must stay below this many tokens.
pub const HANDOFF_MAX_TOKENS: u32 = 250;
/// Web AI bridge budget.
pub const WEB_CONTEXT_MAX_TOKENS: u32 = 400;
/// Target size of a reusable-asset interface summary.
pub const REUSABLE_SUMMARY_TOKENS: u32 = 50;
/// Hard cap of `top_k` accepted from clients.
pub const MAX_TOP_K: u32 = 50;
/// Client name used when the MCP handshake did not provide `clientInfo.name`.
pub const UNKNOWN_CLIENT: &str = "unknown";

// ----------------------------------------------------------------------------- arguments

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SearchMemoryArgs {
    pub query: String,
    /// Project name or absolute path; omitted = auto-resolved from MCP roots / cwd.
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub include_archived: Option<bool>,
    #[serde(default)]
    pub top_k: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SearchReusableAssetsArgs {
    pub query: String,
    #[serde(default)]
    pub source_type: Option<SourceType>,
    #[serde(default)]
    pub exclude_current_project: Option<bool>,
    #[serde(default)]
    pub top_k: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SaveMemoryArgs {
    pub content: String,
    pub category: MemoryCategory,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub original_file_path: Option<String>,
    #[serde(default)]
    pub source_type: Option<SourceType>,
    #[serde(default)]
    pub confidence: Option<f64>,
    #[serde(default)]
    pub is_reusable: Option<bool>,
    #[serde(default)]
    pub reusable_snippet: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UpdateMemoryArgs {
    pub memory_id: Id,
    pub new_content: String,
    pub reason: String,
    #[serde(default)]
    pub confidence: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CreateHandoffArgs {
    pub summary: String,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub open_files: Option<Vec<String>>,
    #[serde(default)]
    pub project: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ResumeHandoffArgs {
    #[serde(default)]
    pub project: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ListProjectRulesArgs {
    #[serde(default)]
    pub project: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArchiveMemoryArgs {
    pub memory_id: Id,
    pub reason: String,
    /// `false` (default) = dry run returning the impact; `true` = archive (after user consent).
    #[serde(default)]
    pub confirm: Option<bool>,
}

// ----------------------------------------------------------------------- structured output

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResolvedProject {
    pub id: Id,
    pub name: String,
    pub root_path: Option<String>,
    /// `true` when the project was auto-created from an unknown root path.
    pub created: bool,
}

/// Token-lean memory representation returned to AIs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompactMemory {
    pub id: Id,
    pub content: String,
    pub category: MemoryCategory,
    pub source_type: SourceType,
    pub confidence: f64,
    pub similarity: Option<f64>,
    /// Project name, `None` = global.
    pub project: Option<String>,
    pub is_core_pin: bool,
    pub is_reusable: bool,
    pub file_path: Option<String>,
    pub updated_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SearchMemoryOutput {
    pub project: Option<ResolvedProject>,
    pub core_rules: Vec<CompactMemory>,
    pub results: Vec<CompactMemory>,
    pub savings: TokenSavings,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SearchReusableAssetsOutput {
    pub assets: Vec<ReusableAsset>,
    pub savings: TokenSavings,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SaveMemoryOutput {
    pub memory_id: Id,
    pub action: WriteAction,
    pub previous_id: Option<Id>,
    pub project: Option<ResolvedProject>,
    pub redacted_secrets: u32,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UpdateMemoryOutput {
    pub memory_id: Id,
    pub previous_id: Id,
    pub redacted_secrets: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CreateHandoffOutput {
    pub handoff_id: Id,
    pub expires_at: Timestamp,
    pub tokens: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResumeHandoffOutput {
    pub handoff: Option<Handoff>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ListProjectRulesOutput {
    pub project: Option<ResolvedProject>,
    /// Nuclear Laws (`is_core_pin = 1`) of the project + global.
    pub core_laws: Vec<CompactMemory>,
    /// Active `preference` memories of the project + global, highest confidence first.
    pub preferences: Vec<CompactMemory>,
}

/// How one AI client has used a memory (from telemetry `returned_items`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClientUsage {
    pub client_name: String,
    pub uses: u64,
    pub last_used_at: Timestamp,
}

/// Who depends on a memory: shown to the user before an agent archives it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArchiveImpact {
    pub memory_id: Id,
    pub preview: String,
    pub is_core_pin: bool,
    pub is_reusable: bool,
    pub hit_count: i64,
    pub reuse_count: i64,
    pub last_accessed_at: Option<Timestamp>,
    /// Clients other than the caller that read or reused this memory.
    pub other_clients: Vec<ClientUsage>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArchiveMemoryOutput {
    pub memory_id: Id,
    /// `false` for a dry run.
    pub archived: bool,
    pub impact: ArchiveImpact,
}
