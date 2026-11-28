use std::collections::HashMap;

use cobalt_core::enums::WriteAction;
use cobalt_core::model::NewBranch;
use cobalt_core::traits::{BranchRepository, GovernanceService};

use super::*;

struct RecordedEmbedderMock {
    spec: EmbeddingModelSpec,
    vectors: HashMap<String, Vec<f32>>,
}

#[async_trait]
impl Embedder for RecordedEmbedderMock {
    fn spec(&self) -> &EmbeddingModelSpec {
        &self.spec
    }

    async fn embed_documents(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        Ok(texts
            .iter()
            .map(|text| self.vectors[text].clone())
            .collect())
    }

    async fn embed_query(&self, text: &str) -> Result<Vec<f32>> {
        Ok(self.vectors[text].clone())
    }
}

const DIMENSIONS: usize = 32;

#[test]
fn conflict_patterns_require_the_same_assertion_or_context() {
    for (a, b, expected) in [
        ("Don't use the cache.", "Use the cache.", Some("negation")),
        ("No usamos SQLite", "Sí usamos SQLite", Some("negation")),
        (
            "Set retry delay to -2.5 seconds",
            "Set retry delay to +2.5 seconds",
            Some("different_value"),
        ),
        (
            "Enable retries in production",
            "Disable retries in production",
            Some("opposite_choice"),
        ),
        ("Do not use Redis", "Use SQLite", None),
        ("Use Rust in development", "Use Go in production", None),
        ("Use Rust and Go", "Use Go", None),
        ("Worker count is 4", "Thread count is 8", None),
    ] {
        assert_eq!(crate::conflicts::reason(a, b), expected, "{a:?} / {b:?}");
        assert_eq!(crate::conflicts::reason(b, a), expected, "{b:?} / {a:?}");
    }
}

fn embedding(axis: usize, cosine: f32) -> Vec<f32> {
    let mut vector = vec![0.0; DIMENSIONS];
    vector[0] = cosine;
    vector[axis] = (1.0 - cosine * cosine).sqrt();
    vector
}

#[tokio::test]
async fn mixed_scope_prefers_comparable_project_hits_including_exact_identifiers() {
    let dir = tempfile::tempdir().unwrap();
    let docs = [
        "Settings for route-cache",
        "The route-cache holds routing requests while the gateway is down",
    ];
    let store = lexical_fixture(&dir, &docs).await;
    let project = store
        .create_project(NewProject {
            name: "Routing".into(),
            root_path: None,
            color_hex: None,
        })
        .await
        .unwrap();
    let global = store.save_memory(new_memory(docs[0])).await.unwrap().memory;
    let local = store
        .save_memory(NewMemory {
            project_id: Some(project.id),
            ..new_memory(docs[1])
        })
        .await
        .unwrap()
        .memory;

    for query in ["route cache", "route-cache"] {
        let global_only = store.search(lexical_request(query)).await.unwrap().hits;
        let mixed = store
            .search(SearchRequest {
                scope: ProjectScope::ProjectAndGlobal(project.id),
                ..lexical_request(query)
            })
            .await
            .unwrap()
            .hits;
        assert_eq!(mixed.len(), 2);
        assert_eq!(mixed[0].memory.id, local.id);
        assert_eq!(mixed[1].memory.id, global.id);
        assert_eq!(mixed[1].fts_rank, Some(1));
        assert_eq!(mixed[1].rrf_score, global_only[0].rrf_score);
        assert!(mixed[1].score < global_only[0].score);
        assert!(mixed.iter().all(|hit| hit.outranked_by.is_none()));

        let sharper_rank_decay = store
            .search(SearchRequest {
                scope: ProjectScope::ProjectAndGlobal(project.id),
                rrf_override: Some(RrfWeights {
                    k: 0.0,
                    vector_weight: 0.0,
                    ..Default::default()
                }),
                ..lexical_request(query)
            })
            .await
            .unwrap()
            .hits;
        assert_eq!(sharper_rank_decay[0].memory.id, global.id);
    }
}

#[tokio::test]
async fn newer_conflicts_lead_their_group_and_unrelated_hits_keep_their_order() {
    let dir = tempfile::tempdir().unwrap();
    let docs = [
        ("Set retry delay to 2 seconds", 1.0),
        ("Set retry delay to 3 seconds", 1.0),
        ("Set retry delay to 4 seconds", 0.0),
        ("Retry delay documentation", 1.0),
        ("Retry delay metrics", 0.5),
    ];
    let store = lexical_fixture(&dir, &docs.map(|(text, _)| text)).await;
    let mut ids = Vec::new();
    for (content, confidence) in docs {
        ids.push(
            store
                .save_memory(NewMemory {
                    confidence: Some(confidence),
                    ..new_memory(content)
                })
                .await
                .unwrap()
                .memory
                .id,
        );
    }
    let older = [ids[0], ids[1]];
    store
        .db
        .write(move |conn| {
            conn.execute(
                "UPDATE memories SET updated_at = '2000-01-01T00:00:00Z' WHERE id IN (?1, ?2)",
                older.map(|id| id.to_string()),
            )
            .unwrap();
            Ok(())
        })
        .await
        .unwrap();

    let hits = store
        .search(lexical_request("retry delay"))
        .await
        .unwrap()
        .hits;
    let conflicts: Vec<_> = hits
        .iter()
        .skip_while(|hit| hit.memory.id != ids[2])
        .take(3)
        .collect();
    assert_eq!(conflicts.len(), 3);
    assert_eq!(conflicts[0].outranked_by, None);
    for hit in &conflicts[1..] {
        assert!(older.contains(&hit.memory.id));
        assert_eq!(hit.outranked_by, Some(ids[2]));
        assert!(hit.score > conflicts[0].score);
    }
    let unrelated: Vec<_> = hits
        .iter()
        .filter(|hit| ids[3..].contains(&hit.memory.id))
        .collect();
    assert_eq!(unrelated.len(), 2);
    assert!(unrelated[0].score > unrelated[1].score);
    assert!(unrelated.iter().all(|hit| hit.outranked_by.is_none()));

    let hits = store
        .search(lexical_request("documentation metrics"))
        .await
        .unwrap()
        .hits;
    assert_eq!(hits.len(), 2);
    assert!(hits[0].score > hits[1].score);
    assert!(hits.iter().all(|hit| hit.outranked_by.is_none()));
}

#[tokio::test]
async fn nuclear_laws_keep_their_rank_score_and_rule_list() {
    let dir = tempfile::tempdir().unwrap();
    let docs = ["Never use retries", "Use retries"];
    let store = lexical_fixture(&dir, &docs).await;
    let project = store
        .create_project(NewProject {
            name: "Retries".into(),
            root_path: None,
            color_hex: None,
        })
        .await
        .unwrap();
    let law = store
        .save_memory(NewMemory {
            is_core_pin: true,
            ..new_memory(docs[0])
        })
        .await
        .unwrap()
        .memory;
    let local = store
        .save_memory(NewMemory {
            project_id: Some(project.id),
            ..new_memory(docs[1])
        })
        .await
        .unwrap()
        .memory;

    let request = lexical_request("never use retries");
    let global = store.search(request.clone()).await.unwrap();
    let mixed = store
        .search(SearchRequest {
            scope: ProjectScope::ProjectAndGlobal(project.id),
            ..request
        })
        .await
        .unwrap();
    assert_eq!(mixed.core_rules, vec![law]);
    assert_eq!(mixed.hits.len(), 2);
    assert_eq!(mixed.hits[0], global.hits[0]);
    assert_eq!(mixed.hits[1].memory.id, local.id);
    assert_eq!(mixed.hits[1].outranked_by, None);
}

async fn recorded_store(
    dir: &tempfile::TempDir,
    vectors: impl IntoIterator<Item = (&str, Vec<f32>)>,
    calibrated: bool,
) -> SqliteStore {
    let mut spec = default_model_spec(HardwareTier::Eco);
    if !calibrated {
        spec.id = "stage-four-fixture".into();
    }
    spec.dimensions = DIMENSIONS as u32;
    SqliteStore::open_at(dir.path().join("cobalt.db"))
        .await
        .unwrap()
        .with_sqlite_vec(
            Arc::new(RecordedEmbedderMock {
                spec,
                vectors: vectors
                    .into_iter()
                    .map(|(text, vector)| (text.to_owned(), vector))
                    .collect(),
            }),
            Arc::new(TiktokenCounter::new(TokenEncoding::Cl100kBase)),
        )
        .await
        .unwrap()
}

async fn lexical_fixture(dir: &tempfile::TempDir, docs: &[&str]) -> SqliteStore {
    recorded_store(
        dir,
        docs.iter()
            .enumerate()
            .map(|(index, text)| (*text, embedding(index + 1, 0.0))),
        false,
    )
    .await
}

fn lexical_request(query: &str) -> SearchRequest {
    SearchRequest {
        rrf_override: Some(RrfWeights {
            vector_weight: 0.0,
            ..Default::default()
        }),
        ..search_request(query)
    }
}

#[tokio::test]
async fn expanded_project_neighbor_beats_a_newer_conflicting_global_hit() {
    let dir = tempfile::tempdir().unwrap();
    let store = recorded_store(
        &dir,
        [
            ("caching", embedding(1, 1.0)),
            ("Use Redis for caching", embedding(1, 1.0)),
            ("Use SQLite for caching", embedding(2, 0.60)),
            ("Caching documentation", embedding(3, 0.59)),
        ],
        false,
    )
    .await;
    let project = store
        .create_project(NewProject {
            name: "Caching".into(),
            root_path: None,
            color_hex: None,
        })
        .await
        .unwrap();
    let local = store
        .save_memory(NewMemory {
            project_id: Some(project.id),
            ..new_memory("Use SQLite for caching")
        })
        .await
        .unwrap()
        .memory;
    let global = store
        .save_memory(new_memory("Use Redis for caching"))
        .await
        .unwrap()
        .memory;
    let unrelated = store
        .save_memory(new_memory("Caching documentation"))
        .await
        .unwrap()
        .memory;
    store
        .db
        .write(move |conn| {
            conn.execute(
                "UPDATE memories SET updated_at = '2000-01-01T00:00:00Z' WHERE id = ?1",
                [local.id.to_string()],
            )
            .unwrap();
            for (id, weight) in [(local.id, 0.80), (unrelated.id, 0.90)] {
                conn.execute(
                    "INSERT INTO memory_edges VALUES (?1, ?2, 'semantic', ?3)",
                    params![global.id.to_string(), id.to_string(), weight],
                )
                .unwrap();
            }
            Ok(())
        })
        .await
        .unwrap();

    let request = SearchRequest {
        scope: ProjectScope::ProjectAndGlobal(project.id),
        top_k: Some(2),
        rrf_override: Some(RrfWeights {
            fts_weight: 0.0,
            ..Default::default()
        }),
        ..search_request("caching")
    };
    let direct = store.search(request.clone()).await.unwrap().hits;
    assert_eq!(direct.len(), 1);
    assert_eq!(direct[0].memory.id, global.id);
    assert_eq!(direct[0].outranked_by, None);

    let hits = store
        .search(SearchRequest {
            expand_graph: true,
            ..request
        })
        .await
        .unwrap()
        .hits;
    assert_eq!(hits.len(), 2);
    assert_eq!(hits[0].memory.id, local.id);
    assert_eq!(hits[0].related_to, Some(global.id));
    assert_eq!(hits[0].outranked_by, None);
    assert_eq!(hits[1].memory.id, global.id);
    assert_eq!(hits[1].outranked_by, Some(local.id));
    assert!(hits[1].score > hits[0].score);
    assert!(hits[1].memory.updated_at > hits[0].memory.updated_at);
}

#[tokio::test]
async fn graph_expansion_preserves_direct_order_and_respects_scope_and_budgets() {
    let dir = tempfile::tempdir().unwrap();
    let records = [
        ("routing routing overview", 1.0),
        ("Network controls", 0.92),
        ("Fallback cluster", 0.59),
        ("Retry schedule", 0.58),
        ("Regional pool", 0.57),
        ("Timeout defaults", 0.56),
        ("Historical mapping", 0.60),
        ("Different project", 0.60),
        ("Different branch", 0.60),
        ("Weak association", 0.29),
        ("Deprecated definition", 0.60),
        ("Another hop", 0.61),
        ("Revised definition", 0.62),
        ("Intermediate definition", 0.63),
    ];
    let store = recorded_store(
        &dir,
        records
            .iter()
            .enumerate()
            .map(|(i, (text, _))| (*text, embedding(i + 1, 0.0)))
            .chain([
                ("routing", embedding(1, 1.0)),
                ("origami", embedding(31, 0.0)),
            ]),
        false,
    )
    .await;
    let project = store
        .create_project(NewProject {
            name: "Elsewhere".into(),
            root_path: None,
            color_hex: None,
        })
        .await
        .unwrap();
    let other_branch = store
        .create_branch(NewBranch {
            name: "draft".into(),
            parent_branch_id: None,
        })
        .await
        .unwrap();
    let mut memories = Vec::new();
    for (i, (text, _)) in records.iter().enumerate() {
        memories.push(
            store
                .save_memory(NewMemory {
                    branch_id: Some(if i == 8 {
                        other_branch.id
                    } else {
                        MAIN_BRANCH_ID
                    }),
                    project_id: (i == 7).then_some(project.id),
                    is_reusable: i != 3,
                    ..new_memory(text)
                })
                .await
                .unwrap()
                .memory,
        );
    }
    store
        .archive_memory(memories[6].id, "out of date")
        .await
        .unwrap();
    let ids: Vec<_> = memories.iter().map(|row| row.id).collect();
    let graph_ids = ids.clone();
    store
        .db
        .write(move |conn| {
            crate::memory::mark_superseded(conn, graph_ids[10], graph_ids[13], "revision", 1.0)?;
            crate::memory::mark_superseded(conn, graph_ids[13], graph_ids[12], "revision", 1.0)?;
            for (source, target, kind, weight) in [
                (0, 1, "semantic", 1.0),      // already direct
                (2, 0, "semantic", 0.82),     // incoming semantic edge
                (0, 2, "same_project", 0.72), // same neighbor via another edge
                (0, 3, "same_project", 0.71),
                (0, 4, "semantic", 0.69), // over the first parent's budget
                (1, 2, "semantic", 0.99), // already returned with the first parent
                (1, 5, "semantic", 0.60),
                (1, 6, "semantic", 0.99),      // archived
                (1, 7, "semantic", 0.99),      // out of project scope
                (1, 8, "semantic", 0.99),      // out of branch scope
                (1, 9, "semantic", 1.0),       // below the query threshold
                (1, 10, "same_project", 0.50), // resolve the linked historical endpoint
                (2, 11, "semantic", 1.0),      // two hops from the direct hits
            ] {
                conn.execute(
                    "INSERT INTO memory_edges VALUES (?1, ?2, ?3, ?4)",
                    params![
                        graph_ids[source].to_string(),
                        graph_ids[target].to_string(),
                        kind,
                        weight
                    ],
                )
                .unwrap();
            }
            Ok(())
        })
        .await
        .unwrap();
    let vectors: Vec<_> = memories
        .iter()
        .zip(records)
        .enumerate()
        .map(|(i, (row, (_, cosine)))| VectorRecord {
            memory_id: row.id,
            vector: embedding(i + 1, cosine),
            project_id: row.project_id,
            branch_id: row.branch_id,
            is_reusable: row.is_reusable,
            status: row.status,
        })
        .collect();
    SqliteVec::open(&store, DIMENSIONS)
        .await
        .unwrap()
        .upsert(&vectors)
        .await
        .unwrap();

    let request = SearchRequest {
        branch_id: Some(MAIN_BRANCH_ID),
        include_archived: true,
        top_k: Some(8),
        ..search_request("routing")
    };
    let direct = store.search(request.clone()).await.unwrap().hits;
    assert_eq!(
        direct.iter().map(|hit| hit.memory.id).collect::<Vec<_>>(),
        ids[..2]
    );
    let request = SearchRequest {
        expand_graph: true,
        ..request
    };
    let expanded = store.search(request.clone()).await.unwrap().hits;
    assert_eq!(expanded[..2], direct);
    for (hit, (target, parent, weight)) in
        expanded[2..]
            .iter()
            .zip([(2, 0, 0.82), (3, 0, 0.71), (12, 1, 0.50), (5, 1, 0.60)])
    {
        assert_eq!(hit.memory.id, ids[target]);
        assert_eq!(hit.related_to, Some(ids[parent]));
        assert!((hit.score - direct[parent].score * weight).abs() < 1e-12);
        assert!((hit.similarity_score - f64::from(records[target].1)).abs() < 1e-6);
    }
    assert_eq!(expanded.len(), 6);
    assert_eq!(
        store
            .search(SearchRequest {
                top_k: Some(2),
                ..request.clone()
            })
            .await
            .unwrap()
            .hits,
        direct
    );
    assert_eq!(
        store
            .search(SearchRequest {
                top_k: Some(3),
                ..request.clone()
            })
            .await
            .unwrap()
            .hits,
        expanded[..3]
    );
    assert!(
        store
            .search(SearchRequest {
                query: "origami".into(),
                ..request.clone()
            })
            .await
            .unwrap()
            .hits
            .is_empty()
    );
    let filtered = store
        .search(SearchRequest {
            filter: SearchFilter {
                only_reusable: true,
                ..Default::default()
            },
            ..request
        })
        .await
        .unwrap()
        .hits;
    assert!(!filtered.iter().any(|hit| hit.memory.id == ids[3]));
    assert!(filtered.iter().any(|hit| hit.memory.id == ids[4]));
}

#[tokio::test]
async fn save_and_governance_share_calibrated_conflict_rules() {
    let dir = tempfile::tempdir().unwrap();
    let clusters: &[&[&str]] = &[
        &[
            "Cobalt stores attachments locally",
            "Cobalt never stores attachments locally",
        ],
        &[
            "La versión de la API es v1.14.0",
            "La versión de la API es v1.15.0",
        ],
        &["Use SQLite for persistence", "Use Postgres for persistence"],
        &["Cache mode=relaxed", "Cache mode=strict"],
        &["Use Rust in development", "Use Go in production"],
        &["El motor procesa lotes", "El motor nunca procesa lotes"],
        &[
            "The retention period is 12 days",
            "The retention period is 14 days",
            "The retention period is 15 days",
            "The retention period is 16 days",
            "The retention period is 17 days",
            "The retention period is 18 days",
        ],
        &["The maximum pool size is 8", "The maximum pool size is 16"],
        &[
            "The maximum batch size is 24",
            "The maximum batch size is 48",
        ],
    ];
    let mut vectors = Vec::new();
    let mut axis = clusters.len() + 1;
    for (topic, texts) in clusters.iter().enumerate() {
        for &text in *texts {
            let raw_cosine: f32 = match topic {
                4 => 0.930,
                7 => 0.880,
                8 => 0.912,
                _ => 0.9366,
            };
            let mut vector = vec![0.0; DIMENSIONS];
            vector[topic] = raw_cosine.sqrt();
            vector[axis] = (1.0 - raw_cosine).sqrt();
            axis += 1;
            vectors.push((text, vector));
        }
    }
    let store = recorded_store(&dir, vectors, true).await;
    let project = store
        .create_project(NewProject {
            name: "Unrelated scope".into(),
            root_path: None,
            color_hex: None,
        })
        .await
        .unwrap();
    let mut expected = Vec::new();
    for (index, reason) in [
        "negation",
        "different_value",
        "opposite_choice",
        "different_value",
    ]
    .into_iter()
    .enumerate()
    {
        let [a, b] = clusters[index] else {
            panic!("expected a pair")
        };
        let first = store.save_memory(new_memory(a)).await.unwrap();
        let second = store.save_memory(new_memory(b)).await.unwrap();
        let hints = &second.possible_conflicts;
        assert_eq!(second.action, WriteAction::Inserted);
        assert_eq!(hints.len(), 1);
        assert_eq!(hints[0].reason, reason);
        assert_eq!(hints[0].preview, *a);
        assert_eq!(hints[0].memory_id, first.memory.id);
        assert!((hints[0].similarity - 0.87024).abs() < 0.0001);
        expected.push((first.memory.id, second.memory.id, reason));
    }

    // Equal-topic lookalikes with different conditions do not produce choice conflicts.
    for text in clusters[4] {
        assert!(
            store
                .save_memory(new_memory(text))
                .await
                .unwrap()
                .possible_conflicts
                .is_empty()
        );
    }
    let archived = store
        .save_memory(new_memory(clusters[5][0]))
        .await
        .unwrap()
        .memory;
    store.archive_memory(archived.id, "retired").await.unwrap();
    assert!(
        store
            .save_memory(new_memory(clusters[5][1]))
            .await
            .unwrap()
            .possible_conflicts
            .is_empty()
    );
    for text in clusters[7] {
        assert!(
            store
                .save_memory(new_memory(text))
                .await
                .unwrap()
                .possible_conflicts
                .is_empty()
        );
    }
    let [batch_a, batch_b] = clusters[8] else {
        panic!("expected a pair")
    };
    let batch_a = store.save_memory(new_memory(batch_a)).await.unwrap();
    let batch_b = store.save_memory(new_memory(batch_b)).await.unwrap();
    assert_eq!(batch_b.possible_conflicts[0].memory_id, batch_a.memory.id);
    expected.push((batch_a.memory.id, batch_b.memory.id, "different_value"));
    let mut latest = None;
    for (index, text) in clusters[6].iter().enumerate() {
        let result = store
            .save_memory(NewMemory {
                project_id: (index == 0).then_some(project.id),
                ..new_memory(text)
            })
            .await
            .unwrap();
        assert_eq!(
            result.possible_conflicts.len(),
            index.saturating_sub(1).min(3)
        );
        latest = Some(result.memory.id);
    }
    assert!(
        store
            .save_memory(new_memory(clusters[6][5]))
            .await
            .unwrap()
            .possible_conflicts
            .is_empty()
    );

    let pairs = store.find_conflicts(64).await.unwrap();
    assert_eq!(pairs.len(), expected.len() + 10);
    for (a, b, reason) in expected {
        assert!(
            pairs.iter().any(|pair| pair.a.id == a.min(b)
                && pair.b.id == a.max(b)
                && pair.reason == reason)
        );
    }
    assert_eq!(
        pairs
            .iter()
            .filter(|pair| Some(pair.a.id) == latest || Some(pair.b.id) == latest)
            .count(),
        4
    );
    assert!(
        pairs
            .iter()
            .all(|pair| pair.a.project_id == pair.b.project_id && pair.a.id < pair.b.id)
    );
    assert_eq!(store.find_conflicts(1).await.unwrap(), pairs[..1]);
    assert!(store.find_conflicts(0).await.unwrap().is_empty());
    drop(store);
    let store_without_engine = SqliteStore::open_at(dir.path().join("cobalt.db"))
        .await
        .unwrap();
    let from_edges = store_without_engine.find_conflicts(64).await.unwrap();
    assert_eq!(from_edges.len(), pairs.len() - 1);
    assert!(from_edges.iter().all(|pair| pairs.contains(pair)));
}
