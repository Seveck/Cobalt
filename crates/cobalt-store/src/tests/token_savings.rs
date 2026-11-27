use chrono::TimeDelta;
use cobalt_core::enums::TelemetryOperation::{self, *};
use cobalt_core::ids::{Id, now, timestamp_to_sql};
use cobalt_core::telemetry::{NewTelemetryEvent, ReturnedItem, TelemetryLog};
use cobalt_core::traits::TelemetryRepository;
use rusqlite::Connection;

use super::*;

fn item(source_doc_id: Option<Id>, chunk_tokens: i64) -> ReturnedItem {
    ReturnedItem {
        memory_id: new_id(),
        source_doc_id,
        chunk_tokens,
        similarity_score: 0.9,
        content_snapshot: Some("Excerpt".into()),
    }
}

fn add_document(conn: &Connection, tokens: i64) -> Id {
    let id = new_id();
    conn.execute(
        "INSERT INTO source_documents (id, file_path, total_tokens, updated_at)
         VALUES (?1, ?1, ?2, '2026-11-25T00:00:00.000Z')",
        params![id.to_string(), tokens],
    )
    .unwrap();
    id
}

fn event(operation: TelemetryOperation, returned_items: Vec<ReturnedItem>) -> NewTelemetryEvent {
    NewTelemetryEvent {
        client_name: "codex".into(),
        operation,
        query_text: None,
        returned_items,
        injected_tokens: 100,
        output_tokens_saved: 600,
        latency_ms: 2,
        project_id: None,
    }
}

fn tokens(log: &TelemetryLog) -> (i64, i64) {
    (log.avoided_full_tokens, log.saved_tokens)
}

#[tokio::test]
async fn read_baseline_caps_documents_and_only_counts_each_client_once_per_window() {
    let dir = tempfile::tempdir().unwrap();
    let store = SqliteStore::open_at(dir.path().join("cobalt.db"))
        .await
        .unwrap();
    let doc = store
        .db
        .write(|conn| Ok(add_document(conn, 12_000)))
        .await
        .unwrap();
    let chunk = item(Some(doc), 70);
    let read = event(Read, vec![chunk.clone(), chunk, item(None, 40)]);
    assert_eq!(
        store
            .compute_avoided_tokens(&read.returned_items)
            .await
            .unwrap(),
        2040
    );

    // Same-client reads are serialized even when they are submitted concurrently.
    let (first, repeat) = tokio::join!(
        store.record_event(read.clone()),
        store.record_event(read.clone())
    );
    let mut token_pairs = [tokens(&first.unwrap()), tokens(&repeat.unwrap())];
    token_pairs.sort_unstable();
    assert_eq!(token_pairs, [(40, 0), (2040, 1940)]);
    let other = store
        .record_event(NewTelemetryEvent {
            client_name: "claude".into(),
            ..read.clone()
        })
        .await
        .unwrap();
    assert_eq!(tokens(&other), (2040, 1940));

    // Retention removes excerpts while preserving which documents were credited.
    let mut settings = store.load_settings().await.unwrap();
    settings.retention.detailed_log_limit = 0;
    store.save_settings(&settings).await.unwrap();
    store.apply_retention().await.unwrap();
    assert_eq!(
        tokens(&store.record_event(read.clone()).await.unwrap()),
        (40, 0)
    );

    store
        .db
        .write(|conn| {
            let past = timestamp_to_sql(&(now() - TimeDelta::seconds(READ_DEDUP_WINDOW_SECS)));
            conn.execute(
                "UPDATE telemetry_logs SET timestamp = ?1
             WHERE client_name = 'codex' AND avoided_full_tokens = 2040",
                [past],
            )
            .unwrap();
            Ok(())
        })
        .await
        .unwrap();
    let refreshed = store.record_event(read).await.unwrap();
    assert_eq!(tokens(&refreshed), (2040, 1940));
}

#[tokio::test]
async fn only_reads_and_reuse_earn_token_savings() {
    let dir = tempfile::tempdir().unwrap();
    let store = SqliteStore::open_at(dir.path().join("cobalt.db"))
        .await
        .unwrap();
    let doc = store
        .db
        .write(|conn| Ok(add_document(conn, 12_000)))
        .await
        .unwrap();
    let items = vec![item(Some(doc), 800)];
    for operation in [Write, Update, Handoff, BlockedFirewall] {
        let log = store
            .record_event(event(operation, items.clone()))
            .await
            .unwrap();
        assert_eq!(tokens(&log), (0, 0), "{operation:?}");
    }
    let reuse = event(Reuse, items.clone());
    let log = store.record_event(reuse.clone()).await.unwrap();
    assert_eq!(tokens(&log), (600, 500));
    let log = store
        .record_event(NewTelemetryEvent {
            injected_tokens: 700,
            ..reuse
        })
        .await
        .unwrap();
    assert_eq!(tokens(&log), (600, 0));
    assert_eq!(
        tokens(&store.record_event(event(Read, items)).await.unwrap()),
        (2000, 1900)
    );
}

fn totals(conn: &Connection) -> (i64, i64, i64, i64) {
    conn.query_row(
        "SELECT count(*), sum(injected_tokens), sum(avoided_full_tokens), sum(saved_tokens)
         FROM telemetry_logs",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )
    .unwrap()
}

fn request_buckets(conn: &Connection) -> Vec<(String, String, String, String, i64)> {
    conn.prepare(
        "SELECT hour_utc, client_name, operation, project_id, requests
                  FROM usage_hourly WHERE requests > 0 ORDER BY 1, 2, 3, 4",
    )
    .unwrap()
    .query_map([], |row| {
        Ok((
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
        ))
    })
    .unwrap()
    .collect::<rusqlite::Result<_>>()
    .unwrap()
}

#[tokio::test]
async fn v2_migration_reaccounts_a_copy_of_two_days_of_history() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = dir.path().join("fixture-v2.db");
    let copy = dir.path().join("migration-copy.db");
    let old = Connection::open(&fixture).unwrap();
    old.execute_batch(include_str!("../schema.sql")).unwrap();
    old.execute_batch(include_str!("../usage_hourly.sql"))
        .unwrap();
    old.pragma_update(None, "user_version", 2).unwrap();

    let large_doc = add_document(&old, 12_000);
    let small_doc = add_document(&old, 1_200);
    let large = [item(Some(large_doc), 500), item(Some(large_doc), 565)];
    let mixed = [
        large[0].clone(),
        large[1].clone(),
        item(Some(small_doc), 70),
        item(None, 12),
    ];
    let no_items = [];
    let rows = [
        (
            "26T09:00:00",
            "codex",
            Read,
            &large[..],
            1065,
            12_000,
            0,
            (2000, 935),
        ),
        (
            "25T09:30:00",
            "codex",
            Read,
            &large[..],
            1065,
            12_000,
            0,
            (2000, 935),
        ),
        (
            "25T09:05:00",
            "codex",
            Read,
            &large[..],
            1065,
            12_000,
            0,
            (0, 0),
        ),
        (
            "25T09:00:00",
            "codex",
            Read,
            &mixed[..],
            1065,
            13_212,
            0,
            (3212, 2147),
        ),
        (
            "25T09:05:00",
            "claude",
            Read,
            &large[..],
            1065,
            12_000,
            0,
            (2000, 935),
        ),
        (
            "25T09:05:00",
            "codex",
            Read,
            &mixed[..],
            1065,
            13_212,
            0,
            (12, 0),
        ),
        (
            "25T15:00:00",
            "codex",
            Write,
            &no_items[..],
            0,
            0,
            21_707,
            (0, 0),
        ),
        (
            "26T15:00:00",
            "git",
            Write,
            &no_items[..],
            0,
            0,
            7866,
            (0, 0),
        ),
        (
            "26T15:02:00",
            "codex",
            Update,
            &large[..],
            0,
            12_000,
            30,
            (0, 0),
        ),
        (
            "26T15:05:00",
            "codex",
            Handoff,
            &no_items[..],
            0,
            0,
            400,
            (0, 0),
        ),
        (
            "26T15:06:00",
            "codex",
            BlockedFirewall,
            &no_items[..],
            0,
            0,
            250,
            (0, 0),
        ),
        (
            "26T15:08:00",
            "claude",
            Reuse,
            &no_items[..],
            200,
            0,
            1800,
            (1800, 1600),
        ),
        (
            "26T15:10:00",
            "claude",
            Reuse,
            &large[..],
            600,
            12_000,
            500,
            (500, 0),
        ),
    ];
    let mut expected = Vec::new();
    for (time, client, operation, items, injected, avoided, output, accounted) in rows {
        let id = new_id();
        old.execute(
            "INSERT INTO telemetry_logs (id, timestamp, client_name, operation, returned_items_json,
                                         injected_tokens, avoided_full_tokens, saved_tokens)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id.to_string(), format!("2026-11-{time}.000Z"), client,
                operation.as_str(), serde_json::to_string(items).unwrap(), injected, avoided,
                (avoided - injected).max(0) + output],
        ).unwrap();
        expected.push((id, accounted));
    }
    let before = totals(&old);
    let requests = request_buckets(&old);
    drop(old);
    std::fs::copy(&fixture, &copy).unwrap();

    let store = SqliteStore::open_at(copy.clone()).await.unwrap();
    for (id, accounted) in expected {
        assert_eq!(
            tokens(&store.get_telemetry_log(id).await.unwrap().unwrap()),
            accounted
        );
    }
    drop(store);
    let migrated = Connection::open(copy).unwrap();
    let after = totals(&migrated);
    assert_eq!(before, (13, 7190, 98_424, 123_987));
    assert_eq!(after, (13, 7190, 11_524, 6552));
    let rolled_up: (i64, i64) = migrated
        .query_row(
            "SELECT sum(requests), sum(saved_tokens) FROM usage_hourly",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(request_buckets(&migrated), requests);
    assert_eq!(rolled_up, (after.0, after.3));
    println!("fixture (requests, injected, avoided, saved) before {before:?}, after {after:?}");
}

#[tokio::test]
async fn portable_import_reaccounts_legacy_reuse_with_the_manifest_schema() {
    for version in [1, 2] {
        let dir = tempfile::tempdir().unwrap();
        let store = SqliteStore::open_at(dir.path().join("cobalt.db"))
            .await
            .unwrap();
        let legacy = TelemetryLog {
            id: new_id(),
            timestamp: now(),
            client_name: "codex".into(),
            operation: Reuse,
            query_text: None,
            returned_items: vec![item(None, 1000)],
            injected_tokens: 100,
            avoided_full_tokens: 1000,
            saved_tokens: 1500,
            latency_ms: 2,
            project_id: None,
        };
        let write = TelemetryLog {
            id: new_id(),
            operation: Write,
            ..legacy.clone()
        };
        let without_output = TelemetryLog {
            id: new_id(),
            saved_tokens: 900,
            ..legacy.clone()
        };
        for _ in 0..2 {
            store
                .insert_portable_history_for_schema(
                    version,
                    vec![],
                    vec![],
                    vec![],
                    vec![legacy.clone(), write.clone(), without_output.clone()],
                )
                .await
                .unwrap();
        }
        assert_eq!(
            tokens(&store.get_telemetry_log(legacy.id).await.unwrap().unwrap()),
            (600, 500)
        );
        assert_eq!(
            tokens(&store.get_telemetry_log(write.id).await.unwrap().unwrap()),
            (0, 0)
        );
        let no_output = store
            .get_telemetry_log(without_output.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(tokens(&no_output), (0, 0));
        assert_eq!(
            store
                .query_telemetry(Default::default())
                .await
                .unwrap()
                .total,
            3
        );
    }
}
