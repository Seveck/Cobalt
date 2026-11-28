//! Run against a quiescent snapshot with installed model artifacts and a private TSV:
//! COBALT_HOME=/path/to/model-home COBALT_EVAL_SNAPSHOT=/path/to/snapshot \
//! COBALT_EVAL_LABELS=/path/to/labels.tsv cargo test -p cobalt-store --test search_quality \
//!     -- --ignored --nocapture
//! The TSV has [off_topic], [identifier], and [natural] sections. Each row is a query,
//! followed for labeled hits by a tab and comma-separated acceptable memory UUIDs.
//! Keep brain-derived labels outside the repository.
//! Run `synthetic_search_quality` in the same way with just the installed model
//! to compare expansion on the checked-in bilingual corpus.

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use cobalt_core::engine::MODEL_MULTILINGUAL_E5_SMALL;
use cobalt_core::enums::{MemoryCategory, MemoryStatus, TokenEncoding};
use cobalt_core::ids::{Id, MAIN_BRANCH_ID};
use cobalt_core::model::NewMemory;
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
    compare_expansion(&store, ProjectScope::ProjectAndGlobal(project.id), &cases).await;
}

async fn compare_expansion(
    store: &SqliteStore,
    scope: ProjectScope,
    cases: &[(usize, &str, Vec<Id>)],
) {
    for top_k in [3, 5] {
        let baseline = evaluate(store, scope, cases, top_k, false).await;
        let expanded = evaluate(store, scope, cases, top_k, true).await;
        assert!(
            expanded[0] >= baseline[0],
            "off-topic zero-result rate regressed"
        );
        assert!(
            expanded[2] >= baseline[2],
            "natural top-three rate regressed"
        );
    }
}

async fn evaluate(
    store: &SqliteStore,
    scope: ProjectScope,
    cases: &[(usize, &str, Vec<Id>)],
    top_k: u32,
    expand_graph: bool,
) -> [usize; 3] {
    let mut passed = [0; 3];
    let mut totals = [0; 3];
    let mut latencies = Vec::new();
    let mut related = 0;
    for pass in 0..TIMING_PASSES {
        for (index, (category, query, expected)) in cases.iter().enumerate() {
            let started = Instant::now();
            let response = store
                .search(SearchRequest {
                    query: (*query).to_owned(),
                    scope,
                    branch_id: None,
                    top_k: Some(top_k),
                    include_archived: false,
                    filter: Default::default(),
                    rrf_override: None,
                    record_hits: false,
                    expand_graph,
                })
                .await
                .expect("search quality query must complete");
            latencies.push(started.elapsed().as_secs_f64() * 1_000.0);
            if pass != 0 {
                continue;
            }
            related += response
                .hits
                .iter()
                .filter(|hit| hit.related_to.is_some())
                .count();
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
                "expand={expand_graph} k={top_k} case={} {} pass={success} hits={hits:.3?}",
                index + 1,
                SECTIONS[*category]
            );
        }
    }
    latencies.sort_by(f64::total_cmp);
    let percentile = |p: usize| latencies[(p * latencies.len()).div_ceil(100) - 1];
    for (index, label) in SECTIONS.iter().enumerate() {
        println!(
            "expand={expand_graph} k={top_k} {label} {}/{}",
            passed[index], totals[index]
        );
    }
    println!(
        "expand={expand_graph} k={top_k} related_hits={related} latency_ms p50={:.2} p95={:.2}",
        percentile(50),
        percentile(95)
    );
    passed
}

#[tokio::test]
#[ignore = "requires installed multilingual-e5-small"]
async fn synthetic_search_quality() {
    let corpus = [
        (
            "PAYMENT_QUEUE",
            "What queues up payment requests during outages?",
            "PAYMENT_QUEUE stores payment requests during outages until the gateway recovers.",
            "Retry the gateway when connectivity returns. Keep failed payments in a durable buffer.",
        ),
        (
            "INDEX_REPAIR",
            "¿Cómo se repara un índice de búsqueda dañado?",
            "INDEX_REPAIR repara un índice de búsqueda dañado y lo reconstruye a partir de los documentos.",
            "Si las consultas fallan, reemplaza la estructura de búsqueda a partir de los archivos originales.",
        ),
        (
            "ARCHIVE_POLICY",
            "When are inactive records archived?",
            "ARCHIVE_POLICY marks inactive records as archived after thirty days.",
            "Old entries stay accessible through the history view for compliance reviews.",
        ),
        (
            "IMPORT_ERRORS",
            "¿Dónde aparecen los errores de importación?",
            "IMPORT_ERRORS muestra los errores de importación en el registro de actividad.",
            "El historial recoge fallos de carga y señala el archivo que se debe revisar.",
        ),
        (
            "RESUME_SYNC",
            "How does file synchronization resume after a disconnect?",
            "RESUME_SYNC resumes file synchronization from the last acknowledged block after a disconnect.",
            "A checkpoint lets the transfer continue without resending chunks that the server already received.",
        ),
        (
            "PDF_PREVIEW",
            "¿Cómo se visualiza una página del PDF?",
            "PDF_PREVIEW visualiza una página del PDF en el panel de documentos.",
            "El visor dibuja cada hoja del archivo como una imagen de baja resolución.",
        ),
        (
            "PROFILE_EXPORT",
            "Where can I export my profile preferences?",
            "PROFILE_EXPORT exports profile preferences from the settings screen.",
            "The account download contains a copy of your display and notification options.",
        ),
        (
            "SESSION_TIMEOUT",
            "¿Cuándo expira una sesión sin actividad?",
            "SESSION_TIMEOUT cierra una sesión sin actividad después de quince minutos.",
            "Una credencial de acceso deja de ser válida tras un cuarto de hora de inactividad.",
        ),
        (
            "UPLOAD_CHECKSUM",
            "How do uploads detect corrupted bytes?",
            "UPLOAD_CHECKSUM detects corrupted bytes by validating the hash of each upload.",
            "The receiver recomputes a fingerprint and rejects mismatching transfers.",
        ),
        (
            "ROLLBACK_RELEASE",
            "¿Cómo revertir un despliegue defectuoso?",
            "ROLLBACK_RELEASE permite revertir un despliegue defectuoso a la versión anterior.",
            "Si falla la publicación, vuelve a activar la revisión estable que la precedía.",
        ),
    ];
    let off_topic = [
        "How do peacocks fan their plumage?",
        "¿En qué océano viven los narvales?",
        "What spices belong in pumpkin pie?",
        "¿Por qué florecen los cerezos en primavera?",
        "Can a violin be tuned in fifths?",
        "¿Quién descubrió la penicilina?",
        "Which rocks contain garnets?",
        "¿Dónde anidan las golondrinas?",
        "What makes Neptune blue?",
        "¿Cómo preparar gazpacho andaluz?",
    ];
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cobalt.db");
    let embedder = Arc::new(FastembedEmbedder::from_catalog(MODEL_MULTILINGUAL_E5_SMALL).unwrap());
    embedder.embed_query("warm up").await.unwrap();
    let store = SqliteStore::open_at(path.clone())
        .await
        .unwrap()
        .with_usearch(
            embedder,
            Arc::new(TiktokenCounter::new(TokenEncoding::Cl100kBase)),
        )
        .await
        .unwrap();
    let connection = rusqlite::Connection::open(path).unwrap();
    let mut cases: Vec<_> = off_topic
        .into_iter()
        .map(|query| (0, query, Vec::new()))
        .collect();
    for (identifier, query, summary, related) in corpus {
        let note = |content: &str| NewMemory {
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
        };
        let direct = store.save_memory(note(summary)).await.unwrap().memory.id;
        let neighbor = store.save_memory(note(related)).await.unwrap().memory.id;
        connection
            .execute(
                "INSERT INTO memory_edges (source_id, target_id, edge_type, weight)
             VALUES (?1, ?2, 'same_project', 0.8)",
                [direct.to_string(), neighbor.to_string()],
            )
            .unwrap();
        cases.push((1, identifier, vec![direct]));
        cases.push((2, query, vec![direct]));
    }
    compare_expansion(&store, ProjectScope::Global, &cases).await;
}
