//! Tauri IPC commands. Convention (see `cobalt_core::ipc`): zero or one parameter named
//! `args`, results as `Result<T, CobaltError>`.

use std::sync::Arc;

use cobalt_core::catalog::is_ollama_model;
use cobalt_core::config::AppSettings;
use cobalt_core::engine::{
    DownloadProgress, EmbeddingModelSpec, EngineInstallRequest, EngineStatus,
};
use cobalt_core::events::{EVENT_DOWNLOAD_PROGRESS, EVENT_VAULT_STATUS};
use cobalt_core::hardware::HardwareProfile;
use cobalt_core::ipc::{AppInfo, CancelDownloadArgs, VaultPasswordArgs};
use cobalt_core::model::VaultStatus;
use cobalt_core::traits::ProgressSink;
use cobalt_core::{CONTRACT_VERSION, CobaltError, SCHEMA_VERSION};
use tauri::{AppHandle, Emitter, State};

use crate::state::{AppState, blocking};

type CmdResult<T> = Result<T, CobaltError>;

#[tauri::command]
pub fn app_info(state: State<'_, AppState>) -> CmdResult<AppInfo> {
    Ok(AppInfo {
        name: "Cobalt".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        contract_version: CONTRACT_VERSION.into(),
        schema_version: SCHEMA_VERSION,
        data_dir: state.home.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub async fn get_hardware_profile(state: State<'_, AppState>) -> CmdResult<HardwareProfile> {
    state.hardware_profile().await
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> CmdResult<AppSettings> {
    Ok(state.config.get())
}

#[tauri::command]
pub async fn update_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    args: AppSettings,
) -> CmdResult<AppSettings> {
    let previous = state.config.get();
    let engine_changed = args.vector_engine != previous.vector_engine
        || args.embedding_model_id != previous.embedding_model_id;
    // Existing vectors belong to the current model: switching without re-embedding leaves
    // most memories unsearchable. Only `swap_engine` may change engine/model then.
    if engine_changed && state.memory_counts().await?.0 > 0 {
        return Err(CobaltError::Conflict(
            "changing the vector engine or embedding model with existing memories requires \
             re-indexing: use swap_engine"
                .into(),
        ));
    }
    let saved = state.config.update(args).await?;
    state
        .vault
        .set_auto_lock_minutes(saved.vault.auto_lock_minutes);
    state.daemon.reload_settings();
    if saved.read_only != state.daemon.is_read_only() {
        state.daemon.set_read_only(saved.read_only).await?;
    }
    if saved.capture.indexing_paused != previous.capture.indexing_paused {
        // Global pause: stop or resume the watcher right away.
        state.restart_watcher().await;
    }
    if saved.shortcuts != previous.shortcuts {
        crate::desktop::register_shortcuts(&app, &saved);
    }
    if engine_changed {
        // Empty brain: nothing to re-embed, switch right away.
        state.activate_engine().await?;
    }
    Ok(saved)
}

#[tauri::command]
pub fn list_embedding_models(state: State<'_, AppState>) -> CmdResult<Vec<EmbeddingModelSpec>> {
    Ok(state.catalog.model_specs())
}

/// Downloads every missing artifact, streaming `cobalt://download-progress`, and returns the
/// resulting status. Does not switch the active engine (that is `update_settings` /
/// `swap_engine`).
#[tauri::command]
pub async fn install_engine(
    app: AppHandle,
    state: State<'_, AppState>,
    args: EngineInstallRequest,
) -> CmdResult<EngineStatus> {
    let emitter = app.clone();
    let sink: ProgressSink<DownloadProgress> = Arc::new(move |p: DownloadProgress| {
        if let Err(err) = emitter.emit(EVENT_DOWNLOAD_PROGRESS, &p) {
            tracing::warn!(%err, "failed to emit download progress");
        }
    });
    state.engines.install(&args, sink).await?;
    if let Err(err) = state.activate_engine().await {
        tracing::warn!(%err, "engine installed but retrieval not activated");
    }
    engine_status_for(&state, args.engine, &args.model_id).await
}

#[tauri::command]
pub fn cancel_download(state: State<'_, AppState>, args: CancelDownloadArgs) -> CmdResult<()> {
    if state.engines.cancel(&args.artifact_id) {
        Ok(())
    } else {
        Err(CobaltError::NotFound(format!(
            "no active download '{}'",
            args.artifact_id
        )))
    }
}

/// State of the default OCR model (contract v1.7.0).
#[tauri::command]
pub fn get_ocr_status(state: State<'_, AppState>) -> CmdResult<cobalt_core::engine::OcrStatus> {
    state
        .engines
        .ocr_status(cobalt_core::catalog::DEFAULT_OCR_MODEL)
}

/// Downloads and verifies the OCR model (streams `cobalt://download-progress`), then turns OCR
/// on for every ingest (images and scanned PDFs).
#[tauri::command]
pub async fn install_ocr(
    app: AppHandle,
    state: State<'_, AppState>,
    args: cobalt_core::engine::OcrInstallRequest,
) -> CmdResult<cobalt_core::engine::OcrStatus> {
    let emitter = app.clone();
    let sink: ProgressSink<DownloadProgress> = Arc::new(move |p: DownloadProgress| {
        if let Err(err) = emitter.emit(EVENT_DOWNLOAD_PROGRESS, &p) {
            tracing::warn!(%err, "failed to emit download progress");
        }
    });
    let status = state.engines.install_ocr(&args.model_id, sink).await?;
    state.refresh_ocr().await;
    Ok(status)
}

/// Status of the engine/model currently selected in settings.
#[tauri::command]
pub async fn get_engine_status(state: State<'_, AppState>) -> CmdResult<EngineStatus> {
    let settings = state.config.get();
    engine_status_for(&state, settings.vector_engine, &settings.embedding_model_id).await
}

async fn engine_status_for(
    state: &AppState,
    engine: cobalt_core::enums::EngineKind,
    model_id: &str,
) -> CmdResult<EngineStatus> {
    let dimensions = if is_ollama_model(model_id) {
        0
    } else {
        state
            .catalog
            .model(model_id)
            .map(|m| m.spec.dimensions)
            .ok_or_else(|| CobaltError::NotFound(format!("embedding model '{model_id}'")))?
    };
    let (vector_count, _) = state.memory_counts().await?;
    Ok(EngineStatus {
        engine,
        engine_state: state.engines.engine_state(engine).await,
        model_id: model_id.to_owned(),
        model_state: state.engines.model_state(model_id),
        dimensions,
        vector_count,
        installed_bytes: state.engines.installed_bytes(engine, model_id),
        sidecar_endpoint: state.engines.sidecar_endpoint().await,
        last_error: None,
    })
}

pub async fn vault_status_of(state: &AppState) -> CmdResult<VaultStatus> {
    let (_, encrypted_count) = state.memory_counts().await?;
    Ok(VaultStatus {
        initialized: state.vault.is_initialized(),
        unlocked: state.vault.is_unlocked(),
        auto_lock_minutes: state.vault.auto_lock_minutes(),
        encrypted_count,
    })
}

async fn emit_vault(app: &AppHandle, state: &AppState) -> CmdResult<VaultStatus> {
    let status = vault_status_of(state).await?;
    if let Err(err) = app.emit(EVENT_VAULT_STATUS, &status) {
        tracing::warn!(%err, "failed to emit vault status");
    }
    Ok(status)
}

#[tauri::command]
pub async fn vault_status(state: State<'_, AppState>) -> CmdResult<VaultStatus> {
    vault_status_of(&state).await
}

#[tauri::command]
pub async fn vault_setup(
    app: AppHandle,
    state: State<'_, AppState>,
    args: VaultPasswordArgs,
) -> CmdResult<VaultStatus> {
    let vault = state.vault.clone();
    blocking(move || vault.setup(&args.password)).await?;
    emit_vault(&app, &state).await
}

#[tauri::command]
pub async fn vault_unlock(
    app: AppHandle,
    state: State<'_, AppState>,
    args: VaultPasswordArgs,
) -> CmdResult<VaultStatus> {
    let vault = state.vault.clone();
    blocking(move || vault.unlock(&args.password)).await?;
    emit_vault(&app, &state).await
}

#[tauri::command]
pub async fn vault_lock(app: AppHandle, state: State<'_, AppState>) -> CmdResult<VaultStatus> {
    state.vault.lock();
    emit_vault(&app, &state).await
}

/// Full name of the OS account, used to prefill the greeting name (never sent anywhere).
#[tauri::command]
pub fn get_system_user_name() -> CmdResult<Option<String>> {
    Ok(system_user_name())
}

fn system_user_name() -> Option<String> {
    let clean = |s: &str| {
        let s = s.split(',').next().unwrap_or_default().trim().to_owned();
        (!s.is_empty()).then_some(s)
    };
    #[cfg(target_os = "macos")]
    if let Ok(out) = std::process::Command::new("id").arg("-F").output() {
        if let Some(n) = clean(&String::from_utf8_lossy(&out.stdout)) {
            return Some(n);
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let user = std::env::var("USER").unwrap_or_default();
        if let Ok(passwd) = std::fs::read_to_string("/etc/passwd")
            && let Some(gecos) = passwd
                .lines()
                .map(|l| l.split(':').collect::<Vec<_>>())
                .find(|f| f.first() == Some(&user.as_str()))
                .and_then(|f| f.get(4).and_then(|g| clean(g)))
        {
            return Some(gecos);
        }
    }
    #[cfg(windows)]
    if let Ok(out) = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "(Get-CimInstance Win32_UserAccount -Filter \"Name='$env:USERNAME'\").FullName",
        ])
        .output()
    {
        if let Some(n) = clean(&String::from_utf8_lossy(&out.stdout)) {
            return Some(n);
        }
    }
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .ok()
        .and_then(|u| clean(&u))
}
