//! `EngineManager` contracts: model catalog entries, verified downloads, sidecar status
//! and the atomic 1-Click engine/model swap.

use serde::{Deserialize, Serialize};

use crate::enums::{
    DownloadPhase, EmbeddingProvider, EngineKind, EngineState, EngineSwapPhase, HardwareTier,
    Pooling, Quantization,
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
    /// Pooling applied to `last_hidden_state` (e5 = mean, bge = cls); output is L2-normalized.
    pub pooling: Pooling,
    /// Hugging Face repository of the ONNX weights (e.g. `intfloat/multilingual-e5-small`).
    pub hf_repo: Option<String>,
    /// Prepended to search queries before embedding (`"query: "` for the e5 family).
    pub query_prefix: Option<String>,
    /// Prepended to indexed documents before embedding (`"passage: "` for the e5 family).
    pub document_prefix: Option<String>,
}

// ---------------------------------------------------------------------------------------
// Default model catalog ids. Multilingual models are the default on every tier (Spanish +
// English memories); English-only models stay selectable in Pro mode.
// ---------------------------------------------------------------------------------------

/// Eco default: `intfloat/multilingual-e5-small`, 384 dims, INT8.
pub const MODEL_MULTILINGUAL_E5_SMALL: &str = "multilingual-e5-small";
/// Balanced default: `intfloat/multilingual-e5-base`, 768 dims.
pub const MODEL_MULTILINGUAL_E5_BASE: &str = "multilingual-e5-base";
/// Ultra default: `BAAI/bge-m3`, 1024 dims (no prefixes).
pub const MODEL_BGE_M3: &str = "bge-m3";
/// English-only models, Pro mode only.
pub const PRO_ENGLISH_MODELS: &[&str] =
    &["all-minilm-l6-v2", "bge-small-en-v1.5", "bge-large-en-v1.5"];

pub const E5_QUERY_PREFIX: &str = "query: ";
pub const E5_PASSAGE_PREFIX: &str = "passage: ";

/// Default embedding model for a hardware tier.
pub const fn default_model_for_tier(tier: HardwareTier) -> &'static str {
    match tier {
        HardwareTier::Eco => MODEL_MULTILINGUAL_E5_SMALL,
        HardwareTier::Balanced => MODEL_MULTILINGUAL_E5_BASE,
        HardwareTier::Ultra => MODEL_BGE_M3,
    }
}

/// Default vector engine for a hardware tier.
pub const fn default_engine_for_tier(tier: HardwareTier) -> EngineKind {
    match tier {
        HardwareTier::Eco => EngineKind::SqliteVec,
        HardwareTier::Balanced => EngineKind::Usearch,
        HardwareTier::Ultra => EngineKind::QdrantSidecar,
    }
}

/// `(query_prefix, document_prefix)` required by a model id. The e5 family
/// (`multilingual-e5-*`, `e5-*`) needs `"query: "` / `"passage: "`; others need none.
pub fn prefixes_for_model(model_id: &str) -> (Option<&'static str>, Option<&'static str>) {
    let id = model_id.to_ascii_lowercase();
    let is_e5 = id.starts_with("e5-") || id.contains("multilingual-e5") || id.contains("/e5-");
    if is_e5 {
        (Some(E5_QUERY_PREFIX), Some(E5_PASSAGE_PREFIX))
    } else {
        (None, None)
    }
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

/// OCR model state (`get_ocr_status`, `install_ocr`; contract v1.7.0). Downloads stream the
/// usual `cobalt://download-progress` events (artifact ids `<model>/<file>`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OcrStatus {
    pub model_id: String,
    pub engine: crate::enums::OcrEngineKind,
    pub display_name: String,
    /// Scripts it reads, e.g. `latin`.
    pub languages: Vec<String>,
    pub state: EngineState,
    pub size_bytes: u64,
    pub installed_bytes: u64,
    /// Selected in settings (`capture.ocr_model_id`); used once installed.
    pub active: bool,
}

/// Verified local files of an installed OCR model.
#[derive(Debug, Clone, PartialEq)]
pub struct OcrModelFiles {
    pub engine: crate::enums::OcrEngineKind,
    pub detection: std::path::PathBuf,
    pub recognition: std::path::PathBuf,
    /// PaddleOCR character dictionary (`inference.yml`).
    pub dictionary: Option<std::path::PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OcrInstallRequest {
    pub model_id: String,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multilingual_defaults_per_tier() {
        assert_eq!(
            default_model_for_tier(HardwareTier::Eco),
            "multilingual-e5-small"
        );
        assert_eq!(
            default_model_for_tier(HardwareTier::Balanced),
            "multilingual-e5-base"
        );
        assert_eq!(default_model_for_tier(HardwareTier::Ultra), "bge-m3");
        assert_eq!(
            default_engine_for_tier(HardwareTier::Balanced),
            EngineKind::Usearch
        );
    }

    #[test]
    fn e5_models_get_prefixes_others_do_not() {
        assert_eq!(
            prefixes_for_model("multilingual-e5-small"),
            (Some("query: "), Some("passage: "))
        );
        assert_eq!(
            prefixes_for_model("intfloat/multilingual-e5-base"),
            (Some("query: "), Some("passage: "))
        );
        assert_eq!(prefixes_for_model("bge-m3"), (None, None));
        assert_eq!(prefixes_for_model("all-minilm-l6-v2"), (None, None));
    }
}
