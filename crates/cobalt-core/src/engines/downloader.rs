//! Verified, resumable downloads with progress, retries and cancellation.
//!
//! - Streams into `<dest>.part`, hashing with SHA-256 as bytes arrive.
//! - Resumes an existing `.part` with an HTTP `Range` request (re-hashing the prefix).
//! - Verifies exact size + digest before an atomic rename; writes `<dest>.sha256` marker.
//! - Retries transient failures with exponential backoff; integrity failures restart clean.
//! - Only `https://` URLs are accepted (plain `http://` only for loopback, used by tests).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use reqwest::StatusCode;
use reqwest::header::RANGE;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::catalog::is_safe_relative_path;
use crate::engine::{DownloadArtifact, DownloadProgress};
use crate::enums::DownloadPhase;
use crate::error::{CobaltError, Result};
use crate::traits::ProgressSink;

/// Shared cancellation flag.
pub type CancelFlag = Arc<AtomicBool>;

const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);
const MARKER_EXT: &str = "sha256";

#[derive(Clone)]
pub struct Downloader {
    client: reqwest::Client,
    home: PathBuf,
    max_attempts: u32,
    base_backoff: Duration,
}

enum AttemptError {
    /// Network / server hiccup: retry, keeping the partial file.
    Transient(CobaltError),
    /// Digest or size mismatch: retry from scratch.
    Corrupt(CobaltError),
    /// Cancellation or a non-retryable error.
    Fatal(CobaltError),
}

impl Downloader {
    pub fn new(home: PathBuf) -> Result<Self> {
        let client = reqwest::Client::builder()
            .user_agent(concat!("Cobalt/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(20))
            .read_timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| CobaltError::Download(format!("http client: {e}")))?;
        Ok(Self {
            client,
            home,
            max_attempts: 4,
            base_backoff: Duration::from_secs(2),
        })
    }

    /// Faster retries for tests.
    pub fn with_retry_policy(mut self, max_attempts: u32, base_backoff: Duration) -> Self {
        self.max_attempts = max_attempts.max(1);
        self.base_backoff = base_backoff;
        self
    }

    pub fn home(&self) -> &Path {
        &self.home
    }

    /// Absolute destination of an artifact inside the Cobalt home.
    pub fn dest_path(&self, artifact: &DownloadArtifact) -> Result<PathBuf> {
        if !is_safe_relative_path(&artifact.relative_dest) {
            return Err(CobaltError::Sandbox(format!(
                "unsafe destination {}",
                artifact.relative_dest
            )));
        }
        Ok(self.home.join(&artifact.relative_dest))
    }

    /// `true` when the artifact was already downloaded and verified (marker + size match).
    /// For archives, verification is recorded by the marker alone (the archive is deleted
    /// after extraction).
    pub fn is_verified(&self, artifact: &DownloadArtifact) -> bool {
        let Ok(dest) = self.dest_path(artifact) else {
            return false;
        };
        let marker_ok = std::fs::read_to_string(marker_path(&dest))
            .map(|m| m.trim() == artifact.sha256)
            .unwrap_or(false);
        if !marker_ok {
            return false;
        }
        artifact.archive.is_some()
            || std::fs::metadata(&dest)
                .map(|m| m.len() == artifact.size_bytes)
                .unwrap_or(false)
    }

    /// Downloads and verifies `artifact`, returning its final path.
    pub async fn fetch(
        &self,
        artifact: &DownloadArtifact,
        progress: &ProgressSink<DownloadProgress>,
        cancel: &CancelFlag,
    ) -> Result<PathBuf> {
        validate_url(&artifact.url)?;
        let dest = self.dest_path(artifact)?;
        if self.is_verified(artifact) && dest.exists() {
            emit(
                progress,
                artifact,
                DownloadPhase::Completed,
                artifact.size_bytes,
                1,
                None,
            );
            return Ok(dest);
        }
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let part = part_path(&dest);
        emit(progress, artifact, DownloadPhase::Queued, 0, 1, None);

        let mut last_err = CobaltError::Download("download did not start".into());
        for attempt in 1..=self.max_attempts {
            match self
                .attempt(artifact, &part, progress, cancel, attempt)
                .await
            {
                Ok(()) => {
                    tokio::fs::rename(&part, &dest).await?;
                    tokio::fs::write(marker_path(&dest), &artifact.sha256).await?;
                    emit(
                        progress,
                        artifact,
                        DownloadPhase::Completed,
                        artifact.size_bytes,
                        attempt,
                        None,
                    );
                    return Ok(dest);
                }
                Err(AttemptError::Fatal(e)) => {
                    let phase = if matches!(e, CobaltError::Cancelled) {
                        DownloadPhase::Cancelled
                    } else {
                        DownloadPhase::Failed
                    };
                    emit(progress, artifact, phase, 0, attempt, Some(e.to_string()));
                    return Err(e);
                }
                Err(AttemptError::Corrupt(e)) => {
                    let _ = tokio::fs::remove_file(&part).await;
                    last_err = e;
                }
                Err(AttemptError::Transient(e)) => last_err = e,
            }
            if attempt < self.max_attempts {
                emit(
                    progress,
                    artifact,
                    DownloadPhase::Retrying,
                    0,
                    attempt,
                    Some(last_err.to_string()),
                );
                let backoff = self
                    .base_backoff
                    .saturating_mul(2u32.saturating_pow(attempt - 1));
                tokio::time::sleep(backoff.min(Duration::from_secs(30))).await;
            }
        }
        emit(
            progress,
            artifact,
            DownloadPhase::Failed,
            0,
            self.max_attempts,
            Some(last_err.to_string()),
        );
        Err(last_err)
    }

    async fn attempt(
        &self,
        artifact: &DownloadArtifact,
        part: &Path,
        progress: &ProgressSink<DownloadProgress>,
        cancel: &CancelFlag,
        attempt: u32,
    ) -> std::result::Result<(), AttemptError> {
        let fatal = |e: CobaltError| AttemptError::Fatal(e);
        let mut hasher = Sha256::new();
        let mut have = hash_existing(part, &mut hasher).await.map_err(fatal)?;
        if have > artifact.size_bytes {
            let _ = tokio::fs::remove_file(part).await;
            hasher = Sha256::new();
            have = 0;
        }

        let mut request = self.client.get(&artifact.url);
        if have > 0 {
            request = request.header(RANGE, format!("bytes={have}-"));
        }
        let response = request
            .send()
            .await
            .map_err(|e| AttemptError::Transient(CobaltError::Download(e.to_string())))?;
        let status = response.status();
        let append = match status {
            StatusCode::PARTIAL_CONTENT if have > 0 => true,
            StatusCode::OK => {
                hasher = Sha256::new();
                have = 0;
                false
            }
            StatusCode::RANGE_NOT_SATISFIABLE => {
                return Err(AttemptError::Corrupt(CobaltError::Download(
                    "stale partial file".into(),
                )));
            }
            s if s.is_server_error() || s == StatusCode::TOO_MANY_REQUESTS => {
                return Err(AttemptError::Transient(CobaltError::Download(format!(
                    "HTTP {s}"
                ))));
            }
            s => {
                return Err(fatal(CobaltError::Download(format!(
                    "HTTP {s} for {}",
                    artifact.url
                ))));
            }
        };

        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(append)
            .truncate(!append)
            .open(part)
            .await
            .map_err(|e| fatal(e.into()))?;
        let mut downloaded = have;
        let mut last_emit = Instant::now() - PROGRESS_INTERVAL;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            if cancel.load(Ordering::Relaxed) {
                let _ = file.flush().await;
                return Err(fatal(CobaltError::Cancelled));
            }
            let chunk =
                chunk.map_err(|e| AttemptError::Transient(CobaltError::Download(e.to_string())))?;
            file.write_all(&chunk).await.map_err(|e| fatal(e.into()))?;
            hasher.update(&chunk);
            downloaded += chunk.len() as u64;
            if downloaded > artifact.size_bytes {
                return Err(AttemptError::Corrupt(CobaltError::Integrity(format!(
                    "{} is larger than expected",
                    artifact.id
                ))));
            }
            if last_emit.elapsed() >= PROGRESS_INTERVAL {
                emit(
                    progress,
                    artifact,
                    DownloadPhase::Downloading,
                    downloaded,
                    attempt,
                    None,
                );
                last_emit = Instant::now();
            }
        }
        file.flush().await.map_err(|e| fatal(e.into()))?;
        file.sync_all().await.map_err(|e| fatal(e.into()))?;
        drop(file);

        if downloaded < artifact.size_bytes {
            return Err(AttemptError::Transient(CobaltError::Download(format!(
                "connection closed at {downloaded}/{} bytes",
                artifact.size_bytes
            ))));
        }
        emit(
            progress,
            artifact,
            DownloadPhase::Verifying,
            downloaded,
            attempt,
            None,
        );
        let digest = hex::encode(hasher.finalize());
        if !digest.eq_ignore_ascii_case(&artifact.sha256) {
            return Err(AttemptError::Corrupt(CobaltError::Integrity(format!(
                "SHA-256 mismatch for {} (expected {}, got {digest})",
                artifact.id, artifact.sha256
            ))));
        }
        Ok(())
    }
}

fn validate_url(url: &str) -> Result<()> {
    let loopback = url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:");
    if url.starts_with("https://") || loopback {
        Ok(())
    } else {
        Err(CobaltError::Sandbox(format!(
            "refusing non-HTTPS download URL {url}"
        )))
    }
}

async fn hash_existing(part: &Path, hasher: &mut Sha256) -> Result<u64> {
    let mut file = match tokio::fs::File::open(part).await {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e.into()),
    };
    let mut buf = vec![0u8; 1 << 20];
    let mut total = 0u64;
    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    Ok(total)
}

fn part_path(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_owned();
    s.push(".part");
    PathBuf::from(s)
}

pub(crate) fn marker_path(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_owned();
    s.push(".");
    s.push(MARKER_EXT);
    PathBuf::from(s)
}

fn emit(
    progress: &ProgressSink<DownloadProgress>,
    artifact: &DownloadArtifact,
    phase: DownloadPhase,
    downloaded: u64,
    attempt: u32,
    message: Option<String>,
) {
    progress(DownloadProgress {
        artifact_id: artifact.id.clone(),
        phase,
        downloaded_bytes: downloaded,
        total_bytes: Some(artifact.size_bytes),
        attempt,
        message,
    });
}

/// Extracts a verified archive into `dir` (blocking). Entries escaping `dir` are rejected.
pub fn extract_archive(archive: &Path, kind: &str, dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    match kind {
        "tar.gz" => {
            let file = std::fs::File::open(archive)?;
            let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
            for entry in tar.entries()? {
                let mut entry = entry?;
                if !entry.unpack_in(dir)? {
                    return Err(CobaltError::Sandbox(
                        "archive entry escapes target dir".into(),
                    ));
                }
            }
            Ok(())
        }
        "zip" => {
            let file = std::fs::File::open(archive)?;
            let mut zip = zip::ZipArchive::new(file)
                .map_err(|e| CobaltError::Integrity(format!("zip: {e}")))?;
            for i in 0..zip.len() {
                let mut entry = zip
                    .by_index(i)
                    .map_err(|e| CobaltError::Integrity(format!("zip: {e}")))?;
                let Some(rel) = entry.enclosed_name() else {
                    return Err(CobaltError::Sandbox(
                        "archive entry escapes target dir".into(),
                    ));
                };
                let out = dir.join(rel);
                if entry.is_dir() {
                    std::fs::create_dir_all(&out)?;
                    continue;
                }
                if let Some(parent) = out.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                let mut target = std::fs::File::create(&out)?;
                std::io::copy(&mut entry, &mut target)?;
            }
            Ok(())
        }
        other => Err(CobaltError::Unsupported(format!("archive format {other}"))),
    }
}

#[cfg(test)]
pub(crate) mod test_server {
    //! Minimal HTTP/1.1 file server with `Range` support for download tests.
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    pub struct TestServer {
        pub base: String,
        pub requests: Arc<AtomicUsize>,
    }

    /// Serves `body` at any path. When `cut_first_at` is set, the first response is truncated
    /// after that many bytes (simulating a dropped connection).
    pub async fn serve(body: Vec<u8>, cut_first_at: Option<usize>) -> TestServer {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let counter = requests.clone();
        let body = Arc::new(body);
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let body = body.clone();
                let n = counter.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    let mut req = Vec::new();
                    let mut buf = [0u8; 1024];
                    while !req.windows(4).any(|w| w == b"\r\n\r\n") {
                        match sock.read(&mut buf).await {
                            Ok(0) | Err(_) => return,
                            Ok(k) => req.extend_from_slice(&buf[..k]),
                        }
                    }
                    let text = String::from_utf8_lossy(&req).to_lowercase();
                    let start = text
                        .lines()
                        .find_map(|l| l.strip_prefix("range: bytes="))
                        .and_then(|r| {
                            r.trim_end_matches('-')
                                .trim()
                                .trim_end_matches('-')
                                .parse::<usize>()
                                .ok()
                        });
                    let (status, slice) = match start {
                        Some(s) if s < body.len() => ("206 Partial Content", &body[s..]),
                        Some(_) => ("416 Range Not Satisfiable", &body[0..0]),
                        None => ("200 OK", &body[..]),
                    };
                    let head = format!(
                        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        slice.len()
                    );
                    let _ = sock.write_all(head.as_bytes()).await;
                    let send = match cut_first_at {
                        Some(cut) if n == 0 => &slice[..cut.min(slice.len())],
                        _ => slice,
                    };
                    let _ = sock.write_all(send).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        TestServer {
            base: format!("http://127.0.0.1:{}", addr.port()),
            requests,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn artifact(url: String, body: &[u8], dest: &str) -> DownloadArtifact {
        DownloadArtifact {
            id: dest.to_owned(),
            url,
            sha256: hex::encode(Sha256::digest(body)),
            size_bytes: body.len() as u64,
            relative_dest: dest.to_owned(),
            archive: None,
        }
    }

    fn recorder() -> (
        ProgressSink<DownloadProgress>,
        Arc<Mutex<Vec<DownloadPhase>>>,
    ) {
        let phases = Arc::new(Mutex::new(Vec::new()));
        let sink_phases = phases.clone();
        let sink: ProgressSink<DownloadProgress> =
            Arc::new(move |p: DownloadProgress| sink_phases.lock().unwrap().push(p.phase));
        (sink, phases)
    }

    fn body(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i * 31 % 251) as u8).collect()
    }

    #[tokio::test]
    async fn downloads_verifies_and_skips_when_already_verified() {
        let data = body(300_000);
        let server = test_server::serve(data.clone(), None).await;
        let home = tempfile::tempdir().unwrap();
        let dl = Downloader::new(home.path().to_path_buf()).unwrap();
        let a = artifact(
            format!("{}/m.onnx", server.base),
            &data,
            "models/t/model.onnx",
        );
        let (sink, phases) = recorder();
        let cancel = CancelFlag::default();
        let path = dl.fetch(&a, &sink, &cancel).await.unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), data);
        assert!(dl.is_verified(&a));
        assert!(phases.lock().unwrap().contains(&DownloadPhase::Verifying));
        assert_eq!(
            phases.lock().unwrap().last(),
            Some(&DownloadPhase::Completed)
        );
        // Second fetch does not hit the network.
        dl.fetch(&a, &sink, &cancel).await.unwrap();
        assert_eq!(server.requests.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn resumes_after_dropped_connection() {
        let data = body(500_000);
        let server = test_server::serve(data.clone(), Some(123_456)).await;
        let home = tempfile::tempdir().unwrap();
        let dl = Downloader::new(home.path().to_path_buf())
            .unwrap()
            .with_retry_policy(3, Duration::from_millis(10));
        let a = artifact(
            format!("{}/x", server.base),
            &data,
            "models/t/tokenizer.json",
        );
        let (sink, phases) = recorder();
        let path = dl.fetch(&a, &sink, &CancelFlag::default()).await.unwrap();
        assert_eq!(std::fs::read(path).unwrap(), data);
        assert!(phases.lock().unwrap().contains(&DownloadPhase::Retrying));
        assert_eq!(server.requests.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn rejects_digest_mismatch_and_cleans_up() {
        let data = body(10_000);
        let server = test_server::serve(data.clone(), None).await;
        let home = tempfile::tempdir().unwrap();
        let dl = Downloader::new(home.path().to_path_buf())
            .unwrap()
            .with_retry_policy(2, Duration::from_millis(5));
        let mut a = artifact(format!("{}/x", server.base), &data, "models/t/config.json");
        a.sha256 = "0".repeat(64);
        let (sink, _) = recorder();
        let err = dl
            .fetch(&a, &sink, &CancelFlag::default())
            .await
            .unwrap_err();
        assert!(matches!(err, CobaltError::Integrity(_)), "{err}");
        assert!(!home.path().join("models/t/config.json").exists());
        assert!(!home.path().join("models/t/config.json.part").exists());
    }

    #[tokio::test]
    async fn honours_cancellation_and_rejects_insecure_urls() {
        let data = body(2_000_000);
        let server = test_server::serve(data.clone(), None).await;
        let home = tempfile::tempdir().unwrap();
        let dl = Downloader::new(home.path().to_path_buf()).unwrap();
        let a = artifact(format!("{}/x", server.base), &data, "models/t/big.onnx");
        let (sink, phases) = recorder();
        let cancel = CancelFlag::new(AtomicBool::new(true));
        assert!(matches!(
            dl.fetch(&a, &sink, &cancel).await,
            Err(CobaltError::Cancelled)
        ));
        assert_eq!(
            phases.lock().unwrap().last(),
            Some(&DownloadPhase::Cancelled)
        );

        let insecure = artifact("http://example.com/x".into(), &data, "models/t/y");
        assert!(matches!(
            dl.fetch(&insecure, &sink, &CancelFlag::default()).await,
            Err(CobaltError::Sandbox(_))
        ));
        let escape = artifact(format!("{}/x", server.base), &data, "../evil");
        assert!(matches!(
            dl.fetch(&escape, &sink, &CancelFlag::default()).await,
            Err(CobaltError::Sandbox(_))
        ));
    }

    #[test]
    fn extracts_tar_gz_and_zip() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        // tar.gz with one executable
        let tgz = dir.path().join("q.tar.gz");
        {
            let enc = flate2::write::GzEncoder::new(
                std::fs::File::create(&tgz).unwrap(),
                flate2::Compression::fast(),
            );
            let mut builder = tar::Builder::new(enc);
            let payload = b"#!/bin/sh\necho qdrant\n";
            let mut header = tar::Header::new_gnu();
            header.set_size(payload.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder
                .append_data(&mut header, "qdrant", &payload[..])
                .unwrap();
            builder.into_inner().unwrap().finish().unwrap();
        }
        let out = dir.path().join("out");
        extract_archive(&tgz, "tar.gz", &out).unwrap();
        assert!(out.join("qdrant").is_file());

        // zip
        let zpath = dir.path().join("q.zip");
        {
            let mut zw = zip::ZipWriter::new(std::fs::File::create(&zpath).unwrap());
            zw.start_file("qdrant.exe", zip::write::SimpleFileOptions::default())
                .unwrap();
            zw.write_all(b"MZ").unwrap();
            zw.finish().unwrap();
        }
        let zout = dir.path().join("zout");
        extract_archive(&zpath, "zip", &zout).unwrap();
        assert_eq!(std::fs::read(zout.join("qdrant.exe")).unwrap(), b"MZ");
        assert!(extract_archive(&zpath, "rar", &zout).is_err());
    }
}
