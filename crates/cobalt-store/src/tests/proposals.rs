use chrono::TimeDelta;
use cobalt_core::enums::{ProposalKind, ProposalStatus, TelemetryOperation};
use cobalt_core::ids::{Id, now, timestamp_to_sql};
use cobalt_core::model::{MemoryProposal, NewMemoryProposal};
use cobalt_core::telemetry::NewTelemetryEvent;
use cobalt_core::traits::{HandoffRepository, SnapshotRepository, TelemetryRepository};
use rusqlite::Connection;

use crate::db::sql_error;

use super::*;

fn new_proposal(content: &str, project_id: Option<Id>) -> NewMemoryProposal {
    NewMemoryProposal {
        project_id,
        client_name: "codex".into(),
        kind: ProposalKind::Decision,
        content: content.into(),
        evidence: Some("Discussed during review".into()),
    }
}

async fn add(store: &SqliteStore, content: &str, project_id: Option<Id>) -> MemoryProposal {
    store
        .add_proposal(new_proposal(content, project_id))
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn proposals_deduplicate_by_normalized_content_and_project_in_every_status() {
    let dir = tempfile::tempdir().unwrap();
    let store = SqliteStore::open_at(dir.path().join("cobalt.db"))
        .await
        .unwrap();
    let project = store
        .create_project(NewProject {
            name: "Example".into(),
            root_path: None,
            color_hex: None,
        })
        .await
        .unwrap();

    for scope in [None, Some(project.id)] {
        let original = "  «REVISIÓN:\tconservar\u{2003}adjuntos»  ";
        let first = add(&store, original, scope).await;
        assert_eq!(first.content, original);
        assert_eq!(first.project_id, scope);
        assert_eq!(first.client_name, "codex");
        assert_eq!(first.kind, ProposalKind::Decision);
        assert_eq!(first.evidence.as_deref(), Some("Discussed during review"));
        assert_eq!(first.status, ProposalStatus::Pending);

        let mut duplicate = new_proposal("revisión:  conservar adjuntos.", scope);
        duplicate.client_name = "claude-code".into();
        duplicate.kind = ProposalKind::Fix;
        assert_eq!(store.add_proposal(duplicate.clone()).await.unwrap(), None);
        for status in [ProposalStatus::Rejected, ProposalStatus::Accepted] {
            store
                .set_proposal_status(first.id, status, None)
                .await
                .unwrap();
            assert_eq!(store.add_proposal(duplicate.clone()).await.unwrap(), None);
        }
    }
    assert_eq!(store.list_proposals(None, 10).await.unwrap().len(), 2);
}

#[tokio::test]
async fn proposals_list_newest_first_by_status_and_limit() {
    let dir = tempfile::tempdir().unwrap();
    let store = SqliteStore::open_at(dir.path().join("cobalt.db"))
        .await
        .unwrap();
    let older = add(&store, "Older pending", None).await;
    let middle = add(&store, "Rejected", None).await;
    let newest = add(&store, "Newest pending", None).await;
    let middle = store
        .set_proposal_status(middle.id, ProposalStatus::Rejected, None)
        .await
        .unwrap();

    assert_eq!(
        store.list_proposals(None, 2).await.unwrap(),
        [newest.clone(), middle.clone()],
    );
    assert_eq!(
        store
            .list_proposals(Some(ProposalStatus::Pending), 2)
            .await
            .unwrap(),
        [newest, older],
    );
    assert_eq!(
        store
            .list_proposals(Some(ProposalStatus::Rejected), 10)
            .await
            .unwrap(),
        [middle],
    );
    assert!(
        store
            .list_proposals(Some(ProposalStatus::Accepted), 10)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(store.list_proposals(None, 0).await.unwrap().is_empty());
}

#[tokio::test]
async fn proposal_status_stamps_review_and_updates_memory_link() {
    let dir = tempfile::tempdir().unwrap();
    let store = sqlite_store(&dir).await;
    let pending = add(&store, "Keep the backup", None).await;
    let memory = store
        .save_memory(new_memory("Keep the backup"))
        .await
        .unwrap()
        .memory;

    for (status, memory_id) in [
        (ProposalStatus::Accepted, Some(memory.id)),
        (ProposalStatus::Rejected, None),
    ] {
        let id = pending.id;
        store
            .db
            .write(move |conn| {
                conn.execute(
                    "UPDATE memory_proposals SET reviewed_at = NULL WHERE id = ?1",
                    [id.to_string()],
                )
                .map_err(sql_error)?;
                Ok(())
            })
            .await
            .unwrap();
        let before = timestamp_to_sql(&now());
        let reviewed = store
            .set_proposal_status(id, status, memory_id)
            .await
            .unwrap();
        let after = timestamp_to_sql(&now());
        assert_eq!(reviewed.status, status);
        assert_eq!(reviewed.memory_id, memory_id);
        assert_eq!(reviewed.created_at, pending.created_at);
        assert_eq!(store.get_proposal(id).await.unwrap(), Some(reviewed));
        store
            .db
            .read(move |conn| {
                let stamp: String = conn
                    .query_row(
                        "SELECT reviewed_at FROM memory_proposals WHERE id = ?1",
                        [id.to_string()],
                        |row| row.get(0),
                    )
                    .map_err(sql_error)?;
                assert!(before <= stamp && stamp <= after);
                Ok(())
            })
            .await
            .unwrap();
    }
    let missing = new_id();
    assert_eq!(store.get_proposal(missing).await.unwrap(), None);
    assert!(matches!(
        store
            .set_proposal_status(missing, ProposalStatus::Rejected, None)
            .await,
        Err(CobaltError::NotFound(_))
    ));
}

#[tokio::test]
async fn deleting_project_cascades_to_its_proposals() {
    let dir = tempfile::tempdir().unwrap();
    let store = SqliteStore::open_at(dir.path().join("cobalt.db"))
        .await
        .unwrap();
    let project = store
        .create_project(NewProject {
            name: "To delete".into(),
            root_path: None,
            color_hex: None,
        })
        .await
        .unwrap();
    let scoped = add(&store, "Review", Some(project.id)).await;
    let global = add(&store, "Review", None).await;
    store
        .db
        .write(move |conn| {
            conn.execute(
                "DELETE FROM projects WHERE id = ?1",
                [project.id.to_string()],
            )
            .map_err(sql_error)?;
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(store.get_proposal(scoped.id).await.unwrap(), None);
    assert_eq!(store.list_proposals(None, 10).await.unwrap(), [global]);
}

#[tokio::test]
async fn v3_database_and_snapshot_migrate_to_v4() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cobalt.db");
    let store = SqliteStore::open_at(path.clone()).await.unwrap();
    let project = store
        .create_project(NewProject {
            name: "From v3".into(),
            root_path: None,
            color_hex: None,
        })
        .await
        .unwrap();
    let old_snapshot = store.create_snapshot("v3 snapshot").await.unwrap();
    drop(store);
    for path in [&path, std::path::Path::new(&old_snapshot.file_path)] {
        let legacy = Connection::open(path).unwrap();
        legacy
            .execute_batch("DROP TABLE memory_proposals; PRAGMA user_version = 3;")
            .unwrap();
    }

    let store = SqliteStore::open_at(path.clone()).await.unwrap();
    let conn = Connection::open(path).unwrap();
    let version: u32 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, 4);
    drop(conn);
    assert_eq!(
        store.get_project(project.id).await.unwrap(),
        Some(project.clone())
    );
    assert!(store.list_proposals(None, 10).await.unwrap().is_empty());
    add(&store, "After DB migration", Some(project.id)).await;

    store.restore_snapshot(old_snapshot.id).await.unwrap();
    assert_eq!(
        store.get_project(project.id).await.unwrap(),
        Some(project.clone())
    );
    assert!(store.list_proposals(None, 10).await.unwrap().is_empty());
    add(&store, "After snapshot migration", Some(project.id)).await;
}

#[tokio::test]
async fn retention_counts_expired_pending_proposals_and_scrubbed_logs() {
    let dir = tempfile::tempdir().unwrap();
    let store = SqliteStore::open_at(dir.path().join("cobalt.db"))
        .await
        .unwrap();
    let expired = add(&store, "Expired", None).await;
    let fresh = add(&store, "Fresh", None).await;
    let accepted = add(&store, "Accepted", None).await;
    let rejected = add(&store, "Rejected", None).await;
    store
        .set_proposal_status(accepted.id, ProposalStatus::Accepted, None)
        .await
        .unwrap();
    store
        .set_proposal_status(rejected.id, ProposalStatus::Rejected, None)
        .await
        .unwrap();
    store
        .db
        .write(move |conn| {
            let now = now();
            for (proposal, age) in [
                (expired.id, 31),
                (accepted.id, 31),
                (rejected.id, 31),
                (fresh.id, 29),
            ] {
                conn.execute(
                    "UPDATE memory_proposals SET created_at = ?2 WHERE id = ?1",
                    params![
                        proposal.to_string(),
                        timestamp_to_sql(&(now - TimeDelta::days(age)))
                    ],
                )
                .map_err(sql_error)?;
            }
            Ok(())
        })
        .await
        .unwrap();
    let mut settings = store.load_settings().await.unwrap();
    settings.retention.detailed_log_limit = 0;
    store.save_settings(&settings).await.unwrap();
    let log = store
        .record_event(NewTelemetryEvent {
            client_name: "codex".into(),
            operation: TelemetryOperation::Read,
            query_text: Some("Review proposals".into()),
            returned_items: vec![],
            injected_tokens: 5,
            output_tokens_saved: 0,
            latency_ms: 5,
            project_id: None,
        })
        .await
        .unwrap();

    assert_eq!(store.apply_retention().await.unwrap(), 2);
    assert_eq!(store.get_proposal(expired.id).await.unwrap(), None);
    for id in [fresh.id, accepted.id, rejected.id] {
        assert!(store.get_proposal(id).await.unwrap().is_some());
    }
    assert!(
        store
            .get_telemetry_log(log.id)
            .await
            .unwrap()
            .unwrap()
            .query_text
            .is_none()
    );
    assert_eq!(store.apply_retention().await.unwrap(), 0);
}
