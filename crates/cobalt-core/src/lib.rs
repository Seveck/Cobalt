//! # cobalt-core
//!
//! Frozen contracts of Cobalt (see `docs/CONTRACTS.md`): shared enums, entities (1:1 with
//! the 12 SQLite tables), DTOs, service traits, Tauri event names and IPC command names.
//! Every serializable type is mirrored exactly in `src/types/contracts.ts`.
//!
//! Core services owned by [CLAUDE] (Phase 1): pinned model/engine `catalog`, hardware
//! `profiler` (detection behind feature `hardware`), `engines::EngineManager` (feature
//! `engines`), `config_manager`, Secret `scrubber`, `memoryignore`, `vault`, `firewall`.
//! Contract consumers that only need DTOs/traits depend on the crate without features.

#![forbid(unsafe_code)]

pub mod catalog;
pub mod config;
pub mod config_manager;
pub mod connectors;
pub mod engine;
#[cfg(feature = "engines")]
pub mod engines;
pub mod enums;
pub mod error;
pub mod events;
pub mod firewall;
pub mod hardware;
pub mod ids;
pub mod ipc;
pub mod mcp;
pub mod memoryignore;
pub mod model;
pub mod paths;
pub mod profiler;
pub mod scrubber;
pub mod search;
pub mod telemetry;
pub mod theme;
pub mod traits;
pub mod transfer;
pub mod vault;

pub use error::{CobaltError, ErrorKind, ErrorPayload, Result};
pub use ids::{Id, MAIN_BRANCH_ID, MAIN_BRANCH_NAME, Timestamp};

/// Version of the frozen contracts. Bump the minor version for additive changes and the
/// major version for breaking ones (requires updating `src/types/contracts.ts`).
pub const CONTRACT_VERSION: &str = "1.9.0";

/// SQLite schema version (`PRAGMA user_version`) expected by this build.
pub const SCHEMA_VERSION: u32 = 1;

/// Number of canonical tables in the schema (virtual `vec_memories` included).
pub const CANONICAL_TABLE_COUNT: usize = 12;
