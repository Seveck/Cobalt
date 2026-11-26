use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use cobalt_core::catalog::{Catalog, ModelEntry};
use cobalt_core::engine::{EmbeddingModelSpec, MODEL_BGE_M3, default_model_for_tier};
use cobalt_core::enums::{HardwareTier, Quantization};
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::paths::home_path;
use cobalt_core::traits::Embedder;
use fastembed::{
    InitOptionsUserDefined, Pooling, QuantizationMode, TextEmbedding, TokenizerFiles,
    UserDefinedEmbeddingModel,
};

use crate::{normalize, one_vector, prefixed};

/// Returns the catalog specification for the built-in default of this tier.
pub fn default_model_spec(tier: HardwareTier) -> EmbeddingModelSpec {
    // The tier mapping and validated catalog are compiled together.
    catalog_entry(default_model_for_tier(tier))
        .expect("built-in catalog must contain the default model for every tier")
        .spec
        .clone()
}

fn catalog_entry(id: &str) -> Result<&'static ModelEntry> {
    Catalog::builtin()?
        .model(id)
        .ok_or_else(|| CobaltError::NotFound(format!("catalog model {id}")))
}

/// Local ONNX paths accepted by the compatibility constructor.
pub struct OnnxFiles {
    pub model: PathBuf,
    pub tokenizer_dir: PathBuf,
    pub external_initializers: Vec<(String, PathBuf)>,
    pub pooling: Pooling,
    pub quantization: QuantizationMode,
    pub max_length: usize,
}

struct CatalogFiles {
    model: PathBuf,
    tokenizer: PathBuf,
    config: PathBuf,
    special_tokens: PathBuf,
    tokenizer_config: PathBuf,
    external_initializers: Vec<(String, PathBuf)>,
    pooling: Pooling,
    quantization: QuantizationMode,
    max_length: usize,
}

/// Loads a fastembed model on the first nonempty embedding request.
pub struct FastembedEmbedder {
    spec: EmbeddingModelSpec,
    source: Arc<CatalogFiles>,
    model: Arc<Mutex<Option<TextEmbedding>>>,
    inference_slot: Arc<tokio::sync::Semaphore>,
}

impl FastembedEmbedder {
    pub fn for_tier(tier: HardwareTier) -> Result<Self> {
        Self::from_catalog(default_model_for_tier(tier))
    }

    pub fn new(spec: EmbeddingModelSpec) -> Result<Self> {
        let entry = catalog_entry(&spec.id)?;
        if spec != entry.spec {
            return Err(CobaltError::InvalidInput(format!(
                "model specification differs from catalog: {}",
                spec.id
            )));
        }
        Self::from_catalog(&spec.id)
    }

    /// Accepts the engine manager's existing paths after checking them against the catalog.
    /// Pooling and quantization always come from the catalog specification.
    pub fn from_onnx(spec: EmbeddingModelSpec, files: OnnxFiles) -> Result<Self> {
        let mut embedder = Self::new(spec)?;
        let source = Arc::get_mut(&mut embedder.source)
            .ok_or_else(|| CobaltError::Internal("new ONNX model files are shared".into()))?;
        let tokenizer_matches = [
            &source.tokenizer,
            &source.config,
            &source.special_tokens,
            &source.tokenizer_config,
        ]
        .into_iter()
        .all(|path| path.parent() == Some(files.tokenizer_dir.as_path()));
        let initializers_match = source.external_initializers.len()
            == files.external_initializers.len()
            && source
                .external_initializers
                .iter()
                .all(|file| files.external_initializers.contains(file));
        if source.model != files.model
            || !tokenizer_matches
            || !initializers_match
            || files.max_length == 0
        {
            return Err(CobaltError::InvalidInput(
                "ONNX files must match the installed catalog artifacts".into(),
            ));
        }
        source.max_length = source.max_length.min(files.max_length);
        Ok(embedder)
    }

    pub fn from_catalog(id: &str) -> Result<Self> {
        let entry = catalog_entry(id)?;
        Ok(Self {
            spec: entry.spec.clone(),
            source: Arc::new(CatalogFiles::from_catalog(entry)?),
            model: Arc::new(Mutex::new(None)),
            inference_slot: Arc::new(tokio::sync::Semaphore::new(1)),
        })
    }

    async fn embed(&self, input: Vec<String>) -> Result<Vec<Vec<f32>>> {
        if input.is_empty() {
            return Ok(Vec::new());
        }
        let permit = self
            .inference_slot
            .clone()
            .acquire_owned()
            .await
            .map_err(|err| CobaltError::Internal(err.to_string()))?;
        let source = self.source.clone();
        let state = self.model.clone();
        let spec = self.spec.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let mut state = state
                .lock()
                .map_err(|_| CobaltError::Internal("ONNX model lock poisoned".into()))?;
            let model = match state.as_mut() {
                Some(model) => model,
                None => state.insert(source.load()?),
            };
            let count = input.len();
            let vectors = if source.quantization == QuantizationMode::Dynamic {
                // Dynamic scale depends on the batch. Keep embeddings independent of neighboring inputs.
                let mut vectors = Vec::with_capacity(count);
                for text in input {
                    vectors.extend(model.embed([text], None).map_err(embedding_error)?);
                }
                vectors
            } else {
                model
                    .embed(input, Some(crate::DOCUMENT_EMBED_BATCH))
                    .map_err(embedding_error)?
            };
            normalize(vectors, count, &spec)
        })
        .await
        .map_err(|err| CobaltError::Internal(err.to_string()))?
    }
}

#[async_trait]
impl Embedder for FastembedEmbedder {
    fn spec(&self) -> &EmbeddingModelSpec {
        &self.spec
    }

    async fn embed_documents(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        self.embed(
            texts
                .iter()
                .map(|text| prefixed(text, self.spec.document_prefix.as_deref()))
                .collect(),
        )
        .await
    }

    async fn embed_query(&self, text: &str) -> Result<Vec<f32>> {
        one_vector(
            self.embed(vec![prefixed(text, self.spec.query_prefix.as_deref())])
                .await?,
        )
    }
}

fn embedding_error(err: impl std::fmt::Display) -> CobaltError {
    CobaltError::Embedding(err.to_string())
}

impl CatalogFiles {
    fn from_catalog(entry: &ModelEntry) -> Result<Self> {
        let artifacts = entry
            .files
            .iter()
            .map(|artifact| {
                let path = std::path::Path::new(&artifact.relative_dest);
                let name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or_else(|| {
                        CobaltError::Integrity(format!("invalid artifact path {}", path.display()))
                    })?;
                Ok((name.to_owned(), home_path(&artifact.relative_dest)?))
            })
            .collect::<Result<std::collections::BTreeMap<_, _>>>()?;
        let file = |name: &str| {
            artifacts.get(name).cloned().ok_or_else(|| {
                CobaltError::Integrity(format!(
                    "missing catalog artifact {name} for {}",
                    entry.spec.id
                ))
            })
        };
        Ok(Self {
            model: file("model.onnx")?,
            tokenizer: file("tokenizer.json")?,
            config: file("config.json")?,
            special_tokens: file("special_tokens_map.json")?,
            tokenizer_config: file("tokenizer_config.json")?,
            external_initializers: artifacts
                .iter()
                .filter(|(name, _)| name.starts_with("model.onnx_"))
                .map(|(name, path)| (name.clone(), path.clone()))
                .collect(),
            pooling: match entry.spec.pooling {
                cobalt_core::enums::Pooling::Mean => Pooling::Mean,
                cobalt_core::enums::Pooling::Cls => Pooling::Cls,
            },
            quantization: match entry.spec.quantization {
                Quantization::Int8 => QuantizationMode::Dynamic,
                _ => QuantizationMode::None,
            },
            max_length: if entry.spec.id == MODEL_BGE_M3 {
                8192
            } else {
                512
            },
        })
    }

    fn load(&self) -> Result<TextEmbedding> {
        let tokenizer = TokenizerFiles {
            tokenizer_file: read_model_file(&self.tokenizer)?,
            config_file: read_model_file(&self.config)?,
            special_tokens_map_file: read_model_file(&self.special_tokens)?,
            tokenizer_config_file: read_model_file(&self.tokenizer_config)?,
        };
        let mut model = UserDefinedEmbeddingModel::new(read_model_file(&self.model)?, tokenizer)
            .with_pooling(self.pooling.clone())
            .with_quantization(self.quantization);
        for (name, path) in &self.external_initializers {
            model = model.with_external_initializer(name.clone(), read_model_file(path)?);
        }
        TextEmbedding::try_new_from_user_defined(
            model,
            InitOptionsUserDefined::new().with_max_length(self.max_length),
        )
        .map_err(embedding_error)
    }
}

fn read_model_file(path: &std::path::Path) -> Result<Vec<u8>> {
    std::fs::read(path).map_err(|err| match err.kind() {
        std::io::ErrorKind::NotFound => {
            CobaltError::NotFound(format!("installed ONNX artifact {}", path.display()))
        }
        _ => CobaltError::Io(err),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compatibility_constructor_validates_paths_and_uses_catalog_pooling() {
        let spec = default_model_spec(HardwareTier::Ultra);
        let catalog = FastembedEmbedder::from_catalog(&spec.id).unwrap();
        let catalog_paths = || OnnxFiles {
            model: catalog.source.model.clone(),
            tokenizer_dir: catalog.source.tokenizer.parent().unwrap().to_path_buf(),
            external_initializers: catalog.source.external_initializers.clone(),
            pooling: Pooling::Mean,
            quantization: QuantizationMode::Dynamic,
            max_length: 512,
        };
        let attached = FastembedEmbedder::from_onnx(spec.clone(), catalog_paths()).unwrap();
        assert!(matches!(attached.source.pooling, Pooling::Cls));
        assert_eq!(attached.source.quantization, QuantizationMode::None);
        assert_eq!(attached.source.max_length, 512);
        let mut wrong_paths = catalog_paths();
        wrong_paths.external_initializers.clear();
        assert!(FastembedEmbedder::from_onnx(spec, wrong_paths).is_err());
    }

    #[test]
    fn catalog_supplies_specs_artifacts_pooling_and_prefixes() {
        for tier in [
            HardwareTier::Eco,
            HardwareTier::Balanced,
            HardwareTier::Ultra,
        ] {
            let model = FastembedEmbedder::for_tier(tier).unwrap();
            assert_eq!(*model.spec(), default_model_spec(tier));
            if tier == HardwareTier::Ultra {
                assert!(matches!(model.source.pooling, Pooling::Cls));
                assert_eq!(model.source.external_initializers[0].0, "model.onnx_data");
            } else {
                assert!(matches!(model.source.pooling, Pooling::Mean));
                assert_eq!(model.source.quantization, QuantizationMode::Dynamic);
                assert_eq!(
                    prefixed("texto", model.spec().query_prefix.as_deref()),
                    "query: texto"
                );
                assert_eq!(
                    prefixed("texto", model.spec().document_prefix.as_deref()),
                    "passage: texto"
                );
            }
            assert!(
                model
                    .source
                    .model
                    .ends_with(format!("models/{}/model.onnx", model.spec().id))
            );
        }
        assert!(FastembedEmbedder::from_catalog("unknown-model").is_err());
        let model = FastembedEmbedder::for_tier(HardwareTier::Eco).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        assert!(rt.block_on(model.embed_documents(&[])).unwrap().is_empty());
    }
}
