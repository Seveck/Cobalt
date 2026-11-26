use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use cobalt_core::enums::MemoryChangeKind;
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::ids::Id;
use cobalt_core::model::{MemoryChanged, SourceDocument};
use cobalt_core::paths::MEMORY_IGNORE_FILE;
use cobalt_core::traits::ProgressSink;
use cobalt_core::transfer::{INGEST_STAGE_READING, IngestIssue, IngestProgress, IngestRequest};
use notify::event::{CreateKind, RemoveKind};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::Context;
use crate::documents::{INGEST_CLIENT, IgnoreMatchers, document_priority, issue};
use crate::jobs::{Cancellation, Progress};

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

#[derive(Default)]
struct EventFilter {
    watched: HashMap<PathBuf, (Option<Id>, bool)>,
    project_roots: HashMap<Id, PathBuf>,
    ignores: IgnoreMatchers,
}

impl EventFilter {
    async fn load(context: &Context, docs: &[SourceDocument]) -> Self {
        let mut filter = Self::default();
        let projects: HashSet<_> = docs.iter().filter_map(|doc| doc.project_id).collect();
        for id in projects {
            match context.store.get_project(id).await {
                Ok(Some(project)) => {
                    if let Some(root) = project.root_path {
                        filter.project_roots.insert(id, root.into());
                    }
                }
                Ok(None) => {}
                Err(error) => context.watch_issue(issue(Path::new("watcher"), error)),
            }
        }
        filter.watched = docs
            .iter()
            .map(|doc| (PathBuf::from(&doc.file_path), (doc.project_id, doc.is_dir)))
            .collect();
        filter
    }

    fn filter_paths(&mut self, event: &mut Event, global: Option<&Path>) {
        if event
            .paths
            .iter()
            .any(|path| path.file_name() == Some(MEMORY_IGNORE_FILE.as_ref()))
        {
            self.ignores = IgnoreMatchers::default();
        }
        event.paths.retain(|path| {
            let ignore_file = path.file_name() == Some(MEMORY_IGNORE_FILE.as_ref());
            if ignore_file && path.parent() == global {
                return true;
            }
            let root = path
                .ancestors()
                .find_map(|ancestor| self.watched.get(ancestor))
                .and_then(|(project, _)| project.as_ref())
                .and_then(|project| self.project_roots.get(project))
                .map(PathBuf::as_path);
            let (path, is_dir) = if ignore_file && let Some(parent) = path.parent() {
                (parent, true)
            } else {
                let is_dir = match event.kind {
                    EventKind::Create(CreateKind::Folder)
                    | EventKind::Remove(RemoveKind::Folder) => true,
                    EventKind::Create(CreateKind::File) | EventKind::Remove(RemoveKind::File) => {
                        false
                    }
                    _ => path.symlink_metadata().map_or_else(
                        // An untyped rename can refer to a directory that has already moved.
                        |_| self.watched.get(path).is_none_or(|(_, is_dir)| *is_dir),
                        |metadata| metadata.is_dir(),
                    ),
                };
                (path.as_path(), is_dir)
            };
            // Let reconciliation report invalid rules instead of losing file changes.
            !self
                .ignores
                .ignored(path, is_dir, root, global)
                .unwrap_or(false)
        });
    }
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
    let filter = Arc::new(Mutex::new(EventFilter::load(&context, &docs).await));
    let event_filter = filter.clone();
    let global = context.global_ignore.clone();
    let (event_tx, mut events) = mpsc::channel::<notify::Result<Event>>(1024);
    let overflow = Arc::new(AtomicBool::new(false));
    let overrun = overflow.clone();
    let mut watcher = notify::recommended_watcher(move |mut event: notify::Result<Event>| {
        if let Ok(event) = &mut event {
            // Reads during reconciliation can generate more events than the queue can hold.
            if event.kind.is_access() {
                return;
            }
            event_filter
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .filter_paths(event, global.as_deref());
            if event.paths.is_empty() && !event.need_rescan() {
                return;
            }
        }
        if let Err(mpsc::error::TrySendError::Full(_)) = event_tx.try_send(event) {
            overrun.store(true, Ordering::Relaxed);
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
                        Some(Ok(event)) => {
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
                        None => break,
                    }
                }
                _ = tick.tick() => {
                    let refresh_due = last_refresh.elapsed() >= REFRESH;
                    rescan |= overflow.swap(false, Ordering::Relaxed);
                    let batch_ready = batch_started.is_some() && (last_event.elapsed() >= DEBOUNCE
                        || batch_started.is_some_and(|start| start.elapsed() >= MAX_DEBOUNCE));
                    if refresh_due || batch_ready || rescan {
                        match list_watched(&context, &task_cancellation).await {
                            Ok(updated) => {
                                let previous: HashSet<_> = docs.iter()
                                    .map(|doc| (doc.id, doc.file_path.as_str())).collect();
                                let watched_roots: HashMap<_, _> = updated.iter()
                                    .filter(|doc| doc.is_dir)
                                    .map(|doc| (Path::new(&doc.file_path), doc.project_id))
                                    .collect();
                                for doc in &updated {
                                    let path = Path::new(&doc.file_path);
                                    let covered = path.ancestors().skip(1)
                                        .find_map(|parent| watched_roots.get(parent))
                                        .is_some_and(|project| *project == doc.project_id);
                                    if !covered && !previous.contains(&(doc.id, doc.file_path.as_str())) {
                                        pending.insert(path.to_owned());
                                    }
                                }
                                if refresh_due || updated != docs {
                                    let updated_filter = EventFilter::load(&context, &updated).await;
                                    *filter.lock().unwrap_or_else(PoisonError::into_inner) = updated_filter;
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
        .is_some_and(|global| paths.contains(&global.join(MEMORY_IGNORE_FILE)));
    let ignore_roots: Vec<_> = paths
        .iter()
        .filter_map(|path| {
            (path.file_name()? == MEMORY_IGNORE_FILE)
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
    if jobs.is_empty() || cancellation.check().is_err() {
        return retry;
    }
    let first = jobs
        .first_key_value()
        .map(|(path, target)| (path.clone(), target.project_id));
    let project_id = first
        .as_ref()
        .and_then(|(_, project)| *project)
        .filter(|project| {
            jobs.values()
                .all(|target| target.project_id == Some(*project))
        });
    let first_path = first.as_ref().and_then(|(path, _)| path.to_str());
    let mut jobs: Vec<_> = jobs.into_iter().collect();
    // Walk directories before their files. Missing or excluded files still need their own
    // reconciliation because a directory walk does not report them as processed.
    jobs.sort_by_cached_key(|(path, target)| {
        if target.was_directory == Some(true) || path.is_dir() {
            0
        } else {
            1 + document_priority(path)
        }
    });
    let total = jobs.len() as u64;
    let _ = context
        .jobs
        .run(
            first_path,
            project_id,
            Some(cancellation),
            callbacks.progress.clone(),
            |_| false,
            async |cancellation, progress| {
                let mut failed = false;
                let mut reconciled_files = HashMap::new();
                for (index, (path, target)) in jobs.into_iter().enumerate() {
                    cancellation.check()?;
                    if reconciled_files.get(&path) == Some(&target.project_id) {
                        progress.finish(index as u64 + 1, total);
                        continue;
                    }
                    progress.document(&path, index as u64, total, INGEST_STAGE_READING);
                    let result = reconcile_path(
                        context,
                        &path,
                        target,
                        &cancellation,
                        callbacks,
                        &progress,
                        &mut reconciled_files,
                    )
                    .await;
                    match result {
                        Err(CobaltError::Cancelled) => return Err(CobaltError::Cancelled),
                        Err(error) => {
                            context.watch_issue(issue(&path, error));
                            retry.insert(path);
                            failed = true;
                        }
                        Ok(()) => {}
                    }
                    progress.finish(index as u64 + 1, total);
                }
                if failed {
                    Err(CobaltError::Storage("watcher reconciliation failed".into()))
                } else {
                    Ok(())
                }
            },
        )
        .await;
    retry
}

async fn reconcile_path(
    context: &Context,
    path: &Path,
    target: WatchTarget,
    cancellation: &Cancellation,
    callbacks: &Callbacks,
    progress: &Progress,
    reconciled_files: &mut HashMap<PathBuf, Option<Id>>,
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
        .ingest_watched(
            req,
            target.folder_limited,
            cancellation,
            callbacks,
            progress,
            reconciled_files,
        )
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
