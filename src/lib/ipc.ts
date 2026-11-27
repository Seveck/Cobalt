import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  ErrorPayload,
  EventName,
  EventPayloadMap,
  IpcCommand,
  IpcCommandMap,
} from "@/types/contracts";

type ArgsOf<C extends IpcCommand> = IpcCommandMap[C]["args"];
type ResultOf<C extends IpcCommand> = IpcCommandMap[C]["result"];

/** Rejection type of every typed IPC call. */
export class IpcError extends Error {
  readonly kind: ErrorPayload["kind"];
  readonly command: IpcCommand;

  constructor(command: IpcCommand, payload: ErrorPayload) {
    super(payload.message);
    this.name = "IpcError";
    this.kind = payload.kind;
    this.command = command;
  }
}

function toErrorPayload(raw: unknown): ErrorPayload {
  if (raw && typeof raw === "object" && "kind" in raw && "message" in raw) {
    return raw as ErrorPayload;
  }
  return { kind: "internal", message: typeof raw === "string" ? raw : String(raw) };
}

/**
 * Typed `invoke`: commands take zero or one parameter, always named `args`
 * (see `cobalt_core::ipc`). Commands whose args are `void` are called without payload.
 */
export async function call<C extends IpcCommand>(
  command: C,
  ...rest: ArgsOf<C> extends void ? [] : [args: ArgsOf<C>]
): Promise<ResultOf<C>> {
  const payload = rest.length > 0 ? { args: rest[0] } : undefined;
  try {
    return await invoke<ResultOf<C>>(command, payload);
  } catch (raw) {
    throw new IpcError(command, toErrorPayload(raw));
  }
}

/** Typed listener for `cobalt://*` events. Returns the unlisten function. */
export function on<E extends EventName>(
  event: E,
  handler: (payload: EventPayloadMap[E]) => void,
): Promise<UnlistenFn> {
  return listen<EventPayloadMap[E]>(event, (e) => handler(e.payload));
}

/** `true` when running inside the Tauri webview (false in a plain browser / Vite preview). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Detect an IPC `"unsupported"` error (e.g. while backend storage is landing). */
export function isUnsupportedError(err: unknown): boolean {
  if (err instanceof IpcError && err.kind === "unsupported") {
    return true;
  }
  if (err instanceof Error && /\bunsupported\b/i.test(err.message)) {
    return true;
  }
  return false;
}
