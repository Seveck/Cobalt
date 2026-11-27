use cobalt_core::catalog::{Catalog, DEFAULT_OCR_MODEL};
use cobalt_core::engines::EngineManager;
use cobalt_core::traits::OcrEngine;
use cobalt_ingest::OcrsEngine;
use sha2::{Digest, Sha256};
use std::sync::Arc;

#[tokio::test]
#[ignore = "downloads the two pinned OCR models (~12 MB) from the catalog"]
async fn pinned_models_recognize_rendered_text() {
    let dir = tempfile::tempdir().unwrap();
    let manager = EngineManager::new(dir.path().to_owned()).unwrap();
    manager
        .install_ocr(DEFAULT_OCR_MODEL, Arc::new(|_| {}))
        .await
        .unwrap();
    let files = manager.ocr_model_files(DEFAULT_OCR_MODEL).unwrap();
    let (detection, recognition) = (files.detection, files.recognition);
    let entry = Catalog::builtin()
        .unwrap()
        .ocr_model(DEFAULT_OCR_MODEL)
        .unwrap();
    let (det_spec, rec_spec) = entry.detection_and_recognition().unwrap();
    for (path, spec) in [(&detection, det_spec), (&recognition, rec_spec)] {
        let bytes = std::fs::read(path).unwrap();
        assert_eq!(bytes.len() as u64, spec.size_bytes);
        assert_eq!(hex::encode(Sha256::digest(&bytes)), spec.sha256);
    }

    // Open Sans Regular, 68 pt, black on white, rendered from "Cobalt OCR 2026 áéñ".
    let engine = OcrsEngine::from_paths(detection, recognition).unwrap();
    let text = engine
        .recognize(include_bytes!("fixtures/ocr-text.png"))
        .unwrap();
    println!("OCR read {text:?}");
    assert!(
        text.split_whitespace()
            .take(3)
            .eq(["Cobalt", "OCR", "2026"]),
        "{text:?}"
    );
}
