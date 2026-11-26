//! # cobalt-mcp
//!
//! The single Cobalt daemon and its interfaces:
//! - [`daemon::Daemon`]: sole writer, write queue, read-only mode, live events, status.
//! - [`tools`]: the 7 MCP tools of `docs/MCP_SPEC.md` (scrubber + firewall + telemetry).
//! - [`protocol::Session`]: MCP JSON-RPC session shared by every transport.
//! - [`socket`]: authenticated local socket + the `cobalt --mcp-stdio` bridge.
//! - [`http`]: MCP streamable HTTP + legacy SSE, REST API with OpenAPI/Swagger, WebSocket.

pub mod daemon;
pub mod http;
pub mod project;
pub mod protocol;
mod render;
pub mod socket;
pub mod tools;
mod writes;

pub use daemon::{Daemon, DaemonEvent, EventSink, NullSink};
pub use project::ClientContext;
pub use protocol::Session;
