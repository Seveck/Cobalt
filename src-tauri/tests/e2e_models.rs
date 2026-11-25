//! End-to-end check of the Eco model pipeline against the real network:
//! catalog -> EngineManager (HTTPS, SHA-256, progress) -> cobalt-embeddings ONNX loader.
//! Downloads ~135 MB, so it is ignored by default:
//! `cargo test -p cobalt-app --test e2e_models -- --ignored --nocapture`

use std::sync::{Arc, Mutex};

use cobalt_core::engine::{DownloadProgress, EngineInstallRequest};
use cobalt_core::engines::EngineManager;
use cobalt_core::enums::{DownloadPhase, EngineKind, EngineState};
use cobalt_core::traits::{Embedder, ProgressSink};
use cobalt_embeddings::{FastembedEmbedder, OnnxFiles, Pooling, QuantizationMode};

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

#[tokio::test]
#[ignore = "downloads the real multilingual-e5-small model (~135 MB)"]
async fn eco_model_downloads_verifies_and_embeds_spanish() {
    let home = tempfile::tempdir().expect("tempdir");
    let manager = EngineManager::new(home.path().to_path_buf()).expect("manager");
    let model_id = "multilingual-e5-small";

    let phases = Arc::new(Mutex::new(Vec::<DownloadPhase>::new()));
    let seen = phases.clone();
    let sink: ProgressSink<DownloadProgress> = Arc::new(move |p: DownloadProgress| {
        seen.lock().expect("lock").push(p.phase);
    });
    let req = EngineInstallRequest {
        engine: EngineKind::SqliteVec,
        model_id: model_id.into(),
    };
    manager.install(&req, sink).await.expect("install");

    assert_eq!(manager.model_state(model_id), EngineState::Installed);
    assert_eq!(
        manager
            .missing_bytes(EngineKind::SqliteVec, model_id)
            .expect("missing"),
        0
    );
    let phases = phases.lock().expect("lock").clone();
    assert!(
        phases.contains(&DownloadPhase::Verifying),
        "SHA-256 verification must run"
    );

    let spec = manager
        .catalog()
        .model(model_id)
        .expect("spec")
        .spec
        .clone();
    let dir = manager.model_dir(model_id);
    let embedder = FastembedEmbedder::from_onnx(
        spec,
        OnnxFiles {
            model: dir.join("model.onnx"),
            tokenizer_dir: dir,
            external_initializers: Vec::new(),
            pooling: Pooling::Mean,
            quantization: QuantizationMode::Dynamic,
            max_length: 512,
        },
    )
    .expect("embedder");

    let docs = embedder
        .embed_documents(&[
            "Decidimos usar SQLite en modo WAL para evitar bloqueos con varios lectores.".into(),
            "La receta de arepas lleva harina de maíz precocida y sal.".into(),
        ])
        .await
        .expect("embed documents");
    let query = embedder
        .embed_query("¿Qué base de datos elegimos y por qué?")
        .await
        .expect("query");
    assert_eq!(query.len(), 384);
    let relevant = cosine(&query, &docs[0]);
    let unrelated = cosine(&query, &docs[1]);
    println!("cosine relevant={relevant:.3} unrelated={unrelated:.3}");
    assert!(
        relevant > unrelated,
        "multilingual retrieval must rank the SQLite note first"
    );
}
