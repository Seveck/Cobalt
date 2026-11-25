//! # cobalt-core
//!
//! Frozen contracts of Cobalt (see `docs/CONTRACTS.md`): shared enums, entities (1:1 with
//! the 12 SQLite tables), DTOs, service traits, Tauri event names and IPC command names.
//! Every serializable type is mirrored exactly in `src/types/contracts.ts`.
//!
//! Phase 1 adds the core services owned by [CLAUDE]: hardware profiler, `EngineManager`,
//! Secret Scrubber, `.memoryignore`, vault and Token Firewall.

#![forbid(unsafe_code)]

pub mod config;
pub mod connectors;
pub mod engine;
pub mod enums;
pub mod error;
pub mod events;
pub mod hardware;
pub mod ids;
pub mod ipc;
pub mod mcp;
pub mod model;
pub mod paths;
pub mod search;
pub mod telemetry;
pub mod theme;
pub mod traits;
pub mod transfer;

pub use error::{CobaltError, ErrorKind, ErrorPayload, Result};
pub use ids::{Id, MAIN_BRANCH_ID, MAIN_BRANCH_NAME, Timestamp};

/// Version of the frozen contracts. Bump the minor version for additive changes and the
/// major version for breaking ones (requires updating `src/types/contracts.ts`).
pub const CONTRACT_VERSION: &str = "1.0.0";

/// SQLite schema version (`PRAGMA user_version`) expected by this build.
pub const SCHEMA_VERSION: u32 = 1;

/// Number of canonical tables in the schema (virtual `vec_memories` included).
pub const CANONICAL_TABLE_COUNT: usize = 12;
