use std::time::Duration;

use async_trait::async_trait;
use cobalt_core::engine::EmbeddingModelSpec;
use cobalt_core::enums::EmbeddingProvider;
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::traits::Embedder;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};

use crate::{normalize, one_vector, prefixed};

pub struct OllamaEmbedder {
    spec: EmbeddingModelSpec,
    client: Client,
    endpoint: Url,
    model: String,
}

#[derive(Serialize)]
struct EmbedRequest<'a> {
    model: &'a str,
    input: Vec<String>,
}

#[derive(Deserialize)]
struct EmbedResponse {
    embeddings: Vec<Vec<f32>>,
}

impl OllamaEmbedder {
    pub fn new(base_url: &str, spec: EmbeddingModelSpec) -> Result<Self> {
        let model = spec.id.strip_prefix("ollama:").unwrap_or(&spec.id);
        if spec.provider != EmbeddingProvider::Ollama
            || model.trim().is_empty()
            || spec.dimensions == 0
        {
            return Err(CobaltError::InvalidInput(
                "invalid Ollama model spec".into(),
            ));
        }
        let mut endpoint =
            Url::parse(base_url).map_err(|err| CobaltError::InvalidInput(err.to_string()))?;
        if !matches!(endpoint.scheme(), "http" | "https")
            || endpoint.host().is_none()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
        {
            return Err(CobaltError::InvalidInput(
                "invalid Ollama HTTP base URL".into(),
            ));
        }
        endpoint
            .path_segments_mut()
            .map_err(|()| CobaltError::InvalidInput("invalid Ollama path".into()))?
            .pop_if_empty()
            .extend(["api", "embed"]);
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(120))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(http_error)?;
        Ok(Self {
            model: model.into(),
            spec,
            client,
            endpoint,
        })
    }

    async fn embed(&self, input: Vec<String>) -> Result<Vec<Vec<f32>>> {
        let count = input.len();
        if count == 0 {
            return Ok(Vec::new());
        }
        let response = self
            .client
            .post(self.endpoint.clone())
            .json(&EmbedRequest {
                model: &self.model,
                input,
            })
            .send()
            .await
            .map_err(http_error)?;
        if !response.status().is_success() {
            return Err(CobaltError::Embedding(format!(
                "Ollama returned HTTP {}",
                response.status()
            )));
        }
        let response: EmbedResponse = response.json().await.map_err(http_error)?;
        normalize(response.embeddings, count, &self.spec)
    }
}

fn http_error(err: reqwest::Error) -> CobaltError {
    CobaltError::Embedding(err.without_url().to_string())
}

#[async_trait]
impl Embedder for OllamaEmbedder {
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

#[cfg(test)]
mod tests {
    use cobalt_core::enums::HardwareTier;

    use super::*;

    #[test]
    fn builds_endpoint_and_checks_embeddings_without_network() {
        let spec = EmbeddingModelSpec {
            id: "ollama:embed:test".into(),
            provider: EmbeddingProvider::Ollama,
            dimensions: 2,
            query_prefix: Some("search: ".into()),
            ..crate::default_model_spec(HardwareTier::Eco)
        };
        let embedder = OllamaEmbedder::new("http://127.0.0.1:11434/proxy/", spec.clone()).unwrap();
        assert_eq!(embedder.endpoint.path(), "/proxy/api/embed");
        assert_eq!(embedder.model, "embed:test");
        assert_eq!(
            prefixed("text", embedder.spec().query_prefix.as_deref()),
            "search: text"
        );
        assert_eq!(
            normalize(vec![vec![0.0, 2.0]], 1, &spec).unwrap(),
            vec![vec![0.0, 1.0]]
        );
        assert!(normalize(vec![vec![0.0, 0.0]], 1, &spec).is_err());
        assert!(normalize(vec![vec![1.0]], 1, &spec).is_err());
        assert!(normalize(vec![vec![1.0, 0.0]], 2, &spec).is_err());
        assert!(OllamaEmbedder::new("ftp://localhost", spec).is_err());
    }
}
