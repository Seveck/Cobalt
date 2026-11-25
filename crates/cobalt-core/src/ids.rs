//! Identifier, timestamp and well-known constant helpers.

use chrono::{DateTime, SecondsFormat, Utc};
use uuid::Uuid;

use crate::error::{CobaltError, Result};

/// Every entity id is a UUID (v7 for new rows) serialized as lowercase hyphenated text.
pub type Id = Uuid;

/// UTC timestamp. Serialized over IPC as RFC 3339; stored in SQLite as RFC 3339 with
/// millisecond precision and a `Z` suffix (see [`timestamp_to_sql`]).
pub type Timestamp = DateTime<Utc>;

/// Fixed id of the `main` memory branch. It is identical on every installation so that
/// `.cobalt-backup` and `.cbrain` files merge cleanly across machines.
pub const MAIN_BRANCH_ID: Id = Uuid::from_u128(0x0000_0000_0000_7000_8000_0000_0000_0001);

/// Name of the default memory branch.
pub const MAIN_BRANCH_NAME: &str = "main";

/// Generates a new time-ordered id (UUID v7).
pub fn new_id() -> Id {
    Uuid::now_v7()
}

/// Current UTC time.
pub fn now() -> Timestamp {
    Utc::now()
}

/// Canonical SQLite text form: `2026-11-25T14:57:00.123Z`.
pub fn timestamp_to_sql(ts: &Timestamp) -> String {
    ts.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Parses any RFC 3339 timestamp (as stored in SQLite or received over IPC).
pub fn timestamp_from_sql(raw: &str) -> Result<Timestamp> {
    DateTime::parse_from_rfc3339(raw)
        .map(|dt| dt.with_timezone(&Utc))
        .map_err(|e| CobaltError::InvalidInput(format!("invalid timestamp '{raw}': {e}")))
}

/// Parses a UUID stored as text.
pub fn id_from_str(raw: &str) -> Result<Id> {
    Uuid::parse_str(raw).map_err(|e| CobaltError::InvalidInput(format!("invalid id '{raw}': {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamp_roundtrip_keeps_millis() {
        let ts = now();
        let text = timestamp_to_sql(&ts);
        assert!(text.ends_with('Z'));
        let parsed = timestamp_from_sql(&text).unwrap_or_default();
        assert_eq!(parsed.timestamp_millis(), ts.timestamp_millis());
    }

    #[test]
    fn main_branch_id_is_stable() {
        assert_eq!(
            MAIN_BRANCH_ID.to_string(),
            "00000000-0000-7000-8000-000000000001"
        );
    }

    #[test]
    fn new_ids_are_v7_and_ordered() {
        let a = new_id();
        let b = new_id();
        assert_eq!(a.get_version_num(), 7);
        assert!(a <= b);
    }
}
