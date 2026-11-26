// Prevents an extra console window on Windows release builds. MCP clients spawn
// `cobalt --mcp-stdio` with redirected pipes, which GUI-subsystem processes still inherit.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|a| a == cobalt_core::paths::MCP_STDIO_FLAG) {
        std::process::exit(cobalt_app_lib::run_mcp_stdio_bridge());
    }
    cobalt_app_lib::run();
}
