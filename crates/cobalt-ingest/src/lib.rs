//! Local document ingestion and portable knowledge transfer.

mod documents;
mod jobs;
mod past_life;
mod transfer;
mod watcher;

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use cobalt_core::error::Result;
use cobalt_core::model::{Memory, MemoryChanged};
use cobalt_core::traits::{CobaltStore, ProgressSink, TokenCounter};
use cobalt_core::transfer::*;
use cobalt_store::SqliteStore;
use tokio::sync::Mutex;

pub use cobalt_core;

/// The daemon's document ingestion and knowledge transfer service.
pub struct IngestService {
    inner: Arc<Context>,
    watcher: Mutex<Option<watcher::WatchTask>>,
    watcher_callbacks: watcher::Callbacks,
}

struct Context {
    store: Arc<dyn CobaltStore>,
    sqlite: Option<Arc<SqliteStore>>,
    tokens: Arc<dyn TokenCounter>,
    global_ignore: Option<PathBuf>,
    writes: Mutex<()>,
    jobs: jobs::Jobs,
    watcher_issues: std::sync::Mutex<VecDeque<IngestIssue>>,
}

impl IngestService {
    pub fn new(store: Arc<dyn CobaltStore>, tokens: Arc<dyn TokenCounter>) -> Self {
        Self::build(store, None, tokens)
    }

    /// Enables identity-preserving imports and independent document chunks on the canonical store.
    pub fn with_sqlite_store(store: Arc<SqliteStore>, tokens: Arc<dyn TokenCounter>) -> Self {
        Self::build(store.clone(), Some(store), tokens)
    }

    /// Installs callbacks for background ingest progress and committed memory changes.
    pub fn with_watcher_callbacks(
        mut self,
        progress: ProgressSink<IngestProgress>,
        memory_changed: ProgressSink<MemoryChanged>,
    ) -> Self {
        self.watcher_callbacks = watcher::Callbacks {
            progress: Some(progress),
            memory_changed: Some(memory_changed),
        };
        self
    }

    /// Drains recent errors reported by the background watcher.
    pub fn take_watcher_issues(&self) -> Vec<IngestIssue> {
        self.inner
            .watcher_issues
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .drain(..)
            .collect()
    }

    fn build(
        store: Arc<dyn CobaltStore>,
        sqlite: Option<Arc<SqliteStore>>,
        tokens: Arc<dyn TokenCounter>,
    ) -> Self {
        Self {
            inner: Arc::new(Context {
                store,
                sqlite,
                tokens,
                global_ignore: cobalt_core::paths::cobalt_home().ok(),
                writes: Mutex::new(()),
                jobs: jobs::Jobs::default(),
                watcher_issues: std::sync::Mutex::default(),
            }),
            watcher: Mutex::default(),
            watcher_callbacks: watcher::Callbacks::default(),
        }
    }
}

impl Context {
    fn watch_issue(&self, issue: IngestIssue) {
        let mut issues = self
            .watcher_issues
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if issues.len() == 128 {
            issues.pop_front();
        }
        issues.push_back(issue);
    }
}

#[async_trait]
impl cobalt_core::traits::IngestService for IngestService {
    async fn ingest_paths(
        &self,
        req: IngestRequest,
        progress: ProgressSink<IngestProgress>,
    ) -> Result<IngestReport> {
        self.inner.ingest(req, None, progress).await
    }

    async fn import_past_life(
        &self,
        req: PastLifeImportRequest,
        progress: ProgressSink<IngestProgress>,
    ) -> Result<IngestReport> {
        self.inner
            .ingest(
                IngestRequest {
                    paths: vec![req.path],
                    project_id: req.project_id,
                    watch: false,
                    mark_reusable: false,
                    ocr: false,
                },
                Some(req.source),
                progress,
            )
            .await
    }

    async fn promote_file_to_reusable(&self, req: PromoteFileRequest) -> Result<Memory> {
        self.inner.promote(req).await
    }

    async fn cancel_job(&self, job_id: cobalt_core::ids::Id) -> Result<bool> {
        Ok(self.inner.jobs.cancel(job_id))
    }

    async fn start_watcher(&self) -> Result<()> {
        let mut watcher = self.watcher.lock().await;
        if watcher.is_none() {
            self.inner.watcher_store()?;
            *watcher =
                Some(watcher::start(self.inner.clone(), self.watcher_callbacks.clone()).await?);
        }
        Ok(())
    }

    async fn stop_watcher(&self) -> Result<()> {
        if let Some(watcher) = self.watcher.lock().await.take() {
            watcher.stop().await;
        }
        Ok(())
    }

    async fn export_capsule(&self, req: CapsuleExportRequest) -> Result<CapsuleManifest> {
        self.inner.export_capsule(req).await
    }

    async fn import_capsule(&self, path: &str) -> Result<ImportReport> {
        self.inner
            .import_package(path.to_owned(), None, false)
            .await
    }

    async fn export_backup(&self, req: BackupExportRequest) -> Result<BackupManifest> {
        self.inner.export_backup(req).await
    }

    async fn import_backup(&self, req: BackupImportRequest) -> Result<ImportReport> {
        self.inner
            .import_package(req.path, req.password, true)
            .await
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| cobalt_core::error::CobaltError::Internal(error.to_string()))?
}

#[cfg(test)]
mod tests;
