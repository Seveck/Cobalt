use super::*;

use chrono::TimeDelta;
use cobalt_core::engine::EngineSwapRequest;
use cobalt_core::enums::{
    DuplicateKind, EdgeType, EngineKind, EngineSwapPhase, MemoryStatus, TelemetryOperation,
    WriteAction,
};
use cobalt_core::ids::now;
use cobalt_core::model::{InstalledTheme, MemoryPatch, NewBranch, NewHandoff, UpdateMemoryRequest};
use cobalt_core::search::{LibraryFilter, ReusableAssetQuery, WebContextRequest};
use cobalt_core::telemetry::{
    NewTelemetryEvent, ReturnedItem, TelemetryQuery, TelemetryRange, UsageStatsRequest,
};
use cobalt_core::traits::{
    BranchRepository, CobaltStore, EngineMigrator, GovernanceService, HandoffRepository,
    SnapshotRepository, TelemetryRepository, ThemeRepository, TokenCounter,
};
use std::sync::Mutex;

struct CalibratedEmbedderMock(EmbeddingModelSpec);

impl CalibratedEmbedderMock {
    fn vector(text: &str) -> Vec<f32> {
        if text == "unrelated" {
            return vec![0.78, -(1.0_f32 - 0.78 * 0.78).sqrt()];
        }
        let score = match text {
            // E5 Small maps this cosine to 0.882, between dedup and duplicate.
            "semantic revision" => 0.93774_f32,
            "near-identical" => 0.999,
            _ => 1.0,
        };
        vec![score, (1.0 - score * score).sqrt()]
    }
}

#[async_trait]
impl Embedder for CalibratedEmbedderMock {
    fn spec(&self) -> &EmbeddingModelSpec {
        &self.0
    }

    async fn embed_documents(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        Ok(texts.iter().map(|text| Self::vector(text)).collect())
    }

    async fn embed_query(&self, text: &str) -> Result<Vec<f32>> {
        if text == "related query" {
            return Ok(vec![0.84, (1.0_f32 - 0.84 * 0.84).sqrt()]);
        }
        Ok(Self::vector(text))
    }
}

async fn calibrated_store(directory: &tempfile::TempDir) -> SqliteStore {
    let mut spec = default_model_spec(HardwareTier::Eco);
    spec.dimensions = 2;
    SqliteStore::open_at(directory.path().join("cobalt.db"))
        .await
        .unwrap()
        .with_sqlite_vec(
            Arc::new(CalibratedEmbedderMock(spec)),
            Arc::new(TiktokenCounter::new(TokenEncoding::Cl100kBase)),
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn canonical_writes_calibrate_scores_and_preserve_version_history() {
    let dir = tempfile::tempdir().unwrap();
    let store = calibrated_store(&dir).await;
    let full_store: &dyn CobaltStore = &store;
    let first = full_store
        .save_memory(NewMemory {
            is_core_pin: true,
            category: MemoryCategory::Preference,
            ..new_memory("original")
        })
        .await
        .unwrap();
    assert_eq!(first.action, WriteAction::Inserted);
    let duplicate = store.save_memory(new_memory("original")).await.unwrap();
    assert_eq!(duplicate.action, WriteAction::Duplicate);
    assert_eq!(duplicate.memory, first.memory);
    assert_eq!(
        store
            .save_memory(new_memory("unrelated"))
            .await
            .unwrap()
            .action,
        WriteAction::Inserted
    );

    let mut vector_only = search_request("original");
    vector_only.rrf_override = Some(RrfWeights {
        fts_weight: 0.0,
        ..Default::default()
    });
    let results = store.search(vector_only.clone()).await.unwrap();
    assert_eq!(results.hits.len(), 1);
    assert_eq!(results.hits[0].similarity_score, 1.0);
    let results = store
        .search(SearchRequest {
            rrf_override: vector_only.rrf_override,
            ..search_request("related query")
        })
        .await
        .unwrap();
    assert_eq!(results.hits.len(), 1);
    assert_eq!(results.hits[0].memory.id, first.memory.id);
    assert!(
        store
            .find_import_collision("semantic revision", None, None)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        store
            .find_import_collision("near-identical", None, None)
            .await
            .unwrap()
            .unwrap()
            .0,
        first.memory.id
    );

    let revision = store
        .save_memory(NewMemory {
            category: MemoryCategory::Preference,
            ..new_memory("semantic revision")
        })
        .await
        .unwrap();
    assert_eq!(revision.action, WriteAction::Superseded);
    assert_eq!(revision.previous_id, Some(first.memory.id));
    assert!((revision.matched_similarity.unwrap() - 0.882).abs() < 0.002);
    assert!(revision.memory.is_core_pin);
    let search_score = store
        .search(vector_only)
        .await
        .unwrap()
        .hits
        .into_iter()
        .find(|hit| hit.memory.id == revision.memory.id)
        .unwrap()
        .similarity_score;
    assert!((search_score - 0.767).abs() < 0.002);

    let updated = store
        .update_memory(UpdateMemoryRequest {
            memory_id: revision.memory.id,
            new_content: "near-identical".into(),
            reason: "Revised policy".into(),
            confidence: Some(0.8),
            source_client: Some("client".into()),
        })
        .await
        .unwrap();
    let refreshed = store
        .save_memory(NewMemory {
            category: MemoryCategory::Preference,
            confidence: Some(0.7),
            ..new_memory("exact meaning refreshed")
        })
        .await
        .unwrap();
    assert_eq!(refreshed.action, WriteAction::UpdatedExisting);
    assert_eq!(refreshed.memory.id, updated.memory.id);
    let history = store.memory_history(revision.memory.id).await.unwrap();
    assert_eq!(
        history.iter().map(|row| row.id).collect::<Vec<_>>(),
        [first.memory.id, revision.memory.id, updated.memory.id]
    );
    assert_eq!(history[1].version_reason.as_deref(), Some("Revised policy"));
    assert_eq!(history[0].superseded_by, Some(revision.memory.id));
    let graph = store
        .graph(GraphQuery {
            include_superseded: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(
        graph
            .edges
            .iter()
            .any(|edge| edge.edge_type == EdgeType::Supersedes
                && edge.source_id == updated.memory.id
                && edge.target_id == revision.memory.id)
    );
    assert_eq!(
        store.list_core_rules(None).await.unwrap()[0].id,
        updated.memory.id
    );
    assert_eq!(
        store.list_preferences(None).await.unwrap()[0].id,
        updated.memory.id
    );

    store
        .patch_memory(
            updated.memory.id,
            MemoryPatch {
                confidence: Some(0.6),
                reusable_snippet: Some(Some("public snippet".into())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store.delete_memory(revision.memory.id).await.unwrap();
    let remaining = store.memory_history(updated.memory.id).await.unwrap();
    assert_eq!(remaining.len(), 2);
    assert_eq!(remaining[0].superseded_by, Some(updated.memory.id));
    assert_eq!(remaining[1].confidence, 0.6);
}

#[tokio::test]
async fn encryption_roundtrip_removes_plaintext_from_all_retrieval_channels() {
    let dir = tempfile::tempdir().unwrap();
    let store = sqlite_store(&dir).await;
    let row = store
        .save_memory(NewMemory {
            is_core_pin: true,
            is_reusable: true,
            reusable_snippet: Some("payload".into()),
            ..new_memory("alpha confidential treasure")
        })
        .await
        .unwrap()
        .memory;
    let index = SqliteVec::open(&store, 3).await.unwrap();
    let protected = store
        .set_encrypted_payload(row.id, vec![1, 2], vec![3])
        .await
        .unwrap();
    assert_eq!(protected.content_hash, row.content_hash);
    assert_eq!(protected.content, "");
    assert!(protected.reusable_snippet.is_none());
    assert_eq!(index.count().await.unwrap(), 0);
    let result = store.search(search_request("confidential")).await.unwrap();
    assert!(result.hits.is_empty() && result.core_rules.is_empty());
    assert!(
        store
            .list_library(LibraryFilter::default())
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .clear_encrypted_payload(row.id, "wrong".into())
            .await
            .is_err()
    );
    let cleared = store
        .clear_encrypted_payload(row.id, row.content.clone())
        .await
        .unwrap();
    assert!(!cleared.is_encrypted && cleared.ciphertext.is_none() && cleared.nonce.is_none());
    assert_eq!(cleared.content, row.content);
    assert_eq!(index.count().await.unwrap(), 1);
    store.delete_memory(row.id).await.unwrap();
    assert_eq!(index.count().await.unwrap(), 0);
    assert!(store.get_memory(row.id).await.unwrap().is_none());
}

#[tokio::test]
async fn reusable_library_verifies_origin_records_usage_and_caps_context() {
    let dir = tempfile::tempdir().unwrap();
    let store = sqlite_store(&dir).await;
    let project = store
        .create_project(NewProject {
            name: "origin".into(),
            root_path: None,
            color_hex: None,
        })
        .await
        .unwrap();
    let path = dir.path().join("script.sh");
    std::fs::write(&path, "hello").unwrap();
    let doc = store
        .upsert_source_document(NewSourceDocument {
            project_id: Some(project.id),
            file_path: path.to_str().unwrap().into(),
            is_dir: false,
            source_type: None,
            file_hash: Some(crate::memory::content_hash("hello")),
            total_tokens: 150,
            is_watched: false,
        })
        .await
        .unwrap();
    let asset = store
        .save_memory(NewMemory {
            project_id: Some(project.id),
            source_doc_id: Some(doc.id),
            is_reusable: true,
            reusable_snippet: Some("echo hello".into()),
            ..new_memory("alpha summary")
        })
        .await
        .unwrap()
        .memory;
    store
        .save_memory(new_memory("beta ordinary"))
        .await
        .unwrap();
    let query = ReusableAssetQuery {
        query: "alpha".into(),
        source_type: Some(doc.source_type),
        current_project_id: None,
        exclude_current_project: true,
        top_k: Some(4),
        record_reuse: true,
    };
    let matches = store.search_reusable(query.clone()).await.unwrap();
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].availability, FileAvailability::Available);
    assert_eq!(matches[0].origin_project_name.as_deref(), Some("origin"));
    assert_eq!(matches[0].reuse_count, 1);
    assert!(
        store
            .search_reusable(ReusableAssetQuery {
                current_project_id: Some(project.id),
                record_reuse: false,
                ..query
            })
            .await
            .unwrap()
            .is_empty()
    );
    std::fs::write(&path, "changed").unwrap();
    assert_eq!(
        store.list_library(LibraryFilter::default()).await.unwrap()[0].availability,
        FileAvailability::Modified
    );
    std::fs::remove_file(path).unwrap();
    let library = store
        .list_library(LibraryFilter {
            availability: vec![FileAvailability::SnippetOnly],
            project_ids: vec![project.id],
            limit: Some(1),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(library[0].memory_id, asset.id);
    assert_eq!(library[0].reuse_count, 1);
    // record_reuse only bumps counters; reuse telemetry is recorded by the caller (cobalt-mcp).
    assert_eq!(
        store
            .query_telemetry(TelemetryQuery {
                operations: vec![TelemetryOperation::Reuse],
                ..Default::default()
            })
            .await
            .unwrap()
            .total,
        0
    );
    let pin = store
        .save_memory(NewMemory {
            is_core_pin: true,
            ..new_memory("Global instruction with several tokens and words")
        })
        .await
        .unwrap()
        .memory;
    let context = store
        .build_web_context(WebContextRequest {
            task: "alpha".into(),
            project_id: Some(project.id),
            max_tokens: Some(3),
        })
        .await
        .unwrap();
    assert_eq!(context.memory_ids, [pin.id]);
    assert_eq!(
        context.tokens as usize,
        TiktokenCounter::new(TokenEncoding::Cl100kBase).count(&context.text)
    );
    assert!(context.tokens <= 3 && context.text.starts_with("Global"));
}

#[tokio::test]
async fn governance_clusters_calibrated_duplicates_and_decay_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let store = calibrated_store(&dir).await;
    let mut settings = store.load_settings().await.unwrap();
    settings.search.dedup_threshold = 1.0;
    store.save_settings(&settings).await.unwrap();
    let first = store
        .save_memory(NewMemory {
            confidence: Some(0.7),
            ..new_memory("original")
        })
        .await
        .unwrap()
        .memory;
    let second = store
        .save_memory(NewMemory {
            is_core_pin: true,
            ..new_memory("near-identical")
        })
        .await
        .unwrap()
        .memory;
    let unrelated = store
        .save_memory(new_memory("unrelated"))
        .await
        .unwrap()
        .memory;
    let graph = store.graph(GraphQuery::default()).await.unwrap();
    assert!(
        graph
            .edges
            .iter()
            .any(|edge| edge.edge_type == EdgeType::Semantic
                && edge.source_id == second.id
                && edge.target_id == first.id
                && edge.weight > 0.99)
    );
    let duplicates = store.find_duplicates().await.unwrap();
    assert_eq!(duplicates.len(), 1);
    assert_eq!(duplicates[0].kind, DuplicateKind::Conflict);
    assert_eq!(duplicates[0].suggested_keep_id, second.id);
    assert!(!duplicates[0].memory_ids.contains(&unrelated.id));
    assert!(
        store
            .merge_duplicates(first.id, &[second.id, second.id])
            .await
            .unwrap()
            .is_core_pin
    );
    assert_eq!(
        store
            .get_memory(second.id)
            .await
            .unwrap()
            .unwrap()
            .superseded_by,
        Some(first.id)
    );

    let start = now();
    let later = start + TimeDelta::days(61);
    assert_eq!(store.run_decay(later).await.unwrap().decayed, 1);
    assert_eq!(store.run_decay(later).await.unwrap().decayed, 0);
    assert_eq!(
        store
            .get_memory(unrelated.id)
            .await
            .unwrap()
            .unwrap()
            .relevance_score,
        0.5
    );
    assert_eq!(
        store
            .run_decay(start + TimeDelta::days(181))
            .await
            .unwrap()
            .archived,
        1
    );
    assert_eq!(
        store
            .get_memory(first.id)
            .await
            .unwrap()
            .unwrap()
            .relevance_score,
        1.0
    );
    assert_eq!(
        store
            .restore_memories(&[unrelated.id, unrelated.id])
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .archive_memories(&[unrelated.id, unrelated.id])
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .get_memory(unrelated.id)
            .await
            .unwrap()
            .unwrap()
            .status,
        MemoryStatus::Archived
    );
}

#[tokio::test]
async fn branching_checks_target_scope_and_keeps_main_active() {
    let dir = tempfile::tempdir().unwrap();
    let store = calibrated_store(&dir).await;
    let main = store
        .save_memory(new_memory("original"))
        .await
        .unwrap()
        .memory;
    let duplicate_isolated = store
        .create_branch(NewBranch {
            name: "duplicate".into(),
            parent_branch_id: None,
        })
        .await
        .unwrap();
    assert_eq!(duplicate_isolated.parent_branch_id, Some(MAIN_BRANCH_ID));
    assert!(!duplicate_isolated.is_active);
    store.switch_branch(duplicate_isolated.id).await.unwrap();
    assert_eq!(
        store
            .save_memory(new_memory("original"))
            .await
            .unwrap()
            .action,
        WriteAction::Inserted
    );
    let merge = store.merge_branch(duplicate_isolated.id).await.unwrap();
    assert_eq!(merge.skipped_duplicates, 1);
    assert_eq!(store.active_branch().await.unwrap().id, MAIN_BRANCH_ID);

    let revision = store
        .create_branch(NewBranch {
            name: "revision".into(),
            parent_branch_id: None,
        })
        .await
        .unwrap();
    let branch_row = store
        .save_memory(NewMemory {
            branch_id: Some(revision.id),
            ..new_memory("semantic revision")
        })
        .await
        .unwrap()
        .memory;
    let merge = store.merge_branch(revision.id).await.unwrap();
    assert_eq!((merge.merged, merge.superseded), (1, 1));
    assert_eq!(
        store
            .get_memory(main.id)
            .await
            .unwrap()
            .unwrap()
            .superseded_by,
        Some(branch_row.id)
    );
    assert_eq!(
        store
            .get_memory(branch_row.id)
            .await
            .unwrap()
            .unwrap()
            .branch_id,
        MAIN_BRANCH_ID
    );

    let discarded = store
        .create_branch(NewBranch {
            name: "discard".into(),
            parent_branch_id: None,
        })
        .await
        .unwrap();
    store.switch_branch(discarded.id).await.unwrap();
    let row = store
        .save_memory(new_memory("unrelated"))
        .await
        .unwrap()
        .memory;
    store.discard_branch(discarded.id).await.unwrap();
    assert!(store.get_memory(row.id).await.unwrap().is_none());
    assert_eq!(store.list_branches().await.unwrap().len(), 1);
    assert!(store.discard_branch(MAIN_BRANCH_ID).await.is_err());
    assert!(store.merge_branch(MAIN_BRANCH_ID).await.is_err());
}

#[tokio::test]
async fn snapshots_use_online_backup_and_preserve_safety_catalog_and_search() {
    let dir = tempfile::tempdir().unwrap();
    let store = sqlite_store(&dir).await;
    let first = store
        .save_memory(new_memory("alpha before"))
        .await
        .unwrap()
        .memory;
    let target = store.create_snapshot("baseline").await.unwrap();
    assert_eq!(target.memory_count, 1);
    assert!(std::path::Path::new(&target.file_path).is_file());
    let later = store
        .save_memory(new_memory("beta after"))
        .await
        .unwrap()
        .memory;
    store.delete_memory(first.id).await.unwrap();
    assert_eq!(store.restore_snapshot(target.id).await.unwrap(), target);
    assert!(store.get_memory(later.id).await.unwrap().is_none());
    assert_eq!(
        store.search(search_request("alpha")).await.unwrap().hits[0]
            .memory
            .id,
        first.id
    );
    let snapshots = store.list_snapshots().await.unwrap();
    assert_eq!(snapshots.len(), 2);
    assert!(snapshots[0].label.contains("Safety snapshot"));
    store.restore_snapshot(snapshots[0].id).await.unwrap();
    assert!(store.get_memory(first.id).await.unwrap().is_none());
    assert_eq!(
        store.search(search_request("beta")).await.unwrap().hits[0]
            .memory
            .id,
        later.id
    );
    store.delete_snapshot(target.id).await.unwrap();
    assert!(!std::path::Path::new(&target.file_path).exists());
    assert_eq!(store.list_snapshots().await.unwrap().len(), 2);
}

#[tokio::test]
async fn handoff_theme_and_telemetry_repositories_persist_real_data() {
    let dir = tempfile::tempdir().unwrap();
    let store = sqlite_store(&dir).await;
    let project = store
        .create_project(NewProject {
            name: "repo".into(),
            root_path: None,
            color_hex: None,
        })
        .await
        .unwrap();
    let new = NewHandoff {
        project_id: None,
        source_client: "test".into(),
        summary: "Ready".into(),
        last_error: Some("previous error".into()),
        open_files: vec!["lib.rs".into()],
        ttl_hours: None,
    };
    let global = store.create_handoff(new.clone()).await.unwrap();
    assert_eq!(global.expires_at - global.created_at, TimeDelta::hours(48));
    let local = store
        .create_handoff(NewHandoff {
            project_id: Some(project.id),
            ..new.clone()
        })
        .await
        .unwrap();
    store
        .create_handoff(NewHandoff {
            ttl_hours: Some(0),
            ..new
        })
        .await
        .unwrap();
    let a = store.clone();
    let b = store.clone();
    let (x, y) = tokio::join!(
        a.resume_handoff(Some(project.id), "a"),
        b.resume_handoff(Some(project.id), "b")
    );
    let mut consumed = [x.unwrap().unwrap().id, y.unwrap().unwrap().id];
    consumed.sort();
    assert_eq!(consumed, [global.id, local.id]);
    assert!(
        store
            .resume_handoff(Some(project.id), "c")
            .await
            .unwrap()
            .is_none()
    );

    let theme = InstalledTheme {
        id: "theme".into(),
        name: "Theme".into(),
        author: "Author".into(),
        version: "1.2.3".into(),
        size_bytes: 20,
        hardware_tier: HardwareTier::Eco,
        local_path: "local".into(),
        installed_at: global.created_at,
    };
    store.record_installed_theme(theme.clone()).await.unwrap();
    assert_eq!(
        store.list_installed_themes().await.unwrap(),
        std::slice::from_ref(&theme)
    );
    store
        .record_installed_theme(InstalledTheme {
            size_bytes: 21,
            ..theme.clone()
        })
        .await
        .unwrap();
    assert_eq!(
        store.list_installed_themes().await.unwrap()[0].size_bytes,
        21
    );
    store.remove_installed_theme(&theme.id).await.unwrap();
    assert!(store.list_installed_themes().await.unwrap().is_empty());

    let doc = store
        .upsert_source_document(NewSourceDocument {
            project_id: None,
            file_path: dir.path().join("doc.md").to_str().unwrap().into(),
            is_dir: false,
            source_type: None,
            file_hash: None,
            total_tokens: 100,
            is_watched: false,
        })
        .await
        .unwrap();
    let memory = store
        .save_memory(new_memory("alpha usage"))
        .await
        .unwrap()
        .memory;
    store
        .search(SearchRequest {
            record_hits: true,
            ..search_request("alpha")
        })
        .await
        .unwrap();
    let item = ReturnedItem {
        memory_id: memory.id,
        source_doc_id: Some(doc.id),
        similarity_score: 0.8,
        chunk_tokens: 8,
        content_snapshot: Some("sample".into()),
    };
    let items = vec![
        item.clone(),
        item.clone(),
        ReturnedItem {
            source_doc_id: None,
            ..item
        },
    ];
    assert_eq!(store.compute_avoided_tokens(&items).await.unwrap(), 108);
    let log = store
        .record_event(NewTelemetryEvent {
            client_name: "reader".into(),
            operation: TelemetryOperation::Read,
            query_text: Some("READ ME".into()),
            returned_items: items,
            injected_tokens: 20,
            output_tokens_saved: 5,
            latency_ms: 2,
            project_id: Some(project.id),
        })
        .await
        .unwrap();
    assert_eq!((log.saved_tokens, log.avoided_full_tokens), (88, 108));
    let page = store
        .query_telemetry(TelemetryQuery {
            client_name: Some("reader".into()),
            project_id: Some(project.id),
            text: Some("read me".into()),
            operations: vec![TelemetryOperation::Read],
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.items, std::slice::from_ref(&log));
    let summary = store
        .telemetry_summary(TelemetryRange {
            session_only: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        (
            summary.total_saved_tokens,
            summary.session_saved_tokens,
            summary.saved_from_reads
        ),
        (88, 88, 88)
    );
    assert_eq!(summary.timeline[0].operations, 1);
    assert_eq!(summary.by_client[0].reads, 1);
    assert_eq!(summary.top_nodes[0].memory_id, memory.id);

    let req = UsageStatsRequest {
        year: chrono::Datelike::year(&log.timestamp),
        utc_offset_minutes: 0,
    };
    let usage_before = store.usage_stats(req).await.unwrap();
    assert_eq!(usage_before.all_time.requests, 1);
    assert_eq!(usage_before.all_time.saved_tokens, 88);
    let mut settings = store.load_settings().await.unwrap();
    settings.retention.detailed_log_limit = 0;
    store.save_settings(&settings).await.unwrap();
    assert_eq!(store.apply_retention().await.unwrap(), 1);
    assert_eq!(store.apply_retention().await.unwrap(), 0);
    let usage_after = store.usage_stats(req).await.unwrap();
    assert_eq!(usage_after.all_time, usage_before.all_time);
    assert_eq!(usage_after.days, usage_before.days);
    let purged = store.get_telemetry_log(log.id).await.unwrap().unwrap();
    assert_eq!(purged.saved_tokens, log.saved_tokens);
    assert_eq!(purged.returned_items.len(), 3);
    assert!(
        purged.query_text.is_none()
            && purged
                .returned_items
                .iter()
                .all(|item| item.content_snapshot.is_none())
    );
}

struct SwapEmbedderMock {
    spec: EmbeddingModelSpec,
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
    fail_documents: bool,
}

#[async_trait]
impl Embedder for SwapEmbedderMock {
    fn spec(&self) -> &EmbeddingModelSpec {
        &self.spec
    }

    async fn embed_documents(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        if self.fail_documents {
            return Err(CobaltError::Embedding("injected migration failure".into()));
        }
        Ok(texts
            .iter()
            .map(|text| {
                let mut vector = DeterministicEmbedderMock::embedding(text);
                vector.push(0.2);
                vector
            })
            .collect())
    }

    async fn embed_query(&self, text: &str) -> Result<Vec<f32>> {
        if text == "Cobalt vector index verification" && !self.fail_documents {
            self.entered.notify_one();
            self.release.notified().await;
        }
        let mut vector = DeterministicEmbedderMock::embedding(text);
        vector.push(0.2);
        Ok(vector)
    }
}

#[tokio::test]
async fn engine_swap_reuses_vectors_queues_writes_reembeds_and_rolls_back() {
    let dir = tempfile::tempdir().unwrap();
    let store = sqlite_store(&dir).await;
    let old = store
        .save_memory(new_memory("alpha migration"))
        .await
        .unwrap()
        .memory;
    let hidden = store
        .save_memory(new_memory("beta private"))
        .await
        .unwrap()
        .memory;
    store
        .set_encrypted_payload(hidden.id, vec![1], vec![2])
        .await
        .unwrap();
    let snapshot = store.create_snapshot("before swap").await.unwrap();
    let phases = Arc::new(Mutex::new(Vec::new()));
    let progress: cobalt_core::traits::ProgressSink<cobalt_core::engine::EngineSwapProgress> = {
        let phases = phases.clone();
        Arc::new(move |progress| {
            phases
                .lock()
                .unwrap()
                .push((progress.phase, progress.queued_writes))
        })
    };
    let to_usearch = EngineSwapRequest {
        target_engine: EngineKind::Usearch,
        target_model_id: "phase-one-test".into(),
        external_endpoint: None,
    };
    let report = store
        .swap_engine(to_usearch, progress.clone())
        .await
        .unwrap();
    assert_eq!((report.reembedded, report.verified_count), (0, 1));
    assert_eq!(
        store.load_settings().await.unwrap().vector_engine,
        EngineKind::Usearch
    );
    assert_eq!(
        store.search(search_request("alpha")).await.unwrap().hits[0]
            .memory
            .id,
        old.id
    );

    let active_index = Usearch::open(&store, "phase-one-test", 3).await.unwrap();
    let external_memory = store
        .save_memory(new_memory("beta indexed externally"))
        .await
        .unwrap()
        .memory;
    assert_eq!(active_index.count().await.unwrap(), 2);
    store
        .set_encrypted_payload(external_memory.id, vec![1], vec![2])
        .await
        .unwrap();
    assert_eq!(active_index.count().await.unwrap(), 1);
    store
        .clear_encrypted_payload(external_memory.id, external_memory.content)
        .await
        .unwrap();
    assert_eq!(active_index.count().await.unwrap(), 2);
    store.delete_memory(external_memory.id).await.unwrap();
    assert_eq!(active_index.count().await.unwrap(), 1);

    let mut spec = default_model_spec(HardwareTier::Eco);
    spec.id = "phase-two-test".into();
    spec.dimensions = 4;
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let target = EngineSwapRequest {
        target_engine: EngineKind::SqliteVec,
        target_model_id: spec.id.clone(),
        external_endpoint: None,
    };
    let swap = tokio::spawn({
        let store = store.clone();
        let embedder = Arc::new(SwapEmbedderMock {
            spec: spec.clone(),
            entered: entered.clone(),
            release: release.clone(),
            fail_documents: false,
        });
        let progress = progress.clone();
        let target = target.clone();
        async move {
            store
                .swap_engine_with_embedder(target, embedder, progress)
                .await
        }
    });
    entered.notified().await;
    let waiting = tokio::spawn({
        let store = store.clone();
        async move { store.save_memory(new_memory("beta queued")).await }
    });
    while store
        .waiting_for_engine
        .load(std::sync::atomic::Ordering::Relaxed)
        == 0
    {
        tokio::task::yield_now().await;
    }
    assert!(!waiting.is_finished());
    release.notify_one();
    let report = swap.await.unwrap().unwrap();
    let queued_id = waiting.await.unwrap().unwrap().memory.id;
    assert_eq!((report.reembedded, report.verified_count), (1, 1));
    assert_eq!(
        SqliteVec::open(&store, 4)
            .await
            .unwrap()
            .count()
            .await
            .unwrap(),
        2
    );
    let current = store.get_memory(old.id).await.unwrap().unwrap();
    assert_ne!(
        (current.pos_x, current.pos_y, current.pos_z),
        (old.pos_x, old.pos_y, old.pos_z)
    );
    assert!(
        phases
            .lock()
            .unwrap()
            .iter()
            .any(|&(phase, queue)| phase == EngineSwapPhase::Reindexing && queue > 0)
    );

    let bad_spec = EmbeddingModelSpec {
        id: "bad-model".into(),
        ..spec.clone()
    };
    let failed = store
        .swap_engine_with_embedder(
            EngineSwapRequest {
                target_model_id: bad_spec.id.clone(),
                ..target
            },
            Arc::new(SwapEmbedderMock {
                spec: bad_spec,
                entered,
                release,
                fail_documents: true,
            }),
            progress,
        )
        .await;
    assert!(matches!(failed, Err(CobaltError::Embedding(_))));
    assert_eq!(
        phases.lock().unwrap().last().unwrap().0,
        EngineSwapPhase::RolledBack
    );
    assert_eq!(
        store.load_settings().await.unwrap().embedding_model_id,
        spec.id
    );
    assert_eq!(
        store
            .search(search_request("beta queued"))
            .await
            .unwrap()
            .hits[0]
            .memory
            .id,
        queued_id
    );

    store.restore_snapshot(snapshot.id).await.unwrap();
    assert!(store.get_memory(queued_id).await.unwrap().is_none());
    assert_eq!(
        store.load_settings().await.unwrap().embedding_model_id,
        spec.id
    );
    assert_eq!(
        SqliteVec::open(&store, 4)
            .await
            .unwrap()
            .count()
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        store.search(search_request("alpha")).await.unwrap().hits[0]
            .memory
            .id,
        old.id
    );
    assert!(
        store
            .get_memory(hidden.id)
            .await
            .unwrap()
            .unwrap()
            .is_encrypted
    );
}

#[tokio::test]
async fn archive_similarity_and_usage_follow_phase_three_contract() {
    let dir = tempfile::tempdir().unwrap();
    let store = calibrated_store(&dir).await;
    let row = store
        .save_memory(new_memory("original"))
        .await
        .unwrap()
        .memory;
    assert!(
        store
            .find_similar("semantic revision", None, 0.9)
            .await
            .unwrap()
            .is_none()
    );
    let (matched, similarity) = store
        .find_similar("semantic revision", None, 0.8)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(matched.id, row.id);
    assert!((similarity - 0.8818).abs() < 0.001);

    let item = ReturnedItem {
        memory_id: row.id,
        source_doc_id: None,
        similarity_score: 1.0,
        chunk_tokens: 4,
        content_snapshot: Some(row.content.clone()),
    };
    for (client, operation, copies) in [
        ("other", TelemetryOperation::Read, 2),
        ("other", TelemetryOperation::Reuse, 1),
        ("writer", TelemetryOperation::Write, 1),
    ] {
        store
            .record_event(NewTelemetryEvent {
                client_name: client.into(),
                operation,
                query_text: None,
                returned_items: vec![item.clone(); copies],
                injected_tokens: 0,
                output_tokens_saved: 0,
                latency_ms: 0,
                project_id: None,
            })
            .await
            .unwrap();
    }
    let usage = store.memory_usage_by_client(row.id).await.unwrap();
    assert_eq!(usage.len(), 1);
    assert_eq!(usage[0].client_name, "other");
    assert_eq!(usage[0].uses, 2);
    let archived = store
        .archive_memory(row.id, "No longer applies")
        .await
        .unwrap();
    assert_eq!(archived.status, MemoryStatus::Archived);
    assert_eq!(
        archived.version_reason.as_deref(),
        Some("No longer applies")
    );
    assert!(
        store
            .find_similar("original", None, 0.9)
            .await
            .unwrap()
            .is_none()
    );
    store.restore_memories(&[row.id]).await.unwrap();
    assert!(
        store
            .find_similar("original", None, 0.9)
            .await
            .unwrap()
            .is_some()
    );
    store
        .patch_memory(
            row.id,
            MemoryPatch {
                is_core_pin: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        store.archive_memory(row.id, "Obsolete").await,
        Err(CobaltError::Conflict(_))
    ));
}

#[cfg(feature = "lancedb")]
#[tokio::test]
async fn lancedb_swap_preserves_search_writes_and_reopens_published_generation() {
    let dir = tempfile::tempdir().unwrap();
    let store = calibrated_store(&dir).await;
    let original = store
        .save_memory(new_memory("original"))
        .await
        .unwrap()
        .memory;
    let spec = default_model_spec(HardwareTier::Eco);
    let path = dir.path().join("local-lance");
    let request = EngineSwapRequest {
        target_engine: EngineKind::LanceDb,
        target_model_id: spec.id,
        external_endpoint: Some(path.to_str().unwrap().into()),
    };
    let report = store.swap_engine(request, Arc::new(|_| {})).await.unwrap();
    assert_eq!((report.verified_count, report.reembedded), (1, 0));
    assert_eq!(
        store
            .find_similar("original", None, 0.9)
            .await
            .unwrap()
            .unwrap()
            .0
            .id,
        original.id
    );
    let next = store
        .save_memory(new_memory("unrelated"))
        .await
        .unwrap()
        .memory;
    assert_eq!(
        store
            .find_similar("unrelated", None, 0.9)
            .await
            .unwrap()
            .unwrap()
            .0
            .id,
        next.id
    );
    store.delete_memory(original.id).await.unwrap();
    let mut spec = default_model_spec(HardwareTier::Eco);
    spec.dimensions = 2;
    drop(store);
    let store = SqliteStore::open_at(dir.path().join("cobalt.db"))
        .await
        .unwrap()
        .with_external_index(
            path.to_str().unwrap(),
            None,
            Arc::new(CalibratedEmbedderMock(spec)),
            Arc::new(TiktokenCounter::new(TokenEncoding::Cl100kBase)),
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .find_similar("unrelated", None, 0.9)
            .await
            .unwrap()
            .unwrap()
            .0
            .id,
        next.id
    );
    assert!(store.get_memory(original.id).await.unwrap().is_none());
}
