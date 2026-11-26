//! Phase 3 IPC commands: projects, library, telemetry, connectors, MCP Doctor, tool docs,
//! theme store, engine swap, web-AI bridge and quick note.

use std::sync::Arc;

use cobalt_core::config::BUILTIN_THEME_ID;
use cobalt_core::connectors::{ConnectorStatus, ConnectorToggleRequest, ConnectorToggleResult, DoctorReport};
use cobalt_core::engine::{EngineSwapProgress, EngineSwapReport, EngineSwapRequest};
use cobalt_core::enums::{EngineKind, MemoryCategory};
use cobalt_core::events::EVENT_ENGINE_SWAP_PROGRESS;
use cobalt_core::ipc::{
    DoctorFixArgs, ListProjectsArgs, McpToolDoc, PathArgs, QuickNoteArgs, RelinkArgs,
    RemoveEngineArtifactsArgs, SetWatchedArgs, ThemeIdArgs, ThemeSearchArgs, UpdateProjectArgs,
};
use cobalt_core::model::{InstalledTheme, NewMemory, NewProject, Project, ProjectStats, SaveOutcome, SourceDocument};
use cobalt_core::search::{LibraryFilter, ReusableAsset, WebContext, WebContextRequest};
use cobalt_core::telemetry::{Page, TelemetryLog, TelemetryQuery, TelemetryRange, TelemetrySummary};
use cobalt_core::theme::{ThemeCard, ThemeManifest};
use cobalt_core::traits::ProgressSink;
use cobalt_core::CobaltError;
use cobalt_mcp::connectors::{self, PlatformDirs};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::AppState;
use crate::{doctor, themes};

type CmdResult<T> = Result<T, CobaltError>;

const MAX_THEME_FILE_BYTES: u64 = 30 * 1024 * 1024;

// ------------------------------------------------------------------ projects & library

#[tauri::command]
pub async fn list_projects(state: State<'_, AppState>, args: ListProjectsArgs) -> CmdResult<Vec<ProjectStats>> {
    state.store().list_projects(args.include_archived).await
}

#[tauri::command]
pub async fn create_project(state: State<'_, AppState>, args: NewProject) -> CmdResult<Project> {
    state.store().create_project(args).await
}

#[tauri::command]
pub async fn update_project(state: State<'_, AppState>, args: UpdateProjectArgs) -> CmdResult<Project> {
    state.store().update_project(args.id, args.patch).await
}

#[tauri::command]
pub async fn list_library(state: State<'_, AppState>, args: LibraryFilter) -> CmdResult<Vec<ReusableAsset>> {
    state.store().list_library(args).await
}

#[tauri::command]
pub async fn relink_source_document(state: State<'_, AppState>, args: RelinkArgs) -> CmdResult<SourceDocument> {
    state.store().relink_source_document(args.source_doc_id, &args.new_path).await
}

#[tauri::command]
pub async fn set_watched(state: State<'_, AppState>, args: SetWatchedArgs) -> CmdResult<SourceDocument> {
    state.store().set_watched(args.source_doc_id, args.watched).await
}

// ------------------------------------------------------------------ telemetry

#[tauri::command]
pub async fn get_telemetry_summary(state: State<'_, AppState>, args: TelemetryRange) -> CmdResult<TelemetrySummary> {
    state.store().telemetry_summary(args).await
}

#[tauri::command]
pub async fn query_telemetry(state: State<'_, AppState>, args: TelemetryQuery) -> CmdResult<Page<TelemetryLog>> {
    state.store().query_telemetry(args).await
}

// ------------------------------------------------------------------ connectors & doctor

fn exe() -> CmdResult<std::path::PathBuf> {
    Ok(std::env::current_exe()?)
}

#[tauri::command]
pub fn list_connectors() -> CmdResult<Vec<ConnectorStatus>> {
    Ok(connectors::status_all(&PlatformDirs::detect()?, &exe()?))
}

#[tauri::command]
pub fn toggle_connector(args: ConnectorToggleRequest) -> CmdResult<ConnectorToggleResult> {
    connectors::toggle(args.client, args.enable, &PlatformDirs::detect()?, &exe()?)
}

#[tauri::command]
pub async fn run_doctor(state: State<'_, AppState>) -> CmdResult<DoctorReport> {
    doctor::run(&state).await
}

#[tauri::command]
pub async fn doctor_fix(state: State<'_, AppState>, args: DoctorFixArgs) -> CmdResult<DoctorReport> {
    doctor::fix(&state, &args.check_id).await?;
    doctor::run(&state).await
}

#[tauri::command]
pub fn get_mcp_tool_docs(state: State<'_, AppState>) -> CmdResult<Vec<McpToolDoc>> {
    let overrides = state.config.get().mcp.tool_docstring_overrides;
    Ok(cobalt_mcp::tools::TOOLS
        .iter()
        .map(|t| McpToolDoc {
            name: t.name.into(),
            default_description: t.description.into(),
            override_description: overrides.get(t.name).cloned(),
        })
        .collect())
}

// ------------------------------------------------------------------ theme store

fn themes_dir(state: &AppState) -> std::path::PathBuf {
    state.home.join(cobalt_core::paths::THEMES_DIR)
}

fn http() -> CmdResult<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(concat!("Cobalt/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| CobaltError::Download(e.to_string()))
}

#[tauri::command]
pub async fn search_theme_registry(state: State<'_, AppState>, args: ThemeSearchArgs) -> CmdResult<Vec<ThemeCard>> {
    let index = themes::fetch_registry(&http()?).await?;
    let installed = state.store().list_installed_themes().await?;
    let tier = state.config.get().hardware_tier;
    Ok(themes::search(&index, args.query.as_deref())
        .into_iter()
        .map(|entry| {
            let local = installed.iter().find(|t| t.id == entry.id);
            ThemeCard {
                compatibility: themes::compatibility(entry.hardware_tier, tier),
                installed: local.is_some(),
                installed_version: local.map(|t| t.version.clone()),
                entry,
            }
        })
        .collect())
}

#[tauri::command]
pub async fn install_theme(state: State<'_, AppState>, args: ThemeIdArgs) -> CmdResult<InstalledTheme> {
    let client = http()?;
    let index = themes::fetch_registry(&client).await?;
    let entry = index
        .themes
        .into_iter()
        .find(|t| t.id == args.theme_id)
        .ok_or_else(|| CobaltError::NotFound(format!("theme {}", args.theme_id)))?;
    let package = themes::download_package(&client, &entry).await?;
    let dir = themes_dir(&state);
    let installed = crate::state::blocking(move || themes::install_package(&dir, &package)).await?;
    if installed.id != entry.id {
        let _ = themes::uninstall(&themes_dir(&state), &installed.id);
        return Err(CobaltError::Integrity("package id does not match the registry entry".into()));
    }
    state.store().record_installed_theme(installed.clone()).await?;
    Ok(installed)
}

#[tauri::command]
pub async fn install_theme_file(state: State<'_, AppState>, args: PathArgs) -> CmdResult<InstalledTheme> {
    let meta = tokio::fs::metadata(&args.path).await?;
    if meta.len() > MAX_THEME_FILE_BYTES {
        return Err(CobaltError::Sandbox("theme package is too large".into()));
    }
    let package = tokio::fs::read(&args.path).await?;
    let dir = themes_dir(&state);
    let installed = crate::state::blocking(move || themes::install_package(&dir, &package)).await?;
    state.store().record_installed_theme(installed.clone()).await?;
    Ok(installed)
}

#[tauri::command]
pub async fn uninstall_theme(state: State<'_, AppState>, args: ThemeIdArgs) -> CmdResult<()> {
    themes::uninstall(&themes_dir(&state), &args.theme_id)?;
    state.store().remove_installed_theme(&args.theme_id).await?;
    if state.config.get().active_theme_id == args.theme_id {
        state.config.modify(|s| s.active_theme_id = BUILTIN_THEME_ID.into()).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn list_installed_themes(state: State<'_, AppState>) -> CmdResult<Vec<InstalledTheme>> {
    let mut list = vec![themes::builtin_installed()?];
    list.extend(state.store().list_installed_themes().await?);
    Ok(list)
}

#[tauri::command]
pub fn get_theme_manifest(state: State<'_, AppState>, args: ThemeIdArgs) -> CmdResult<ThemeManifest> {
    themes::read_manifest(&themes_dir(&state), &args.theme_id)
}

// ------------------------------------------------------------------ engines

/// 1-Click engine/model migration. MCP writes are queued while it runs; on success the
/// settings switch and retrieval is rebuilt, on failure the store rolls back.
#[tauri::command]
pub async fn swap_engine(app: AppHandle, state: State<'_, AppState>, args: EngineSwapRequest) -> CmdResult<EngineSwapReport> {
    if state.engines.model_state(&args.target_model_id) != cobalt_core::enums::EngineState::Installed
        && !cobalt_core::catalog::is_ollama_model(&args.target_model_id)
    {
        return Err(CobaltError::InvalidInput("install the target model first".into()));
    }
    let mut req = args.clone();
    if args.target_engine == EngineKind::QdrantSidecar {
        let (endpoint, api_key) = state.engines.ensure_sidecar().await?;
        req.external_endpoint = Some(format!("{endpoint}#api-key={api_key}"));
    }
    let emitter = app.clone();
    let sink: ProgressSink<EngineSwapProgress> = Arc::new(move |p: EngineSwapProgress| {
        let _ = emitter.emit(EVENT_ENGINE_SWAP_PROGRESS, &p);
    });
    let report = {
        let _pause = state.daemon.pause_writes().await;
        state.store().swap_engine(req, sink).await?
    };
    if !report.rolled_back {
        state
            .config
            .modify(|s| {
                s.vector_engine = args.target_engine;
                s.embedding_model_id = args.target_model_id.clone();
            })
            .await?;
        state.activate_engine().await?;
    }
    Ok(report)
}

#[tauri::command]
pub async fn remove_engine_artifacts(state: State<'_, AppState>, args: RemoveEngineArtifactsArgs) -> CmdResult<u64> {
    let settings = state.config.get();
    if args.model_id.as_deref() == Some(settings.embedding_model_id.as_str()) {
        return Err(CobaltError::Conflict("cannot remove the active embedding model".into()));
    }
    if args.engine == Some(settings.vector_engine) {
        return Err(CobaltError::Conflict("cannot remove the active vector engine".into()));
    }
    state.engines.remove(args.engine, args.model_id.as_deref()).await
}

// ------------------------------------------------------------------ bridges

#[tauri::command]
pub async fn build_web_context(state: State<'_, AppState>, args: WebContextRequest) -> CmdResult<WebContext> {
    state.store().build_web_context(args).await
}

/// Quick note window: save and hide.
#[tauri::command]
pub async fn submit_quick_note(app: AppHandle, state: State<'_, AppState>, args: QuickNoteArgs) -> CmdResult<SaveOutcome> {
    let content = args.content.trim().to_owned();
    if content.is_empty() {
        return Err(CobaltError::InvalidInput("the note is empty".into()));
    }
    let outcome = state
        .daemon
        .save_from_user(
            NewMemory {
                content,
                category: MemoryCategory::Note,
                project_id: args.project_id,
                branch_id: None,
                source_doc_id: None,
                source_type: None,
                confidence: None,
                is_core_pin: false,
                is_reusable: false,
                reusable_snippet: None,
                source_client: None,
            },
            "cobalt-quicknote",
        )
        .await?;
    if let Some(w) = app.get_webview_window(crate::QUICKNOTE_WINDOW) {
        let _ = w.hide();
    }
    Ok(outcome)
}
