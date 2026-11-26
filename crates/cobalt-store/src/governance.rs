use std::collections::BTreeMap;

use async_trait::async_trait;
use chrono::TimeDelta;
use cobalt_core::enums::{DuplicateKind, MemoryStatus};
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::ids::{Id, Timestamp, timestamp_to_sql};
use cobalt_core::model::{DecayReport, DuplicateCluster, Memory};
use cobalt_core::traits::GovernanceService;
use rusqlite::{Connection, params};

use crate::db::sql_error;
use crate::memory::{
    clear_semantic_edges, exact_match, mark_superseded, memory, refresh_edges, required_memory,
};
use crate::repositories::{branch, load_settings, stamp};
use crate::{SqliteStore, calibrated_similarity};

pub(crate) fn branch_memories(conn: &Connection, branch_id: Id) -> Result<Vec<Memory>> {
    let mut stmt = conn
        .prepare("SELECT * FROM memories WHERE branch_id = ?1 ORDER BY created_at, id")
        .map_err(sql_error)?;
    stmt.query_map([branch_id.to_string()], memory)
        .map_err(sql_error)?
        .collect::<rusqlite::Result<_>>()
        .map_err(sql_error)
}

fn root(parents: &mut [usize], mut index: usize) -> usize {
    while parents[index] != index {
        let parent = parents[index];
        parents[index] = parents[parent];
        index = parents[index];
    }
    index
}

pub(crate) fn cosine(a: &[f32], b: &[f32]) -> f64 {
    let (dot, a_sq, b_sq) = a
        .iter()
        .zip(b)
        .fold((0.0, 0.0, 0.0), |(dot, a_sq, b_sq), (&a, &b)| {
            let (a, b) = (f64::from(a), f64::from(b));
            (dot + a * b, a_sq + a * a, b_sq + b * b)
        });
    dot / (a_sq * b_sq).sqrt()
}

#[async_trait]
impl GovernanceService for SqliteStore {
    async fn run_decay(&self, now: Timestamp) -> Result<DecayReport> {
        self.db
            .write(move |conn| {
                let tx = conn.transaction().map_err(sql_error)?;
                let settings = load_settings(&tx)?.decay;
                let mut report = DecayReport {
                    evaluated: 0,
                    decayed: 0,
                    archived: 0,
                };
                if !settings.enabled {
                    return Ok(report);
                }
                if settings.inactive_days == 0
                    || !(0.0..=1.0).contains(&settings.decay_rate)
                    || !(0.0..=1.0).contains(&settings.archive_threshold)
                {
                    return Err(CobaltError::InvalidInput("invalid decay settings".into()));
                }
                let rows = {
                    let mut stmt = tx
                        .prepare(
                            "SELECT * FROM memories WHERE status = 'active' AND is_core_pin = 0",
                        )
                        .map_err(sql_error)?;
                    stmt.query_map([], memory)
                        .map_err(sql_error)?
                        .collect::<rusqlite::Result<Vec<_>>>()
                        .map_err(sql_error)?
                };
                let period = TimeDelta::days(i64::from(settings.inactive_days)).num_seconds();
                let time = timestamp_to_sql(&now);
                for row in rows {
                    report.evaluated += 1;
                    let anchor = row.last_accessed_at.unwrap_or(row.created_at);
                    // updated_at is the checkpoint for elapsed periods already applied. An access
                    // starts a fresh inactivity window without compounding previously applied decay.
                    let periods = |until: Timestamp| (until - anchor).num_seconds().max(0) / period;
                    let elapsed = periods(now) - periods(row.updated_at);
                    if elapsed <= 0 {
                        continue;
                    }
                    let relevance = row.relevance_score * settings.decay_rate.powf(elapsed as f64);
                    let archived = relevance < settings.archive_threshold;
                    tx.execute(
                        "UPDATE memories SET relevance_score = ?2, updated_at = ?3,
                        status = CASE WHEN ?4 THEN 'archived' ELSE status END WHERE id = ?1",
                        params![row.id.to_string(), relevance, time, archived],
                    )
                    .map_err(sql_error)?;
                    report.decayed += u64::from(relevance != row.relevance_score);
                    report.archived += u64::from(archived);
                    if archived {
                        clear_semantic_edges(&tx, row.id)?;
                    }
                }
                tx.commit().map_err(sql_error)?;
                Ok(report)
            })
            .await
    }

    async fn find_duplicates(&self) -> Result<Vec<DuplicateCluster>> {
        let _gate = self.engine_gate.read().await;
        let retrieval = self.configured_retrieval()?;
        self.db
            .read(move |conn| {
                let tx = conn.unchecked_transaction().map_err(sql_error)?;
                let settings = load_settings(&tx)?.search;
                let rows: Vec<_> = branch_memories(&tx, branch(&tx, None)?.id)?
                    .into_iter()
                    .filter(|row| row.status == MemoryStatus::Active && !row.is_encrypted)
                    .collect();
                let vectors = match &retrieval {
                    Some(retrieval) => retrieval
                        .index
                        .vectors(&tx, &rows.iter().map(|row| row.id).collect::<Vec<_>>())?,
                    None => vec![None; rows.len()],
                };
                let mut by_project: BTreeMap<_, Vec<usize>> = BTreeMap::new();
                for (i, row) in rows.iter().enumerate() {
                    by_project.entry(row.project_id).or_default().push(i);
                }
                let mut parents: Vec<_> = (0..rows.len()).collect();
                let mut scores = vec![0.0_f64; rows.len()];
                for scope in by_project.values() {
                    for (offset, &a) in scope.iter().enumerate() {
                        for &b in &scope[offset + 1..] {
                            let exact = rows[a].content_hash == rows[b].content_hash;
                            let score = if exact {
                                1.0
                            } else if let (Some(a), Some(b), Some(retrieval)) =
                                (&vectors[a], &vectors[b], &retrieval)
                            {
                                calibrated_similarity(&retrieval.embedder.spec().id, cosine(a, b))
                            } else {
                                continue;
                            };
                            if !exact && score < settings.duplicate_threshold {
                                continue;
                            }
                            let parent_a = root(&mut parents, a);
                            let parent_b = root(&mut parents, b);
                            parents[parent_b] = parent_a;
                            scores[parent_a] = scores[parent_a].max(scores[parent_b]).max(score);
                        }
                    }
                }
                let mut groups: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
                for i in 0..rows.len() {
                    groups.entry(root(&mut parents, i)).or_default().push(i);
                }
                let mut result = Vec::new();
                for (root, members) in groups {
                    if members.len() < 2 {
                        continue;
                    }
                    let exact = members
                        .iter()
                        .all(|&i| rows[i].content_hash == rows[root].content_hash);
                    let max_similarity = scores[root];
                    let mut sorted: Vec<_> = members.iter().map(|&i| &rows[i]).collect();
                    sorted.sort_by(|a, b| {
                        b.confidence
                            .total_cmp(&a.confidence)
                            .then_with(|| b.updated_at.cmp(&a.updated_at))
                            .then_with(|| b.id.cmp(&a.id))
                    });
                    let Some(keep) = sorted.first() else { continue };
                    result.push(DuplicateCluster {
                        kind: if exact {
                            DuplicateKind::Duplicate
                        } else {
                            DuplicateKind::Conflict
                        },
                        memory_ids: sorted.iter().map(|row| row.id).collect(),
                        max_similarity,
                        suggested_keep_id: keep.id,
                    });
                }
                Ok(result)
            })
            .await
    }

    async fn merge_duplicates(&self, keep_id: Id, merge_ids: &[Id]) -> Result<Memory> {
        let merge_ids: std::collections::BTreeSet<_> = merge_ids
            .iter()
            .copied()
            .filter(|id| *id != keep_id)
            .collect();
        self.db.write(move |conn| {
            let tx = conn.transaction().map_err(sql_error)?;
            let keep = required_memory(&tx, keep_id)?;
            if keep.status != MemoryStatus::Active || keep.is_encrypted {
                return Err(CobaltError::Conflict("survivor must be an active plaintext memory".into()));
            }
            for id in merge_ids {
                let other = required_memory(&tx, id)?;
                if other.superseded_by == Some(keep_id) { continue; }
                if other.project_id != keep.project_id || other.branch_id != keep.branch_id
                    || other.status == MemoryStatus::Superseded || other.is_encrypted {
                    return Err(CobaltError::Conflict("duplicate must be plaintext and in the survivor's scope".into()));
                }
                tx.execute(
                    "UPDATE memories SET is_core_pin = max(is_core_pin, ?2),
                        is_reusable = max(is_reusable, ?3), reusable_snippet = coalesce(reusable_snippet, ?4),
                        reuse_count = min(reuse_count, 9223372036854775807 - ?5) + ?5,
                        hit_count = min(hit_count, 9223372036854775807 - ?6) + ?6,
                        last_accessed_at = CASE WHEN last_accessed_at IS NULL OR last_accessed_at < ?7
                                                THEN ?7 ELSE last_accessed_at END,
                        updated_at = ?8 WHERE id = ?1",
                    params![keep_id.to_string(), other.is_core_pin, other.is_reusable, other.reusable_snippet,
                        other.reuse_count, other.hit_count, other.last_accessed_at.map(|ts| timestamp_to_sql(&ts)), stamp()],
                ).map_err(sql_error)?;
                mark_superseded(&tx, id, keep_id, "Merged duplicate", 1.0)?;
            }
            let result = required_memory(&tx, keep_id)?;
            tx.commit().map_err(sql_error)?;
            Ok(result)
        }).await
    }

    async fn archive_memories(&self, ids: &[Id]) -> Result<u64> {
        self.change_archive_status(ids, false).await
    }

    async fn restore_memories(&self, ids: &[Id]) -> Result<u64> {
        self.change_archive_status(ids, true).await
    }
}

impl SqliteStore {
    async fn change_archive_status(&self, ids: &[Id], restore: bool) -> Result<u64> {
        let gate = self.engine_write().await;
        let retrieval = self.configured_retrieval()?;
        let ids = ids.to_vec();
        self.db.write(move |conn| {
            let _gate = gate;
            let tx = conn.transaction().map_err(sql_error)?;
            let mut changed = 0;
            let threshold = load_settings(&tx)?.search.semantic_edge_threshold;
            for id in ids {
                let Some(row) = crate::memory::memory_by_id(&tx, id)? else { continue };
                if restore && row.status == MemoryStatus::Archived {
                    if exact_match(&tx, row.branch_id, row.project_id, &row.content_hash, Some(id))?.is_some() {
                        return Err(CobaltError::Conflict("an active copy already exists".into()));
                    }
                    tx.execute("UPDATE memories SET status = 'active', relevance_score = 1.0,
                                updated_at = ?2 WHERE id = ?1", params![id.to_string(), stamp()]).map_err(sql_error)?;
                    if let Some(retrieval) = &retrieval
                        && !row.is_encrypted
                        && let Some(vector) = retrieval.index.vectors(&tx, &[id])?.into_iter().next().flatten() {
                        let active = required_memory(&tx, id)?;
                        refresh_edges(&tx, retrieval, &active, &vector, threshold)?;
                    }
                    changed += 1;
                } else if !restore && row.status == MemoryStatus::Active {
                    tx.execute("UPDATE memories SET status = 'archived', updated_at = ?2 WHERE id = ?1",
                               params![id.to_string(), stamp()]).map_err(sql_error)?;
                    clear_semantic_edges(&tx, id)?;
                    changed += 1;
                }
            }
            tx.commit().map_err(sql_error)?;
            Ok(changed)
        }).await
    }
}
