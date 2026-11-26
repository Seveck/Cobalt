//! Well-known locations and local endpoints. Everything lives under `~/.cobalt/`
//! (overridable with the `COBALT_HOME` environment variable, used by tests).

use std::path::PathBuf;

use crate::error::{CobaltError, Result};

pub const COBALT_HOME_ENV: &str = "COBALT_HOME";
pub const DATABASE_FILE: &str = "cobalt.db";
pub const MODELS_DIR: &str = "models";
pub const ENGINES_DIR: &str = "engines";
pub const THEMES_DIR: &str = "themes";
pub const SNAPSHOTS_DIR: &str = "snapshots";
pub const BACKUPS_DIR: &str = "backups";
pub const LOGS_DIR: &str = "logs";
pub const VECTOR_INDEX_DIR: &str = "index";
/// Ephemeral token authenticating `cobalt --mcp-stdio` bridges against the daemon.
pub const DAEMON_TOKEN_FILE: &str = "daemon.token";
/// Unix domain socket file name (Linux / macOS), created inside the Cobalt home.
pub const DAEMON_SOCKET_FILE: &str = "daemon.sock";
/// Windows named pipe.
pub const DAEMON_PIPE_NAME: &str = r"\\.\pipe\cobalt-daemon";
/// `.gitignore`-style rules honored by MCP and the file watcher.
pub const MEMORY_IGNORE_FILE: &str = ".memoryignore";
/// Default local MCP HTTP/SSE + REST/WS port (bound to 127.0.0.1 only).
pub const DEFAULT_HTTP_PORT: u16 = 7437;
/// CLI flag that turns the binary into a stdio <-> daemon MCP bridge.
pub const MCP_STDIO_FLAG: &str = "--mcp-stdio";
/// CLI flag that starts the daemon without showing the main window (tray only).
pub const HEADLESS_FLAG: &str = "--headless";
/// CLI flag used by client hooks: `cobalt --hook <source>` (event JSON on stdin or as last arg).
pub const HOOK_FLAG: &str = "--hook";
/// Hook events received while the daemon was down, replayed at the next start.
pub const HOOK_QUEUE_FILE: &str = "hook-queue.jsonl";

/// Resolves the Cobalt home directory (`$COBALT_HOME` or `~/.cobalt`). Does not create it.
pub fn cobalt_home() -> Result<PathBuf> {
    if let Some(custom) = std::env::var_os(COBALT_HOME_ENV).filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(custom));
    }
    user_home()
        .map(|home| home.join(".cobalt"))
        .ok_or_else(|| CobaltError::Internal("cannot resolve the user home directory".into()))
}

fn user_home() -> Option<PathBuf> {
    #[cfg(windows)]
    let var = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let var = std::env::var_os("HOME");
    var.filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// Absolute path of a well-known entry inside the Cobalt home.
pub fn home_path(entry: &str) -> Result<PathBuf> {
    cobalt_home().map(|home| home.join(entry))
}
