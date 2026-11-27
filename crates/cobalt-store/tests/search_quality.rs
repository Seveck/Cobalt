//! Run against a quiescent snapshot with installed model artifacts and a private TSV:
//! COBALT_HOME=/path/to/model-home COBALT_EVAL_SNAPSHOT=/path/to/snapshot \
//! COBALT_EVAL_LABELS=/path/to/labels.tsv cargo test -p cobalt-store --test search_quality \
//!     -- --ignored --nocapture
//! The TSV has [off_topic], [identifier], and [natural] sections. Each row is a query,
//! followed for labeled hits by a tab and comma-separated acceptable memory UUIDs.
//! Keep brain-derived labels outside the repository.

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use cobalt_core::engine::MODEL_MULTILINGUAL_E5_SMALL;
use cobalt_core::enums::{MemoryStatus, TokenEncoding};
use cobalt_core::ids::{Id, MAIN_BRANCH_ID};
use cobalt_core::search::{ProjectScope, SearchRequest};
use cobalt_core::traits::{Embedder, MemoryRepository, ProjectRepository, SearchService};
use cobalt_embeddings::{FastembedEmbedder, TiktokenCounter};
use cobalt_store::SqliteStore;

const TIMING_PASSES: usize = 3;
const SECTIONS: [&str; 3] = ["[off_topic]", "[identifier]", "[natural]"];

#[tokio::test]
#[ignore = "requires a private snapshot, its labels, and installed multilingual-e5-small"]
async fn snapshot_search_quality() {
    let snapshot = PathBuf::from(std::env::var_os("COBALT_EVAL_SNAPSHOT").unwrap());
    let labels = fs::read_to_string(std::env::var_os("COBALT_EVAL_LABELS").unwrap()).unwrap();
    let copy = tempfile::tempdir().unwrap();
    let model_index = format!("index/usearch-{MODEL_MULTILINGUAL_E5_SMALL}");
    fs::create_dir_all(copy.path().join(&model_index)).unwrap();
    let index = format!("{model_index}/index.usearch");
    for file in ["cobalt.db", index.as_str()] {
        fs::copy(snapshot.join(file), copy.path().join(file)).unwrap();
    }
    let wal = snapshot.join("cobalt.db-wal");
    if wal.exists() {
        fs::copy(wal, copy.path().join("cobalt.db-wal")).unwrap();
    }

    let embedder = Arc::new(FastembedEmbedder::from_catalog(MODEL_MULTILINGUAL_E5_SMALL).unwrap());
    embedder.embed_query("warm up").await.unwrap();
    let store = SqliteStore::open_at(copy.path().join("cobalt.db"))
        .await
        .unwrap()
        .with_usearch(
            embedder,
            Arc::new(TiktokenCounter::new(TokenEncoding::Cl100kBase)),
        )
        .await
        .unwrap();
    let project = store.find_project_by_name("Cobalt").await.unwrap().unwrap();
    let mut section = None;
    let mut cases = Vec::new();
    let mut seen = HashSet::new();
    for line in labels.lines().filter(|line| !line.trim().is_empty()) {
        if let Some(index) = SECTIONS.iter().position(|name| *name == line) {
            section = Some(index);
            continue;
        }
        let category = section.expect("case must follow a section header");
        let (query, ids) = line.split_once('\t').unwrap_or((line, ""));
        assert!(seen.insert(query), "duplicate query");
        let expected: Vec<Id> = ids
            .split(',')
            .filter(|id| !id.is_empty())
            .map(|id| id.parse().unwrap())
            .collect();
        assert_eq!(
            expected.is_empty(),
            category == 0,
            "case {}",
            cases.len() + 1
        );
        for id in &expected {
            let memory = store.get_memory(*id).await.unwrap().expect("unknown label");
            assert!(memory.project_id.is_none_or(|id| id == project.id));
            assert_eq!(memory.status, MemoryStatus::Active);
            assert_eq!(memory.branch_id, MAIN_BRANCH_ID);
            assert!(!memory.is_encrypted);
        }
        cases.push((category, query, expected));
    }
    assert!(cases.len() >= 25);
    for category in 0..SECTIONS.len() {
        assert!(cases.iter().any(|(value, ..)| *value == category));
    }

    for top_k in [3, 5] {
        let mut passed = [0; 3];
        let mut totals = [0; 3];
        let mut latencies = Vec::new();
        for pass in 0..TIMING_PASSES {
            for (index, (category, query, expected)) in cases.iter().enumerate() {
                let started = Instant::now();
                let response = store
                    .search(SearchRequest {
                        query: (*query).to_owned(),
                        scope: ProjectScope::ProjectAndGlobal(project.id),
                        branch_id: None,
                        top_k: Some(top_k),
                        include_archived: false,
                        filter: Default::default(),
                        rrf_override: None,
                        record_hits: false,
                    })
                    .await
                    .unwrap();
                latencies.push(started.elapsed().as_secs_f64() * 1_000.0);
                if pass != 0 {
                    continue;
                }
                let success = match category {
                    0 => response.hits.is_empty(),
                    1 => response
                        .hits
                        .first()
                        .is_some_and(|hit| expected.contains(&hit.memory.id)),
                    _ => response
                        .hits
                        .iter()
                        .take(3)
                        .any(|hit| expected.contains(&hit.memory.id)),
                };
                totals[*category] += 1;
                passed[*category] += usize::from(success);
                let hits: Vec<_> = response
                    .hits
                    .iter()
                    .map(|hit| (hit.memory.id, hit.similarity_score, hit.fts_rank))
                    .collect();
                println!(
                    "k={top_k} case={} {} pass={success} hits={hits:.3?}",
                    index + 1,
                    SECTIONS[*category]
                );
            }
        }
        latencies.sort_by(f64::total_cmp);
        let percentile = |p: usize| latencies[(p * latencies.len()).div_ceil(100) - 1];
        for (index, label) in SECTIONS.iter().enumerate() {
            println!("k={top_k} {label} {}/{}", passed[index], totals[index]);
        }
        println!(
            "k={top_k} latency_ms p50={:.2} p95={:.2}",
            percentile(50),
            percentile(95)
        );
    }
}
