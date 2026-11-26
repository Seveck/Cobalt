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

/// Without an explicit project, files go to the project whose root contains them; a dropped
/// folder that is not inside any project becomes a new project named after it.
async fn resolve_project_for(
    state: &AppState,
    paths: &[String],
) -> CmdResult<Option<cobalt_core::Id>> {
    let Some(first) = paths.first() else {
        return Ok(None);
    };
    let store = state.store();
    if let Some(project) = store.resolve_project_by_path(first, false).await? {
        return Ok(Some(project.id));
    }
    let is_dir = tokio::fs::metadata(first)
        .await
        .map(|m| m.is_dir())
        .unwrap_or(false);
    if paths.len() == 1 && is_dir {
        return Ok(store
            .resolve_project_by_path(first, true)
            .await?
            .map(|p| p.id));
    }
    Ok(None)
}

#[tauri::command]
pub async fn ingest_paths(
    app: AppHandle,
    state: State<'_, AppState>,
    mut args: IngestRequest,
) -> CmdResult<IngestReport> {
    let ingest = state.ingest()?;
    if args.project_id.is_none() {
        args.project_id = resolve_project_for(&state, &args.paths).await?;
    }
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

/// Re-indexes files an AI CLI just touched (only files inside a known project; ignored and
/// oversized files are skipped by the ingest rules).
pub async fn reindex_files(
    app: &AppHandle,
    state: &AppState,
    files: Vec<String>,
    project_id: Option<cobalt_core::Id>,
) -> CmdResult<()> {
    let Some(project_id) = project_id else {
        return Ok(());
    };
    let ingest = state.ingest()?;
    let existing: Vec<String> = files
        .into_iter()
        .filter(|f| std::path::Path::new(f).is_file())
        .collect();
    if existing.is_empty() {
        return Ok(());
    }
    {
        let _slot = state.daemon.write_slot().await;
        ingest
            .ingest_paths(
                IngestRequest {
                    paths: existing,
                    project_id: Some(project_id),
                    watch: true,
                    mark_reusable: false,
                    ocr: false,
                },
                progress_sink(app),
            )
            .await?;
    }
    bulk_changed(state, "cobalt-capture");
    Ok(())
}

/// First time a project with a root is seen: index and watch it (if enabled in settings).
pub async fn auto_watch_project(
    app: &AppHandle,
    state: &AppState,
    project: &cobalt_core::model::Project,
) -> CmdResult<()> {
    if !state.config.get().capture.auto_watch_projects {
        return Ok(());
    }
    let Some(root) = project.root_path.clone() else {
        return Ok(());
    };
    if let Some(doc) = state.store().find_source_document_by_path(&root).await?
        && doc.is_watched
    {
        return Ok(());
    }
    let ingest = state.ingest()?;
    {
        let _slot = state.daemon.write_slot().await;
        ingest
            .ingest_paths(
                IngestRequest {
                    paths: vec![root],
                    project_id: Some(project.id),
                    watch: true,
                    mark_reusable: false,
                    ocr: false,
                },
                progress_sink(app),
            )
            .await?;
    }
    bulk_changed(state, "cobalt-capture");
    Ok(())
}
