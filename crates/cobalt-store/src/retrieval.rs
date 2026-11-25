use std::collections::{HashMap, HashSet};
use std::time::Instant;

use async_trait::async_trait;
use cobalt_core::config::{RrfWeights, SearchSettings};
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::ids::Id;
use cobalt_core::model::Memory;
use cobalt_core::search::{
    LibraryFilter, ReusableAsset, ReusableAssetQuery, SearchFilter, SearchHit, SearchRequest,
    SearchResponse, TokenSavings, VectorFilter, WebContext, WebContextRequest,
};
use cobalt_core::traits::{ConfigRepository, SearchService};
use rusqlite::{Connection, params, params_from_iter, types::Value};

use crate::db::sql_error;
use crate::memory::{memory, memory_by_id};
use crate::repositories::{branch, id, optional_timestamp, stamp};
use crate::vector::{Index, Scope};
use crate::{SqliteStore, pending};

pub(crate) fn core_rules(
    conn: &Connection,
    branch_id: Id,
    filter: &VectorFilter,
) -> Result<Vec<Memory>> {
    let scope = Scope::new(
        branch_id,
        &VectorFilter {
            only_reusable: false,
            include_archived: false,
            ..filter.clone()
        },
        &SearchFilter::default(),
    );
    let mut stmt = conn
        .prepare(&format!(
            "SELECT m.* FROM memories m WHERE {} AND m.is_core_pin = 1 ORDER BY m.id",
            scope.clause,
        ))
        .map_err(sql_error)?;
    stmt.query_map(params_from_iter(scope.params), memory)
        .map_err(sql_error)?
        .collect::<rusqlite::Result<_>>()
        .map_err(sql_error)
}

fn fts_query(input: &str) -> String {
    // Quote user input so that FTS operators, column selectors and wildcards remain literal.
    input
        .split(|c: char| {
            !(c.is_alphanumeric() || c == '_' || ('\u{0300}'..='\u{036f}').contains(&c))
        })
        .filter(|term| term.chars().any(|c| c.is_alphanumeric() || c == '_'))
        .map(|term| format!("\"{term}\""))
        .collect::<Vec<_>>()
        .join(" OR ")
}

fn lexical(conn: &Connection, query: &str, limit: u32, scope: Scope) -> Result<Vec<(Id, f64)>> {
    let expression = fts_query(query);
    if expression.is_empty() {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare(&format!(
            "SELECT m.id, bm25(memories_fts) AS bm25 FROM memories_fts
         JOIN memories m ON m.rowid = memories_fts.rowid
         WHERE memories_fts MATCH ? AND {} ORDER BY bm25, m.id LIMIT ?",
            scope.clause,
        ))
        .map_err(sql_error)?;
    let args = [Value::Text(expression)]
        .into_iter()
        .chain(scope.params)
        .chain([Value::Integer(i64::from(limit))]);
    stmt.query_map(params_from_iter(args), |row| {
        Ok((id(row, "id")?, row.get("bm25")?))
    })
    .map_err(sql_error)?
    .collect::<rusqlite::Result<_>>()
    .map_err(sql_error)
}

#[derive(Default)]
struct Candidate {
    vector: Option<(u32, f64)>,
    fts: Option<(u32, f64)>,
}

fn checked_weights(weights: &RrfWeights) -> Result<()> {
    if ![weights.k, weights.vector_weight, weights.fts_weight]
        .into_iter()
        .all(|v| v.is_finite() && v >= 0.0)
    {
        return Err(CobaltError::InvalidInput(
            "RRF parameters must be finite and nonnegative".into(),
        ));
    }
    Ok(())
}

fn collect_hits(
    conn: &Connection,
    req: &SearchRequest,
    settings: &SearchSettings,
    index: Option<(&Index, &[f32])>,
    branch_id: Id,
    filter: &VectorFilter,
    top_k: u32,
) -> Result<Vec<SearchHit>> {
    if top_k == 0 || req.query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let weights = req.rrf_override.as_ref().unwrap_or(&settings.rrf);
    let candidates_per_channel = top_k.saturating_mul(4).max(32);
    let scope = || Scope::new(branch_id, filter, &req.filter);
    let mut candidates: HashMap<Id, Candidate> = HashMap::new();

    if let Some((index, query)) = index {
        let vectors = index.scoped(conn, query, candidates_per_channel as usize, scope())?;
        for (rank, entry) in (1..=candidates_per_channel).zip(vectors) {
            let similarity = f64::from(entry.similarity);
            if similarity >= settings.min_similarity {
                candidates.entry(entry.memory_id).or_default().vector = Some((rank, similarity));
            }
        }
    }
    if weights.fts_weight > 0.0 {
        let lexical = lexical(conn, &req.query, candidates_per_channel, scope())?;
        for (rank, (id, score)) in (1..=candidates_per_channel).zip(lexical) {
            candidates.entry(id).or_default().fts = Some((rank, score));
        }
    }
    let mut hits = Vec::with_capacity(candidates.len());
    for (id, candidate) in candidates {
        let memory = memory_by_id(conn, id)?
            .ok_or_else(|| CobaltError::Integrity(format!("search candidate {id} disappeared")))?;
        let vector_rank = candidate.vector.map(|(rank, _)| rank);
        let fts_rank = candidate.fts.map(|(rank, _)| rank);
        let rrf_score = vector_rank.map_or(0.0, |rank| {
            weights.vector_weight / (weights.k + f64::from(rank))
        }) + fts_rank.map_or(0.0, |rank| {
            weights.fts_weight / (weights.k + f64::from(rank))
        });
        let confidence = 1.0 - settings.confidence_weight * (1.0 - memory.confidence);
        let boost = if memory.is_core_pin {
            settings.core_pin_boost
        } else {
            0.0
        };
        hits.push(SearchHit {
            memory,
            score: rrf_score * confidence + boost,
            rrf_score,
            vector_rank,
            fts_rank,
            similarity_score: candidate.vector.map_or(0.0, |(_, similarity)| similarity),
            bm25: candidate.fts.map(|(_, score)| score),
        });
    }
    hits.sort_by(|a, b| {
        b.memory
            .is_core_pin
            .cmp(&a.memory.is_core_pin)
            .then_with(|| b.score.total_cmp(&a.score))
            .then_with(|| a.memory.id.cmp(&b.memory.id))
    });
    hits.truncate(top_k as usize);
    Ok(hits)
}

fn savings<'a>(
    conn: &Connection,
    memories: impl Iterator<Item = &'a Memory>,
) -> Result<TokenSavings> {
    let mut savings = TokenSavings::default();
    let mut known_memories = HashSet::new();
    let mut known_docs = HashSet::new();
    let mut statement = conn
        .prepare("SELECT total_tokens FROM source_documents WHERE id = ?1")
        .map_err(sql_error)?;
    for memory in memories {
        if !known_memories.insert(memory.id) {
            continue;
        }
        savings.injected_tokens = savings.injected_tokens.saturating_add(memory.chunk_tokens);
        let avoided = match memory.source_doc_id {
            Some(id) if known_docs.insert(id) => statement
                .query_row([id.to_string()], |row| row.get(0))
                .map_err(sql_error)?,
            Some(_) => 0,
            None => memory.chunk_tokens,
        };
        savings.avoided_full_tokens = savings.avoided_full_tokens.saturating_add(avoided);
    }
    savings.saved_tokens = savings
        .avoided_full_tokens
        .saturating_sub(savings.injected_tokens)
        .max(0);
    Ok(savings)
}

#[async_trait]
impl SearchService for SqliteStore {
    async fn search(&self, req: SearchRequest) -> Result<SearchResponse> {
        let start = Instant::now();
        let settings = self.load_settings().await?.search;
        let top_k = req.top_k.unwrap_or(settings.top_k);
        let weights = req.rrf_override.as_ref().unwrap_or(&settings.rrf);
        checked_weights(weights)?;
        if req
            .filter
            .min_confidence
            .is_some_and(|v| !(0.0..=1.0).contains(&v))
        {
            return Err(CobaltError::InvalidInput(
                "minimum confidence must be between 0 and 1".into(),
            ));
        }
        let vector = if top_k > 0 && weights.vector_weight > 0.0 && !req.query.trim().is_empty() {
            let retrieval = self.retrieval()?;
            Some((
                retrieval.index.clone(),
                retrieval.embedder.embed_query(&req.query).await?,
            ))
        } else {
            None
        };
        let record_hits = req.record_hits;
        let mut response = self
            .db
            .read(move |conn| {
                let tx = conn.unchecked_transaction().map_err(sql_error)?;
                let branch_id = branch(&tx, req.branch_id)?.id;
                let filter = VectorFilter {
                    scope: req.scope,
                    branch_id: Some(branch_id),
                    include_archived: req.include_archived,
                    only_reusable: req.filter.only_reusable,
                };
                let core_rules = core_rules(&tx, branch_id, &filter)?;
                let hits = collect_hits(
                    &tx,
                    &req,
                    &settings,
                    vector
                        .as_ref()
                        .map(|(index, query)| (index, query.as_slice())),
                    branch_id,
                    &filter,
                    top_k,
                )?;
                let savings = savings(
                    &tx,
                    core_rules.iter().chain(hits.iter().map(|hit| &hit.memory)),
                )?;
                Ok(SearchResponse {
                    hits,
                    core_rules,
                    savings,
                    latency_ms: 0,
                })
            })
            .await?;
        if record_hits && (!response.core_rules.is_empty() || !response.hits.is_empty()) {
            response = self
                .db
                .write(move |conn| {
                    let tx = conn.transaction().map_err(sql_error)?;
                    let accessed = stamp();
                    let mut updates = HashMap::new();
                    {
                        let mut statement = tx.prepare(
                        "UPDATE memories SET hit_count = min(hit_count, 9223372036854775806) + 1,
                         last_accessed_at = ?2 WHERE id = ?1 RETURNING hit_count, last_accessed_at",
                    ).map_err(sql_error)?;
                        for memory in response
                            .core_rules
                            .iter_mut()
                            .chain(response.hits.iter_mut().map(|hit| &mut hit.memory))
                        {
                            let (count, time) = match updates.entry(memory.id) {
                                std::collections::hash_map::Entry::Occupied(entry) => *entry.get(),
                                std::collections::hash_map::Entry::Vacant(entry) => *entry.insert(
                                    statement
                                        .query_row(
                                            params![memory.id.to_string(), accessed],
                                            |row| {
                                                Ok((
                                                    row.get::<_, i64>("hit_count")?,
                                                    optional_timestamp(row, "last_accessed_at")?,
                                                ))
                                            },
                                        )
                                        .map_err(sql_error)?,
                                ),
                            };
                            memory.hit_count = count;
                            memory.last_accessed_at = time;
                        }
                    }
                    tx.commit().map_err(sql_error)?;
                    Ok(response)
                })
                .await?;
        }
        response.latency_ms = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX);
        Ok(response)
    }

    async fn search_reusable(&self, _query: ReusableAssetQuery) -> Result<Vec<ReusableAsset>> {
        pending("search_reusable")
    }

    async fn list_library(&self, _filter: LibraryFilter) -> Result<Vec<ReusableAsset>> {
        pending("list_library")
    }

    async fn build_web_context(&self, _req: WebContextRequest) -> Result<WebContext> {
        pending("build_web_context")
    }
}
