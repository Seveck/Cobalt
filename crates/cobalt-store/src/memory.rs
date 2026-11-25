use std::collections::HashSet;

use async_trait::async_trait;
use cobalt_core::enums::{EdgeType, SourceType, WriteAction};
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::ids::{Id, new_id};
use cobalt_core::model::{
    GraphData, GraphNode, GraphQuery, Memory, MemoryEdge, MemoryPatch, NewMemory, SaveOutcome,
    UpdateMemoryRequest,
};
use cobalt_core::traits::MemoryRepository;
use rusqlite::{Connection, OptionalExtension, Row, params};
use sha2::{Digest, Sha256};

use crate::db::sql_error;
use crate::repositories::{
    branch, id, load_settings, optional_id, optional_timestamp, project_stats, source_by_id, stamp,
    text, timestamp,
};
use crate::{SqliteStore, pending};

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

#[async_trait]
impl MemoryRepository for SqliteStore {
    async fn save_memory(&self, new: NewMemory) -> Result<SaveOutcome> {
        let retrieval = self.retrieval()?;
        if new.content.trim().is_empty() {
            return Err(CobaltError::InvalidInput("memory content is empty".into()));
        }
        let confidence = new.confidence.unwrap_or(1.0);
        if !(0.0..=1.0).contains(&confidence) {
            return Err(CobaltError::InvalidInput(
                "confidence must be between 0 and 1".into(),
            ));
        }
        let mut embeddings = retrieval
            .embedder
            .embed_documents(std::slice::from_ref(&new.content))
            .await?;
        if embeddings.len() != 1 {
            return Err(CobaltError::Embedding(
                "expected one document embedding".into(),
            ));
        }
        let embedding = embeddings
            .pop()
            .ok_or_else(|| CobaltError::Embedding("missing document embedding".into()))?;
        let tokens = retrieval.tokens.clone();
        let index = retrieval.index.clone();
        self.db.write(move |conn| {
            let tx = conn.transaction().map_err(sql_error)?;
            let branch_id = branch(&tx, new.branch_id)?.id;
            let source_type = if let Some(id) = new.source_doc_id {
                let doc = source_by_id(&tx, id)?.ok_or_else(|| CobaltError::NotFound(format!("source document {id}")))?;
                new.source_type.unwrap_or(doc.source_type)
            } else {
                new.source_type.unwrap_or(SourceType::Note)
            };
            let key = new_id();
            let hash = format!("{:x}", Sha256::digest(new.content.as_bytes()));
            let chunk_tokens = i64::try_from(tokens.count(&new.content)).map_err(|_| CobaltError::InvalidInput("memory token count exceeds SQLite range".into()))?;
            let [x, y, z] = project_embedding(&embedding);
            let memory = tx.query_row(
                "INSERT INTO memories (id, branch_id, project_id, source_doc_id, content, content_hash,
                  source_type, category, confidence, is_core_pin, is_reusable, reusable_snippet,
                  chunk_tokens, pos_x, pos_y, pos_z, created_at, updated_at, source_client)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?17, ?18)
                 RETURNING *",
                params![key.to_string(), branch_id.to_string(), new.project_id.map(|id| id.to_string()),
                    new.source_doc_id.map(|id| id.to_string()), new.content, hash, source_type.as_str(),
                    new.category.as_str(), confidence, new.is_core_pin, new.is_reusable,
                    new.reusable_snippet, chunk_tokens, x, y, z, stamp(), new.source_client],
                memory,
            ).map_err(sql_error)?;
            index.insert(&tx, key, &embedding)?;
            tx.commit().map_err(sql_error)?;
            Ok(SaveOutcome { action: WriteAction::Inserted, memory, previous_id: None,
                matched_similarity: None, redacted_secrets: 0, truncated: false })
        }).await
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

    async fn update_memory(&self, _req: UpdateMemoryRequest) -> Result<SaveOutcome> {
        pending("update_memory")
    }

    async fn patch_memory(&self, _id: Id, _patch: MemoryPatch) -> Result<Memory> {
        pending("patch_memory")
    }

    async fn memory_history(&self, _id: Id) -> Result<Vec<Memory>> {
        pending("memory_history")
    }

    async fn delete_memory(&self, _id: Id) -> Result<()> {
        pending("delete_memory")
    }

    async fn set_encrypted_payload(
        &self,
        _id: Id,
        _ciphertext: Vec<u8>,
        _nonce: Vec<u8>,
    ) -> Result<Memory> {
        pending("set_encrypted_payload")
    }

    async fn clear_encrypted_payload(&self, _id: Id, _plaintext: String) -> Result<Memory> {
        pending("clear_encrypted_payload")
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

    async fn list_preferences(&self, _project_id: Option<Id>) -> Result<Vec<Memory>> {
        pending("list_preferences")
    }
}
