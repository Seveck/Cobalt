//! Memory proposals (contract v1.14.0): decisions, fixes and preferences noticed in AI sessions.
//! Cheap, local heuristics on the last turn; nothing is saved until the user accepts it.

use cobalt_core::enums::{ProposalKind, ProposalStatus};
use cobalt_core::model::NewMemoryProposal;
use cobalt_core::scrubber::scrub;

use crate::daemon::Daemon;

/// At most this many proposals per turn (keeps the inbox calm).
pub const MAX_PER_TURN: usize = 3;
const MIN_CHARS: usize = 25;
const MAX_CHARS: usize = 320;
/// Characters of the AI's message kept around the proposal as evidence.
const EVIDENCE_AROUND_CHARS: usize = 450;
/// Characters of the user's request kept as evidence.
const EVIDENCE_REQUEST_CHARS: usize = 300;

const DECISION_CUES: &[&str] = &[
    "decidimos",
    "hemos decidido",
    "he decidido",
    "decidí ",
    "vamos a usar",
    "usaremos",
    "optamos por",
    "elegimos",
    "la decisión fue",
    "la decisión es usar",
    "se decidió",
    "we decided",
    "i decided",
    "decided to use",
    "we'll use",
    "we will use",
    "going with",
    "chose to",
    "the decision was",
];
const FIX_CUES: &[&str] = &[
    "causa raíz",
    "la causa era",
    "la causa es",
    "se debía a",
    "el fallo era",
    "el error era",
    "arreglado:",
    "lo arreglé",
    "se arregló",
    "root cause",
    "was caused by",
    "the bug was",
    "fixed by",
    "the fix was",
    "the fix is",
];
const PREFERENCE_CUES: &[&str] = &[
    "siempre ",
    "nunca ",
    "prefiero",
    "no quiero que",
    "quiero que siempre",
    "a partir de ahora",
    "always ",
    "never ",
    "i prefer",
    "from now on",
    "don't ever",
];

/// Markdown emphasis/code marks removed so they never leak into a memory.
fn plain(s: &str) -> String {
    s.replace("**", "").replace("__", "").replace('`', "")
}

/// A short "Label:" prefix (e.g. "IA:", "Usuario:", "Nota:") marks meta text, not a statement.
fn has_label_prefix(s: &str) -> bool {
    s.split_once(':')
        .is_some_and(|(head, _)| head.chars().count() <= 14 && !head.contains(' '))
}

fn sentences(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(['\n', '.', '!', '?', ';'])
        .map(|s| {
            plain(
                s.trim()
                    .trim_start_matches(['-', '*', '•', '>', '#', ' '])
                    .trim(),
            )
        })
        .map(|s| s.trim().to_owned())
        .filter(|s| (MIN_CHARS..=MAX_CHARS).contains(&s.chars().count()))
        .filter(|s| {
            !s.contains("```") && !s.starts_with('|') && !s.contains('"') && !s.contains('«')
        })
        .filter(|s| !has_label_prefix(s))
}

fn has_cue(s: &str, cues: &[&str]) -> bool {
    let low = s.to_lowercase();
    cues.iter().any(|c| low.contains(c))
}

fn clip(text: &str, max: usize) -> String {
    let t: String = text.chars().take(max).collect();
    if text.chars().count() > max {
        format!("{}…", t.trim_end())
    } else {
        t
    }
}

/// The paragraph of `text` that contains `sentence`, widened to about
/// [`EVIDENCE_AROUND_CHARS`] with the text right before and after it.
fn around(text: &str, sentence: &str) -> String {
    let Some(pos) = text.find(sentence) else {
        return clip(sentence, EVIDENCE_AROUND_CHARS);
    };
    let half = EVIDENCE_AROUND_CHARS.saturating_sub(sentence.len()) / 2;
    let mut start = pos.saturating_sub(half);
    while !text.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (pos + sentence.len() + half).min(text.len());
    while !text.is_char_boundary(end) {
        end += 1;
    }
    // Prefer whole paragraphs/lines at the edges.
    if let Some(nl) = text[start..pos].find('\n') {
        start += nl + 1;
    }
    if let Some(nl) = text[pos + sentence.len()..end].rfind('\n') {
        end = pos + sentence.len() + nl;
    }
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.push_str(text[start..end].trim());
    if end < text.len() {
        out.push('…');
    }
    out
}

/// Evidence shown next to a proposal: what the user asked and where the AI said it.
fn evidence(
    user: Option<&str>,
    assistant: Option<&str>,
    sentence: &str,
    from_user: bool,
) -> String {
    let mut parts = Vec::new();
    if let Some(u) = user.map(str::trim).filter(|u| !u.is_empty()) {
        parts.push(format!("Usuario: {}", clip(u, EVIDENCE_REQUEST_CHARS)));
    }
    if !from_user && let Some(a) = assistant {
        parts.push(format!("IA: {}", around(a, sentence)));
    }
    scrub(&parts.join("\n\n")).text
}

/// Candidates in one turn: decisions and fixes from the AI's message, preferences from the
/// user's, each with its evidence (the user's request and the surrounding text). De-duplicated,
/// scrubbed, capped at [`MAX_PER_TURN`].
pub fn extract(assistant: Option<&str>, user: Option<&str>) -> Vec<(ProposalKind, String, String)> {
    let mut out: Vec<(ProposalKind, String, String)> = Vec::new();
    let mut push = |kind: ProposalKind, s: String| {
        let clean = scrub(&s).text;
        if out.len() < MAX_PER_TURN && !out.iter().any(|(_, o, _)| o.eq_ignore_ascii_case(&clean)) {
            let ev = evidence(user, assistant, &s, kind == ProposalKind::Preference);
            out.push((kind, clean, ev));
        }
    };
    if let Some(u) = user {
        for s in sentences(u).filter(|s| has_cue(s, PREFERENCE_CUES)) {
            push(ProposalKind::Preference, s);
        }
    }
    if let Some(a) = assistant {
        for s in sentences(a) {
            if has_cue(&s, FIX_CUES) {
                push(ProposalKind::Fix, s);
            } else if has_cue(&s, DECISION_CUES) {
                push(ProposalKind::Decision, s);
            }
        }
    }
    out
}

impl Daemon {
    /// Turns one finished AI turn into pending proposals (if enabled), skipping anything already
    /// known as a memory, and announces the new pending count.
    pub(crate) async fn propose_from_turn(
        &self,
        client: &str,
        project_id: Option<cobalt_core::Id>,
        assistant: Option<&str>,
        user: Option<&str>,
    ) {
        if !self.config.get().capture.proposals || self.is_read_only() {
            return;
        }
        let mut added = 0;
        for (kind, content, evidence) in extract(assistant, user) {
            if self.already_remembered(&content, project_id).await {
                continue;
            }
            let new = NewMemoryProposal {
                project_id,
                client_name: client.to_owned(),
                kind,
                evidence: Some(evidence),
                content,
            };
            if let Ok(Some(_)) = self.store().add_proposal(new).await {
                added += 1;
            }
        }
        if added > 0 {
            self.announce_proposals().await;
        }
    }

    /// `true` when a very similar memory already exists (no point proposing it again).
    async fn already_remembered(&self, content: &str, project_id: Option<cobalt_core::Id>) -> bool {
        let scope = project_id.map_or(cobalt_core::search::ProjectScope::Global, |p| {
            cobalt_core::search::ProjectScope::ProjectAndGlobal(p)
        });
        let threshold = self.config.get().search.dedup_threshold;
        let Ok(found) = self
            .store()
            .search(cobalt_core::search::SearchRequest {
                query: content.to_owned(),
                scope,
                branch_id: None,
                top_k: Some(1),
                include_archived: false,
                filter: cobalt_core::search::SearchFilter::default(),
                rrf_override: None,
                expand_graph: false,
                record_hits: false,
            })
            .await
        else {
            return false;
        };
        found
            .hits
            .first()
            .is_some_and(|h| h.vector_rank.is_some() && h.similarity_score >= threshold)
    }

    /// Emits the current number of pending proposals.
    pub async fn announce_proposals(&self) {
        if let Ok(list) = self
            .store()
            .list_proposals(Some(ProposalStatus::Pending), 500)
            .await
        {
            self.sink.proposals_changed(list.len() as u64);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_decisions_fixes_and_preferences_but_not_noise() {
        let assistant = "Revisé el código.\nLa causa raíz era que el puente no se reconectaba tras reiniciar el daemon.\nDecidimos usar PaddleOCR como motor por defecto porque lee tildes.\n```rust\nlet x = 1; // decidimos\n```\nListo.";
        let user = "Gracias. A partir de ahora háblame siempre en español, por favor.";
        let got = extract(Some(assistant), Some(user));
        let kinds: Vec<_> = got.iter().map(|(k, _, _)| *k).collect();
        let decision = got
            .iter()
            .find(|(k, _, _)| *k == ProposalKind::Decision)
            .unwrap();
        assert!(decision.2.starts_with("Usuario: Gracias"), "{}", decision.2);
        assert!(
            decision.2.contains("IA: ") && decision.2.contains("La causa raíz"),
            "{}",
            decision.2
        );
        assert!(kinds.contains(&ProposalKind::Fix));
        assert!(kinds.contains(&ProposalKind::Decision));
        assert!(kinds.contains(&ProposalKind::Preference));
        assert!(got.len() <= MAX_PER_TURN);
        assert!(got.iter().all(|(_, s, _)| !s.contains("let x")));
        assert!(extract(Some("Hecho. Todo compila."), Some("ok")).is_empty());
        // Talking ABOUT decisions or quoting is not deciding (real false positive, 2026-11-28).
        let meta = "- **IA:** el fragmento de su respuesta donde tomó la decisión, con lo que dijo justo antes y justo después.\nEl detector busca frases como \"decidimos usar…\" en la respuesta.";
        assert!(
            extract(Some(meta), None).is_empty(),
            "{:?}",
            extract(Some(meta), None)
        );
    }

    #[test]
    fn secrets_never_reach_a_proposal() {
        let got = extract(
            Some(
                "Decidimos usar la clave sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 para la API de pruebas.",
            ),
            None,
        );
        assert_eq!(got.len(), 1);
        assert!(!got[0].1.contains("sk-proj-AbCd"), "{}", got[0].1);
        assert!(!got[0].2.contains("sk-proj-AbCd"), "{}", got[0].2);
    }
}
