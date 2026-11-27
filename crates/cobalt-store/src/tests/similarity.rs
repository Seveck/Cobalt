use std::collections::BTreeSet;

use cobalt_core::config::SearchSettings;
use cobalt_core::traits::Embedder;
use cobalt_embeddings::FastembedEmbedder;
use sha2::{Digest, Sha256};

use crate::governance::cosine;
use crate::{SimilarityKind, calibrated_similarity};

const MODELS: [&str; 2] = ["multilingual-e5-small", "multilingual-e5-base"];
const PAIRS: &str = include_str!("../../tests/fixtures/similarity-pairs.tsv");
const COSINES: &str = include_str!("../../tests/fixtures/similarity-cosines.tsv");
const LABELS: [&str; 3] = ["paraphrase", "different_fact", "unrelated"];

struct Pair {
    id: &'static str,
    label: &'static str,
    left: &'static str,
    right: &'static str,
}

fn pairs() -> Vec<Pair> {
    PAIRS
        .lines()
        .skip(1)
        .map(|line| {
            let fields: Vec<_> = line.split('\t').collect();
            let [id, label, left, right] = fields[..] else {
                panic!("invalid pair: {line}");
            };
            assert!(LABELS.contains(&label));
            Pair {
                id,
                label,
                left,
                right,
            }
        })
        .collect()
}

fn fixture_hash() -> String {
    hex::encode(Sha256::digest(PAIRS.lines().collect::<Vec<_>>().join("\n")))
}

#[test]
fn uses_model_calibration_with_a_clamped_fallback() {
    let [small, base] = MODELS;
    let probe = 0.9;
    assert!(
        (calibrated_similarity(small, SimilarityKind::Document, probe) - 0.4933058702).abs() < 1e-9
    );
    assert!(
        (calibrated_similarity(base, SimilarityKind::Document, probe) - 0.7273652085).abs() < 1e-9
    );
    for kind in [SimilarityKind::Document, SimilarityKind::Query] {
        assert_eq!(
            calibrated_similarity("MULTILINGUAL-E5-SMALL", kind, probe),
            calibrated_similarity(small, kind, probe),
        );
        for model in ["bge-m3", "custom-model", "multilingual-e5-large"] {
            assert_eq!(calibrated_similarity(model, kind, probe), probe);
        }
        for model in [small, base, "bge-m3", "custom-model"] {
            let score = |cosine| calibrated_similarity(model, kind, cosine);
            assert_eq!(score(-0.1), 0.0);
            assert!(score(1.0_f64.next_down()) < 1.0);
            assert_eq!(score(1.0), 1.0);
            assert_eq!(score(1.1), 1.0);
            for invalid in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
                assert_eq!(score(invalid), 0.0);
            }
            let mut previous = score(-1.0);
            for step in -9999..=10_000 {
                let cosine = f64::from(step) / 10_000.0;
                let current = score(cosine);
                assert!(current >= previous, "{model} {kind:?} at {cosine}");
                previous = current;
            }
        }
    }
}

#[test]
fn recorded_cosines_preserve_fixture_decisions() {
    let settings = SearchSettings::default();
    let pairs = pairs();
    assert!(pairs.len() >= 60);
    let ids: BTreeSet<_> = pairs.iter().map(|pair| pair.id).collect();
    assert_eq!(ids.len(), pairs.len());

    let mut rows = COSINES.lines();
    assert_eq!(
        rows.next().unwrap(),
        format!("# fixture_sha256\t{}", fixture_hash()),
        "remeasure the cosines when changing the labeled fixture",
    );
    rows.next().unwrap(); // Column names

    // Measured recall at the write threshold, subject to zero different-fact replacements.
    // The largest unrelated cosine by itself ranks above 5 Small and 4 Base paraphrases,
    // so a monotone mapping that keeps those unrelated pairs below 0.40 cannot reach 95%.
    for (model, expected_dedup_hits) in MODELS.into_iter().zip([7, 10]) {
        let mut dedup_hits = 0;
        let mut query_scores = [Vec::new(), Vec::new(), Vec::new()];
        for pair in &pairs {
            let row = rows.next().expect("missing recorded cosine row");
            let fields: Vec<_> = row.split('\t').collect();
            let [recorded_model, id, document, forward, reverse] = fields[..] else {
                panic!("invalid cosine row: {row}");
            };
            assert_eq!((recorded_model, id), (model, pair.id));
            let [document, forward, reverse] = [document, forward, reverse].map(|value| {
                let raw = value.parse::<f64>().unwrap();
                assert!((-1.0..=1.0).contains(&raw), "{model} {id}: {raw}");
                raw
            });
            let document = calibrated_similarity(model, SimilarityKind::Document, document);
            let label = LABELS
                .iter()
                .position(|label| *label == pair.label)
                .unwrap();
            query_scores[label].extend(
                [forward, reverse]
                    .map(|raw| calibrated_similarity(model, SimilarityKind::Query, raw)),
            );
            let case = || format!("{model} {id} ({}): {document:.6}", pair.label);
            match pair.label {
                "paraphrase" => {
                    // The write path uses a strict comparison.
                    dedup_hits += usize::from(document > settings.dedup_threshold);
                }
                "different_fact" => {
                    assert!(document < settings.duplicate_threshold, "{}", case());
                    assert!(document < settings.dedup_threshold, "{}", case());
                }
                "unrelated" => {
                    assert!(document < 0.40, "{}", case());
                }
                label => panic!("unknown pair label: {label}"),
            }
        }
        assert!(
            query_scores.iter().all(|scores| scores.len() == 40),
            "{model}"
        );
        assert_eq!(dedup_hits, expected_dedup_hits, "{model}");
        // Query/document pairs include both directions because the embeddings are asymmetric.
        let [paraphrases, different_facts, mut unrelated] = query_scores;
        let pass_rate = |scores: &[f64]| {
            let hits = scores
                .iter()
                .filter(|&&score| score >= settings.min_similarity)
                .count();
            hits as f64 / scores.len() as f64
        };
        assert!(pass_rate(&paraphrases) >= 0.95, "{model} paraphrases");
        assert!(
            pass_rate(&different_facts) >= 0.75,
            "{model} different facts"
        );
        unrelated.sort_by(f64::total_cmp);
        let n = unrelated.len();
        let median = (unrelated[(n - 1) / 2] + unrelated[n / 2]) / 2.0;
        assert!(median < 0.15, "{model} unrelated median: {median:.6}");
    }
    assert!(rows.next().is_none(), "unexpected extra cosine rows");
}

// Re-record the TSV header and data rows with:
// cargo test -p cobalt-store measure_similarity_distributions -- --ignored --nocapture
#[tokio::test]
#[ignore = "requires the installed multilingual E5 Small and Base ONNX models"]
async fn measure_similarity_distributions() {
    let pairs = pairs();
    let texts: Vec<_> = pairs
        .iter()
        .flat_map(|pair| [pair.left.to_owned(), pair.right.to_owned()])
        .collect();

    // These lines constitute the recorded fixture. Keep distribution summaries out of it.
    println!("# fixture_sha256\t{}", fixture_hash());
    println!(
        "model\tpair\tdocument_document\tleft_query_right_document\tright_query_left_document"
    );
    for model in MODELS {
        let embedder = FastembedEmbedder::from_catalog(model).unwrap();
        let documents = embedder.embed_documents(&texts).await.unwrap();
        assert_eq!(documents.len(), texts.len());
        let (document_pairs, remainder) = documents.as_chunks::<2>();
        assert!(remainder.is_empty());
        let mut observations = Vec::new();
        for (pair, [left, right]) in pairs.iter().zip(document_pairs) {
            let left_query = embedder.embed_query(pair.left).await.unwrap();
            let right_query = embedder.embed_query(pair.right).await.unwrap();
            let scores = [
                cosine(left, right),
                cosine(&left_query, right),
                cosine(&right_query, left),
            ];
            let [document, forward, reverse] = scores;
            println!(
                "{model}\t{}\t{document:.9}\t{forward:.9}\t{reverse:.9}",
                pair.id
            );
            observations.push((pair.label, scores));
        }
        for label in LABELS {
            for (input, mode) in ["document/document", "query/document"]
                .into_iter()
                .enumerate()
            {
                let mut scores: Vec<_> = observations
                    .iter()
                    .filter(|(observed, _)| *observed == label)
                    .flat_map(|(_, scores)| {
                        if input == 0 {
                            &scores[..1]
                        } else {
                            &scores[1..]
                        }
                    })
                    .copied()
                    .collect();
                scores.sort_by(f64::total_cmp);
                let n = scores.len();
                let median = (scores[(n - 1) / 2] + scores[n / 2]) / 2.0;
                eprintln!(
                    "{model} {label} {mode}: n={n} min={:.6} median={median:.6} max={:.6}",
                    scores[0],
                    scores[n - 1],
                );
            }
        }
    }
}
