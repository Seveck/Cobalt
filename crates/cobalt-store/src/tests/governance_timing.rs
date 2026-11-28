use std::time::{Duration, Instant};

use cobalt_core::traits::GovernanceService;

use super::*;

#[tokio::test]
#[ignore = "Release timing fixture: run with cargo test --release -p cobalt-store governance_scan_timing -- --ignored --nocapture"]
async fn governance_scan_timing() {
    const ROWS: usize = 5_000;
    const DIMENSIONS: usize = 384;
    const TOPICS: usize = 50;

    let dir = tempfile::tempdir().unwrap();
    let mut embedder = DeterministicEmbedderMock::new();
    embedder.0.dimensions = DIMENSIONS as _;
    let store = SqliteStore::open_at(dir.path().join("cobalt.db"))
        .await
        .unwrap()
        .with_sqlite_vec(
            Arc::new(embedder),
            Arc::new(TiktokenCounter::new(TokenEncoding::Cl100kBase)),
        )
        .await
        .unwrap();
    store
        .db
        .write(|conn| {
            let tx = conn.transaction().unwrap();
            {
                let mut insert = tx
                    .prepare(
                        "INSERT INTO memories (id, branch_id, content, content_hash, category,
                 chunk_tokens, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'note', 8, ?5, ?5)",
                    )
                    .unwrap();
                let mut seed = 7_u32;
                let mut shared_vector = Vec::new();
                let branch = MAIN_BRANCH_ID.to_string();
                let stamp = crate::repositories::stamp();
                for i in 0..ROWS {
                    let id = new_id();
                    let mut vector = vec![0.0; DIMENSIONS];
                    vector[0] = 0.55;
                    vector[1 + i % TOPICS] = 0.74;
                    for x in &mut vector[1 + TOPICS..] {
                        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                        *x = ((seed >> 16) as f32 / 32_768.0 - 1.0) * 0.05;
                    }
                    let content = format!("Notes from session {i}");
                    match i {
                        0 => shared_vector.clone_from(&vector),
                        1 => vector.clone_from(&shared_vector),
                        _ => {}
                    }
                    insert
                        .execute(params![
                            id.to_string(),
                            branch,
                            content,
                            crate::memory::content_hash(&content),
                            stamp,
                        ])
                        .unwrap();
                    SqliteVec::replace(&tx, id, &vector)?;
                }
            }
            tx.commit().unwrap();
            Ok(())
        })
        .await
        .unwrap();

    let start = Instant::now();
    let duplicates = store.find_duplicates().await.unwrap();
    let duplicate_time = start.elapsed();
    let start = Instant::now();
    let conflicts = store.find_conflicts(50).await.unwrap();
    let conflict_time = start.elapsed();

    eprintln!(
        "{ROWS} memories × {DIMENSIONS}: duplicates {duplicate_time:?}, conflicts {conflict_time:?}"
    );
    assert!(!duplicates.is_empty());
    assert!(!conflicts.is_empty());
    if !cfg!(debug_assertions) {
        assert!(duplicate_time < Duration::from_millis(500));
        assert!(conflict_time < Duration::from_millis(500));
    }
}
