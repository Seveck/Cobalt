use std::io::{Cursor, Read};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use cobalt_core::engine::EmbeddingModelSpec;
use cobalt_core::enums::{
    HardwareTier, MemoryCategory, MemoryChangeKind, MemoryStatus, PastLifeSource, SourceType,
    TelemetryOperation, TokenEncoding,
};
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::model::{
    GraphQuery, NewHandoff, NewMemory, NewProject, SourceDocument, UpdateMemoryRequest,
};
use cobalt_core::search::VectorFilter;
use cobalt_core::telemetry::{NewTelemetryEvent, ReturnedItem, TelemetryQuery};
use cobalt_core::traits::{
    ConfigRepository, Embedder, HandoffRepository, IngestService as _, MemoryRepository,
    ProjectRepository, SourceDocumentRepository, TelemetryRepository, TokenCounter, VectorStore,
};
use cobalt_core::transfer::*;
use cobalt_embeddings::{TiktokenCounter, default_model_spec};
use cobalt_store::{SqliteStore, SqliteVec};
use serde_json::json;
use tokio::sync::{mpsc, oneshot};

use crate::IngestService;
use crate::documents::{FileRead, chunks, digest, quiet_progress, read_text_document};
use crate::jobs::Cancellation;

struct IngestEmbedderMock {
    spec: EmbeddingModelSpec,
    calls: Option<mpsc::UnboundedSender<oneshot::Sender<()>>>,
}

#[async_trait]
impl Embedder for IngestEmbedderMock {
    fn spec(&self) -> &EmbeddingModelSpec {
        &self.spec
    }
    async fn embed_documents(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        if let Some(calls) = &self.calls {
            let (release, wait) = oneshot::channel();
            calls.send(release).unwrap();
            wait.await.unwrap();
        }
        Ok(vec![vec![1.0, 0.0]; texts.len()])
    }
    async fn embed_query(&self, _: &str) -> Result<Vec<f32>> {
        Ok(vec![1.0, 0.0])
    }
}

async fn setup(
    dir: &Path,
    model: &str,
) -> (Arc<SqliteStore>, IngestService, Arc<dyn TokenCounter>) {
    setup_with_embedder_gate(dir, model, None).await
}

async fn setup_with_embedder_gate(
    dir: &Path,
    model: &str,
    calls: Option<mpsc::UnboundedSender<oneshot::Sender<()>>>,
) -> (Arc<SqliteStore>, IngestService, Arc<dyn TokenCounter>) {
    let mut spec = default_model_spec(HardwareTier::Eco);
    spec.id = model.into();
    spec.dimensions = 2;
    let tokens: Arc<dyn TokenCounter> = Arc::new(TiktokenCounter::new(TokenEncoding::Cl100kBase));
    let store = Arc::new(
        SqliteStore::open_at(dir.join("cobalt.db"))
            .await
            .unwrap()
            .with_sqlite_vec(Arc::new(IngestEmbedderMock { spec, calls }), tokens.clone())
            .await
            .unwrap(),
    );
    let mut settings = store.load_settings().await.unwrap();
    settings.embedding_model_id = model.into();
    settings.chunking.max_chunk_tokens = 16;
    settings.chunking.overlap_tokens = 4;
    store.save_settings(&settings).await.unwrap();
    let mut ingest = IngestService::with_sqlite_store(store.clone(), tokens.clone());
    Arc::get_mut(&mut ingest.inner).unwrap().global_ignore = Some(dir.join("ignore-config"));
    (store, ingest, tokens)
}

fn path(path: &Path) -> String {
    path.to_str().unwrap().into()
}

fn req(pathname: &Path) -> IngestRequest {
    IngestRequest {
        paths: vec![path(pathname)],
        project_id: None,
        watch: false,
        mark_reusable: false,
        ocr: true,
    }
}

fn memory(content: &str) -> NewMemory {
    NewMemory {
        content: content.into(),
        category: MemoryCategory::Decision,
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

#[test]
fn chunking_stays_bounded_with_unicode_and_overlap() {
    let tokens = TiktokenCounter::new(TokenEncoding::Cl100kBase);
    let text = "alpha beta gamma delta epsilon zeta eta theta iota kappa 🦊 おはようございます";
    let chunks = chunks(&tokens, text, 8, 3, &Cancellation::default()).unwrap();
    assert!(chunks.len() >= 3);
    assert!(chunks.iter().all(|chunk| tokens.count(chunk) <= 8));
    assert!(chunks.windows(2).any(|pair| {
        pair[0]
            .split_whitespace()
            .last()
            .is_some_and(|word| pair[1].contains(word))
    }));
    assert!(chunks.last().unwrap().ends_with("ございます"));
}

struct PrefixOnlyReaderMock(Cursor<Vec<u8>>);

impl Read for PrefixOnlyReaderMock {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let read = self.0.read(buffer)?;
        assert!(
            read > 0 || buffer.is_empty(),
            "read beyond the sniff prefix"
        );
        Ok(read)
    }
}

#[test]
fn rejects_binary_prefix_without_reading_the_rest() {
    const PREFIX: usize = 8 * 1024;
    for (binary_byte, reason) in [(0, "NUL byte"), (0xff, "UTF-8")] {
        let mut bytes = vec![b'x'; PREFIX];
        bytes[PREFIX - 1] = binary_byte;
        let mut input = PrefixOnlyReaderMock(Cursor::new(bytes));
        let result = read_text_document(&mut input, 128 * 1024 * 1024).unwrap();
        assert!(matches!(result, FileRead::Skipped(error) if error.to_string().contains(reason)));
        assert_eq!(input.0.position(), PREFIX as u64);
    }

    let text = format!("{}é", "x".repeat(PREFIX - 1));
    assert!(matches!(
        read_text_document(text.as_bytes(), 2 * 1024 * 1024).unwrap(),
        FileRead::Bytes(bytes) if bytes == text.as_bytes()
    ));
}

#[tokio::test]
async fn reports_large_and_binary_folder_skips() {
    let dir = tempfile::tempdir().unwrap();
    let (store, ingest, _) = setup(dir.path(), "test").await;
    let root = dir.path().join("folder");
    std::fs::create_dir(&root).unwrap();
    let large = root.join("large.txt");
    let initial = vec![b' '; 2 * 1024 * 1024 + 1];
    std::fs::write(&large, &initial).unwrap();
    std::fs::write(root.join("model.BIN"), "looks like text").unwrap();
    std::fs::write(root.join("unknown"), b"prefix\x00data").unwrap();
    let report = ingest
        .ingest_paths(req(&root), quiet_progress())
        .await
        .unwrap();
    assert_eq!(report.skipped_ignored, 3);
    assert_eq!(report.documents_created, 1);
    assert_eq!(report.errors.len(), 3);
    for (name, reason) in [
        ("large.txt", "2 MiB"),
        ("model.BIN", "file extension"),
        ("unknown", "NUL byte"),
    ] {
        assert!(report.errors.iter().any(|issue| {
            Path::new(&issue.path).ends_with(name) && issue.message.contains(reason)
        }));
    }

    // An explicit file reaches the sniff stage instead of the folder size check.
    let file = std::fs::OpenOptions::new()
        .write(true)
        .open(&large)
        .unwrap();
    std::io::Write::write_all(&mut &file, &[0]).unwrap();
    let report = ingest
        .ingest_paths(req(&large), quiet_progress())
        .await
        .unwrap();
    assert_eq!(report.skipped_ignored, 1);
    assert!(report.errors[0].message.contains("NUL byte"));
    file.set_len(128 * 1024 * 1024 + 1).unwrap();
    let report = ingest
        .ingest_paths(req(&large), quiet_progress())
        .await
        .unwrap();
    assert_eq!(report.skipped_ignored, 1);
    assert!(report.errors[0].message.contains("128 MiB"));
    assert!(
        store
            .find_source_document_by_path(&path(&large.canonicalize().unwrap()))
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn cancels_mid_folder_between_embedding_chunks() {
    let dir = tempfile::tempdir().unwrap();
    let (calls, mut embeddings) = mpsc::unbounded_channel();
    let (store, ingest, _) = setup_with_embedder_gate(dir.path(), "test", Some(calls)).await;
    let root = dir.path().join("folder");
    std::fs::create_dir(&root).unwrap();
    let first = root.join("a.md");
    let second = root.join("b.md");
    let third = root.join("c.md");
    std::fs::write(&first, "Use atomic releases.").unwrap();
    std::fs::write(&second, "astronomy apple bronze cactus diamond eagle forest guitar harp iron jelly kitten lemon moon nest ocean piano quartz ribbon star tulip umbrella violet wolf xylophone yarn zebra").unwrap();
    std::fs::write(&third, "Keep the data local.").unwrap();
    let (send, mut progress) = mpsc::unbounded_channel();
    let request = IngestRequest {
        watch: true,
        ..req(&root)
    };

    tokio::time::timeout(Duration::from_secs(10), async {
        let (report, id) = tokio::join!(
            ingest.ingest_paths(
                request,
                Arc::new(move |event| {
                    send.send((Instant::now(), event)).unwrap();
                })
            ),
            async {
                let (initial_time, initial) = progress.recv().await.unwrap();
                assert_eq!(initial.stage, "scanning");
                assert_eq!(initial.processed, 0);

                embeddings.recv().await.unwrap().send(()).unwrap();
                let in_flight = embeddings.recv().await.unwrap();
                let mut last_time = initial_time;
                loop {
                    let (time, event) = progress.recv().await.unwrap();
                    assert!(time.duration_since(last_time) >= Duration::from_millis(95));
                    assert_eq!(event.job_id, initial.job_id);
                    last_time = time;
                    if event.stage == "embedding" && event.processed == 2 {
                        assert_eq!(event.total, 4);
                        assert_eq!(
                            event.current_path,
                            Some(path(&second.canonicalize().unwrap()))
                        );
                        break;
                    }
                }

                assert!(ingest.cancel_job(initial.job_id).await.unwrap());
                in_flight.send(()).unwrap();
                initial.job_id
            }
        );
        let report = report.unwrap();
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(report.documents_created, 2);
        assert_eq!(report.memories_created, 2);
        assert!(!ingest.cancel_job(id).await.unwrap());
        assert!(embeddings.try_recv().is_err());
        assert!(store.list_watched().await.unwrap().is_empty());

        let find = |file: &Path| {
            let path = path(&file.canonicalize().unwrap());
            let store = store.clone();
            async move { store.find_source_document_by_path(&path).await.unwrap() }
        };
        assert!(find(&first).await.unwrap().file_hash.is_some());
        assert!(find(&second).await.unwrap().file_hash.is_none());
        assert!(find(&third).await.is_none());
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn ingests_files_with_privacy_metadata_reuse_and_incremental_updates() {
    let dir = tempfile::tempdir().unwrap();
    let (store, ingest, tokens) = setup(dir.path(), "test").await;
    let root = dir.path().join("documents");
    std::fs::create_dir(&root).unwrap();
    let file = root.join("a.md");
    let original = "# Release\nUse atomic commits and verify staged data.\nContact hello@cobalt.invalid for details.\n";
    std::fs::write(&file, original).unwrap();
    std::fs::write(root.join(".memoryignore"), "hidden.md\n").unwrap();
    std::fs::write(root.join("hidden.md"), "Private note").unwrap();
    std::fs::write(root.join(".env"), "API_KEY=secret").unwrap();
    let image = root.join("scan.png");
    std::fs::write(&image, b"placeholder").unwrap();
    let report = ingest
        .ingest_paths(req(&root), quiet_progress())
        .await
        .unwrap();
    assert_eq!(report.documents_created, 2);
    assert!(report.memories_created > 1);
    assert_eq!(report.redacted_secrets, 1);
    assert_eq!(report.skipped_ignored, 3);
    assert_eq!(report.errors.len(), 1);
    assert!(
        report.errors[0]
            .message
            .contains("excluded by file extension")
    );
    let doc = store
        .find_source_document_by_path(&path(&file.canonicalize().unwrap()))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(doc.source_type, SourceType::Md);
    assert_eq!(doc.total_tokens, tokens.count(original) as i64);
    assert_eq!(doc.file_hash, Some(digest(original.as_bytes())));
    let changes = ingest
        .ingest_paths(req(&file), quiet_progress())
        .await
        .unwrap();
    assert_eq!(changes.documents_unchanged, 1);
    let before = store.graph(GraphQuery::default()).await.unwrap();
    assert!(
        before
            .nodes
            .iter()
            .all(|node| !node.preview.contains("hello@cobalt.invalid"))
    );
    std::fs::write(&file, "Use stateless jobs.").unwrap();
    let changes = ingest
        .ingest_paths(req(&file), quiet_progress())
        .await
        .unwrap();
    assert_eq!(changes.documents_updated, 1);
    let graph = store
        .graph(GraphQuery {
            include_archived: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        graph
            .nodes
            .iter()
            .filter(|node| node.status == MemoryStatus::Archived)
            .count(),
        before.nodes.len()
    );
    let saved = ingest
        .promote_file_to_reusable(PromoteFileRequest {
            path: path(&file),
            project_id: None,
            summary: Some("Call us at mail@cobalt.invalid for the interface.".into()),
        })
        .await
        .unwrap();
    assert!(saved.is_reusable);
    assert_eq!(saved.source_doc_id, Some(doc.id));
    assert!(
        !saved
            .reusable_snippet
            .unwrap()
            .contains("mail@cobalt.invalid")
    );
}

#[tokio::test]
async fn past_life_accepts_each_supported_source_and_omits_assistant_speculation() {
    let dir = tempfile::tempdir().unwrap();
    let (store, ingest, _) = setup(dir.path(), "test").await;
    let chatgpt = dir.path().join("chatgpt.json");
    let claude = dir.path().join("claude.zip");
    // The built-in ignores exclude archives unless the user opts in.
    let global = dir.path().join("ignore-config");
    std::fs::create_dir(&global).unwrap();
    std::fs::write(global.join(".memoryignore"), "!claude.zip\n").unwrap();

    let cursor = dir.path().join(".cursorrules");
    let instructions = dir.path().join("CLAUDE.md");
    let folder = dir.path().join("notes");
    std::fs::create_dir(&folder).unwrap();
    std::fs::write(&chatgpt, json!([{"current_node":"b","mapping":{
        "a":{"message":{"author":{"role":"user"},"content":{"parts":["We decided to use SQLite."]}}},
        "b":{"parent":"a","message":{"author":{"role":"assistant"},"content":{"parts":["We decided to print private speculation."]}}}
    }}]).to_string()).unwrap();
    let mut archive = zip::ZipWriter::new(std::fs::File::create(&claude).unwrap());
    archive
        .start_file(
            "export/conversations.json",
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )
        .unwrap();
    std::io::Write::write_all(&mut archive, json!([{"chat_messages":[{"sender":"human","content":[{"type":"text","text":"I prefer local search."}]}]}]).to_string().as_bytes()).unwrap();
    archive.finish().unwrap();
    std::fs::write(&cursor, "- Use atomic releases.\n").unwrap();
    std::fs::write(&instructions, "# Testing\n- Always test recovery.\n").unwrap();
    std::fs::write(folder.join("design.md"), "# API\n- Keep IDs stable.\n").unwrap();
    for (kind, input) in [
        (PastLifeSource::ChatgptExport, chatgpt),
        (PastLifeSource::ClaudeExport, claude),
        (PastLifeSource::CursorRules, cursor),
        (PastLifeSource::ClaudeMd, instructions),
        (PastLifeSource::MarkdownFolder, folder),
    ] {
        let report = ingest
            .import_past_life(
                PastLifeImportRequest {
                    source: kind,
                    path: path(&input),
                    project_id: None,
                },
                quiet_progress(),
            )
            .await
            .unwrap();
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(report.memories_created, 1);
    }
    let nodes = store.graph(GraphQuery::default()).await.unwrap().nodes;
    assert_eq!(nodes.len(), 5);
    assert!(
        nodes.iter().any(
            |node| node.category == MemoryCategory::Decision && node.preview.contains("SQLite")
        )
    );
    assert!(
        nodes
            .iter()
            .all(|node| !node.preview.contains("speculation"))
    );
}

fn build_pdf(path: &Path) {
    use lopdf::content::{Content, Operation};
    use lopdf::{Document, Object, Stream, dictionary};
    let mut pdf = Document::with_version("1.5");
    let pages = pdf.new_object_id();
    let font = pdf.add_object(
        dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica" },
    );
    let resources = pdf.add_object(dictionary! { "Font" => dictionary! { "F1" => font } });
    let content = Content {
        operations: vec![
            Operation::new("BT", vec![]),
            Operation::new("Tf", vec!["F1".into(), 16.into()]),
            Operation::new("Td", vec![20.into(), 20.into()]),
            Operation::new("Tj", vec![Object::string_literal("A searchable PDF note")]),
            Operation::new("ET", vec![]),
        ],
    };
    let content = pdf.add_object(Stream::new(dictionary! {}, content.encode().unwrap()));
    let page =
        pdf.add_object(dictionary! { "Type" => "Page", "Parent" => pages, "Contents" => content });
    pdf.objects.insert(pages, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![page.into()],
        "Count" => 1, "Resources" => resources, "MediaBox" => vec![0.into(), 0.into(), 300.into(), 300.into()] }));
    let root = pdf.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
    pdf.trailer.set("Root", root);
    pdf.save(path).unwrap();
}

#[tokio::test]
async fn reads_pdf_text_without_ocr_models() {
    let dir = tempfile::tempdir().unwrap();
    let (store, ingest, _) = setup(dir.path(), "test").await;
    let pdf = dir.path().join("note.pdf");
    build_pdf(&pdf);
    let report = ingest
        .ingest_paths(req(&pdf), quiet_progress())
        .await
        .unwrap();
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(report.memories_created, 1);
    assert!(
        store.graph(GraphQuery::default()).await.unwrap().nodes[0]
            .preview
            .contains("searchable PDF note")
    );
}

async fn source_at(store: &SqliteStore, file: &Path) -> Option<SourceDocument> {
    store
        .find_source_document_by_path(&path(file))
        .await
        .unwrap()
}

async fn wait_for_hash(store: &SqliteStore, file: &Path, hash: Option<String>) {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            if source_at(store, file)
                .await
                .is_some_and(|doc| doc.file_hash == hash)
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn watcher_replaces_chunks_and_vectors_without_rewriting_linked_memory() {
    let dir = tempfile::tempdir().unwrap();
    let (store, ingest, tokens) = setup(dir.path(), "test").await;
    let file = dir.path().canonicalize().unwrap().join("watched.md");
    std::fs::write(&file, "Original astronomy notes.").unwrap();
    let watch = IngestRequest {
        watch: true,
        ..req(&file)
    };
    assert!(
        ingest
            .ingest_paths(watch, quiet_progress())
            .await
            .unwrap()
            .errors
            .is_empty()
    );
    let doc = source_at(&store, &file).await.unwrap();
    let old = store.graph(GraphQuery::default()).await.unwrap().nodes[0].id;
    let written = store
        .insert_document_chunk(NewMemory {
            source_doc_id: Some(doc.id),
            source_client: Some("claude-code".into()),
            ..memory("Keep the telescope aligned to the north.")
        })
        .await
        .unwrap()
        .memory;
    let (changes, mut activity) = mpsc::unbounded_channel();
    let ingest = ingest.with_watcher_callbacks(
        quiet_progress(),
        Arc::new(move |event| {
            changes.send(event).unwrap();
        }),
    );
    ingest.start_watcher().await.unwrap();
    let new_text = "Revised telescope alignment notes.";
    let mut replacement = tempfile::NamedTempFile::new_in(dir.path()).unwrap();
    std::io::Write::write_all(&mut replacement, new_text.as_bytes()).unwrap();
    replacement.persist(&file).unwrap();
    wait_for_hash(&store, &file, Some(digest(new_text.as_bytes()))).await;
    ingest.stop_watcher().await.unwrap();

    let deleted = activity.try_recv().unwrap();
    let created = activity.try_recv().unwrap();
    assert_eq!(deleted.kind, MemoryChangeKind::Deleted);
    assert_eq!(deleted.memory_ids, vec![old]);
    assert_eq!(created.kind, MemoryChangeKind::Created);
    assert_eq!(created.source_client.as_deref(), Some("cobalt-ingest"));
    assert_eq!(created.memory_ids.len(), 1);
    assert!(activity.try_recv().is_err());
    let fresh = created.memory_ids[0];
    assert!(store.get_memory(old).await.unwrap().is_none());
    assert_eq!(
        store.get_memory(fresh).await.unwrap().unwrap().content,
        new_text
    );
    assert_eq!(
        store.get_memory(written.id).await.unwrap().unwrap(),
        written
    );
    let updated = source_at(&store, &file).await.unwrap();
    assert_eq!(updated.id, doc.id);
    assert_eq!(updated.total_tokens, tokens.count(new_text) as i64);
    let index = SqliteVec::open(&store, 2).await.unwrap();
    let hits = index
        .search(&[1.0, 0.0], 10, &VectorFilter::default())
        .await
        .unwrap();
    assert_eq!(hits.len(), 2);
    assert!(hits.iter().any(|hit| hit.memory_id == fresh));

    std::fs::remove_file(&file).unwrap();
    ingest.start_watcher().await.unwrap();
    wait_for_hash(&store, &file, None).await;
    ingest.stop_watcher().await.unwrap();
    let archived = store.get_memory(fresh).await.unwrap().unwrap();
    assert_eq!(archived.status, MemoryStatus::Archived);
    assert_eq!(archived.version_reason.as_deref(), Some("file deleted"));
    assert_eq!(
        store.get_memory(written.id).await.unwrap().unwrap(),
        written
    );
    assert_eq!(
        activity.try_recv().unwrap().kind,
        MemoryChangeKind::Archived
    );
}

#[tokio::test]
async fn watched_directory_discovers_and_retires_files_under_moved_or_deleted_subtrees() {
    let dir = tempfile::tempdir().unwrap();
    let (store, ingest, _) = setup(dir.path(), "test").await;
    let root = dir.path().canonicalize().unwrap().join("documents");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(
        root.join(".memoryignore"),
        "/hidden.md
",
    )
    .unwrap();
    let watch = IngestRequest {
        watch: true,
        ..req(&root)
    };
    assert!(
        ingest
            .ingest_paths(watch, quiet_progress())
            .await
            .unwrap()
            .errors
            .is_empty()
    );
    ingest.start_watcher().await.unwrap();
    let nested = root.join("nested");
    std::fs::create_dir(&nested).unwrap();
    let first = nested.join("first.md");
    let second = root.join("second.md");
    let text = b"New field notes";
    std::fs::write(&first, text).unwrap();
    std::fs::write(&second, b"Root notes").unwrap();
    let excluded = [
        root.join("hidden.md"),
        root.join(".env"),
        nested.join("oversized.txt"),
    ];
    std::fs::write(&excluded[0], text).unwrap();
    std::fs::write(&excluded[1], text).unwrap();
    std::fs::write(&excluded[2], vec![b'x'; 2 * 1024 * 1024 + 1]).unwrap();
    wait_for_hash(&store, &first, Some(digest(text))).await;
    wait_for_hash(&store, &second, Some(digest(b"Root notes"))).await;
    let before = store.graph(GraphQuery::default()).await.unwrap();
    assert_eq!(before.nodes.len(), 2);
    let moved = dir.path().join("moved");
    std::fs::rename(&nested, &moved).unwrap();
    wait_for_hash(&store, &first, None).await;
    std::fs::remove_dir_all(&root).unwrap();
    wait_for_hash(&store, &second, None).await;
    ingest.stop_watcher().await.unwrap();
    for file in excluded {
        assert!(
            source_at(&store, &file).await.is_none(),
            "{}",
            file.display()
        );
    }
    for node in before.nodes {
        let row = store.get_memory(node.id).await.unwrap().unwrap();
        assert_eq!(row.status, MemoryStatus::Archived);
        assert_eq!(row.version_reason.as_deref(), Some("file deleted"));
    }
}

#[tokio::test]
async fn watcher_debounces_editor_bursts() {
    let dir = tempfile::tempdir().unwrap();
    let (store, ingest, _) = setup(dir.path(), "test").await;
    let file = dir.path().canonicalize().unwrap().join("burst.md");
    std::fs::write(&file, "Initial notes").unwrap();
    let watch = IngestRequest {
        watch: true,
        ..req(&file)
    };
    ingest.ingest_paths(watch, quiet_progress()).await.unwrap();
    let (progress, mut updates) = mpsc::unbounded_channel();
    let (changes, mut activity) = mpsc::unbounded_channel();
    let ingest = ingest.with_watcher_callbacks(
        Arc::new(move |update| {
            progress.send(update).unwrap();
        }),
        Arc::new(move |event| {
            changes.send(event).unwrap();
        }),
    );
    ingest.start_watcher().await.unwrap();
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let update = updates.recv().await.unwrap();
            if update.total > 0 && update.processed == update.total {
                break;
            }
        }
    })
    .await
    .unwrap();
    for text in ["Draft one", "Draft two", "Final notes"] {
        std::fs::write(&file, text).unwrap();
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    wait_for_hash(&store, &file, Some(digest(b"Final notes"))).await;
    ingest.stop_watcher().await.unwrap();
    let changes: Vec<_> = std::iter::from_fn(|| activity.try_recv().ok()).collect();
    assert_eq!(
        changes.iter().map(|event| event.kind).collect::<Vec<_>>(),
        vec![MemoryChangeKind::Deleted, MemoryChangeKind::Created]
    );
    let graph = store
        .graph(GraphQuery {
            include_archived: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(graph.nodes.len(), 1);
    assert_eq!(graph.nodes[0].preview, "Final notes");
}

#[tokio::test]
async fn stopping_watcher_stops_active_reconciliation_between_chunks() {
    let dir = tempfile::tempdir().unwrap();
    let (calls, mut embeddings) = mpsc::unbounded_channel();
    let (store, ingest, _) = setup_with_embedder_gate(dir.path(), "test", Some(calls)).await;
    let file = dir.path().join("watched.md");
    std::fs::write(&file, "").unwrap();
    let watch = IngestRequest {
        watch: true,
        ..req(&file)
    };
    let initial = ingest.ingest_paths(watch, quiet_progress()).await.unwrap();
    assert!(initial.errors.is_empty());
    ingest.start_watcher().await.unwrap();
    std::fs::write(&file, "astronomy apple bronze cactus diamond eagle forest guitar harp iron jelly kitten lemon moon nest ocean piano quartz ribbon star tulip umbrella violet wolf xylophone yarn zebra").unwrap();

    tokio::time::timeout(Duration::from_secs(10), async {
        let in_flight = embeddings.recv().await.unwrap();
        let (stopped, ()) = tokio::join!(
            biased;
            ingest.stop_watcher(),
            async { in_flight.send(()).unwrap() },
        );
        stopped.unwrap();
    })
    .await
    .unwrap();

    assert!(embeddings.try_recv().is_err());
    let doc = store
        .find_source_document_by_path(&path(&file.canonicalize().unwrap()))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(doc.file_hash, Some(digest(b"")));
    assert!(doc.is_watched);
}

#[tokio::test]
async fn portable_roundtrip_preserves_identity_isolates_collisions_and_reembeds() {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let (origin, exporter, _) = setup(source.path(), "model-a").await;
    let (dest, importer, _) = setup(target.path(), "model-b").await;
    let project = origin
        .create_project(NewProject {
            name: "Recipes".into(),
            root_path: None,
            color_hex: None,
        })
        .await
        .unwrap();
    let project_note = origin
        .save_memory(NewMemory {
            project_id: Some(project.id),
            ..memory("Decide on schema validation.")
        })
        .await
        .unwrap()
        .memory;
    let imported_note = origin
        .save_memory(memory("We decided to use a narrow API."))
        .await
        .unwrap()
        .memory;
    let unrelated_local = dest
        .save_memory(memory("Keep existing external API."))
        .await
        .unwrap()
        .memory;
    let capsule = source.path().join("selected.cbrain");
    let manifest = exporter
        .export_capsule(CapsuleExportRequest {
            project_id: Some(project.id),
            memory_ids: vec![],
            dest_path: path(&capsule),
        })
        .await
        .unwrap();
    assert_eq!(manifest.memory_count, 1);
    assert_eq!(manifest.dimensions, 2);
    assert_eq!(manifest.checksums.len(), 1);
    let report = importer.import_capsule(&path(&capsule)).await.unwrap();
    assert_eq!(
        (report.inserted, report.projects_created, report.reembedded),
        (1, 1, 1)
    );
    assert_eq!(
        dest.get_memory(project_note.id)
            .await
            .unwrap()
            .unwrap()
            .content,
        project_note.content
    );
    assert_eq!(
        importer
            .import_capsule(&path(&capsule))
            .await
            .unwrap()
            .skipped_identical,
        1
    );

    let backup = source.path().join("all.cobalt-backup");
    let manifest = exporter
        .export_backup(BackupExportRequest {
            dest_path: path(&backup),
            password: Some("portable passphrase".into()),
            include_history: true,
        })
        .await
        .unwrap();
    assert!(manifest.encrypted);
    assert_eq!(manifest.counts.memories, 2);
    assert!(matches!(
        importer
            .import_backup(BackupImportRequest {
                path: path(&backup),
                password: None
            })
            .await,
        Err(CobaltError::InvalidInput(_))
    ));
    let report = importer
        .import_backup(BackupImportRequest {
            path: path(&backup),
            password: Some("portable passphrase".into()),
        })
        .await
        .unwrap();
    assert_eq!(
        (
            report.inserted,
            report.skipped_identical,
            report.isolated,
            report.reembedded
        ),
        (1, 1, 1, 1)
    );
    assert!(report.review_branch.unwrap().starts_with("import-"));
    let local = dest.get_memory(unrelated_local.id).await.unwrap().unwrap();
    assert_eq!(local.status, MemoryStatus::Active);
    assert_ne!(
        dest.get_memory(imported_note.id)
            .await
            .unwrap()
            .unwrap()
            .branch_id,
        local.branch_id
    );
}

#[tokio::test]
async fn newer_same_uuid_supersedes_once_and_corrupt_archive_writes_nothing() {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let (origin, exporter, _) = setup(source.path(), "test").await;
    let (dest, importer, _) = setup(target.path(), "test").await;
    let row = origin
        .save_memory(memory("First imported text."))
        .await
        .unwrap()
        .memory;
    let backup = source.path().join("all.cobalt-backup");
    exporter
        .export_backup(BackupExportRequest {
            dest_path: path(&backup),
            password: None,
            include_history: false,
        })
        .await
        .unwrap();
    let arg = BackupImportRequest {
        path: path(&backup),
        password: None,
    };
    let mut older = row.clone();
    older.content = "Older local text.".into();
    older.content_hash = digest(older.content.as_bytes());
    older.updated_at -= std::time::Duration::from_secs(2);
    dest.insert_portable_memory(older, None).await.unwrap();
    assert_eq!(
        importer
            .import_backup(arg.clone())
            .await
            .unwrap()
            .superseded,
        1
    );
    let older = dest.get_memory(row.id).await.unwrap().unwrap();
    assert_eq!(older.status, MemoryStatus::Superseded);
    assert_eq!(
        older.version_reason.as_deref(),
        Some("Superseded by newer imported memory")
    );
    let next = dest
        .get_memory(older.superseded_by.unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(next.content, row.content);
    assert_eq!(
        importer
            .import_backup(arg.clone())
            .await
            .unwrap()
            .skipped_identical,
        1
    );
    let mut corrupted = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let mut original = zip::ZipArchive::new(std::fs::File::open(&backup).unwrap()).unwrap();
    let mut archived_manifest = original.by_name("manifest.json").unwrap();
    let mut manifest = Vec::new();
    std::io::Read::read_to_end(&mut archived_manifest, &mut manifest).unwrap();
    drop(archived_manifest);
    drop(original);
    corrupted
        .start_file("manifest.json", zip::write::SimpleFileOptions::default())
        .unwrap();
    std::io::Write::write_all(&mut corrupted, &manifest).unwrap();
    corrupted
        .start_file("data.json", zip::write::SimpleFileOptions::default())
        .unwrap();
    std::io::Write::write_all(&mut corrupted, b"{}").unwrap();
    std::fs::write(&backup, corrupted.finish().unwrap().into_inner()).unwrap();
    assert!(matches!(
        importer.import_backup(arg).await,
        Err(CobaltError::Integrity(message)) if message.contains("checksum")
    ));
    assert_eq!(dest.get_memory(next.id).await.unwrap().unwrap(), next);
}

#[tokio::test]
async fn backup_retains_version_links_handoff_and_scrubbed_telemetry_history() {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let (origin, exporter, _) = setup(source.path(), "test").await;
    let (dest, importer, _) = setup(target.path(), "test").await;
    let first = origin
        .save_memory(memory("First version."))
        .await
        .unwrap()
        .memory;
    let last = origin
        .update_memory(UpdateMemoryRequest {
            memory_id: first.id,
            new_content: "New version.".into(),
            reason: "Decision revised".into(),
            source_client: None,
            confidence: None,
        })
        .await
        .unwrap()
        .memory;
    let handoff = origin
        .create_handoff(NewHandoff {
            project_id: None,
            source_client: "local-client".into(),
            summary: "Review the change.".into(),
            last_error: None,
            open_files: vec![".env".into(), "README.md".into()],
            ttl_hours: None,
        })
        .await
        .unwrap();
    origin
        .record_event(NewTelemetryEvent {
            client_name: "local-client".into(),
            operation: TelemetryOperation::Read,
            query_text: Some("Ask support at team@cobalt.invalid".into()),
            returned_items: vec![ReturnedItem {
                memory_id: last.id,
                source_doc_id: None,
                similarity_score: 1.0,
                chunk_tokens: 10,
                content_snapshot: Some("Contact team@cobalt.invalid".into()),
            }],
            injected_tokens: 4,
            output_tokens_saved: 2,
            latency_ms: 1,
            project_id: None,
        })
        .await
        .unwrap();
    let archive = source.path().join("history.cobalt-backup");
    let manifest = exporter
        .export_backup(BackupExportRequest {
            dest_path: path(&archive),
            password: None,
            include_history: true,
        })
        .await
        .unwrap();
    assert_eq!(
        (
            manifest.counts.memories,
            manifest.counts.handoffs,
            manifest.counts.telemetry_logs
        ),
        (2, 1, 1)
    );
    let args = BackupImportRequest {
        path: path(&archive),
        password: None,
    };
    assert_eq!(
        importer.import_backup(args.clone()).await.unwrap().inserted,
        2
    );
    assert_eq!(
        importer
            .import_backup(args)
            .await
            .unwrap()
            .skipped_identical,
        2
    );
    let chain = dest.memory_history(first.id).await.unwrap();
    assert_eq!(chain.len(), 2);
    assert_eq!(chain[0].superseded_by, Some(last.id));
    assert_eq!(chain[0].version_reason.as_deref(), Some("Decision revised"));
    let logs = dest
        .query_telemetry(TelemetryQuery::default())
        .await
        .unwrap();
    assert_eq!(logs.total, 1);
    assert_eq!(logs.items[0].saved_tokens, 8);
    assert_eq!(
        logs.items[0].query_text.as_deref(),
        Some("Ask support at [REDACTED:email]")
    );
    let restored = dest.portable_handoffs().await.unwrap();
    assert_eq!(restored[0].id, handoff.id);
    assert_eq!(restored[0].open_files, vec!["README.md"]);
}
