//! Cobalt desktop shell (Tauri v2).
//!
//! Phase 0: two windows (`main`, `quicknote`), plugins and capabilities.
//! Phase 2 adds the daemon, `--mcp-stdio` bridge, tray and global shortcuts;
//! Phase 3 wires the full IPC command table of `docs/CONTRACTS.md`.

mod commands;

use tracing_subscriber::EnvFilter;

/// Window labels (must match `tauri.conf.json` and `capabilities/*.json`).
pub const MAIN_WINDOW: &str = "main";
pub const QUICKNOTE_WINDOW: &str = "quicknote";

pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .try_init();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());

    let result = builder
        .invoke_handler(tauri::generate_handler![commands::app_info])
        .run(tauri::generate_context!());

    if let Err(err) = result {
        tracing::error!(error = %err, "cobalt failed to start");
        eprintln!("cobalt failed to start: {err}");
        std::process::exit(1);
    }
}
