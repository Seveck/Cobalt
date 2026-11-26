//! Ingestion, Past-Life import, knowledge capsules (`.cbrain`) and universal backups
//! (`.cobalt-backup`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::enums::PastLifeSource;
use crate::ids::{Id, Timestamp};
use crate::model::Project;

pub const CAPSULE_EXT: &str = "cbrain";
pub const BACKUP_EXT: &str = "cobalt-backup";
/// Version of the archive layout of capsules and backups.
pub const TRANSFER_FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IngestRequest {
    /// Files or folders (drag & drop). Folders are walked honoring `.memoryignore`.
    pub paths: Vec<String>,
    pub project_id: Option<Id>,
    /// Mark the resulting `source_documents` as watched (`is_watched = 1`).
    #[serde(default)]
    pub watch: bool,
    /// Promote the resulting memories to reusable assets (with fallback snippet).
    #[serde(default)]
    pub mark_reusable: bool,
    /// Run OCR (`ocrs`) on images and scanned PDFs.
    #[serde(default = "default_true")]
    pub ocr: bool,
}

fn default_true() -> bool {
    true
}

/// Non-terminal stages of `IngestProgress::stage`.
pub const INGEST_STAGE_SCANNING: &str = "scanning";
pub const INGEST_STAGE_READING: &str = "reading";
pub const INGEST_STAGE_EMBEDDING: &str = "embedding";
pub const INGEST_STAGE_SAVING: &str = "saving";
/// Terminal stages: **every** job (UI-started, watcher, hooks) ends with exactly one of these.
pub const INGEST_STAGE_COMPLETED: &str = "completed";
pub const INGEST_STAGE_CANCELLED: &str = "cancelled";
pub const INGEST_STAGE_FAILED: &str = "failed";

/// Payload of `cobalt://ingest-progress`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IngestProgress {
    pub job_id: Id,
    pub processed: u64,
    pub total: u64,
    pub current_path: Option<String>,
    /// One of the `INGEST_STAGE_*` constants.
    pub stage: String,
    /// `true` for jobs Cobalt starts by itself (file watcher, CLI hooks, auto-watch).
    #[serde(default)]
    pub background: bool,
    /// Project the job belongs to, when known.
    #[serde(default)]
    pub project_id: Option<Id>,
    /// Estimated seconds left (from the recent chunk throughput), when known.
    #[serde(default)]
    pub eta_seconds: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IngestIssue {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct IngestReport {
    pub documents_created: u64,
    pub documents_updated: u64,
    pub documents_unchanged: u64,
    pub memories_created: u64,
    pub memories_superseded: u64,
    pub skipped_ignored: u64,
    pub redacted_secrets: u64,
    pub total_tokens: u64,
    pub errors: Vec<IngestIssue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PastLifeImportRequest {
    pub source: PastLifeSource,
    pub path: String,
    pub project_id: Option<Id>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PromoteFileRequest {
    pub path: String,
    pub project_id: Option<Id>,
    /// Optional human summary; generated from the file when `None`.
    pub summary: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CapsuleExportRequest {
    pub project_id: Option<Id>,
    /// Restrict to these memories (cluster export); empty = whole project.
    #[serde(default)]
    pub memory_ids: Vec<Id>,
    pub dest_path: String,
}

/// `manifest.json` inside a `.cbrain` (zstd) capsule.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CapsuleManifest {
    pub format_version: u32,
    pub schema_version: u32,
    pub app_version: String,
    pub created_at: Timestamp,
    pub project: Option<Project>,
    pub memory_count: u64,
    pub source_document_count: u64,
    pub embedding_model_id: String,
    pub dimensions: u32,
    /// SHA-256 per archive entry.
    pub checksums: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BackupExportRequest {
    pub dest_path: String,
    /// When set, the archive payload is encrypted with AES-256-GCM (Argon2id-derived key).
    pub password: Option<String>,
    #[serde(default = "default_true")]
    pub include_history: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct BackupCounts {
    pub projects: u64,
    pub branches: u64,
    pub source_documents: u64,
    pub memories: u64,
    pub memory_edges: u64,
    pub handoffs: u64,
    pub telemetry_logs: u64,
    pub snapshots: u64,
}

/// `manifest.json` inside a `.cobalt-backup` (engine-agnostic, zstd, optional encryption).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BackupManifest {
    pub format_version: u32,
    pub schema_version: u32,
    pub app_version: String,
    pub created_at: Timestamp,
    pub source_os: String,
    pub embedding_model_id: String,
    pub dimensions: u32,
    pub vector_engine: String,
    pub encrypted: bool,
    pub counts: BackupCounts,
    /// SHA-256 per archive entry (of the plaintext payload).
    pub checksums: BTreeMap<String, String>,
    /// Installed theme ids (packages are not included).
    pub theme_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BackupImportRequest {
    pub path: String,
    pub password: Option<String>,
}

/// Result of a non-destructive import (backup or capsule).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ImportReport {
    pub inserted: u64,
    /// Same UUID + same `content_hash`.
    pub skipped_identical: u64,
    /// Older versions marked `superseded` (by `updated_at`) with `version_reason`.
    pub superseded: u64,
    /// Semantic collisions (> import threshold) isolated in a review branch.
    pub isolated: u64,
    /// `import-<date>` branch name when `isolated > 0`.
    pub review_branch: Option<String>,
    pub reembedded: u64,
    pub projects_created: u64,
    pub warnings: Vec<String>,
}
