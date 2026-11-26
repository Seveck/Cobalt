//! Phase 3 ingestion and transfer commands (drag & drop, Past-Life import, promotion to the
//! library, `.cbrain` capsules and `.cobalt-backup`). Progress streams through
//! `cobalt://ingest-progress`; the 3D view refreshes through `cobalt://memory-changed`.

use std::sync::Arc;

use cobalt_core::CobaltError;
use cobalt_core::enums::MemoryChangeKind;
use cobalt_core::events::EVENT_INGEST_PROGRESS;
use cobalt_core::ipc::PathArgs;
use cobalt_core::model::{Memory, MemoryChanged};
use cobalt_core::traits::{IngestService as _, ProgressSink};
use cobalt_core::transfer::{
    BackupExportRequest, BackupImportRequest, BackupManifest, CapsuleExportRequest,
    CapsuleManifest, ImportReport, IngestProgress, IngestReport, IngestRequest,
    PastLifeImportRequest, PromoteFileRequest,
};
use tauri::{AppHandle, Emitter, State};

use crate::state::AppState;

type CmdResult<T> = Result<T, CobaltError>;

fn progress_sink(app: &AppHandle) -> ProgressSink<IngestProgress> {
    let app = app.clone();
    Arc::new(move |p: IngestProgress| {
        let _ = app.emit(EVENT_INGEST_PROGRESS, &p);
    })
}

/// Everything changed in bulk: tell the UI to reload.
fn bulk_changed(state: &AppState, client: &str) {
    state.daemon.emit_memory_changed(MemoryChanged {
        kind: MemoryChangeKind::Created,
        memory_ids: Vec::new(),
        source_client: Some(client.into()),
    });
}

#[tauri::command]
pub async fn ingest_paths(
    app: AppHandle,
    state: State<'_, AppState>,
    args: IngestRequest,
) -> CmdResult<IngestReport> {
    let ingest = state.ingest()?;
    let report = {
        let _slot = state.daemon.write_slot().await;
        ingest.ingest_paths(args, progress_sink(&app)).await?
    };
    bulk_changed(&state, "cobalt-ingest");
    Ok(report)
}

#[tauri::command]
pub async fn import_past_life(
    app: AppHandle,
    state: State<'_, AppState>,
    args: PastLifeImportRequest,
) -> CmdResult<IngestReport> {
    let ingest = state.ingest()?;
    let report = {
        let _slot = state.daemon.write_slot().await;
        ingest.import_past_life(args, progress_sink(&app)).await?
    };
    bulk_changed(&state, "cobalt-import");
    Ok(report)
}

#[tauri::command]
pub async fn promote_file_to_reusable(
    state: State<'_, AppState>,
    args: PromoteFileRequest,
) -> CmdResult<Memory> {
    let ingest = state.ingest()?;
    let memory = {
        let _slot = state.daemon.write_slot().await;
        ingest.promote_file_to_reusable(args).await?
    };
    state.daemon.emit_memory_changed(MemoryChanged {
        kind: MemoryChangeKind::Created,
        memory_ids: vec![memory.id],
        source_client: Some("cobalt-library".into()),
    });
    Ok(memory)
}

#[tauri::command]
pub async fn export_capsule(
    state: State<'_, AppState>,
    args: CapsuleExportRequest,
) -> CmdResult<CapsuleManifest> {
    state.ingest()?.export_capsule(args).await
}

#[tauri::command]
pub async fn import_capsule(state: State<'_, AppState>, args: PathArgs) -> CmdResult<ImportReport> {
    let ingest = state.ingest()?;
    let report = {
        let _pause = state.daemon.pause_writes().await;
        ingest.import_capsule(&args.path).await?
    };
    bulk_changed(&state, "cobalt-capsule");
    Ok(report)
}

#[tauri::command]
pub async fn export_backup(
    state: State<'_, AppState>,
    args: BackupExportRequest,
) -> CmdResult<BackupManifest> {
    state.ingest()?.export_backup(args).await
}

/// Non-destructive restore; MCP writes are queued meanwhile.
#[tauri::command]
pub async fn import_backup(
    state: State<'_, AppState>,
    args: BackupImportRequest,
) -> CmdResult<ImportReport> {
    let ingest = state.ingest()?;
    let report = {
        let _pause = state.daemon.pause_writes().await;
        ingest.import_backup(args).await?
    };
    bulk_changed(&state, "cobalt-backup");
    Ok(report)
}

/// Cancels a running ingest/import job; already committed documents stay.
#[tauri::command]
pub async fn cancel_ingest(
    state: State<'_, AppState>,
    args: cobalt_core::ipc::IdArgs,
) -> CmdResult<bool> {
    state.ingest()?.cancel_job(args.id).await
}
