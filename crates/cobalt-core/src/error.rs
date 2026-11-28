//! Unified error type shared by every Cobalt crate.
//!
//! `CobaltError` serializes to [`ErrorPayload`] (`{ "kind": "...", "message": "..." }`) so it
//! can be returned directly from Tauri commands, the REST API and MCP tool errors.

use serde::{Deserialize, Serialize};

/// Convenience alias used across the workspace.
pub type Result<T, E = CobaltError> = std::result::Result<T, E>;

#[derive(Debug, thiserror::Error)]
pub enum CobaltError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("read-only mode is active; writes are paused")]
    ReadOnly,
    #[error("blocked by token firewall: {0}")]
    FirewallBlocked(String),
    #[error("vault is locked")]
    VaultLocked,
    #[error("crypto error: {0}")]
    Crypto(String),
    #[error("storage error: {0}")]
    Storage(String),
    #[error("vector engine error: {0}")]
    Engine(String),
    #[error("embedding error: {0}")]
    Embedding(String),
    #[error("download error: {0}")]
    Download(String),
    #[error("integrity check failed: {0}")]
    Integrity(String),
    #[error("sandbox violation: {0}")]
    Sandbox(String),
    #[error("daemon error: {0}")]
    Daemon(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("operation cancelled")]
    Cancelled,
    #[error("unsupported: {0}")]
    Unsupported(String),
    /// The user did not allow this AI client to do that (contract v1.15.0).
    #[error("permission denied: {0}")]
    PermissionDenied(String),
    #[error("internal error: {0}")]
    Internal(String),
}

/// Stable machine-readable error discriminant (mirrored in `src/types/contracts.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    NotFound,
    InvalidInput,
    Conflict,
    ReadOnly,
    FirewallBlocked,
    VaultLocked,
    Crypto,
    Storage,
    Engine,
    Embedding,
    Download,
    Integrity,
    Sandbox,
    Daemon,
    Io,
    Serialization,
    Cancelled,
    Unsupported,
    Internal,
    PermissionDenied,
}

/// Wire representation of an error crossing IPC / HTTP / MCP boundaries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorPayload {
    pub kind: ErrorKind,
    pub message: String,
}

impl CobaltError {
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::NotFound(_) => ErrorKind::NotFound,
            Self::InvalidInput(_) => ErrorKind::InvalidInput,
            Self::Conflict(_) => ErrorKind::Conflict,
            Self::ReadOnly => ErrorKind::ReadOnly,
            Self::FirewallBlocked(_) => ErrorKind::FirewallBlocked,
            Self::VaultLocked => ErrorKind::VaultLocked,
            Self::Crypto(_) => ErrorKind::Crypto,
            Self::Storage(_) => ErrorKind::Storage,
            Self::Engine(_) => ErrorKind::Engine,
            Self::Embedding(_) => ErrorKind::Embedding,
            Self::Download(_) => ErrorKind::Download,
            Self::Integrity(_) => ErrorKind::Integrity,
            Self::Sandbox(_) => ErrorKind::Sandbox,
            Self::Daemon(_) => ErrorKind::Daemon,
            Self::Io(_) => ErrorKind::Io,
            Self::Serialization(_) => ErrorKind::Serialization,
            Self::Cancelled => ErrorKind::Cancelled,
            Self::Unsupported(_) => ErrorKind::Unsupported,
            Self::PermissionDenied(_) => ErrorKind::PermissionDenied,
            Self::Internal(_) => ErrorKind::Internal,
        }
    }

    pub fn payload(&self) -> ErrorPayload {
        ErrorPayload {
            kind: self.kind(),
            message: self.to_string(),
        }
    }
}

impl Serialize for CobaltError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.payload().serialize(serializer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_payload() {
        let json =
            serde_json::to_value(CobaltError::NotFound("memory x".into())).unwrap_or_default();
        assert_eq!(json["kind"], "not_found");
        assert_eq!(json["message"], "not found: memory x");
    }
}
