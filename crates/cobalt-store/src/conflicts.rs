use std::cmp::Reverse;
use std::collections::HashSet;

use cobalt_core::error::Result;
use cobalt_core::ids::Id;
use cobalt_core::model::ConflictPair;
use cobalt_core::search::SearchHit;
use rusqlite::{Connection, params};

use crate::Retrieval;
use crate::db::sql_error;
use crate::memory::{document_neighbors, memory, required_memory};

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
    let vectors = match retrieval {
        Some(retrieval) => retrieval
            .index
            .vectors(conn, &anchors.iter().map(|row| row.id).collect::<Vec<_>>())?,
        None => vec![None; anchors.len()],
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
    for (anchor, vector) in anchors.into_iter().zip(vectors) {
        let neighbors = if let Some((retrieval, vector)) = retrieval.zip(vector.as_deref()) {
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
            let other = required_memory(conn, id)?;
            let Some(reason) = reason(&anchor.content, &other.content) else {
                continue;
            };
            let (a, b) = if anchor.id < id {
                (anchor.clone(), other)
            } else {
                (other, anchor.clone())
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
