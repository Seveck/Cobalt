//! Tauri IPC command names and their small argument wrappers.
//!
//! Convention: every command takes **zero or one** parameter, always named `args`, so the
//! frontend calls `invoke(name, { args })` and no camelCase/snake_case conversion happens.
//! Results are `Result<T, CobaltError>`; errors arrive in JS as `ErrorPayload`.
//! The full command table (args -> result) is in `docs/CONTRACTS.md` and mirrored by
//! `IpcCommandMap` in `src/types/contracts.ts`.

use serde::{Deserialize, Serialize};

use crate::ids::Id;
use crate::model::{MemoryPatch, ProjectPatch};

pub mod commands {
    // App / hardware / settings / engines (Phase 1)
    pub const APP_INFO: &str = "app_info";
    pub const GET_SYSTEM_USER_NAME: &str = "get_system_user_name";
    pub const GET_HARDWARE_PROFILE: &str = "get_hardware_profile";
    pub const GET_SETTINGS: &str = "get_settings";
    pub const UPDATE_SETTINGS: &str = "update_settings";
    pub const LIST_EMBEDDING_MODELS: &str = "list_embedding_models";
    pub const INSTALL_ENGINE: &str = "install_engine";
    pub const CANCEL_DOWNLOAD: &str = "cancel_download";
    pub const GET_ENGINE_STATUS: &str = "get_engine_status";
    // OCR (v1.7.0)
    pub const GET_OCR_STATUS: &str = "get_ocr_status";
    pub const INSTALL_OCR: &str = "install_ocr";
    // OCR choice (v1.8.0)
    pub const LIST_OCR_MODELS: &str = "list_ocr_models";
    pub const REMOVE_OCR: &str = "remove_ocr";
    pub const VAULT_STATUS: &str = "vault_status";
    pub const VAULT_SETUP: &str = "vault_setup";
    pub const VAULT_UNLOCK: &str = "vault_unlock";
    pub const VAULT_LOCK: &str = "vault_lock";

    // Memories / graph / governance (Phase 2)
    pub const GET_GRAPH: &str = "get_graph";
    pub const GET_MEMORY: &str = "get_memory";
    pub const GET_MEMORY_HISTORY: &str = "get_memory_history";
    pub const SAVE_MEMORY: &str = "save_memory";
    pub const UPDATE_MEMORY: &str = "update_memory";
    pub const PATCH_MEMORY: &str = "patch_memory";
    pub const DELETE_MEMORY: &str = "delete_memory";
    pub const SET_MEMORY_ENCRYPTED: &str = "set_memory_encrypted";
    pub const REVEAL_MEMORY: &str = "reveal_memory";
    pub const SEARCH_MEMORIES: &str = "search_memories";
    pub const LIST_BRANCHES: &str = "list_branches";
    pub const CREATE_BRANCH: &str = "create_branch";
    pub const SWITCH_BRANCH: &str = "switch_branch";
    pub const MERGE_BRANCH: &str = "merge_branch";
    pub const DISCARD_BRANCH: &str = "discard_branch";
    pub const LIST_SNAPSHOTS: &str = "list_snapshots";
    pub const CREATE_SNAPSHOT: &str = "create_snapshot";
    pub const RESTORE_SNAPSHOT: &str = "restore_snapshot";
    pub const DELETE_SNAPSHOT: &str = "delete_snapshot";
    pub const FIND_DUPLICATES: &str = "find_duplicates";
    pub const MERGE_DUPLICATES: &str = "merge_duplicates";
    pub const ARCHIVE_MEMORIES: &str = "archive_memories";
    pub const RESTORE_MEMORIES: &str = "restore_memories";
    pub const GET_READ_ONLY: &str = "get_read_only";
    pub const SET_READ_ONLY: &str = "set_read_only";
    pub const GET_DAEMON_STATUS: &str = "get_daemon_status";
    pub const REPLAY_ACTIVITY: &str = "replay_activity";
    pub const GET_SOURCE_DOCUMENT: &str = "get_source_document";
    pub const GET_ARCHIVE_IMPACT: &str = "get_archive_impact";
    pub const GET_DELETION_IMPACT: &str = "get_deletion_impact";
    pub const VERIFY_SOURCE_DOCUMENT: &str = "verify_source_document";

    // Projects / library / telemetry / connectors / themes / transfer (Phase 3)
    pub const LIST_PROJECTS: &str = "list_projects";
    pub const CREATE_PROJECT: &str = "create_project";
    pub const UPDATE_PROJECT: &str = "update_project";
    pub const LIST_LIBRARY: &str = "list_library";
    pub const RELINK_SOURCE_DOCUMENT: &str = "relink_source_document";
    pub const SET_WATCHED: &str = "set_watched";
    pub const SET_PROJECT_WATCHED: &str = "set_project_watched";
    pub const PROMOTE_FILE_TO_REUSABLE: &str = "promote_file_to_reusable";
    pub const GET_TELEMETRY_SUMMARY: &str = "get_telemetry_summary";
    pub const QUERY_TELEMETRY: &str = "query_telemetry";
    pub const GET_USAGE_STATS: &str = "get_usage_stats";
    pub const LIST_CONNECTORS: &str = "list_connectors";
    pub const TOGGLE_CONNECTOR: &str = "toggle_connector";
    pub const LIST_CAPTURE_INTEGRATIONS: &str = "list_capture_integrations";
    pub const TOGGLE_CAPTURE_INTEGRATION: &str = "toggle_capture_integration";
    pub const RUN_DOCTOR: &str = "run_doctor";
    pub const DOCTOR_FIX: &str = "doctor_fix";
    pub const GET_MCP_TOOL_DOCS: &str = "get_mcp_tool_docs";
    pub const SEARCH_THEME_REGISTRY: &str = "search_theme_registry";
    pub const INSTALL_THEME: &str = "install_theme";
    pub const INSTALL_THEME_FILE: &str = "install_theme_file";
    pub const UNINSTALL_THEME: &str = "uninstall_theme";
    pub const LIST_INSTALLED_THEMES: &str = "list_installed_themes";
    pub const GET_THEME_MANIFEST: &str = "get_theme_manifest";
    pub const INGEST_PATHS: &str = "ingest_paths";
    pub const CANCEL_INGEST: &str = "cancel_ingest";
    pub const IMPORT_PAST_LIFE: &str = "import_past_life";
    pub const EXPORT_CAPSULE: &str = "export_capsule";
    pub const IMPORT_CAPSULE: &str = "import_capsule";
    pub const EXPORT_BACKUP: &str = "export_backup";
    pub const IMPORT_BACKUP: &str = "import_backup";
    pub const SWAP_ENGINE: &str = "swap_engine";
    pub const REMOVE_ENGINE_ARTIFACTS: &str = "remove_engine_artifacts";
    pub const BUILD_WEB_CONTEXT: &str = "build_web_context";
    pub const SUBMIT_QUICK_NOTE: &str = "submit_quick_note";
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub os: String,
    pub arch: String,
    pub contract_version: String,
    pub schema_version: u32,
    pub data_dir: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdArgs {
    pub id: Id,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdsArgs {
    pub ids: Vec<Id>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PathArgs {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThemeIdArgs {
    pub theme_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThemeSearchArgs {
    pub query: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CancelDownloadArgs {
    pub artifact_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VaultPasswordArgs {
    pub password: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PatchMemoryArgs {
    pub id: Id,
    pub patch: MemoryPatch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetMemoryEncryptedArgs {
    pub id: Id,
    pub encrypted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateSnapshotArgs {
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MergeDuplicatesArgs {
    pub keep_id: Id,
    pub merge_ids: Vec<Id>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetReadOnlyArgs {
    pub read_only: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListProjectsArgs {
    pub include_archived: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UpdateProjectArgs {
    pub id: Id,
    pub patch: ProjectPatch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelinkArgs {
    pub source_doc_id: Id,
    pub new_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetWatchedArgs {
    pub source_doc_id: Id,
    pub watched: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DoctorFixArgs {
    pub check_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoveEngineArtifactsArgs {
    pub engine: Option<crate::enums::EngineKind>,
    pub model_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuickNoteArgs {
    pub content: String,
    pub project_id: Option<Id>,
}

/// Docstring editor entry (Pro mode).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpToolDoc {
    pub name: String,
    pub default_description: String,
    pub override_description: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetProjectWatchedArgs {
    pub project_id: Id,
    pub watched: bool,
}
