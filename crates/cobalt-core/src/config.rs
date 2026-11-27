//! Typed application settings persisted in the `app_config` key-value table.
//!
//! Storage rule: each top-level field of [`AppSettings`] is one `app_config` row whose `key`
//! is the field name and whose `value_json` is the serialized field. Missing keys fall back
//! to defaults, so adding settings never requires a migration.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::enums::{EngineKind, HardwareTier, Language, TokenEncoding};
use crate::error::Result;

/// Reciprocal Rank Fusion parameters: `score = Σ weight / (k + rank)`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RrfWeights {
    pub k: f64,
    pub vector_weight: f64,
    pub fts_weight: f64,
}

impl Default for RrfWeights {
    fn default() -> Self {
        Self {
            k: 60.0,
            vector_weight: 1.0,
            fts_weight: 1.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SearchSettings {
    pub top_k: u32,
    /// Minimum cosine similarity for vector candidates.
    pub min_similarity: f64,
    /// Check-Before-Write threshold (same project + branch).
    pub dedup_threshold: f64,
    /// "Clean Brain" duplicate detector threshold.
    pub duplicate_threshold: f64,
    /// Backup import: semantic collisions above this go to an `import-<date>` branch.
    pub import_collision_threshold: f64,
    /// Minimum similarity to persist a `semantic` edge.
    pub semantic_edge_threshold: f64,
    pub rrf: RrfWeights,
    /// How much `confidence` modulates the fused score (0 = ignore).
    pub confidence_weight: f64,
    /// Additive boost for Nuclear Laws.
    pub core_pin_boost: f64,
    /// Max tokens of memory content one `search_memory` answer may carry (v1.13.0); AIs can ask
    /// for less or more with `max_tokens`.
    pub response_token_budget: u32,
}

impl Default for SearchSettings {
    fn default() -> Self {
        Self {
            top_k: 8,
            min_similarity: 0.30,
            dedup_threshold: 0.85,
            duplicate_threshold: 0.90,
            import_collision_threshold: 0.92,
            semantic_edge_threshold: 0.75,
            rrf: RrfWeights::default(),
            confidence_weight: 0.15,
            core_pin_boost: 0.5,
            response_token_budget: 1200,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ChunkingSettings {
    pub max_chunk_tokens: u32,
    pub overlap_tokens: u32,
}

impl Default for ChunkingSettings {
    fn default() -> Self {
        Self {
            max_chunk_tokens: 400,
            overlap_tokens: 40,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct DecaySettings {
    pub enabled: bool,
    /// Days without access before `relevance_score` starts decaying.
    pub inactive_days: u32,
    /// Multiplicative decay applied per elapsed `inactive_days` period.
    pub decay_rate: f64,
    /// Below this `relevance_score` a memory becomes `archived` (never Nuclear Laws).
    pub archive_threshold: f64,
}

impl Default for DecaySettings {
    fn default() -> Self {
        Self {
            enabled: true,
            inactive_days: 60,
            decay_rate: 0.5,
            archive_threshold: 0.2,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RetentionSettings {
    /// Keep `content_snapshot` / `query_text` for the latest N logs...
    pub detailed_log_limit: u32,
    /// ...and only if younger than N days. Aggregate metrics are never purged.
    pub detailed_log_days: u32,
}

impl Default for RetentionSettings {
    fn default() -> Self {
        Self {
            detailed_log_limit: 5_000,
            detailed_log_days: 90,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct FirewallSettings {
    pub max_tokens_per_memory: u32,
    pub max_writes_per_minute: u32,
    pub max_reads_per_minute: u32,
    /// Identical writes from the same client inside this window are treated as a loop.
    pub repeated_write_window_secs: u32,
    pub notify_on_block: bool,
}

impl Default for FirewallSettings {
    fn default() -> Self {
        Self {
            max_tokens_per_memory: 800,
            max_writes_per_minute: 30,
            max_reads_per_minute: 120,
            repeated_write_window_secs: 60,
            notify_on_block: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct VaultSettings {
    pub auto_lock_minutes: u32,
}

impl Default for VaultSettings {
    fn default() -> Self {
        Self {
            auto_lock_minutes: 10,
        }
    }
}

/// Global shortcuts in Tauri accelerator syntax.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ShortcutSettings {
    pub quick_note: String,
    pub toggle_read_only: String,
}

impl Default for ShortcutSettings {
    fn default() -> Self {
        Self {
            quick_note: "Alt+Space".into(),
            toggle_read_only: "CommandOrControl+Shift+M".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct McpSettings {
    /// Streamable HTTP / SSE MCP endpoint on `127.0.0.1`.
    pub http_enabled: bool,
    pub http_port: u16,
    /// Local REST + WebSocket API with OpenAPI docs (same port, `/api/v1`).
    pub rest_enabled: bool,
    pub handoff_ttl_hours: u32,
    /// Pro mode: per-tool docstring overrides keyed by tool name.
    pub tool_docstring_overrides: BTreeMap<String, String>,
}

impl Default for McpSettings {
    fn default() -> Self {
        Self {
            http_enabled: true,
            http_port: crate::paths::DEFAULT_HTTP_PORT,
            rest_enabled: true,
            handoff_ttl_hours: 48,
            tool_docstring_overrides: BTreeMap::new(),
        }
    }
}

/// Automatic capture: keep Cobalt current even when an AI never calls it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CaptureSettings {
    /// Projects are indexed and watched as soon as they are detected (respecting `.memoryignore`).
    pub auto_watch_projects: bool,
    /// Session hooks leave an automatic handoff when a CLI session ends.
    pub session_handoffs: bool,
    /// Git `post-commit` hooks record each commit as a project memory.
    pub git_commits: bool,
    /// Global pause: file watcher, auto-watch and hook re-indexing stop until resumed.
    pub indexing_paused: bool,
    /// OCR model used for images and scanned PDFs once installed (`ocrs-latin` or
    /// `paddleocr-latin`, contract v1.8.0).
    pub ocr_model_id: String,
    /// At session start, Claude Code / Gemini CLI receive the project's rules and the latest
    /// handoff automatically through their SessionStart hook (v1.13.0).
    pub session_context: bool,
}

impl Default for CaptureSettings {
    fn default() -> Self {
        Self {
            auto_watch_projects: true,
            session_handoffs: true,
            git_commits: true,
            indexing_paused: false,
            ocr_model_id: crate::catalog::DEFAULT_OCR_MODEL.to_owned(),
            session_context: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct OllamaSettings {
    pub base_url: String,
}

impl Default for OllamaSettings {
    fn default() -> Self {
        Self {
            base_url: "http://127.0.0.1:11434".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    pub onboarding_completed: bool,
    /// Name used to greet the user (asked in onboarding, prefilled from the OS account).
    pub user_display_name: Option<String>,
    pub hardware_tier: HardwareTier,
    pub vector_engine: EngineKind,
    pub embedding_model_id: String,
    pub token_encoding: TokenEncoding,
    pub language: Language,
    pub active_theme_id: String,
    pub read_only: bool,
    pub pro_mode: bool,
    pub search: SearchSettings,
    pub chunking: ChunkingSettings,
    pub decay: DecaySettings,
    pub retention: RetentionSettings,
    pub firewall: FirewallSettings,
    pub vault: VaultSettings,
    pub shortcuts: ShortcutSettings,
    pub mcp: McpSettings,
    pub ollama: OllamaSettings,
    pub capture: CaptureSettings,
}

/// Id of the only theme bundled with the base app.
pub const BUILTIN_THEME_ID: &str = "cobalt-minimal";

/// Themes bundled with Cobalt (THEME_SPEC v1.2): always installed, never uninstallable, ids
/// reserved. The first one is the default.
pub const BUILTIN_THEME_IDS: [&str; 5] =
    [BUILTIN_THEME_ID, "grafito", "porcelana", "abisal", "niebla"];

/// Default embedding model (Eco profile, multilingual ES/EN).
pub const DEFAULT_EMBEDDING_MODEL_ID: &str = crate::engine::MODEL_MULTILINGUAL_E5_SMALL;

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            onboarding_completed: false,
            user_display_name: None,
            hardware_tier: HardwareTier::Eco,
            vector_engine: EngineKind::SqliteVec,
            embedding_model_id: DEFAULT_EMBEDDING_MODEL_ID.into(),
            token_encoding: TokenEncoding::Cl100kBase,
            language: Language::Es,
            active_theme_id: BUILTIN_THEME_ID.into(),
            read_only: false,
            pro_mode: false,
            search: SearchSettings::default(),
            chunking: ChunkingSettings::default(),
            decay: DecaySettings::default(),
            retention: RetentionSettings::default(),
            firewall: FirewallSettings::default(),
            vault: VaultSettings::default(),
            shortcuts: ShortcutSettings::default(),
            mcp: McpSettings::default(),
            ollama: OllamaSettings::default(),
            capture: CaptureSettings::default(),
        }
    }
}

impl AppSettings {
    /// Splits the settings into `app_config` rows (`key`, `value_json`).
    pub fn to_entries(&self) -> Result<Vec<(String, serde_json::Value)>> {
        let value = serde_json::to_value(self)?;
        let entries = match value {
            serde_json::Value::Object(map) => map.into_iter().collect(),
            _ => Vec::new(),
        };
        Ok(entries)
    }

    /// Rebuilds settings from `app_config` rows; unknown keys are ignored and missing keys
    /// (or keys whose JSON no longer matches the schema) fall back to defaults.
    pub fn from_entries<I>(entries: I) -> Self
    where
        I: IntoIterator<Item = (String, serde_json::Value)>,
    {
        let mut base = match serde_json::to_value(Self::default()) {
            Ok(serde_json::Value::Object(map)) => map,
            _ => return Self::default(),
        };
        for (key, value) in entries {
            if base.contains_key(&key) {
                base.insert(key, value);
            }
        }
        let merged = serde_json::Value::Object(base);
        match serde_json::from_value::<Self>(merged.clone()) {
            Ok(settings) => settings,
            Err(_) => Self::from_entries_lenient(merged),
        }
    }

    /// Field-by-field fallback: keeps every key that still deserializes on its own.
    fn from_entries_lenient(merged: serde_json::Value) -> Self {
        let defaults = Self::default();
        let Ok(serde_json::Value::Object(mut good)) = serde_json::to_value(&defaults) else {
            return defaults;
        };
        if let serde_json::Value::Object(candidate) = merged {
            for (key, value) in candidate {
                let mut probe = good.clone();
                probe.insert(key.clone(), value.clone());
                if serde_json::from_value::<Self>(serde_json::Value::Object(probe)).is_ok() {
                    good.insert(key, value);
                }
            }
        }
        serde_json::from_value(serde_json::Value::Object(good)).unwrap_or(defaults)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_roundtrip() {
        let s = AppSettings {
            language: Language::En,
            search: SearchSettings {
                top_k: 12,
                ..SearchSettings::default()
            },
            ..AppSettings::default()
        };
        let entries = s.to_entries().unwrap();
        assert!(entries.iter().any(|(k, _)| k == "search"));
        assert_eq!(AppSettings::from_entries(entries), s);
    }

    #[test]
    fn missing_unknown_and_corrupt_keys_fall_back_to_defaults() {
        let entries = vec![
            ("language".to_string(), serde_json::json!("en")),
            ("unknown_key".to_string(), serde_json::json!(42)),
            ("hardware_tier".to_string(), serde_json::json!("not-a-tier")),
            ("search".to_string(), serde_json::json!({ "top_k": 3 })),
        ];
        let s = AppSettings::from_entries(entries);
        assert_eq!(s.language, Language::En);
        assert_eq!(s.hardware_tier, HardwareTier::Eco);
        assert_eq!(s.search.top_k, 3);
        assert_eq!(s.search.dedup_threshold, 0.85);
    }
}
