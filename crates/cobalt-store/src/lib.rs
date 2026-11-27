//! Canonical SQLite repositories and hybrid retrieval.

pub use cobalt_embeddings::DOCUMENT_EMBED_BATCH;

mod db;
#[cfg(any(feature = "qdrant", feature = "chroma", feature = "lancedb"))]
mod external;
mod governance;
mod ingest;
mod lifecycle;
mod memory;
mod migration;
mod portable;
mod repositories;
mod retrieval;
mod snapshots;
mod telemetry;
mod usage_stats;
mod vector;

use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use cobalt_core::engine::{MODEL_MULTILINGUAL_E5_BASE, MODEL_MULTILINGUAL_E5_SMALL};
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::paths::{DATABASE_FILE, home_path};
use cobalt_core::traits::{Embedder, TokenCounter};
use db::Database;

pub use cobalt_core;
pub use cobalt_core::SCHEMA_VERSION;
#[cfg(feature = "chroma")]
pub use external::Chroma;
#[cfg(any(feature = "qdrant", feature = "chroma", feature = "lancedb"))]
pub use external::ExternalVectorStore;
#[cfg(feature = "lancedb")]
pub use external::LanceDb;
#[cfg(feature = "qdrant")]
pub use external::QdrantSidecar;
pub use ingest::WatchedFileUpdate;
pub use memory::project_embedding;
pub use telemetry::{READ_AVOIDED_CAP_PER_DOCUMENT, READ_DEDUP_WINDOW_SECS};
pub use vector::{SqliteVec, Usearch};

/// A daemon-owned store. Open one instance per database and clone it to share the writer and pool.
#[derive(Clone)]
pub struct SqliteStore {
    db: Database,
    data_dir: PathBuf,
    retrieval: Arc<RwLock<Option<Arc<Retrieval>>>>,
    engine_gate: Arc<tokio::sync::RwLock<()>>,
    waiting_for_engine: Arc<std::sync::atomic::AtomicUsize>,
    started_at: cobalt_core::ids::Timestamp,
}

#[derive(Clone)]
struct Retrieval {
    embedder: Arc<dyn Embedder>,
    tokens: Arc<dyn TokenCounter>,
    index: vector::Index,
}

impl SqliteStore {
    pub async fn open() -> Result<Self> {
        Self::open_at(home_path(DATABASE_FILE)?).await
    }

    pub async fn open_at(path: PathBuf) -> Result<Self> {
        let path = std::path::absolute(path)?;
        let data_dir = path
            .parent()
            .ok_or_else(|| CobaltError::InvalidInput("database path has no parent".into()))?
            .to_path_buf();
        Ok(Self {
            db: Database::open(path).await?,
            data_dir,
            retrieval: Arc::default(),
            engine_gate: Arc::default(),
            waiting_for_engine: Arc::default(),
            started_at: cobalt_core::ids::now(),
        })
    }

    pub async fn with_sqlite_vec(
        self,
        embedder: Arc<dyn Embedder>,
        tokens: Arc<dyn TokenCounter>,
    ) -> Result<Self> {
        let _gate = self.engine_gate.clone().write_owned().await;
        let index = SqliteVec::open(&self, embedder.spec().dimensions as usize).await?;
        self.set_retrieval(Retrieval {
            embedder,
            tokens,
            index: index.into(),
        })?;
        Ok(self)
    }

    pub async fn with_usearch(
        self,
        embedder: Arc<dyn Embedder>,
        tokens: Arc<dyn TokenCounter>,
    ) -> Result<Self> {
        let _gate = self.engine_gate.clone().write_owned().await;
        let index = Usearch::open_in(
            &self,
            self.data_path(cobalt_core::paths::VECTOR_INDEX_DIR),
            &embedder.spec().id,
            embedder.spec().dimensions as usize,
        )
        .await?;
        self.set_retrieval(Retrieval {
            embedder,
            tokens,
            index: index.into(),
        })?;
        Ok(self)
    }

    fn data_path(&self, entry: &str) -> PathBuf {
        self.data_dir.join(entry)
    }

    async fn engine_write(&self) -> tokio::sync::OwnedRwLockWriteGuard<()> {
        let _pending = db::PendingWrite::new(&self.waiting_for_engine);
        self.engine_gate.clone().write_owned().await
    }

    fn queued_writes(&self) -> u64 {
        use std::sync::atomic::Ordering;
        self.db
            .queued_writes()
            .saturating_add(self.waiting_for_engine.load(Ordering::Relaxed) as u64)
    }

    fn retrieval(&self) -> Result<Arc<Retrieval>> {
        self.configured_retrieval()?
            .ok_or_else(|| CobaltError::Engine("configure a retrieval engine first".into()))
    }

    fn configured_retrieval(&self) -> Result<Option<Arc<Retrieval>>> {
        self.retrieval
            .read()
            .map(|state| state.clone())
            .map_err(|_| CobaltError::Internal("retrieval lock poisoned".into()))
    }

    fn set_retrieval(&self, retrieval: Retrieval) -> Result<()> {
        *self
            .retrieval
            .write()
            .map_err(|_| CobaltError::Internal("retrieval lock poisoned".into()))? =
            Some(Arc::new(retrieval));
        Ok(())
    }
}

/// Selects the embedding pair used to measure the cosine.
#[derive(Clone, Copy, Debug)]
pub enum SimilarityKind {
    /// Two passage embeddings, used for writes and duplicate detection.
    Document,
    /// A query embedding and a passage embedding, used for retrieval.
    Query,
}

// (model ID, baseline, scale), measured by tests::similarity::measure_similarity_distributions.
// Fit (cosine - baseline) / scale to map the largest unrelated cosine to 0.39
// and the largest different-fact document cosine to 0.84, then round the coefficients.
// This leaves a 0.01 margin below each fixture limit (0.40 and the 0.85 write threshold).
const DOCUMENT_CALIBRATIONS: [(&str, f64, f64); 2] = [
    (MODEL_MULTILINGUAL_E5_SMALL, 0.8521, 0.0971),
    (MODEL_MULTILINGUAL_E5_BASE, 0.8285, 0.0983),
];

// Place the 0.30 retrieval cutoff just below the lower quartile of different-fact
// query cosines and map the unrelated median to about 0.08 for each model.
const QUERY_CALIBRATIONS: [(&str, f64, f64); 2] = [
    (MODEL_MULTILINGUAL_E5_SMALL, 0.772, 0.137),
    (MODEL_MULTILINGUAL_E5_BASE, 0.744, 0.074),
];

/// Maps a raw cosine to a score in `0..=1` using the measured model calibration.
/// BGE-M3 and unlisted models use clamped raw cosine so the fallback never boosts a score.
pub fn calibrated_similarity(model_id: &str, kind: SimilarityKind, cosine: f64) -> f64 {
    if !cosine.is_finite() {
        return 0.0;
    }
    let (calibrations, upper_score) = match kind {
        SimilarityKind::Document => (&DOCUMENT_CALIBRATIONS, 0.95),
        SimilarityKind::Query => (&QUERY_CALIBRATIONS, 0.30),
    };
    let Some(&(_, baseline, scale)) = calibrations
        .iter()
        .find(|(id, _, _)| id.eq_ignore_ascii_case(model_id))
    else {
        return cosine.clamp(0.0, 1.0);
    };

    // Above the fitted range, interpolate to a score of 1 at cosine 1.
    let upper_cosine = baseline + upper_score * scale;
    if cosine <= upper_cosine {
        ((cosine - baseline) / scale).clamp(0.0, upper_score)
    } else {
        let fraction = (cosine - upper_cosine) / (1.0 - upper_cosine);
        upper_score + (1.0 - upper_score) * fraction.min(1.0)
    }
}

#[cfg(test)]
mod tests;
