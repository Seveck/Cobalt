use chrono::Datelike;
use cobalt_core::enums::TelemetryOperation;
use cobalt_core::ids::{now, timestamp_from_sql};
use cobalt_core::telemetry::{NewTelemetryEvent, UsageStats, UsageStatsRequest, UsageTotals};
use cobalt_core::traits::{SnapshotRepository, TelemetryRepository};
use rusqlite::Connection;

use super::*;

fn event() -> NewTelemetryEvent {
    NewTelemetryEvent {
        client_name: "test client".into(),
        operation: TelemetryOperation::Read,
        query_text: None,
        returned_items: Vec::new(),
        injected_tokens: 0,
        output_tokens_saved: 5,
        latency_ms: 0,
        project_id: None,
    }
}

async fn stats(store: &SqliteStore, year: i32, offset: i32, now: &'static str) -> UsageStats {
    store
        .db
        .read(move |conn| {
            crate::usage_stats::read(
                conn,
                UsageStatsRequest {
                    year,
                    utc_offset_minutes: offset,
                },
                timestamp_from_sql(now)?,
            )
        })
        .await
        .unwrap()
}

#[tokio::test]
async fn time_buckets_and_periods_follow_local_calendar() {
    let dir = tempfile::tempdir().unwrap();
    let store = SqliteStore::open_at(dir.path().join("cobalt.db"))
        .await
        .unwrap();
    store
        .db
        .write(|conn| {
            conn.execute_batch(
                "INSERT INTO usage_hourly VALUES
                 ('2023-12-31T18', 'writer', 'write', '', 2, 20),
                 ('2023-12-31T19', 'reader', 'read', '', 3, 30),
                 ('2024-01-01T00', 'reader', 'read', '', 5, 50),
                 ('2024-01-01T05', 'writer', 'write', '', 7, 70);
             INSERT INTO memories (id, branch_id, content, content_hash, category, chunk_tokens,
                                   created_at, updated_at)
             SELECT 'memory-' || rowid, id, 'note', 'hash', 'note', 1,
                    '2023-12-31T18:30:00.000Z', '2024-01-02T00:00:00.000Z'
             FROM branches;",
            )
            .unwrap();
            Ok(())
        })
        .await
        .unwrap();

    for (offset, requests, memories, hours, prior_requests) in [
        (-300, 7, 0, vec![(0, 7)], 10),
        (0, 12, 0, vec![(0, 5), (5, 7)], 5),
        (330, 15, 1, vec![(0, 3), (5, 5), (10, 7)], 2),
        (-330, 0, 0, vec![], 17),
    ] {
        let instant = "2024-01-01T12:00:00.000Z";
        let result = stats(&store, 2024, offset, instant).await;
        let expected = UsageTotals {
            requests,
            saved_tokens: (requests * 10) as i64,
            memories_created: memories,
        };
        assert_eq!(result.today, expected, "offset {offset}");
        assert_eq!(result.this_week, expected, "Monday at offset {offset}");
        assert_eq!(result.this_year, expected, "offset {offset}");
        assert_eq!(result.by_weekday, [requests, 0, 0, 0, 0, 0, 0]);
        let mut expected_hours = vec![0; 24];
        for (hour, requests) in hours {
            expected_hours[hour] = requests;
        }
        assert_eq!(result.by_hour, expected_hours, "offset {offset}");
        assert_eq!(result.days.len(), usize::from(requests > 0));
        if let Some(day) = result.days.first() {
            assert_eq!(day.date, "2024-01-01");
            assert_eq!(day.memories_created, memories);
            assert_eq!(result.busiest_day.as_ref(), Some(day));
        }
        assert_eq!(result.all_time.requests, 17);
        assert_eq!(result.all_time.memories_created, 1);
        assert_eq!(result.first_activity.as_deref(), Some("2023-12-31"));

        let prior = stats(&store, 2023, offset, instant).await;
        assert_eq!(prior.this_year, expected);
        assert_eq!(prior.days[0].date, "2023-12-31");
        assert_eq!(prior.days[0].memories_created, 1 - memories);
        assert_eq!(prior.by_weekday, [0, 0, 0, 0, 0, 0, prior_requests]);
        assert_eq!(prior.by_hour.iter().sum::<u64>(), prior_requests);
    }

    let result = stats(&store, 2024, 330, "2024-01-01T06:00:00.000Z").await;
    assert_eq!(
        result
            .by_client
            .iter()
            .map(|row| (&*row.client_name, row.requests, row.saved_tokens))
            .collect::<Vec<_>>(),
        [("reader", 8, 80), ("writer", 7, 70)]
    );
    assert_eq!(
        result
            .by_operation
            .iter()
            .map(|row| (row.operation, row.requests))
            .collect::<Vec<_>>(),
        [
            (TelemetryOperation::Read, 8),
            (TelemetryOperation::Write, 7)
        ]
    );
}

#[tokio::test]
async fn streaks_span_years_and_ignore_memory_only_days() {
    let dir = tempfile::tempdir().unwrap();
    let store = SqliteStore::open_at(dir.path().join("cobalt.db"))
        .await
        .unwrap();
    store
        .db
        .write(|conn| {
            conn.execute_batch(
                "INSERT INTO usage_hourly VALUES
                 ('2023-12-30T04', 'reader', 'read', '', 1, 1),
                 ('2023-12-31T04', 'reader', 'read', '', 1, 1),
                 ('2024-01-01T04', 'reader', 'read', '', 1, 1),
                 ('2024-01-04T04', 'reader', 'read', '', 1, 1),
                 ('2024-01-05T04', 'reader', 'read', '', 2, 10);
             INSERT INTO memories (id, branch_id, content, content_hash, category, chunk_tokens,
                                   created_at, updated_at)
             SELECT 'memory-' || rowid, id, 'note', 'hash', 'note', 1,
                    '2023-12-28T20:00:00.000Z', '2024-01-02T00:00:00.000Z'
             FROM branches
             UNION ALL
             SELECT 'other-memory-' || rowid, id, 'other note', 'other hash', 'note', 1,
                    '2024-01-06T20:00:00.000Z', '2024-01-06T20:00:00.000Z'
             FROM branches;",
            )
            .unwrap();
            Ok(())
        })
        .await
        .unwrap();

    for (instant, current_streak) in [
        ("2024-01-05T23:00:00.000Z", 2),
        ("2024-01-06T23:00:00.000Z", 2),
        ("2024-01-07T23:00:00.000Z", 0),
    ] {
        let result = stats(&store, 2024, 0, instant).await;
        assert_eq!(result.current_streak_days, current_streak);
        assert_eq!(result.best_streak_days, 3);
        assert_eq!(result.first_activity.as_deref(), Some("2023-12-28"));
        assert_eq!(result.busiest_day.unwrap().date, "2024-01-05");
        assert_eq!(
            result
                .days
                .iter()
                .map(|day| day.date.as_str())
                .collect::<Vec<_>>(),
            ["2024-01-01", "2024-01-04", "2024-01-05", "2024-01-06"]
        );
        assert_eq!(result.days[3].requests, 0);
        assert_eq!(result.days[3].memories_created, 1);
    }
}

#[tokio::test]
async fn v1_backfill_is_idempotent_and_keeps_deleted_project_totals() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cobalt.db");
    let project = new_id();
    let deleted = new_id();
    let old = Connection::open(&path).unwrap();
    old.execute_batch(include_str!("../schema.sql")).unwrap();
    old.pragma_update(None, "user_version", 1).unwrap();
    for (id, name) in [(project, "Surviving project"), (deleted, "Deleted project")] {
        old.execute(
            "INSERT INTO projects (id, name, color_hex, created_at, updated_at)
             VALUES (?1, ?2, '#123ABC', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')",
            params![id.to_string(), name],
        )
        .unwrap();
    }
    for (time, project, saved) in [
        ("2024-11-01T23:00:00.000Z", None, 3),
        ("2024-11-01T23:59:59.999Z", None, 4),
        ("2024-11-01T23:01:00.000Z", Some(project), 5),
        ("2024-11-01T23:02:00.000Z", Some(deleted), 7),
        ("2024-11-02T00:00:00.000Z", Some(deleted), 8),
    ] {
        old.execute(
            "INSERT INTO telemetry_logs (id, timestamp, client_name, operation, project_id, saved_tokens)
             VALUES (?1, ?2, 'reader', 'read', ?3, ?4)",
            params![new_id().to_string(), time, project.map(|id| id.to_string()), saved],
        ).unwrap();
    }
    drop(old);
    let store = SqliteStore::open_at(path.clone()).await.unwrap();
    store
        .db
        .read(|conn| {
            let global: (String, i64, i64) = conn.query_row(
                "SELECT hour_utc, requests, saved_tokens FROM usage_hourly WHERE project_id = ''",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            ).unwrap();
            assert_eq!(global, ("2024-11-01T23".into(), 2, 7));
            Ok(())
        })
        .await
        .unwrap();
    let result = stats(&store, 2024, 0, "2024-11-02T01:00:00.000Z").await;
    assert_eq!(result.top_project.unwrap().project_id, deleted);

    store
        .db
        .write(move |conn| {
            conn.execute("DELETE FROM projects WHERE id = ?1", [deleted.to_string()])
                .unwrap();
            Ok(())
        })
        .await
        .unwrap();
    drop(store);

    let reopened = SqliteStore::open_at(path).await.unwrap();
    let result = stats(&reopened, 2024, 0, "2024-11-02T01:00:00.000Z").await;
    assert_eq!(
        (result.all_time.requests, result.all_time.saved_tokens),
        (5, 27)
    );
    let top = result.top_project.unwrap();
    assert_eq!(
        (top.project_id, top.name.as_str(), top.requests),
        (project, "Surviving project", 1)
    );
}

#[tokio::test]
async fn record_event_updates_rollup_and_rolls_back_when_it_fails() {
    let dir = tempfile::tempdir().unwrap();
    let store = SqliteStore::open_at(dir.path().join("cobalt.db"))
        .await
        .unwrap();
    let first = store.record_event(event()).await.unwrap();
    store.record_event(event()).await.unwrap();

    store
        .db
        .write(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER reject_rollup BEFORE INSERT ON usage_hourly
             BEGIN SELECT raise(ABORT, 'rollup failure'); END;",
            )
            .unwrap();
            Ok(())
        })
        .await
        .unwrap();
    assert!(store.record_event(event()).await.is_err());

    let result = store
        .usage_stats(UsageStatsRequest {
            year: first.timestamp.year(),
            utc_offset_minutes: 0,
        })
        .await
        .unwrap();
    assert_eq!(result.all_time.requests, 2);
    assert_eq!(result.all_time.saved_tokens, 10);
    assert_eq!(
        store
            .query_telemetry(Default::default())
            .await
            .unwrap()
            .total,
        2
    );
}

#[tokio::test]
async fn importing_portable_telemetry_counts_each_log_once() {
    let source_dir = tempfile::tempdir().unwrap();
    let source = SqliteStore::open_at(source_dir.path().join("cobalt.db"))
        .await
        .unwrap();
    let log = source.record_event(event()).await.unwrap();
    let target_dir = tempfile::tempdir().unwrap();
    let target = SqliteStore::open_at(target_dir.path().join("cobalt.db"))
        .await
        .unwrap();
    for _ in 0..2 {
        target
            .insert_portable_history(vec![], vec![], vec![], vec![log.clone()])
            .await
            .unwrap();
    }
    let result = target
        .usage_stats(UsageStatsRequest {
            year: log.timestamp.year(),
            utc_offset_minutes: 0,
        })
        .await
        .unwrap();
    assert_eq!(
        (result.all_time.requests, result.all_time.saved_tokens),
        (1, 5)
    );
}

#[tokio::test]
async fn restore_migrates_legacy_snapshot_before_installing_it() {
    let dir = tempfile::tempdir().unwrap();
    let store = SqliteStore::open_at(dir.path().join("cobalt.db"))
        .await
        .unwrap();
    let log = store.record_event(event()).await.unwrap();
    let snapshot = store.create_snapshot("legacy").await.unwrap();
    let legacy = Connection::open(&snapshot.file_path).unwrap();
    legacy
        .execute_batch(
            "DROP TRIGGER telemetry_usage_hourly;
             DROP TABLE usage_hourly;
             DROP INDEX idx_memories_created_at;
             PRAGMA user_version = 1;",
        )
        .unwrap();
    drop(legacy);

    store.record_event(event()).await.unwrap();
    store.restore_snapshot(snapshot.id).await.unwrap();
    let req = UsageStatsRequest {
        year: log.timestamp.year(),
        utc_offset_minutes: 0,
    };
    assert_eq!(store.usage_stats(req).await.unwrap().all_time.requests, 1);
    store.record_event(event()).await.unwrap();
    assert_eq!(store.usage_stats(req).await.unwrap().all_time.requests, 2);
}

#[tokio::test]
async fn empty_brain_returns_zero_totals_and_buckets() {
    let dir = tempfile::tempdir().unwrap();
    let store = SqliteStore::open_at(dir.path().join("cobalt.db"))
        .await
        .unwrap();
    let req = UsageStatsRequest {
        year: now().year(),
        utc_offset_minutes: 330,
    };
    let result = store.usage_stats(req).await.unwrap();
    assert_eq!(
        result,
        UsageStats {
            year: req.year,
            today: UsageTotals::default(),
            this_week: UsageTotals::default(),
            this_year: UsageTotals::default(),
            all_time: UsageTotals::default(),
            days: vec![],
            by_client: vec![],
            by_hour: vec![0; 24],
            by_weekday: vec![0; 7],
            by_operation: vec![],
            top_project: None,
            busiest_day: None,
            current_streak_days: 0,
            best_streak_days: 0,
            first_activity: None,
        }
    );
}

#[tokio::test]
#[ignore = "timing depends on the build profile and host"]
async fn usage_stats_year_timing() {
    for clients in [1, 3] {
        measure_year(clients).await;
    }
}

async fn measure_year(client_count: u64) {
    let dir = tempfile::tempdir().unwrap();
    let store = SqliteStore::open_at(dir.path().join("cobalt.db"))
        .await
        .unwrap();
    store
        .db
        .write(move |conn| {
            conn.execute(
                "WITH RECURSIVE hours(n) AS (
                 VALUES (0) UNION ALL SELECT n + 1 FROM hours WHERE n < 8783
             ), clients(n, name) AS (VALUES (1, 'client-a'), (2, 'client-b'), (3, 'client-c'))
             INSERT INTO usage_hourly
             SELECT strftime('%Y-%m-%dT%H', '2024-01-01', '+' || hours.n || ' hours'),
                    name, CASE hours.n % 3 WHEN 0 THEN 'read' WHEN 1 THEN 'write' ELSE 'update' END,
                    '', 20, 300
             FROM hours CROSS JOIN clients WHERE clients.n <= ?1",
                [client_count as i64],
            )
            .unwrap();
            Ok(())
        })
        .await
        .unwrap();
    let req = UsageStatsRequest {
        year: 2024,
        utc_offset_minutes: 0,
    };
    let rows = 8784 * client_count;
    let mut durations = Vec::new();
    for _ in 0..10 {
        let start = std::time::Instant::now();
        let result = store.usage_stats(req).await.unwrap();
        durations.push(start.elapsed());
        assert_eq!(result.all_time.requests, rows * 20);
        assert_eq!(result.days.len(), 366);
    }
    durations.sort_unstable();
    eprintln!(
        "Year of usage stats ({rows} hourly rows), median: {:?}",
        durations[5]
    );
}
