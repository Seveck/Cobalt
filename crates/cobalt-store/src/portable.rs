use cobalt_core::SCHEMA_VERSION;
use cobalt_core::enums::{EdgeType, MemoryStatus};
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::ids::{Id, Timestamp, timestamp_to_sql};
use cobalt_core::model::{Handoff, Memory, MemoryEdge, SourceDocument};
use cobalt_core::telemetry::TelemetryLog;
use rusqlite::{TransactionBehavior, params};

use crate::SqliteStore;
use crate::db::sql_error;
use crate::lifecycle::handoff;
use crate::memory::{
    content_hash, embed_memory, mark_superseded, project_embedding, refresh_edges, required_memory,
};
use crate::migration::edit_transaction;
use crate::repositories::{load_settings, source};
use crate::telemetry::account_imported_event;

impl SqliteStore {
    /// Inserts a previously validated portable memory without merging it with unrelated local data.
    /// The expected previous timestamp prevents stale imports from versioning concurrent local edits.
    pub async fn insert_portable_memory(
        &self,
        row: Memory,
        previous: Option<(Id, Timestamp)>,
    ) -> Result<bool> {
        if row.is_encrypted
            || row.content.trim().is_empty()
            || content_hash(&row.content) != row.content_hash
        {
            return Err(CobaltError::InvalidInput(
                "invalid portable memory content".into(),
            ));
        }
        let gate = self.engine_write().await;
        let retrieval = self.retrieval()?;
        let embedding = embed_memory(&retrieval, &row.content).await?;
        self.db.write(move |conn| {
            let _gate = gate;
            edit_transaction(conn, Some(&retrieval), |tx, index| {
                if let Some(existing) = crate::memory::memory_by_id(tx, row.id)? {
                    if existing.content_hash == row.content_hash { return Ok(false); }
                    return Err(CobaltError::Conflict(format!("memory {} changed during import", row.id)));
                }
                if let Some((id, updated_at)) = previous {
                    let old = required_memory(tx, id)?;
                    if old.updated_at != updated_at || old.is_encrypted || old.status == MemoryStatus::Superseded {
                        return Err(CobaltError::Conflict(format!("memory {id} changed during import")));
                    }
                }
                let [x, y, z] = project_embedding(&embedding);
                let count = i64::try_from(retrieval.tokens.count(&row.content))
                    .map_err(|_| CobaltError::InvalidInput("memory token count exceeds SQLite range".into()))?;
                tx.execute(
                    "INSERT INTO memories (id, branch_id, project_id, source_doc_id, content, content_hash,
                      source_type, category, confidence, status, version_reason, is_core_pin, is_reusable,
                      reusable_snippet, reuse_count, chunk_tokens, hit_count, relevance_score, pos_x, pos_y, pos_z,
                      created_at, updated_at, last_accessed_at, source_client, superseded_by)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                             ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26)",
                    params![row.id.to_string(), row.branch_id.to_string(), row.project_id.map(|id| id.to_string()),
                        row.source_doc_id.map(|id| id.to_string()), row.content, row.content_hash, row.source_type.as_str(),
                        row.category.as_str(), row.confidence, row.status.as_str(), row.version_reason, row.is_core_pin,
                        row.is_reusable, row.reusable_snippet, row.reuse_count, count, row.hit_count, row.relevance_score,
                        x, y, z, timestamp_to_sql(&row.created_at), timestamp_to_sql(&row.updated_at),
                        row.last_accessed_at.as_ref().map(timestamp_to_sql), row.source_client, row.superseded_by.map(|id| id.to_string())],
                ).map_err(sql_error)?;
                if let Some((id, _)) = previous {
                    mark_superseded(tx, id, row.id, "Superseded by newer imported memory", 1.0)?;
                }
                if let Some(next) = row.superseded_by {
                    tx.execute("INSERT INTO memory_edges (source_id, target_id, edge_type, weight)
                                VALUES (?1, ?2, 'supersedes', 1.0) ON CONFLICT DO NOTHING",
                        params![next.to_string(), row.id.to_string()]).map_err(sql_error)?;
                }
                let retrieval = crate::memory::configured(index)?;
                refresh_edges(tx, retrieval, &row, &embedding, load_settings(tx)?.search.semantic_edge_threshold)?;
                retrieval.index.insert(tx, row.id, &embedding)?;
                Ok(true)
            })
        }).await
    }

    pub async fn portable_source_documents(&self) -> Result<Vec<SourceDocument>> {
        self.db
            .read(|conn| {
                let mut stmt = conn
                    .prepare("SELECT * FROM source_documents ORDER BY id")
                    .map_err(sql_error)?;
                stmt.query_map([], source)
                    .map_err(sql_error)?
                    .collect::<rusqlite::Result<_>>()
                    .map_err(sql_error)
            })
            .await
    }

    pub async fn portable_handoffs(&self) -> Result<Vec<Handoff>> {
        self.db
            .read(|conn| {
                let mut stmt = conn
                    .prepare("SELECT * FROM handoffs ORDER BY id")
                    .map_err(sql_error)?;
                stmt.query_map([], handoff)
                    .map_err(sql_error)?
                    .collect::<rusqlite::Result<_>>()
                    .map_err(sql_error)
            })
            .await
    }

    /// Restores portable history without replacing existing telemetry, handoffs, or edges.
    pub async fn insert_portable_history(
        &self,
        edges: Vec<MemoryEdge>,
        versions: Vec<(Id, Id)>,
        handoffs: Vec<Handoff>,
        logs: Vec<TelemetryLog>,
    ) -> Result<()> {
        self.import_history(None, edges, versions, handoffs, logs)
            .await
    }

    /// Restores history using the schema version from the backup manifest.
    pub async fn insert_portable_history_for_schema(
        &self,
        schema_version: u32,
        edges: Vec<MemoryEdge>,
        versions: Vec<(Id, Id)>,
        handoffs: Vec<Handoff>,
        logs: Vec<TelemetryLog>,
    ) -> Result<()> {
        if !(1..=SCHEMA_VERSION).contains(&schema_version) {
            return Err(CobaltError::Unsupported(format!(
                "history uses schema {schema_version}"
            )));
        }
        self.import_history(Some(schema_version < 3), edges, versions, handoffs, logs)
            .await
    }

    async fn import_history(
        &self,
        legacy_telemetry: Option<bool>,
        edges: Vec<MemoryEdge>,
        versions: Vec<(Id, Id)>,
        handoffs: Vec<Handoff>,
        mut logs: Vec<TelemetryLog>,
    ) -> Result<()> {
        logs.sort_unstable_by_key(|log| (log.timestamp, log.id));
        self.db.write(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(sql_error)?;
            for (id, next) in versions {
                tx.execute("UPDATE memories SET superseded_by = ?2 WHERE id = ?1
                            AND status = 'superseded' AND superseded_by IS NULL",
                    params![id.to_string(), next.to_string()]).map_err(sql_error)?;
            }
            for edge in edges.into_iter().filter(|edge| edge.edge_type != EdgeType::Semantic && edge.source_id != edge.target_id) {
                tx.execute("INSERT INTO memory_edges (source_id, target_id, edge_type, weight)
                            VALUES (?1, ?2, ?3, ?4) ON CONFLICT DO NOTHING",
                    params![edge.source_id.to_string(), edge.target_id.to_string(), edge.edge_type.as_str(), edge.weight])
                    .map_err(sql_error)?;
            }
            for entry in handoffs {
                tx.execute("INSERT INTO handoffs (id, project_id, source_client, summary, last_error, open_files_json,
                            created_at, expires_at, consumed_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                            ON CONFLICT(id) DO NOTHING",
                    params![entry.id.to_string(), entry.project_id.map(|id| id.to_string()), entry.source_client,
                        entry.summary, entry.last_error, serde_json::to_string(&entry.open_files)?,
                        timestamp_to_sql(&entry.created_at), timestamp_to_sql(&entry.expires_at), entry.consumed_by])
                    .map_err(sql_error)?;
            }
            for log in logs {
                let (avoided, saved, items) = account_imported_event(&tx, &log, legacy_telemetry)?;
                tx.execute("INSERT INTO telemetry_logs (id, timestamp, client_name, operation, query_text,
                            returned_items_json, injected_tokens, avoided_full_tokens, saved_tokens, latency_ms, project_id)
                            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) ON CONFLICT(id) DO NOTHING",
                    params![log.id.to_string(), timestamp_to_sql(&log.timestamp), log.client_name, log.operation.as_str(),
                        log.query_text, items, log.injected_tokens,
                        avoided, saved, log.latency_ms, log.project_id.map(|id| id.to_string())])
                    .map_err(sql_error)?;
            }
            tx.commit().map_err(sql_error)
        }).await
    }

    pub async fn portable_embedding_dimensions(&self) -> Result<u32> {
        Ok(self.retrieval()?.embedder.spec().dimensions)
    }
}
