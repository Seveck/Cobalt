//! `EngineManager`: installs, inspects and removes embedding models and engine binaries
//! (all from the pinned catalog), and owns the Qdrant sidecar lifecycle.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::sync::Mutex;

use super::downloader::{CancelFlag, Downloader, extract_archive, marker_path};
use super::sidecar::{QdrantSidecar, SidecarConfig, default_storage_dir};
use crate::catalog::{Catalog, OcrModelEntry, is_ollama_model};
use crate::engine::{DownloadArtifact, DownloadProgress, EngineInstallRequest, OcrStatus};
use crate::enums::{DownloadPhase, EngineKind, EngineState};
use crate::error::{CobaltError, Result};
use crate::paths::{ENGINES_DIR, LOGS_DIR, MODELS_DIR};
use crate::traits::ProgressSink;

pub struct EngineManager {
    home: PathBuf,
    catalog: &'static Catalog,
    downloader: Downloader,
    active: std::sync::Mutex<HashMap<String, CancelFlag>>,
    sidecar: Mutex<Option<QdrantSidecar>>,
}

impl EngineManager {
    pub fn new(home: PathBuf) -> Result<Self> {
        Ok(Self {
            downloader: Downloader::new(home.clone())?,
            catalog: Catalog::builtin()?,
            home,
            active: std::sync::Mutex::new(HashMap::new()),
            sidecar: Mutex::new(None),
        })
    }

    pub fn with_downloader(mut self, downloader: Downloader) -> Self {
        self.downloader = downloader;
        self
    }

    pub fn catalog(&self) -> &'static Catalog {
        self.catalog
    }

    pub fn home(&self) -> &Path {
        &self.home
    }

    /// Folder holding a model's files (`~/.cobalt/models/<id>/`).
    pub fn model_dir(&self, model_id: &str) -> PathBuf {
        self.home.join(MODELS_DIR).join(model_id)
    }

    fn active(&self) -> std::sync::MutexGuard<'_, HashMap<String, CancelFlag>> {
        self.active.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// `true` when the artifact is verified on disk (archives: extracted executable present).
    pub fn is_artifact_installed(&self, artifact: &DownloadArtifact) -> bool {
        if !self.downloader.is_verified(artifact) {
            return false;
        }
        match &artifact.archive {
            None => true,
            Some(_) => self
                .catalog
                .engine(EngineKind::QdrantSidecar)
                .and_then(|e| e.binaries.iter().find(|b| b.artifact.id == artifact.id))
                .and_then(|b| self.downloader.dest_path(&b.artifact).ok().map(|d| (b, d)))
                .and_then(|(b, d)| d.parent().map(|p| p.join(&b.executable)))
                .is_some_and(|exe| exe.is_file()),
        }
    }

    /// Bytes still to download for `engine` + `model_id`.
    pub fn missing_bytes(&self, engine: EngineKind, model_id: &str) -> Result<u64> {
        Ok(self
            .catalog
            .artifacts_for(engine, model_id)?
            .iter()
            .filter(|a| !self.is_artifact_installed(a))
            .map(|a| a.size_bytes)
            .sum())
    }

    /// Relative-dest predicate for `profiler::build_recommendation`.
    pub fn is_relative_dest_installed(&self, relative_dest: &str) -> bool {
        self.catalog
            .models()
            .iter()
            .flat_map(|m| m.files.iter())
            .chain(
                self.catalog
                    .engine(EngineKind::QdrantSidecar)
                    .into_iter()
                    .flat_map(|e| e.binaries.iter().map(|b| &b.artifact)),
            )
            .find(|a| a.relative_dest == relative_dest)
            .is_some_and(|a| self.is_artifact_installed(a))
    }

    pub fn model_state(&self, model_id: &str) -> EngineState {
        if is_ollama_model(model_id) {
            return EngineState::Installed;
        }
        let Some(model) = self.catalog.model(model_id) else {
            return EngineState::Error;
        };
        let active = self.active();
        if model.files.iter().any(|f| active.contains_key(&f.id)) {
            return EngineState::Downloading;
        }
        drop(active);
        if model.files.iter().all(|f| self.is_artifact_installed(f)) {
            EngineState::Installed
        } else {
            EngineState::NotInstalled
        }
    }

    pub async fn engine_state(&self, engine: EngineKind) -> EngineState {
        match engine {
            EngineKind::QdrantSidecar => {
                let mut guard = self.sidecar.lock().await;
                if let Some(sidecar) = guard.as_mut() {
                    if sidecar.is_running() {
                        return EngineState::Running;
                    }
                    *guard = None;
                    return EngineState::Stopped;
                }
                drop(guard);
                match self.catalog.engine_binary(engine) {
                    Ok(Some(b)) if self.active().contains_key(&b.artifact.id) => {
                        EngineState::Downloading
                    }
                    Ok(Some(b)) if self.is_artifact_installed(&b.artifact) => {
                        EngineState::Installed
                    }
                    Ok(_) => EngineState::NotInstalled,
                    Err(_) => EngineState::Error,
                }
            }
            // Bundled in the binary or external connectors: nothing to install.
            _ => EngineState::Installed,
        }
    }

    /// Downloads (and extracts) every missing artifact for the request, sequentially.
    pub async fn install(
        &self,
        req: &EngineInstallRequest,
        progress: ProgressSink<DownloadProgress>,
    ) -> Result<()> {
        let artifacts = self.catalog.artifacts_for(req.engine, &req.model_id)?;
        self.install_artifacts(artifacts, progress).await
    }

    /// Downloads every missing artifact sequentially (verified against the catalog SHA-256).
    async fn install_artifacts(
        &self,
        artifacts: Vec<DownloadArtifact>,
        progress: ProgressSink<DownloadProgress>,
    ) -> Result<()> {
        for artifact in artifacts {
            if self.is_artifact_installed(&artifact) {
                progress(DownloadProgress {
                    artifact_id: artifact.id.clone(),
                    phase: DownloadPhase::Completed,
                    downloaded_bytes: artifact.size_bytes,
                    total_bytes: Some(artifact.size_bytes),
                    attempt: 0,
                    message: None,
                });
                continue;
            }
            let cancel: CancelFlag = Arc::new(AtomicBool::new(false));
            {
                let mut active = self.active();
                if active.contains_key(&artifact.id) {
                    return Err(CobaltError::Conflict(format!(
                        "{} is already downloading",
                        artifact.id
                    )));
                }
                active.insert(artifact.id.clone(), cancel.clone());
            }
            let result = self.fetch_and_extract(&artifact, &progress, &cancel).await;
            self.active().remove(&artifact.id);
            result?;
        }
        Ok(())
    }

    async fn fetch_and_extract(
        &self,
        artifact: &DownloadArtifact,
        progress: &ProgressSink<DownloadProgress>,
        cancel: &CancelFlag,
    ) -> Result<()> {
        let path = self.downloader.fetch(artifact, progress, cancel).await?;
        let Some(kind) = artifact.archive.clone() else {
            return Ok(());
        };
        progress(DownloadProgress {
            artifact_id: artifact.id.clone(),
            phase: DownloadPhase::Extracting,
            downloaded_bytes: artifact.size_bytes,
            total_bytes: Some(artifact.size_bytes),
            attempt: 1,
            message: None,
        });
        let dir = path
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| CobaltError::Internal("archive without parent dir".into()))?;
        let archive_path = path.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            extract_archive(&archive_path, &kind, &dir)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let exe = dir.join("qdrant");
                if exe.is_file() {
                    std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755))?;
                }
            }
            // Keep only the verification marker; the archive itself is no longer needed.
            std::fs::remove_file(&archive_path)?;
            Ok(())
        })
        .await
        .map_err(|e| CobaltError::Internal(format!("extract task: {e}")))??;
        // The marker written by the downloader stays next to the (removed) archive path.
        debug_assert!(marker_path(&path).exists());
        Ok(())
    }

    // ------------------------------------------------------------------ OCR models

    fn ocr_entry(&self, model_id: &str) -> Result<&'static OcrModelEntry> {
        self.catalog
            .ocr_model(model_id)
            .ok_or_else(|| CobaltError::NotFound(format!("OCR model '{model_id}'")))
    }

    /// Installed / downloading / not installed for an OCR model of the catalog.
    pub fn ocr_status(&self, model_id: &str) -> Result<OcrStatus> {
        let entry = self.ocr_entry(model_id)?;
        let downloading = {
            let active = self.active();
            entry.files.iter().any(|f| active.contains_key(&f.id))
        };
        let installed: Vec<bool> = entry
            .files
            .iter()
            .map(|f| self.is_artifact_installed(f))
            .collect();
        let state = if downloading {
            EngineState::Downloading
        } else if installed.iter().all(|i| *i) {
            EngineState::Installed
        } else {
            EngineState::NotInstalled
        };
        let installed_bytes = entry
            .files
            .iter()
            .zip(&installed)
            .filter(|(_, i)| **i)
            .map(|(f, _)| f.size_bytes)
            .sum();
        Ok(OcrStatus {
            model_id: entry.id.clone(),
            display_name: entry.display_name.clone(),
            languages: entry.languages.clone(),
            state,
            size_bytes: entry.size_bytes,
            installed_bytes,
        })
    }

    /// Downloads and verifies the OCR model files.
    pub async fn install_ocr(
        &self,
        model_id: &str,
        progress: ProgressSink<DownloadProgress>,
    ) -> Result<OcrStatus> {
        let entry = self.ocr_entry(model_id)?;
        self.install_artifacts(entry.files.clone(), progress)
            .await?;
        self.ocr_status(model_id)
    }

    /// Verified `(detection, recognition)` model paths, or `None` until installed.
    pub fn ocr_model_paths(&self, model_id: &str) -> Option<(PathBuf, PathBuf)> {
        let entry = self.catalog.ocr_model(model_id)?;
        let (det, rec) = entry.detection_and_recognition()?;
        if !(self.is_artifact_installed(det) && self.is_artifact_installed(rec)) {
            return None;
        }
        Some((
            self.downloader.dest_path(det).ok()?,
            self.downloader.dest_path(rec).ok()?,
        ))
    }

    /// Requests cancellation of an in-flight artifact download.
    pub fn cancel(&self, artifact_id: &str) -> bool {
        match self.active().get(artifact_id) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }

    /// Bytes currently used on disk by the engine binary and model files.
    pub fn installed_bytes(&self, engine: EngineKind, model_id: &str) -> u64 {
        let mut total = 0;
        if !is_ollama_model(model_id) {
            total += dir_size(&self.model_dir(model_id));
        }
        if engine == EngineKind::QdrantSidecar {
            total += dir_size(&self.home.join(ENGINES_DIR).join("qdrant"));
        }
        total
    }

    /// Deletes a model folder and/or the Qdrant binaries. Returns freed bytes.
    /// The caller must ensure the targets are not the active engine/model.
    pub async fn remove(&self, engine: Option<EngineKind>, model_id: Option<&str>) -> Result<u64> {
        let mut freed = 0;
        if let Some(model_id) = model_id {
            if self.catalog.model(model_id).is_none() {
                return Err(CobaltError::NotFound(format!(
                    "embedding model '{model_id}'"
                )));
            }
            let dir = self.model_dir(model_id);
            freed += dir_size(&dir);
            if dir.exists() {
                tokio::fs::remove_dir_all(&dir).await?;
            }
        }
        if engine == Some(EngineKind::QdrantSidecar) {
            self.stop_sidecar().await?;
            let dir = self.home.join(ENGINES_DIR).join("qdrant");
            freed += dir_size(&dir);
            if dir.exists() {
                tokio::fs::remove_dir_all(&dir).await?;
            }
        }
        Ok(freed)
    }

    /// Starts the Qdrant sidecar (idempotent). Returns `(http_endpoint, api_key)`.
    pub async fn ensure_sidecar(&self) -> Result<(String, String)> {
        let mut guard = self.sidecar.lock().await;
        if let Some(sidecar) = guard.as_mut()
            && sidecar.is_running()
        {
            return Ok((sidecar.http_endpoint(), sidecar.api_key().to_owned()));
        }
        let binary = self
            .catalog
            .engine_binary(EngineKind::QdrantSidecar)?
            .ok_or_else(|| CobaltError::Internal("qdrant missing from catalog".into()))?;
        if !self.is_artifact_installed(&binary.artifact) {
            return Err(CobaltError::NotFound("qdrant is not installed".into()));
        }
        let exe = self
            .downloader
            .dest_path(&binary.artifact)?
            .parent()
            .map(|p| p.join(&binary.executable))
            .ok_or_else(|| CobaltError::Internal("qdrant path".into()))?;
        let sidecar = QdrantSidecar::start(&SidecarConfig {
            binary: exe,
            storage_dir: default_storage_dir(&self.home),
            log_file: self.home.join(LOGS_DIR).join("qdrant.log"),
            ready_timeout: Duration::from_secs(30),
        })
        .await?;
        let out = (sidecar.http_endpoint(), sidecar.api_key().to_owned());
        *guard = Some(sidecar);
        Ok(out)
    }

    pub async fn sidecar_endpoint(&self) -> Option<String> {
        let mut guard = self.sidecar.lock().await;
        let sidecar = guard.as_mut()?;
        if sidecar.is_running() {
            Some(sidecar.http_endpoint())
        } else {
            None
        }
    }

    pub async fn stop_sidecar(&self) -> Result<()> {
        if let Some(sidecar) = self.sidecar.lock().await.take() {
            sidecar.stop().await?;
        }
        Ok(())
    }
}

fn dir_size(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    if meta.is_file() {
        return meta.len();
    }
    if !meta.is_dir() {
        return 0;
    }
    std::fs::read_dir(path)
        .map(|entries| entries.flatten().map(|e| dir_size(&e.path())).sum())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn states_and_missing_bytes_on_empty_home() {
        let home = tempfile::tempdir().unwrap();
        let mgr = EngineManager::new(home.path().to_path_buf()).unwrap();
        assert_eq!(
            mgr.model_state("multilingual-e5-small"),
            EngineState::NotInstalled
        );
        assert_eq!(
            mgr.model_state("ollama:nomic-embed-text"),
            EngineState::Installed
        );
        assert_eq!(mgr.model_state("unknown"), EngineState::Error);
        assert_eq!(
            mgr.engine_state(EngineKind::SqliteVec).await,
            EngineState::Installed
        );
        assert_eq!(
            mgr.engine_state(EngineKind::QdrantSidecar).await,
            EngineState::NotInstalled
        );
        let model_bytes = mgr
            .catalog()
            .model("multilingual-e5-small")
            .unwrap()
            .spec
            .size_bytes;
        assert_eq!(
            mgr.missing_bytes(EngineKind::SqliteVec, "multilingual-e5-small")
                .unwrap(),
            model_bytes
        );
        assert!(
            mgr.missing_bytes(EngineKind::QdrantSidecar, "multilingual-e5-small")
                .unwrap()
                > model_bytes
        );
        assert!(!mgr.cancel("nothing-running"));
        assert!(matches!(
            mgr.ensure_sidecar().await,
            Err(CobaltError::NotFound(_))
        ));
    }

    #[tokio::test]
    async fn verified_files_count_as_installed_and_remove_frees_space() {
        let home = tempfile::tempdir().unwrap();
        let mgr = EngineManager::new(home.path().to_path_buf()).unwrap();
        let model = mgr
            .catalog()
            .model("multilingual-e5-small")
            .unwrap()
            .clone();
        // Simulate verified files: we cannot download 135 MB in a unit test, so create files
        // of the exact size with the verification marker the downloader writes.
        for f in &model.files {
            let dest = home.path().join(&f.relative_dest);
            std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
            let file = std::fs::File::create(&dest).unwrap();
            file.set_len(f.size_bytes).unwrap();
            std::fs::write(marker_path(&dest), &f.sha256).unwrap();
        }
        assert_eq!(mgr.model_state(&model.spec.id), EngineState::Installed);
        assert_eq!(
            mgr.missing_bytes(EngineKind::SqliteVec, &model.spec.id)
                .unwrap(),
            0
        );
        assert!(mgr.is_relative_dest_installed(&model.files[0].relative_dest));
        let freed = mgr.remove(None, Some(&model.spec.id)).await.unwrap();
        assert!(freed >= model.spec.size_bytes);
        assert_eq!(mgr.model_state(&model.spec.id), EngineState::NotInstalled);
    }

    #[tokio::test]
    async fn ocr_models_report_state_and_paths_once_verified() {
        let home = tempfile::tempdir().unwrap();
        let mgr = EngineManager::new(home.path().to_path_buf()).unwrap();
        let id = crate::catalog::DEFAULT_OCR_MODEL;
        let status = mgr.ocr_status(id).unwrap();
        assert_eq!(status.state, EngineState::NotInstalled);
        assert_eq!(status.installed_bytes, 0);
        assert!(mgr.ocr_model_paths(id).is_none());
        assert!(matches!(
            mgr.ocr_status("nope"),
            Err(CobaltError::NotFound(_))
        ));

        // Same simulation as above: exact-size files plus the downloader's verification marker.
        let entry = mgr.catalog().ocr_model(id).unwrap().clone();
        for f in &entry.files {
            let dest = home.path().join(&f.relative_dest);
            std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
            std::fs::File::create(&dest)
                .unwrap()
                .set_len(f.size_bytes)
                .unwrap();
            std::fs::write(marker_path(&dest), &f.sha256).unwrap();
        }
        let status = mgr.ocr_status(id).unwrap();
        assert_eq!(status.state, EngineState::Installed);
        assert_eq!(status.installed_bytes, entry.size_bytes);
        let (det, rec) = mgr.ocr_model_paths(id).unwrap();
        assert!(det.ends_with("models/ocrs-latin/text-detection.onnx"));
        assert!(rec.ends_with("models/ocrs-latin/text-recognition.onnx"));
        // Already verified: install only reports completion, no network.
        let status = mgr.install_ocr(id, Arc::new(|_| {})).await.unwrap();
        assert_eq!(status.state, EngineState::Installed);
    }
}
