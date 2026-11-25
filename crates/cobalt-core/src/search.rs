//! Hybrid search (vector + FTS5 BM25 fused with RRF), reusable assets and vector-engine DTOs.

use serde::{Deserialize, Serialize};

use crate::config::RrfWeights;
use crate::enums::{FileAvailability, MemoryCategory, MemoryStatus, SourceType};
use crate::ids::Id;
use crate::model::Memory;

/// Which projects a query or vector lookup may touch.
///
/// Wire format (adjacently tagged): `{ "kind": "all" }`,
/// `{ "kind": "project_and_global", "project_id": "<uuid>" }`, ...
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "project_id", rename_all = "snake_case")]
pub enum ProjectScope {
    /// Every project plus global.
    All,
    /// Only `project_id IS NULL`.
    #[default]
    Global,
    /// Only the given project.
    Project(Id),
    /// `project_id = <id> OR project_id IS NULL` (default for MCP `search_memory`).
    ProjectAndGlobal(Id),
    /// Every project except the given one (used by `search_reusable_assets`).
    AllExcept(Id),
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SearchFilter {
    /// Empty = any.
    #[serde(default)]
    pub source_types: Vec<SourceType>,
    /// Empty = any.
    #[serde(default)]
    pub categories: Vec<MemoryCategory>,
    #[serde(default)]
    pub only_reusable: bool,
    pub min_confidence: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SearchRequest {
    pub query: String,
    #[serde(default)]
    pub scope: ProjectScope,
    /// `None` = active branch.
    pub branch_id: Option<Id>,
    /// `None` = `AppSettings.search.top_k`.
    pub top_k: Option<u32>,
    #[serde(default)]
    pub include_archived: bool,
    #[serde(default)]
    pub filter: SearchFilter,
    /// Pro-mode / RAG debugger override of the configured RRF weights.
    pub rrf_override: Option<RrfWeights>,
    /// `true` for real retrievals (MCP): bumps `hit_count` / `last_accessed_at`.
    /// `false` for the RAG debugger / simulator.
    #[serde(default)]
    pub record_hits: bool,
}

/// One fused result with full scoring breakdown (also used by the RAG debugger).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SearchHit {
    pub memory: Memory,
    /// Final score after RRF fusion, confidence weighting and core-pin boost.
    pub score: f64,
    /// Cosine similarity in `0.0..=1.0` (0 when only matched by FTS5).
    pub similarity_score: f64,
    /// 1-based rank in the vector result list.
    pub vector_rank: Option<u32>,
    /// 1-based rank in the FTS5 result list.
    pub fts_rank: Option<u32>,
    /// Raw FTS5 `bm25()` value (lower = better, SQLite convention).
    pub bm25: Option<f64>,
    /// RRF contribution before confidence / pin adjustments.
    pub rrf_score: f64,
}

/// Honest token accounting (deduplicated by unique `source_doc_id`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenSavings {
    /// Tokens actually injected into the AI context.
    pub injected_tokens: i64,
    /// Sum of `source_documents.total_tokens` counted once per unique source document
    /// (memories without a source document count their own `chunk_tokens`).
    pub avoided_full_tokens: i64,
    /// `max(0, avoided_full_tokens - injected_tokens)` (+ output tokens for `reuse`).
    pub saved_tokens: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SearchResponse {
    pub hits: Vec<SearchHit>,
    /// Nuclear Laws of the resolved scope, always returned first by MCP.
    pub core_rules: Vec<Memory>,
    pub savings: TokenSavings,
    pub latency_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReusableAssetQuery {
    pub query: String,
    pub source_type: Option<SourceType>,
    /// Project resolved from the calling client; excluded when `exclude_current_project`.
    pub current_project_id: Option<Id>,
    #[serde(default)]
    pub exclude_current_project: bool,
    pub top_k: Option<u32>,
    /// `true` for MCP calls: increments `reuse_count` and logs `operation = 'reuse'`.
    #[serde(default)]
    pub record_reuse: bool,
}

/// Compact cross-project reusable asset (MCP `search_reusable_assets` and the Library).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReusableAsset {
    pub memory_id: Id,
    /// ~50-token interface summary.
    pub summary: String,
    pub source_type: SourceType,
    pub origin_project_id: Option<Id>,
    pub origin_project_name: Option<String>,
    pub origin_project_color: Option<String>,
    pub source_doc_id: Option<Id>,
    /// Verified path from `source_documents` (present even if the file is gone).
    pub file_path: Option<String>,
    pub availability: FileAvailability,
    pub snippet: Option<String>,
    pub reuse_count: i64,
    /// Estimated output tokens saved by reusing instead of regenerating.
    pub output_tokens_saved: i64,
    /// Cosine similarity with the query (`1.0` for plain library listings).
    pub similarity_score: f64,
    pub status: MemoryStatus,
}

/// Filters of the visual Library tab.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LibraryFilter {
    /// Hybrid search text; `None` lists everything.
    pub query: Option<String>,
    #[serde(default)]
    pub source_types: Vec<SourceType>,
    #[serde(default)]
    pub project_ids: Vec<Id>,
    #[serde(default)]
    pub availability: Vec<FileAvailability>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

/// "Copy Smart Context" bridge for web AIs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WebContextRequest {
    pub task: String,
    pub project_id: Option<Id>,
    /// Hard cap, defaults to 400.
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WebContext {
    pub text: String,
    pub tokens: u32,
    pub memory_ids: Vec<Id>,
}

// ---------------------------------------------------------------------------------------
// VectorStore DTOs
// ---------------------------------------------------------------------------------------

/// One vector keyed by `memories.id` (never by SQLite rowid).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VectorRecord {
    pub memory_id: Id,
    pub vector: Vec<f32>,
    pub project_id: Option<Id>,
    pub branch_id: Id,
    pub is_reusable: bool,
    pub status: MemoryStatus,
}

/// Payload filter applied by the engine when supported, otherwise post-filtered by the store.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct VectorFilter {
    pub scope: ProjectScope,
    pub branch_id: Option<Id>,
    #[serde(default)]
    pub only_reusable: bool,
    #[serde(default)]
    pub include_archived: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct VectorHit {
    pub memory_id: Id,
    /// Cosine similarity in `0.0..=1.0`.
    pub similarity: f32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_scope_wire_format() {
        let id = crate::ids::new_id();
        let json = serde_json::to_value(ProjectScope::ProjectAndGlobal(id)).unwrap();
        assert_eq!(json["kind"], "project_and_global");
        assert_eq!(json["project_id"], id.to_string());
        let all = serde_json::to_value(ProjectScope::All).unwrap();
        assert_eq!(all, serde_json::json!({ "kind": "all" }));
        let back: ProjectScope =
            serde_json::from_value(serde_json::json!({ "kind": "global" })).unwrap();
        assert_eq!(back, ProjectScope::Global);
    }
}
