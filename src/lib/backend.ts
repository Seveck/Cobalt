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
 * (see `docs/CONTRACTS.md` §5).
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
]);

/** All commands currently routed to real Tauri IPC (Phases 0, 1 & 2). */
export const REAL_IPC_COMMANDS: ReadonlySet<IpcCommand> = new Set<IpcCommand>([
  ...PHASE1_REAL_COMMANDS,
  ...PHASE2_REAL_COMMANDS,
]);

/** Events emitted by the real Tauri backend in Phases 1 & 2. */
export const REAL_IPC_EVENTS: ReadonlySet<EventName> = new Set<EventName>([
  "cobalt://download-progress",
  "cobalt://vault-status",
  "cobalt://mcp-activity",
  "cobalt://memory-changed",
  "cobalt://read-only-changed",
  "cobalt://daemon-status",
]);

/** Returns `true` when the given command will be served by `backendMock`. */
export function isCommandMocked(command: IpcCommand): boolean {
  return !isTauri() || !REAL_IPC_COMMANDS.has(command);
}

/** Returns `true` when the given event stream comes from `backendMock`. */
export function isEventMocked(event: EventName): boolean {
  return !isTauri() || !REAL_IPC_EVENTS.has(event);
}

/** Returns `true` when running outside Tauri (all commands use `backendMock`). */
export function isGlobalMockMode(): boolean {
  return !isTauri();
}

/**
 * Unified typed backend call:
 * - Inside Tauri + Phase 0/1/2 command -> real `call()` from `src/lib/ipc.ts`
 * - Outside Tauri or Phase 3 command -> typed `callBackendMock()`
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
 * - Inside Tauri + Phase 1/2 event -> real `on()` from `src/lib/ipc.ts`
 * - Outside Tauri or Phase 3 event -> typed `onBackendMock()`
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
