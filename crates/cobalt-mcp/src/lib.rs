//! # cobalt-mcp
//!
//! Implemented by [CLAUDE] in Phase 2: single-daemon RPC with write queue, `--mcp-stdio`
//! bridge, MCP stdio + streamable HTTP/SSE server exposing the 7 tools of `docs/MCP_SPEC.md`,
//! axum REST/WebSocket API with OpenAPI, 1-Click connector and MCP Doctor (Phase 3).
//!
//! Contracts: `cobalt_core::traits` and `docs/CONTRACTS.md`.

pub use cobalt_core;
