//! Local ONNX and Ollama embedding providers and exact BPE token accounting.

mod ollama;
mod onnx;
mod tokens;

use cobalt_core::engine::EmbeddingModelSpec;
use cobalt_core::error::{CobaltError, Result};

pub use cobalt_core;
pub use fastembed::{Pooling, QuantizationMode};
pub use ollama::OllamaEmbedder;
pub use onnx::{FastembedEmbedder, OnnxFiles, default_model_spec};
pub use tokens::TiktokenCounter;

fn prefixed(text: &str, prefix: Option<&str>) -> String {
    match prefix {
        Some(prefix) => format!("{prefix}{text}"),
        None => text.to_owned(),
    }
}

fn normalize(
    mut vectors: Vec<Vec<f32>>,
    expected_count: usize,
    spec: &EmbeddingModelSpec,
) -> Result<Vec<Vec<f32>>> {
    if vectors.len() != expected_count {
        return Err(CobaltError::Embedding(format!(
            "{} returned {} embeddings for {expected_count} inputs",
            spec.id,
            vectors.len()
        )));
    }
    for vector in &mut vectors {
        let norm = vector
            .iter()
            .map(|&v| f64::from(v).powi(2))
            .sum::<f64>()
            .sqrt();
        if vector.len() != spec.dimensions as usize || !norm.is_finite() || norm == 0.0 {
            return Err(CobaltError::Embedding(format!(
                "{} must produce {} finite dimensions with nonzero norm",
                spec.id, spec.dimensions
            )));
        }
        for component in vector {
            *component = (f64::from(*component) / norm) as f32;
        }
    }
    Ok(vectors)
}

fn one_vector(mut vectors: Vec<Vec<f32>>) -> Result<Vec<f32>> {
    vectors
        .pop()
        .ok_or_else(|| CobaltError::Embedding("provider returned no embedding".into()))
}
