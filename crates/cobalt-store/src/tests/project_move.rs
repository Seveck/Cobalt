use cobalt_core::enums::MemoryStatus;
use cobalt_core::ids::Id;
use cobalt_core::model::{MoveReport, MoveToProjectRequest, NewBranch, UpdateMemoryRequest};
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
