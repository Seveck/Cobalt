//! Process-wide application state shared by IPC commands (Phase 1 services).
//! Phase 2 moves ownership into the single daemon (`cobalt-mcp`).

use std::path::PathBuf;
use std::sync::Arc;

use cobalt_core::catalog::Catalog;
use cobalt_core::config_manager::ConfigManager;
use cobalt_core::engines::EngineManager;
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::hardware::HardwareProfile;
use cobalt_core::model::GraphQuery;
use cobalt_core::paths::{DATABASE_FILE, cobalt_home};
use cobalt_core::traits::MemoryRepository;
use cobalt_core::vault::Vault;
use cobalt_store::SqliteStore;
use tokio::sync::OnceCell;

pub struct AppState {
    pub home: PathBuf,
    pub catalog: &'static Catalog,
    pub store: SqliteStore,
    pub config: Arc<ConfigManager>,
    pub engines: Arc<EngineManager>,
    pub vault: Arc<Vault>,
    hardware: OnceCell<HardwareProfile>,
}

impl AppState {
    pub async fn init() -> Result<Self> {
        Self::init_at(cobalt_home()?).await
    }

    pub async fn init_at(home: PathBuf) -> Result<Self> {
        tokio::fs::create_dir_all(&home).await?;
        let store = SqliteStore::open_at(home.join(DATABASE_FILE)).await?;
        let config = Arc::new(ConfigManager::load(Arc::new(store.clone())).await?);
        let engines = Arc::new(EngineManager::new(home.clone())?);
        let vault = Arc::new(Vault::open(&home, config.get().vault.auto_lock_minutes));
        Ok(Self {
            catalog: Catalog::builtin()?,
            home,
            store,
            config,
            engines,
            vault,
            hardware: OnceCell::new(),
        })
    }

    /// Hardware detection runs once per process; the recommendation's `download_bytes` is
    /// recomputed on every call so it reflects what is already installed.
    pub async fn hardware_profile(&self) -> Result<HardwareProfile> {
        let engines = self.engines.clone();
        let mut profile = self
            .hardware
            .get_or_try_init(|| async move {
                cobalt_core::profiler::detect_hardware(engines.catalog(), |p| {
                    engines.is_relative_dest_installed(p)
                })
                .await
            })
            .await?
            .clone();
        let rec = &profile.recommendation;
        profile.recommendation = cobalt_core::profiler::build_recommendation(
            self.catalog,
            rec.tier,
            &rec.reason_key,
            |p| self.engines.is_relative_dest_installed(p),
        )?;
        Ok(profile)
    }

    /// `(indexed active memories, encrypted memories)` of the active branch.
    pub async fn memory_counts(&self) -> Result<(u64, u64)> {
        let graph = self
            .store
            .graph(GraphQuery {
                include_archived: true,
                include_superseded: true,
                ..GraphQuery::default()
            })
            .await?;
        let indexed = graph
            .nodes
            .iter()
            .filter(|n| !n.is_encrypted && n.status == cobalt_core::enums::MemoryStatus::Active)
            .count() as u64;
        let encrypted = graph.nodes.iter().filter(|n| n.is_encrypted).count() as u64;
        Ok((indexed, encrypted))
    }
}

/// Runs CPU-heavy work (Argon2id, hashing) off the async executor.
pub async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| CobaltError::Internal(format!("blocking task: {e}")))?
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use cobalt_core::enums::Language;

    #[tokio::test]
    async fn init_persists_settings_and_reports_real_state() {
        let home = tempfile::tempdir().unwrap();
        let state = AppState::init_at(home.path().to_path_buf()).await.unwrap();
        assert!(home.path().join(DATABASE_FILE).is_file());
        assert_eq!(state.memory_counts().await.unwrap(), (0, 0));
        assert!(!state.vault.is_initialized());

        let profile = state.hardware_profile().await.unwrap();
        assert!(profile.total_ram_bytes > 0);
        assert!(profile.recommendation.download_bytes > 0);

        state
            .config
            .modify(|s| s.language = Language::En)
            .await
            .unwrap();
        drop(state);
        let reopened = AppState::init_at(home.path().to_path_buf()).await.unwrap();
        assert_eq!(reopened.config.get().language, Language::En);
    }
}
