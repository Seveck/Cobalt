use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use cobalt_core::error::{CobaltError, Result};
use cobalt_core::ids::{Id, new_id};
use cobalt_core::scrubber::scrub;
use cobalt_core::traits::ProgressSink;
use cobalt_core::transfer::IngestProgress;
use tokio::sync::watch;
use tokio::time::{Instant, sleep_until};

const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Clone, Default)]
pub(crate) struct Cancellation(watch::Sender<bool>);

impl Cancellation {
    pub(crate) fn cancel(&self) {
        self.0.send_replace(true);
    }

    pub(crate) fn check(&self) -> Result<()> {
        if *self.0.borrow() {
            Err(CobaltError::Cancelled)
        } else {
            Ok(())
        }
    }

    pub(crate) async fn cancelled(&self) {
        let _ = self.0.subscribe().wait_for(|cancelled| *cancelled).await;
    }
}

#[derive(Default)]
pub(crate) struct Jobs(Mutex<HashMap<Id, Cancellation>>);

impl Jobs {
    pub(crate) fn start(&self) -> Job<'_> {
        let id = new_id();
        let cancellation = Cancellation::default();
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id, cancellation.clone());
        Job {
            jobs: self,
            id,
            cancellation,
        }
    }

    pub(crate) fn cancel(&self, id: Id) -> bool {
        let jobs = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(job) = jobs.get(&id) {
            job.cancel();
            true
        } else {
            false
        }
    }
}

pub(crate) struct Job<'a> {
    jobs: &'a Jobs,
    pub(crate) id: Id,
    pub(crate) cancellation: Cancellation,
}

impl Drop for Job<'_> {
    fn drop(&mut self) {
        self.jobs
            .0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.id);
        self.cancellation.cancel();
    }
}

#[derive(Clone, Default)]
pub(crate) struct Progress(Option<watch::Sender<IngestProgress>>);

impl Progress {
    pub(crate) fn channel(id: Id, path: Option<&str>) -> (Self, watch::Receiver<IngestProgress>) {
        let (sender, receiver) = watch::channel(IngestProgress {
            job_id: id,
            processed: 0,
            total: 0,
            current_path: path.map(|path| scrub(path).text),
            stage: "scanning".into(),
        });
        (Self(Some(sender)), receiver)
    }

    pub(crate) fn document(&self, path: &Path, processed: u64, total: u64, stage: &str) {
        if let Some(sender) = &self.0 {
            let path = scrub(&path.to_string_lossy()).text;
            sender.send_modify(|progress| {
                progress.current_path = Some(path);
                progress.processed = processed;
                progress.total = total;
                stage.clone_into(&mut progress.stage);
            });
        }
    }

    pub(crate) fn stage(&self, stage: &str) {
        if let Some(sender) = &self.0 {
            sender.send_modify(|progress| stage.clone_into(&mut progress.stage));
        }
    }

    pub(crate) fn finish(&self, processed: u64, total: u64) {
        if let Some(sender) = &self.0 {
            sender.send_modify(|progress| {
                progress.processed = processed;
                progress.total = total;
            });
        }
    }
}

pub(crate) async fn emit_progress(
    mut updates: watch::Receiver<IngestProgress>,
    progress: ProgressSink<IngestProgress>,
) {
    let initial = updates.borrow_and_update().clone();
    progress(initial);
    let mut last_event = Instant::now();
    while updates.changed().await.is_ok() {
        sleep_until(last_event + PROGRESS_INTERVAL).await;
        // Coalesce faster updates without blocking the ingest loop.
        let latest = updates.borrow_and_update().clone();
        last_event = Instant::now();
        progress(latest);
    }
}
