use std::collections::HashSet;

use async_trait::async_trait;
use cobalt_core::enums::{EdgeType, MemoryStatus, SourceType, WriteAction};
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::ids::{Id, new_id};
use cobalt_core::model::{
    GraphData, GraphNode, GraphQuery, Memory, MemoryEdge, MemoryPatch, NewMemory, SaveOutcome,
    UpdateMemoryRequest,
};
use cobalt_core::search::{ProjectScope, SearchFilter, VectorFilter};
use cobalt_core::traits::MemoryRepository;
use rusqlite::{Connection, OptionalExtension, Row, params};
use sha2::{Digest, Sha256};

use crate::db::sql_error;
use crate::migration::edit_transaction;
use crate::repositories::{
    branch, id, load_settings, optional_id, optional_timestamp, project_stats, source_by_id, stamp,
    text, timestamp,
};
use crate::vector::{Index, Scope, checked_vector};
use crate::{Retrieval, SqliteStore, calibrated_similarity};

pub(crate) fn memory(row: &Row<'_>) -> rusqlite::Result<Memory> {
    Ok(Memory {
        id: id(row, "id")?,
        branch_id: id(row, "branch_id")?,
        project_id: optional_id(row, "project_id")?,
        source_doc_id: optional_id(row, "source_doc_id")?,
        content: row.get("content")?,
        content_hash: row.get("content_hash")?,
        source_type: text(row, "source_type")?,
        category: text(row, "category")?,
        confidence: row.get("confidence")?,
        status: text(row, "status")?,
        superseded_by: optional_id(row, "superseded_by")?,
        version_reason: row.get("version_reason")?,
        is_core_pin: row.get("is_core_pin")?,
        is_reusable: row.get("is_reusable")?,
        reusable_snippet: row.get("reusable_snippet")?,
        reuse_count: row.get("reuse_count")?,
        is_encrypted: row.get("is_encrypted")?,
        ciphertext: row.get("ciphertext")?,
        nonce: row.get("nonce")?,
        chunk_tokens: row.get("chunk_tokens")?,
        hit_count: row.get("hit_count")?,
        relevance_score: row.get("relevance_score")?,
        pos_x: row.get("pos_x")?,
        pos_y: row.get("pos_y")?,
        pos_z: row.get("pos_z")?,
        created_at: timestamp(row, "created_at")?,
        updated_at: timestamp(row, "updated_at")?,
        last_accessed_at: optional_timestamp(row, "last_accessed_at")?,
        source_client: row.get("source_client")?,
    })
}

pub(crate) fn memory_by_id(conn: &Connection, id: Id) -> Result<Option<Memory>> {
    conn.query_row(
        "SELECT * FROM memories WHERE id = ?1",
        [id.to_string()],
        memory,
    )
    .optional()
    .map_err(sql_error)
}

/// Applies a fixed-seed random sign matrix, then scales the projection into the radius-100 sphere.
/// The radial clamp preserves differences between projections within the sphere.
pub fn project_embedding(embedding: &[f32]) -> [f64; 3] {
    // SplitMix64 produces a repeatable sequence independent of platform and crate versions.
    let mut state = 0x0b8a_f651_8df3_045b_u64;
    let mut coords = [0.0; 3];
    let mut energy = 0.0;
    for &component in embedding {
        let component = f64::from(component);
        energy += component * component;
        state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut bits = state;
        bits = (bits ^ (bits >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        bits = (bits ^ (bits >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        bits ^= bits >> 31;
        for (axis, coord) in coords.iter_mut().enumerate() {
            *coord += if bits & (1 << axis) == 0 {
                component
            } else {
                -component
            };
        }
    }
    if !energy.is_finite() || energy == 0.0 {
        return [0.0; 3];
    }
    let radius = coords.iter().map(|value| value * value).sum::<f64>().sqrt();
    // Leave room for roundoff when the scaled coordinates are converted back to a radius.
    let scale = (100.0 - 1e-12) / radius.max((3.0 * energy).sqrt());
    coords.map(|component| component * scale)
}

fn graph_node(row: &Row<'_>) -> rusqlite::Result<GraphNode> {
    let position = match (row.get("pos_x")?, row.get("pos_y")?, row.get("pos_z")?) {
        (Some(x), Some(y), Some(z)) => Some([x, y, z]),
        _ => None,
    };
    Ok(GraphNode {
        id: id(row, "id")?,
        branch_id: id(row, "branch_id")?,
        project_id: optional_id(row, "project_id")?,
        source_doc_id: optional_id(row, "source_doc_id")?,
        source_type: text(row, "source_type")?,
        category: text(row, "category")?,
        status: text(row, "status")?,
        confidence: row.get("confidence")?,
        is_core_pin: row.get("is_core_pin")?,
        is_reusable: row.get("is_reusable")?,
        is_encrypted: row.get("is_encrypted")?,
        reuse_count: row.get("reuse_count")?,
        hit_count: row.get("hit_count")?,
        relevance_score: row.get("relevance_score")?,
        chunk_tokens: row.get("chunk_tokens")?,
        superseded_by: optional_id(row, "superseded_by")?,
        position,
        preview: row.get("preview")?,
        updated_at: timestamp(row, "updated_at")?,
    })
}

impl SqliteStore {
    /// Inserts a document chunk without treating similar adjacent chunks as versions.
    pub async fn insert_document_chunk(&self, new: NewMemory) -> Result<SaveOutcome> {
        let gate = self.engine_write().await;
        validate_content(&new.content, new.confidence.unwrap_or(1.0))?;
        if new.source_doc_id.is_none() {
            return Err(CobaltError::InvalidInput(
                "a document chunk requires a source document".into(),
            ));
        }
        let retrieval = self.retrieval()?;
        let embedding = embed_memory(&retrieval, &new.content).await?;
        self.db
            .write(move |conn| {
                let _gate = gate;
                edit_transaction(conn, Some(&retrieval), |tx, retrieval| {
                    let branch_id = branch(tx, new.branch_id)?.id;
                    write_memory(
                        tx,
                        configured(retrieval)?,
                        branch_id,
                        new,
                        &embedding,
                        WriteMode::Document,
                    )
                })
            })
            .await
    }

    /// Active chunks previously written by a particular import mode.
    pub async fn ingested_memories(
        &self,
        branch_id: Id,
        source_id: Id,
        client: &str,
    ) -> Result<Vec<Memory>> {
        let client = client.to_owned();
        self.db
            .read(move |conn| {
                let mut stmt = conn
                    .prepare(
                        "SELECT * FROM memories WHERE branch_id = ?1 AND source_doc_id = ?2
                 AND source_client = ?3 AND status = 'active' ORDER BY id",
                    )
                    .map_err(sql_error)?;
                stmt.query_map(
                    params![branch_id.to_string(), source_id.to_string(), client],
                    memory,
                )
                .map_err(sql_error)?
                .collect::<rusqlite::Result<_>>()
                .map_err(sql_error)
            })
            .await
    }
}

#[async_trait]
impl MemoryRepository for SqliteStore {
    async fn save_memory(&self, new: NewMemory) -> Result<SaveOutcome> {
        let gate = self.engine_write().await;
        validate_content(&new.content, new.confidence.unwrap_or(1.0))?;
        let hash = content_hash(&new.content);
        let requested_branch = new.branch_id;
        let project = new.project_id;
        // Avoid calling the embedder at all for a known exact duplicate.
        let (branch_id, duplicate) = self
            .db
            .read(move |conn| {
                let branch_id = branch(conn, requested_branch)?.id;
                Ok((
                    branch_id,
                    exact_match(conn, branch_id, project, &hash, None)?,
                ))
            })
            .await?;
        if let Some(memory) = duplicate {
            if memory.is_encrypted {
                return Err(CobaltError::Conflict(
                    "content is already protected by the vault".into(),
                ));
            }
            return Ok(outcome(WriteAction::Duplicate, memory, None, Some(1.0)));
        }
        let retrieval = self.retrieval()?;
        let embedding = embed_memory(&retrieval, &new.content).await?;
        self.db
            .write(move |conn| {
                let _gate = gate;
                edit_transaction(conn, Some(&retrieval), |tx, retrieval| {
                    write_memory(
                        tx,
                        configured(retrieval)?,
                        branch_id,
                        new,
                        &embedding,
                        WriteMode::Normal,
                    )
                })
            })
            .await
    }

    async fn archive_memory(&self, id: Id, reason: &str) -> Result<Memory> {
        if reason.trim().is_empty() {
            return Err(CobaltError::InvalidInput("archive reason is empty".into()));
        }
        let reason = reason.to_owned();
        self.db
            .write(move |conn| {
                let tx = conn.transaction().map_err(sql_error)?;
                let row = required_memory(&tx, id)?;
                if row.is_core_pin || row.status == MemoryStatus::Superseded {
                    return Err(CobaltError::Conflict(
                        "cannot archive a Nuclear Law or superseded version".into(),
                    ));
                }
                if row.status == MemoryStatus::Archived {
                    return Ok(row);
                }
                let archived = tx.query_row(
                    "UPDATE memories SET status = 'archived', version_reason = ?2, updated_at = ?3
                 WHERE id = ?1 RETURNING *",
                    params![id.to_string(), reason, stamp()],
                    memory,
                )
                .map_err(sql_error)?;
                clear_semantic_edges(&tx, id)?;
                tx.commit().map_err(sql_error)?;
                Ok(archived)
            })
            .await
    }

    async fn find_similar(
        &self,
        content: &str,
        project_id: Option<Id>,
        min_similarity: f64,
    ) -> Result<Option<(Memory, f64)>> {
        validate_content(content, min_similarity)?;
        let _gate = self.engine_gate.read().await;
        let retrieval = self.retrieval()?;
        let embedding = embed_memory(&retrieval, content).await?;
        self.db
            .read(move |conn| {
                let tx = conn.unchecked_transaction().map_err(sql_error)?;
                let branch_id = branch(&tx, None)?.id;
                Ok(
                    semantic_match(&tx, &retrieval, branch_id, project_id, &embedding)?
                        .filter(|(_, score)| *score >= min_similarity),
                )
            })
            .await
    }

    async fn get_memory(&self, id: Id) -> Result<Option<Memory>> {
        self.db.read(move |conn| memory_by_id(conn, id)).await
    }

    async fn graph(&self, query: GraphQuery) -> Result<GraphData> {
        self.db.read(move |conn| {
            let tx = conn.unchecked_transaction().map_err(sql_error)?;
            let branch = branch(&tx, query.branch_id)?;
            let min_weight = query.min_edge_weight.unwrap_or(load_settings(&tx)?.search.semantic_edge_threshold);
            let mut stmt = tx.prepare(
                "SELECT id, branch_id, project_id, source_doc_id, source_type, category, status, confidence,
                  is_core_pin, is_reusable, is_encrypted, reuse_count, hit_count, relevance_score, chunk_tokens,
                  superseded_by, pos_x, pos_y, pos_z, substr(content, 1, 160) AS preview, updated_at
                 FROM memories WHERE branch_id = ?1 AND
                   (status = 'active' OR (?2 AND status = 'archived') OR (?3 AND status = 'superseded'))
                 ORDER BY is_core_pin DESC, relevance_score DESC, id LIMIT ?4",
            ).map_err(sql_error)?;
            let nodes = stmt.query_map(params![
                branch.id.to_string(), query.include_archived, query.include_superseded,
                query.limit.map_or(-1, i64::from),
            ], graph_node).map_err(sql_error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_error)?;

            let ids: HashSet<_> = nodes.iter().map(|node| node.id).collect();
            let mut stmt = tx.prepare(
                "SELECT e.* FROM memory_edges e JOIN memories m ON m.id = e.source_id
                 WHERE m.branch_id = ?1 AND (e.edge_type <> 'semantic' OR e.weight >= ?2)
                 ORDER BY e.source_id, e.target_id, e.edge_type"
            ).map_err(sql_error)?;
            let mut edges = Vec::new();
            for row in stmt.query_map(params![branch.id.to_string(), min_weight], |row| Ok(MemoryEdge {
                source_id: id(row, "source_id")?,
                target_id: id(row, "target_id")?,
                edge_type: text::<EdgeType>(row, "edge_type")?,
                weight: row.get("weight")?,
            })).map_err(sql_error)? {
                let edge = row.map_err(sql_error)?;
                if ids.contains(&edge.source_id) && ids.contains(&edge.target_id) {
                    edges.push(edge);
                }
            }
            let projects = project_stats(&tx, branch.id, true)?;
            Ok(GraphData { nodes, edges, projects, branch })
        }).await
    }

    async fn update_memory(&self, req: UpdateMemoryRequest) -> Result<SaveOutcome> {
        let gate = self.engine_write().await;
        validate_content(&req.new_content, req.confidence.unwrap_or(1.0))?;
        if req.reason.trim().is_empty() {
            return Err(CobaltError::InvalidInput("version reason is empty".into()));
        }
        let retrieval = self.retrieval()?;
        let embedding = embed_memory(&retrieval, &req.new_content).await?;
        self.db
            .write(move |conn| {
                let _gate = gate;
                edit_transaction(conn, Some(&retrieval), |tx, retrieval| {
                    let retrieval = configured(retrieval)?;
                    let previous = required_memory(tx, req.memory_id)?;
                    if previous.status == MemoryStatus::Superseded || previous.is_encrypted {
                        return Err(CobaltError::Conflict(
                            "cannot version a superseded or encrypted memory".into(),
                        ));
                    }
                    let new = NewMemory {
                        content: req.new_content,
                        category: previous.category,
                        project_id: previous.project_id,
                        branch_id: Some(previous.branch_id),
                        source_doc_id: previous.source_doc_id,
                        source_type: Some(previous.source_type),
                        confidence: req.confidence.or(Some(previous.confidence)),
                        is_core_pin: previous.is_core_pin,
                        is_reusable: previous.is_reusable,
                        reusable_snippet: previous.reusable_snippet.clone(),
                        source_client: req.source_client.or(previous.source_client.clone()),
                    };
                    write_memory(
                        tx,
                        retrieval,
                        previous.branch_id,
                        new,
                        &embedding,
                        WriteMode::Version(Box::new(previous), req.reason),
                    )
                })
            })
            .await
    }

    async fn patch_memory(&self, id: Id, patch: MemoryPatch) -> Result<Memory> {
        let gate = self.engine_write().await;
        let retrieval = self.configured_retrieval()?;
        self.db.write(move |conn| {
            let _gate = gate;
            let tx = conn.transaction().map_err(sql_error)?;
            let old = required_memory(&tx, id)?;
            let branch_id = patch.branch_id.unwrap_or(old.branch_id);
            let project_id = patch.project_id.unwrap_or(old.project_id);
            let status = patch.status.unwrap_or(old.status);
            let confidence = patch.confidence.unwrap_or(old.confidence);
            validate_confidence(confidence)?;
            let snippet = patch.reusable_snippet.unwrap_or(old.reusable_snippet.clone());
            if old.is_encrypted && snippet.is_some() {
                return Err(CobaltError::InvalidInput("encrypted memories cannot store snippets".into()));
            }
            if (status == MemoryStatus::Superseded) != (old.status == MemoryStatus::Superseded) {
                return Err(CobaltError::InvalidInput("superseded status requires a version link".into()));
            }
            let scopes_changed = branch_id != old.branch_id || project_id != old.project_id;
            if status == MemoryStatus::Active && (scopes_changed || old.status != status)
                && exact_match(&tx, branch_id, project_id, &old.content_hash, Some(id))?.is_some() {
                return Err(CobaltError::Conflict("an active copy already exists in the target scope".into()));
            }
            let memory = tx.query_row(
                "UPDATE memories SET category = ?2, confidence = ?3, status = ?4, is_core_pin = ?5,
                    is_reusable = ?6, reusable_snippet = ?7, project_id = ?8, branch_id = ?9,
                    updated_at = ?10 WHERE id = ?1 RETURNING *",
                params![id.to_string(), patch.category.unwrap_or(old.category).as_str(), confidence,
                    status.as_str(), patch.is_core_pin.unwrap_or(old.is_core_pin),
                    patch.is_reusable.unwrap_or(old.is_reusable), snippet, project_id.map(|id| id.to_string()),
                    branch_id.to_string(), stamp()], memory
            ).map_err(sql_error)?;
            if scopes_changed || status != old.status {
                clear_semantic_edges(&tx, id)?;
                if let Some(retrieval) = retrieval
                    && let Some(vector) = retrieval.index.vectors(&tx, &[id])?.into_iter().next().flatten() {
                    add_semantic_edges(&tx, &retrieval, &memory, &vector, load_settings(&tx)?.search.semantic_edge_threshold)?;
                }
            }
            tx.commit().map_err(sql_error)?;
            Ok(memory)
        }).await
    }

    async fn memory_history(&self, id: Id) -> Result<Vec<Memory>> {
        self.db.read(move |conn| {
            required_memory(conn, id)?;
            let mut stmt = conn.prepare(
                "WITH RECURSIVE history(id) AS (
                    SELECT ?1
                    UNION SELECT m.superseded_by FROM memories m JOIN history h ON m.id = h.id
                        WHERE m.superseded_by IS NOT NULL
                    UNION SELECT m.id FROM memories m JOIN history h ON m.superseded_by = h.id
                 )
                 SELECT m.* FROM memories m JOIN history h ON h.id = m.id ORDER BY m.created_at, m.id"
            ).map_err(sql_error)?;
            stmt.query_map([id.to_string()], memory).map_err(sql_error)?
                .collect::<rusqlite::Result<_>>().map_err(sql_error)
        }).await
    }

    async fn delete_memory(&self, id: Id) -> Result<()> {
        let gate = self.engine_write().await;
        let retrieval = self.configured_retrieval()?;
        self.db
            .write(move |conn| {
                let _gate = gate;
                edit_transaction(conn, retrieval.as_deref(), |tx, retrieval| {
                    let old = required_memory(tx, id)?;
                    if let Some(successor) = old.superseded_by {
                        tx.execute(
                            "INSERT OR IGNORE INTO memory_edges (source_id, target_id, edge_type)
                            SELECT ?2, id, 'supersedes' FROM memories WHERE superseded_by = ?1",
                            params![id.to_string(), successor.to_string()],
                        )
                        .map_err(sql_error)?;
                        tx.execute(
                            "UPDATE memories SET superseded_by = ?2 WHERE superseded_by = ?1",
                            params![id.to_string(), successor.to_string()],
                        )
                        .map_err(sql_error)?;
                    }
                    remove_vectors(tx, retrieval.map(|r| &r.index), &[id])?;
                    tx.execute("DELETE FROM memories WHERE id = ?1", [id.to_string()])
                        .map_err(sql_error)?;
                    Ok(())
                })
            })
            .await
    }

    async fn set_encrypted_payload(
        &self,
        id: Id,
        ciphertext: Vec<u8>,
        nonce: Vec<u8>,
    ) -> Result<Memory> {
        if ciphertext.is_empty() || nonce.is_empty() {
            return Err(CobaltError::InvalidInput(
                "ciphertext and nonce cannot be empty".into(),
            ));
        }
        let gate = self.engine_write().await;
        let retrieval = self.configured_retrieval()?;
        self.db
            .write(move |conn| {
                let _gate = gate;
                edit_transaction(conn, retrieval.as_deref(), |tx, retrieval| {
                    required_memory(tx, id)?;
                    let memory = tx.query_row(
                        "UPDATE memories SET content = '', is_encrypted = 1, ciphertext = ?2, nonce = ?3,
                         reusable_snippet = NULL, pos_x = NULL, pos_y = NULL, pos_z = NULL, updated_at = ?4
                         WHERE id = ?1 RETURNING *",
                        params![id.to_string(), ciphertext, nonce, stamp()], memory,
                    ).map_err(sql_error)?;
                    clear_semantic_edges(tx, id)?;
                    remove_vectors(tx, retrieval.map(|r| &r.index), &[id])?;
                    Ok(memory)
                })
            })
            .await
    }

    async fn clear_encrypted_payload(&self, id: Id, plaintext: String) -> Result<Memory> {
        let gate = self.engine_write().await;
        validate_content(&plaintext, 1.0)?;
        let hash = content_hash(&plaintext);
        self.db
            .read(move |conn| {
                let old = required_memory(conn, id)?;
                if !old.is_encrypted || old.content_hash != hash {
                    return Err(CobaltError::Conflict(
                        "plaintext does not match an encrypted memory".into(),
                    ));
                }
                Ok(())
            })
            .await?;
        let retrieval = self.retrieval()?;
        let embedding = embed_memory(&retrieval, &plaintext).await?;
        self.db
            .write(move |conn| {
                let _gate = gate;
                edit_transaction(conn, Some(&retrieval), |tx, retrieval| {
                    let retrieval = configured(retrieval)?;
                    let [x, y, z] = project_embedding(&embedding);
                    let count = token_count(retrieval, &plaintext)?;
                    let memory = tx.query_row(
                        "UPDATE memories SET content = ?2, is_encrypted = 0, ciphertext = NULL, nonce = NULL,
                         pos_x = ?3, pos_y = ?4, pos_z = ?5, updated_at = ?6, chunk_tokens = ?7
                         WHERE id = ?1 RETURNING *",
                        params![id.to_string(), plaintext, x, y, z, stamp(), count], memory,
                    ).map_err(sql_error)?;
                    refresh_edges(tx, retrieval, &memory, &embedding, load_settings(tx)?.search.semantic_edge_threshold)?;
                    retrieval.index.insert(tx, id, &embedding)?;
                    Ok(memory)
                })
            })
            .await
    }

    async fn list_core_rules(&self, project_id: Option<Id>) -> Result<Vec<Memory>> {
        let filter = cobalt_core::search::VectorFilter {
            scope: project_id.map_or(
                cobalt_core::search::ProjectScope::Global,
                cobalt_core::search::ProjectScope::ProjectAndGlobal,
            ),
            ..Default::default()
        };
        self.db
            .read(move |conn| {
                let tx = conn.unchecked_transaction().map_err(sql_error)?;
                crate::retrieval::core_rules(&tx, branch(&tx, None)?.id, &filter)
            })
            .await
    }

    async fn list_preferences(&self, project_id: Option<Id>) -> Result<Vec<Memory>> {
        self.db.read(move |conn| {
            let tx = conn.unchecked_transaction().map_err(sql_error)?;
            let branch_id = branch(&tx, None)?.id;
            let mut stmt = tx.prepare(
                "SELECT * FROM memories WHERE branch_id = ?1 AND (project_id IS NULL OR project_id = ?2)
                 AND status = 'active' AND is_encrypted = 0 AND category = 'preference'
                 ORDER BY is_core_pin DESC, updated_at DESC, id"
            ).map_err(sql_error)?;
            stmt.query_map(params![branch_id.to_string(), project_id.map(|id| id.to_string())], memory)
                .map_err(sql_error)?.collect::<rusqlite::Result<_>>().map_err(sql_error)
        }).await
    }
}

pub(crate) fn configured(retrieval: Option<&Retrieval>) -> Result<&Retrieval> {
    retrieval
        .ok_or_else(|| CobaltError::Internal("missing retrieval during vector transaction".into()))
}

pub(crate) fn required_memory(conn: &Connection, id: Id) -> Result<Memory> {
    memory_by_id(conn, id)?.ok_or_else(|| CobaltError::NotFound(format!("memory {id}")))
}

pub(crate) fn content_hash(content: &str) -> String {
    hex::encode(Sha256::digest(content.as_bytes()))
}

fn validate_content(content: &str, confidence: f64) -> Result<()> {
    if content.trim().is_empty() {
        return Err(CobaltError::InvalidInput("memory content is empty".into()));
    }
    validate_confidence(confidence)
}

fn validate_confidence(confidence: f64) -> Result<()> {
    if !(0.0..=1.0).contains(&confidence) {
        return Err(CobaltError::InvalidInput(
            "confidence must be between 0 and 1".into(),
        ));
    }
    Ok(())
}

pub(crate) async fn embed_memory(retrieval: &Retrieval, content: &str) -> Result<Vec<f32>> {
    let vectors = retrieval
        .embedder
        .embed_documents(&[content.to_owned()])
        .await?;
    let [embedding]: [Vec<f32>; 1] = vectors
        .try_into()
        .map_err(|_| CobaltError::Embedding("expected one document embedding".into()))?;
    checked_vector(&embedding, retrieval.index.dimensions())?;
    Ok(embedding)
}

fn token_count(retrieval: &Retrieval, content: &str) -> Result<i64> {
    i64::try_from(retrieval.tokens.count(content))
        .map_err(|_| CobaltError::InvalidInput("memory token count exceeds SQLite range".into()))
}

pub(crate) fn exact_match(
    conn: &Connection,
    branch: Id,
    project: Option<Id>,
    hash: &str,
    except: Option<Id>,
) -> Result<Option<Memory>> {
    conn.query_row(
        "SELECT * FROM memories WHERE branch_id = ?1 AND project_id IS ?2 AND content_hash = ?3
         AND status = 'active' AND id IS NOT ?4 ORDER BY is_encrypted DESC, id LIMIT 1",
        params![
            branch.to_string(),
            project.map(|id| id.to_string()),
            hash,
            except.map(|id| id.to_string())
        ],
        memory,
    )
    .optional()
    .map_err(sql_error)
}

fn outcome(
    action: WriteAction,
    memory: Memory,
    previous_id: Option<Id>,
    matched_similarity: Option<f64>,
) -> SaveOutcome {
    SaveOutcome {
        action,
        memory,
        previous_id,
        matched_similarity,
        redacted_secrets: 0,
        truncated: false,
    }
}

pub(crate) fn mark_superseded(
    conn: &Connection,
    previous: Id,
    next: Id,
    reason: &str,
    weight: f64,
) -> Result<()> {
    conn.execute(
        "UPDATE memories SET status = 'superseded', superseded_by = ?2, version_reason = ?3,
                              updated_at = ?4 WHERE id = ?1",
        params![previous.to_string(), next.to_string(), reason, stamp()],
    )
    .map_err(sql_error)?;
    clear_semantic_edges(conn, previous)?;
    conn.execute(
        "INSERT INTO memory_edges (source_id, target_id, edge_type, weight)
         VALUES (?1, ?2, 'supersedes', ?3)",
        params![next.to_string(), previous.to_string(), weight],
    )
    .map_err(sql_error)?;
    Ok(())
}

pub(crate) fn clear_semantic_edges(conn: &Connection, id: Id) -> Result<()> {
    conn.execute(
        "DELETE FROM memory_edges WHERE edge_type = 'semantic' AND (source_id = ?1 OR target_id = ?1)",
        [id.to_string()],
    ).map_err(sql_error)?;
    Ok(())
}

pub(crate) fn refresh_edges(
    conn: &Connection,
    retrieval: &Retrieval,
    row: &Memory,
    embedding: &[f32],
    threshold: f64,
) -> Result<()> {
    clear_semantic_edges(conn, row.id)?;
    add_semantic_edges(conn, retrieval, row, embedding, threshold)
}

pub(crate) fn add_semantic_edges(
    conn: &Connection,
    retrieval: &Retrieval,
    row: &Memory,
    embedding: &[f32],
    threshold: f64,
) -> Result<()> {
    if row.status != MemoryStatus::Active || row.is_encrypted {
        return Ok(());
    }
    let mut scope = Scope::new(
        row.branch_id,
        &VectorFilter {
            scope: ProjectScope::All,
            ..Default::default()
        },
        &SearchFilter::default(),
    );
    scope.clause.push_str(" AND m.id <> ?");
    scope.params.push(row.id.to_string().into());
    for hit in retrieval.index.scoped(conn, embedding, 16, scope)? {
        let similarity =
            calibrated_similarity(&retrieval.embedder.spec().id, f64::from(hit.similarity));
        if similarity < threshold {
            break;
        }
        conn.execute(
            "INSERT INTO memory_edges (source_id, target_id, edge_type, weight) VALUES (?1, ?2, 'semantic', ?3)",
            params![row.id.to_string(), hit.memory_id.to_string(), similarity],
        ).map_err(sql_error)?;
    }
    Ok(())
}

pub(crate) fn remove_vectors(conn: &Connection, index: Option<&Index>, ids: &[Id]) -> Result<()> {
    if let Some(index) = index {
        index.delete(conn, ids)?;
        if matches!(index, Index::SqliteVec(_)) {
            return Ok(());
        }
    }
    let has_table = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name = 'vec_memories')",
            [],
            |row| row.get::<_, bool>(0),
        )
        .map_err(sql_error)?;
    if has_table {
        for &id in ids {
            crate::vector::SqliteVec::remove(conn, id)?;
        }
    } else if index.is_none()
        && load_settings(conn)?.vector_engine == cobalt_core::enums::EngineKind::Usearch
    {
        return Err(CobaltError::Engine(
            "configure the USearch index before removing vectors".into(),
        ));
    }
    Ok(())
}

pub(crate) fn semantic_match(
    conn: &Connection,
    retrieval: &Retrieval,
    branch_id: Id,
    project_id: Option<Id>,
    embedding: &[f32],
) -> Result<Option<(Memory, f64)>> {
    let scope = Scope::new(
        branch_id,
        &VectorFilter {
            scope: project_id.map_or(ProjectScope::Global, ProjectScope::Project),
            ..Default::default()
        },
        &SearchFilter::default(),
    );
    let best = retrieval
        .index
        .scoped(conn, embedding, 1, scope)?
        .into_iter()
        .next();
    best.map(|hit| {
        Ok((
            required_memory(conn, hit.memory_id)?,
            calibrated_similarity(&retrieval.embedder.spec().id, f64::from(hit.similarity)),
        ))
    })
    .transpose()
}

pub(crate) enum WriteMode {
    Normal,
    Version(Box<Memory>, String),
    Document,
}

pub(crate) fn write_memory(
    conn: &Connection,
    retrieval: &Retrieval,
    branch_id: Id,
    new: NewMemory,
    embedding: &[f32],
    mode: WriteMode,
) -> Result<SaveOutcome> {
    let hash = content_hash(&new.content);
    let exact = if matches!(mode, WriteMode::Document) {
        conn.query_row(
            "SELECT * FROM memories WHERE branch_id = ?1 AND source_doc_id = ?2
             AND source_client IS ?3 AND project_id IS ?4 AND content_hash = ?5
             AND status = 'active' ORDER BY id LIMIT 1",
            params![
                branch_id.to_string(),
                new.source_doc_id.map(|id| id.to_string()),
                new.source_client,
                new.project_id.map(|id| id.to_string()),
                hash
            ],
            memory,
        )
        .optional()
        .map_err(sql_error)?
    } else {
        exact_match(conn, branch_id, new.project_id, &hash, None)?
    };
    if let Some(row) = exact {
        if row.is_encrypted {
            return Err(CobaltError::Conflict(
                "content is already protected by the vault".into(),
            ));
        }
        return Ok(outcome(WriteAction::Duplicate, row, None, Some(1.0)));
    }
    let settings = load_settings(conn)?.search;
    let (previous, reason, similarity, action) = match mode {
        WriteMode::Version(previous, reason) => {
            (Some(*previous), Some(reason), None, WriteAction::Superseded)
        }
        WriteMode::Document => (None, None, None, WriteAction::Inserted),
        WriteMode::Normal => {
            match semantic_match(conn, retrieval, branch_id, new.project_id, embedding)? {
                Some((previous, score)) if score > settings.dedup_threshold => {
                    // The higher duplicate threshold denotes a near-identical meaning. A match
                    // between the thresholds is retained as a separate version for inspection.
                    if score >= settings.duplicate_threshold {
                        (
                            Some(previous),
                            None,
                            Some(score),
                            WriteAction::UpdatedExisting,
                        )
                    } else {
                        (
                            Some(previous),
                            Some("Semantic match on save".into()),
                            Some(score),
                            WriteAction::Superseded,
                        )
                    }
                }
                _ => (None, None, None, WriteAction::Inserted),
            }
        }
    };

    let source_type = match (new.source_type, new.source_doc_id) {
        (Some(source_type), _) => source_type,
        (None, Some(id)) => {
            source_by_id(conn, id)?
                .ok_or_else(|| CobaltError::NotFound(format!("source document {id}")))?
                .source_type
        }
        (None, None) => SourceType::Note,
    };
    let is_core_pin = new.is_core_pin || previous.as_ref().is_some_and(|row| row.is_core_pin);
    let confidence = new
        .confidence
        .or_else(|| previous.as_ref().map(|row| row.confidence))
        .unwrap_or(1.0);
    let count = token_count(retrieval, &new.content)?;
    let [x, y, z] = project_embedding(embedding);
    let previous_id = previous.as_ref().map(|row| row.id);
    let key = if action == WriteAction::UpdatedExisting {
        let row = previous
            .as_ref()
            .ok_or_else(|| CobaltError::Internal("missing near-duplicate".into()))?;
        conn.execute(
            "UPDATE memories SET content = ?2, content_hash = ?3, source_doc_id = coalesce(?4, source_doc_id),
                source_type = ?5, category = ?6, confidence = ?7, is_core_pin = ?8,
                is_reusable = max(is_reusable, ?9), reusable_snippet = coalesce(?10, reusable_snippet),
                chunk_tokens = ?11, pos_x = ?12, pos_y = ?13, pos_z = ?14, updated_at = ?15,
                source_client = coalesce(?16, source_client), relevance_score = 1.0 WHERE id = ?1",
            params![row.id.to_string(), new.content, hash, new.source_doc_id.map(|id| id.to_string()),
                new.source_type.or(new.source_doc_id.map(|_| source_type)).unwrap_or(row.source_type).as_str(),
                new.category.as_str(), confidence, is_core_pin, new.is_reusable, new.reusable_snippet,
                count, x, y, z, stamp(), new.source_client],
        ).map_err(sql_error)?;
        row.id
    } else {
        let id = new_id();
        conn.execute(
            "INSERT INTO memories (id, branch_id, project_id, source_doc_id, content, content_hash,
                source_type, category, confidence, is_core_pin, is_reusable, reusable_snippet,
                chunk_tokens, pos_x, pos_y, pos_z, created_at, updated_at, source_client)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?17, ?18)",
            params![id.to_string(), branch_id.to_string(), new.project_id.map(|id| id.to_string()),
                new.source_doc_id.map(|id| id.to_string()), new.content, hash, source_type.as_str(),
                new.category.as_str(), confidence, is_core_pin, new.is_reusable,
                new.reusable_snippet, count, x, y, z, stamp(), new.source_client],
        ).map_err(sql_error)?;
        if let (Some(previous), Some(reason)) = (previous_id, reason) {
            mark_superseded(conn, previous, id, &reason, similarity.unwrap_or(1.0))?;
        }
        id
    };
    let memory = required_memory(conn, key)?;
    refresh_edges(
        conn,
        retrieval,
        &memory,
        embedding,
        settings.semantic_edge_threshold,
    )?;
    retrieval.index.insert(conn, key, embedding)?;
    Ok(outcome(action, memory, previous_id, similarity))
}
