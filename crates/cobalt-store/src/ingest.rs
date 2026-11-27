use std::collections::BTreeSet;
use std::path::MAIN_SEPARATOR_STR;

use cobalt_core::enums::{MemoryStatus, WriteAction};
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::ids::Id;
use cobalt_core::model::{NewMemory, NewSourceDocument, SourceDocument};
use rusqlite::{Connection, OptionalExtension, params};

use crate::db::sql_error;
use crate::memory::{
    WriteMode, clear_semantic_edges, configured, content_hash, embed_document_chunks,
    remove_vectors, token_count, write_memory,
};
use crate::migration::edit_transaction;
use crate::repositories::{branch, id, load_settings, source, stamp, text, upsert_source};
use crate::vector::Index;
use crate::{DOCUMENT_EMBED_BATCH, SqliteStore};

const INGEST_CLIENT: &str = "cobalt-ingest";

/// Identifies the rows affected by a committed file reconciliation.
pub struct WatchedFileUpdate {
    pub previous: Option<SourceDocument>,
    pub deleted: Vec<Id>,
    pub created: Vec<Id>,
}

impl SqliteStore {
    /// Whether this branch already has an active watcher or ingest mirror for the source.
    pub async fn has_ingested_chunks(&self, branch_id: Id, source_id: Id) -> Result<bool> {
        self.db
            .read(move |conn| {
                conn.query_row(
                    "SELECT EXISTS(
                    SELECT 1 FROM memories WHERE branch_id = ?1 AND source_doc_id = ?2
                      AND source_client = ?3 AND status = 'active'
                )",
                    params![branch_id.to_string(), source_id.to_string(), INGEST_CLIENT],
                    |row| row.get(0),
                )
                .map_err(sql_error)
            })
            .await
    }

    /// Replaces a file mirror, publishing its source metadata, chunks and vectors together.
    /// Checks the disk snapshot again after embedding, before publishing.
    /// Returns the previous source state and committed IDs, or None for an unchanged mirror.
    pub async fn replace_watched_file(
        &self,
        doc: NewSourceDocument,
        branch_id: Id,
        chunks: Vec<NewMemory>,
        inherit_watch: bool,
        check_cancelled: impl Fn() -> Result<()> + Send + 'static,
        verify_snapshot: impl FnOnce() -> Result<()> + Send + 'static,
    ) -> Result<Option<WatchedFileUpdate>> {
        self.replace_watched_file_with_progress(
            doc,
            branch_id,
            chunks,
            inherit_watch,
            move |_| check_cancelled(),
            verify_snapshot,
        )
        .await
    }

    /// Calls `on_batch` after each embedding batch and with zero at cancellation checkpoints.
    pub async fn replace_watched_file_with_progress(
        &self,
        doc: NewSourceDocument,
        branch_id: Id,
        mut chunks: Vec<NewMemory>,
        inherit_watch: bool,
        on_batch: impl Fn(usize) -> Result<()> + Send + 'static,
        verify_snapshot: impl FnOnce() -> Result<()> + Send + 'static,
    ) -> Result<Option<WatchedFileUpdate>> {
        let gate = self.engine_write().await;
        on_batch(0)?;
        let path = doc.file_path.clone();
        let prior = self.db.read(move |conn| source_at(conn, &path)).await?;
        if let Some(prior) = &prior {
            if !prior.is_watched && !inherit_watch {
                return Ok(None);
            }
            if prior.is_watched
                && prior.file_hash == doc.file_hash
                && prior.project_id == doc.project_id
                && prior.total_tokens == doc.total_tokens
                && !prior.is_dir
            {
                let old = self
                    .ingested_memories(branch_id, prior.id, INGEST_CLIENT)
                    .await?;
                let expected: BTreeSet<_> = chunks
                    .iter()
                    .map(|chunk| content_hash(&chunk.content))
                    .collect();
                let reusable = chunks.iter().any(|chunk| chunk.is_reusable);
                if old.len() == expected.len()
                    && old.iter().all(|row| {
                        expected.contains(&row.content_hash)
                            && (!reusable || (row.is_reusable && row.reusable_snippet.is_some()))
                    })
                {
                    return Ok(None);
                }
            }
        }
        let retrieval = self.configured_retrieval()?;
        let mut vectors = Vec::with_capacity(chunks.len());
        for batch in chunks.chunks(DOCUMENT_EMBED_BATCH) {
            on_batch(0)?;
            vectors.extend(embed_document_chunks(configured(retrieval.as_deref())?, batch).await?);
            on_batch(batch.len())?;
        }
        on_batch(0)?;
        self.db
            .write(move |conn| {
                let _gate = gate;
                on_batch(0)?;
                verify_snapshot()?;
                on_batch(0)?;
                edit_transaction(conn, retrieval.as_deref(), |tx, retrieval| {
                    check_writable(tx)?;
                    if source_at(tx, &doc.file_path)? != prior {
                        return Err(CobaltError::Conflict(
                            "watched source changed during indexing".into(),
                        ));
                    }
                    let mut branches = BTreeSet::from([branch(tx, Some(branch_id))?.id]);
                    let mut deleted = Vec::new();
                    if let Some(prior) = &prior {
                        let mut stmt = tx
                            .prepare(
                                "SELECT id, branch_id, status FROM memories
                             WHERE source_doc_id = ?1 AND source_client = ?2
                               AND NOT (status = 'archived' AND version_reason IS 'file deleted')",
                            )
                            .map_err(sql_error)?;
                        for row in stmt
                            .query_map(params![prior.id.to_string(), INGEST_CLIENT], |row| {
                                Ok((
                                    id(row, "id")?,
                                    id(row, "branch_id")?,
                                    text::<MemoryStatus>(row, "status")?,
                                ))
                            })
                            .map_err(sql_error)?
                        {
                            let (id, branch_id, status) = row.map_err(sql_error)?;
                            if status == MemoryStatus::Active {
                                branches.insert(branch_id);
                            }
                            deleted.push(id);
                        }
                        delete_chunks(tx, retrieval.map(|r| &r.index), &deleted)?;
                    }
                    let doc = upsert_source(tx, doc)?;
                    let mut created = Vec::new();
                    for chunk in &mut chunks {
                        chunk.source_doc_id = Some(doc.id);
                        chunk.source_client = Some(INGEST_CLIENT.into());
                        chunk.project_id = doc.project_id;
                    }
                    let counts = chunks
                        .iter()
                        .map(|chunk| token_count(configured(retrieval)?, &chunk.content))
                        .collect::<Result<Vec<_>>>()?;
                    for branch_id in branches {
                        for ((chunk, embedding), count) in chunks.iter().zip(&vectors).zip(&counts)
                        {
                            let outcome = write_memory(
                                tx,
                                configured(retrieval)?,
                                branch_id,
                                chunk.clone(),
                                embedding,
                                WriteMode::CountedDocument(*count),
                            )?;
                            if outcome.action == WriteAction::Inserted {
                                created.push(outcome.memory.id);
                            }
                        }
                    }
                    Ok(Some(WatchedFileUpdate {
                        previous: prior,
                        deleted,
                        created,
                    }))
                })
            })
            .await
    }

    /// Lists indexed sources at or beneath the given directory.
    pub async fn source_documents_under(&self, directory: String) -> Result<Vec<SourceDocument>> {
        let prefix = format!(
            "{}{MAIN_SEPARATOR_STR}",
            directory.trim_end_matches(MAIN_SEPARATOR_STR),
        );
        self.db
            .read(move |conn| {
                let mut stmt = conn
                    .prepare(
                        "SELECT * FROM source_documents
                     WHERE file_path = ?1 OR instr(file_path, ?2) = 1",
                    )
                    .map_err(sql_error)?;
                stmt.query_map(params![directory, prefix], source)
                    .map_err(sql_error)?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(sql_error)
            })
            .await
    }

    /// Removes ignored sources and their ingest mirrors in one store/index edit.
    /// The source foreign key detaches any remaining memories from the removed documents.
    pub async fn prune_ingested_sources(
        &self,
        sources: Vec<SourceDocument>,
        check_cancelled: impl Fn() -> Result<()> + Send + 'static,
    ) -> Result<(Vec<String>, Vec<Id>)> {
        if sources.is_empty() {
            return Ok((Vec::new(), Vec::new()));
        }
        let gate = self.engine_write().await;
        let retrieval = self.configured_retrieval()?;
        self.db
            .write(move |conn| {
                let _gate = gate;
                check_cancelled()?;
                edit_transaction(conn, retrieval.as_deref(), |tx, retrieval| {
                    check_writable(tx)?;
                    let mut removed = Vec::new();
                    let mut deleted = Vec::new();
                    let mut source_ids = Vec::new();
                    {
                        let mut chunks = tx.prepare(
                            "SELECT id FROM memories WHERE source_doc_id = ?1 AND source_client = ?2",
                        ).map_err(sql_error)?;
                        for doc in sources {
                            if !source_at(tx, &doc.file_path)?.is_some_and(|current| current.id == doc.id) {
                                continue;
                            }
                            let source_id = doc.id.to_string();
                            for row in chunks
                                .query_map(params![source_id, INGEST_CLIENT], |row| id(row, "id"))
                                .map_err(sql_error)?
                            {
                                deleted.push(row.map_err(sql_error)?);
                            }
                            source_ids.push(source_id);
                            removed.push(doc.file_path);
                        }
                    }
                    delete_chunks(tx, retrieval.map(|r| &r.index), &deleted)?;
                    let mut delete_source = tx
                        .prepare("DELETE FROM source_documents WHERE id = ?1")
                        .map_err(sql_error)?;
                    for id in source_ids {
                        delete_source.execute([id]).map_err(sql_error)?;
                    }
                    Ok((removed, deleted))
                })
            })
            .await
    }

    /// Archives the active ingest mirrors for a missing or excluded watched file.
    /// Keeps its source ID and watch registration so the path can be indexed again.
    pub async fn archive_watched_file(
        &self,
        path: String,
        reason: &'static str,
    ) -> Result<Vec<Id>> {
        self.db
            .write(move |conn| {
                let tx = conn.transaction().map_err(sql_error)?;
                let Some(doc) = source_at(&tx, &path)?.filter(|doc| doc.is_watched && !doc.is_dir)
                else {
                    return Ok(Vec::new());
                };
                check_writable(&tx)?;
                let ids = {
                    let mut stmt = tx.prepare(
                    "UPDATE memories SET status = 'archived', version_reason = ?3, updated_at = ?4
                     WHERE source_doc_id = ?1 AND source_client = ?2 AND status = 'active'
                     RETURNING id",
                ).map_err(sql_error)?;
                    stmt.query_map(
                        params![doc.id.to_string(), INGEST_CLIENT, reason, stamp()],
                        |row| id(row, "id"),
                    )
                    .map_err(sql_error)?
                    .collect::<rusqlite::Result<Vec<Id>>>()
                    .map_err(sql_error)?
                };
                for &id in &ids {
                    clear_semantic_edges(&tx, id)?;
                }
                if doc.file_hash.is_some() || doc.total_tokens != 0 {
                    tx.execute(
                    "UPDATE source_documents SET file_hash = NULL, total_tokens = 0, updated_at = ?2
                     WHERE id = ?1",
                    params![doc.id.to_string(), stamp()],
                ).map_err(sql_error)?;
                }
                tx.commit().map_err(sql_error)?;
                Ok(ids)
            })
            .await
    }
}

fn delete_chunks(conn: &Connection, index: Option<&Index>, ids: &[Id]) -> Result<()> {
    if !ids.is_empty() {
        remove_vectors(conn, index, ids)?;
        let mut delete = conn
            .prepare("DELETE FROM memories WHERE id = ?1")
            .map_err(sql_error)?;
        for id in ids {
            delete.execute([id.to_string()]).map_err(sql_error)?;
        }
    }
    Ok(())
}

fn source_at(conn: &Connection, path: &str) -> Result<Option<SourceDocument>> {
    conn.query_row(
        "SELECT * FROM source_documents WHERE file_path = ?1",
        [path],
        source,
    )
    .optional()
    .map_err(sql_error)
}

fn check_writable(conn: &Connection) -> Result<()> {
    if load_settings(conn)?.read_only {
        return Err(CobaltError::ReadOnly);
    }
    Ok(())
}
