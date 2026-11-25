//! Config manager: validated, cached `AppSettings` on top of any `ConfigRepository`, with
//! change notifications (`tokio::sync::watch`) so the daemon, firewall, vault and UI react
//! to edits immediately.

use std::sync::Arc;

use tokio::sync::{Mutex, watch};

use crate::catalog::{Catalog, is_ollama_model};
use crate::config::AppSettings;
use crate::enums::EngineKind;
use crate::error::{CobaltError, Result};
use crate::mcp::MAX_TOP_K;
use crate::traits::ConfigRepository;

pub struct ConfigManager {
    repo: Arc<dyn ConfigRepository>,
    tx: watch::Sender<AppSettings>,
    /// Serializes read-modify-write updates.
    write_lock: Mutex<()>,
}

impl ConfigManager {
    /// Loads settings; invalid persisted values are replaced by defaults field by field and
    /// the repaired settings are saved back.
    pub async fn load(repo: Arc<dyn ConfigRepository>) -> Result<Self> {
        let mut loaded = repo.load_settings().await?;
        // First run: follow the OS language (Spanish for es-*, English otherwise).
        if repo.get_raw("language").await?.is_none() {
            loaded.language = crate::enums::Language::detect_system();
            repo.save_settings(&loaded).await?;
        }
        let settings = match validate_settings(&loaded) {
            Ok(()) => loaded,
            Err(err) => {
                tracing::warn!(%err, "persisted settings invalid; repairing");
                let repaired = repair(loaded);
                repo.save_settings(&repaired).await?;
                repaired
            }
        };
        let (tx, _rx) = watch::channel(settings);
        Ok(Self {
            repo,
            tx,
            write_lock: Mutex::new(()),
        })
    }

    pub fn get(&self) -> AppSettings {
        self.tx.borrow().clone()
    }

    pub fn subscribe(&self) -> watch::Receiver<AppSettings> {
        self.tx.subscribe()
    }

    /// Validates, persists and broadcasts a full replacement.
    pub async fn update(&self, new: AppSettings) -> Result<AppSettings> {
        let _guard = self.write_lock.lock().await;
        validate_settings(&new)?;
        self.repo.save_settings(&new).await?;
        self.tx.send_replace(new.clone());
        Ok(new)
    }

    /// Read-modify-write helper.
    pub async fn modify(&self, f: impl FnOnce(&mut AppSettings) + Send) -> Result<AppSettings> {
        let _guard = self.write_lock.lock().await;
        let mut next = self.get();
        f(&mut next);
        validate_settings(&next)?;
        self.repo.save_settings(&next).await?;
        self.tx.send_replace(next.clone());
        Ok(next)
    }
}

/// Keeps every top-level section that validates on its own; resets the others.
fn repair(candidate: AppSettings) -> AppSettings {
    let defaults = AppSettings::default();
    let Ok(cand_entries) = candidate.to_entries() else {
        return defaults;
    };
    let mut current = defaults;
    for (key, value) in cand_entries {
        let Ok(mut probe_entries) = current.to_entries() else {
            continue;
        };
        for entry in &mut probe_entries {
            if entry.0 == key {
                entry.1 = value.clone();
            }
        }
        let probe = AppSettings::from_entries(probe_entries);
        if validate_settings(&probe).is_ok() {
            current = probe;
        }
    }
    current
}

fn check(cond: bool, msg: &str) -> Result<()> {
    if cond {
        Ok(())
    } else {
        Err(CobaltError::InvalidInput(msg.to_owned()))
    }
}

fn unit(x: f64) -> bool {
    x.is_finite() && (0.0..=1.0).contains(&x)
}

/// Validates every user-editable setting (ranges, catalog ids, shortcuts, URLs).
pub fn validate_settings(s: &AppSettings) -> Result<()> {
    let q = &s.search;
    check(
        q.top_k >= 1 && q.top_k <= MAX_TOP_K,
        "search.top_k must be between 1 and 50",
    )?;
    for (v, name) in [
        (q.min_similarity, "search.min_similarity"),
        (q.dedup_threshold, "search.dedup_threshold"),
        (q.duplicate_threshold, "search.duplicate_threshold"),
        (
            q.import_collision_threshold,
            "search.import_collision_threshold",
        ),
        (q.semantic_edge_threshold, "search.semantic_edge_threshold"),
        (q.confidence_weight, "search.confidence_weight"),
    ] {
        check(unit(v), &format!("{name} must be within 0..=1"))?;
    }
    check(
        q.core_pin_boost.is_finite() && (0.0..=10.0).contains(&q.core_pin_boost),
        "search.core_pin_boost must be within 0..=10",
    )?;
    check(
        q.rrf.k.is_finite() && q.rrf.k > 0.0 && q.rrf.k <= 1000.0,
        "search.rrf.k must be within (0, 1000]",
    )?;
    check(
        q.rrf.vector_weight.is_finite()
            && q.rrf.fts_weight.is_finite()
            && q.rrf.vector_weight >= 0.0
            && q.rrf.fts_weight >= 0.0
            && q.rrf.vector_weight + q.rrf.fts_weight > 0.0,
        "search.rrf weights must be >= 0 and not both 0",
    )?;

    let c = &s.chunking;
    check(
        (32..=8192).contains(&c.max_chunk_tokens),
        "chunking.max_chunk_tokens must be within 32..=8192",
    )?;
    check(
        c.overlap_tokens < c.max_chunk_tokens / 2,
        "chunking.overlap_tokens must be < half of max_chunk_tokens",
    )?;

    let d = &s.decay;
    check(d.inactive_days >= 1, "decay.inactive_days must be >= 1")?;
    check(
        d.decay_rate > 0.0 && d.decay_rate <= 1.0,
        "decay.decay_rate must be within (0, 1]",
    )?;
    check(
        unit(d.archive_threshold),
        "decay.archive_threshold must be within 0..=1",
    )?;

    check(
        s.retention.detailed_log_limit >= 100,
        "retention.detailed_log_limit must be >= 100",
    )?;
    check(
        s.retention.detailed_log_days >= 1,
        "retention.detailed_log_days must be >= 1",
    )?;

    let f = &s.firewall;
    check(
        (50..=8000).contains(&f.max_tokens_per_memory),
        "firewall.max_tokens_per_memory must be within 50..=8000",
    )?;
    check(
        f.max_writes_per_minute >= 1 && f.max_reads_per_minute >= 1,
        "firewall rates must be >= 1",
    )?;
    check(
        f.repeated_write_window_secs <= 3600,
        "firewall.repeated_write_window_secs must be <= 3600",
    )?;

    check(
        (1..=1440).contains(&s.vault.auto_lock_minutes),
        "vault.auto_lock_minutes must be within 1..=1440",
    )?;

    check(
        !s.shortcuts.quick_note.trim().is_empty(),
        "shortcuts.quick_note must not be empty",
    )?;
    check(
        !s.shortcuts.toggle_read_only.trim().is_empty(),
        "shortcuts.toggle_read_only must not be empty",
    )?;
    check(
        s.shortcuts.quick_note != s.shortcuts.toggle_read_only,
        "shortcuts must be different",
    )?;

    check(s.mcp.http_port >= 1024, "mcp.http_port must be >= 1024")?;
    check(
        (1..=24 * 30).contains(&s.mcp.handoff_ttl_hours),
        "mcp.handoff_ttl_hours must be within 1..=720",
    )?;
    for (tool, doc) in &s.mcp.tool_docstring_overrides {
        check(
            crate::mcp::ALL_TOOLS.contains(&tool.as_str()),
            &format!("unknown MCP tool '{tool}'"),
        )?;
        check(
            !doc.trim().is_empty() && doc.len() <= 4000,
            "tool docstrings must be 1..=4000 chars",
        )?;
    }

    check(
        s.ollama.base_url.starts_with("http://") || s.ollama.base_url.starts_with("https://"),
        "ollama.base_url must be an http(s) URL",
    )?;
    check(
        !s.active_theme_id.trim().is_empty(),
        "active_theme_id must not be empty",
    )?;

    if !is_ollama_model(&s.embedding_model_id) {
        let catalog = Catalog::builtin()?;
        check(
            catalog.model(&s.embedding_model_id).is_some(),
            "embedding_model_id is not in the catalog",
        )?;
    } else {
        check(
            s.embedding_model_id.len() > "ollama:".len(),
            "ollama model name must not be empty",
        )?;
    }
    if matches!(
        s.vector_engine,
        EngineKind::LanceDb | EngineKind::QdrantRemote | EngineKind::ChromaDb
    ) {
        check(s.pro_mode, "external vector engines require Pro mode")?;
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::field_reassign_with_default)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::Mutex as StdMutex;

    #[derive(Default)]
    struct MemRepo {
        saved: StdMutex<Option<AppSettings>>,
    }

    #[async_trait]
    impl ConfigRepository for MemRepo {
        async fn load_settings(&self) -> Result<AppSettings> {
            Ok(self.saved.lock().unwrap().clone().unwrap_or_default())
        }
        async fn save_settings(&self, settings: &AppSettings) -> Result<()> {
            *self.saved.lock().unwrap() = Some(settings.clone());
            Ok(())
        }
        async fn get_raw(&self, key: &str) -> Result<Option<serde_json::Value>> {
            let saved = self.saved.lock().unwrap().clone();
            Ok(saved.and_then(|s| {
                s.to_entries()
                    .ok()?
                    .into_iter()
                    .find(|(k, _)| k == key)
                    .map(|(_, v)| v)
            }))
        }
        async fn set_raw(&self, _key: &str, _value: serde_json::Value) -> Result<()> {
            Ok(())
        }
    }

    #[test]
    fn defaults_are_valid() {
        validate_settings(&AppSettings::default()).unwrap();
    }

    #[test]
    fn rejects_out_of_range_values() {
        let mut s = AppSettings::default();
        s.search.dedup_threshold = 1.5;
        assert!(validate_settings(&s).is_err());
        let mut s = AppSettings::default();
        s.embedding_model_id = "made-up-model".into();
        assert!(validate_settings(&s).is_err());
        let mut s = AppSettings::default();
        s.embedding_model_id = "ollama:nomic-embed-text".into();
        validate_settings(&s).unwrap();
        let mut s = AppSettings::default();
        s.vector_engine = EngineKind::ChromaDb;
        assert!(validate_settings(&s).is_err());
        s.pro_mode = true;
        validate_settings(&s).unwrap();
        let mut s = AppSettings::default();
        s.mcp
            .tool_docstring_overrides
            .insert("not_a_tool".into(), "doc".into());
        assert!(validate_settings(&s).is_err());
    }

    #[tokio::test]
    async fn update_persists_and_notifies() {
        let repo = Arc::new(MemRepo::default());
        let manager = ConfigManager::load(repo.clone()).await.unwrap();
        let mut rx = manager.subscribe();
        let updated = manager.modify(|s| s.search.top_k = 12).await.unwrap();
        assert_eq!(updated.search.top_k, 12);
        assert!(rx.has_changed().unwrap());
        assert_eq!(rx.borrow_and_update().search.top_k, 12);
        assert_eq!(
            repo.saved.lock().unwrap().as_ref().unwrap().search.top_k,
            12
        );

        let mut bad = manager.get();
        bad.vault.auto_lock_minutes = 0;
        assert!(manager.update(bad).await.is_err());
        assert_eq!(manager.get().vault.auto_lock_minutes, 10);
    }

    #[tokio::test]
    async fn load_repairs_invalid_sections_only() {
        let repo = Arc::new(MemRepo::default());
        let mut stored = AppSettings::default();
        stored.language = crate::enums::Language::En;
        stored.search.top_k = 999;
        *repo.saved.lock().unwrap() = Some(stored);
        let manager = ConfigManager::load(repo.clone()).await.unwrap();
        let s = manager.get();
        assert_eq!(s.language, crate::enums::Language::En);
        assert_eq!(s.search.top_k, 8);
        assert_eq!(repo.saved.lock().unwrap().as_ref().unwrap().search.top_k, 8);
    }
}
