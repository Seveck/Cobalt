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
mod vector;

use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use cobalt_core::error::{CobaltError, Result};
use cobalt_core::paths::{DATABASE_FILE, home_path};
use cobalt_core::traits::{Embedder, TokenCounter};
use db::Database;

pub use cobalt_core;
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
pub use vector::{SqliteVec, Usearch};

pub const SCHEMA_VERSION: u32 = 1;

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

/// Maps usable cosine headroom to 0..1: clamp((cosine - baseline) / (1 - baseline)).
/// Unrelated E5 texts cluster around 0.78. Other models currently use a zero baseline.
pub fn calibrated_similarity(model_id: &str, cosine: f64) -> f64 {
    if !cosine.is_finite() {
        return 0.0;
    }
    let baseline = if cobalt_core::engine::prefixes_for_model(model_id)
        .0
        .is_some()
    {
        0.78
    } else {
        0.0
    };
    ((cosine - baseline) / (1.0 - baseline)).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests;
