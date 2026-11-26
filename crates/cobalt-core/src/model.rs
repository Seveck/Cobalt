//! Canonical entities (1:1 with the 12 SQLite tables) and write/patch DTOs.
//!
//! Wire format: `snake_case` field names, ids as UUID strings, timestamps as RFC 3339,
//! blobs as base64 strings. Mirrored exactly in `src/types/contracts.ts`.

use serde::{Deserialize, Serialize};

use crate::enums::{
    DuplicateKind, EdgeType, HardwareTier, MemoryCategory, MemoryChangeKind, MemoryStatus,
    SourceType, WriteAction,
};
use crate::ids::{Id, Timestamp};

/// Serde helper: `Option<Vec<u8>>` <-> optional base64 string.
pub mod b64_opt {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &Option<Vec<u8>>, s: S) -> Result<S::Ok, S::Error> {
        match value {
            Some(bytes) => s.serialize_some(&STANDARD.encode(bytes)),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<u8>>, D::Error> {
        let raw: Option<String> = Option::deserialize(d)?;
        raw.map(|text| {
            STANDARD
                .decode(text.as_bytes())
                .map_err(serde::de::Error::custom)
        })
        .transpose()
    }
}

/// Serde helper for patch fields: absent = unchanged (`None`), `null` = clear (`Some(None)`),
/// value = set (`Some(Some(v))`). Use with `#[serde(default, skip_serializing_if = "Option::is_none", with = "double_option")]`.
pub mod double_option {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer, T: Serialize>(
        value: &Option<Option<T>>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        match value {
            Some(inner) => inner.serialize(s),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
        d: D,
    ) -> Result<Option<Option<T>>, D::Error> {
        Option::<T>::deserialize(d).map(Some)
    }
}

// ---------------------------------------------------------------------------------------
// 1. projects
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Project {
    pub id: Id,
    pub name: String,
    /// Absolute root path on disk used by MCP auto-detection (`cwd` / MCP roots).
    pub root_path: Option<String>,
    /// `#RRGGBB`, used consistently by `project_clusters` and the UI.
    pub color_hex: String,
    pub is_archived: bool,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewProject {
    pub name: String,
    pub root_path: Option<String>,
    /// When `None` the store assigns a deterministic color from the project name.
    pub color_hex: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ProjectPatch {
    pub name: Option<String>,
    /// `Some(None)` clears the root path.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "double_option"
    )]
    pub root_path: Option<Option<String>>,
    pub color_hex: Option<String>,
    pub is_archived: Option<bool>,
}

/// Project plus aggregate counters (library, `project_clusters`, settings).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectStats {
    pub project: Project,
    /// Active memories in the active branch.
    pub vector_count: u64,
    /// Sum of `memories.chunk_tokens` of those memories.
    pub total_tokens: u64,
    pub reusable_count: u64,
}

// ---------------------------------------------------------------------------------------
// 2. branches
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Branch {
    pub id: Id,
    pub name: String,
    pub parent_branch_id: Option<Id>,
    pub created_at: Timestamp,
    pub is_active: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewBranch {
    pub name: String,
    /// Defaults to the currently active branch.
    pub parent_branch_id: Option<Id>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BranchMergeReport {
    pub source_branch_id: Id,
    pub target_branch_id: Id,
    pub merged: u64,
    pub superseded: u64,
    pub skipped_duplicates: u64,
}

// ---------------------------------------------------------------------------------------
// 3. source_documents
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SourceDocument {
    pub id: Id,
    /// `None` = global.
    pub project_id: Option<Id>,
    pub file_path: String,
    pub is_dir: bool,
    pub source_type: SourceType,
    /// SHA-256 (lowercase hex) of the file content; `None` for directories.
    pub file_hash: Option<String>,
    /// Exact BPE token count of the whole file, counted once (no double counting).
    pub total_tokens: i64,
    pub is_watched: bool,
    pub updated_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewSourceDocument {
    pub project_id: Option<Id>,
    pub file_path: String,
    pub is_dir: bool,
    /// Inferred with `SourceType::from_path` when `None`.
    pub source_type: Option<SourceType>,
    pub file_hash: Option<String>,
    pub total_tokens: i64,
    pub is_watched: bool,
}

// ---------------------------------------------------------------------------------------
// 4. memories (canonical)
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Memory {
    pub id: Id,
    pub branch_id: Id,
    /// `None` = global.
    pub project_id: Option<Id>,
    pub source_doc_id: Option<Id>,
    /// Atomic summary (Context -> Decision -> Reason). Empty string when `is_encrypted`.
    pub content: String,
    /// SHA-256 (lowercase hex) of the plaintext content, used for dedup and backups.
    pub content_hash: String,
    pub source_type: SourceType,
    pub category: MemoryCategory,
    /// Certainty in `0.0..=1.0`.
    pub confidence: f64,
    pub status: MemoryStatus,
    pub superseded_by: Option<Id>,
    pub version_reason: Option<String>,
    /// "Nuclear Law": never decays, always injected first.
    pub is_core_pin: bool,
    pub is_reusable: bool,
    pub reusable_snippet: Option<String>,
    pub reuse_count: i64,
    pub is_encrypted: bool,
    #[serde(with = "b64_opt")]
    pub ciphertext: Option<Vec<u8>>,
    #[serde(with = "b64_opt")]
    pub nonce: Option<Vec<u8>>,
    pub chunk_tokens: i64,
    pub hit_count: i64,
    pub relevance_score: f64,
    pub pos_x: Option<f64>,
    pub pos_y: Option<f64>,
    pub pos_z: Option<f64>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub last_accessed_at: Option<Timestamp>,
    /// `clientInfo.name` of the MCP client (or `cobalt-ui`, `cobalt-quicknote`, `cobalt-ingest`).
    pub source_client: Option<String>,
}

/// Input of the canonical write path (MCP `save_memory`, quick note, inspector, ingest).
/// The store runs Check-Before-Write; callers run Secret Scrubber + Token Firewall first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewMemory {
    pub content: String,
    pub category: MemoryCategory,
    pub project_id: Option<Id>,
    /// `None` = active branch.
    pub branch_id: Option<Id>,
    pub source_doc_id: Option<Id>,
    /// Inferred from the linked source document or defaults to `note`.
    pub source_type: Option<SourceType>,
    /// Defaults to `1.0`.
    pub confidence: Option<f64>,
    pub is_core_pin: bool,
    pub is_reusable: bool,
    pub reusable_snippet: Option<String>,
    pub source_client: Option<String>,
}

/// Explicit new version of a memory (MCP `update_memory`): the old row becomes `superseded`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UpdateMemoryRequest {
    pub memory_id: Id,
    pub new_content: String,
    pub reason: String,
    pub confidence: Option<f64>,
    pub source_client: Option<String>,
}

/// In-place metadata edit from the inspector (does not create a new version).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MemoryPatch {
    pub category: Option<MemoryCategory>,
    pub confidence: Option<f64>,
    pub status: Option<MemoryStatus>,
    pub is_core_pin: Option<bool>,
    pub is_reusable: Option<bool>,
    /// `Some(None)` clears the snippet.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "double_option"
    )]
    pub reusable_snippet: Option<Option<String>>,
    /// `Some(None)` moves the memory to global.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "double_option"
    )]
    pub project_id: Option<Option<Id>>,
    pub branch_id: Option<Id>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SaveOutcome {
    pub action: WriteAction,
    pub memory: Memory,
    /// Previous version when `action` is `superseded` or `updated_existing`.
    pub previous_id: Option<Id>,
    /// Cosine similarity with the matched existing memory, if any.
    pub matched_similarity: Option<f64>,
    /// Number of secrets redacted by the Secret Scrubber before saving.
    pub redacted_secrets: u32,
    /// `true` when the Token Firewall trimmed the content.
    pub truncated: bool,
}

// ---------------------------------------------------------------------------------------
// 7. memory_edges
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryEdge {
    pub source_id: Id,
    pub target_id: Id,
    pub edge_type: EdgeType,
    pub weight: f64,
}

// ---------------------------------------------------------------------------------------
// 8. handoffs
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Handoff {
    pub id: Id,
    pub project_id: Option<Id>,
    pub source_client: String,
    /// < 250 tokens.
    pub summary: String,
    pub last_error: Option<String>,
    /// Stored as `open_files_json`.
    pub open_files: Vec<String>,
    pub created_at: Timestamp,
    pub expires_at: Timestamp,
    pub consumed_by: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewHandoff {
    pub project_id: Option<Id>,
    pub source_client: String,
    pub summary: String,
    pub last_error: Option<String>,
    pub open_files: Vec<String>,
    /// Defaults to 48 hours.
    pub ttl_hours: Option<u32>,
}

// ---------------------------------------------------------------------------------------
// 10. snapshots / 11. installed_themes
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Snapshot {
    pub id: Id,
    pub label: String,
    pub created_at: Timestamp,
    pub memory_count: i64,
    /// Database copy made with the SQLite online backup API.
    pub file_path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InstalledTheme {
    /// Theme id from `manifest.json` (not a UUID).
    pub id: String,
    pub name: String,
    pub author: String,
    pub version: String,
    pub size_bytes: i64,
    pub hardware_tier: HardwareTier,
    pub local_path: String,
    pub installed_at: Timestamp,
}

// ---------------------------------------------------------------------------------------
// Graph (3D visualizer) and governance DTOs
// ---------------------------------------------------------------------------------------

/// Lightweight memory projection for the 3D canvas (no full content, no ciphertext).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GraphNode {
    pub id: Id,
    pub branch_id: Id,
    pub project_id: Option<Id>,
    pub source_doc_id: Option<Id>,
    pub source_type: SourceType,
    pub category: MemoryCategory,
    pub status: MemoryStatus,
    pub confidence: f64,
    pub is_core_pin: bool,
    pub is_reusable: bool,
    pub is_encrypted: bool,
    pub reuse_count: i64,
    pub hit_count: i64,
    pub relevance_score: f64,
    pub chunk_tokens: i64,
    pub superseded_by: Option<Id>,
    /// Cached 3D projection (`pos_x`, `pos_y`, `pos_z`), inside a sphere of radius 100.
    pub position: Option<[f64; 3]>,
    /// First ~160 characters of the content (empty when encrypted).
    pub preview: String,
    pub updated_at: Timestamp,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct GraphQuery {
    /// `None` = active branch.
    pub branch_id: Option<Id>,
    pub include_archived: bool,
    pub include_superseded: bool,
    /// Minimum weight for `semantic` edges (defaults to the configured threshold).
    pub min_edge_weight: Option<f64>,
    /// Max nodes returned (most relevant first). `None` = no limit.
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<MemoryEdge>,
    pub projects: Vec<ProjectStats>,
    pub branch: Branch,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DuplicateCluster {
    pub kind: DuplicateKind,
    pub memory_ids: Vec<Id>,
    pub max_similarity: f64,
    /// Suggested survivor (highest confidence, then most recent).
    pub suggested_keep_id: Id,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecayReport {
    pub evaluated: u64,
    pub decayed: u64,
    pub archived: u64,
}

/// Payload of `cobalt://memory-changed`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryChanged {
    pub kind: MemoryChangeKind,
    pub memory_ids: Vec<Id>,
    pub source_client: Option<String>,
}

/// Bóveda (vault) status.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VaultStatus {
    pub initialized: bool,
    pub unlocked: bool,
    pub auto_lock_minutes: u32,
    pub encrypted_count: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::{MAIN_BRANCH_ID, new_id, now};

    #[test]
    fn memory_blobs_serialize_as_base64() {
        let m = Memory {
            id: new_id(),
            branch_id: MAIN_BRANCH_ID,
            project_id: None,
            source_doc_id: None,
            content: String::new(),
            content_hash: "abc".into(),
            source_type: SourceType::Note,
            category: MemoryCategory::Note,
            confidence: 1.0,
            status: MemoryStatus::Active,
            superseded_by: None,
            version_reason: None,
            is_core_pin: false,
            is_reusable: false,
            reusable_snippet: None,
            reuse_count: 0,
            is_encrypted: true,
            ciphertext: Some(vec![1, 2, 3]),
            nonce: Some(vec![9; 12]),
            chunk_tokens: 0,
            hit_count: 0,
            relevance_score: 1.0,
            pos_x: None,
            pos_y: None,
            pos_z: None,
            created_at: now(),
            updated_at: now(),
            last_accessed_at: None,
            source_client: None,
        };
        let json = serde_json::to_value(&m).unwrap();
        assert_eq!(json["ciphertext"], "AQID");
        let back: Memory = serde_json::from_value(json).unwrap();
        assert_eq!(back.ciphertext, Some(vec![1, 2, 3]));
        assert_eq!(back.nonce.map(|n| n.len()), Some(12));
    }
}

/// Everything the user must know before permanently deleting a memory (shown in the UI).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeletionImpact {
    pub memory_id: Id,
    pub preview: String,
    /// Nuclear Law: every AI loses this rule.
    pub is_core_pin: bool,
    /// Reusable asset: agents in other projects lose access to it.
    pub is_reusable: bool,
    pub reuse_count: i64,
    pub hit_count: i64,
    pub is_encrypted: bool,
    /// AI clients that used it (from telemetry), most recent first.
    pub used_by: Vec<crate::mcp::ClientUsage>,
    /// Versions in its history chain that are deleted with it (superseded predecessors).
    pub history_versions: u64,
    /// Snapshots created after it existed (they may still contain it; deleting does not
    /// touch them, so Time-Travel could bring it back until they are deleted).
    pub snapshots_possibly_containing: u64,
    /// i18n keys of the consequences that apply (`delete.consequence.*`).
    pub consequences: Vec<String>,
}
