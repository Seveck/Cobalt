import type { UnlistenFn } from "@tauri-apps/api/event";
import { call, on } from "@/lib/ipc";
import type { EventName, EventPayloadMap, IpcCommand, IpcCommandMap } from "@/types/contracts";

type ArgsOf<C extends IpcCommand> = IpcCommandMap[C]["args"];
type ResultOf<C extends IpcCommand> = IpcCommandMap[C]["result"];

/**
 * Typed backend command call — always routes to the real Tauri IPC (`src/lib/ipc.ts`).
 */
export function backendCall<C extends IpcCommand>(
  command: C,
  ...rest: ArgsOf<C> extends void ? [] : [args: ArgsOf<C>]
): Promise<ResultOf<C>> {
  return call(command, ...rest);
}

/**
 * Typed backend event subscription — always routes to real Tauri events (`src/lib/ipc.ts`).
 */
export function backendOn<E extends EventName>(
  event: E,
  handler: (payload: EventPayloadMap[E]) => void,
): Promise<UnlistenFn> {
  return on(event, handler);
}
