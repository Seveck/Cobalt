use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use cobalt_core::error::{CobaltError, Result};
use cobalt_core::ids::{Id, new_id};
use cobalt_core::scrubber::scrub;
use cobalt_core::traits::ProgressSink;
use cobalt_core::transfer::*;
use tokio::sync::watch;
use tokio::time::{Instant, sleep_until};

const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Clone, Default)]
pub(crate) struct Cancellation {
    signal: watch::Sender<bool>,
    parent: Option<watch::Sender<bool>>,
}

impl Cancellation {
    pub(crate) fn cancel(&self) {
        self.signal.send_replace(true);
    }

    pub(crate) fn check(&self) -> Result<()> {
        if *self.signal.borrow() || self.parent.as_ref().is_some_and(|parent| *parent.borrow()) {
            Err(CobaltError::Cancelled)
        } else {
            Ok(())
        }
    }

    pub(crate) async fn cancelled(&self) {
        async fn wait(signal: &watch::Sender<bool>) {
            let _ = signal.subscribe().wait_for(|cancelled| *cancelled).await;
        }
        if let Some(parent) = &self.parent {
            tokio::select! {
                () = wait(parent) => {},
                () = wait(&self.signal) => {},
            }
        } else {
            wait(&self.signal).await;
        }
    }
}

#[derive(Default)]
pub(crate) struct Jobs(Mutex<HashMap<Id, Cancellation>>);

impl Jobs {
    pub(crate) async fn run<T>(
        &self,
        path: Option<&str>,
        project_id: Option<Id>,
        parent: Option<&Cancellation>,
        sink: Option<ProgressSink<IngestProgress>>,
        failed: impl FnOnce(&T) -> bool,
        work: impl AsyncFnOnce(Cancellation, Progress) -> Result<T>,
    ) -> Result<T> {
        let id = new_id();
        let cancellation = Cancellation {
            parent: parent.map(|parent| parent.signal.clone()),
            ..Default::default()
        };
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id, cancellation.clone());
        let (sender, receiver) = watch::channel(IngestProgress {
            job_id: id,
            processed: 0,
            total: 0,
            current_path: path.map(|path| scrub(path).text),
            stage: INGEST_STAGE_SCANNING.into(),
            project_id,
            background: parent.is_some(),
            eta_seconds: None,
            file_chunks_done: None,
            file_chunks_total: None,
        });
        let mut job = Job {
            jobs: self,
            id,
            cancellation,
            receiver,
            sink,
        };
        let updates = Progress {
            sender: job.sink.as_ref().map(|_| sender),
            rate: Default::default(),
            track_files: true,
        };
        let ((), (result, stage)) = tokio::join!(
            emit_progress(job.receiver.clone(), job.sink.clone()),
            async {
                let result = work(job.cancellation.clone(), updates).await;
                job.unregister();
                let stage = match &result {
                    Err(CobaltError::Cancelled) => INGEST_STAGE_CANCELLED,
                    Err(_) => INGEST_STAGE_FAILED,
                    Ok(_) if job.cancellation.check().is_err() => INGEST_STAGE_CANCELLED,
                    Ok(value) if failed(value) => INGEST_STAGE_FAILED,
                    Ok(_) => INGEST_STAGE_COMPLETED,
                };
                (result, stage)
            }
        );
        job.emit_terminal(stage);
        result
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

struct Job<'a> {
    jobs: &'a Jobs,
    id: Id,
    cancellation: Cancellation,
    receiver: watch::Receiver<IngestProgress>,
    sink: Option<ProgressSink<IngestProgress>>,
}

impl Job<'_> {
    fn unregister(&self) {
        self.jobs
            .0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.id);
    }

    fn emit_terminal(&mut self, stage: &str) {
        if let Some(sink) = self.sink.take() {
            let mut event = self.receiver.borrow().clone();
            stage.clone_into(&mut event.stage);
            event.eta_seconds = None;
            event.file_chunks_done = None;
            event.file_chunks_total = None;
            sink(event);
        }
    }
}

impl Drop for Job<'_> {
    fn drop(&mut self) {
        self.unregister();
        self.cancellation.cancel();
        if self.sink.is_some() {
            let stage = if std::thread::panicking() {
                INGEST_STAGE_FAILED
            } else {
                INGEST_STAGE_CANCELLED
            };
            // An observer panic must not cause a second panic during unwinding.
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                self.emit_terminal(stage);
            }));
        }
    }
}

#[derive(Default)]
struct ChunkRate {
    samples: VecDeque<(Instant, usize)>,
    started: Option<Instant>,
    chunks: usize,
    remaining: usize,
    files: usize,
}

#[derive(Clone, Default)]
pub(crate) struct Progress {
    sender: Option<watch::Sender<IngestProgress>>,
    rate: std::sync::Arc<Mutex<ChunkRate>>,
    track_files: bool,
}

impl Progress {
    // A watcher batch owns the counters even when reconciling a directory internally.
    pub(crate) fn within_path(&self) -> Self {
        Self {
            track_files: false,
            ..self.clone()
        }
    }

    pub(crate) fn document(&self, path: &Path, processed: u64, total: u64, stage: &str) {
        if let Some(sender) = &self.sender {
            let path = scrub(&path.to_string_lossy()).text;
            sender.send_modify(|progress| {
                progress.current_path = Some(path);
                progress.file_chunks_done = None;
                progress.file_chunks_total = None;
                if self.track_files {
                    progress.processed = processed;
                    progress.total = total;
                }
                stage.clone_into(&mut progress.stage);
            });
        }
    }

    pub(crate) fn stage(&self, stage: &str) {
        if let Some(sender) = &self.sender {
            sender.send_modify(|progress| stage.clone_into(&mut progress.stage));
        }
    }

    pub(crate) fn finish(&self, processed: u64, total: u64) {
        if self.track_files
            && let Some(sender) = &self.sender
        {
            sender.send_modify(|progress| {
                progress.processed = processed;
                progress.total = total;
            });
        }
    }

    pub(crate) fn start_chunks(&self, count: usize) {
        if let Some(sender) = &self.sender {
            let mut rate = self.rate.lock().unwrap_or_else(PoisonError::into_inner);
            rate.files += 1;
            rate.chunks += count;
            rate.remaining = count;
            rate.started.get_or_insert_with(Instant::now);
            sender.send_modify(|event| {
                event.file_chunks_done = Some(0);
                event.file_chunks_total = Some(count as u64);
            });
        }
    }

    pub(crate) fn embedded(&self, count: usize) {
        if count != 0
            && let Some(sender) = &self.sender
        {
            let mut rate = self.rate.lock().unwrap_or_else(PoisonError::into_inner);
            let now = Instant::now();
            let Some(started) = rate.started.replace(now) else {
                return;
            };
            rate.remaining = rate.remaining.saturating_sub(count);
            rate.samples.push_back((started, count));
            if rate.samples.len() > 8 {
                rate.samples.pop_front();
            }
            let recent: usize = rate.samples.iter().map(|(_, count)| count).sum();
            sender.send_modify(|event| {
                if let Some(done) = &mut event.file_chunks_done {
                    *done += count as u64;
                }
                if recent >= 5 {
                    let elapsed = now.duration_since(rate.samples[0].0).as_secs_f64();
                    let remaining_files = event.total.saturating_sub(event.processed + 1);
                    let chunks_per_file = rate.chunks as f64 / rate.files as f64;
                    let remaining =
                        rate.remaining as f64 + remaining_files as f64 * chunks_per_file;
                    event.eta_seconds = Some((elapsed * remaining / recent as f64).ceil() as u64);
                }
            });
        }
    }
}

async fn emit_progress(
    mut updates: watch::Receiver<IngestProgress>,
    progress: Option<ProgressSink<IngestProgress>>,
) {
    let Some(progress) = progress else { return };
    loop {
        let latest = updates.borrow_and_update().clone();
        let embedding = latest.stage == INGEST_STAGE_EMBEDDING
            && matches!(
                (latest.file_chunks_done, latest.file_chunks_total),
                (Some(done), Some(total)) if done < total
            );
        progress(latest);
        let next_event = Instant::now() + PROGRESS_INTERVAL;
        // Publish periodically even while an embedding batch is still in flight.
        tokio::select! {
            biased;
            result = updates.changed() => {
                if result.is_err() {
                    break;
                }
                sleep_until(next_event).await;
            }
            () = sleep_until(next_event), if embedding => {}
        }
    }
}
