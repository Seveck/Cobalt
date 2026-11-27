//! Telemetry (`telemetry_logs`), request history, dashboard aggregates and the live
//! `cobalt://mcp-activity` payload.

use serde::{Deserialize, Serialize};

use crate::enums::TelemetryOperation;
use crate::ids::{Id, Timestamp};

/// One vector delivered to an AI (stored in `telemetry_logs.returned_items_json`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReturnedItem {
    pub memory_id: Id,
    pub source_doc_id: Option<Id>,
    pub similarity_score: f64,
    pub chunk_tokens: i64,
    /// Purged (set to `null`) by the retention policy; metrics are never lost.
    pub content_snapshot: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TelemetryLog {
    pub id: Id,
    pub timestamp: Timestamp,
    pub client_name: String,
    pub operation: TelemetryOperation,
    pub query_text: Option<String>,
    /// Stored as `returned_items_json`.
    pub returned_items: Vec<ReturnedItem>,
    pub injected_tokens: i64,
    pub avoided_full_tokens: i64,
    pub saved_tokens: i64,
    pub latency_ms: i64,
    pub project_id: Option<Id>,
}

/// Input for recording an operation. The store computes `avoided_full_tokens`
/// deduplicating by unique `source_doc_id` and `saved_tokens = max(0, avoided - injected)
/// + output_tokens_saved`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewTelemetryEvent {
    pub client_name: String,
    pub operation: TelemetryOperation,
    pub query_text: Option<String>,
    pub returned_items: Vec<ReturnedItem>,
    pub injected_tokens: i64,
    /// Extra output tokens avoided (reuse of existing assets instead of regenerating).
    pub output_tokens_saved: i64,
    pub latency_ms: i64,
    pub project_id: Option<Id>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TelemetryQuery {
    pub client_name: Option<String>,
    pub project_id: Option<Id>,
    #[serde(default)]
    pub operations: Vec<TelemetryOperation>,
    pub from: Option<Timestamp>,
    pub to: Option<Timestamp>,
    /// Substring match over `query_text`.
    pub text: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub total: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TelemetryRange {
    pub from: Option<Timestamp>,
    pub to: Option<Timestamp>,
    /// Only events since the daemon started.
    #[serde(default)]
    pub session_only: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClientStats {
    pub client_name: String,
    pub reads: u64,
    pub writes: u64,
    pub updates: u64,
    pub reuses: u64,
    pub handoffs: u64,
    pub blocked: u64,
    pub saved_tokens: i64,
}

/// High-value node ranking (`hit_count` / `reuse_count`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NodeValue {
    pub memory_id: Id,
    pub preview: String,
    pub hit_count: i64,
    pub reuse_count: i64,
    pub project_id: Option<Id>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TimeBucket {
    pub bucket_start: Timestamp,
    pub saved_tokens: i64,
    pub injected_tokens: i64,
    pub avoided_full_tokens: i64,
    pub operations: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TelemetrySummary {
    pub total_saved_tokens: i64,
    pub session_saved_tokens: i64,
    /// Saved by avoided reads (`read`).
    pub saved_from_reads: i64,
    /// Saved by cross-project reuse (`reuse`).
    pub saved_from_reuse: i64,
    pub total_injected_tokens: i64,
    pub total_avoided_tokens: i64,
    /// `1 - injected / avoided` in `0.0..=1.0` (0 when nothing avoided).
    pub compression_ratio: f64,
    pub by_client: Vec<ClientStats>,
    pub top_nodes: Vec<NodeValue>,
    /// Daily buckets.
    pub timeline: Vec<TimeBucket>,
}

// ------------------------------------------------------------------ usage stats (v1.10.0)

/// `get_usage_stats` input. Days/hours are the user's local time: `utc_offset_minutes` is the
/// offset to ADD to UTC (JS: `-new Date().getTimezoneOffset()`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct UsageStatsRequest {
    pub year: i32,
    pub utc_offset_minutes: i32,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct UsageTotals {
    /// AI requests (every MCP/REST tool call: read, write, update, reuse, handoff, blocked).
    pub requests: u64,
    pub saved_tokens: i64,
    pub memories_created: u64,
}

/// One local calendar day with activity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UsageDay {
    /// `YYYY-MM-DD` (local).
    pub date: String,
    pub requests: u64,
    pub saved_tokens: i64,
    pub memories_created: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClientUsageStats {
    pub client_name: String,
    pub requests: u64,
    pub saved_tokens: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OperationUsage {
    pub operation: TelemetryOperation,
    pub requests: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectUsage {
    pub project_id: Id,
    pub name: String,
    pub requests: u64,
}

/// Personal usage dashboard (Estadísticas). Built from the permanent `usage_hourly` rollup
/// (never pruned, unlike detailed `telemetry_logs`) plus `memories.created_at`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UsageStats {
    pub year: i32,
    pub today: UsageTotals,
    /// Monday-based local week containing today.
    pub this_week: UsageTotals,
    pub this_year: UsageTotals,
    pub all_time: UsageTotals,
    /// Days of `year` with any activity, ascending (missing days = zero).
    pub days: Vec<UsageDay>,
    /// Year totals per AI client, most requests first.
    pub by_client: Vec<ClientUsageStats>,
    /// 24 local-hour buckets of requests in `year` (index = hour).
    pub by_hour: Vec<u64>,
    /// 7 buckets of requests in `year`, Monday = 0.
    pub by_weekday: Vec<u64>,
    pub by_operation: Vec<OperationUsage>,
    pub top_project: Option<ProjectUsage>,
    pub busiest_day: Option<UsageDay>,
    /// Consecutive local days with ≥ 1 request ending today (or yesterday).
    pub current_streak_days: u32,
    pub best_streak_days: u32,
    /// First local day with any recorded activity (`YYYY-MM-DD`).
    pub first_activity: Option<String>,
}

/// One node lit by a live MCP operation.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct MatchedNode {
    pub memory_id: Id,
    pub similarity_score: f64,
}

/// Payload of the Tauri event `cobalt://mcp-activity` (also re-emitted for 3D Replay).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct McpActivity {
    pub log_id: Id,
    pub timestamp: Timestamp,
    pub client_name: String,
    pub operation: TelemetryOperation,
    pub query_text: Option<String>,
    pub matched_nodes: Vec<MatchedNode>,
    pub injected_tokens: i64,
    pub avoided_full_tokens: i64,
    pub saved_tokens: i64,
    pub latency_ms: i64,
    /// `true` when re-emitted from the history "Replay in 3D" button.
    #[serde(default)]
    pub is_replay: bool,
}
