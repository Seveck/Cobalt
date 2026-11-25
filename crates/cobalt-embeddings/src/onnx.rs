use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use cobalt_core::engine::{
    EmbeddingModelSpec, MODEL_BGE_M3, MODEL_MULTILINGUAL_E5_BASE, MODEL_MULTILINGUAL_E5_SMALL,
    default_model_for_tier, prefixes_for_model,
};
use cobalt_core::enums::{EmbeddingProvider, HardwareTier, Quantization};
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::paths::{MODELS_DIR, home_path};
use cobalt_core::traits::Embedder;
use fastembed::{
    EmbeddingModel, InitOptions, InitOptionsUserDefined, Pooling, QuantizationMode, TextEmbedding,
    TokenizerFiles, UserDefinedEmbeddingModel,
};

use crate::{normalize, one_vector, prefixed};

/// The Phase 1 multilingual defaults. Download sizes are estimates for the weights.
pub fn default_model_spec(tier: HardwareTier) -> EmbeddingModelSpec {
    let id = default_model_for_tier(tier);
    let (display, repo, dimensions, quantization, size_bytes) = match tier {
        HardwareTier::Eco => (
            "Multilingual E5 Small",
            "intfloat/multilingual-e5-small",
            384,
            Quantization::Int8,
            118_000_000,
        ),
        HardwareTier::Balanced => (
            "Multilingual E5 Base",
            "intfloat/multilingual-e5-base",
            768,
            Quantization::Fp32,
            1_110_000_000,
        ),
        HardwareTier::Ultra => (
            "BGE-M3",
            "BAAI/bge-m3",
            1024,
            Quantization::Fp32,
            2_270_000_000,
        ),
    };
    let (query, document) = prefixes_for_model(id);
    EmbeddingModelSpec {
        id: id.into(),
        provider: EmbeddingProvider::Fastembed,
        display_name: display.into(),
        dimensions,
        size_bytes,
        quantization,
        recommended_tier: tier,
        multilingual: true,
        hf_repo: Some(repo.into()),
        query_prefix: query.map(str::to_owned),
        document_prefix: document.map(str::to_owned),
    }
}

/// Local files installed and verified by the engine manager.
pub struct OnnxFiles {
    pub model: PathBuf,
    pub tokenizer_dir: PathBuf,
    /// Pairs of initializer names as used inside the ONNX graph and their verified local paths.
    pub external_initializers: Vec<(String, PathBuf)>,
    pub pooling: Pooling,
    pub quantization: QuantizationMode,
    pub max_length: usize,
}

enum ModelSource {
    BuiltIn {
        model: EmbeddingModel,
        cache: PathBuf,
    },
    Installed(OnnxFiles),
}

/// Loads a fastembed model on the first nonempty embedding request.
pub struct FastembedEmbedder {
    spec: EmbeddingModelSpec,
    source: Arc<ModelSource>,
    model: Arc<Mutex<Option<TextEmbedding>>>,
    inference_slot: Arc<tokio::sync::Semaphore>,
}

impl FastembedEmbedder {
    pub fn for_tier(tier: HardwareTier) -> Result<Self> {
        Self::new(default_model_spec(tier))
    }

    pub fn new(spec: EmbeddingModelSpec) -> Result<Self> {
        validate(&spec)?;
        let cache = home_path(MODELS_DIR)?;
        let source = if let Some(model) = built_in(&spec) {
            ModelSource::BuiltIn { model, cache }
        } else {
            let directory = cache.join(&spec.id);
            ModelSource::Installed(OnnxFiles {
                model: directory.join("model.onnx"),
                tokenizer_dir: directory,
                external_initializers: Vec::new(),
                pooling: if prefixes_for_model(&spec.id).0.is_some() {
                    Pooling::Mean
                } else {
                    Pooling::Cls
                },
                quantization: if spec.quantization == Quantization::Int8 {
                    QuantizationMode::Dynamic
                } else {
                    QuantizationMode::None
                },
                max_length: if spec.id == MODEL_BGE_M3 { 8192 } else { 512 },
            })
        };
        Ok(Self::from_source(spec, source))
    }

    pub fn from_onnx(spec: EmbeddingModelSpec, files: OnnxFiles) -> Result<Self> {
        validate(&spec)?;
        if files.max_length == 0 {
            return Err(CobaltError::InvalidInput(
                "ONNX maximum input length must be positive".into(),
            ));
        }
        Ok(Self::from_source(spec, ModelSource::Installed(files)))
    }

    fn from_source(mut spec: EmbeddingModelSpec, source: ModelSource) -> Self {
        let (query, document) = prefixes_for_model(&spec.id);
        if let (Some(query), Some(document)) = (query, document) {
            spec.query_prefix = Some(query.into());
            spec.document_prefix = Some(document.into());
        }
        Self {
            spec,
            source: Arc::new(source),
            model: Arc::new(Mutex::new(None)),
            inference_slot: Arc::new(tokio::sync::Semaphore::new(1)),
        }
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
            let vectors = match source.as_ref() {
                ModelSource::Installed(files)
                    if files.quantization == QuantizationMode::Dynamic =>
                {
                    // Dynamic scale depends on the batch. Keep embeddings independent of neighboring inputs.
                    let mut vectors = Vec::with_capacity(count);
                    for text in input {
                        vectors.extend(model.embed([text], None).map_err(embedding_error)?);
                    }
                    vectors
                }
                _ => model.embed(input, None).map_err(embedding_error)?,
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

fn validate(spec: &EmbeddingModelSpec) -> Result<()> {
    if spec.provider != EmbeddingProvider::Fastembed
        || spec.dimensions == 0
        || spec.id.is_empty()
        || spec.id == "."
        || spec.id == ".."
        || !spec
            .id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Err(CobaltError::InvalidInput(
            "invalid fastembed model spec".into(),
        ));
    }
    Ok(())
}

fn built_in(spec: &EmbeddingModelSpec) -> Option<EmbeddingModel> {
    use EmbeddingModel::*;
    match (spec.id.as_str(), spec.quantization) {
        (MODEL_MULTILINGUAL_E5_SMALL, Quantization::Fp32) => Some(MultilingualE5Small),
        (MODEL_MULTILINGUAL_E5_BASE, Quantization::Fp32) => Some(MultilingualE5Base),
        (MODEL_BGE_M3, Quantization::Fp32) => Some(BGEM3),
        ("all-minilm-l6-v2", Quantization::Fp32) => Some(AllMiniLML6V2),
        ("all-minilm-l6-v2", Quantization::Int8) => Some(AllMiniLML6V2Q),
        ("bge-small-en-v1.5", Quantization::Fp32) => Some(BGESmallENV15),
        ("bge-small-en-v1.5", Quantization::Int8) => Some(BGESmallENV15Q),
        ("bge-large-en-v1.5", Quantization::Fp32) => Some(BGELargeENV15),
        ("bge-large-en-v1.5", Quantization::Int8) => Some(BGELargeENV15Q),
        _ => None,
    }
}

fn embedding_error(err: impl std::fmt::Display) -> CobaltError {
    CobaltError::Embedding(err.to_string())
}

impl ModelSource {
    fn load(&self) -> Result<TextEmbedding> {
        match self {
            Self::BuiltIn { model, cache } => {
                std::fs::create_dir_all(cache)?;
                TextEmbedding::try_new(
                    InitOptions::new(model.clone())
                        .with_cache_dir(cache.clone())
                        .with_show_download_progress(false),
                )
                .map_err(embedding_error)
            }
            Self::Installed(files) => {
                let read = |file: &str| read_model_file(&files.tokenizer_dir.join(file));
                let tokenizer = TokenizerFiles {
                    tokenizer_file: read("tokenizer.json")?,
                    config_file: read("config.json")?,
                    special_tokens_map_file: read("special_tokens_map.json")?,
                    tokenizer_config_file: read("tokenizer_config.json")?,
                };
                let mut model =
                    UserDefinedEmbeddingModel::new(read_model_file(&files.model)?, tokenizer)
                        .with_pooling(files.pooling.clone())
                        .with_quantization(files.quantization);
                for (name, path) in &files.external_initializers {
                    model = model.with_external_initializer(name.clone(), read_model_file(path)?);
                }
                TextEmbedding::try_new_from_user_defined(
                    model,
                    InitOptionsUserDefined::new().with_max_length(files.max_length),
                )
                .map_err(embedding_error)
            }
        }
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
    fn defaults_use_correct_dimensions_and_mandatory_e5_prefixes() {
        let eco = default_model_spec(HardwareTier::Eco);
        assert_eq!(
            (eco.dimensions, eco.quantization),
            (384, Quantization::Int8)
        );
        assert_eq!(
            eco.hf_repo.as_deref(),
            Some("intfloat/multilingual-e5-small")
        );
        assert!(built_in(&eco).is_none());
        let balanced = default_model_spec(HardwareTier::Balanced);
        assert_eq!(
            (balanced.dimensions, balanced.quantization),
            (768, Quantization::Fp32)
        );
        assert_eq!(
            built_in(&balanced),
            Some(EmbeddingModel::MultilingualE5Base)
        );
        let ultra = default_model_spec(HardwareTier::Ultra);
        assert_eq!(
            (ultra.dimensions, ultra.quantization),
            (1024, Quantization::Fp32)
        );
        assert_eq!(built_in(&ultra), Some(EmbeddingModel::BGEM3));
        assert!(ultra.query_prefix.is_none() && ultra.document_prefix.is_none());

        let model = FastembedEmbedder::from_onnx(
            EmbeddingModelSpec {
                query_prefix: Some("custom: ".into()),
                document_prefix: None,
                ..eco
            },
            OnnxFiles {
                model: PathBuf::new(),
                tokenizer_dir: PathBuf::new(),
                external_initializers: Vec::new(),
                pooling: Pooling::Mean,
                quantization: QuantizationMode::Dynamic,
                max_length: 512,
            },
        )
        .unwrap();
        assert_eq!(
            prefixed("texto", model.spec().query_prefix.as_deref()),
            "query: texto"
        );
        assert_eq!(
            prefixed("texto", model.spec().document_prefix.as_deref()),
            "passage: texto"
        );
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        assert!(rt.block_on(model.embed_documents(&[])).unwrap().is_empty());
    }
}
