use std::collections::BTreeSet;

use cobalt_core::enums::{MemoryStatus, WriteAction};
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::ids::Id;
use cobalt_core::model::{NewMemory, NewSourceDocument, SourceDocument};
use rusqlite::{Connection, OptionalExtension, params};

use crate::SqliteStore;
use crate::db::sql_error;
use crate::memory::{
    WriteMode, clear_semantic_edges, configured, content_hash, embed_memory, remove_vectors,
    write_memory,
};
use crate::migration::edit_transaction;
use crate::repositories::{branch, id, load_settings, source, stamp, text, upsert_source};

const INGEST_CLIENT: &str = "cobalt-ingest";

/// Identifies the rows affected by a committed file reconciliation.
pub struct WatchedFileUpdate {
    pub previous: Option<SourceDocument>,
    pub deleted: Vec<Id>,
    pub created: Vec<Id>,
}

impl SqliteStore {
    /// Replaces a file mirror, publishing its source metadata, chunks and vectors together.
    /// Checks the disk snapshot again after embedding, before publishing.
    /// Returns the previous source state and committed IDs, or None for an unchanged mirror.
    pub async fn replace_watched_file(
        &self,
        doc: NewSourceDocument,
        branch_id: Id,
        mut chunks: Vec<NewMemory>,
        inherit_watch: bool,
        check_cancelled: impl Fn() -> Result<()> + Send + 'static,
        verify_snapshot: impl FnOnce() -> Result<()> + Send + 'static,
    ) -> Result<Option<WatchedFileUpdate>> {
        let gate = self.engine_write().await;
        check_cancelled()?;
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
        for chunk in &chunks {
            check_cancelled()?;
            vectors.push(embed_memory(configured(retrieval.as_deref())?, &chunk.content).await?);
        }
        check_cancelled()?;
        self.db
            .write(move |conn| {
                let _gate = gate;
                verify_snapshot()?;
                check_cancelled()?;
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
                        if !deleted.is_empty() {
                            remove_vectors(tx, retrieval.map(|r| &r.index), &deleted)?;
                            for id in &deleted {
                                tx.execute("DELETE FROM memories WHERE id = ?1", [id.to_string()])
                                    .map_err(sql_error)?;
                            }
                        }
                    }
                    let doc = upsert_source(tx, doc)?;
                    let mut created = Vec::new();
                    for chunk in &mut chunks {
                        chunk.source_doc_id = Some(doc.id);
                        chunk.source_client = Some(INGEST_CLIENT.into());
                        chunk.project_id = doc.project_id;
                    }
                    for branch_id in branches {
                        for (chunk, embedding) in chunks.iter().zip(&vectors) {
                            let outcome = write_memory(
                                tx,
                                configured(retrieval)?,
                                branch_id,
                                chunk.clone(),
                                embedding,
                                WriteMode::Document,
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
