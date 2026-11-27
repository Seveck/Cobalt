//! Frozen service traits. `cobalt-store`, `cobalt-embeddings` and `cobalt-ingest` ([CODEX])
//! implement them; `cobalt-mcp` and `src-tauri` ([CLAUDE]) consume them as `Arc<dyn ...>`.
//!
//! All traits are object-safe (`async_trait`) and `Send + Sync`. Implementations own their
//! own synchronization: the SQLite writer is single-threaded behind a write queue, readers
//! use a WAL connection pool. Blocking work must run off the async executor
//! (`spawn_blocking` or a dedicated thread).

use std::sync::Arc;

use async_trait::async_trait;

use crate::config::AppSettings;
use crate::engine::{EmbeddingModelSpec, EngineSwapProgress, EngineSwapReport, EngineSwapRequest};
use crate::enums::{EngineKind, FileAvailability, TokenEncoding};
use crate::error::Result;
use crate::ids::{Id, Timestamp};
use crate::model::{
    Branch, BranchMergeReport, DecayReport, DuplicateCluster, GraphData, GraphQuery, Handoff,
    InstalledTheme, Memory, MemoryPatch, NewBranch, NewHandoff, NewMemory, NewProject,
    NewSourceDocument, Project, ProjectPatch, ProjectStats, SaveOutcome, Snapshot, SourceDocument,
    UpdateMemoryRequest,
};
use crate::search::{
    LibraryFilter, ReusableAsset, ReusableAssetQuery, SearchRequest, SearchResponse, VectorFilter,
    VectorHit, VectorRecord, WebContext, WebContextRequest,
};
use crate::telemetry::{
    NewTelemetryEvent, Page, ReturnedItem, TelemetryLog, TelemetryQuery, TelemetryRange,
    TelemetrySummary,
};
use crate::transfer::{
    BackupExportRequest, BackupImportRequest, BackupManifest, CapsuleExportRequest,
    CapsuleManifest, ImportReport, IngestProgress, IngestReport, IngestRequest,
    PastLifeImportRequest, PromoteFileRequest,
};

/// Progress callback (must be cheap and non-blocking; typically forwards to a Tauri event).
pub type ProgressSink<T> = Arc<dyn Fn(T) + Send + Sync>;

// ===================================================================== engines & models

/// Vector index behind the canonical SQLite store. Vectors are keyed by `memories.id`.
#[async_trait]
pub trait VectorStore: Send + Sync {
    fn kind(&self) -> EngineKind;
    fn dimensions(&self) -> usize;
    /// Insert or replace vectors (idempotent by `memory_id`).
    async fn upsert(&self, records: &[VectorRecord]) -> Result<()>;
    async fn delete(&self, memory_ids: &[Id]) -> Result<()>;
    /// Cosine top-k. Engines that cannot filter natively must over-fetch and post-filter.
    async fn search(
        &self,
        query: &[f32],
        top_k: usize,
        filter: &VectorFilter,
    ) -> Result<Vec<VectorHit>>;
    async fn count(&self) -> Result<u64>;
    /// Persist pending state (mmap flush, sidecar snapshot...).
    async fn flush(&self) -> Result<()>;
    /// Cheap liveness / integrity probe used by MCP Doctor and the engine swap.
    async fn health_check(&self) -> Result<()>;
}

/// Text embedding provider (fastembed ONNX or Ollama HTTP).
#[async_trait]
pub trait Embedder: Send + Sync {
    fn spec(&self) -> &EmbeddingModelSpec;
    /// L2-normalized embeddings, one per input, same order.
    async fn embed_documents(&self, texts: &[String]) -> Result<Vec<Vec<f32>>>;
    async fn embed_query(&self, text: &str) -> Result<Vec<f32>>;
}

/// Exact BPE token counting (`tiktoken-rs`). Synchronous and cheap.
pub trait TokenCounter: Send + Sync {
    fn encoding(&self) -> TokenEncoding;
    fn count(&self, text: &str) -> usize;
    /// Truncates on a token boundary to at most `max_tokens` tokens.
    fn truncate(&self, text: &str, max_tokens: usize) -> String;
}

// ===================================================================== canonical store

#[async_trait]
pub trait ProjectRepository: Send + Sync {
    async fn list_projects(&self, include_archived: bool) -> Result<Vec<ProjectStats>>;
    async fn get_project(&self, id: Id) -> Result<Option<Project>>;
    async fn find_project_by_name(&self, name: &str) -> Result<Option<Project>>;
    /// Longest `root_path` that is a prefix of `path` (path-component aware, case-insensitive
    /// on Windows/macOS). With `create_if_missing`, creates a project rooted at `path`
    /// named after its last component.
    async fn resolve_project_by_path(
        &self,
        path: &str,
        create_if_missing: bool,
    ) -> Result<Option<Project>>;
    async fn create_project(&self, new: NewProject) -> Result<Project>;
    async fn update_project(&self, id: Id, patch: ProjectPatch) -> Result<Project>;
}

#[async_trait]
pub trait SourceDocumentRepository: Send + Sync {
    /// Insert or update by `file_path`.
    async fn upsert_source_document(&self, doc: NewSourceDocument) -> Result<SourceDocument>;
    async fn get_source_document(&self, id: Id) -> Result<Option<SourceDocument>>;
    async fn find_source_document_by_path(&self, path: &str) -> Result<Option<SourceDocument>>;
    /// Re-hashes the file on disk and compares with `file_hash` / reusable snippets.
    async fn verify_source_document(&self, id: Id) -> Result<FileAvailability>;
    /// Points the document to a moved file (re-hashes it).
    async fn relink_source_document(&self, id: Id, new_path: &str) -> Result<SourceDocument>;
    async fn set_watched(&self, id: Id, watched: bool) -> Result<SourceDocument>;
    async fn list_watched(&self) -> Result<Vec<SourceDocument>>;
}

#[async_trait]
pub trait MemoryRepository: Send + Sync {
    /// Canonical write path: embedding, Check-Before-Write (`dedup_threshold` within the same
    /// project + branch), 3D coordinates, FTS5 + vector indexing, `supersedes` edges.
    async fn save_memory(&self, new: NewMemory) -> Result<SaveOutcome>;
    /// Creates a new version and marks the old one `superseded` with `version_reason`.
    async fn update_memory(&self, req: UpdateMemoryRequest) -> Result<SaveOutcome>;
    async fn patch_memory(&self, id: Id, patch: MemoryPatch) -> Result<Memory>;
    async fn get_memory(&self, id: Id) -> Result<Option<Memory>>;
    /// Version chain (oldest first) following `superseded_by`.
    async fn memory_history(&self, id: Id) -> Result<Vec<Memory>>;
    async fn delete_memory(&self, id: Id) -> Result<()>;
    /// Stores vault ciphertext (`content` becomes empty, FTS/vector entries removed).
    async fn set_encrypted_payload(
        &self,
        id: Id,
        ciphertext: Vec<u8>,
        nonce: Vec<u8>,
    ) -> Result<Memory>;
    /// Restores plaintext of a previously encrypted memory (re-indexes it).
    async fn clear_encrypted_payload(&self, id: Id, plaintext: String) -> Result<Memory>;
    /// Nuclear Laws for the project (+ global), active branch.
    async fn list_core_rules(&self, project_id: Option<Id>) -> Result<Vec<Memory>>;
    /// Active `preference` memories for the project (+ global).
    async fn list_preferences(&self, project_id: Option<Id>) -> Result<Vec<Memory>>;
    async fn graph(&self, query: GraphQuery) -> Result<GraphData>;
    /// Archives one memory recording `version_reason = reason` (`Conflict` for Nuclear Laws).
    async fn archive_memory(&self, id: Id, reason: &str) -> Result<Memory>;
    /// Most similar active memory in the scope with its calibrated similarity, if any reaches
    /// `min_similarity` (backup/capsule import collisions, contradiction checks).
    async fn find_similar(
        &self,
        content: &str,
        project_id: Option<Id>,
        min_similarity: f64,
    ) -> Result<Option<(Memory, f64)>>;
}

#[async_trait]
pub trait SearchService: Send + Sync {
    /// Hybrid search: vector + FTS5 BM25 fused with RRF, confidence weighting, pin boost.
    async fn search(&self, req: SearchRequest) -> Result<SearchResponse>;
    /// Cross-project search over `is_reusable = 1` only.
    async fn search_reusable(&self, query: ReusableAssetQuery) -> Result<Vec<ReusableAsset>>;
    async fn list_library(&self, filter: LibraryFilter) -> Result<Vec<ReusableAsset>>;
    /// Compresses the most relevant memories for a task under `max_tokens` (default 400).
    async fn build_web_context(&self, req: WebContextRequest) -> Result<WebContext>;
}

#[async_trait]
pub trait GovernanceService: Send + Sync {
    /// Applies the forgetting curve at `now` (never touches Nuclear Laws).
    async fn run_decay(&self, now: Timestamp) -> Result<DecayReport>;
    async fn find_duplicates(&self) -> Result<Vec<DuplicateCluster>>;
    /// Keeps `keep_id`, marks the others `superseded` by it.
    async fn merge_duplicates(&self, keep_id: Id, merge_ids: &[Id]) -> Result<Memory>;
    async fn archive_memories(&self, ids: &[Id]) -> Result<u64>;
    async fn restore_memories(&self, ids: &[Id]) -> Result<u64>;
}

#[async_trait]
pub trait BranchRepository: Send + Sync {
    async fn list_branches(&self) -> Result<Vec<Branch>>;
    async fn active_branch(&self) -> Result<Branch>;
    async fn create_branch(&self, new: NewBranch) -> Result<Branch>;
    async fn switch_branch(&self, id: Id) -> Result<Branch>;
    /// Merges `id` into `main` (Check-Before-Write semantics) and deletes the branch.
    async fn merge_branch(&self, id: Id) -> Result<BranchMergeReport>;
    /// Deletes the branch and its memories (never `main`).
    async fn discard_branch(&self, id: Id) -> Result<()>;
}

#[async_trait]
pub trait SnapshotRepository: Send + Sync {
    async fn list_snapshots(&self) -> Result<Vec<Snapshot>>;
    /// Uses the SQLite online backup API into `~/.cobalt/snapshots/`.
    async fn create_snapshot(&self, label: &str) -> Result<Snapshot>;
    /// Time-Travel: takes an automatic safety snapshot, then restores.
    async fn restore_snapshot(&self, id: Id) -> Result<Snapshot>;
    async fn delete_snapshot(&self, id: Id) -> Result<()>;
}

#[async_trait]
pub trait HandoffRepository: Send + Sync {
    async fn create_handoff(&self, new: NewHandoff) -> Result<Handoff>;
    /// Latest non-expired, non-consumed handoff of the project (or global); marks it
    /// `consumed_by = consumer`.
    async fn resume_handoff(
        &self,
        project_id: Option<Id>,
        consumer: &str,
    ) -> Result<Option<Handoff>>;
}

#[async_trait]
pub trait TelemetryRepository: Send + Sync {
    /// Computes `avoided_full_tokens` deduplicated by unique `source_doc_id`, stores the row
    /// and returns it (the caller emits `cobalt://mcp-activity`).
    async fn record_event(&self, event: NewTelemetryEvent) -> Result<TelemetryLog>;
    /// Pure accounting helper shared by `search` and `record_event`.
    async fn compute_avoided_tokens(&self, items: &[ReturnedItem]) -> Result<i64>;
    async fn query_telemetry(&self, query: TelemetryQuery) -> Result<Page<TelemetryLog>>;
    async fn get_telemetry_log(&self, id: Id) -> Result<Option<TelemetryLog>>;
    async fn telemetry_summary(&self, range: TelemetryRange) -> Result<TelemetrySummary>;
    /// Usage of a memory per client (from `returned_items_json`), most recent first.
    async fn memory_usage_by_client(&self, memory_id: Id) -> Result<Vec<crate::mcp::ClientUsage>>;
    /// Applies `RetentionSettings` (purges `content_snapshot`/`query_text` only).
    async fn apply_retention(&self) -> Result<u64>;
    /// Personal usage dashboard (contract v1.10.0).
    async fn usage_stats(
        &self,
        req: crate::telemetry::UsageStatsRequest,
    ) -> Result<crate::telemetry::UsageStats> {
        let _ = req;
        Err(crate::error::CobaltError::Unsupported(
            "usage statistics are not available in this store".into(),
        ))
    }
}

#[async_trait]
pub trait ConfigRepository: Send + Sync {
    async fn load_settings(&self) -> Result<AppSettings>;
    async fn save_settings(&self, settings: &AppSettings) -> Result<()>;
    async fn get_raw(&self, key: &str) -> Result<Option<serde_json::Value>>;
    async fn set_raw(&self, key: &str, value: serde_json::Value) -> Result<()>;
}

#[async_trait]
pub trait ThemeRepository: Send + Sync {
    async fn list_installed_themes(&self) -> Result<Vec<InstalledTheme>>;
    async fn record_installed_theme(&self, theme: InstalledTheme) -> Result<()>;
    async fn remove_installed_theme(&self, id: &str) -> Result<()>;
}

#[async_trait]
pub trait EngineMigrator: Send + Sync {
    /// 1-Click atomic swap: queue writes -> stage -> re-embed if dimensions changed ->
    /// verify count + probe query -> swap -> drain. Any failure rolls back automatically.
    async fn swap_engine(
        &self,
        req: EngineSwapRequest,
        progress: ProgressSink<EngineSwapProgress>,
    ) -> Result<EngineSwapReport>;
}

/// Everything the daemon needs from `cobalt-store`, as a single object.
pub trait CobaltStore:
    ProjectRepository
    + SourceDocumentRepository
    + MemoryRepository
    + SearchService
    + GovernanceService
    + BranchRepository
    + SnapshotRepository
    + HandoffRepository
    + TelemetryRepository
    + ConfigRepository
    + ThemeRepository
    + EngineMigrator
{
}

impl<T> CobaltStore for T where
    T: ProjectRepository
        + SourceDocumentRepository
        + MemoryRepository
        + SearchService
        + GovernanceService
        + BranchRepository
        + SnapshotRepository
        + HandoffRepository
        + TelemetryRepository
        + ConfigRepository
        + ThemeRepository
        + EngineMigrator
{
}

// ===================================================================== themes

/// Saves user/AI-made themes (contract v1.12.0). Implemented by the desktop app, which owns the
/// theme folder; the MCP daemon calls it for `create_theme`.
#[async_trait]
pub trait ThemeService: Send + Sync {
    /// Validates `manifest` exactly like a downloaded package (a WebP preview is generated from
    /// its colors), installs or replaces the user's theme with that id, optionally applies it,
    /// and emits `cobalt://themes-changed`.
    async fn save_custom_theme(
        &self,
        manifest: crate::theme::ThemeManifest,
        apply: bool,
        source_client: &str,
    ) -> Result<crate::model::InstalledTheme>;
}

// ===================================================================== ingestion

/// Local OCR (contract v1.7.0): text from an encoded image (PNG/JPEG/WebP/…). CPU-bound and
/// synchronous: callers run it on a blocking thread. Built from catalog-verified model files.
pub trait OcrEngine: Send + Sync {
    /// Recognized text in reading order (lines separated by `\n`); empty when no text is found.
    fn recognize(&self, image: &[u8]) -> Result<String>;
}

#[async_trait]
pub trait IngestService: Send + Sync {
    async fn ingest_paths(
        &self,
        req: IngestRequest,
        progress: ProgressSink<IngestProgress>,
    ) -> Result<IngestReport>;
    async fn import_past_life(
        &self,
        req: PastLifeImportRequest,
        progress: ProgressSink<IngestProgress>,
    ) -> Result<IngestReport>;
    async fn promote_file_to_reusable(&self, req: PromoteFileRequest) -> Result<Memory>;
    /// Requests cancellation of a running ingest/import job (`IngestProgress::job_id`).
    /// Documents already committed stay; the job stops before the next document.
    /// Returns `false` if no such job is running.
    async fn cancel_job(&self, job_id: Id) -> Result<bool>;
    /// Starts the `notify` watcher over `source_documents.is_watched = 1`.
    async fn start_watcher(&self) -> Result<()>;
    async fn stop_watcher(&self) -> Result<()>;
    async fn export_capsule(&self, req: CapsuleExportRequest) -> Result<CapsuleManifest>;
    async fn import_capsule(&self, path: &str) -> Result<ImportReport>;
    async fn export_backup(&self, req: BackupExportRequest) -> Result<BackupManifest>;
    async fn import_backup(&self, req: BackupImportRequest) -> Result<ImportReport>;
}

#[cfg(test)]
mod tests {
    use super::*;

    // Compile-time guarantee that every trait stays object-safe.
    #[allow(dead_code)]
    fn assert_object_safe(
        _: Option<Arc<dyn VectorStore>>,
        _: Option<Arc<dyn Embedder>>,
        _: Option<Arc<dyn TokenCounter>>,
        _: Option<Arc<dyn CobaltStore>>,
        _: Option<Arc<dyn IngestService>>,
    ) {
    }

    #[test]
    fn traits_are_object_safe() {
        assert_object_safe(None, None, None, None, None);
    }
}
