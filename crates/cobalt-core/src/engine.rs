//! `EngineManager` contracts: model catalog entries, verified downloads, sidecar status
//! and the atomic 1-Click engine/model swap.

use serde::{Deserialize, Serialize};

use crate::enums::{
    DownloadPhase, EmbeddingProvider, EngineKind, EngineState, EngineSwapPhase, HardwareTier,
    Quantization,
};
use crate::ids::{Id, Timestamp};

/// Embedding model known to Cobalt (ONNX via fastembed, or an Ollama model name).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EmbeddingModelSpec {
    /// Stable id, e.g. `all-minilm-l6-v2-int8`, `bge-small-en-v1.5`, `ollama:nomic-embed-text`.
    pub id: String,
    pub provider: EmbeddingProvider,
    pub display_name: String,
    pub dimensions: u32,
    /// Download size (0 for Ollama models, which Ollama manages).
    pub size_bytes: u64,
    pub quantization: Quantization,
    pub recommended_tier: HardwareTier,
    pub multilingual: bool,
}

/// A downloadable, SHA-256-verified artifact (model file or engine binary).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DownloadArtifact {
    pub id: String,
    pub url: String,
    /// Lowercase hex SHA-256 the download must match.
    pub sha256: String,
    pub size_bytes: u64,
    /// Destination relative to `~/.cobalt/` (e.g. `models/bge-small/model.onnx`).
    pub relative_dest: String,
    /// Archive to extract after verification (`tar.gz` / `zip`), if any.
    pub archive: Option<String>,
}

/// Payload of `cobalt://download-progress`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DownloadProgress {
    pub artifact_id: String,
    pub phase: DownloadPhase,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub attempt: u32,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EngineInstallRequest {
    pub engine: EngineKind,
    pub model_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EngineStatus {
    pub engine: EngineKind,
    pub engine_state: EngineState,
    pub model_id: String,
    pub model_state: EngineState,
    pub dimensions: u32,
    pub vector_count: u64,
    pub installed_bytes: u64,
    /// Local endpoint of a running sidecar (Qdrant), if any.
    pub sidecar_endpoint: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EngineSwapRequest {
    pub target_engine: EngineKind,
    pub target_model_id: String,
    /// Connection string for external Pro engines (LanceDB path, Qdrant/Chroma URL).
    pub external_endpoint: Option<String>,
}

/// Payload of `cobalt://engine-swap-progress`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EngineSwapProgress {
    pub swap_id: Id,
    pub phase: EngineSwapPhase,
    pub processed: u64,
    pub total: u64,
    /// Writes waiting in the daemon queue while the swap runs.
    pub queued_writes: u64,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EngineSwapReport {
    pub swap_id: Id,
    pub from_engine: EngineKind,
    pub to_engine: EngineKind,
    pub from_model_id: String,
    pub to_model_id: String,
    pub reembedded: u64,
    pub verified_count: u64,
    pub rolled_back: bool,
    pub started_at: Timestamp,
    pub finished_at: Timestamp,
    /// Disk that can be freed by removing the previous engine/model.
    pub reclaimable_bytes: u64,
}
