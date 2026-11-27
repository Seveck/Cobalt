use std::collections::{HashMap, HashSet};
use std::time::Instant;

use async_trait::async_trait;
use cobalt_core::config::{RrfWeights, SearchSettings};
use cobalt_core::enums::FileAvailability;
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::ids::Id;
use cobalt_core::model::Memory;
use cobalt_core::search::{
    LibraryFilter, ProjectScope, ReusableAsset, ReusableAssetQuery, SearchFilter, SearchHit,
    SearchRequest, SearchResponse, TokenSavings, VectorFilter, WebContext, WebContextRequest,
};
use cobalt_core::traits::{ConfigRepository, SearchService, TokenCounter};
use cobalt_embeddings::TiktokenCounter;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter, types::Value};

use crate::db::sql_error;
use crate::memory::{memory, memory_by_id};
use crate::repositories::{
    branch, id, optional_timestamp, source_availability, source_by_id, stamp,
};
use crate::vector::Scope;
use crate::{Retrieval, SimilarityKind, SqliteStore, calibrated_similarity};

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

const EN_STOPWORDS: &[&str] = &[
    "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "could", "did", "do",
    "does", "for", "from", "had", "has", "have", "how", "if", "in", "is", "it", "its", "me", "my",
    "of", "on", "or", "our", "please", "should", "so", "than", "that", "the", "their", "them",
    "then", "there", "these", "they", "this", "those", "to", "us", "was", "we", "were", "what",
    "when", "where", "which", "who", "why", "will", "with", "would", "you", "your",
];
const ES_STOPWORDS: &[&str] = &[
    "al", "como", "con", "cual", "cuando", "de", "del", "donde", "el", "ella", "ellos", "en",
    "era", "es", "esa", "ese", "eso", "esta", "estas", "este", "esto", "estos", "fue", "ha", "hay",
    "la", "las", "le", "les", "lo", "los", "mas", "me", "mi", "mis", "muy", "ni", "no", "nos", "o",
    "para", "pero", "por", "que", "se", "sea", "ser", "si", "sin", "sobre", "son", "su", "sus",
    "te", "tu", "un", "una", "unas", "unos", "y", "ya", "yo",
];

fn fts_terms(input: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    input
        .split(|c: char| {
            !(c.is_alphanumeric() || c == '_' || ('\u{0300}'..='\u{036f}').contains(&c))
        })
        .filter(|term| {
            term.chars().any(char::is_alphanumeric)
                && term
                    .chars()
                    .filter(|c| c.is_alphanumeric() || *c == '_')
                    .nth(1)
                    .is_some()
        })
        .filter(|term| {
            // Match unicode61's case and diacritic folding for English and Spanish words.
            let key: String = term
                .chars()
                .flat_map(char::to_lowercase)
                .filter(|c| !matches!(c, '\u{0301}' | '\u{0303}' | '\u{0308}'))
                .map(|c| match c {
                    'á' => 'a',
                    'é' => 'e',
                    'í' => 'i',
                    'ñ' => 'n',
                    'ó' => 'o',
                    'ú' | 'ü' => 'u',
                    _ => c,
                })
                .collect();
            !EN_STOPWORDS.contains(&key.as_str())
                && !ES_STOPWORDS.contains(&key.as_str())
                && seen.insert(key)
        })
        // Quote user input so that FTS operators, column selectors and wildcards remain literal.
        .map(|term| format!("\"{term}\""))
        .collect()
}

fn lexical(
    conn: &Connection,
    query: &str,
    limit: u32,
    scope: Scope,
    vector_candidates: &HashMap<Id, Candidate>,
) -> Result<Vec<(u32, Id, f64)>> {
    let terms = fts_terms(query);
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare(&format!(
            "SELECT m.id, m.rowid, m.is_core_pin, bm25(memories_fts) AS bm25 FROM memories_fts
         JOIN memories m ON m.rowid = memories_fts.rowid
         WHERE memories_fts MATCH ? AND {} ORDER BY bm25, m.id LIMIT ?",
            scope.clause,
        ))
        .map_err(sql_error)?;
    let args = [Value::Text(terms.join(" OR "))]
        .into_iter()
        .chain(scope.params)
        .chain([Value::Integer(i64::from(limit))]);
    let mut rows = stmt.query(params_from_iter(args)).map_err(sql_error)?;
    // The OR expression already guarantees one match for every row.
    let required = terms.len().div_ceil(2);
    let mut term_match = conn
        .prepare_cached("SELECT 1 FROM memories_fts WHERE rowid = ?1 AND memories_fts MATCH ?2")
        .map_err(sql_error)?;
    let mut matches = Vec::new();
    for rank in 1..=limit {
        let Some(row) = rows.next().map_err(sql_error)? else {
            break;
        };
        let memory_id = id(row, "id").map_err(sql_error)?;
        if required > 1
            && !row.get::<_, bool>("is_core_pin").map_err(sql_error)?
            && !vector_candidates.contains_key(&memory_id)
        {
            // Use the same FTS tokenizer and indexed columns for BM25 and term coverage.
            let rowid: i64 = row.get("rowid").map_err(sql_error)?;
            let mut matched = 0;
            for term in &terms {
                if term_match.exists(params![rowid, term]).map_err(sql_error)? {
                    matched += 1;
                    if matched == required {
                        break;
                    }
                }
            }
            if matched < required {
                continue;
            }
        }
        matches.push((rank, memory_id, row.get("bm25").map_err(sql_error)?));
    }
    Ok(matches)
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
    vector: Option<(&Retrieval, &[f32])>,
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

    if let Some((retrieval, query)) = vector {
        let vectors =
            retrieval
                .index
                .scoped(conn, query, candidates_per_channel as usize, scope())?;
        for (rank, entry) in (1..=candidates_per_channel).zip(vectors) {
            let similarity = calibrated_similarity(
                &retrieval.embedder.spec().id,
                SimilarityKind::Query,
                f64::from(entry.similarity),
            );
            if similarity >= settings.min_similarity {
                candidates.entry(entry.memory_id).or_default().vector = Some((rank, similarity));
            }
        }
    }
    if weights.fts_weight > 0.0 {
        for (rank, id, score) in lexical(
            conn,
            &req.query,
            candidates_per_channel,
            scope(),
            &candidates,
        )? {
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
    let mut items = Vec::new();
    for memory in memories {
        if known_memories.insert(memory.id) {
            savings.injected_tokens = savings.injected_tokens.saturating_add(memory.chunk_tokens);
            items.push((memory.source_doc_id, memory.chunk_tokens));
        }
    }
    savings.avoided_full_tokens = crate::telemetry::avoided_tokens(conn, items)?;
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
        let pending = req
            .record_hits
            .then(|| crate::db::PendingWrite::new(&self.waiting_for_engine));
        let gate = self.engine_gate.clone().read_owned().await;
        drop(pending);
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
        let vector = match self.configured_retrieval()? {
            Some(retrieval)
                if top_k > 0 && weights.vector_weight > 0.0 && !req.query.trim().is_empty() =>
            {
                let query = retrieval.embedder.embed_query(&req.query).await?;
                Some((retrieval, query))
            }
            _ => None,
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
                        .map(|(index, query)| (index.as_ref(), query.as_slice())),
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
                    let _gate = gate;
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

    async fn search_reusable(&self, query: ReusableAssetQuery) -> Result<Vec<ReusableAsset>> {
        let scope = if query.exclude_current_project {
            query
                .current_project_id
                .map_or(ProjectScope::All, ProjectScope::AllExcept)
        } else {
            ProjectScope::All
        };
        let limit = query
            .top_k
            .unwrap_or(self.load_settings().await?.search.top_k);
        let hits = self
            .search(asset_request(
                query.query.clone(),
                scope,
                query.source_type.into_iter().collect(),
                limit,
            ))
            .await?
            .hits;
        let tokens = self.asset_tokens().await?;
        let mut assets = self
            .build_assets(
                hits.into_iter()
                    .map(|hit| (hit.memory, hit.similarity_score))
                    .collect(),
                tokens.clone(),
            )
            .await?;
        if query.record_reuse {
            // Only the counters live here; telemetry (with the real client identity) is
            // recorded by the caller (cobalt-mcp), so reuse is never double counted.
            assets = self.db.write(move |conn| {
                let tx = conn.transaction().map_err(sql_error)?;
                let mut returned = Vec::new();
                {
                    let mut stmt = tx.prepare(
                        "UPDATE memories SET reuse_count = min(reuse_count, 9223372036854775806) + 1
                         WHERE id = ?1 AND is_encrypted = 0 AND is_reusable = 1 AND status = 'active'
                         RETURNING reuse_count"
                    ).map_err(sql_error)?;
                    for mut asset in assets {
                        let Some(count) = stmt.query_row([asset.memory_id.to_string()], |row| row.get(0))
                            .optional().map_err(sql_error)? else { continue };
                        asset.reuse_count = count;
                        returned.push(asset);
                    }
                }
                tx.commit().map_err(sql_error)?;
                Ok(returned)
            }).await?;
        }
        Ok(assets)
    }

    async fn list_library(&self, filter: LibraryFilter) -> Result<Vec<ReusableAsset>> {
        let rows: Vec<(Memory, f64)> = if let Some(query) =
            filter.query.as_ref().filter(|q| !q.trim().is_empty())
        {
            self.search(asset_request(
                query.clone(),
                ProjectScope::All,
                filter.source_types.clone(),
                u32::MAX,
            ))
            .await?
            .hits
            .into_iter()
            .map(|hit| (hit.memory, hit.similarity_score))
            .collect()
        } else {
            let types = filter.source_types.clone();
            self.db.read(move |conn| {
                let tx = conn.unchecked_transaction().map_err(sql_error)?;
                let scope = Scope::new(branch(&tx, None)?.id, &VectorFilter {
                    scope: ProjectScope::All, only_reusable: true, ..Default::default()
                }, &SearchFilter { source_types: types, ..Default::default() });
                let mut stmt = tx.prepare(&format!(
                    "SELECT m.* FROM memories m WHERE {} ORDER BY m.reuse_count DESC, m.updated_at DESC, m.id", scope.clause
                )).map_err(sql_error)?;
                stmt.query_map(params_from_iter(scope.params), |row| Ok((memory(row)?, 1.0)))
                    .map_err(sql_error)?.collect::<rusqlite::Result<_>>().map_err(sql_error)
            }).await?
        };
        let rows = rows
            .into_iter()
            .filter(|(row, _)| {
                filter.project_ids.is_empty()
                    || row
                        .project_id
                        .is_some_and(|id| filter.project_ids.contains(&id))
            })
            .collect();
        let assets = self.build_assets(rows, self.asset_tokens().await?).await?;
        Ok(assets
            .into_iter()
            .filter(|asset| {
                filter.availability.is_empty() || filter.availability.contains(&asset.availability)
            })
            .skip(filter.offset.unwrap_or(0) as usize)
            .take(filter.limit.unwrap_or(u32::MAX) as usize)
            .collect())
    }

    async fn build_web_context(&self, req: WebContextRequest) -> Result<WebContext> {
        let max_tokens = req.max_tokens.unwrap_or(400);
        let tokens = self.asset_tokens().await?;
        let mut context = WebContext {
            text: String::new(),
            tokens: 0,
            memory_ids: Vec::new(),
        };
        if max_tokens == 0 {
            return Ok(context);
        }
        let response = self
            .search(SearchRequest {
                query: req.task,
                scope: req
                    .project_id
                    .map_or(ProjectScope::Global, ProjectScope::ProjectAndGlobal),
                branch_id: None,
                top_k: None,
                include_archived: false,
                filter: SearchFilter::default(),
                rrf_override: None,
                record_hits: false,
            })
            .await?;
        let mut seen = HashSet::new();
        for row in response
            .core_rules
            .into_iter()
            .chain(response.hits.into_iter().map(|hit| hit.memory))
        {
            if !seen.insert(row.id) || row.content.is_empty() {
                continue;
            }
            let separator = if context.text.is_empty() { "" } else { "\n\n" };
            let candidate = format!("{}{separator}{}", context.text, row.content);
            if tokens.count(&candidate) <= max_tokens as usize {
                context.text = candidate;
                context.memory_ids.push(row.id);
            } else {
                let shortened = tokens.truncate(&candidate, max_tokens as usize);
                let prefix = format!("{}{separator}", context.text);
                if let Some(extra) = shortened.strip_prefix(&prefix)
                    && !extra.trim().is_empty()
                {
                    context.text = shortened;
                    context.memory_ids.push(row.id);
                }
                break;
            }
        }
        context.tokens = tokens.count(&context.text) as u32;
        Ok(context)
    }
}

fn asset_request(
    query: String,
    scope: ProjectScope,
    source_types: Vec<cobalt_core::enums::SourceType>,
    limit: u32,
) -> SearchRequest {
    SearchRequest {
        query,
        scope,
        top_k: Some(limit),
        branch_id: None,
        include_archived: false,
        filter: SearchFilter {
            source_types,
            only_reusable: true,
            ..Default::default()
        },
        rrf_override: None,
        record_hits: false,
    }
}

impl SqliteStore {
    async fn asset_tokens(&self) -> Result<std::sync::Arc<dyn TokenCounter>> {
        match self.configured_retrieval()? {
            Some(retrieval) => Ok(retrieval.tokens.clone()),
            None => Ok(std::sync::Arc::new(TiktokenCounter::new(
                self.load_settings().await?.token_encoding,
            ))),
        }
    }

    async fn build_assets(
        &self,
        rows: Vec<(Memory, f64)>,
        tokens: std::sync::Arc<dyn TokenCounter>,
    ) -> Result<Vec<ReusableAsset>> {
        self.db
            .read(move |conn| {
                let tx = conn.unchecked_transaction().map_err(sql_error)?;
                let mut availability = HashMap::new();
                let mut project = tx
                    .prepare("SELECT name, color_hex FROM projects WHERE id = ?1")
                    .map_err(sql_error)?;
                rows.into_iter()
                    .map(|(row, similarity_score)| {
                        let snippet = row
                            .reusable_snippet
                            .filter(|snippet| !snippet.trim().is_empty());
                        let fallback = if snippet.is_some() {
                            FileAvailability::SnippetOnly
                        } else {
                            FileAvailability::Missing
                        };
                        let doc = row
                            .source_doc_id
                            .map(|id| source_by_id(&tx, id))
                            .transpose()?
                            .flatten();
                        let (file_path, availability) = if let Some(doc) = doc {
                            let state = match availability.entry(doc.id) {
                                std::collections::hash_map::Entry::Occupied(entry) => *entry.get(),
                                std::collections::hash_map::Entry::Vacant(entry) => {
                                    *entry.insert(source_availability(&doc, false)?)
                                }
                            };
                            (
                                Some(doc.file_path),
                                if state == FileAvailability::Missing {
                                    fallback
                                } else {
                                    state
                                },
                            )
                        } else {
                            (None, fallback)
                        };
                        let (origin_project_name, origin_project_color) = if let Some(id) =
                            row.project_id
                        {
                            project
                                .query_row([id.to_string()], |row| Ok((row.get(0)?, row.get(1)?)))
                                .optional()
                                .map_err(sql_error)?
                                .unwrap_or_default()
                        } else {
                            (None, None)
                        };
                        Ok(ReusableAsset {
                            memory_id: row.id,
                            summary: tokens.truncate(&row.content, 50),
                            source_type: row.source_type,
                            origin_project_id: row.project_id,
                            origin_project_name,
                            origin_project_color,
                            source_doc_id: row.source_doc_id,
                            file_path,
                            availability,
                            output_tokens_saved: snippet
                                .as_ref()
                                .map_or(0, |s| i64::try_from(tokens.count(s)).unwrap_or(i64::MAX)),
                            snippet,
                            reuse_count: row.reuse_count,
                            similarity_score,
                            status: row.status,
                        })
                    })
                    .collect()
            })
            .await
    }
}
