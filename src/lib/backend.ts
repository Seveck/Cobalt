import type { UnlistenFn } from "@tauri-apps/api/event";
import { call, isTauri, on } from "@/lib/ipc";
import { callBackendMock, onBackendMock } from "@/lib/backendMock";
import type { EventName, EventPayloadMap, IpcCommand, IpcCommandMap } from "@/types/contracts";

type ArgsOf<C extends IpcCommand> = IpcCommandMap[C]["args"];
type ResultOf<C extends IpcCommand> = IpcCommandMap[C]["result"];

/**
 * Phase 1 commands wired to the real Rust/Tauri backend when running inside Tauri.
 * Every other command (e.g. `get_graph`, `list_branches`, `list_library`, ...)
 * routes through `src/lib/backendMock.ts` until Phases 2 & 3 land.
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
]);

/** Phase 1 events emitted by the real Tauri backend. */
export const PHASE1_REAL_EVENTS: ReadonlySet<EventName> = new Set<EventName>([
  "cobalt://download-progress",
]);

/** Returns `true` when the given command will be served by `backendMock`. */
export function isCommandMocked(command: IpcCommand): boolean {
  return !isTauri() || !PHASE1_REAL_COMMANDS.has(command);
}

/** Returns `true` when the given event stream comes from `backendMock`. */
export function isEventMocked(event: EventName): boolean {
  return !isTauri() || !PHASE1_REAL_EVENTS.has(event);
}

/** Returns `true` when running outside Tauri (all commands use `backendMock`). */
export function isGlobalMockMode(): boolean {
  return !isTauri();
}

/**
 * Unified typed backend call:
 * - Inside Tauri + Phase 1 command -> real `call()` from `src/lib/ipc.ts`
 * - Outside Tauri or Phase 2/3 command -> typed `callBackendMock()`
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
 * - Inside Tauri + Phase 1 event -> real `on()` from `src/lib/ipc.ts`
 * - Outside Tauri or Phase 2/3 event -> typed `onBackendMock()`
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
