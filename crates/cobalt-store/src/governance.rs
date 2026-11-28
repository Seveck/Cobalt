use std::collections::{BTreeMap, HashMap};

use async_trait::async_trait;
use chrono::TimeDelta;
use cobalt_core::enums::{DuplicateKind, MemoryStatus};
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::ids::{Id, Timestamp, timestamp_to_sql};
use cobalt_core::model::{ConflictPair, DecayReport, DuplicateCluster, Memory};
use cobalt_core::traits::GovernanceService;
use rusqlite::{Connection, params};

use crate::db::sql_error;
use crate::memory::{
    clear_semantic_edges, exact_match, mark_superseded, memory, refresh_edges, required_memory,
};
use crate::repositories::{branch, load_settings, stamp};
use crate::similarity_scan::{UnitVector, raw_floor, rounding_margin};
use crate::{SimilarityKind, SqliteStore, calibrated_similarity};

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

fn join(parents: &mut [usize], scores: &mut [f64], a: usize, b: usize, score: f64) -> usize {
    let a = root(parents, a);
    let b = root(parents, b);
    let parent = a.min(b);
    parents[a.max(b)] = parent;
    scores[parent] = scores[a].max(scores[b]).max(score);
    parent
}

// Any qualifying pair has a bounded difference on every coordinate. Index the
// coordinates used by many anchors so those anchors can skip whole ranges.
fn projections(vectors: &[UnitVector], radius: f64) -> HashMap<usize, Vec<(f32, usize)>> {
    let mut uses = HashMap::new();
    for vector in vectors {
        *uses.entry(vector.strongest()).or_insert(0) += 1;
    }
    uses.into_iter()
        .filter(|&(_, count)| count >= (vectors.len() / 100).max(8))
        .filter_map(|(dimension, _)| {
            let mut values = vectors
                .iter()
                .enumerate()
                .map(|(i, v)| v.coordinate(dimension).map(|value| (value, i)))
                .collect::<Option<Vec<_>>>()?;
            let mut min = f32::INFINITY;
            let mut max = f32::NEG_INFINITY;
            for &(value, _) in &values {
                if !value.is_finite() {
                    return None;
                }
                min = min.min(value);
                max = max.max(value);
            }
            if f64::from(max) - f64::from(min) <= radius {
                return None;
            }
            values.sort_unstable_by(|a, b| a.0.total_cmp(&b.0));
            Some((dimension, values))
        })
        .collect()
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
    async fn find_conflicts(&self, limit: u32) -> Result<Vec<ConflictPair>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let _gate = self.engine_gate.read().await;
        let retrieval = self.configured_retrieval()?;
        self.db
            .read(move |conn| {
                let tx = conn.unchecked_transaction().map_err(sql_error)?;
                let branch = branch(&tx, None)?;
                let settings = load_settings(&tx)?.search;
                crate::conflicts::scan(
                    &tx,
                    branch.id,
                    retrieval.as_deref(),
                    settings.duplicate_threshold,
                    limit,
                )
            })
            .await
    }

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
                let rows = {
                    let mut stmt = tx
                        .prepare(
                            "SELECT * FROM memories WHERE branch_id = ?1 AND status = 'active'
                         AND is_encrypted = 0 ORDER BY created_at, id",
                        )
                        .map_err(sql_error)?;
                    stmt.query_map([branch(&tx, None)?.id.to_string()], memory)
                        .map_err(sql_error)?
                        .collect::<rusqlite::Result<Vec<_>>>()
                        .map_err(sql_error)?
                };
                let vectors = match &retrieval {
                    Some(retrieval) => retrieval
                        .index
                        .vectors(&tx, &rows.iter().map(|row| row.id).collect::<Vec<_>>())?,
                    None => vec![None; rows.len()],
                };
                let mut parents: Vec<_> = (0..rows.len()).collect();
                let mut scores = vec![0.0_f64; rows.len()];
                let mut hashes = HashMap::new();
                let mut by_project: BTreeMap<_, Vec<_>> = BTreeMap::new();
                for (i, row) in rows.iter().enumerate() {
                    if let Some(previous) = hashes.insert((row.project_id, &row.content_hash), i) {
                        join(&mut parents, &mut scores, previous, i, 1.0);
                    }
                    if let Some(vector) = &vectors[i] {
                        by_project
                            .entry(row.project_id)
                            .or_default()
                            .push((i, vector));
                    }
                }
                if let Some(retrieval) = &retrieval {
                    let model = &retrieval.embedder.spec().id;
                    let floor = raw_floor(model, settings.duplicate_threshold)
                        - rounding_margin(retrieval.index.dimensions());
                    for scope in by_project.values() {
                        let normalized: Vec<_> = scope
                            .iter()
                            .map(|(_, vector)| UnitVector::new(vector))
                            .collect();
                        let radius = (2.0 * (1.0 - floor)).sqrt();
                        let projections =
                            if settings.duplicate_threshold > 0.0 && scope.len() >= 128 {
                                projections(&normalized, radius)
                            } else {
                                HashMap::new()
                            };
                        for (offset, &(a, vector_a)) in scope.iter().enumerate() {
                            let vector = &normalized[offset];
                            let dimension = vector.strongest();
                            let window = projections
                                .get(&dimension)
                                .zip(vector.coordinate(dimension))
                                .map(|(values, coordinate)| {
                                    let coordinate = f64::from(coordinate);
                                    let start = values.partition_point(|&(value, _)| {
                                        f64::from(value) < coordinate - radius
                                    });
                                    let end = values.partition_point(|&(value, _)| {
                                        f64::from(value) <= coordinate + radius
                                    });
                                    &values[start..end]
                                });
                            let remaining = if window.is_some() {
                                0..0
                            } else {
                                offset + 1..scope.len()
                            };
                            let candidate_indices = remaining.chain(
                                window
                                    .unwrap_or_default()
                                    .iter()
                                    .map(|&(_, i)| i)
                                    .filter(|&i| i > offset),
                            );
                            let mut parent_a = root(&mut parents, a);
                            for i in candidate_indices {
                                let (b, vector_b) = scope[i];
                                // Even a perfect score cannot improve this connected component.
                                if scores[parent_a] == 1.0 && parent_a == root(&mut parents, b) {
                                    continue;
                                }
                                if settings.duplicate_threshold > 0.0
                                    && !normalized[offset].could_reach(&normalized[i], floor)
                                {
                                    continue;
                                }
                                let score = calibrated_similarity(
                                    model,
                                    SimilarityKind::Document,
                                    cosine(vector_a, vector_b),
                                );
                                if score >= settings.duplicate_threshold {
                                    parent_a = join(&mut parents, &mut scores, parent_a, b, score);
                                }
                            }
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
