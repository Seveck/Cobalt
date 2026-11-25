//! Cobalt desktop shell (Tauri v2).
//!
//! Phase 1: core services (settings, hardware profile, verified engine/model downloads,
//! vault) exposed through the Phase 1 IPC commands of `docs/CONTRACTS.md`.
//! Phase 2 adds the daemon, `--mcp-stdio` bridge, tray and global shortcuts;
//! Phase 3 wires the full IPC command table.

mod commands;
mod state;

use std::time::Duration;

use cobalt_core::events::EVENT_VAULT_STATUS;
use tauri::{Emitter, Manager};
use tracing_subscriber::EnvFilter;

use crate::state::AppState;

/// Window labels (must match `tauri.conf.json` and `capabilities/*.json`).
pub const MAIN_WINDOW: &str = "main";
pub const QUICKNOTE_WINDOW: &str = "quicknote";

pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,wgpu_hal=off,wgpu_core=warn,naga=warn")),
        )
        .try_init();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());

    let result = builder
        .setup(|app| {
            let state = tauri::async_runtime::block_on(AppState::init())
                .map_err(|e| format!("failed to initialize Cobalt: {e}"))?;
            app.manage(state);
            spawn_vault_auto_lock(app.handle().clone());
            Ok(())
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
        ])
        .run(tauri::generate_context!());

    if let Err(err) = result {
        tracing::error!(error = %err, "cobalt failed to start");
        eprintln!("cobalt failed to start: {err}");
        std::process::exit(1);
    }
}

/// Locks the vault after inactivity and notifies the UI.
fn spawn_vault_auto_lock(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        loop {
            tick.tick().await;
            let state = app.state::<AppState>();
            if state.vault.tick() {
                match commands::vault_status_of(&state).await {
                    Ok(status) => {
                        if let Err(err) = app.emit(EVENT_VAULT_STATUS, &status) {
                            tracing::warn!(%err, "failed to emit vault status");
                        }
                    }
                    Err(err) => tracing::warn!(%err, "vault status after auto-lock"),
                }
            }
        }
    });
}
