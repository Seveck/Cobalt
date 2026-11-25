//! Qdrant sidecar: the official binary (downloaded and verified by the `EngineManager`) run
//! as a child process bound to `127.0.0.1` on free ports, protected by a random API key,
//! with storage under `~/.cobalt/index/qdrant/`. The process is killed when the handle is
//! dropped, so it never outlives Cobalt.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use tokio::process::{Child, Command};

use crate::error::{CobaltError, Result};

pub struct SidecarConfig {
    pub binary: PathBuf,
    pub storage_dir: PathBuf,
    pub log_file: PathBuf,
    pub ready_timeout: Duration,
}

pub struct QdrantSidecar {
    child: Child,
    http_port: u16,
    grpc_port: u16,
    api_key: String,
}

impl QdrantSidecar {
    pub async fn start(cfg: &SidecarConfig) -> Result<Self> {
        if !cfg.binary.is_file() {
            return Err(CobaltError::NotFound(format!(
                "qdrant binary {}",
                cfg.binary.display()
            )));
        }
        tokio::fs::create_dir_all(&cfg.storage_dir).await?;
        if let Some(parent) = cfg.log_file.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let http_port = free_port()?;
        let grpc_port = free_port()?;
        let api_key = hex::encode(rand::random::<[u8; 24]>());
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&cfg.log_file)?;
        let log_err = log.try_clone()?;
        let snapshots = cfg.storage_dir.join("snapshots");

        let mut cmd = Command::new(&cfg.binary);
        cmd.current_dir(&cfg.storage_dir)
            .env("QDRANT__SERVICE__HOST", "127.0.0.1")
            .env("QDRANT__SERVICE__HTTP_PORT", http_port.to_string())
            .env("QDRANT__SERVICE__GRPC_PORT", grpc_port.to_string())
            .env("QDRANT__SERVICE__API_KEY", &api_key)
            .env("QDRANT__STORAGE__STORAGE_PATH", &cfg.storage_dir)
            .env("QDRANT__STORAGE__SNAPSHOTS_PATH", &snapshots)
            .env("QDRANT__TELEMETRY_DISABLED", "true")
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log_err))
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let child = cmd.spawn()?;
        let mut sidecar = Self {
            child,
            http_port,
            grpc_port,
            api_key,
        };
        sidecar.wait_ready(cfg.ready_timeout).await?;
        tracing::info!(port = http_port, "qdrant sidecar ready");
        Ok(sidecar)
    }

    async fn wait_ready(&mut self, timeout: Duration) -> Result<()> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .map_err(|e| CobaltError::Engine(e.to_string()))?;
        let url = format!("{}/readyz", self.http_endpoint());
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self.child.try_wait()? {
                return Err(CobaltError::Engine(format!(
                    "qdrant exited during startup ({status})"
                )));
            }
            if let Ok(resp) = client
                .get(&url)
                .header("api-key", &self.api_key)
                .send()
                .await
                && resp.status().is_success()
            {
                return Ok(());
            }
            if Instant::now() >= deadline {
                let _ = self.child.start_kill();
                return Err(CobaltError::Engine(
                    "qdrant did not become ready in time".into(),
                ));
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    pub fn http_endpoint(&self) -> String {
        format!("http://127.0.0.1:{}", self.http_port)
    }

    pub fn grpc_endpoint(&self) -> String {
        format!("http://127.0.0.1:{}", self.grpc_port)
    }

    /// API key required by the sidecar (send as `api-key` header).
    pub fn api_key(&self) -> &str {
        &self.api_key
    }

    pub fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Stops the process and waits for it (Qdrant's WAL makes a hard stop safe).
    pub async fn stop(mut self) -> Result<()> {
        if self.is_running() {
            self.child.start_kill()?;
        }
        let _ = tokio::time::timeout(Duration::from_secs(10), self.child.wait()).await;
        Ok(())
    }
}

fn free_port() -> Result<u16> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

/// Default storage folder of the sidecar inside the Cobalt home.
pub fn default_storage_dir(home: &Path) -> PathBuf {
    home.join(crate::paths::VECTOR_INDEX_DIR).join("qdrant")
}

#[cfg(all(test, unix))]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn script(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("qdrant");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    fn config(dir: &Path, binary: PathBuf, timeout: Duration) -> SidecarConfig {
        SidecarConfig {
            binary,
            storage_dir: dir.join("storage"),
            log_file: dir.join("logs/qdrant.log"),
            ready_timeout: timeout,
        }
    }

    #[tokio::test]
    async fn starts_waits_for_readyz_and_stops() {
        if std::process::Command::new("python3")
            .arg("--version")
            .output()
            .is_err()
        {
            eprintln!("python3 not available; skipping");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        // Fake qdrant: serves a `readyz` file over HTTP on the port Cobalt assigned.
        let bin = script(
            dir.path(),
            r#"cd "$QDRANT__STORAGE__STORAGE_PATH" && echo ok > readyz && exec python3 -m http.server "$QDRANT__SERVICE__HTTP_PORT" --bind 127.0.0.1"#,
        );
        let mut sidecar = QdrantSidecar::start(&config(dir.path(), bin, Duration::from_secs(15)))
            .await
            .unwrap();
        assert!(sidecar.is_running());
        assert!(sidecar.http_endpoint().starts_with("http://127.0.0.1:"));
        assert_eq!(sidecar.api_key().len(), 48);
        sidecar.stop().await.unwrap();
    }

    #[tokio::test]
    async fn reports_early_exit_and_missing_binary() {
        let dir = tempfile::tempdir().unwrap();
        let bin = script(dir.path(), "exit 3");
        let err = QdrantSidecar::start(&config(dir.path(), bin, Duration::from_secs(5)))
            .await
            .err();
        assert!(matches!(err, Some(CobaltError::Engine(_))));
        let missing = config(dir.path(), dir.path().join("nope"), Duration::from_secs(1));
        assert!(matches!(
            QdrantSidecar::start(&missing).await.err(),
            Some(CobaltError::NotFound(_))
        ));
    }
}
