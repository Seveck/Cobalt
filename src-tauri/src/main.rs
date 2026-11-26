// Prevents an extra console window on Windows release builds. MCP clients spawn
// `cobalt --mcp-stdio` with redirected pipes, which GUI-subsystem processes still inherit.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == cobalt_core::paths::MCP_STDIO_FLAG) {
        std::process::exit(cobalt_app_lib::run_mcp_stdio_bridge());
    }
    if let Some(pos) = args.iter().position(|a| a == cobalt_core::paths::HOOK_FLAG) {
        let source = args.get(pos + 1).cloned().unwrap_or_default();
        let last = args.get(pos + 2).cloned();
        std::process::exit(cobalt_app_lib::run_hook(&source, last));
    }
    cobalt_app_lib::run();
}
