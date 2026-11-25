//! Canonical SQLite repositories and hybrid retrieval.

mod db;
mod memory;
mod repositories;
mod retrieval;
mod vector;

use std::path::PathBuf;
use std::sync::Arc;

use cobalt_core::error::{CobaltError, Result};
use cobalt_core::paths::{DATABASE_FILE, home_path};
use cobalt_core::traits::{Embedder, TokenCounter};
use db::Database;

pub use cobalt_core;
pub use memory::project_embedding;
pub use vector::{SqliteVec, Usearch};

pub const SCHEMA_VERSION: u32 = 1;

/// A daemon-owned store. Open one instance per database and clone it to share the writer and pool.
#[derive(Clone)]
pub struct SqliteStore {
    db: Database,
    retrieval: Option<Arc<Retrieval>>,
}

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
        Ok(Self {
            db: Database::open(path).await?,
            retrieval: None,
        })
    }

    pub async fn with_sqlite_vec(
        mut self,
        embedder: Arc<dyn Embedder>,
        tokens: Arc<dyn TokenCounter>,
    ) -> Result<Self> {
        let index = SqliteVec::open(&self, embedder.spec().dimensions as usize).await?;
        self.retrieval = Some(Arc::new(Retrieval {
            embedder,
            tokens,
            index: index.into(),
        }));
        Ok(self)
    }

    pub async fn with_usearch(
        mut self,
        embedder: Arc<dyn Embedder>,
        tokens: Arc<dyn TokenCounter>,
    ) -> Result<Self> {
        let index = Usearch::open(
            &self,
            &embedder.spec().id,
            embedder.spec().dimensions as usize,
        )
        .await?;
        self.retrieval = Some(Arc::new(Retrieval {
            embedder,
            tokens,
            index: index.into(),
        }));
        Ok(self)
    }

    fn retrieval(&self) -> Result<&Retrieval> {
        self.retrieval
            .as_deref()
            .ok_or_else(|| CobaltError::Engine("configure a retrieval engine first".into()))
    }
}

fn pending<T>(operation: &str) -> Result<T> {
    Err(CobaltError::Unsupported(format!(
        "{operation} is unavailable in this phase"
    )))
}

#[cfg(test)]
mod tests;
