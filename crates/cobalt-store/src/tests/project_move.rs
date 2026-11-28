use cobalt_core::enums::MemoryStatus;
use cobalt_core::ids::Id;
use cobalt_core::model::{
    DeleteProjectContents, DeleteProjectReport, DeleteProjectRequest, MoveReport,
    MoveToProjectRequest, NewBranch, UpdateMemoryRequest,
};
use cobalt_core::traits::BranchRepository;

use super::*;

async fn create_project(store: &SqliteStore, name: &str) -> Id {
    store
        .create_project(NewProject {
            name: name.into(),
            root_path: None,
            color_hex: None,
        })
        .await
        .unwrap()
        .id
}

async fn ingest_chunks(store: &SqliteStore, project: Id) -> (Id, Vec<Id>) {
    let chunks = store
        .replace_watched_file(
            NewSourceDocument {
                project_id: Some(project),
                file_path: "move-notes.md".into(),
                is_dir: false,
                source_type: None,
                file_hash: Some("initial".into()),
                total_tokens: 6,
                is_watched: false,
            },
            MAIN_BRANCH_ID,
            vec![
                new_memory("alpha orchard"),
                new_memory("beta orchard"),
                new_memory("gamma orchard"),
            ],
            false,
            || Ok(()),
            || Ok(()),
        )
        .await
        .unwrap()
        .unwrap()
        .created;
    let doc = store
        .find_source_document_by_path("move-notes.md")
        .await
        .unwrap()
        .unwrap();
    (doc.id, chunks)
}

#[tokio::test]
async fn moves_document_and_active_branch_chunks_into_project_search() {
    let dir = tempfile::tempdir().unwrap();
    let store = sqlite_store(&dir).await;
    let origin = create_project(&store, "Origin").await;
    let target = create_project(&store, "Target").await;
    let (doc, chunks) = ingest_chunks(&store, origin).await;
    let [alpha, old_beta, gamma] = chunks[..] else {
        panic!("expected three chunks")
    };
    store.archive_memory(gamma, "old chunk").await.unwrap();
    let beta = store
        .update_memory(UpdateMemoryRequest {
            memory_id: old_beta,
            new_content: "beta orchard revised".into(),
            reason: "updated chunk".into(),
            confidence: None,
            source_client: None,
        })
        .await
        .unwrap()
        .memory
        .id;

    let stays = store
        .save_memory(NewMemory {
            project_id: Some(origin),
            ..new_memory("alpha other")
        })
        .await
        .unwrap()
        .memory
        .id;
    store
        .db
        .write(move |conn| {
            for endpoint in [beta, stays] {
                conn.execute(
                    "INSERT INTO memory_edges (source_id, target_id, edge_type)
                 VALUES (?1, ?2, 'same_project')",
                    params![alpha.to_string(), endpoint.to_string()],
                )
                .unwrap();
            }
            Ok(())
        })
        .await
        .unwrap();
    let side = store
        .create_branch(NewBranch {
            name: "Side".into(),
            parent_branch_id: None,
        })
        .await
        .unwrap()
        .id;
    let side_chunk = store
        .save_memory(NewMemory {
            source_doc_id: Some(doc),
            project_id: Some(origin),
            branch_id: Some(side),
            ..new_memory("alpha on side branch")
        })
        .await
        .unwrap()
        .memory
        .id;

    let search = |scope, include_archived| SearchRequest {
        scope,
        include_archived,
        rrf_override: Some(RrfWeights {
            vector_weight: 0.0,
            ..Default::default()
        }),
        ..search_request("orchard")
    };
    assert_eq!(
        store
            .search(search(ProjectScope::Project(origin), false))
            .await
            .unwrap()
            .hits
            .len(),
        2
    );
    let request = MoveToProjectRequest {
        project_id: Some(target),
        source_doc_ids: vec![doc, doc],
        memory_ids: vec![alpha, alpha],
    };
    assert_eq!(
        store.move_to_project(request.clone()).await.unwrap(),
        MoveReport {
            documents: 1,
            memories: 4,
            merged: 0
        }
    );
    assert_eq!(
        store.move_to_project(request).await.unwrap(),
        MoveReport::default()
    );
    assert_eq!(
        store
            .get_source_document(doc)
            .await
            .unwrap()
            .unwrap()
            .project_id,
        Some(target)
    );
    let historical = store.get_memory(old_beta).await.unwrap().unwrap();
    assert_eq!(historical.project_id, Some(target));
    assert_eq!(historical.status, MemoryStatus::Superseded);
    assert_eq!(historical.superseded_by, Some(beta));
    let archived = store.get_memory(gamma).await.unwrap().unwrap();
    assert_eq!(archived.status, MemoryStatus::Archived);
    assert_eq!(archived.project_id, Some(target));
    assert_eq!(
        store
            .get_memory(side_chunk)
            .await
            .unwrap()
            .unwrap()
            .project_id,
        Some(origin)
    );

    store.db.read(move |conn| {
        let endpoint: String = conn.query_row(
            "SELECT target_id FROM memory_edges WHERE source_id = ?1 AND edge_type = 'same_project'",
            [alpha.to_string()], |row| row.get(0),
        ).unwrap();
        assert_eq!(endpoint, beta.to_string());
        let count: i64 = conn.query_row(
            "SELECT count(*) FROM memory_edges WHERE source_id = ?1 AND edge_type = 'same_project'",
            [alpha.to_string()], |row| row.get(0),
        ).unwrap();
        assert_eq!(count, 1);
        Ok(())
    }).await.unwrap();
    let index = SqliteVec::open(&store, 3).await.unwrap();
    for (project, expected) in [(origin, vec![]), (target, vec![alpha, beta])] {
        let scope = ProjectScope::Project(project);
        let hits = store.search(search(scope, false)).await.unwrap().hits;
        assert_eq!(hits.len(), expected.len());
        assert!(hits.iter().all(|hit| expected.contains(&hit.memory.id)));
        let vector_hits = index
            .search(
                &[1.0, 0.0, 0.0],
                10,
                &VectorFilter {
                    scope,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let expected = if project == origin {
            vec![stays]
        } else {
            expected
        };
        assert_eq!(vector_hits.len(), expected.len());
        assert!(
            vector_hits
                .iter()
                .all(|hit| expected.contains(&hit.memory_id))
        );
    }
    assert_eq!(
        store
            .search(search(ProjectScope::Project(target), true))
            .await
            .unwrap()
            .hits
            .len(),
        3
    );
}

#[tokio::test]
async fn moving_to_global_supersedes_an_exact_duplicate_and_preserves_history() {
    let dir = tempfile::tempdir().unwrap();
    let store = sqlite_store(&dir).await;
    let origin = create_project(&store, "Origin").await;
    let (doc, chunks) = ingest_chunks(&store, origin).await;
    let existing = store
        .save_memory(new_memory("alpha orchard"))
        .await
        .unwrap()
        .memory
        .id;
    let result = store
        .move_to_project(MoveToProjectRequest {
            memory_ids: vec![chunks[0]],
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        result,
        MoveReport {
            documents: 0,
            memories: 1,
            merged: 1
        }
    );
    assert_eq!(
        store
            .move_to_project(MoveToProjectRequest {
                project_id: None,
                source_doc_ids: vec![doc],
                memory_ids: vec![],
            })
            .await
            .unwrap(),
        MoveReport {
            documents: 1,
            memories: 2,
            merged: 0
        }
    );
    let moved = store.get_memory(chunks[0]).await.unwrap().unwrap();
    assert_eq!(moved.project_id, None);
    assert_eq!(moved.status, MemoryStatus::Superseded);
    assert_eq!(moved.superseded_by, Some(existing));
    assert_eq!(
        moved.version_reason.as_deref(),
        Some("moved: duplicate in target")
    );
    assert_eq!(
        store
            .get_source_document(doc)
            .await
            .unwrap()
            .unwrap()
            .project_id,
        None
    );
    assert_eq!(store.memory_history(existing).await.unwrap().len(), 2);
    let hits = store.search(search_request("orchard")).await.unwrap().hits;
    assert!(hits.iter().any(|hit| hit.memory.id == existing));
    assert!(hits.iter().any(|hit| hit.memory.id == chunks[1]));
    assert!(hits.iter().all(|hit| hit.memory.id != moved.id));
    store
        .db
        .read(move |conn| {
            let edges: i64 = conn
                .query_row(
                    "SELECT count(*) FROM memory_edges WHERE edge_type = 'semantic'
               AND (source_id = ?1 OR target_id = ?1)",
                    [moved.id.to_string()],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(edges, 0);
            Ok(())
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn unknown_move_ids_leave_the_document_and_memories_in_place() {
    let dir = tempfile::tempdir().unwrap();
    let store = sqlite_store(&dir).await;
    let origin = create_project(&store, "Origin").await;
    let (doc, chunks) = ingest_chunks(&store, origin).await;
    let missing = new_id();
    for request in [
        MoveToProjectRequest {
            project_id: Some(missing),
            source_doc_ids: vec![doc],
            memory_ids: vec![],
        },
        MoveToProjectRequest {
            project_id: None,
            source_doc_ids: vec![doc, missing],
            memory_ids: vec![],
        },
        MoveToProjectRequest {
            project_id: None,
            source_doc_ids: vec![doc],
            memory_ids: vec![chunks[0], missing],
        },
    ] {
        assert!(
            matches!(store.move_to_project(request).await, Err(CobaltError::NotFound(message))
            if message.contains(&missing.to_string()))
        );
        assert_eq!(
            store
                .get_source_document(doc)
                .await
                .unwrap()
                .unwrap()
                .project_id,
            Some(origin)
        );
        for &id in &chunks {
            assert_eq!(
                store.get_memory(id).await.unwrap().unwrap().project_id,
                Some(origin)
            );
        }
    }
}

#[tokio::test]
async fn deleting_project_moves_all_memories_and_documents_to_global_or_another_project() {
    for to_project in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let store = sqlite_store(&dir).await;
        let origin = create_project(&store, "Origin").await;
        let target = if to_project {
            Some(create_project(&store, "Target").await)
        } else {
            None
        };
        let (doc, chunks) = ingest_chunks(&store, origin).await;
        store.archive_memory(chunks[2], "old chunk").await.unwrap();
        let existing = store
            .save_memory(NewMemory {
                project_id: target,
                ..new_memory("alpha orchard")
            })
            .await
            .unwrap()
            .memory
            .id;
        let side = store
            .create_branch(NewBranch {
                name: "Side".into(),
                parent_branch_id: None,
            })
            .await
            .unwrap()
            .id;
        let side_chunk = store
            .save_memory(NewMemory {
                source_doc_id: Some(doc),
                project_id: Some(origin),
                branch_id: Some(side),
                ..new_memory("alpha persimmon")
            })
            .await
            .unwrap()
            .memory
            .id;

        let report = store
            .delete_project(DeleteProjectRequest {
                id: origin,
                contents: DeleteProjectContents::Move,
                move_to: target,
            })
            .await
            .unwrap();
        assert_eq!(
            report,
            DeleteProjectReport {
                moved: MoveReport {
                    memories: 4,
                    documents: 1,
                    merged: 1,
                },
                ..Default::default()
            }
        );
        assert!(store.get_project(origin).await.unwrap().is_none());
        let document = store.get_source_document(doc).await.unwrap().unwrap();
        assert_eq!(document.project_id, target);
        for (id, status) in [
            (chunks[0], MemoryStatus::Superseded),
            (chunks[1], MemoryStatus::Active),
            (chunks[2], MemoryStatus::Archived),
            (side_chunk, MemoryStatus::Active),
        ] {
            let memory = store.get_memory(id).await.unwrap().unwrap();
            assert_eq!(memory.project_id, target);
            assert_eq!(memory.source_doc_id, Some(doc));
            assert_eq!(memory.status, status);
        }
        assert_eq!(
            store
                .get_memory(chunks[0])
                .await
                .unwrap()
                .unwrap()
                .superseded_by,
            Some(existing)
        );

        let scope = target.map_or(ProjectScope::Global, ProjectScope::Project);
        for (branch, query, expected) in [
            (MAIN_BRANCH_ID, "orchard", vec![existing, chunks[1]]),
            (side, "persimmon", vec![side_chunk]),
        ] {
            let hits = store
                .search(SearchRequest {
                    scope,
                    branch_id: Some(branch),
                    ..search_request(query)
                })
                .await
                .unwrap()
                .hits;
            assert_eq!(hits.len(), expected.len());
            assert!(hits.iter().all(|hit| expected.contains(&hit.memory.id)));
        }
    }
}

#[tokio::test]
async fn deleting_project_removes_rows_and_indexes_and_preserves_other_projects() {
    let dir = tempfile::tempdir().unwrap();
    let store = sqlite_store(&dir).await;
    let origin = create_project(&store, "Origin").await;
    let other = create_project(&store, "Other").await;
    let (doc, chunks) = ingest_chunks(&store, origin).await;
    store.archive_memory(chunks[2], "old chunk").await.unwrap();
    let side = store
        .create_branch(NewBranch {
            name: "Side".into(),
            parent_branch_id: None,
        })
        .await
        .unwrap()
        .id;
    let side_chunk = store
        .save_memory(NewMemory {
            source_doc_id: Some(doc),
            project_id: Some(origin),
            branch_id: Some(side),
            ..new_memory("alpha orchard side")
        })
        .await
        .unwrap()
        .memory
        .id;
    let other_memory = store
        .save_memory(NewMemory {
            project_id: Some(other),
            ..new_memory("alpha cherry")
        })
        .await
        .unwrap()
        .memory
        .id;
    let deleted_ids = [chunks[0], chunks[1], chunks[2], side_chunk];
    let [active, historical, _, _] = deleted_ids;
    let other_doc = new_id();
    store
        .db
        .write(move |conn| {
            let active = active.to_string();
            let historical = historical.to_string();
            let other_memory = other_memory.to_string();
            conn.execute(
                "UPDATE memories SET status = 'superseded', superseded_by = ?1
                 WHERE id IN (?2, ?3)",
                params![active, historical, other_memory],
            ).unwrap();
            conn.execute(
                "INSERT OR IGNORE INTO memory_edges (source_id, target_id, edge_type)
                 VALUES (?1, ?2, 'semantic'), (?2, ?1, 'semantic')",
                params![active, other_memory],
            ).unwrap();
            conn.execute(
                "INSERT INTO source_documents (id, project_id, file_path, updated_at)
                 VALUES (?1, ?2, 'keep.md', '2026-11-28T01:00:00Z')",
                params![other_doc.to_string(), other.to_string()],
            ).unwrap();
            conn.execute(
                "INSERT INTO handoffs (id, project_id, source_client, summary, created_at, expires_at)
                 VALUES ('remove', ?1, 'test', 'remove', '2026-11-28', '2026-11-29'),
                        ('keep', ?2, 'test', 'keep', '2026-11-28', '2026-11-29')",
                params![origin.to_string(), other.to_string()],
            ).unwrap();
            conn.execute(
                "INSERT INTO memory_proposals (id, project_id, client_name, kind, content, content_key, created_at)
                 VALUES ('remove', ?1, 'test', 'fix', 'remove', 'remove', '2026-11-28'),
                        ('keep', ?2, 'test', 'fix', 'keep', 'keep', '2026-11-28')",
                params![origin.to_string(), other.to_string()],
            ).unwrap();
            conn.execute(
                "INSERT INTO telemetry_logs (id, project_id, timestamp, client_name, operation, saved_tokens)
                 VALUES ('remove-project', ?1, '2026-11-28T01:00:00Z', 'test', 'read', 10),
                        ('keep-project', ?2, '2026-11-28T01:00:00Z', 'test', 'read', 20),
                        ('global', NULL, '2026-11-28T01:00:00Z', 'test', 'read', 30)",
                params![origin.to_string(), other.to_string()],
            ).unwrap();
            Ok(())
        })
        .await
        .unwrap();

    let search = SearchRequest {
        scope: ProjectScope::All,
        rrf_override: Some(RrfWeights {
            vector_weight: 0.0,
            ..Default::default()
        }),
        ..search_request("orchard")
    };
    let request = DeleteProjectRequest {
        id: origin,
        contents: DeleteProjectContents::Delete,
        move_to: None,
    };
    assert!(!store.search(search.clone()).await.unwrap().hits.is_empty());
    store
        .db
        .write(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER reject_project_delete BEFORE DELETE ON projects
             BEGIN SELECT RAISE(ABORT, 'project deletion rejected'); END;",
            )
            .unwrap();
            Ok(())
        })
        .await
        .unwrap();
    assert!(store.delete_project(request.clone()).await.is_err());
    assert!(store.get_project(origin).await.unwrap().is_some());
    assert!(store.get_source_document(doc).await.unwrap().is_some());
    assert!(!store.search(search.clone()).await.unwrap().hits.is_empty());
    store
        .db
        .write(move |conn| {
            let count: i64 = conn
                .query_row(
                    "SELECT count(*) FROM vec_memories WHERE memory_id = ?1",
                    [active.to_string()],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 1);
            conn.execute_batch("DROP TRIGGER reject_project_delete;")
                .unwrap();
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(
        store.delete_project(request).await.unwrap(),
        DeleteProjectReport {
            memories_deleted: 4,
            documents_deleted: 1,
            ..Default::default()
        }
    );
    assert!(store.get_project(origin).await.unwrap().is_none());
    assert!(store.get_source_document(doc).await.unwrap().is_none());
    assert!(store.search(search).await.unwrap().hits.is_empty());
    assert!(store.get_project(other).await.unwrap().is_some());
    assert_eq!(
        store
            .get_source_document(other_doc)
            .await
            .unwrap()
            .unwrap()
            .project_id,
        Some(other)
    );
    let survivor = store.get_memory(other_memory).await.unwrap().unwrap();
    assert_eq!(survivor.project_id, Some(other));
    assert_eq!(survivor.superseded_by, None);
    for id in deleted_ids {
        assert!(store.get_memory(id).await.unwrap().is_none());
    }

    store
        .db
        .read(move |conn| {
            for (query, expected) in [
                ("SELECT count(*) FROM vec_memories", 1),
                (
                    "SELECT count(*) FROM memories_fts WHERE memories_fts MATCH 'orchard'",
                    0,
                ),
                ("SELECT count(*) FROM memory_edges", 0),
                ("SELECT count(*) FROM handoffs", 1),
                ("SELECT count(*) FROM memory_proposals", 1),
                ("SELECT count(*) FROM telemetry_logs", 3),
                (
                    "SELECT count(*) FROM telemetry_logs WHERE project_id IS NULL",
                    2,
                ),
                ("SELECT requests FROM usage_hourly WHERE project_id = ''", 2),
                (
                    "SELECT saved_tokens FROM usage_hourly WHERE project_id = ''",
                    40,
                ),
            ] {
                assert_eq!(
                    conn.query_row(query, [], |row| row.get::<_, i64>(0))
                        .unwrap(),
                    expected,
                    "{query}"
                );
            }
            let retained_id: String = conn
                .query_row("SELECT memory_id FROM vec_memories", [], |row| row.get(0))
                .unwrap();
            assert_eq!(retained_id, other_memory.to_string());
            let (requests, saved): (i64, i64) = conn
                .query_row(
                    "SELECT requests, saved_tokens FROM usage_hourly WHERE project_id = ?1",
                    [other.to_string()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!((requests, saved), (1, 20));
            let count: i64 = conn
                .query_row(
                    "SELECT count(*) FROM usage_hourly WHERE project_id = ?1",
                    [origin.to_string()],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 0);
            Ok(())
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn invalid_project_deletion_leaves_contents_in_place() {
    let dir = tempfile::tempdir().unwrap();
    let store = sqlite_store(&dir).await;
    let origin = create_project(&store, "Origin").await;
    let (doc, chunks) = ingest_chunks(&store, origin).await;
    let missing = new_id();
    let request = DeleteProjectRequest {
        id: origin,
        contents: DeleteProjectContents::Move,
        move_to: None,
    };
    for invalid in [
        DeleteProjectRequest {
            id: missing,
            ..request.clone()
        },
        DeleteProjectRequest {
            move_to: Some(missing),
            ..request.clone()
        },
    ] {
        assert!(
            matches!(store.delete_project(invalid).await, Err(CobaltError::NotFound(message))
            if message.contains(&missing.to_string()))
        );
    }
    assert!(matches!(
        store
            .delete_project(DeleteProjectRequest {
                move_to: Some(origin),
                ..request.clone()
            })
            .await,
        Err(CobaltError::InvalidInput(_))
    ));
    let settings = AppSettings {
        read_only: true,
        ..store.load_settings().await.unwrap()
    };
    store.save_settings(&settings).await.unwrap();
    for contents in [DeleteProjectContents::Move, DeleteProjectContents::Delete] {
        assert!(matches!(
            store
                .delete_project(DeleteProjectRequest {
                    contents,
                    ..request.clone()
                })
                .await,
            Err(CobaltError::ReadOnly)
        ));
    }
    assert!(store.get_project(origin).await.unwrap().is_some());
    assert_eq!(
        store
            .get_source_document(doc)
            .await
            .unwrap()
            .unwrap()
            .project_id,
        Some(origin)
    );
    for id in chunks {
        assert_eq!(
            store.get_memory(id).await.unwrap().unwrap().project_id,
            Some(origin)
        );
    }
}
