use chrono::{Datelike, NaiveDate, TimeDelta};
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::ids::Timestamp;
use cobalt_core::telemetry::{
    ClientUsageStats, OperationUsage, ProjectUsage, UsageDay, UsageStats, UsageStatsRequest,
    UsageTotals,
};
use rusqlite::{Connection, OptionalExtension, params};

use crate::db::sql_error;
use crate::repositories::{id, text};

pub(crate) fn read(
    conn: &Connection,
    req: UsageStatsRequest,
    now: Timestamp,
) -> Result<UsageStats> {
    let today = (now + TimeDelta::minutes(i64::from(req.utc_offset_minutes))).date_naive();
    let week_start = today - TimeDelta::days(i64::from(today.weekday().num_days_from_monday()));
    // A UTC hour starts at minute 0, so shift by whole hours rounded toward negative infinity.
    let hour_shift = req.utc_offset_minutes.div_euclid(60);
    let tx = conn.unchecked_transaction().map_err(sql_error)?;
    let (start, end) = year_bounds(&tx, req.year, hour_shift)?;
    let mut stats = UsageStats {
        year: req.year,
        today: UsageTotals::default(),
        this_week: UsageTotals::default(),
        this_year: UsageTotals::default(),
        all_time: UsageTotals::default(),
        days: Vec::new(),
        by_client: Vec::new(),
        by_hour: vec![0; 24],
        by_weekday: vec![0; 7],
        by_operation: Vec::new(),
        top_project: None,
        busiest_day: None,
        current_streak_days: 0,
        best_streak_days: 0,
        first_activity: None,
    };
    let mut stmt = tx
        .prepare(
            "WITH hourly AS MATERIALIZED (
                SELECT hour_utc, sum(requests) AS requests, sum(saved_tokens) AS saved_tokens
                FROM usage_hourly INDEXED BY idx_usage_hour_totals GROUP BY hour_utc
             ), activity AS (
                SELECT date(hour_utc || ':00', ?1) AS day, requests, saved_tokens,
                       0 AS memories_created
                FROM hourly
                UNION ALL
                SELECT date(created_at, ?2) AS day, 0, 0, count(*)
                FROM memories GROUP BY day
             )
             SELECT day, sum(requests), sum(saved_tokens), sum(memories_created), NULL AS hour
             FROM activity GROUP BY day
             HAVING sum(requests) > 0 OR sum(saved_tokens) <> 0 OR sum(memories_created) > 0
             UNION ALL
             SELECT NULL, sum(requests), 0, 0,
                    (CAST(substr(hour_utc, 12, 2) AS INTEGER) + ?5) % 24 AS hour
             FROM hourly WHERE hour_utc BETWEEN ?3 AND ?4 GROUP BY hour
             ORDER BY day",
        )
        .map_err(sql_error)?;
    let mut rows = stmt
        .query(params![
            format!("{hour_shift} hours"),
            format!("{} minutes", req.utc_offset_minutes),
            start,
            end,
            hour_shift.rem_euclid(24),
        ])
        .map_err(sql_error)?;
    let mut previous = None;
    let mut streak = 0;
    let yesterday = today.pred_opt();
    let week = week_start..week_start + TimeDelta::days(7);
    while let Some(row) = rows.next().map_err(sql_error)? {
        let requests = row.get::<_, i64>(1).map_err(sql_error)? as u64;
        if let Some(hour) = row.get::<_, Option<u8>>(4).map_err(sql_error)? {
            stats.by_hour[usize::from(hour)] = requests;
            continue;
        }
        let day = UsageDay {
            date: row.get(0).map_err(sql_error)?,
            requests,
            saved_tokens: row.get(2).map_err(sql_error)?,
            memories_created: row.get::<_, i64>(3).map_err(sql_error)? as u64,
        };
        let date = day
            .date
            .parse::<NaiveDate>()
            .map_err(|err| CobaltError::Integrity(format!("invalid usage day: {err}")))?;
        stats.first_activity.get_or_insert_with(|| day.date.clone());
        add_day(&mut stats.all_time, &day);
        if date.year() == today.year() {
            add_day(&mut stats.this_year, &day);
        }
        if week.contains(&date) {
            add_day(&mut stats.this_week, &day);
        }
        if date == today {
            add_day(&mut stats.today, &day);
        }
        if day.requests > 0 {
            streak = if date.pred_opt() == previous {
                streak + 1
            } else {
                1
            };
            previous = Some(date);
            stats.best_streak_days = stats.best_streak_days.max(streak);
            if date == today || Some(date) == yesterday {
                stats.current_streak_days = streak;
            }
        }
        if date.year() == req.year {
            stats.by_weekday[date.weekday().num_days_from_monday() as usize] += day.requests;
            if stats
                .busiest_day
                .as_ref()
                .is_none_or(|busiest| day.requests > busiest.requests)
            {
                stats.busiest_day = Some(day.clone());
            }
            stats.days.push(day);
        }
    }

    read_year_breakdowns(&tx, start, end, &mut stats)?;
    Ok(stats)
}

fn add_day(total: &mut UsageTotals, day: &UsageDay) {
    total.requests += day.requests;
    total.saved_tokens = total.saved_tokens.saturating_add(day.saved_tokens);
    total.memories_created += day.memories_created;
}

fn year_bounds(
    conn: &Connection,
    year: i32,
    hour_shift: i32,
) -> Result<(Option<String>, Option<String>)> {
    // Convert the local year to UTC once so the range uses the primary key's hour prefix.
    let modifier = format!("{} hours", -hour_shift);
    conn.query_row(
        "SELECT strftime('%Y-%m-%dT%H', ?1, ?3), strftime('%Y-%m-%dT%H', ?2, ?3)",
        params![
            format!("{year:04}-01-01T00:00"),
            format!("{year:04}-12-31T23:00"),
            modifier
        ],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .map_err(sql_error)
}

fn read_year_breakdowns(
    conn: &Connection,
    start: Option<String>,
    end: Option<String>,
    stats: &mut UsageStats,
) -> Result<()> {
    let bounds = params![start, end];
    let mut stmt = conn
        .prepare(
            "WITH breakdown AS MATERIALIZED (
                SELECT client_name, operation, sum(requests) AS requests,
                       sum(saved_tokens) AS saved_tokens
                FROM usage_hourly INDEXED BY idx_usage_client_operation
                WHERE hour_utc BETWEEN ?1 AND ?2 GROUP BY client_name, operation
             )
             SELECT client_name, NULL AS operation, sum(requests) AS requests, sum(saved_tokens)
             FROM breakdown GROUP BY client_name
             UNION ALL
             SELECT NULL, operation, sum(requests) AS requests, 0
             FROM breakdown GROUP BY operation
             ORDER BY requests DESC, client_name, operation",
        )
        .map_err(sql_error)?;
    let mut rows = stmt.query(bounds).map_err(sql_error)?;
    while let Some(row) = rows.next().map_err(sql_error)? {
        let requests = row.get::<_, i64>("requests").map_err(sql_error)? as u64;
        if let Some(client_name) = row.get(0).map_err(sql_error)? {
            stats.by_client.push(ClientUsageStats {
                client_name,
                requests,
                saved_tokens: row.get(3).map_err(sql_error)?,
            });
        } else {
            stats.by_operation.push(OperationUsage {
                operation: text(row, "operation").map_err(sql_error)?,
                requests,
            });
        }
    }
    stats.top_project = conn
        .query_row(
            "WITH totals AS MATERIALIZED (
                SELECT p.id, p.name, (
                    SELECT sum(requests) FROM usage_hourly
                    WHERE project_id = p.id AND project_id <> '' AND hour_utc BETWEEN ?1 AND ?2
                ) AS requests
                FROM projects p
             )
             SELECT id, name, requests FROM totals WHERE requests > 0
             ORDER BY requests DESC, id LIMIT 1",
            bounds,
            |row| {
                Ok(ProjectUsage {
                    project_id: id(row, "id")?,
                    name: row.get(1)?,
                    requests: row.get::<_, i64>(2)? as u64,
                })
            },
        )
        .optional()
        .map_err(sql_error)?;
    Ok(())
}
