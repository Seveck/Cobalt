//! Token Firewall: guards the MCP write/read paths against anomalous traffic.
//!
//! Writes (checked in order):
//! 1. rate limit (`max_writes_per_minute` accepted writes per client);
//! 2. raw log / stack-trace dumps;
//! 3. identical content repeated by the same client inside `repeated_write_window_secs`;
//! 4. size: more than 2× `max_tokens_per_memory` is blocked, more than 1× is trimmed.
//!
//! Reads: `max_reads_per_minute` per client.
//! Callers record `blocked_firewall` telemetry and show a discreet OS notification.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, RwLock};
use std::time::{Duration, Instant};

use regex::Regex;
use sha2::{Digest, Sha256};

use crate::config::FirewallSettings;
use crate::traits::TokenCounter;

const WINDOW: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockReason {
    WriteRateExceeded,
    ReadRateExceeded,
    LogDump,
    RepeatedWrite,
    Oversized,
}

impl BlockReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::WriteRateExceeded => "write_rate_exceeded",
            Self::ReadRateExceeded => "read_rate_exceeded",
            Self::LogDump => "log_dump",
            Self::RepeatedWrite => "repeated_write",
            Self::Oversized => "oversized",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FirewallVerdict {
    Allow,
    /// Content was trimmed on a token boundary.
    Truncated {
        content: String,
        original_tokens: usize,
        kept_tokens: usize,
    },
    Blocked {
        reason: BlockReason,
        detail: String,
    },
}

impl FirewallVerdict {
    pub fn is_blocked(&self) -> bool {
        matches!(self, Self::Blocked { .. })
    }
}

#[derive(Default)]
struct ClientWindow {
    writes: VecDeque<Instant>,
    reads: VecDeque<Instant>,
    recent_hashes: VecDeque<(Instant, [u8; 32])>,
}

pub struct TokenFirewall {
    settings: RwLock<FirewallSettings>,
    counter: Arc<dyn TokenCounter>,
    clients: Mutex<HashMap<String, ClientWindow>>,
}

impl TokenFirewall {
    pub fn new(settings: FirewallSettings, counter: Arc<dyn TokenCounter>) -> Self {
        Self {
            settings: RwLock::new(settings),
            counter,
            clients: Mutex::new(HashMap::new()),
        }
    }

    pub fn update_settings(&self, settings: FirewallSettings) {
        *self.settings.write().unwrap_or_else(|p| p.into_inner()) = settings;
    }

    fn settings(&self) -> FirewallSettings {
        self.settings
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    fn clients(&self) -> MutexGuard<'_, HashMap<String, ClientWindow>> {
        self.clients.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn check_write(&self, client: &str, content: &str) -> FirewallVerdict {
        self.check_write_at(client, content, Instant::now())
    }

    pub fn check_write_at(&self, client: &str, content: &str, now: Instant) -> FirewallVerdict {
        let s = self.settings();
        let mut clients = self.clients();
        let window = clients.entry(client.to_owned()).or_default();
        prune(&mut window.writes, now, WINDOW);
        let repeat_window = Duration::from_secs(u64::from(s.repeated_write_window_secs));
        while window
            .recent_hashes
            .front()
            .is_some_and(|(t, _)| now.saturating_duration_since(*t) > repeat_window)
        {
            window.recent_hashes.pop_front();
        }

        if window.writes.len() >= s.max_writes_per_minute as usize {
            return FirewallVerdict::Blocked {
                reason: BlockReason::WriteRateExceeded,
                detail: format!(
                    "more than {} writes in the last minute",
                    s.max_writes_per_minute
                ),
            };
        }
        if looks_like_log_dump(content) {
            return FirewallVerdict::Blocked {
                reason: BlockReason::LogDump,
                detail: "raw logs / stack traces are not memories; save an atomic summary".into(),
            };
        }
        let hash = normalized_hash(content);
        if window.recent_hashes.iter().any(|(_, h)| *h == hash) {
            return FirewallVerdict::Blocked {
                reason: BlockReason::RepeatedWrite,
                detail: "identical write repeated in a short window (possible loop)".into(),
            };
        }
        let max = s.max_tokens_per_memory as usize;
        let tokens = self.counter.count(content);
        let verdict = if tokens > max.saturating_mul(2) {
            return FirewallVerdict::Blocked {
                reason: BlockReason::Oversized,
                detail: format!("{tokens} tokens exceeds the hard limit of {}", max * 2),
            };
        } else if tokens > max {
            let trimmed = self.counter.truncate(content, max);
            let kept = self.counter.count(&trimmed);
            FirewallVerdict::Truncated {
                content: trimmed,
                original_tokens: tokens,
                kept_tokens: kept,
            }
        } else {
            FirewallVerdict::Allow
        };
        window.writes.push_back(now);
        window.recent_hashes.push_back((now, hash));
        verdict
    }

    pub fn check_read(&self, client: &str) -> FirewallVerdict {
        self.check_read_at(client, Instant::now())
    }

    pub fn check_read_at(&self, client: &str, now: Instant) -> FirewallVerdict {
        let s = self.settings();
        let mut clients = self.clients();
        let window = clients.entry(client.to_owned()).or_default();
        prune(&mut window.reads, now, WINDOW);
        if window.reads.len() >= s.max_reads_per_minute as usize {
            return FirewallVerdict::Blocked {
                reason: BlockReason::ReadRateExceeded,
                detail: format!(
                    "more than {} reads in the last minute",
                    s.max_reads_per_minute
                ),
            };
        }
        window.reads.push_back(now);
        FirewallVerdict::Allow
    }
}

fn prune(q: &mut VecDeque<Instant>, now: Instant, window: Duration) {
    while q
        .front()
        .is_some_and(|t| now.saturating_duration_since(*t) >= window)
    {
        q.pop_front();
    }
}

/// SHA-256 of the content with whitespace collapsed and lowercased.
fn normalized_hash(content: &str) -> [u8; 32] {
    let normalized: String = content
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    let digest = Sha256::digest(normalized.as_bytes());
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

fn log_line_regex() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(concat!(
            r"^\s*(?:",
            r"\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}", // ISO timestamps
            r"|\[?\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\]?\s", // hh:mm:ss
            r"|\[?(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\]?[\s:]", // level prefix
            r"|at\s+[\w$.<>]+\s*\(",                // JS/Java frames
            r#"|File\s+".+",\s+line\s+\d+"#,        // Python frames
            r"|\d+:\s+0x[0-9a-f]+\s",               // Rust backtrace
            r"|Traceback \(most recent call last\)",
            r"|thread '.+' panicked at",
            r")",
        ))
        .ok()
    })
    .as_ref()
}

/// Heuristic: ≥ 8 non-empty lines and ≥ 60 % of them look like log / stack-trace lines.
pub fn looks_like_log_dump(content: &str) -> bool {
    let Some(re) = log_line_regex() else {
        return false;
    };
    let lines: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.len() < 8 {
        return false;
    }
    let matching = lines.iter().filter(|l| re.is_match(l)).count();
    matching * 10 >= lines.len() * 6
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::enums::TokenEncoding;

    /// Whitespace "tokenizer" for tests.
    struct WordCounter;
    impl TokenCounter for WordCounter {
        fn encoding(&self) -> TokenEncoding {
            TokenEncoding::Cl100kBase
        }
        fn count(&self, text: &str) -> usize {
            text.split_whitespace().count()
        }
        fn truncate(&self, text: &str, max_tokens: usize) -> String {
            text.split_whitespace()
                .take(max_tokens)
                .collect::<Vec<_>>()
                .join(" ")
        }
    }

    fn firewall(max_tokens: u32, writes: u32, reads: u32) -> TokenFirewall {
        TokenFirewall::new(
            FirewallSettings {
                max_tokens_per_memory: max_tokens,
                max_writes_per_minute: writes,
                max_reads_per_minute: reads,
                repeated_write_window_secs: 60,
                notify_on_block: true,
            },
            Arc::new(WordCounter),
        )
    }

    #[test]
    fn allows_trims_and_blocks_by_size() {
        let fw = firewall(10, 100, 100);
        assert_eq!(
            fw.check_write("cursor", "short atomic decision"),
            FirewallVerdict::Allow
        );
        let fifteen = (0..15)
            .map(|i| format!("w{i}"))
            .collect::<Vec<_>>()
            .join(" ");
        match fw.check_write("cursor", &fifteen) {
            FirewallVerdict::Truncated {
                original_tokens,
                kept_tokens,
                content,
            } => {
                assert_eq!((original_tokens, kept_tokens), (15, 10));
                assert!(content.ends_with("w9"));
            }
            other => panic!("expected truncation, got {other:?}"),
        }
        let thirty = (0..30)
            .map(|i| format!("x{i}"))
            .collect::<Vec<_>>()
            .join(" ");
        assert!(matches!(
            fw.check_write("cursor", &thirty),
            FirewallVerdict::Blocked {
                reason: BlockReason::Oversized,
                ..
            }
        ));
    }

    #[test]
    fn blocks_repeated_writes_per_client_within_window() {
        let fw = firewall(800, 100, 100);
        let t0 = Instant::now();
        assert_eq!(
            fw.check_write_at("claude-code", "Use pnpm", t0),
            FirewallVerdict::Allow
        );
        assert!(matches!(
            fw.check_write_at("claude-code", "  use   PNPM ", t0 + Duration::from_secs(5)),
            FirewallVerdict::Blocked {
                reason: BlockReason::RepeatedWrite,
                ..
            }
        ));
        // Another client may write the same fact.
        assert_eq!(
            fw.check_write_at("cursor", "Use pnpm", t0),
            FirewallVerdict::Allow
        );
        // After the window it is accepted again.
        assert_eq!(
            fw.check_write_at("claude-code", "Use pnpm", t0 + Duration::from_secs(61)),
            FirewallVerdict::Allow
        );
    }

    #[test]
    fn rate_limits_writes_and_reads() {
        let fw = firewall(800, 3, 2);
        let t0 = Instant::now();
        for i in 0..3 {
            assert_eq!(
                fw.check_write_at("loop-bot", &format!("fact {i}"), t0),
                FirewallVerdict::Allow
            );
        }
        assert!(matches!(
            fw.check_write_at("loop-bot", "fact 4", t0),
            FirewallVerdict::Blocked {
                reason: BlockReason::WriteRateExceeded,
                ..
            }
        ));
        assert_eq!(
            fw.check_write_at("loop-bot", "fact 5", t0 + Duration::from_secs(60)),
            FirewallVerdict::Allow
        );

        assert_eq!(fw.check_read_at("gemini", t0), FirewallVerdict::Allow);
        assert_eq!(fw.check_read_at("gemini", t0), FirewallVerdict::Allow);
        assert!(fw.check_read_at("gemini", t0).is_blocked());
        assert_eq!(
            fw.check_read_at("gemini", t0 + Duration::from_secs(61)),
            FirewallVerdict::Allow
        );
    }

    #[test]
    fn detects_log_dumps_but_not_normal_notes() {
        let log = (0..10)
            .map(|i| format!("2026-11-25T14:0{}:00Z ERROR worker failed id={i}", i % 10))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(looks_like_log_dump(&log));
        let trace = "Traceback (most recent call last)\n".to_string()
            + &(0..9)
                .map(|i| format!("  File \"app.py\", line {i}, in run"))
                .collect::<Vec<_>>()
                .join("\n");
        assert!(looks_like_log_dump(&trace));
        let fw = firewall(10_000, 100, 100);
        assert!(matches!(
            fw.check_write("ci", &log),
            FirewallVerdict::Blocked {
                reason: BlockReason::LogDump,
                ..
            }
        ));
        let note = "Contexto: el login fallaba.\nDecisión: refresh tokens rotativos.\nRazón: evitar sesiones zombi.";
        assert!(!looks_like_log_dump(note));
    }
}
