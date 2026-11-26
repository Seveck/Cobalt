use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use cobalt_core::enums::MemoryChangeKind;
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::ids::Id;
use cobalt_core::model::{MemoryChanged, SourceDocument};
use cobalt_core::traits::ProgressSink;
use cobalt_core::transfer::{IngestIssue, IngestProgress, IngestRequest};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::Context;
use crate::documents::{INGEST_CLIENT, issue};
use crate::jobs::Cancellation;

const DEBOUNCE: Duration = Duration::from_millis(300);
const MAX_DEBOUNCE: Duration = Duration::from_secs(1);
const REFRESH: Duration = Duration::from_secs(2);

#[derive(Clone, Default)]
pub(crate) struct Callbacks {
    pub(crate) progress: Option<ProgressSink<IngestProgress>>,
    pub(crate) memory_changed: Option<ProgressSink<MemoryChanged>>,
}

impl Callbacks {
    pub(crate) fn changed(&self, kind: MemoryChangeKind, memory_ids: Vec<Id>) {
        if !memory_ids.is_empty()
            && let Some(sink) = &self.memory_changed
        {
            sink(MemoryChanged {
                kind,
                memory_ids,
                source_client: Some(INGEST_CLIENT.into()),
            });
        }
    }
}

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
    for doc in docs.iter().filter(|doc| doc.is_dir) {
        let path = Path::new(&doc.file_path);
        if path.is_dir() {
            roots.insert(path.to_owned(), RecursiveMode::Recursive);
        }
    }
    for doc in docs {
        let path = Path::new(&doc.file_path);
        if path
            .ancestors()
            .skip(1)
            .any(|parent| roots.get(parent) == Some(&RecursiveMode::Recursive))
        {
            continue;
        }
        if let Some(parent) = path.ancestors().skip(1).find(|parent| parent.is_dir()) {
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

pub(crate) async fn start(context: Arc<Context>, callbacks: Callbacks) -> Result<WatchTask> {
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
        let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + DEBOUNCE, DEBOUNCE);
        let mut last_refresh = tokio::time::Instant::now();
        let mut last_event = last_refresh;
        let mut batch_started = None;
        let mut rescan = true;
        let mut retry = BTreeSet::new();
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
                    let refresh_due = last_refresh.elapsed() >= REFRESH;
                    rescan |= overflow.swap(false, std::sync::atomic::Ordering::Relaxed);
                    let batch_ready = batch_started.is_some() && (last_event.elapsed() >= DEBOUNCE
                        || batch_started.is_some_and(|start| start.elapsed() >= MAX_DEBOUNCE));
                    if refresh_due || batch_ready || rescan {
                        match list_watched(&context, &task_cancellation).await {
                            Ok(updated) => {
                                let previous: HashSet<_> = docs.iter()
                                    .map(|doc| (doc.id, doc.file_path.as_str())).collect();
                                for doc in &updated {
                                    if !previous.contains(&(doc.id, doc.file_path.as_str())) {
                                        pending.insert(PathBuf::from(&doc.file_path));
                                    }
                                }
                                docs = updated;
                                for issue in refresh(&mut watcher, &mut roots, &docs, context.global_ignore.as_deref()) { context.watch_issue(issue); }
                            }
                            Err(CobaltError::Cancelled) => break,
                            Err(error) => context.watch_issue(issue(Path::new("watcher"), error)),
                        }
                        if refresh_due {
                            last_refresh = tokio::time::Instant::now();
                            pending.append(&mut retry);
                        }
                    }
                    if batch_ready || (batch_started.is_none() && (rescan || !pending.is_empty())) {
                        batch_started = None;
                        let paths = std::mem::take(&mut pending);
                        let full = std::mem::take(&mut rescan);
                        retry.extend(reconcile(&context, &docs, paths, full, &task_cancellation, &callbacks).await);
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

struct WatchTarget {
    project_id: Option<Id>,
    folder_limited: bool,
    was_directory: Option<bool>,
}

async fn reconcile(
    context: &Context,
    docs: &[SourceDocument],
    paths: BTreeSet<PathBuf>,
    full: bool,
    cancellation: &Cancellation,
    callbacks: &Callbacks,
) -> BTreeSet<PathBuf> {
    let mut jobs = BTreeMap::new();
    let directories: BTreeMap<_, _> = docs
        .iter()
        .filter(|doc| doc.is_dir)
        .map(|doc| (Path::new(&doc.file_path), doc.project_id))
        .collect();
    let global_changed = context
        .global_ignore
        .as_ref()
        .is_some_and(|global| paths.contains(&global.join(cobalt_core::paths::MEMORY_IGNORE_FILE)));
    let ignore_roots: Vec<_> = paths
        .iter()
        .filter_map(|path| {
            (path.file_name()? == cobalt_core::paths::MEMORY_IGNORE_FILE)
                .then(|| path.parent())
                .flatten()
        })
        .collect();
    for doc in docs {
        let watched = Path::new(&doc.file_path);
        let inherited = watched
            .ancestors()
            .skip(1)
            .any(|parent| directories.contains_key(parent));
        if full
            || global_changed
            || ignore_roots.iter().any(|parent| {
                watched.starts_with(parent) || (doc.is_dir && parent.starts_with(watched))
            })
            || watched.ancestors().any(|path| paths.contains(path))
        {
            jobs.insert(
                watched.to_owned(),
                WatchTarget {
                    project_id: doc.project_id,
                    folder_limited: inherited,
                    was_directory: Some(doc.is_dir),
                },
            );
        }
    }
    for path in paths {
        if !super::documents::eligible(&path, None) {
            continue;
        }
        if let Some(project) = path
            .ancestors()
            .skip(1)
            .find_map(|parent| directories.get(parent))
        {
            jobs.entry(path).or_insert(WatchTarget {
                project_id: *project,
                folder_limited: true,
                was_directory: None,
            });
        }
    }
    let mut retry = BTreeSet::new();
    for (path, target) in jobs {
        if cancellation.check().is_err() {
            break;
        }
        let report = reconcile_path(context, &path, target, cancellation, callbacks).await;
        if let Err(error) = report
            && !matches!(error, CobaltError::Cancelled)
        {
            context.watch_issue(issue(&path, error));
            retry.insert(path);
        }
    }
    retry
}

async fn reconcile_path(
    context: &Context,
    path: &Path,
    target: WatchTarget,
    cancellation: &Cancellation,
    callbacks: &Callbacks,
) -> Result<()> {
    match path.symlink_metadata() {
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            return retire(context, path, "file deleted", cancellation, callbacks).await;
        }
        Err(error) => return Err(error.into()),
        Ok(metadata) if target.was_directory == Some(true) && !metadata.is_dir() => return Ok(()),
        Ok(metadata) if target.was_directory == Some(false) && metadata.is_dir() => {
            retire(context, path, "file excluded", cancellation, callbacks).await?;
            if !target.folder_limited {
                return Ok(());
            }
        }
        Ok(_) => {}
    }
    let req = IngestRequest {
        paths: vec![path.to_string_lossy().into_owned()],
        project_id: target.project_id,
        watch: true,
        mark_reusable: false,
        ocr: true,
    };
    let report = context
        .ingest_watched(req, target.folder_limited, cancellation, callbacks)
        .await?;
    let excluded = report.skipped_ignored == 1
        && report.errors.is_empty()
        && report.documents_created + report.documents_updated + report.documents_unchanged == 0;
    for issue in report.errors {
        context.watch_issue(issue);
    }
    if excluded {
        retire(context, path, "file excluded", cancellation, callbacks).await?;
    }
    Ok(())
}

async fn retire(
    context: &Context,
    path: &Path,
    reason: &'static str,
    cancellation: &Cancellation,
    callbacks: &Callbacks,
) -> Result<()> {
    let _write = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(CobaltError::Cancelled),
        guard = context.writes.lock() => guard,
    };
    if reason == "file deleted" && path.exists() {
        // An editor may have recreated this path while the write lock was queued.
        return Err(CobaltError::Conflict(
            "watched path reappeared during indexing".into(),
        ));
    }
    context.archive_watched_path(path, reason, callbacks).await
}

impl Context {
    pub(crate) fn watcher_store(&self) -> Result<&cobalt_store::SqliteStore> {
        self.sqlite.as_deref().ok_or_else(|| {
            CobaltError::Unsupported(
                "atomic file watching requires IngestService::with_sqlite_store".into(),
            )
        })
    }

    pub(crate) async fn archive_watched_path(
        &self,
        path: &Path,
        reason: &'static str,
        callbacks: &Callbacks,
    ) -> Result<()> {
        let archived = self
            .watcher_store()?
            .archive_watched_file(super::documents::path_string(path)?, reason)
            .await?;
        callbacks.changed(MemoryChangeKind::Archived, archived);
        Ok(())
    }
}
