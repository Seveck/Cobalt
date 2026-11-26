//! Process-wide application state: the single daemon plus Phase 1 services.

use std::path::PathBuf;
use std::sync::Arc;

use cobalt_core::catalog::Catalog;
use cobalt_core::config_manager::ConfigManager;
use cobalt_core::engines::EngineManager;
use cobalt_core::enums::{EngineKind, EngineState};
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::hardware::HardwareProfile;
use cobalt_core::model::GraphQuery;
use cobalt_core::paths::{DATABASE_FILE, cobalt_home};
use cobalt_core::traits::{CobaltStore, Embedder, TokenCounter};
use cobalt_core::vault::Vault;
use cobalt_embeddings::{FastembedEmbedder, TiktokenCounter};
use cobalt_mcp::http::HttpServer;
use cobalt_mcp::socket::SocketServer;
use cobalt_mcp::{Daemon, EventSink};
use cobalt_store::SqliteStore;
use tokio::sync::{Mutex, OnceCell};

pub struct AppState {
    pub home: PathBuf,
    pub catalog: &'static Catalog,
    pub config: Arc<ConfigManager>,
    pub engines: Arc<EngineManager>,
    pub vault: Arc<Vault>,
    pub daemon: Arc<Daemon>,
    base_store: SqliteStore,
    /// `(engine, model)` the live store was built with, if retrieval is active.
    active_engine: Mutex<Option<(EngineKind, String)>>,
    hardware: OnceCell<HardwareProfile>,
    servers: Mutex<Servers>,
}

#[derive(Default)]
struct Servers {
    socket: Option<SocketServer>,
    http: Option<HttpServer>,
}

impl AppState {
    pub async fn init(sink: Arc<dyn EventSink>) -> Result<Self> {
        Self::init_at(cobalt_home()?, sink).await
    }

    pub async fn init_at(home: PathBuf, sink: Arc<dyn EventSink>) -> Result<Self> {
        tokio::fs::create_dir_all(&home).await?;
        let base_store = SqliteStore::open_at(home.join(DATABASE_FILE)).await?;
        let config = Arc::new(ConfigManager::load(Arc::new(base_store.clone())).await?);
        let engines = Arc::new(EngineManager::new(home.clone())?);
        let settings = config.get();
        let vault = Arc::new(Vault::open(&home, settings.vault.auto_lock_minutes));
        let tokens: Arc<dyn TokenCounter> = Arc::new(TiktokenCounter::new(settings.token_encoding));
        let daemon = Daemon::new(
            Arc::new(base_store.clone()),
            config.clone(),
            tokens,
            home.clone(),
            sink,
        );
        let state = Self {
            catalog: Catalog::builtin()?,
            home,
            config,
            engines,
            vault,
            daemon,
            base_store,
            active_engine: Mutex::new(None),
            hardware: OnceCell::new(),
            servers: Mutex::new(Servers::default()),
        };
        if let Err(err) = state.activate_engine().await {
            tracing::warn!(%err, "retrieval engine not active yet");
        }
        Ok(state)
    }

    /// Current store (with retrieval once the embedding model is installed).
    pub fn store(&self) -> Arc<dyn CobaltStore> {
        self.daemon.store()
    }

    /// Builds the retrieval store for the configured engine/model if the model is installed
    /// and swaps it into the daemon. Returns `true` when retrieval is active afterwards.
    pub async fn activate_engine(&self) -> Result<bool> {
        let settings = self.config.get();
        let wanted = (settings.vector_engine, settings.embedding_model_id.clone());
        let mut active = self.active_engine.lock().await;
        if active.as_ref() == Some(&wanted) {
            return Ok(true);
        }
        if self.engines.model_state(&wanted.1) != EngineState::Installed {
            return Ok(false);
        }
        let embedder: Arc<dyn Embedder> = Arc::new(FastembedEmbedder::from_catalog(&wanted.1)?);
        let tokens: Arc<dyn TokenCounter> = Arc::new(TiktokenCounter::new(settings.token_encoding));
        let store = match wanted.0 {
            EngineKind::SqliteVec => {
                self.base_store
                    .clone()
                    .with_sqlite_vec(embedder, tokens)
                    .await?
            }
            EngineKind::Usearch => {
                self.base_store
                    .clone()
                    .with_usearch(embedder, tokens)
                    .await?
            }
            other => {
                return Err(CobaltError::Unsupported(format!(
                    "{other} is connected in Phase 3; choose sqlite_vec or usearch"
                )));
            }
        };
        self.daemon.replace_store(Arc::new(store)).await;
        tracing::info!(engine = %wanted.0, model = %wanted.1, "retrieval engine active");
        *active = Some(wanted);
        Ok(true)
    }

    /// Starts the local socket (stdio bridges) and, if enabled, the HTTP server.
    pub async fn start_servers(&self) -> Result<()> {
        let mut servers = self.servers.lock().await;
        if servers.socket.is_none() {
            servers.socket = Some(SocketServer::start(self.daemon.clone()).await?);
        }
        let settings = self.config.get();
        if settings.mcp.http_enabled && servers.http.is_none() {
            let token = servers
                .socket
                .as_ref()
                .map(|s| s.token.clone())
                .unwrap_or_default();
            match HttpServer::start(self.daemon.clone(), token, settings.mcp.http_port).await {
                Ok(http) => {
                    tracing::info!(addr = %http.addr, "MCP/REST http server listening");
                    servers.http = Some(http);
                }
                Err(err) => tracing::warn!(%err, "http server not started"),
            }
        }
        Ok(())
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
            .store()
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
    use cobalt_mcp::NullSink;

    #[tokio::test]
    async fn init_persists_settings_and_reports_real_state() {
        let home = tempfile::tempdir().unwrap();
        let state = AppState::init_at(home.path().to_path_buf(), Arc::new(NullSink))
            .await
            .unwrap();
        assert!(home.path().join(DATABASE_FILE).is_file());
        assert_eq!(state.memory_counts().await.unwrap(), (0, 0));
        assert!(!state.vault.is_initialized());
        // Model not installed in a fresh home: retrieval stays inactive, no error.
        assert!(!state.activate_engine().await.unwrap());

        let profile = state.hardware_profile().await.unwrap();
        assert!(profile.total_ram_bytes > 0);

        state
            .config
            .modify(|s| s.language = Language::En)
            .await
            .unwrap();
        drop(state);
        let reopened = AppState::init_at(home.path().to_path_buf(), Arc::new(NullSink))
            .await
            .unwrap();
        assert_eq!(reopened.config.get().language, Language::En);
    }
}
