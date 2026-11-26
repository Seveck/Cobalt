use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use cobalt_core::engine::{EngineSwapProgress, EngineSwapReport, EngineSwapRequest};
use cobalt_core::enums::{EngineKind, EngineSwapPhase};
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::ids::{Id, new_id, now};
use cobalt_core::traits::{Embedder, EngineMigrator, ProgressSink};
use cobalt_embeddings::{FastembedEmbedder, TiktokenCounter};
use rusqlite::{Connection, OptionalExtension, Transaction, params};

use crate::db::{blocking, sql_error};
use crate::memory::{
    add_semantic_edges, embed_memory, exact_match, project_embedding, required_memory,
    semantic_match,
};
use crate::repositories::{UPSERT_CONFIG, branch, id, load_settings, stamp};
use crate::vector::{Index, SqliteVec, Usearch, checked_vector, index_key};
use crate::{Retrieval, SqliteStore};

fn engine_error(err: impl std::fmt::Display) -> CobaltError {
    CobaltError::Engine(err.to_string())
}

fn copy_file(source: &Path, destination: &Path) -> Result<()> {
    std::fs::copy(source, destination)?;
    std::fs::OpenOptions::new()
        .write(true)
        .open(destination)?
        .sync_all()?;
    Ok(())
}

fn install_index<T>(
    target: &Usearch,
    staged: &Usearch,
    commit: impl FnOnce() -> Result<T>,
) -> Result<T> {
    let _lock = target.index_io().write().map_err(engine_error)?;
    let file = target.file();
    let parent = file
        .parent()
        .ok_or_else(|| engine_error("USearch index path has no parent"))?;
    std::fs::create_dir_all(parent)?;
    let rollback = if file.try_exists()? {
        let previous = tempfile::NamedTempFile::new_in(parent)?;
        copy_file(file, previous.path())?;
        Some(previous)
    } else {
        None
    };
    let replacement = tempfile::NamedTempFile::new_in(parent)?;
    copy_file(staged.file(), replacement.path())?;
    replacement.persist(file).map_err(|err| err.error)?;
    match commit() {
        Ok(value) => Ok(value),
        Err(error) => {
            let rollback = match rollback {
                Some(previous) => previous.persist(file).map(|_| ()).map_err(|err| err.error),
                None => std::fs::remove_file(file),
            };
            rollback.map_err(|rollback| {
                CobaltError::Integrity(format!("{error}; index rollback failed: {rollback}"))
            })?;
            Err(error)
        }
    }
}

pub(crate) fn edit_transaction<T>(
    conn: &mut Connection,
    retrieval: Option<&Retrieval>,
    edit: impl FnOnce(&Transaction<'_>, Option<&Retrieval>) -> Result<T>,
) -> Result<T> {
    let tx = conn.transaction().map_err(sql_error)?;
    if let Some(retrieval) = retrieval
        && let Index::Usearch(target) = &retrieval.index
    {
        let dir = tempfile::tempdir()?;
        let staged = target.with_file(dir.path().join("index.usearch"));
        copy_file(target.file(), staged.file())?;
        let shadow = Retrieval {
            index: staged.clone().into(),
            ..retrieval.clone()
        };
        let result = edit(&tx, Some(&shadow))?;
        return install_index(target, &staged, || {
            tx.commit().map_err(sql_error)?;
            Ok(result)
        });
    }
    let result = edit(&tx, retrieval)?;
    tx.commit().map_err(sql_error)?;
    Ok(result)
}

pub(crate) fn indexed_texts(conn: &Connection) -> Result<Vec<(Id, String)>> {
    let mut stmt = conn
        .prepare("SELECT id, content FROM memories WHERE is_encrypted = 0 ORDER BY id")
        .map_err(sql_error)?;
    stmt.query_map([], |row| Ok((id(row, "id")?, row.get("content")?)))
        .map_err(sql_error)?
        .collect::<rusqlite::Result<_>>()
        .map_err(sql_error)
}

pub(crate) async fn prepare_vectors(
    embedder: &dyn Embedder,
    rows: Vec<(Id, String)>,
    existing: Vec<Option<Vec<f32>>>,
    mut progress: impl FnMut(u64),
) -> Result<(Vec<(Id, Vec<f32>)>, u64)> {
    let mut output = Vec::with_capacity(rows.len());
    let mut reembedded = 0;
    if rows.len() != existing.len() {
        return Err(CobaltError::Internal("vector staging size mismatch".into()));
    }
    let mut rows = rows.into_iter().zip(existing);
    loop {
        let batch: Vec<_> = rows.by_ref().take(64).collect();
        if batch.is_empty() {
            break;
        }
        let inputs: Vec<_> = batch
            .iter()
            .filter(|(_, vector)| vector.is_none())
            .map(|((_, text), _)| text.clone())
            .collect();
        let mut vectors = if inputs.is_empty() {
            Vec::new()
        } else {
            embedder.embed_documents(&inputs).await?
        }
        .into_iter();
        if vectors.len() != inputs.len() {
            return Err(CobaltError::Embedding(
                "embedding count differs from batch size".into(),
            ));
        }
        reembedded += inputs.len() as u64;
        for ((id, _), existing) in batch {
            let vector = existing
                .or_else(|| vectors.next())
                .ok_or_else(|| CobaltError::Embedding("missing staged embedding".into()))?;
            checked_vector(&vector, embedder.spec().dimensions as usize)?;
            output.push((id, vector));
        }
        progress(output.len() as u64);
    }
    Ok((output, reembedded))
}

pub(crate) struct StagedIndex {
    index: Index,
    external: Option<(Usearch, Usearch, tempfile::TempDir)>,
}

impl StagedIndex {
    pub(crate) fn new(target: Index, vectors: &[(Id, Vec<f32>)], probe: &[f32]) -> Result<Self> {
        checked_vector(probe, target.dimensions())?;
        if let Index::Usearch(target) = target {
            let dir = tempfile::tempdir()?;
            let staged = target.with_file(dir.path().join("index.usearch"));
            let index = staged.new_index()?;
            index.reserve(vectors.len().max(1)).map_err(engine_error)?;
            for (id, vector) in vectors {
                index.add(index_key(*id), vector).map_err(engine_error)?;
            }
            let count = index.size();
            if count != vectors.len()
                || (count > 0 && index.search(probe, 1).map_err(engine_error)?.keys.len() != 1)
            {
                return Err(engine_error(
                    "staged USearch count or probe verification failed",
                ));
            }
            staged.publish(&index)?;
            Ok(Self {
                index: staged.clone().into(),
                external: Some((target, staged, dir)),
            })
        } else {
            Ok(Self {
                index: target,
                external: None,
            })
        }
    }

    pub(crate) fn populate(
        &self,
        conn: &Connection,
        retrieval: &Retrieval,
        vectors: &[(Id, Vec<f32>)],
        probe: &[f32],
    ) -> Result<()> {
        match &self.index {
            Index::SqliteVec(_) => {
                SqliteVec::recreate(conn, self.index.dimensions())?;
                for (id, vector) in vectors {
                    SqliteVec::replace(conn, *id, vector)?;
                }
                let count: i64 = conn
                    .query_row("SELECT count(*) FROM vec_memories", [], |row| row.get(0))
                    .map_err(sql_error)?;
                let probe = crate::vector::vector_bytes(probe);
                let distance: Option<f64> = conn
                    .query_row(
                        "SELECT vec_distance_cosine(embedding, ?1) AS distance
                     FROM vec_memories ORDER BY distance LIMIT 1",
                        [probe],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(sql_error)?;
                if count as usize != vectors.len()
                    || (count > 0 && !distance.is_some_and(f64::is_finite))
                {
                    return Err(engine_error(
                        "staged SQLite vector count or probe verification failed",
                    ));
                }
            }
            Index::Usearch(_) => {
                conn.execute("DROP TABLE IF EXISTS vec_memories", [])
                    .map_err(sql_error)?;
            }
        }
        let mut positions = conn
            .prepare("UPDATE memories SET pos_x = ?2, pos_y = ?3, pos_z = ?4 WHERE id = ?1")
            .map_err(sql_error)?;
        for (id, vector) in vectors {
            let [x, y, z] = project_embedding(vector);
            positions
                .execute(params![id.to_string(), x, y, z])
                .map_err(sql_error)?;
        }
        conn.execute("DELETE FROM memory_edges WHERE edge_type = 'semantic'", [])
            .map_err(sql_error)?;
        let threshold = load_settings(conn)?.search.semantic_edge_threshold;
        let retrieval = Retrieval {
            index: self.index.clone(),
            ..retrieval.clone()
        };
        for (id, vector) in vectors {
            add_semantic_edges(
                conn,
                &retrieval,
                &required_memory(conn, *id)?,
                vector,
                threshold,
            )?;
        }
        Ok(())
    }

    pub(crate) fn commit<T>(&self, work: impl FnOnce() -> Result<T>) -> Result<T> {
        match &self.external {
            Some((target, staged, _)) => install_index(target, staged, work),
            None => work(),
        }
    }
}

pub(crate) fn save_engine_settings(conn: &Connection, retrieval: &Retrieval) -> Result<()> {
    let updated = stamp();
    for (key, value) in [
        (
            "vector_engine",
            serde_json::to_string(&retrieval.index.kind())?,
        ),
        (
            "embedding_model_id",
            serde_json::to_string(&retrieval.embedder.spec().id)?,
        ),
        (
            "token_encoding",
            serde_json::to_string(&retrieval.tokens.encoding())?,
        ),
    ] {
        conn.execute(UPSERT_CONFIG, params![key, value, updated])
            .map_err(sql_error)?;
    }
    Ok(())
}

struct SwapProgress {
    id: Id,
    callback: ProgressSink<EngineSwapProgress>,
    processed: u64,
    total: u64,
}

impl SwapProgress {
    fn emit(&self, store: &SqliteStore, phase: EngineSwapPhase, message: Option<String>) {
        (self.callback)(EngineSwapProgress {
            swap_id: self.id,
            phase,
            processed: self.processed,
            total: self.total,
            queued_writes: store.queued_writes(),
            message,
        });
    }
}

#[async_trait]
impl EngineMigrator for SqliteStore {
    async fn swap_engine(
        &self,
        req: EngineSwapRequest,
        progress: ProgressSink<EngineSwapProgress>,
    ) -> Result<EngineSwapReport> {
        self.run_swap(req, None, progress).await
    }
}

impl SqliteStore {
    /// Switch using a provider prepared by the engine manager, including user-configured Ollama models.
    pub async fn swap_engine_with_embedder(
        &self,
        req: EngineSwapRequest,
        embedder: Arc<dyn Embedder>,
        progress: ProgressSink<EngineSwapProgress>,
    ) -> Result<EngineSwapReport> {
        self.run_swap(req, Some(embedder), progress).await
    }

    async fn run_swap(
        &self,
        req: EngineSwapRequest,
        embedder: Option<Arc<dyn Embedder>>,
        callback: ProgressSink<EngineSwapProgress>,
    ) -> Result<EngineSwapReport> {
        let store = self.clone();
        // Complete the maintenance operation even if the initiating IPC request disconnects.
        tokio::spawn(async move {
            let started_at = now();
            let mut progress = SwapProgress {
                id: new_id(),
                callback,
                processed: 0,
                total: 0,
            };
            let gate = store.engine_gate.clone().write_owned().await;
            let maintenance = store.db.maintenance().await;
            progress.emit(&store, EngineSwapPhase::QueueingWrites, None);
            let result = store
                .stage_swap(req, embedder, &mut progress, started_at)
                .await;
            match &result {
                Ok(_) => progress.emit(&store, EngineSwapPhase::Draining, None),
                Err(error) => {
                    progress.emit(
                        &store,
                        EngineSwapPhase::RollingBack,
                        Some(error.to_string()),
                    );
                    progress.emit(&store, EngineSwapPhase::RolledBack, None);
                }
            }
            drop(maintenance);
            drop(gate);
            if result.is_ok() {
                // Fair gates place these barriers after the requests that queued during the swap.
                let _gate = store.engine_gate.write().await;
                let _maintenance = store.db.maintenance().await;
                progress.emit(&store, EngineSwapPhase::Completed, None);
            }
            result
        })
        .await
        .map_err(|err| CobaltError::Internal(err.to_string()))?
    }

    async fn stage_swap(
        &self,
        req: EngineSwapRequest,
        embedder: Option<Arc<dyn Embedder>>,
        progress: &mut SwapProgress,
        started_at: cobalt_core::ids::Timestamp,
    ) -> Result<EngineSwapReport> {
        progress.emit(self, EngineSwapPhase::Staging, None);
        let current = self.configured_retrieval()?;
        let settings = self.db.read(load_settings).await?;
        let embedder: Arc<dyn Embedder> = match embedder {
            Some(embedder) => embedder,
            None => match &current {
                Some(current) if current.embedder.spec().id == req.target_model_id => {
                    current.embedder.clone()
                }
                _ => Arc::new(FastembedEmbedder::from_catalog(&req.target_model_id)?),
            },
        };
        if embedder.spec().id != req.target_model_id {
            return Err(CobaltError::InvalidInput(
                "target embedder model and requested id differ".into(),
            ));
        }
        let dims = embedder.spec().dimensions as usize;
        let index: Index = match req.target_engine {
            EngineKind::SqliteVec => SqliteVec::handle(self, dims).into(),
            EngineKind::Usearch => Usearch::handle(
                self,
                self.data_path(cobalt_core::paths::VECTOR_INDEX_DIR),
                &req.target_model_id,
                dims,
            )?
            .into(),
            engine => {
                return Err(engine_error(format!(
                    "no {engine} vector adapter is installed"
                )));
            }
        };
        let target = Retrieval {
            index,
            embedder,
            tokens: current.as_ref().map_or_else(
                || {
                    Arc::new(TiktokenCounter::new(settings.token_encoding))
                        as Arc<dyn cobalt_core::traits::TokenCounter>
                },
                |current| current.tokens.clone(),
            ),
        };
        let reuse = current
            .as_ref()
            .filter(|current| current.embedder.spec() == target.embedder.spec())
            .cloned();
        let (rows, existing) = self
            .db
            .read(move |conn| {
                let rows = indexed_texts(conn)?;
                let existing = if let Some(current) = reuse {
                    current
                        .index
                        .vectors(conn, &rows.iter().map(|(id, _)| *id).collect::<Vec<_>>())?
                } else {
                    vec![None; rows.len()]
                };
                Ok((rows, existing))
            })
            .await?;
        progress.total = rows.len() as u64;
        progress.emit(self, EngineSwapPhase::Reindexing, None);
        let probe = target
            .embedder
            .embed_query("Cobalt vector index verification")
            .await?;
        let (vectors, reembedded) =
            prepare_vectors(target.embedder.as_ref(), rows, existing, |processed| {
                progress.processed = processed;
                progress.emit(self, EngineSwapPhase::Reindexing, None);
            })
            .await?;
        let verified_count = vectors.len() as u64;
        progress.emit(self, EngineSwapPhase::Verifying, None);
        let stage_index = target.index.clone();
        let (stage, vectors, probe) = blocking(move || {
            Ok((
                StagedIndex::new(stage_index, &vectors, &probe)?,
                vectors,
                probe,
            ))
        })
        .await?;
        let from_engine = current
            .as_ref()
            .map_or(settings.vector_engine, |current| current.index.kind());
        let from_model_id = current
            .as_ref()
            .map_or(settings.embedding_model_id, |current| {
                current.embedder.spec().id.clone()
            });
        let reclaimable_bytes = if from_model_id == req.target_model_id {
            0
        } else {
            current
                .as_ref()
                .map_or(0, |current| current.embedder.spec().size_bytes)
        };
        let store = self.clone();
        let on_swapping = progress.callback.clone();
        let swapping = EngineSwapProgress {
            swap_id: progress.id,
            phase: EngineSwapPhase::Swapping,
            processed: progress.processed,
            total: progress.total,
            queued_writes: 0,
            message: None,
        };
        self.db
            .write_exclusive(move |conn| {
                let tx = conn.transaction().map_err(sql_error)?;
                stage.populate(&tx, &target, &vectors, &probe)?;
                save_engine_settings(&tx, &target)?;
                on_swapping(EngineSwapProgress {
                    queued_writes: store.queued_writes(),
                    ..swapping
                });
                let mut state = store
                    .retrieval
                    .write()
                    .map_err(|_| CobaltError::Internal("retrieval lock poisoned".into()))?;
                stage.commit(|| tx.commit().map_err(sql_error))?;
                *state = Some(Arc::new(target));
                Ok(())
            })
            .await?;
        Ok(EngineSwapReport {
            swap_id: progress.id,
            from_engine,
            to_engine: req.target_engine,
            from_model_id,
            to_model_id: req.target_model_id,
            reembedded,
            verified_count,
            rolled_back: false,
            started_at,
            finished_at: now(),
            reclaimable_bytes,
        })
    }

    /// Lookup used by backup import before it chooses the target branch.
    pub async fn find_import_collision(
        &self,
        content: &str,
        project_id: Option<Id>,
        branch_id: Option<Id>,
    ) -> Result<Option<(Id, f64)>> {
        let _gate = self.engine_gate.read().await;
        let retrieval = self.retrieval()?;
        let hash = crate::memory::content_hash(content);
        let (branch_id, exact) = self
            .db
            .read(move |conn| {
                let target = branch(conn, branch_id)?.id;
                Ok((target, exact_match(conn, target, project_id, &hash, None)?))
            })
            .await?;
        if let Some(row) = exact {
            return Ok(Some((row.id, 1.0)));
        }
        let embedding = embed_memory(&retrieval, content).await?;
        self.db
            .read(move |conn| {
                let tx = conn.unchecked_transaction().map_err(sql_error)?;
                let threshold = load_settings(&tx)?.search.import_collision_threshold;
                Ok(
                    semantic_match(&tx, &retrieval, branch_id, project_id, &embedding)?
                        .filter(|(_, score)| *score >= threshold)
                        .map(|(row, score)| (row.id, score)),
                )
            })
            .await
    }
}
