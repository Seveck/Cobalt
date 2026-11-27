#![allow(clippy::unwrap_used)]

use std::sync::Arc;

use cobalt_core::catalog::{Catalog, DEFAULT_OCR_MODEL};
use cobalt_core::engine::OcrModelFiles;
use cobalt_core::engines::EngineManager;
use cobalt_core::enums::OcrEngineKind;
use cobalt_core::traits::OcrEngine;
use cobalt_ingest::{OcrsEngine, PaddleOcrEngine};
use sha2::{Digest, Sha256};

const PADDLE_MODEL: &str = "paddleocr-latin";
const MODEL_IDS: [&str; 2] = [DEFAULT_OCR_MODEL, PADDLE_MODEL];

struct Fixture {
    name: &'static str,
    image: &'static [u8],
    expected: &'static str,
}

macro_rules! fixture {
    ($name:literal) => {
        Fixture {
            name: $name,
            image: include_bytes!(concat!("fixtures/", $name, ".png")),
            expected: include_str!(concat!("fixtures/", $name, ".txt")),
        }
    };
}

// Open Sans and Source Code Pro rendered at native pixel sizes. The column
// reference reads across each row. The rotated page is tilted 8 degrees.
const FIXTURES: &[Fixture] = &[
    fixture!("spanish"),
    fixture!("english"),
    fixture!("code"),
    fixture!("small-12px"),
    fixture!("two-columns"),
    fixture!("rotated"),
];

async fn install_verified(manager: &EngineManager, id: &str) -> OcrModelFiles {
    manager.install_ocr(id, Arc::new(|_| {})).await.unwrap();
    let files = manager.ocr_model_files(id).unwrap();
    let entry = Catalog::builtin().unwrap().ocr_model(id).unwrap();
    let (det, rec) = entry.detection_and_recognition().unwrap();
    for (path, spec) in [
        Some((&files.detection, det)),
        Some((&files.recognition, rec)),
        files.dictionary.as_ref().zip(entry.dictionary()),
    ]
    .into_iter()
    .flatten()
    {
        let bytes = std::fs::read(path).unwrap();
        assert_eq!(bytes.len() as u64, spec.size_bytes);
        assert_eq!(hex::encode(Sha256::digest(&bytes)), spec.sha256);
    }
    assert_eq!(files.dictionary.is_some(), entry.dictionary().is_some());
    files
}

fn load_engine(files: &OcrModelFiles) -> Box<dyn OcrEngine> {
    match files.engine {
        OcrEngineKind::Ocrs => {
            Box::new(OcrsEngine::from_paths(&files.detection, &files.recognition).unwrap())
        }
        OcrEngineKind::PaddleOcr => Box::new(
            PaddleOcrEngine::from_files(
                &files.detection,
                &files.recognition,
                files.dictionary.as_ref().unwrap(),
            )
            .unwrap(),
        ),
    }
}

#[tokio::test]
#[ignore = "downloads both SHA-256-pinned OCR models (~25 MB)"]
async fn pinned_models_recognize_rendered_text() {
    let dir = tempfile::tempdir().unwrap();
    let manager = EngineManager::new(dir.path().to_owned()).unwrap();
    for id in MODEL_IDS {
        let files = install_verified(&manager, id).await;
        tokio::task::spawn_blocking(move || {
            let engine = load_engine(&files);
            for fixture in FIXTURES {
                let text = engine.recognize(fixture.image).unwrap();
                let (errors, chars) = if fixture.name == "two-columns" {
                    // Both reading orders are valid here. The benchmark scores
                    // both engines against the same row-major reference.
                    let sorted_lines = |text: &str| {
                        let mut lines: Vec<_> = text.lines().collect();
                        lines.sort_unstable();
                        lines.join("\n")
                    };
                    character_errors(&sorted_lines(fixture.expected), &sorted_lines(&text))
                } else {
                    character_errors(fixture.expected, &text)
                };
                assert!(
                    errors < chars / 2,
                    "{id} {} ({errors}/{chars} CER): {text:?}",
                    fixture.name
                );
                if id == PADDLE_MODEL && fixture.name == "spanish" {
                    for letter in "áéíóúñü¿".chars() {
                        assert!(text.contains(letter), "missing {letter:?} in {text:?}");
                    }
                }
            }
        })
        .await
        .unwrap();
    }
}

// Collapse runs of whitespace, including newlines and code indentation. Keep
// case, accents, punctuation and reading order in the Unicode character CER.
fn character_errors(expected: &str, actual: &str) -> (usize, usize) {
    let chars = |text: &str| {
        text.split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .collect::<Vec<_>>()
    };
    let expected = chars(expected);
    let actual = chars(actual);
    let mut previous: Vec<_> = (0..=actual.len()).collect();
    let mut current = vec![0; previous.len()];
    for (i, expected_char) in expected.iter().enumerate() {
        current[0] = i + 1;
        for (j, actual_char) in actual.iter().enumerate() {
            current[j + 1] = (current[j] + 1)
                .min(previous[j + 1] + 1)
                .min(previous[j] + usize::from(expected_char != actual_char));
        }
        std::mem::swap(&mut previous, &mut current);
    }
    (previous[actual.len()], expected.len())
}

#[cfg(target_os = "linux")]
mod benchmark {
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::Instant;

    use super::*;

    const ENV_ENGINE: &str = "COBALT_OCR_BENCH_ENGINE";
    const ENV_FIXTURE: &str = "COBALT_OCR_BENCH_FIXTURE";
    const ENV_MODELS: &str = "COBALT_OCR_BENCH_MODELS";
    const WARM_RUNS: usize = 5;

    // cargo test --release -p cobalt-ingest --test ocr_catalog benchmark_models -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "downloads catalog models and measures OCR using Linux procfs"]
    async fn benchmark_models() {
        let dir = tempfile::tempdir().unwrap();
        let manager = EngineManager::new(dir.path().to_owned()).unwrap();
        for id in MODEL_IDS {
            install_verified(&manager, id).await;
        }

        println!(
            "engine\tfixture\tchar errors/ref\tcold ms\twarm median ms\tpeak RSS delta KiB\tOCR text"
        );
        for fixture in FIXTURES {
            for id in MODEL_IDS {
                // Each pair starts a fresh process. Its peak RSS has no previous
                // model, fixture or downloader allocations.
                let output = Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "benchmark::measure_fixture",
                        "--ignored",
                        "--nocapture",
                    ])
                    .env(ENV_MODELS, dir.path())
                    .env(ENV_ENGINE, id)
                    .env(ENV_FIXTURE, fixture.name)
                    .env("RTEN_NUM_THREADS", "2")
                    .output()
                    .unwrap();
                let stdout = String::from_utf8_lossy(&output.stdout);
                assert!(
                    output.status.success(),
                    "{stdout}\n{}",
                    String::from_utf8_lossy(&output.stderr)
                );
                let row = stdout.lines().find(|line| line.starts_with(id)).unwrap();
                println!("{row}");
            }
        }
    }

    #[test]
    #[ignore = "child process of benchmark_models"]
    fn measure_fixture() {
        let Ok(id) = std::env::var(ENV_ENGINE) else {
            return;
        };
        let name = std::env::var(ENV_FIXTURE).unwrap();
        let home = PathBuf::from(std::env::var_os(ENV_MODELS).unwrap());
        let fixture = FIXTURES
            .iter()
            .find(|fixture| fixture.name == name)
            .unwrap();
        let manager = EngineManager::new(home).unwrap();
        let files = manager.ocr_model_files(&id).unwrap();
        let baseline_rss = proc_kib("VmRSS:");
        let cold_start = Instant::now();
        let engine = load_engine(&files);
        let text = engine.recognize(fixture.image).unwrap();
        let cold = cold_start.elapsed();
        let mut warm = [std::time::Duration::ZERO; WARM_RUNS];
        for elapsed in &mut warm {
            let start = Instant::now();
            let result = engine.recognize(fixture.image).unwrap();
            *elapsed = start.elapsed();
            assert_eq!(result, text);
        }
        let peak_delta = proc_kib("VmHWM:").saturating_sub(baseline_rss);
        warm.sort_unstable();
        let (errors, chars) = character_errors(fixture.expected, &text);
        println!(
            "{id}\t{name}\t{errors}/{chars}\t{:.2}\t{:.2}\t{peak_delta}\t{text:?}",
            cold.as_secs_f64() * 1000.0,
            warm[WARM_RUNS / 2].as_secs_f64() * 1000.0
        );
    }

    fn proc_kib(key: &str) -> u64 {
        std::fs::read_to_string("/proc/self/status")
            .unwrap()
            .lines()
            .find_map(|line| line.strip_prefix(key))
            .unwrap()
            .split_whitespace()
            .next()
            .unwrap()
            .parse()
            .unwrap()
    }
}
