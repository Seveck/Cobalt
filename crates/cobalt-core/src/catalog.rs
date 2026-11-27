//! Built-in, revision-pinned catalog of embedding models and engine binaries.
//!
//! Every artifact has an immutable URL (Hugging Face `resolve/<commit>` or a GitHub release
//! asset), an exact size and a SHA-256 digest. The JSON lives in `catalog/*.json` and is
//! compiled into the binary; it is the single source used by the `EngineManager`, the
//! onboarding recommendation and `cobalt-embeddings`.

use std::path::Path;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::engine::{DownloadArtifact, EmbeddingModelSpec};
use crate::enums::EngineKind;
use crate::error::{CobaltError, Result};

const MODELS_JSON: &str = include_str!("../catalog/models.json");
const ENGINES_JSON: &str = include_str!("../catalog/engines.json");
const OCR_JSON: &str = include_str!("../catalog/ocr.json");

/// Default OCR model (detection + recognition) used for images and scanned PDFs.
pub const DEFAULT_OCR_MODEL: &str = "ocrs-latin";

/// An OCR model pair (text detection + recognition) under `~/.cobalt/models/<id>/`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OcrModelEntry {
    pub id: String,
    pub display_name: String,
    /// Scripts it reads, e.g. `latin` (Spanish, English, French…).
    pub languages: Vec<String>,
    pub size_bytes: u64,
    pub revision: String,
    /// Exactly two files: `…/text-detection.onnx` and `…/text-recognition.onnx`.
    pub files: Vec<DownloadArtifact>,
}

impl OcrModelEntry {
    /// The detection and recognition artifacts, in that order.
    pub fn detection_and_recognition(&self) -> Option<(&DownloadArtifact, &DownloadArtifact)> {
        let find = |suffix: &str| self.files.iter().find(|f| f.relative_dest.ends_with(suffix));
        Some((find("text-detection.onnx")?, find("text-recognition.onnx")?))
    }
}

#[derive(Debug, Clone, Deserialize)]
struct OcrFile {
    schema_version: u32,
    ocr_models: Vec<OcrModelEntry>,
}

/// One embedding model and the files it needs under `~/.cobalt/models/<id>/`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelEntry {
    pub spec: EmbeddingModelSpec,
    /// Pinned upstream commit.
    pub revision: String,
    pub files: Vec<DownloadArtifact>,
}

/// A downloadable engine binary for one target triple.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlatformBinary {
    /// Rust target triple, e.g. `x86_64-unknown-linux-gnu`.
    pub target: String,
    /// Executable name inside the extracted archive.
    pub executable: String,
    pub artifact: DownloadArtifact,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EngineEntry {
    pub engine: EngineKind,
    pub version: String,
    pub binaries: Vec<PlatformBinary>,
}

#[derive(Debug, Clone, Deserialize)]
struct ModelsFile {
    schema_version: u32,
    models: Vec<ModelEntry>,
}

#[derive(Debug, Clone, Deserialize)]
struct EnginesFile {
    schema_version: u32,
    engines: Vec<EngineEntry>,
}

#[derive(Debug, Clone)]
pub struct Catalog {
    models: Vec<ModelEntry>,
    engines: Vec<EngineEntry>,
    ocr_models: Vec<OcrModelEntry>,
}

static BUILTIN: OnceLock<Result<Catalog, String>> = OnceLock::new();

impl Catalog {
    /// Parses catalog JSON documents (used by `builtin()` and by tests).
    pub fn from_json(models_json: &str, engines_json: &str) -> Result<Self> {
        let models: ModelsFile = serde_json::from_str(models_json)?;
        let engines: EnginesFile = serde_json::from_str(engines_json)?;
        if models.schema_version != 1 || engines.schema_version != 1 {
            return Err(CobaltError::Unsupported("catalog schema version".into()));
        }
        let catalog = Self {
            models: models.models,
            engines: engines.engines,
            ocr_models: Vec::new(),
        };
        catalog.validate()?;
        Ok(catalog)
    }

    /// Adds the OCR catalog document (validated like model files).
    pub fn with_ocr_json(mut self, ocr_json: &str) -> Result<Self> {
        let ocr: OcrFile = serde_json::from_str(ocr_json)?;
        if ocr.schema_version != 1 {
            return Err(CobaltError::Unsupported("OCR catalog schema version".into()));
        }
        for model in &ocr.ocr_models {
            let total: u64 = model.files.iter().map(|f| f.size_bytes).sum();
            if total != model.size_bytes || model.detection_and_recognition().is_none() {
                return Err(CobaltError::Integrity(format!(
                    "OCR model {} must have detection + recognition files totalling size_bytes",
                    model.id
                )));
            }
            let expected_prefix = format!("models/{}/", model.id);
            for file in &model.files {
                validate_artifact(file)?;
                if !file.relative_dest.starts_with(&expected_prefix) {
                    return Err(CobaltError::Integrity(format!(
                        "{} must live under {expected_prefix}",
                        file.id
                    )));
                }
            }
        }
        self.ocr_models = ocr.ocr_models;
        Ok(self)
    }

    pub fn ocr_models(&self) -> &[OcrModelEntry] {
        &self.ocr_models
    }

    pub fn ocr_model(&self, id: &str) -> Option<&OcrModelEntry> {
        self.ocr_models.iter().find(|m| m.id == id)
    }

    /// The catalog compiled into this binary.
    pub fn builtin() -> Result<&'static Catalog> {
        BUILTIN
            .get_or_init(|| {
                Self::from_json(MODELS_JSON, ENGINES_JSON)
                    .and_then(|c| c.with_ocr_json(OCR_JSON))
                    .map_err(|e| e.to_string())
            })
            .as_ref()
            .map_err(|e| CobaltError::Internal(format!("invalid built-in catalog: {e}")))
    }

    pub fn models(&self) -> &[ModelEntry] {
        &self.models
    }

    pub fn model_specs(&self) -> Vec<EmbeddingModelSpec> {
        self.models.iter().map(|m| m.spec.clone()).collect()
    }

    pub fn model(&self, id: &str) -> Option<&ModelEntry> {
        self.models.iter().find(|m| m.spec.id == id)
    }

    pub fn engine(&self, engine: EngineKind) -> Option<&EngineEntry> {
        self.engines.iter().find(|e| e.engine == engine)
    }

    /// Binary of a downloadable engine for the running platform. `Ok(None)` for engines that
    /// need no download (bundled or external); `Err(Unsupported)` when the platform lacks one.
    pub fn engine_binary(&self, engine: EngineKind) -> Result<Option<&PlatformBinary>> {
        let Some(entry) = self.engine(engine) else {
            return Ok(None);
        };
        let target = current_target()
            .ok_or_else(|| CobaltError::Unsupported("unsupported platform".into()))?;
        entry
            .binaries
            .iter()
            .find(|b| b.target == target)
            .map(Some)
            .ok_or_else(|| CobaltError::Unsupported(format!("{engine} has no binary for {target}")))
    }

    /// Every artifact needed to run `engine` + `model_id` on this platform.
    pub fn artifacts_for(
        &self,
        engine: EngineKind,
        model_id: &str,
    ) -> Result<Vec<DownloadArtifact>> {
        let mut artifacts = Vec::new();
        if let Some(binary) = self.engine_binary(engine)? {
            artifacts.push(binary.artifact.clone());
        }
        if is_ollama_model(model_id) {
            return Ok(artifacts);
        }
        let model = self
            .model(model_id)
            .ok_or_else(|| CobaltError::NotFound(format!("embedding model '{model_id}'")))?;
        artifacts.extend(model.files.iter().cloned());
        Ok(artifacts)
    }

    fn validate(&self) -> Result<()> {
        for model in &self.models {
            if model.files.is_empty() {
                return Err(CobaltError::Integrity(format!(
                    "model {} has no files",
                    model.spec.id
                )));
            }
            let total: u64 = model.files.iter().map(|f| f.size_bytes).sum();
            if total != model.spec.size_bytes {
                return Err(CobaltError::Integrity(format!(
                    "model {} size mismatch ({total} != {})",
                    model.spec.id, model.spec.size_bytes
                )));
            }
            for file in &model.files {
                validate_artifact(file)?;
                let expected_prefix = format!("models/{}/", model.spec.id);
                if !file.relative_dest.starts_with(&expected_prefix) {
                    return Err(CobaltError::Integrity(format!(
                        "{} must live under {expected_prefix}",
                        file.id
                    )));
                }
            }
        }
        for engine in &self.engines {
            for binary in &engine.binaries {
                validate_artifact(&binary.artifact)?;
            }
        }
        Ok(())
    }
}

fn validate_artifact(a: &DownloadArtifact) -> Result<()> {
    let hex_ok = a.sha256.len() == 64 && a.sha256.bytes().all(|b| b.is_ascii_hexdigit());
    let url_ok = a.url.starts_with("https://");
    let dest_ok = is_safe_relative_path(&a.relative_dest);
    if hex_ok && url_ok && dest_ok && a.size_bytes > 0 {
        Ok(())
    } else {
        Err(CobaltError::Integrity(format!(
            "invalid catalog artifact {}",
            a.id
        )))
    }
}

/// `true` for model ids served by Ollama (`ollama:<name>`), which manages its own downloads.
pub fn is_ollama_model(model_id: &str) -> bool {
    model_id.starts_with("ollama:")
}

/// Relative path without `..`, root, prefixes or backslashes.
pub fn is_safe_relative_path(raw: &str) -> bool {
    if raw.is_empty() || raw.contains('\\') || raw.contains('\0') {
        return false;
    }
    Path::new(raw)
        .components()
        .all(|c| matches!(c, std::path::Component::Normal(_)))
}

/// Rust target triple of the running platform, as used by engine binaries.
pub fn current_target() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("x86_64-unknown-linux-gnu"),
        ("linux", "aarch64") => Some("aarch64-unknown-linux-gnu"),
        ("windows", "x86_64") => Some("x86_64-pc-windows-msvc"),
        ("macos", "aarch64") => Some("aarch64-apple-darwin"),
        ("macos", "x86_64") => Some("x86_64-apple-darwin"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{default_model_for_tier, prefixes_for_model};
    use crate::enums::{HardwareTier, Pooling};

    #[test]
    fn builtin_catalog_is_valid_and_has_defaults() {
        let catalog = Catalog::builtin().unwrap();
        let ocr = catalog.ocr_model(DEFAULT_OCR_MODEL).unwrap();
        assert!(ocr.detection_and_recognition().is_some());
        assert!(ocr.languages.iter().any(|l| l == "latin"));
        for tier in HardwareTier::ALL {
            let id = default_model_for_tier(*tier);
            let model = catalog
                .model(id)
                .unwrap_or_else(|| panic!("missing default {id}"));
            assert!(model.spec.multilingual, "{id} must be multilingual");
            assert!(
                model
                    .files
                    .iter()
                    .any(|f| f.relative_dest.ends_with("/model.onnx"))
            );
            assert!(
                model
                    .files
                    .iter()
                    .any(|f| f.relative_dest.ends_with("/tokenizer.json"))
            );
            let (q, d) = prefixes_for_model(id);
            assert_eq!(model.spec.query_prefix.as_deref(), q);
            assert_eq!(model.spec.document_prefix.as_deref(), d);
        }
        assert_eq!(catalog.model("bge-m3").unwrap().spec.pooling, Pooling::Cls);
        assert_eq!(
            catalog
                .model("multilingual-e5-small")
                .unwrap()
                .spec
                .dimensions,
            384
        );
        assert_eq!(
            catalog
                .model("multilingual-e5-base")
                .unwrap()
                .spec
                .dimensions,
            768
        );
    }

    #[test]
    fn artifacts_for_bundled_engine_are_only_model_files() {
        let catalog = Catalog::builtin().unwrap();
        let files = catalog
            .artifacts_for(EngineKind::SqliteVec, "multilingual-e5-small")
            .unwrap();
        assert!(files.iter().all(|f| f.relative_dest.starts_with("models/")));
        assert!(catalog.artifacts_for(EngineKind::Usearch, "nope").is_err());
        assert!(
            catalog
                .artifacts_for(EngineKind::SqliteVec, "ollama:nomic-embed-text")
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn qdrant_binary_exists_for_supported_desktop_targets() {
        let catalog = Catalog::builtin().unwrap();
        let entry = catalog.engine(EngineKind::QdrantSidecar).unwrap();
        for target in [
            "x86_64-unknown-linux-gnu",
            "x86_64-pc-windows-msvc",
            "aarch64-apple-darwin",
        ] {
            assert!(
                entry.binaries.iter().any(|b| b.target == target),
                "{target}"
            );
        }
    }

    #[test]
    fn rejects_unsafe_relative_paths() {
        assert!(is_safe_relative_path("models/a/model.onnx"));
        for bad in ["", "../x", "/etc/passwd", "a/../../b", "C:\\x", "a\\b"] {
            assert!(!is_safe_relative_path(bad), "{bad}");
        }
    }
}
