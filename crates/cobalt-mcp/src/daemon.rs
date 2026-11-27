//! The single Cobalt daemon: the only writer of the canonical store. Every MCP transport
//! (stdio bridge over the local socket, streamable HTTP, legacy SSE) and the REST API go
//! through it, so writes are serialized, policies (read-only, Secret Scrubber, Token Firewall,
//! `.memoryignore`) apply uniformly and every operation produces telemetry + live events.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use cobalt_core::config_manager::ConfigManager;
use cobalt_core::enums::McpTransport;
use cobalt_core::error::Result;
use cobalt_core::events::{ConnectedClient, DaemonStatus};
use cobalt_core::firewall::TokenFirewall;
use cobalt_core::ids::{Timestamp, now};
use cobalt_core::model::MemoryChanged;
use cobalt_core::telemetry::McpActivity;
use cobalt_core::traits::{CobaltStore, TokenCounter};
use serde::Serialize;
use tokio::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard, broadcast};

/// Receives live events (implemented by `src-tauri` to emit Tauri events).
pub trait EventSink: Send + Sync {
    fn mcp_activity(&self, activity: &McpActivity);
    fn memory_changed(&self, change: &MemoryChanged);
    fn read_only_changed(&self, read_only: bool);
    /// A write or read was blocked by the Token Firewall (for a discreet OS notification).
    fn firewall_blocked(&self, client_name: &str, detail: &str);
    /// An agent archived a memory (always notified: the user must be able to restore it).
    fn agent_archived(&self, client_name: &str, preview: &str, other_agents: usize);
    /// Something happened in an AI CLI (hooks). The sink re-indexes touched files.
    fn cli_activity(&self, _activity: &cobalt_core::events::CliActivity) {}
    /// A project with a root path is in use (first time per process): auto-watch it.
    fn project_active(&self, _project: &cobalt_core::model::Project) {}
}

/// Sink that ignores everything (tests, headless tooling).
pub struct NullSink;

impl EventSink for NullSink {
    fn mcp_activity(&self, _: &McpActivity) {}
    fn memory_changed(&self, _: &MemoryChanged) {}
    fn read_only_changed(&self, _: bool) {}
    fn firewall_blocked(&self, _: &str, _: &str) {}
    fn agent_archived(&self, _: &str, _: &str, _: usize) {}
}

/// Event broadcast to WebSocket subscribers (`/api/v1/ws`).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", content = "payload")]
pub enum DaemonEvent {
    #[serde(rename = "cobalt://mcp-activity")]
    McpActivity(McpActivity),
    #[serde(rename = "cobalt://memory-changed")]
    MemoryChanged(MemoryChanged),
    #[serde(rename = "cobalt://read-only-changed")]
    ReadOnlyChanged { read_only: bool },
    #[serde(rename = "cobalt://cli-activity")]
    CliActivity(cobalt_core::events::CliActivity),
}

pub struct Daemon {
    store: std::sync::RwLock<Arc<dyn CobaltStore>>,
    pub(crate) config: Arc<ConfigManager>,
    pub(crate) tokens: Arc<dyn TokenCounter>,
    pub(crate) firewall: TokenFirewall,
    pub(crate) home: PathBuf,
    sink: Arc<dyn EventSink>,
    events: broadcast::Sender<DaemonEvent>,
    read_only: AtomicBool,
    write_gate: RwLock<()>,
    queued_writes: AtomicU64,
    started_at: Timestamp,
    next_session: AtomicU64,
    clients: Mutex<HashMap<u64, ConnectedClient>>,
    http_port: Mutex<Option<u16>>,
    /// `(client, memory)` -> time of the last `archive_memory` dry run.
    archive_dry_runs: Mutex<HashMap<(String, cobalt_core::Id), std::time::Instant>>,
    pub(crate) sessions: Mutex<crate::capture::SessionTracker>,
    seen_projects: crate::capture::SeenProjects,
    /// Saves AI-made themes (`create_theme`); set by the desktop app.
    themes: std::sync::OnceLock<Arc<dyn cobalt_core::traits::ThemeService>>,
}

impl Daemon {
    pub fn new(
        store: Arc<dyn CobaltStore>,
        config: Arc<ConfigManager>,
        tokens: Arc<dyn TokenCounter>,
        home: PathBuf,
        sink: Arc<dyn EventSink>,
    ) -> Arc<Self> {
        let settings = config.get();
        let (events, _) = broadcast::channel(256);
        Arc::new(Self {
            firewall: TokenFirewall::new(settings.firewall.clone(), tokens.clone()),
            read_only: AtomicBool::new(settings.read_only),
            store: std::sync::RwLock::new(store),
            config,
            tokens,
            home,
            sink,
            events,
            write_gate: RwLock::new(()),
            queued_writes: AtomicU64::new(0),
            started_at: now(),
            next_session: AtomicU64::new(1),
            clients: Mutex::new(HashMap::new()),
            http_port: Mutex::new(None),
            archive_dry_runs: Mutex::new(HashMap::new()),
            sessions: Mutex::new(crate::capture::SessionTracker::default()),
            seen_projects: crate::capture::SeenProjects::default(),
            themes: std::sync::OnceLock::new(),
        })
    }

    /// Current store (cheap `Arc` clone).
    pub fn store(&self) -> Arc<dyn CobaltStore> {
        self.store.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Swaps the store, e.g. once the embedding model has been installed. In-flight calls keep
    /// using the previous instance until they finish.
    pub async fn replace_store(&self, store: Arc<dyn CobaltStore>) {
        let _pause = self.pause_writes().await;
        *self.store.write().unwrap_or_else(|p| p.into_inner()) = store;
    }

    pub fn config(&self) -> &Arc<ConfigManager> {
        &self.config
    }

    pub fn subscribe(&self) -> broadcast::Receiver<DaemonEvent> {
        self.events.subscribe()
    }

    /// Re-applies settings that services cache (call after `update_settings`).
    pub fn reload_settings(&self) {
        let settings = self.config.get();
        self.firewall.update_settings(settings.firewall);
    }

    // ------------------------------------------------------------------ read-only mode

    pub fn is_read_only(&self) -> bool {
        self.read_only.load(Ordering::SeqCst)
    }

    /// Toggles Read-Only / Incognito mode, persists it and notifies every listener.
    pub async fn set_read_only(&self, read_only: bool) -> Result<bool> {
        self.config.modify(|s| s.read_only = read_only).await?;
        self.read_only.store(read_only, Ordering::SeqCst);
        self.sink.read_only_changed(read_only);
        let _ = self.events.send(DaemonEvent::ReadOnlyChanged { read_only });
        Ok(read_only)
    }

    // ------------------------------------------------------------------ themes

    /// Installs the app's theme service (once); without it `create_theme` is unavailable.
    pub fn set_theme_service(&self, service: Arc<dyn cobalt_core::traits::ThemeService>) {
        let _ = self.themes.set(service);
    }

    pub(crate) fn theme_service(&self) -> Option<&Arc<dyn cobalt_core::traits::ThemeService>> {
        self.themes.get()
    }

    // ------------------------------------------------------------------ write queue

    /// Shared guard held by every write. Writes wait (queue) while an engine swap holds the
    /// exclusive guard.
    pub async fn write_slot(&self) -> RwLockReadGuard<'_, ()> {
        self.queued_writes.fetch_add(1, Ordering::SeqCst);
        let guard = self.write_gate.read().await;
        self.queued_writes.fetch_sub(1, Ordering::SeqCst);
        guard
    }

    /// Exclusive guard: pauses (queues) all incoming writes, e.g. during an engine swap.
    pub async fn pause_writes(&self) -> RwLockWriteGuard<'_, ()> {
        self.write_gate.write().await
    }

    pub fn queued_writes(&self) -> u64 {
        self.queued_writes.load(Ordering::SeqCst)
    }

    // ------------------------------------------------------------------ events

    pub(crate) fn emit_activity(&self, activity: McpActivity) {
        self.sink.mcp_activity(&activity);
        let _ = self.events.send(DaemonEvent::McpActivity(activity));
    }

    pub fn emit_memory_changed(&self, change: MemoryChanged) {
        self.sink.memory_changed(&change);
        let _ = self.events.send(DaemonEvent::MemoryChanged(change));
    }

    pub(crate) fn emit_cli_activity(&self, activity: cobalt_core::events::CliActivity) {
        self.sink.cli_activity(&activity);
        let _ = self.events.send(DaemonEvent::CliActivity(activity));
    }

    /// Announces a project with a root path once per process (auto-watch / indexing).
    pub(crate) fn notify_project_active(&self, project: &cobalt_core::model::Project) {
        if project.root_path.is_none() {
            return;
        }
        let first = self
            .seen_projects
            .0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(project.id);
        if first {
            self.sink.project_active(project);
        }
    }

    pub(crate) fn emit_agent_archived(&self, client: &str, preview: &str, other_agents: usize) {
        self.sink.agent_archived(client, preview, other_agents);
    }

    pub(crate) fn record_archive_dry_run(&self, client: &str, id: cobalt_core::Id) {
        let mut runs = self
            .archive_dry_runs
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let window = std::time::Duration::from_secs(cobalt_core::mcp::ARCHIVE_CONFIRM_WINDOW_SECS);
        runs.retain(|_, t| t.elapsed() < window);
        runs.insert((client.to_owned(), id), std::time::Instant::now());
    }

    /// Consumes a recent dry run for `(client, id)`; `false` if none within the window.
    pub(crate) fn take_archive_dry_run(&self, client: &str, id: cobalt_core::Id) -> bool {
        let mut runs = self
            .archive_dry_runs
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let window = std::time::Duration::from_secs(cobalt_core::mcp::ARCHIVE_CONFIRM_WINDOW_SECS);
        runs.remove(&(client.to_owned(), id))
            .is_some_and(|t| t.elapsed() < window)
    }

    pub(crate) fn emit_firewall_blocked(&self, client: &str, detail: &str) {
        if self.config.get().firewall.notify_on_block {
            self.sink.firewall_blocked(client, detail);
        }
    }

    // ------------------------------------------------------------------ sessions & status

    pub(crate) fn register_client(&self, client_name: &str, transport: McpTransport) -> u64 {
        let id = self.next_session.fetch_add(1, Ordering::SeqCst);
        let mut clients = self.clients.lock().unwrap_or_else(|p| p.into_inner());
        clients.insert(
            id,
            ConnectedClient {
                client_name: client_name.to_owned(),
                transport,
                connected_at: now(),
            },
        );
        id
    }

    pub(crate) fn rename_client(&self, id: u64, client_name: &str) {
        let mut clients = self.clients.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(c) = clients.get_mut(&id) {
            c.client_name = client_name.to_owned();
        }
    }

    pub(crate) fn unregister_client(&self, id: u64) {
        let mut clients = self.clients.lock().unwrap_or_else(|p| p.into_inner());
        clients.remove(&id);
    }

    pub(crate) fn set_http_port(&self, port: Option<u16>) {
        *self.http_port.lock().unwrap_or_else(|p| p.into_inner()) = port;
    }

    pub fn status(&self) -> DaemonStatus {
        let clients = self.clients.lock().unwrap_or_else(|p| p.into_inner());
        let mut list: Vec<ConnectedClient> = clients.values().cloned().collect();
        list.sort_by_key(|a| a.connected_at);
        DaemonStatus {
            running: true,
            started_at: self.started_at,
            read_only: self.is_read_only(),
            http_port: *self.http_port.lock().unwrap_or_else(|p| p.into_inner()),
            queued_writes: self.queued_writes(),
            clients: list,
        }
    }
}
