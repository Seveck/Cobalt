import type { UnlistenFn } from "@tauri-apps/api/event";
import { call, isTauri, on } from "@/lib/ipc";
import { callBackendMock, onBackendMock } from "@/lib/backendMock";
import type { EventName, EventPayloadMap, IpcCommand, IpcCommandMap } from "@/types/contracts";

type ArgsOf<C extends IpcCommand> = IpcCommandMap[C]["args"];
type ResultOf<C extends IpcCommand> = IpcCommandMap[C]["result"];

/**
 * Phase 0/1 commands wired to the real Rust/Tauri backend inside Tauri.
 */
export const PHASE1_REAL_COMMANDS: ReadonlySet<IpcCommand> = new Set<IpcCommand>([
  "app_info",
  "get_hardware_profile",
  "get_settings",
  "update_settings",
  "list_embedding_models",
  "install_engine",
  "cancel_download",
  "get_engine_status",
  "vault_status",
  "vault_setup",
  "vault_unlock",
  "vault_lock",
]);

/**
 * Phase 2 commands wired to the real Rust/Tauri backend inside Tauri
 * (see `docs/CONTRACTS.md` §5, v1.2.0).
 */
export const PHASE2_REAL_COMMANDS: ReadonlySet<IpcCommand> = new Set<IpcCommand>([
  "get_graph",
  "get_memory",
  "get_memory_history",
  "save_memory",
  "update_memory",
  "patch_memory",
  "delete_memory",
  "set_memory_encrypted",
  "reveal_memory",
  "search_memories",
  "list_branches",
  "create_branch",
  "switch_branch",
  "merge_branch",
  "discard_branch",
  "list_snapshots",
  "create_snapshot",
  "restore_snapshot",
  "delete_snapshot",
  "find_duplicates",
  "merge_duplicates",
  "archive_memories",
  "restore_memories",
  "get_read_only",
  "set_read_only",
  "get_daemon_status",
  "replay_activity",
  "get_source_document",
  "verify_source_document",
]);

/**
 * Phase 3 commands wired to the real Rust/Tauri backend inside Tauri
 * (see `docs/CONTRACTS.md` §5, v1.3.0).
 */
export const PHASE3_REAL_COMMANDS: ReadonlySet<IpcCommand> = new Set<IpcCommand>([
  "get_archive_impact",
  "list_projects",
  "create_project",
  "update_project",
  "list_library",
  "relink_source_document",
  "set_watched",
  "promote_file_to_reusable",
  "get_telemetry_summary",
  "query_telemetry",
  "list_connectors",
  "toggle_connector",
  "run_doctor",
  "doctor_fix",
  "get_mcp_tool_docs",
  "search_theme_registry",
  "install_theme",
  "install_theme_file",
  "uninstall_theme",
  "list_installed_themes",
  "get_theme_manifest",
  "ingest_paths",
  "import_past_life",
  "export_capsule",
  "import_capsule",
  "export_backup",
  "import_backup",
  "swap_engine",
  "remove_engine_artifacts",
  "build_web_context",
  "submit_quick_note",
]);

/** All commands routed to real Tauri IPC (Phases 0, 1, 2 & 3 — 100% of CONTRACTS §5). */
export const REAL_IPC_COMMANDS: ReadonlySet<IpcCommand> = new Set<IpcCommand>([
  ...PHASE1_REAL_COMMANDS,
  ...PHASE2_REAL_COMMANDS,
  ...PHASE3_REAL_COMMANDS,
]);

/** All events emitted by the real Tauri backend (CONTRACTS §4). */
export const REAL_IPC_EVENTS: ReadonlySet<EventName> = new Set<EventName>([
  "cobalt://mcp-activity",
  "cobalt://memory-changed",
  "cobalt://download-progress",
  "cobalt://engine-swap-progress",
  "cobalt://ingest-progress",
  "cobalt://read-only-changed",
  "cobalt://vault-status",
  "cobalt://daemon-status",
]);

/** Returns `true` only in browser preview (outside Tauri); inside Tauri all commands use real IPC. */
export function isCommandMocked(command: IpcCommand): boolean {
  return !isTauri() || !REAL_IPC_COMMANDS.has(command);
}

/** Returns `true` only in browser preview (outside Tauri); inside Tauri all events are real. */
export function isEventMocked(event: EventName): boolean {
  return !isTauri() || !REAL_IPC_EVENTS.has(event);
}

/** Returns `true` when running outside Tauri (browser preview mode). */
export function isGlobalMockMode(): boolean {
  return !isTauri();
}

/**
 * Unified typed backend call:
 * - Inside Tauri -> real `call()` from `src/lib/ipc.ts` for every command in CONTRACTS §5
 * - Outside Tauri (browser preview) -> typed `callBackendMock()`
 */
export function backendCall<C extends IpcCommand>(
  command: C,
  ...rest: ArgsOf<C> extends void ? [] : [args: ArgsOf<C>]
): Promise<ResultOf<C>> {
  if (!isCommandMocked(command)) {
    return call(command, ...rest);
  }
  return callBackendMock(command, ...rest);
}

/**
 * Unified typed backend event subscription:
 * - Inside Tauri -> real `on()` from `src/lib/ipc.ts`
 * - Outside Tauri (browser preview) -> typed `onBackendMock()`
 */
export function backendOn<E extends EventName>(
  event: E,
  handler: (payload: EventPayloadMap[E]) => void,
): Promise<UnlistenFn> {
  if (!isEventMocked(event)) {
    return on(event, handler);
  }
  return onBackendMock(event, handler);
}
