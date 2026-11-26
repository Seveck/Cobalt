//! Cobalt desktop shell (Tauri v2): hosts the single daemon (MCP + REST/WS), the system
//! tray, global shortcuts and the IPC commands of `docs/CONTRACTS.md`.
//!
//! Process modes (see `main.rs`): normal GUI, `--headless` (tray only, started by MCP
//! bridges) and `--mcp-stdio` (thin bridge, no Tauri at all).

mod commands;
mod commands_admin;
mod commands_ingest;
mod commands_memory;
mod desktop;
mod doctor;
mod state;
mod themes;

use std::sync::Arc;
use std::time::Duration;

use cobalt_core::events::{
    EVENT_MCP_ACTIVITY, EVENT_MEMORY_CHANGED, EVENT_READ_ONLY_CHANGED, EVENT_VAULT_STATUS,
    ReadOnlyChanged,
};
use cobalt_core::model::MemoryChanged;
use cobalt_core::paths::HEADLESS_FLAG;
use cobalt_core::telemetry::McpActivity;
use cobalt_mcp::EventSink;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_notification::NotificationExt;
use tracing_subscriber::EnvFilter;

use crate::state::AppState;

/// Window labels (must match `tauri.conf.json` and `capabilities/*.json`).
pub const MAIN_WINDOW: &str = "main";
pub const QUICKNOTE_WINDOW: &str = "quicknote";

/// Forwards daemon events to the webviews, tray and OS notifications.
struct TauriSink {
    app: AppHandle,
}

impl EventSink for TauriSink {
    fn mcp_activity(&self, activity: &McpActivity) {
        let _ = self.app.emit(EVENT_MCP_ACTIVITY, activity);
    }

    fn memory_changed(&self, change: &MemoryChanged) {
        let _ = self.app.emit(EVENT_MEMORY_CHANGED, change);
    }

    fn read_only_changed(&self, read_only: bool) {
        let _ = self
            .app
            .emit(EVENT_READ_ONLY_CHANGED, ReadOnlyChanged { read_only });
        let lang = self
            .app
            .try_state::<AppState>()
            .map(|s| s.config.get().language);
        desktop::set_tray_read_only(
            &self.app,
            read_only,
            lang.unwrap_or(cobalt_core::enums::Language::En),
        );
    }

    fn agent_archived(&self, client_name: &str, preview: &str, other_agents: usize) {
        let body = if other_agents > 0 {
            format!(
                "{client_name} archivó una memoria que usan {other_agents} IA(s) más. Puedes restaurarla en Cobalt.\n«{preview}»"
            )
        } else {
            format!("{client_name} archivó una memoria. Puedes restaurarla en Cobalt.\n«{preview}»")
        };
        let _ = self
            .app
            .notification()
            .builder()
            .title("Cobalt")
            .body(body)
            .show();
    }

    fn firewall_blocked(&self, client_name: &str, detail: &str) {
        let _ = self
            .app
            .notification()
            .builder()
            .title("Cobalt · Token Firewall")
            .body(format!("{client_name}: {detail}"))
            .show();
    }
}

/// Toggles Read-Only mode (tray menu and global shortcut).
pub fn toggle_read_only(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let next = !state.daemon.is_read_only();
        if let Err(err) = state.daemon.set_read_only(next).await {
            tracing::warn!(%err, "could not toggle read-only mode");
        }
    });
}

pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,wgpu_hal=off,wgpu_core=warn,naga=warn")),
        )
        .try_init();

    let headless = std::env::args().any(|a| a == HEADLESS_FLAG);

    let builder = tauri::Builder::default()
        // Must be first: a second launch focuses the running instance instead.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if !argv.iter().any(|a| a == HEADLESS_FLAG) {
                desktop::show_main(app);
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    desktop::on_shortcut(app, shortcut, event.state())
                })
                .build(),
        )
        .manage(desktop::ShortcutBindings::default());

    let result = builder
        .setup(move |app| {
            let handle = app.handle().clone();
            let sink = Arc::new(TauriSink {
                app: handle.clone(),
            });
            let state = tauri::async_runtime::block_on(AppState::init(sink))
                .map_err(|e| format!("failed to initialize Cobalt: {e}"))?;
            let settings = state.config.get();
            if let Err(err) = tauri::async_runtime::block_on(state.start_servers()) {
                tracing::error!(%err, "daemon servers not started");
            }
            app.manage(state);
            desktop::setup_tray(&handle, &settings)?;
            desktop::register_shortcuts(&handle, &settings);
            spawn_vault_auto_lock(handle.clone());
            if !headless {
                desktop::show_main(&handle);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the main window keeps the daemon alive in the tray.
            if let WindowEvent::CloseRequested { api, .. } = event
                && (window.label() == MAIN_WINDOW || window.label() == QUICKNOTE_WINDOW)
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::get_hardware_profile,
            commands::get_settings,
            commands::update_settings,
            commands::list_embedding_models,
            commands::install_engine,
            commands::cancel_download,
            commands::get_engine_status,
            commands::vault_status,
            commands::vault_setup,
            commands::vault_unlock,
            commands::vault_lock,
            commands_memory::get_graph,
            commands_memory::get_memory,
            commands_memory::get_memory_history,
            commands_memory::save_memory,
            commands_memory::update_memory,
            commands_memory::patch_memory,
            commands_memory::delete_memory,
            commands_memory::set_memory_encrypted,
            commands_memory::reveal_memory,
            commands_memory::search_memories,
            commands_memory::list_branches,
            commands_memory::create_branch,
            commands_memory::switch_branch,
            commands_memory::merge_branch,
            commands_memory::discard_branch,
            commands_memory::list_snapshots,
            commands_memory::create_snapshot,
            commands_memory::restore_snapshot,
            commands_memory::delete_snapshot,
            commands_memory::find_duplicates,
            commands_memory::merge_duplicates,
            commands_memory::archive_memories,
            commands_memory::restore_memories,
            commands_memory::get_read_only,
            commands_memory::set_read_only,
            commands_memory::get_daemon_status,
            commands_memory::replay_activity,
            commands_memory::get_source_document,
            commands_memory::verify_source_document,
            commands_memory::get_archive_impact,
            commands_memory::get_deletion_impact,
            commands_admin::list_projects,
            commands_admin::create_project,
            commands_admin::update_project,
            commands_admin::list_library,
            commands_admin::relink_source_document,
            commands_admin::set_watched,
            commands_admin::get_telemetry_summary,
            commands_admin::query_telemetry,
            commands_admin::list_connectors,
            commands_admin::toggle_connector,
            commands_admin::run_doctor,
            commands_admin::doctor_fix,
            commands_admin::get_mcp_tool_docs,
            commands_admin::search_theme_registry,
            commands_admin::install_theme,
            commands_admin::install_theme_file,
            commands_admin::uninstall_theme,
            commands_admin::list_installed_themes,
            commands_admin::get_theme_manifest,
            commands_admin::swap_engine,
            commands_admin::remove_engine_artifacts,
            commands_admin::build_web_context,
            commands_admin::submit_quick_note,
            commands_ingest::ingest_paths,
            commands_ingest::cancel_ingest,
            commands_ingest::import_past_life,
            commands_ingest::promote_file_to_reusable,
            commands_ingest::export_capsule,
            commands_ingest::import_capsule,
            commands_ingest::export_backup,
            commands_ingest::import_backup,
        ])
        .run(tauri::generate_context!());

    if let Err(err) = result {
        tracing::error!(error = %err, "cobalt failed to start");
        eprintln!("cobalt failed to start: {err}");
        std::process::exit(1);
    }
}

/// Locks the vault after inactivity and notifies the UI.
fn spawn_vault_auto_lock(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        loop {
            tick.tick().await;
            let state = app.state::<AppState>();
            if state.vault.tick() {
                match commands::vault_status_of(&state).await {
                    Ok(status) => {
                        let _ = app.emit(EVENT_VAULT_STATUS, &status);
                    }
                    Err(err) => tracing::warn!(%err, "vault status after auto-lock"),
                }
            }
        }
    });
}

/// `cobalt --mcp-stdio`: stdio <-> daemon bridge (no GUI, nothing written to stdout but MCP).
pub fn run_mcp_stdio_bridge() -> i32 {
    let _ = tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn")),
        )
        .try_init();
    let result = (|| -> cobalt_core::Result<()> {
        let home = cobalt_core::paths::cobalt_home()?;
        let exe = std::env::current_exe()?;
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()?;
        rt.block_on(cobalt_mcp::socket::run_stdio_bridge(&home, &exe))
    })();
    match result {
        Ok(()) => 0,
        Err(err) => {
            eprintln!("cobalt --mcp-stdio: {err}");
            1
        }
    }
}
