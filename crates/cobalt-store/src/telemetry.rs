use std::collections::{BTreeMap, HashSet};

use async_trait::async_trait;
use chrono::TimeDelta;
use cobalt_core::enums::TelemetryOperation;
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::ids::{Id, Timestamp, new_id, now, timestamp_to_sql};
use cobalt_core::telemetry::{
    ClientStats, NewTelemetryEvent, NodeValue, Page, ReturnedItem, TelemetryLog, TelemetryQuery,
    TelemetryRange, TelemetrySummary, TimeBucket,
};
use cobalt_core::traits::TelemetryRepository;
use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::SqliteStore;
use crate::db::sql_error;
use crate::repositories::{id, json, load_settings, optional_id, stamp, text, timestamp};

pub(crate) fn avoided_tokens(
    conn: &Connection,
    items: impl IntoIterator<Item = (Option<Id>, i64)>,
) -> Result<i64> {
    let mut documents = HashSet::new();
    let mut total = 0_i64;
    let mut stmt = conn
        .prepare("SELECT total_tokens FROM source_documents WHERE id = ?1")
        .map_err(sql_error)?;
    for (source_id, chunk_tokens) in items {
        let tokens = match source_id {
            Some(id) if documents.insert(id) => stmt
                .query_row([id.to_string()], |row| row.get(0))
                .optional()
                .map_err(sql_error)?
                .unwrap_or(0),
            Some(_) => 0,
            None => chunk_tokens,
        };
        total = total.saturating_add(tokens.max(0));
    }
    Ok(total)
}

fn log(row: &Row<'_>) -> rusqlite::Result<TelemetryLog> {
    Ok(TelemetryLog {
        id: id(row, "id")?,
        timestamp: timestamp(row, "timestamp")?,
        client_name: row.get("client_name")?,
        operation: text(row, "operation")?,
        query_text: row.get("query_text")?,
        returned_items: json(row, "returned_items_json")?.unwrap_or_default(),
        injected_tokens: row.get("injected_tokens")?,
        avoided_full_tokens: row.get("avoided_full_tokens")?,
        saved_tokens: row.get("saved_tokens")?,
        latency_ms: row.get("latency_ms")?,
        project_id: optional_id(row, "project_id")?,
    })
}

pub(crate) fn insert_event(conn: &Connection, event: NewTelemetryEvent) -> Result<TelemetryLog> {
    if event.client_name.trim().is_empty()
        || [
            event.injected_tokens,
            event.output_tokens_saved,
            event.latency_ms,
        ]
        .into_iter()
        .any(|value| value < 0)
        || event
            .returned_items
            .iter()
            .any(|item| item.chunk_tokens < 0 || !(0.0..=1.0).contains(&item.similarity_score))
    {
        return Err(CobaltError::InvalidInput(
            "invalid telemetry event metrics or client".into(),
        ));
    }
    let avoided = avoided_tokens(
        conn,
        event
            .returned_items
            .iter()
            .map(|item| (item.source_doc_id, item.chunk_tokens)),
    )?;
    let saved = avoided
        .saturating_sub(event.injected_tokens)
        .max(0)
        .saturating_add(event.output_tokens_saved);
    conn.query_row(
        "INSERT INTO telemetry_logs (id, timestamp, client_name, operation, query_text,
          returned_items_json, injected_tokens, avoided_full_tokens, saved_tokens, latency_ms, project_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) RETURNING *",
        params![new_id().to_string(), stamp(), event.client_name, event.operation.as_str(),
            event.query_text, serde_json::to_string(&event.returned_items)?, event.injected_tokens,
            avoided, saved, event.latency_ms, event.project_id.map(|id| id.to_string())],
        log,
    ).map_err(sql_error)
}

#[async_trait]
impl TelemetryRepository for SqliteStore {
    async fn record_event(&self, event: NewTelemetryEvent) -> Result<TelemetryLog> {
        self.db.write(move |conn| insert_event(conn, event)).await
    }

    async fn compute_avoided_tokens(&self, items: &[ReturnedItem]) -> Result<i64> {
        let items: Vec<_> = items
            .iter()
            .map(|item| (item.source_doc_id, item.chunk_tokens))
            .collect();
        self.db.read(move |conn| avoided_tokens(conn, items)).await
    }

    async fn query_telemetry(&self, query: TelemetryQuery) -> Result<Page<TelemetryLog>> {
        self.db
            .read(move |conn| {
                const FILTER: &str = "FROM telemetry_logs WHERE
                (?1 IS NULL OR client_name = ?1) AND (?2 IS NULL OR project_id = ?2)
                AND (?3 IS NULL OR timestamp >= ?3) AND (?4 IS NULL OR timestamp <= ?4)
                AND (?5 IS NULL OR instr(lower(query_text), lower(?5)) > 0)
                AND (?6 IS NULL OR operation IN (SELECT value FROM json_each(?6)))";
                let tx = conn.unchecked_transaction().map_err(sql_error)?;
                let project = query.project_id.map(|id| id.to_string());
                let from = query.from.as_ref().map(timestamp_to_sql);
                let to = query.to.as_ref().map(timestamp_to_sql);
                let operations = (!query.operations.is_empty())
                    .then(|| serde_json::to_string(&query.operations))
                    .transpose()?;
                let args = params![query.client_name, project, from, to, query.text, operations];
                let total: i64 = tx
                    .query_row(&format!("SELECT count(*) {FILTER}"), args, |row| row.get(0))
                    .map_err(sql_error)?;
                let mut stmt = tx
                    .prepare(&format!(
                        "SELECT * {FILTER} ORDER BY timestamp DESC, id DESC LIMIT ?7 OFFSET ?8"
                    ))
                    .map_err(sql_error)?;
                let items = stmt
                    .query_map(
                        params![
                            query.client_name,
                            project,
                            from,
                            to,
                            query.text,
                            operations,
                            query.limit.map_or(100, i64::from),
                            query.offset.unwrap_or(0)
                        ],
                        log,
                    )
                    .map_err(sql_error)?
                    .collect::<rusqlite::Result<_>>()
                    .map_err(sql_error)?;
                Ok(Page {
                    items,
                    total: total as u64,
                })
            })
            .await
    }

    async fn get_telemetry_log(&self, id: Id) -> Result<Option<TelemetryLog>> {
        self.db
            .read(move |conn| {
                conn.query_row(
                    "SELECT * FROM telemetry_logs WHERE id = ?1",
                    [id.to_string()],
                    log,
                )
                .optional()
                .map_err(sql_error)
            })
            .await
    }

    async fn telemetry_summary(&self, range: TelemetryRange) -> Result<TelemetrySummary> {
        let start = self.started_at;
        self.db.read(move |conn| summary(conn, range, start)).await
    }

    async fn apply_retention(&self) -> Result<u64> {
        self.db
            .write(|conn| {
                let retention = load_settings(conn)?.retention;
                let cutoff = now()
                    .checked_sub_signed(TimeDelta::days(i64::from(retention.detailed_log_days)));
                let changed = conn
                    .execute(
                        "WITH ranked AS (
                    SELECT id, row_number() OVER (ORDER BY timestamp DESC, id DESC) AS position
                    FROM telemetry_logs
                 )
                 UPDATE telemetry_logs SET query_text = NULL,
                    returned_items_json = CASE WHEN returned_items_json IS NOT NULL THEN
                        (SELECT json_group_array(json_set(value, '$.content_snapshot', NULL))
                         FROM json_each(returned_items_json)) END
                 WHERE (timestamp <= ?1 OR id IN (SELECT id FROM ranked WHERE position > ?2))
                   AND (query_text IS NOT NULL OR EXISTS (
                      SELECT 1 FROM json_each(returned_items_json)
                      WHERE json_extract(value, '$.content_snapshot') IS NOT NULL
                   ))",
                        params![
                            cutoff.as_ref().map(timestamp_to_sql),
                            retention.detailed_log_limit
                        ],
                    )
                    .map_err(sql_error)?;
                Ok(changed as u64)
            })
            .await
    }
}

fn summary(conn: &Connection, range: TelemetryRange, start: Timestamp) -> Result<TelemetrySummary> {
    let tx = conn.unchecked_transaction().map_err(sql_error)?;
    let from = if range.session_only {
        Some(range.from.map_or(start, |from| from.max(start)))
    } else {
        range.from
    };
    let mut stmt = tx.prepare(
        "SELECT timestamp, client_name, operation, saved_tokens, injected_tokens, avoided_full_tokens
         FROM telemetry_logs WHERE (?1 IS NULL OR timestamp >= ?1) AND (?2 IS NULL OR timestamp <= ?2)"
    ).map_err(sql_error)?;
    let mut stats = TelemetrySummary {
        total_saved_tokens: 0,
        session_saved_tokens: 0,
        saved_from_reads: 0,
        saved_from_reuse: 0,
        total_injected_tokens: 0,
        total_avoided_tokens: 0,
        compression_ratio: 0.0,
        by_client: Vec::new(),
        top_nodes: Vec::new(),
        timeline: Vec::new(),
    };
    let mut clients = BTreeMap::new();
    let mut buckets = BTreeMap::new();
    let start = timestamp_to_sql(&start);
    let mut rows = stmt
        .query(params![
            from.as_ref().map(timestamp_to_sql),
            range.to.as_ref().map(timestamp_to_sql)
        ])
        .map_err(sql_error)?;
    while let Some(row) = rows.next().map_err(sql_error)? {
        let time = timestamp(row, "timestamp").map_err(sql_error)?;
        let name: String = row.get("client_name").map_err(sql_error)?;
        let operation = text::<TelemetryOperation>(row, "operation").map_err(sql_error)?;
        let saved: i64 = row.get("saved_tokens").map_err(sql_error)?;
        let injected: i64 = row.get("injected_tokens").map_err(sql_error)?;
        let avoided: i64 = row.get("avoided_full_tokens").map_err(sql_error)?;
        stats.total_saved_tokens = stats.total_saved_tokens.saturating_add(saved);
        stats.total_injected_tokens = stats.total_injected_tokens.saturating_add(injected);
        stats.total_avoided_tokens = stats.total_avoided_tokens.saturating_add(avoided);
        if timestamp_to_sql(&time) >= start {
            stats.session_saved_tokens = stats.session_saved_tokens.saturating_add(saved);
        }
        let client = clients.entry(name.clone()).or_insert(ClientStats {
            client_name: name,
            reads: 0,
            writes: 0,
            updates: 0,
            reuses: 0,
            handoffs: 0,
            blocked: 0,
            saved_tokens: 0,
        });
        client.saved_tokens = client.saved_tokens.saturating_add(saved);
        match operation {
            TelemetryOperation::Read => {
                client.reads += 1;
                stats.saved_from_reads = stats.saved_from_reads.saturating_add(saved);
            }
            TelemetryOperation::Reuse => {
                client.reuses += 1;
                stats.saved_from_reuse = stats.saved_from_reuse.saturating_add(saved);
            }
            TelemetryOperation::Write => client.writes += 1,
            TelemetryOperation::Update => client.updates += 1,
            TelemetryOperation::Handoff => client.handoffs += 1,
            TelemetryOperation::BlockedFirewall => client.blocked += 1,
        }
        let day = time
            .date_naive()
            .and_hms_opt(0, 0, 0)
            .ok_or_else(|| CobaltError::Integrity("invalid telemetry date".into()))?
            .and_utc();
        let bucket = buckets.entry(day).or_insert(TimeBucket {
            bucket_start: day,
            saved_tokens: 0,
            injected_tokens: 0,
            avoided_full_tokens: 0,
            operations: 0,
        });
        bucket.saved_tokens = bucket.saved_tokens.saturating_add(saved);
        bucket.injected_tokens = bucket.injected_tokens.saturating_add(injected);
        bucket.avoided_full_tokens = bucket.avoided_full_tokens.saturating_add(avoided);
        bucket.operations += 1;
    }
    if stats.total_avoided_tokens > 0 {
        stats.compression_ratio = (1.0
            - stats.total_injected_tokens as f64 / stats.total_avoided_tokens as f64)
            .clamp(0.0, 1.0);
    }
    stats.by_client = clients.into_values().collect();
    stats.by_client.sort_by(|a, b| {
        b.saved_tokens
            .cmp(&a.saved_tokens)
            .then(a.client_name.cmp(&b.client_name))
    });
    stats.timeline = buckets.into_values().collect();
    let mut nodes = tx
        .prepare(
            "SELECT id, substr(content, 1, 160) AS preview, hit_count, reuse_count, project_id
         FROM memories WHERE is_encrypted = 0 AND (hit_count > 0 OR reuse_count > 0)
         ORDER BY hit_count + reuse_count DESC, hit_count DESC, id LIMIT 20",
        )
        .map_err(sql_error)?;
    stats.top_nodes = nodes
        .query_map([], |row| {
            Ok(NodeValue {
                memory_id: id(row, "id")?,
                preview: row.get("preview")?,
                hit_count: row.get("hit_count")?,
                reuse_count: row.get("reuse_count")?,
                project_id: optional_id(row, "project_id")?,
            })
        })
        .map_err(sql_error)?
        .collect::<rusqlite::Result<_>>()
        .map_err(sql_error)?;
    Ok(stats)
}
