#[cfg(feature = "lancedb")]
mod lance;
#[cfg(any(feature = "qdrant", feature = "chroma"))]
mod rest;

use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use cobalt_core::enums::{EngineKind, MemoryStatus};
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::ids::{Id, MAIN_BRANCH_ID, new_id};
use cobalt_core::search::{ProjectScope, VectorFilter, VectorHit, VectorRecord};
use cobalt_core::traits::VectorStore;
use rusqlite::{Connection, params_from_iter};

use crate::db::{lock, sql_error};
use crate::repositories::id;
use crate::vector::{Scope, checked_vector};

pub(crate) fn engine_error(error: impl std::fmt::Display) -> CobaltError {
    CobaltError::Engine(error.to_string())
}

#[async_trait]
trait Backend: Send + Sync {
    fn kind(&self) -> EngineKind;
    fn name(&self) -> &str;
    async fn fork(&self, name: &str) -> Result<Arc<dyn Backend>>;
    async fn destroy(&self) -> Result<()>;
    async fn put(&self, records: &[VectorRecord]) -> Result<()>;
    async fn delete(&self, ids: &[Id]) -> Result<()>;
    async fn get(&self, ids: &[Id]) -> Result<Vec<VectorRecord>>;
    async fn nearest(&self, query: &[f32], limit: usize) -> Result<Vec<VectorHit>>;
    async fn count(&self) -> Result<u64>;
    async fn health(&self) -> Result<()>;
}

type Overlay = BTreeMap<Id, Option<VectorRecord>>;

/// Vector adapter backed by a remote collection or a local LanceDB table.
#[derive(Clone)]
pub struct ExternalVectorStore {
    backend: Arc<dyn Backend>,
    dims: usize,
    pending: Option<Arc<Mutex<Overlay>>>,
}

impl ExternalVectorStore {
    fn new(backend: Arc<dyn Backend>, dims: usize) -> Self {
        Self {
            backend,
            dims,
            pending: None,
        }
    }

    pub fn name(&self) -> &str {
        self.backend.name()
    }

    pub(crate) async fn open(
        kind: EngineKind,
        endpoint: &str,
        name: &str,
        dims: usize,
        api_key: Option<&str>,
    ) -> Result<Self> {
        validate_name(name, dims)?;
        #[cfg(not(any(feature = "qdrant", feature = "chroma")))]
        let _ = api_key;
        let backend: Arc<dyn Backend> = match kind {
            #[cfg(feature = "qdrant")]
            EngineKind::QdrantSidecar | EngineKind::QdrantRemote => {
                Arc::new(rest::Qdrant::open(endpoint, name, dims, api_key, kind).await?)
            }
            #[cfg(feature = "chroma")]
            EngineKind::ChromaDb => {
                Arc::new(rest::Chroma::open(endpoint, name, dims, api_key).await?)
            }
            #[cfg(feature = "lancedb")]
            EngineKind::LanceDb => Arc::new(lance::Lance::open(endpoint, name, dims).await?),
            _ => {
                return Err(engine_error(format!(
                    "no {kind} vector adapter is installed"
                )));
            }
        };
        Ok(Self::new(backend, dims))
    }

    pub(crate) fn begin(&self) -> Self {
        Self {
            pending: Some(Arc::default()),
            ..self.clone()
        }
    }

    pub(crate) fn commit<T>(&self, finish: impl FnOnce() -> Result<T>) -> Result<T> {
        let pending = self
            .pending
            .as_ref()
            .ok_or_else(|| engine_error("missing external index transaction"))?;
        let changes = std::mem::take(&mut *lock(pending)?);
        if changes.is_empty() {
            return finish();
        }
        let runtime = tokio::runtime::Handle::current();
        let ids: Vec<_> = changes.keys().copied().collect();
        let original = runtime.block_on(self.fetch(&ids))?;
        let rollback: Overlay = ids.into_iter().zip(original).collect();
        let result = runtime
            .block_on(self.apply(&changes))
            .and_then(|_| finish());
        if let Err(error) = result {
            runtime
                .block_on(self.apply(&rollback))
                .map_err(|rollback| {
                    CobaltError::Integrity(format!(
                        "{error}; external index rollback failed: {rollback}"
                    ))
                })?;
            return Err(error);
        }
        result
    }

    async fn apply(&self, operations: &Overlay) -> Result<()> {
        let mut puts = Vec::new();
        let mut deletes = Vec::new();
        for (id, record) in operations {
            if let Some(record) = record {
                puts.push(record.clone());
            } else {
                deletes.push(*id);
            }
        }
        for batch in puts.chunks(256) {
            self.backend.put(batch).await?;
        }
        for batch in deletes.chunks(256) {
            self.backend.delete(batch).await?;
        }
        Ok(())
    }

    async fn fetch(&self, ids: &[Id]) -> Result<Vec<Option<VectorRecord>>> {
        let mut found = BTreeMap::new();
        for ids in ids.chunks(256) {
            for row in self.backend.get(ids).await? {
                found.insert(row.memory_id, row);
            }
        }
        Ok(ids.iter().map(|id| found.get(id).cloned()).collect())
    }

    pub(crate) fn vectors(&self, ids: &[Id]) -> Result<Vec<Option<Vec<f32>>>> {
        let rows = tokio::runtime::Handle::current().block_on(self.fetch(ids))?;
        Ok(rows
            .into_iter()
            .map(|row| row.map(|row| row.vector))
            .collect())
    }

    pub(crate) fn insert(&self, conn: &Connection, id: Id, vector: &[f32]) -> Result<()> {
        let record = indexed_record(conn, id, vector.to_vec())?;
        tokio::runtime::Handle::current().block_on(self.upsert(&[record]))
    }

    pub(crate) fn remove(&self, ids: &[Id]) -> Result<()> {
        tokio::runtime::Handle::current().block_on(self.delete(ids))
    }

    pub(crate) fn scoped(
        &self,
        conn: &Connection,
        query: &[f32],
        k: usize,
        scope: Scope,
    ) -> Result<Vec<VectorHit>> {
        let sql = format!("SELECT m.id FROM memories m WHERE {}", scope.clause);
        let mut stmt = conn.prepare(&sql).map_err(sql_error)?;
        let ids = stmt
            .query_map(params_from_iter(scope.params), |row| id(row, "id"))
            .map_err(sql_error)?
            .collect::<rusqlite::Result<HashSet<_>>>()
            .map_err(sql_error)?;
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        tokio::runtime::Handle::current().block_on(self.filtered(query, k.min(ids.len()), |hits| {
            let ids = &ids;
            Box::pin(async move {
                Ok(hits
                    .into_iter()
                    .filter(|hit| ids.contains(&hit.memory_id))
                    .collect())
            })
        }))
    }

    pub(crate) fn stage(
        &self,
        conn: &Connection,
        vectors: &[(Id, Vec<f32>)],
        probe: &[f32],
    ) -> Result<Self> {
        let records: Vec<_> = vectors
            .iter()
            .map(|(id, vector)| indexed_record(conn, *id, vector.clone()))
            .collect::<Result<_>>()?;
        let runtime = tokio::runtime::Handle::current();
        runtime.block_on(async {
            let name = format!("cobalt-{}", new_id().simple());
            let target = Self::new(self.backend.fork(&name).await?, self.dims);
            let result = async {
                target.upsert(&records).await?;
                target.health_check().await?;
                if target.count().await? != vectors.len() as u64
                    || (!vectors.is_empty() && target.backend.nearest(probe, 1).await?.len() != 1)
                {
                    return Err(engine_error(
                        "staged external index count or probe verification failed",
                    ));
                }
                Ok(())
            }
            .await;
            if let Err(error) = result {
                return Err(target.cleanup_error(error).await);
            }
            Ok(target)
        })
    }

    pub(crate) async fn cleanup_error(&self, error: CobaltError) -> CobaltError {
        match self.backend.destroy().await {
            Ok(()) => error,
            Err(cleanup) => {
                engine_error(format!("{error}; clearing staging index failed: {cleanup}"))
            }
        }
    }

    async fn filtered<'a, F>(&self, query: &[f32], k: usize, filter: F) -> Result<Vec<VectorHit>>
    where
        F: Fn(
            Vec<VectorHit>,
        )
            -> std::pin::Pin<Box<dyn Future<Output = Result<Vec<VectorHit>>> + Send + 'a>>,
    {
        checked_vector(query, self.dims)?;
        if k == 0 {
            return Ok(Vec::new());
        }
        let changes = self
            .pending
            .as_ref()
            .map(|rows| lock(rows).map(|rows| rows.clone()))
            .transpose()?
            .unwrap_or_default();
        let total = usize::try_from(self.backend.count().await?).unwrap_or(usize::MAX);
        let mut limit = k.saturating_mul(2).max(16).min(total);
        let staged: Vec<_> = changes
            .values()
            .filter_map(|record| {
                record.as_ref().map(|record| VectorHit {
                    memory_id: record.memory_id,
                    similarity: cosine(query, &record.vector),
                })
            })
            .collect();
        loop {
            let candidates = if limit > 0 {
                self.backend.nearest(query, limit).await?
            } else {
                Vec::new()
            };
            let exhausted = candidates.len() < limit || limit >= total;
            let available = candidates
                .into_iter()
                .filter(|hit| !changes.contains_key(&hit.memory_id))
                .chain(staged.iter().copied())
                .collect();
            let mut hits = filter(available).await?;
            let external_hits = hits
                .iter()
                .filter(|hit| !changes.contains_key(&hit.memory_id))
                .count();
            if external_hits >= k || exhausted {
                hits.sort_by(|a, b| {
                    b.similarity
                        .total_cmp(&a.similarity)
                        .then(a.memory_id.cmp(&b.memory_id))
                });
                hits.truncate(k);
                return Ok(hits);
            }
            limit = limit.saturating_mul(2).min(total);
        }
    }
}

fn indexed_record(conn: &Connection, id: Id, vector: Vec<f32>) -> Result<VectorRecord> {
    let row = crate::memory::required_memory(conn, id)?;
    Ok(VectorRecord {
        memory_id: id,
        vector,
        project_id: row.project_id,
        branch_id: row.branch_id,
        status: row.status,
        is_reusable: row.is_reusable,
    })
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let (dot, aa, bb) = a
        .iter()
        .zip(b)
        .fold((0.0, 0.0, 0.0), |(dot, aa, bb), (&a, &b)| {
            let (a, b) = (f64::from(a), f64::from(b));
            (dot + a * b, aa + a * a, bb + b * b)
        });
    (dot / (aa * bb).sqrt()).clamp(0.0, 1.0) as f32
}

fn validate_name(name: &str, dims: usize) -> Result<()> {
    if name.len() < 3
        || name.len() > 63
        || !name
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        || !name
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        || dims == 0
        || dims > i32::MAX as usize
    {
        return Err(CobaltError::InvalidInput(
            "invalid external vector collection name or dimensions".into(),
        ));
    }
    Ok(())
}

fn matches_filter(record: &VectorRecord, filter: &VectorFilter) -> bool {
    let scoped = match filter.scope {
        ProjectScope::All => true,
        ProjectScope::Global => record.project_id.is_none(),
        ProjectScope::Project(id) => record.project_id == Some(id),
        ProjectScope::ProjectAndGlobal(id) => record.project_id.is_none_or(|value| value == id),
        ProjectScope::AllExcept(id) => record.project_id != Some(id),
    };
    scoped
        && record.branch_id == filter.branch_id.unwrap_or(MAIN_BRANCH_ID)
        && (!filter.only_reusable || record.is_reusable)
        && (record.status == MemoryStatus::Active
            || (filter.include_archived && record.status == MemoryStatus::Archived))
}

#[async_trait]
impl VectorStore for ExternalVectorStore {
    fn kind(&self) -> EngineKind {
        self.backend.kind()
    }
    fn dimensions(&self) -> usize {
        self.dims
    }

    async fn upsert(&self, records: &[VectorRecord]) -> Result<()> {
        let mut changes = Overlay::new();
        for record in records {
            checked_vector(&record.vector, self.dims)?;
            changes.insert(record.memory_id, Some(record.clone()));
        }
        if let Some(pending) = &self.pending {
            lock(pending)?.extend(changes);
            Ok(())
        } else {
            self.apply(&changes).await
        }
    }

    async fn delete(&self, ids: &[Id]) -> Result<()> {
        let changes = ids.iter().copied().map(|id| (id, None)).collect();
        if let Some(pending) = &self.pending {
            lock(pending)?.extend(changes);
            Ok(())
        } else {
            self.apply(&changes).await
        }
    }

    async fn search(
        &self,
        query: &[f32],
        k: usize,
        filter: &VectorFilter,
    ) -> Result<Vec<VectorHit>> {
        self.filtered(query, k, |hits| {
            Box::pin(async move {
                let ids: Vec<_> = hits.iter().map(|hit| hit.memory_id).collect();
                let records = self.fetch(&ids).await?;
                Ok(hits
                    .into_iter()
                    .zip(records)
                    .filter_map(|(hit, row)| {
                        row.filter(|row| matches_filter(row, filter)).map(|_| hit)
                    })
                    .collect())
            })
        })
        .await
    }

    async fn count(&self) -> Result<u64> {
        self.backend.count().await
    }
    async fn flush(&self) -> Result<()> {
        self.backend.health().await
    }
    async fn health_check(&self) -> Result<()> {
        self.backend.health().await
    }
}

macro_rules! adapter {
    ($feature:literal, $name:ident, $doc:literal) => {
        #[cfg(feature = $feature)]
        #[doc = $doc]
        #[derive(Clone)]
        pub struct $name(ExternalVectorStore);
        #[cfg(feature = $feature)]
        #[async_trait]
        impl VectorStore for $name {
            fn kind(&self) -> EngineKind {
                self.0.kind()
            }
            fn dimensions(&self) -> usize {
                self.0.dimensions()
            }
            async fn upsert(&self, records: &[VectorRecord]) -> Result<()> {
                self.0.upsert(records).await
            }
            async fn delete(&self, ids: &[Id]) -> Result<()> {
                self.0.delete(ids).await
            }
            async fn search(
                &self,
                query: &[f32],
                k: usize,
                filter: &VectorFilter,
            ) -> Result<Vec<VectorHit>> {
                self.0.search(query, k, filter).await
            }
            async fn count(&self) -> Result<u64> {
                self.0.count().await
            }
            async fn flush(&self) -> Result<()> {
                self.0.flush().await
            }
            async fn health_check(&self) -> Result<()> {
                self.0.health_check().await
            }
        }
    };
}

adapter!("qdrant", QdrantSidecar, "Qdrant REST vector collection.");
adapter!("chroma", Chroma, "Chroma v2 REST vector collection.");
adapter!(
    "lancedb",
    LanceDb,
    "Vector table in a local LanceDB directory."
);

#[cfg(feature = "qdrant")]
impl QdrantSidecar {
    pub async fn open(
        endpoint: &str,
        api_key: Option<&str>,
        collection: &str,
        dimensions: usize,
    ) -> Result<Self> {
        Ok(Self(
            ExternalVectorStore::open(
                EngineKind::QdrantSidecar,
                endpoint,
                collection,
                dimensions,
                api_key,
            )
            .await?,
        ))
    }
}

#[cfg(feature = "chroma")]
impl Chroma {
    pub async fn open(endpoint: &str, collection: &str, dimensions: usize) -> Result<Self> {
        Ok(Self(
            ExternalVectorStore::open(EngineKind::ChromaDb, endpoint, collection, dimensions, None)
                .await?,
        ))
    }
}

#[cfg(feature = "lancedb")]
impl LanceDb {
    pub async fn open(path: &std::path::Path, table: &str, dimensions: usize) -> Result<Self> {
        let path = path
            .to_str()
            .ok_or_else(|| CobaltError::InvalidInput("LanceDB path must be Unicode".into()))?;
        Ok(Self(
            ExternalVectorStore::open(EngineKind::LanceDb, path, table, dimensions, None).await?,
        ))
    }
}

pub(crate) struct StagingGeneration {
    index: ExternalVectorStore,
    published: std::cell::Cell<bool>,
}

impl StagingGeneration {
    pub(crate) fn new(index: ExternalVectorStore) -> Self {
        Self {
            index,
            published: std::cell::Cell::new(false),
        }
    }

    pub(crate) fn publish(&self) {
        self.published.set(true);
    }
}

impl Drop for StagingGeneration {
    fn drop(&mut self) {
        if !self.published.get()
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            let backend = self.index.backend.clone();
            runtime.spawn(async move {
                let _ = backend.destroy().await;
            });
        }
    }
}
