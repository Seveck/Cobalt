use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use cobalt_core::error::{CobaltError, Result};
use cobalt_core::model::{GraphQuery, NewSourceDocument, SourceDocument};
use cobalt_core::transfer::{IngestIssue, IngestRequest};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::Context;
use crate::documents::{INGEST_CLIENT, issue};
use crate::jobs::Cancellation;

const DEBOUNCE: Duration = Duration::from_millis(300);
const MAX_DEBOUNCE: Duration = Duration::from_secs(1);
const REFRESH: Duration = Duration::from_secs(2);

pub(crate) struct WatchTask {
    cancellation: Cancellation,
    handle: Option<JoinHandle<()>>,
}

impl WatchTask {
    pub(crate) async fn stop(mut self) {
        self.cancellation.cancel();
        if let Some(handle) = self.handle.take() {
            let _ = handle.await;
        }
    }
}

impl Drop for WatchTask {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}

fn watcher_error(error: notify::Error) -> CobaltError {
    CobaltError::Storage(format!("file watcher: {error}"))
}

fn refresh(
    watcher: &mut RecommendedWatcher,
    previous: &mut HashMap<PathBuf, RecursiveMode>,
    docs: &[SourceDocument],
    global: Option<&Path>,
) -> Vec<IngestIssue> {
    let mut roots = HashMap::new();
    if !docs.is_empty()
        && let Some(global) = global.filter(|path| path.is_dir())
    {
        roots.insert(global.to_owned(), RecursiveMode::NonRecursive);
    }
    for doc in docs {
        let path = Path::new(&doc.file_path);
        let target = if doc.is_dir && path.is_dir() {
            roots.insert(path.to_owned(), RecursiveMode::Recursive);
            path.parent()
        } else {
            path.parent()
        };
        if let Some(parent) = target.filter(|path| path.is_dir()) {
            roots
                .entry(parent.to_owned())
                .or_insert(RecursiveMode::NonRecursive);
        }
    }
    for path in previous.keys().filter(|path| !roots.contains_key(*path)) {
        let _ = watcher.unwatch(path);
    }
    previous.retain(|path, _| roots.contains_key(path));
    let mut issues = Vec::new();
    for (path, mode) in roots {
        if previous.get(&path) != Some(&mode) {
            if previous.remove(&path).is_some() {
                let _ = watcher.unwatch(&path);
            }
            match watcher.watch(&path, mode) {
                Ok(()) => {
                    previous.insert(path, mode);
                }
                Err(error) => issues.push(issue(&path, watcher_error(error))),
            }
        }
    }
    issues
}

pub(crate) async fn start(context: Arc<Context>) -> Result<WatchTask> {
    let cancellation = Cancellation::default();
    let docs = list_watched(&context, &cancellation).await?;
    let (event_tx, mut events) = mpsc::channel::<notify::Result<Event>>(1024);
    let overflow = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let overrun = overflow.clone();
    let mut watcher = notify::recommended_watcher(move |event| {
        if let Err(mpsc::error::TrySendError::Full(_)) = event_tx.try_send(event) {
            overrun.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    })
    .map_err(watcher_error)?;
    let mut roots = HashMap::new();
    for issue in refresh(
        &mut watcher,
        &mut roots,
        &docs,
        context.global_ignore.as_deref(),
    ) {
        context.watch_issue(issue);
    }
    let task_cancellation = cancellation.clone();
    let handle = tokio::spawn(async move {
        let mut docs = docs;
        let mut pending = BTreeSet::new();
        let mut tick = tokio::time::interval(DEBOUNCE);
        let mut last_refresh = tokio::time::Instant::now();
        let mut last_event = last_refresh;
        let mut batch_started = None;
        let mut rescan = true;
        loop {
            tokio::select! {
                _ = task_cancellation.cancelled() => break,
                received = events.recv() => {
                    match received {
                        Some(Ok(event)) if !event.kind.is_access() => {
                            rescan |= event.need_rescan();
                            if !event.paths.is_empty() {
                                last_event = tokio::time::Instant::now();
                                batch_started.get_or_insert(last_event);
                                pending.extend(event.paths);
                            }
                        }
                        Some(Err(error)) => {
                            context.watch_issue(issue(Path::new("watcher"), watcher_error(error)));
                            rescan = true;
                        }
                        Some(Ok(_)) => {}
                        None => break,
                    }
                }
                _ = tick.tick() => {
                    if last_refresh.elapsed() >= REFRESH {
                        match list_watched(&context, &task_cancellation).await {
                            Ok(updated) => {
                                for doc in &updated {
                                    if !docs.iter().any(|previous| previous.id == doc.id) {
                                        pending.insert(PathBuf::from(&doc.file_path));
                                    }
                                }
                                docs = updated;
                                for issue in refresh(&mut watcher, &mut roots, &docs, context.global_ignore.as_deref()) { context.watch_issue(issue); }
                            }
                            Err(CobaltError::Cancelled) => break,
                            Err(error) => context.watch_issue(issue(Path::new("watcher"), error)),
                        }
                        last_refresh = tokio::time::Instant::now();
                    }
                    rescan |= overflow.swap(false, std::sync::atomic::Ordering::Relaxed);
                    let batch_ready = !pending.is_empty() && (last_event.elapsed() >= DEBOUNCE
                        || batch_started.is_some_and(|start| start.elapsed() >= MAX_DEBOUNCE));
                    if rescan || batch_ready {
                        batch_started = None;
                        let paths = std::mem::take(&mut pending);
                        let full = std::mem::take(&mut rescan);
                        reconcile(&context, &docs, paths, full, &task_cancellation).await;
                    }
                }
            }
        }
    });
    Ok(WatchTask {
        cancellation,
        handle: Some(handle),
    })
}

async fn list_watched(
    context: &Context,
    cancellation: &Cancellation,
) -> Result<Vec<SourceDocument>> {
    let _write = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(CobaltError::Cancelled),
        guard = context.writes.lock() => guard,
    };
    context.store.list_watched().await
}

async fn reconcile(
    context: &Context,
    docs: &[SourceDocument],
    paths: BTreeSet<PathBuf>,
    full: bool,
    cancellation: &Cancellation,
) {
    let mut jobs = BTreeSet::new();
    let watched_directories: BTreeSet<_> = docs
        .iter()
        .filter(|doc| doc.is_dir)
        .map(|doc| Path::new(&doc.file_path))
        .collect();
    let global_changed = context
        .global_ignore
        .as_ref()
        .is_some_and(|global| paths.contains(&global.join(cobalt_core::paths::MEMORY_IGNORE_FILE)));
    for doc in docs {
        if cancellation.check().is_err() {
            return;
        }
        let watched = Path::new(&doc.file_path);
        let ignore_changed = paths.iter().any(|path| {
            path.file_name().is_some_and(|name| name == ".memoryignore")
                && path
                    .parent()
                    .is_some_and(|parent| watched.starts_with(parent))
        });
        if full || global_changed || ignore_changed || paths.contains(watched) {
            jobs.insert((doc.project_id, watched.to_owned()));
        }
        if doc.is_dir {
            for path in paths.iter().filter(|path| path.starts_with(watched)) {
                if path.file_name().is_some_and(|name| name == ".memoryignore") {
                    jobs.insert((doc.project_id, watched.to_owned()));
                } else if super::documents::eligible(path, None) {
                    jobs.insert((doc.project_id, path.clone()));
                }
            }
        }
    }
    for (project_id, path) in jobs {
        if cancellation.check().is_err() {
            return;
        }
        if !path.exists() {
            if let Err(error) = retire_missing(context, &path, cancellation).await
                && !matches!(error, CobaltError::Cancelled)
            {
                context.watch_issue(issue(&path, error));
            }
            continue;
        }
        let req = IngestRequest {
            paths: vec![path.to_string_lossy().into_owned()],
            project_id,
            watch: true,
            mark_reusable: false,
            ocr: true,
        };
        let folder_limited = path
            .ancestors()
            .skip(1)
            .any(|parent| watched_directories.contains(parent));
        let report = context
            .ingest_watched(req, folder_limited, cancellation)
            .await;
        if cancellation.check().is_err() {
            return;
        }
        match report {
            Ok(report) => {
                let excluded = report.skipped_ignored == 1 && report.errors.is_empty();
                for issue in report.errors {
                    context.watch_issue(issue);
                }
                if excluded
                    && report.documents_created
                        + report.documents_updated
                        + report.documents_unchanged
                        == 0
                    && let Err(error) = retire_missing(context, &path, cancellation).await
                    && !matches!(error, CobaltError::Cancelled)
                {
                    context.watch_issue(issue(&path, error));
                }
            }
            Err(error) => context.watch_issue(issue(&path, error)),
        }
    }
}

async fn retire_missing(context: &Context, path: &Path, cancellation: &Cancellation) -> Result<()> {
    let _write = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(CobaltError::Cancelled),
        guard = context.writes.lock() => guard,
    };
    let Some(doc) = context
        .store
        .find_source_document_by_path(&super::documents::path_string(path)?)
        .await?
    else {
        return Ok(());
    };
    if doc.is_dir || !doc.is_watched || doc.file_hash.is_none() {
        return Ok(());
    }
    if context.store.load_settings().await?.read_only {
        return Err(CobaltError::ReadOnly);
    }
    let branch = context.store.active_branch().await?.id;
    let rows = if let Some(store) = &context.sqlite {
        store
            .ingested_memories(branch, doc.id, INGEST_CLIENT)
            .await?
    } else {
        let graph = context
            .store
            .graph(GraphQuery {
                branch_id: Some(branch),
                ..Default::default()
            })
            .await?;
        let mut rows = Vec::new();
        for node in graph
            .nodes
            .into_iter()
            .filter(|node| node.source_doc_id == Some(doc.id))
        {
            if let Some(row) = context.store.get_memory(node.id).await?
                && row.source_client.as_deref() == Some(INGEST_CLIENT)
            {
                rows.push(row);
            }
        }
        rows
    };
    for row in rows
        .into_iter()
        .filter(|row| !row.is_core_pin && !row.is_encrypted)
    {
        context
            .store
            .archive_memory(row.id, "Watched source removed or excluded")
            .await?;
    }
    context
        .store
        .upsert_source_document(NewSourceDocument {
            project_id: doc.project_id,
            file_path: doc.file_path,
            is_dir: false,
            source_type: Some(doc.source_type),
            file_hash: None,
            total_tokens: 0,
            is_watched: doc.is_watched,
        })
        .await?;
    Ok(())
}
