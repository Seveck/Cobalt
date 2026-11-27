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
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::AppState;

type CmdResult<T> = Result<T, CobaltError>;

/// Progress of jobs Cobalt starts by itself (hooks, auto-watch): flagged as background.
fn background_sink(
    app: &AppHandle,
    project_id: Option<cobalt_core::Id>,
) -> ProgressSink<IngestProgress> {
    let app = app.clone();
    Arc::new(move |mut p: IngestProgress| {
        p.background = true;
        p.project_id = p.project_id.or(project_id);
        let _ = app.emit(EVENT_INGEST_PROGRESS, &p);
    })
}

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
    // A linked git worktree belongs to the project of its main checkout.
    if let Some(main) = cobalt_mcp::project::main_checkout_path(std::path::Path::new(first))
        && let Some(project) = store
            .resolve_project_by_path(&main.to_string_lossy(), false)
            .await?
    {
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
    if state.config.get().capture.indexing_paused {
        return Ok(());
    }
    let ingest = state.ingest()?;
    // Only files inside the project's own folder: an AI editing a linked git worktree (another
    // checkout of the same repo) resolves to this project but its half-done copies must not be
    // indexed; they arrive through the main checkout once merged.
    let Some(root) = state
        .store()
        .get_project(project_id)
        .await?
        .and_then(|p| p.root_path)
    else {
        return Ok(());
    };
    let root = std::path::PathBuf::from(root);
    let existing: Vec<String> = files
        .into_iter()
        .filter(|f| {
            let path = std::path::Path::new(f);
            path.starts_with(&root) && path.is_file()
        })
        .collect();
    if existing.is_empty() {
        return Ok(());
    }
    // Background jobs do not hold the daemon write slot for their whole run (that froze every
    // exclusive action behind a long indexing job); the store gates each write, so an engine
    // swap simply queues the job's next file, like the file watcher.
    ingest
        .ingest_paths(
            IngestRequest {
                paths: existing,
                project_id: Some(project_id),
                watch: true,
                mark_reusable: false,
                ocr: false,
            },
            background_sink(app, Some(project_id)),
        )
        .await?;
    bulk_changed(state, "cobalt-capture");
    Ok(())
}

/// First time a project with a root is seen: index and watch it (if enabled in settings).
pub async fn auto_watch_project(
    app: &AppHandle,
    state: &AppState,
    project: &cobalt_core::model::Project,
) -> CmdResult<()> {
    let capture = state.config.get().capture;
    if !capture.auto_watch_projects || capture.indexing_paused {
        return Ok(());
    }
    watch_project_root(app, state, project).await
}

/// Indexes and watches a project root unless it is already watched.
pub async fn watch_project_root(
    app: &AppHandle,
    state: &AppState,
    project: &cobalt_core::model::Project,
) -> CmdResult<()> {
    let Some(root) = project.root_path.clone() else {
        return Ok(());
    };
    if let Some(doc) = state.store().find_source_document_by_path(&root).await?
        && doc.is_watched
    {
        return Ok(());
    }
    let ingest = state.ingest()?;
    // No whole-job write slot: see `reindex_files`.
    ingest
        .ingest_paths(
            IngestRequest {
                paths: vec![root],
                project_id: Some(project.id),
                watch: true,
                mark_reusable: false,
                ocr: false,
            },
            background_sink(app, Some(project.id)),
        )
        .await?;
    bulk_changed(state, "cobalt-capture");
    Ok(())
}

/// Starts or stops watching a project root (Tools > Projects switch).
#[tauri::command]
pub async fn set_project_watched(
    app: AppHandle,
    state: State<'_, AppState>,
    args: cobalt_core::ipc::SetProjectWatchedArgs,
) -> CmdResult<bool> {
    let project = state
        .store()
        .get_project(args.project_id)
        .await?
        .ok_or_else(|| CobaltError::NotFound(format!("project {}", args.project_id)))?;
    let root = project
        .root_path
        .clone()
        .ok_or_else(|| CobaltError::InvalidInput("the project has no root folder".into()))?;
    let doc = state.store().find_source_document_by_path(&root).await?;
    if args.watched {
        match doc {
            Some(d) if d.is_watched => {}
            Some(d) => {
                state.store().set_watched(d.id, true).await?;
            }
            None => {
                // First time: index it in the background and keep it watched.
                let app2 = app.clone();
                tauri::async_runtime::spawn(async move {
                    let state = app2.state::<AppState>();
                    if let Err(err) = watch_project_root(&app2, &state, &project).await {
                        tracing::warn!(%err, "project indexing failed");
                    }
                });
            }
        }
    } else if let Some(d) = doc {
        state.store().set_watched(d.id, false).await?;
    }
    state.restart_watcher().await;
    Ok(args.watched)
}
