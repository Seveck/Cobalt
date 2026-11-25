// Prevents an extra console window on Windows release builds. MCP clients spawn
// `cobalt --mcp-stdio` with redirected pipes, which GUI-subsystem processes still inherit.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    cobalt_app_lib::run();
}
