use std::process::Command;
use std::sync::Arc;

use async_trait::async_trait;
use cobalt_core::config::{AppSettings, RrfWeights};
use cobalt_core::engine::EmbeddingModelSpec;
use cobalt_core::enums::{FileAvailability, HardwareTier, MemoryCategory, TokenEncoding};
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::ids::{MAIN_BRANCH_ID, new_id};
use cobalt_core::model::{GraphQuery, NewMemory, NewProject, NewSourceDocument, ProjectPatch};
use cobalt_core::paths::COBALT_HOME_ENV;
use cobalt_core::search::{ProjectScope, SearchFilter, SearchRequest, VectorFilter, VectorRecord};
use cobalt_core::traits::{
    ConfigRepository, Embedder, MemoryRepository, ProjectRepository, SearchService,
    SourceDocumentRepository, VectorStore,
};
use cobalt_embeddings::{TiktokenCounter, default_model_spec};
use rusqlite::params;
use sha2::{Digest, Sha256};

use super::*;

struct DeterministicEmbedderMock(EmbeddingModelSpec);

impl DeterministicEmbedderMock {
    fn new() -> Self {
        let mut spec = default_model_spec(HardwareTier::Eco);
        spec.id = "phase-one-test".into();
        spec.dimensions = 3;
        Self(spec)
    }

    fn embedding(text: &str) -> Vec<f32> {
        if text == "bad embedding" {
            vec![0.0; 3]
        } else if text == "alpha other" {
            vec![0.8, 0.0, 0.6]
        } else if text.contains("alpha") {
            vec![1.0, 0.0, 0.0]
        } else if text.contains("beta") {
            vec![0.0, 1.0, 0.0]
        } else {
            vec![0.0, 0.0, 1.0]
        }
    }
}

#[async_trait]
impl Embedder for DeterministicEmbedderMock {
    fn spec(&self) -> &EmbeddingModelSpec {
        &self.0
    }

    async fn embed_documents(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        Ok(texts.iter().map(|text| Self::embedding(text)).collect())
    }

    async fn embed_query(&self, text: &str) -> Result<Vec<f32>> {
        Ok(Self::embedding(text))
    }
}

async fn sqlite_store(directory: &tempfile::TempDir) -> SqliteStore {
    SqliteStore::open_at(directory.path().join("cobalt.db"))
        .await
        .unwrap()
        .with_sqlite_vec(
            Arc::new(DeterministicEmbedderMock::new()),
            Arc::new(TiktokenCounter::new(TokenEncoding::Cl100kBase)),
        )
        .await
        .unwrap()
}

fn new_memory(content: &str) -> NewMemory {
    NewMemory {
        content: content.into(),
        category: MemoryCategory::Note,
        project_id: None,
        branch_id: None,
        source_doc_id: None,
        source_type: None,
        confidence: None,
        is_core_pin: false,
        is_reusable: false,
        reusable_snippet: None,
        source_client: None,
    }
}

fn search_request(query: &str) -> SearchRequest {
    SearchRequest {
        query: query.into(),
        scope: ProjectScope::Global,
        branch_id: None,
        top_k: None,
        include_archived: false,
        filter: SearchFilter::default(),
        rrf_override: None,
        record_hits: false,
    }
}

#[tokio::test]
async fn migration_sets_canonical_schema_and_connection_pragmas() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cobalt.db");
    let store = SqliteStore::open_at(path.clone()).await.unwrap();
    store.db.read(|conn| {
        for (pragma, expected) in [
            ("journal_mode", "wal"), ("foreign_keys", "1"), ("synchronous", "1"),
            ("busy_timeout", "5000"), ("temp_store", "2"), ("user_version", "1"),
        ] {
            let actual = conn.pragma_query_value(None, pragma, |row| {
                Ok(match row.get_ref(0)? {
                    rusqlite::types::ValueRef::Integer(value) => value.to_string(),
                    value => value.as_str()?.to_owned(),
                })
            }).unwrap();
            assert_eq!(actual, expected, "{pragma}");
        }
        let mut stmt = conn.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'memories_fts_*' ORDER BY name").unwrap();
        let tables = stmt.query_map([], |row| row.get(0)).unwrap().collect::<rusqlite::Result<Vec<String>>>().unwrap();
        assert_eq!(tables, [
            "app_config", "branches", "handoffs", "installed_themes", "memories", "memories_fts",
            "memory_edges", "projects", "snapshots", "source_documents", "telemetry_logs",
        ]);
        let main = crate::repositories::branch(conn, None)?;
        assert_eq!(main.id, MAIN_BRANCH_ID);
        assert_eq!(main.name, "main");
        assert!(main.parent_branch_id.is_none());
        assert!(conn.execute("DELETE FROM branches", []).is_err());
        Ok(())
    }).await.unwrap();
    let reopened = SqliteStore::open_at(path).await.unwrap();
    assert_eq!(
        reopened
            .graph(GraphQuery::default())
            .await
            .unwrap()
            .branch
            .id,
        MAIN_BRANCH_ID
    );
}

#[tokio::test]
async fn settings_projects_and_source_documents_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let store = SqliteStore::open_at(dir.path().join("cobalt.db"))
        .await
        .unwrap();
    assert_eq!(store.load_settings().await.unwrap(), AppSettings::default());
    let mut settings = AppSettings::default();
    settings.search.top_k = 2;
    store.save_settings(&settings).await.unwrap();
    assert_eq!(store.get_raw("search").await.unwrap().unwrap()["top_k"], 2);
    assert_eq!(store.load_settings().await.unwrap(), settings);
    store
        .set_raw("search", serde_json::json!({ "top_k": 13 }))
        .await
        .unwrap();
    assert_eq!(store.load_settings().await.unwrap().search.top_k, 13);

    let root = dir.path().join("project");
    let child = root.join("nested");
    std::fs::create_dir_all(&child).unwrap();
    let outer = store
        .resolve_project_by_path(root.to_str().unwrap(), true)
        .await
        .unwrap()
        .unwrap();
    let inner = store
        .create_project(NewProject {
            name: "nested".into(),
            root_path: Some(child.to_string_lossy().into_owned()),
            color_hex: None,
        })
        .await
        .unwrap();
    assert_eq!(
        store.get_project(outer.id).await.unwrap(),
        Some(outer.clone())
    );
    assert_eq!(
        store.find_project_by_name("nested").await.unwrap(),
        Some(inner.clone())
    );
    assert_eq!(
        store
            .resolve_project_by_path(child.join("file.md").to_str().unwrap(), false)
            .await
            .unwrap(),
        Some(inner)
    );
    assert_eq!(
        store
            .resolve_project_by_path(dir.path().join("project2/file.md").to_str().unwrap(), false)
            .await
            .unwrap(),
        None
    );
    assert!(
        store
            .update_project(
                outer.id,
                ProjectPatch {
                    root_path: Some(None),
                    is_archived: Some(true),
                    ..Default::default()
                }
            )
            .await
            .unwrap()
            .root_path
            .is_none()
    );
    assert_eq!(store.list_projects(false).await.unwrap().len(), 1);
    assert_eq!(store.list_projects(true).await.unwrap().len(), 2);

    let file = child.join("note.md");
    std::fs::write(&file, b"original").unwrap();
    let new = NewSourceDocument {
        project_id: Some(outer.id),
        file_path: file.to_string_lossy().into_owned(),
        is_dir: false,
        source_type: None,
        file_hash: Some(hex::encode(Sha256::digest(b"original"))),
        total_tokens: 100,
        is_watched: false,
    };
    let doc = store.upsert_source_document(new.clone()).await.unwrap();
    assert_eq!(doc.source_type.as_str(), "md");
    let upserted = store
        .upsert_source_document(NewSourceDocument {
            total_tokens: 120,
            ..new
        })
        .await
        .unwrap();
    assert_eq!(upserted.id, doc.id);
    assert_eq!(
        store
            .get_source_document(doc.id)
            .await
            .unwrap()
            .unwrap()
            .total_tokens,
        120
    );
    assert_eq!(
        store.verify_source_document(doc.id).await.unwrap(),
        FileAvailability::Available
    );
    std::fs::write(&file, b"changed").unwrap();
    assert_eq!(
        store.verify_source_document(doc.id).await.unwrap(),
        FileAvailability::Modified
    );
    let moved = child.join("moved.md");
    std::fs::rename(&file, &moved).unwrap();
    assert_eq!(
        store.verify_source_document(doc.id).await.unwrap(),
        FileAvailability::Missing
    );
    let linked = store
        .relink_source_document(doc.id, moved.to_str().unwrap())
        .await
        .unwrap();
    assert_eq!(
        store
            .find_source_document_by_path(moved.to_str().unwrap())
            .await
            .unwrap(),
        Some(linked)
    );
    assert_eq!(
        store.verify_source_document(doc.id).await.unwrap(),
        FileAvailability::Available
    );
    let watched = store.set_watched(doc.id, true).await.unwrap();
    assert_eq!(store.list_watched().await.unwrap(), vec![watched]);
}

#[tokio::test]
async fn hybrid_search_fuses_filters_counts_sources_and_records_unique_hits() {
    let dir = tempfile::tempdir().unwrap();
    let store = sqlite_store(&dir).await;
    let project = store
        .create_project(NewProject {
            name: "search".into(),
            root_path: None,
            color_hex: None,
        })
        .await
        .unwrap();
    let doc = store
        .upsert_source_document(NewSourceDocument {
            project_id: Some(project.id),
            file_path: dir.path().join("doc.md").to_string_lossy().into_owned(),
            is_dir: false,
            source_type: None,
            file_hash: None,
            total_tokens: 200,
            is_watched: false,
        })
        .await
        .unwrap();
    let a = store
        .save_memory(NewMemory {
            source_doc_id: Some(doc.id),
            project_id: Some(project.id),
            is_reusable: true,
            ..new_memory("alpha shared eso")
        })
        .await
        .unwrap()
        .memory;
    let b = store
        .save_memory(NewMemory {
            source_doc_id: Some(doc.id),
            project_id: Some(project.id),
            ..new_memory("beta shared él")
        })
        .await
        .unwrap()
        .memory;
    let pin = store
        .save_memory(NewMemory {
            is_core_pin: true,
            ..new_memory("alpha rule")
        })
        .await
        .unwrap()
        .memory;
    let _elsewhere = store
        .save_memory(NewMemory {
            project_id: Some(project.id),
            ..new_memory("alpha other")
        })
        .await
        .unwrap();
    let mut request = search_request("alpha shared");
    request.scope = ProjectScope::ProjectAndGlobal(project.id);
    request.filter.min_confidence = Some(0.5);
    request.record_hits = true;
    let response = store.search(request).await.unwrap();

    assert_eq!(response.core_rules[0].id, pin.id);
    assert_eq!(response.hits[0].memory.id, pin.id);
    let hit = response
        .hits
        .iter()
        .find(|hit| hit.memory.id == a.id)
        .unwrap();
    let vector_rank = hit.vector_rank.unwrap();
    let fts_rank = hit.fts_rank.unwrap();
    let expected = 1.0 / (60.0 + f64::from(vector_rank)) + 1.0 / (60.0 + f64::from(fts_rank));
    assert!((hit.rrf_score - expected).abs() < 1e-12);
    assert_eq!(hit.similarity_score, 1.0);
    assert!(hit.bm25.unwrap() < 0.0);
    let hit = response
        .hits
        .iter()
        .find(|hit| hit.memory.id == b.id)
        .unwrap();
    assert!(hit.vector_rank.is_none());
    assert!(hit.fts_rank.is_some());
    let injected: i64 = response
        .hits
        .iter()
        .map(|hit| hit.memory.chunk_tokens)
        .sum();
    let standalone: i64 = response
        .hits
        .iter()
        .filter(|hit| hit.memory.source_doc_id.is_none())
        .map(|hit| hit.memory.chunk_tokens)
        .sum();
    assert_eq!(response.savings.injected_tokens, injected);
    assert_eq!(response.savings.avoided_full_tokens, 200 + standalone);
    assert_eq!(response.savings.saved_tokens, 200 + standalone - injected);
    assert_eq!(
        store.get_memory(pin.id).await.unwrap().unwrap().hit_count,
        1
    );
    assert_eq!(store.get_memory(a.id).await.unwrap().unwrap().hit_count, 1);
    assert!(
        store
            .get_memory(a.id)
            .await
            .unwrap()
            .unwrap()
            .last_accessed_at
            .is_some()
    );

    let mut filtered = search_request("alpha shared");
    filtered.scope = ProjectScope::ProjectAndGlobal(project.id);
    filtered.filter.only_reusable = true;
    filtered.filter.source_types = vec![cobalt_core::enums::SourceType::Md];
    let filtered = store.search(filtered).await.unwrap();
    assert_eq!(filtered.hits.len(), 1);
    assert_eq!(filtered.hits[0].memory.id, a.id);
    assert_eq!(store.get_memory(a.id).await.unwrap().unwrap().hit_count, 1);

    let graph = store.graph(GraphQuery::default()).await.unwrap();
    assert_eq!(graph.nodes[0].id, pin.id);
    let position = graph
        .nodes
        .iter()
        .find(|node| node.id == a.id)
        .unwrap()
        .position
        .unwrap();
    assert_eq!(position, project_embedding(&[1.0, 0.0, 0.0]));
    assert!(
        position
            .iter()
            .map(|coordinate| coordinate * coordinate)
            .sum::<f64>()
            .sqrt()
            <= 100.0
    );
    assert_eq!(graph.projects[0].vector_count, 3);
    assert!(
        store
            .save_memory(new_memory("bad embedding"))
            .await
            .is_err()
    );
    assert_eq!(
        store
            .graph(GraphQuery::default())
            .await
            .unwrap()
            .nodes
            .len(),
        graph.nodes.len()
    );
}

#[tokio::test]
async fn hybrid_search_requires_relevance_in_a_bilingual_dev_corpus() {
    let dir = tempfile::tempdir().unwrap();
    let store = sqlite_store(&dir).await;
    let doc = store
        .upsert_source_document(NewSourceDocument {
            project_id: None,
            file_path: dir.path().join("release.md").to_string_lossy().into_owned(),
            is_dir: false,
            source_type: None,
            file_hash: None,
            total_tokens: 43_000,
            is_watched: false,
        })
        .await
        .unwrap();
    let release = store
        .save_memory(NewMemory {
            source_doc_id: Some(doc.id),
            ..new_memory(
                "The alpha release build failed with E0063 in the pizza fixture. Initialize the write slot field.",
            )
        })
        .await
        .unwrap()
        .memory;
    let database = store
        .save_memory(new_memory(
            "En beta, write_slot agrupa las escrituras en una transacción de SQLite.",
        ))
        .await
        .unwrap()
        .memory;
    let ci = store
        .save_memory(new_memory(
            "En CI, use the x cache key for the Linux runner and rebuild the Rust toolchain on a cache miss.",
        ))
        .await
        .unwrap()
        .memory;
    // Keep the fixture distinct from the test embedder's default query vector.
    SqliteVec::open(&store, 3)
        .await
        .unwrap()
        .upsert(&[VectorRecord {
            memory_id: ci.id,
            vector: vec![0.6, 0.8, 0.0],
            project_id: ci.project_id,
            branch_id: ci.branch_id,
            is_reusable: ci.is_reusable,
            status: ci.status,
        }])
        .await
        .unwrap();

    for query in [
        "receta de pizza margarita",
        "how do I cook the pizza with basil",
        "the de la x",
        "pizza PIZZA pizza receta margarita",
        "transacción transaccion galaxia satélite",
    ] {
        let response = store
            .search(SearchRequest {
                record_hits: true,
                ..search_request(query)
            })
            .await
            .unwrap();
        assert!(response.hits.is_empty(), "{query}: {:?}", response.hits);
        assert!(response.core_rules.is_empty(), "{query}");
        assert_eq!(response.savings, Default::default(), "{query}");
    }
    for id in [release.id, database.id, ci.id] {
        let memory = store.get_memory(id).await.unwrap().unwrap();
        assert_eq!(memory.hit_count, 0);
        assert!(memory.last_accessed_at.is_none());
    }

    for (query, expected) in [
        ("the alpha release build", release.id),
        ("la transacción de beta", database.id),
        ("alpha packet galaxy", release.id),
    ] {
        let result = store.search(search_request(query)).await.unwrap();
        assert_eq!(result.hits[0].memory.id, expected, "{query}");
        assert!(result.hits[0].vector_rank.is_some(), "{query}");
    }
    let fts_only = |query: &str| SearchRequest {
        rrf_override: Some(RrfWeights {
            vector_weight: 0.0,
            ..RrfWeights::default()
        }),
        ..search_request(query)
    };
    for (query, expected) in [
        ("e0063", release.id),
        ("WRITE_SLOT", database.id),
        ("transaccion write_slot pan", database.id),
    ] {
        let result = store.search(fts_only(query)).await.unwrap();
        assert_eq!(result.hits.len(), 1, "{query}");
        assert_eq!(result.hits[0].memory.id, expected, "{query}");
        assert!(result.hits[0].fts_rank.is_some(), "{query}");
        assert!(result.hits[0].vector_rank.is_none(), "{query}");
    }

    let pin = store
        .save_memory(NewMemory {
            is_core_pin: true,
            ..new_memory("Always rotate deployment credentials after a release.")
        })
        .await
        .unwrap()
        .memory;
    let result = store
        .search(fts_only("credentials receta margarita"))
        .await
        .unwrap();
    assert_eq!(result.core_rules[0].id, pin.id);
    assert_eq!(result.hits[0].memory.id, pin.id);
    assert_eq!(result.savings.injected_tokens, pin.chunk_tokens);
}

#[tokio::test]
async fn fts_triggers_remove_old_encrypted_and_deleted_rows() {
    let dir = tempfile::tempdir().unwrap();
    let store = sqlite_store(&dir).await;
    let memory = store
        .save_memory(new_memory("alpha before"))
        .await
        .unwrap()
        .memory;
    let fts_only = |text: &str| SearchRequest {
        rrf_override: Some(RrfWeights {
            vector_weight: 0.0,
            ..RrfWeights::default()
        }),
        ..search_request(text)
    };
    assert_eq!(
        store.search(fts_only("before")).await.unwrap().hits.len(),
        1
    );
    let id = memory.id.to_string();
    store
        .db
        .write(move |conn| {
            conn.execute(
                "UPDATE memories SET content = 'after punct_name' WHERE id = ?1",
                [&id],
            )
            .unwrap();
            Ok(())
        })
        .await
        .unwrap();
    assert!(
        store
            .search(fts_only("before"))
            .await
            .unwrap()
            .hits
            .is_empty()
    );
    assert_eq!(
        store
            .search(fts_only("\"punct_name\" : (OR) *"))
            .await
            .unwrap()
            .hits
            .len(),
        1
    );
    let id = memory.id.to_string();
    store.db.write(move |conn| {
        conn.execute("UPDATE memories SET content = '', is_encrypted = 1, ciphertext = X'00', nonce = X'00' WHERE id = ?1", [&id]).unwrap();
        let count: i64 = conn.query_row("SELECT count(*) FROM memories_fts WHERE memories_fts MATCH 'note'", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 0);
        Ok(())
    }).await.unwrap();
    assert!(
        store
            .search(search_request("alpha"))
            .await
            .unwrap()
            .hits
            .is_empty()
    );
    let second = store
        .save_memory(new_memory("delete this alpha"))
        .await
        .unwrap()
        .memory;
    store
        .db
        .write(move |conn| {
            conn.execute(
                "DELETE FROM memories WHERE id = ?1",
                [second.id.to_string()],
            )
            .unwrap();
            Ok(())
        })
        .await
        .unwrap();
    assert!(
        store
            .search(fts_only("delete"))
            .await
            .unwrap()
            .hits
            .is_empty()
    );
}

#[tokio::test]
async fn sqlite_vec_batch_rollback_and_branch_scope() {
    let dir = tempfile::tempdir().unwrap();
    let store = sqlite_store(&dir).await;
    let vectors = SqliteVec::open(&store, 3).await.unwrap();
    assert!(SqliteVec::open(&store, 4).await.is_err());
    let primary = store
        .save_memory(new_memory("alpha primary"))
        .await
        .unwrap()
        .memory;
    let branch_id = new_id();
    store
        .db
        .write(move |conn| {
            conn.execute(
                "INSERT INTO branches (id, name, created_at) VALUES (?1, 'scratch', ?2)",
                params![branch_id.to_string(), crate::repositories::stamp()],
            )
            .unwrap();
            Ok(())
        })
        .await
        .unwrap();
    let other = store
        .save_memory(NewMemory {
            branch_id: Some(branch_id),
            ..new_memory("alpha scratch")
        })
        .await
        .unwrap()
        .memory;
    let record = VectorRecord {
        memory_id: primary.id,
        vector: vec![0.0, 0.0, 1.0],
        project_id: None,
        branch_id: primary.branch_id,
        is_reusable: false,
        status: primary.status,
    };
    let invalid = VectorRecord {
        memory_id: new_id(),
        ..record.clone()
    };
    assert!(vectors.upsert(&[record, invalid]).await.is_err());
    assert_eq!(vectors.count().await.unwrap(), 2);
    let global = vectors
        .search(&[1.0, 0.0, 0.0], 10, &VectorFilter::default())
        .await
        .unwrap();
    assert_eq!(
        (global[0].memory_id, global[0].similarity),
        (primary.id, 1.0)
    );
    let scratch = vectors
        .search(
            &[1.0, 0.0, 0.0],
            10,
            &VectorFilter {
                branch_id: Some(branch_id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(scratch[0].memory_id, other.id);
    assert_eq!(scratch.len(), 1);
    vectors.delete(&[primary.id]).await.unwrap();
    assert_eq!(vectors.count().await.unwrap(), 1);
}

const TEST_HOME_CHILD: &str = "COBALT_STORE_TEST_HOME_CHILD";

#[test]
fn usearch_persists_in_cobalt_home() {
    let dir = tempfile::tempdir().unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "tests::usearch_home_child"])
        .env(COBALT_HOME_ENV, dir.path())
        .env(TEST_HOME_CHILD, "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(dir.path().join("cobalt.db").is_file());
    assert!(
        dir.path()
            .join("index/usearch-phase-one-test/index.usearch")
            .is_file()
    );
}

#[tokio::test]
#[ignore = "launched by usearch_persists_in_cobalt_home with an isolated COBALT_HOME"]
async fn usearch_home_child() {
    if std::env::var_os(TEST_HOME_CHILD).is_none() || std::env::var_os(COBALT_HOME_ENV).is_none() {
        return;
    }
    let store = SqliteStore::open()
        .await
        .unwrap()
        .with_usearch(
            Arc::new(DeterministicEmbedderMock::new()),
            Arc::new(TiktokenCounter::new(TokenEncoding::Cl100kBase)),
        )
        .await
        .unwrap();
    let a = store
        .save_memory(new_memory("alpha usearch"))
        .await
        .unwrap()
        .memory;
    let _b = store
        .save_memory(new_memory("beta usearch"))
        .await
        .unwrap()
        .memory;
    let result = store.search(search_request("alpha")).await.unwrap();
    assert_eq!(result.hits[0].memory.id, a.id);
    drop(store);

    let store = SqliteStore::open().await.unwrap();
    let vectors = Usearch::open(&store, "phase-one-test", 3).await.unwrap();
    vectors.health_check().await.unwrap();
    vectors.flush().await.unwrap();
    assert_eq!(vectors.count().await.unwrap(), 2);
    let result = vectors
        .search(&[1.0, 0.0, 0.0], 1, &VectorFilter::default())
        .await
        .unwrap();
    assert_eq!(result[0].memory_id, a.id);
    assert!((result[0].similarity - 1.0).abs() < 1e-6);
    vectors.delete(&[a.id]).await.unwrap();
    assert_eq!(vectors.count().await.unwrap(), 1);
    assert!(matches!(
        Usearch::open(&store, "phase-one-test", 4).await,
        Err(CobaltError::Engine(_))
    ));
}

mod phase2;

#[tokio::test]
async fn watched_file_replacement_rolls_back_metadata_chunks_and_vectors_on_write_error() {
    let dir = tempfile::tempdir().unwrap();
    let store = sqlite_store(&dir).await;
    let original = NewSourceDocument {
        project_id: None,
        file_path: "watched.md".into(),
        is_dir: false,
        source_type: None,
        file_hash: Some("original".into()),
        total_tokens: 2,
        is_watched: true,
    };
    let first = store
        .replace_watched_file(
            original.clone(),
            MAIN_BRANCH_ID,
            vec![new_memory("alpha before")],
            false,
            || Ok(()),
            || Ok(()),
        )
        .await
        .unwrap()
        .unwrap()
        .created[0];
    let invalid = NewMemory {
        confidence: Some(2.0),
        ..new_memory("invalid chunk")
    };
    assert!(
        store
            .replace_watched_file(
                NewSourceDocument {
                    file_hash: Some("changed".into()),
                    total_tokens: 6,
                    ..original
                },
                MAIN_BRANCH_ID,
                vec![new_memory("beta after"), invalid],
                false,
                || Ok(()),
                || Ok(()),
            )
            .await
            .is_err()
    );
    let source = store
        .find_source_document_by_path("watched.md")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(source.file_hash.as_deref(), Some("original"));
    assert_eq!(source.total_tokens, 2);
    let hits = store
        .search(search_request("alpha before"))
        .await
        .unwrap()
        .hits;
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].memory.id, first);
    store
        .db
        .read(move |conn| {
            let mut stmt = conn.prepare("SELECT memory_id FROM vec_memories").unwrap();
            let ids: Vec<String> = stmt
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            assert_eq!(ids, vec![first.to_string()]);
            Ok(())
        })
        .await
        .unwrap();
}

mod similarity;
