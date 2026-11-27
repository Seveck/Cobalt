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

const DECISION_CUES: &[&str] = &[
    "decidimos",
    "hemos decidido",
    "he decidido",
    "decidí",
    "vamos a usar",
    "usaremos",
    "optamos por",
    "elegimos",
    "la decisión",
    "se decidió",
    "we decided",
    "decided to",
    "we'll use",
    "we will use",
    "going with",
    "chose to",
    "the decision is",
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

fn sentences(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(['\n', '.', '!', '?', ';'])
        .map(|s| {
            s.trim()
                .trim_start_matches(['-', '*', '•', '>', '#', ' '])
                .trim()
                .to_owned()
        })
        .filter(|s| (MIN_CHARS..=MAX_CHARS).contains(&s.chars().count()))
        .filter(|s| !s.contains("```") && !s.starts_with('|'))
}

fn has_cue(s: &str, cues: &[&str]) -> bool {
    let low = s.to_lowercase();
    cues.iter().any(|c| low.contains(c))
}

/// Candidates in one turn: decisions and fixes from the AI's message, preferences from the
/// user's. De-duplicated, scrubbed, capped at [`MAX_PER_TURN`].
pub fn extract(assistant: Option<&str>, user: Option<&str>) -> Vec<(ProposalKind, String)> {
    let mut out: Vec<(ProposalKind, String)> = Vec::new();
    let mut push = |kind: ProposalKind, s: String| {
        let clean = scrub(&s).text;
        if out.len() < MAX_PER_TURN && !out.iter().any(|(_, o)| o.eq_ignore_ascii_case(&clean)) {
            out.push((kind, clean));
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
        for (kind, content) in extract(assistant, user) {
            if self.already_remembered(&content, project_id).await {
                continue;
            }
            let new = NewMemoryProposal {
                project_id,
                client_name: client.to_owned(),
                kind,
                evidence: Some(content.chars().take(MAX_CHARS).collect()),
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
        let kinds: Vec<_> = got.iter().map(|(k, _)| *k).collect();
        assert!(kinds.contains(&ProposalKind::Fix));
        assert!(kinds.contains(&ProposalKind::Decision));
        assert!(kinds.contains(&ProposalKind::Preference));
        assert!(got.len() <= MAX_PER_TURN);
        assert!(got.iter().all(|(_, s)| !s.contains("let x")));
        assert!(extract(Some("Hecho. Todo compila."), Some("ok")).is_empty());
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
    }
}
