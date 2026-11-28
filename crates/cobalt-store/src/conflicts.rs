use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};

use cobalt_core::error::Result;
use cobalt_core::ids::Id;
use cobalt_core::model::{ConflictPair, Memory};
use cobalt_core::search::SearchHit;
use rusqlite::{Connection, params};

use crate::db::sql_error;
use crate::memory::{document_neighbors, memory, required_memory};
use crate::repositories::{id, optional_id};
use crate::similarity_scan::{DotProduct, UnitVector, raw_floor, rounding_margin};
use crate::vector::{Index, vector_bytes};
use crate::{Retrieval, SimilarityKind, calibrated_similarity};

const MIN_TOPIC_SIMILARITY: f64 = 0.50;
pub(crate) const NEIGHBOR_LIMIT: usize = 16;
const SCAN_ANCHOR_LIMIT: u32 = 256;

pub(crate) fn in_band(similarity: f64, duplicate_threshold: f64) -> bool {
    (MIN_TOPIC_SIMILARITY..duplicate_threshold).contains(&similarity)
}

fn tokens(content: &str) -> Vec<String> {
    let content = content.to_lowercase().replace('’', "'").replace('=', " = ");
    let mut tokens = Vec::new();
    for word in content
        .split(|c: char| !(c.is_alphanumeric() || matches!(c, '.' | '-' | '+' | '_' | '=' | '\'')))
    {
        let word = word.trim_matches(['.', '\'']);
        if let Some(stem) = word.strip_suffix("n't") {
            tokens.push(
                match stem {
                    "ca" => "can",
                    "wo" => "will",
                    stem => stem,
                }
                .to_owned(),
            );
            tokens.push("not".to_owned());
        } else if word == "cannot" {
            tokens.extend(["can".to_owned(), "not".to_owned()]);
        } else if !word.is_empty() {
            tokens.push(
                match word {
                    "uses" | "using" => "use",
                    "usamos" | "usar" | "usa" => "use",
                    "elige" | "elegir" | "elegimos" => "choose",
                    "prefiere" | "preferir" | "preferimos" => "prefer",
                    _ => word,
                }
                .to_owned(),
            );
        }
    }
    tokens
}

fn negated(word: &str) -> bool {
    matches!(word, "no" | "never" | "nunca" | "not")
}

fn numeric_value(word: &str) -> bool {
    let value = word.trim_start_matches(['v', '+', '-']);
    value.as_bytes().first().is_some_and(u8::is_ascii_digit)
        && value.split(['.', '-']).all(|component| {
            !component.is_empty() && component.bytes().all(|byte| byte.is_ascii_digit())
        })
}

fn clause_context(word: &str) -> bool {
    matches!(
        word,
        "for"
            | "in"
            | "on"
            | "when"
            | "with"
            | "if"
            | "unless"
            | "because"
            | "instead"
            | "para"
            | "en"
            | "cuando"
            | "con"
            | "si"
            | "porque"
            | "salvo"
    )
}

fn different_object(a: &[String], b: &[String], exclusive: bool) -> bool {
    let a_end = a
        .iter()
        .position(|word| clause_context(word))
        .unwrap_or(a.len());
    let b_end = b
        .iter()
        .position(|word| clause_context(word))
        .unwrap_or(b.len());
    if a_end == 0 || b_end == 0 || a[a_end..] != b[b_end..] {
        return false;
    }
    let (a, b) = (&a[..a_end], &b[..b_end]);
    if exclusive {
        return !a.windows(b.len()).any(|part| part == b)
            && !b.windows(a.len()).any(|part| part == a);
    }
    a != b
}

fn opposed_verbs(a: &str, b: &str) -> bool {
    let (a, b) = (a.min(b), a.max(b));
    matches!(
        (a, b),
        ("avoid", "use")
            | ("disable", "enable")
            | ("activar", "desactivar")
            | ("deny", "permit")
            | ("allow", "deny")
    )
}

pub(crate) fn reason(a: &str, b: &str) -> Option<&'static str> {
    reason_tokens(&tokens(a), &tokens(b))
}

fn reason_tokens(a: &[String], b: &[String]) -> Option<&'static str> {
    let a_negative = a.iter().any(|word| negated(word));
    let b_negative = b.iter().any(|word| negated(word));
    if a_negative != b_negative {
        // Compare the assertion once polarity markers and supporting auxiliaries are removed.
        let assertion = |word: &&String| {
            !negated(word)
                && !matches!(
                    word.as_str(),
                    "do" | "does" | "did" | "sí" | "always" | "siempre"
                )
        };
        return a
            .iter()
            .filter(assertion)
            .eq(b.iter().filter(assertion))
            .then_some("negation");
    }
    if a_negative || a == b {
        return None;
    }
    if a.len() == b.len()
        && a.iter()
            .zip(b)
            .all(|(a, b)| a == b || (numeric_value(a) && numeric_value(b)))
        && a.iter()
            .any(|word| !numeric_value(word) && word.chars().any(char::is_alphabetic))
    {
        return Some("different_value");
    }
    // The subject and choice/assignment verb must agree, as must any trailing condition.
    let common_prefix = a
        .iter()
        .zip(b)
        .take_while(|(left, right)| left == right)
        .count();
    if let Some((left, right)) = a.get(common_prefix).zip(b.get(common_prefix))
        && opposed_verbs(left, right)
        && a.len() > common_prefix + 1
        && a[common_prefix + 1..] == b[common_prefix + 1..]
    {
        return Some("opposite_choice");
    }
    for position in (0..common_prefix).rev() {
        let left = &a[position];
        let kind = match left.as_str() {
            "use" | "choose" | "prefer" | "select" => "opposite_choice",
            "=" | "is" | "equals" | "es" | "vale" if position > 0 => "different_value",
            "to" if a.first().is_some_and(|word| word == "set") && position > 1 => {
                "different_value"
            }
            _ => continue,
        };
        if different_object(
            &a[position + 1..],
            &b[position + 1..],
            kind == "opposite_choice",
        ) {
            return Some(kind);
        }
    }
    None
}

pub(crate) fn order_search_hits(mut hits: Vec<SearchHit>) -> Vec<SearchHit> {
    if hits.len() < 2 {
        return hits;
    }
    let tokens: Vec<_> = hits
        .iter()
        .map(|hit| (!hit.memory.is_core_pin).then(|| tokens(&hit.memory.content)))
        .collect();
    let authority = |index: usize| {
        let memory = &hits[index].memory;
        (
            memory.project_id.is_some(),
            memory.updated_at,
            Reverse(index),
        )
    };
    let mut winners = vec![None; hits.len()];
    for (i, a) in tokens.iter().enumerate() {
        for (j, b) in tokens.iter().enumerate().skip(i + 1) {
            let Some((a, b)) = a.as_deref().zip(b.as_deref()) else {
                continue;
            };
            if reason_tokens(a, b).is_none() {
                continue;
            }
            let (winner, loser) = if authority(i) > authority(j) {
                (i, j)
            } else {
                (j, i)
            };
            // A hit can name only one winner. Keep its strongest direct contradiction.
            if winners[loser].is_none_or(|current| authority(winner) > authority(current)) {
                winners[loser] = Some(winner);
            }
        }
    }
    if winners.iter().all(Option::is_none) {
        return hits;
    }
    let mut followers = vec![Vec::new(); hits.len()];
    for (loser, winner) in winners.iter().enumerate() {
        if let Some(winner) = *winner {
            hits[loser].outranked_by = Some(hits[winner].memory.id);
            followers[winner].push(loser);
        }
    }
    // Emit each group at its first relevance position, winner first and followers adjacent.
    let mut pending: Vec<_> = hits.into_iter().map(Some).collect();
    let mut ordered = Vec::with_capacity(pending.len());
    let mut stack = Vec::new();
    for mut index in 0..pending.len() {
        if pending[index].is_none() {
            continue;
        }
        while let Some(winner) = winners[index] {
            index = winner;
        }
        stack.push(index);
        while let Some(index) = stack.pop() {
            if let Some(hit) = pending[index].take() {
                ordered.push(hit);
                stack.extend(followers[index].iter().rev().copied());
            }
        }
    }
    ordered
}

// SQLite's scoped search evaluates a join and decodes the same vectors for every
// anchor. Load each vector once, then rank using the same distance and ID tie-break.
struct SqliteCandidate {
    id: Id,
    embedding: Vec<u8>,
    unit: UnitVector,
}

type NeighborLists = HashMap<Id, Vec<(Id, f64)>>;

fn sqlite_neighbors(
    conn: &Connection,
    branch_id: Id,
    retrieval: &Retrieval,
    anchors: &[Memory],
) -> Result<Option<NeighborLists>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id FROM memories
             WHERE branch_id = ?1 AND status = 'active' AND is_encrypted = 0",
        )
        .map_err(sql_error)?;
    let rows = stmt
        .query_map([branch_id.to_string()], |row| {
            Ok((id(row, "id")?, optional_id(row, "project_id")?))
        })
        .map_err(sql_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(sql_error)?;
    let ids: Vec<_> = rows.iter().map(|&(id, _)| id).collect();
    let vectors = retrieval.index.vectors(conn, &ids)?;
    let mut projects: HashMap<_, Vec<SqliteCandidate>> = HashMap::new();
    for ((id, project), vector) in rows.into_iter().zip(vectors) {
        let Some(vector) = vector else { continue };
        let squared_norm = vector.iter().map(|x| x * x).sum::<f32>();
        // Preserve the index's handling of extreme or malformed legacy vectors.
        let stable_norms = (f32::MIN_POSITIVE / f32::EPSILON)..=(f32::MAX / 2.0);
        if vector.len() != retrieval.index.dimensions() || !stable_norms.contains(&squared_norm) {
            return Ok(None);
        }
        projects.entry(project).or_default().push(SqliteCandidate {
            id,
            embedding: vector_bytes(&vector),
            unit: UnitVector::new(&vector),
        });
    }
    let mut locations = HashMap::new();
    for scope in projects.values_mut() {
        scope.sort_unstable_by_key(|row| row.unit.strongest());
        locations.extend(scope.iter().enumerate().map(|(i, row)| (row.id, i)));
    }
    let model = &retrieval.embedder.spec().id;
    let floor = raw_floor(model, MIN_TOPIC_SIMILARITY);
    let margin = rounding_margin(retrieval.index.dimensions());
    let dot_product = DotProduct::new();
    let by_distance =
        |a: &(Id, f32), b: &(Id, f32)| a.1.total_cmp(&b.1).then_with(|| a.0.cmp(&b.0));
    let mut exact_distance = conn
        .prepare("SELECT vec_distance_cosine(?1, ?2)")
        .map_err(sql_error)?;
    let mut neighbors = HashMap::new();
    let mut nearest = Vec::new();
    for anchor in anchors {
        let Some(&position) = locations.get(&anchor.id) else {
            continue;
        };
        let scope = &projects[&anchor.project_id];
        let from = &scope[position];
        nearest.clear();

        // Try vectors sharing the dominant coordinate first. Their exact distances
        // can tighten the cutoff before examining the rest of the project.
        let strongest = from.unit.strongest();
        let start = scope.partition_point(|row| row.unit.strongest() < strongest);
        let end = scope.partition_point(|row| row.unit.strongest() <= strongest);
        let groups = [&scope[start..end], &scope[..start], &scope[end..]];
        let mut cutoff = floor;
        for batch in groups.into_iter().flat_map(|group| group.chunks(64)) {
            let approx_floor = cutoff - margin;
            let radius_squared = 2.0 * (1.0 - approx_floor);
            for to in batch {
                if to.id == anchor.id
                    || from.unit.projected_distance_squared(&to.unit) > radius_squared
                    || dot_product.score(&from.unit, &to.unit) < approx_floor
                {
                    continue;
                }
                let distance = exact_distance
                    .query_row(params![to.embedding, from.embedding], |row| row.get(0))
                    .map_err(sql_error)?;
                nearest.push((to.id, distance));
            }
            if nearest.len() > NEIGHBOR_LIMIT {
                nearest.select_nth_unstable_by(NEIGHBOR_LIMIT, by_distance);
                nearest.truncate(NEIGHBOR_LIMIT);
            }
            if nearest.len() == NEIGHBOR_LIMIT
                && let Some(worst) = nearest.iter().max_by(|a, b| by_distance(a, b))
            {
                cutoff = floor.max(1.0 - f64::from(worst.1));
            }
        }
        nearest.sort_unstable_by(by_distance);
        neighbors.insert(
            anchor.id,
            nearest
                .iter()
                .map(|&(id, distance)| {
                    (
                        id,
                        calibrated_similarity(
                            model,
                            SimilarityKind::Document,
                            f64::from((1.0_f32 - distance).clamp(0.0, 1.0)),
                        ),
                    )
                })
                .collect(),
        );
    }
    Ok(Some(neighbors))
}

pub(crate) fn scan(
    conn: &Connection,
    branch_id: Id,
    retrieval: Option<&Retrieval>,
    duplicate_threshold: f64,
    limit: u32,
) -> Result<Vec<ConflictPair>> {
    // Bound vector probes even when older memories have no semantic edges.
    let mut stmt = conn
        .prepare(
            "SELECT * FROM memories
         WHERE branch_id = ?1 AND status = 'active' AND is_encrypted = 0
         ORDER BY rowid DESC LIMIT ?2",
        )
        .map_err(sql_error)?;
    let anchors = stmt
        .query_map(params![branch_id.to_string(), SCAN_ANCHOR_LIMIT], memory)
        .map_err(sql_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(sql_error)?;
    if anchors.is_empty() {
        return Ok(Vec::new());
    }
    let mut batched = match retrieval {
        Some(retrieval) if matches!(retrieval.index, Index::SqliteVec(_)) => {
            sqlite_neighbors(conn, branch_id, retrieval, &anchors)?
        }
        _ => None,
    };
    let vectors = match retrieval {
        Some(retrieval) if batched.is_none() => retrieval
            .index
            .vectors(conn, &anchors.iter().map(|row| row.id).collect::<Vec<_>>())?,
        _ => vec![None; anchors.len()],
    };
    let mut edges = conn
        .prepare(
            "SELECT other.id, e.weight FROM memory_edges e
         JOIN memories other ON other.id = e.target_id
         WHERE e.source_id = ?1 AND e.edge_type = 'semantic'
           AND other.branch_id = ?2 AND other.project_id IS ?3
           AND other.status = 'active' AND other.is_encrypted = 0
         ORDER BY e.weight DESC, other.id LIMIT ?4",
        )
        .map_err(sql_error)?;
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    let mut compared = HashMap::new();
    for (anchor, vector) in anchors.into_iter().zip(vectors) {
        let anchor_tokens = tokens(&anchor.content);
        let neighbors =
            if let Some(neighbors) = batched.as_mut().and_then(|batch| batch.remove(&anchor.id)) {
                neighbors
            } else if let Some((retrieval, vector)) = retrieval.zip(vector.as_deref()) {
                document_neighbors(
                    conn,
                    retrieval,
                    branch_id,
                    anchor.project_id,
                    vector,
                    Some(anchor.id),
                    NEIGHBOR_LIMIT,
                )?
            } else {
                edges
                    .query_map(
                        params![
                            anchor.id.to_string(),
                            branch_id.to_string(),
                            anchor.project_id.map(|id| id.to_string()),
                            NEIGHBOR_LIMIT as u32
                        ],
                        |row| Ok((crate::repositories::id(row, "id")?, row.get(1)?)),
                    )
                    .map_err(sql_error)?
                    .collect::<rusqlite::Result<_>>()
                    .map_err(sql_error)?
            };
        for (id, similarity) in neighbors {
            if !in_band(similarity, duplicate_threshold)
                || !seen.insert((anchor.id.min(id), anchor.id.max(id)))
            {
                continue;
            }
            if let std::collections::hash_map::Entry::Vacant(slot) = compared.entry(id) {
                let row = required_memory(conn, id)?;
                let tokens = tokens(&row.content);
                slot.insert((row, tokens));
            }
            let (other, other_tokens) = &compared[&id];
            let Some(reason) = reason_tokens(&anchor_tokens, other_tokens) else {
                continue;
            };
            let (a, b) = if anchor.id < id {
                (anchor.clone(), other.clone())
            } else {
                (other.clone(), anchor.clone())
            };
            found.push(ConflictPair {
                a,
                b,
                similarity,
                reason: reason.into(),
            });
        }
    }
    found.sort_by(|a, b| {
        b.similarity
            .total_cmp(&a.similarity)
            .then_with(|| a.a.id.cmp(&b.a.id))
            .then_with(|| a.b.id.cmp(&b.b.id))
    });
    found.truncate(limit as usize);
    Ok(found)
}
