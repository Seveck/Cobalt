//! Token-lean search answers (contract v1.13.0): at most two chunks per file, no repeats within
//! a session, query-focused excerpts of long chunks and a token budget per answer.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use cobalt_core::Id;
use cobalt_core::mcp::CompactMemory;

/// Chunks longer than this many tokens are cut down to an excerpt around the query terms.
pub const EXCERPT_ABOVE_TOKENS: usize = 160;
/// Lines kept around the best-matching line of a long chunk.
const EXCERPT_CONTEXT_LINES: usize = 4;
/// Results from one file per answer.
pub const MAX_CHUNKS_PER_FILE: usize = 2;

const STOPWORDS: &[&str] = &[
    "the", "and", "for", "with", "that", "this", "from", "what", "how", "why", "when", "where",
    "are", "was", "los", "las", "del", "que", "con", "por", "para", "una", "uno", "como", "cuando",
    "donde", "este", "esta", "sobre", "the", "you", "your", "not",
];

fn terms(query: &str) -> Vec<String> {
    query
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .map(str::to_lowercase)
        .filter(|t| t.chars().count() >= 3 && !STOPWORDS.contains(&t.as_str()))
        .collect()
}

/// The lines of `content` around its best query match (or the start), marked with "…".
pub fn excerpt(content: &str, query: &str) -> String {
    let lines: Vec<&str> = content.lines().collect();
    if lines.len() <= EXCERPT_CONTEXT_LINES * 2 + 1 {
        return content.to_owned();
    }
    let terms = terms(query);
    let score = |l: &str| {
        let low = l.to_lowercase();
        terms.iter().filter(|t| low.contains(t.as_str())).count()
    };
    let best = (0..lines.len())
        .max_by_key(|&i| (score(lines[i]), std::cmp::Reverse(i)))
        .unwrap_or(0);
    let start = best.saturating_sub(EXCERPT_CONTEXT_LINES);
    let end = (best + EXCERPT_CONTEXT_LINES + 1).min(lines.len());
    let mut out = String::new();
    if start > 0 {
        out.push_str("…\n");
    }
    out.push_str(&lines[start..end].join("\n"));
    if end < lines.len() {
        out.push_str("\n…");
    }
    out
}

/// Applies the per-file cap, session de-duplication, excerpts and the token budget (the first
/// result is always kept). Marks what was handed over as sent for this session.
pub fn shape_results(
    results: Vec<CompactMemory>,
    query: &str,
    budget_tokens: usize,
    sent: &Mutex<HashSet<Id>>,
    count: impl Fn(&str) -> usize,
) -> Vec<CompactMemory> {
    let mut sent = sent.lock().unwrap_or_else(|p| p.into_inner());
    let mut per_file: HashMap<String, usize> = HashMap::new();
    let mut used = 0usize;
    let mut out = Vec::new();
    for mut m in results {
        if let Some(path) = &m.file_path {
            let n = per_file.entry(path.clone()).or_default();
            if *n >= MAX_CHUNKS_PER_FILE {
                continue;
            }
            *n += 1;
        }
        if sent.contains(&m.id) {
            m.content.clear();
            m.already_sent = true;
        } else if count(&m.content) > EXCERPT_ABOVE_TOKENS {
            let cut = excerpt(&m.content, query);
            if cut.len() < m.content.len() {
                m.content = cut;
                m.excerpt = true;
            }
        }
        let cost = count(&m.content);
        if !out.is_empty() && used + cost > budget_tokens {
            break;
        }
        used += cost;
        sent.insert(m.id);
        out.push(m);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem(id: u128, path: Option<&str>, content: &str) -> CompactMemory {
        CompactMemory {
            id: uuid::Uuid::from_u128(id),
            content: content.into(),
            category: cobalt_core::enums::MemoryCategory::Code,
            source_type: cobalt_core::enums::SourceType::Rs,
            confidence: 1.0,
            similarity: Some(0.6),
            project: None,
            is_core_pin: false,
            is_reusable: false,
            file_path: path.map(str::to_owned),
            file_changed: false,
            updated_at: cobalt_core::ids::now(),
            excerpt: false,
            already_sent: false,
            suspicious: false,
            related_to: None,
            outranked_by: None,
        }
    }
    fn words(t: &str) -> usize {
        t.split_whitespace().count()
    }

    #[test]
    fn caps_files_dedupes_sessions_and_respects_budget() {
        let sent = Mutex::new(HashSet::new());
        let long: String = (0..60)
            .map(|i| {
                if i == 40 {
                    "fn write_slot() -> Guard {".to_owned()
                } else {
                    format!("line {i} filler text here")
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        let first = shape_results(
            vec![
                mem(1, Some("/a.rs"), &long),
                mem(2, Some("/a.rs"), "short a2"),
                mem(3, Some("/a.rs"), "short a3"),
                mem(4, None, "decision: use Redis"),
            ],
            "write_slot guard",
            10_000,
            &sent,
            words,
        );
        assert_eq!(
            first.iter().map(|m| m.id.as_u128()).collect::<Vec<_>>(),
            [1, 2, 4]
        );
        assert!(first[0].excerpt && first[0].content.contains("write_slot"));
        assert!(first[0].content.starts_with('…'));

        // Same session: repeats come back empty and flagged.
        let again = shape_results(
            vec![mem(4, None, "decision: use Redis")],
            "redis",
            10_000,
            &sent,
            words,
        );
        assert!(again[0].already_sent && again[0].content.is_empty());

        // Budget: the first result is always kept, the rest stop at the limit.
        let fresh = Mutex::new(HashSet::new());
        let tight = shape_results(
            vec![
                mem(10, None, "one two three"),
                mem(11, None, "four five six seven"),
            ],
            "x",
            4,
            &fresh,
            words,
        );
        assert_eq!(tight.len(), 1);
    }
}
