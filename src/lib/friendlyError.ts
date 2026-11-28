import type { TFunction } from "i18next";
import i18n from "@/i18n";
import { IpcError } from "@/lib/ipc";
import type { ErrorKind, ErrorPayload, IpcCommand } from "@/types/contracts";

/**
 * Structured error ready for UI rendering:
 * - `message` is always a plain-language sentence for non-programmers.
 * - `details` holds raw backend text and must ONLY be rendered inside a collapsed
 *   "Ver detalles técnicos" disclosure.
 */
export interface DisplayError {
  readonly message: string;
  readonly details: string | null;
  readonly kind?: ErrorKind;
  readonly command?: IpcCommand;
}

export type FriendlyErrorContext =
  | IpcCommand
  | {
      command?: IpcCommand;
      domain?: string;
    };

const VALID_ERROR_KINDS: ReadonlySet<string> = new Set<ErrorKind>([
  "not_found",
  "invalid_input",
  "conflict",
  "read_only",
  "firewall_blocked",
  "vault_locked",
  "crypto",
  "storage",
  "engine",
  "embedding",
  "download",
  "integrity",
  "sandbox",
  "daemon",
  "io",
  "serialization",
  "cancelled",
  "unsupported",
  "internal",
  "permission_denied",
]);

const KIND_PREFIX_RE =
  /^(not_found|invalid_input|conflict|read_only|firewall_blocked|vault_locked|crypto|storage|engine|embedding|download|integrity|sandbox|daemon|io|serialization|cancelled|unsupported|internal|permission_denied)\s*:/i;

const OCR_NOT_INSTALLED_RE = /ocr is not installed/i;

export function isDisplayError(value: unknown): value is DisplayError {
  return (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof (value as { message: unknown }).message === "string" &&
    "details" in value
  );
}

function isErrorPayloadLike(value: unknown): value is ErrorPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "message" in value &&
    typeof (value as { kind: unknown }).kind === "string" &&
    VALID_ERROR_KINDS.has((value as { kind: string }).kind) &&
    typeof (value as { message: unknown }).message === "string"
  );
}

function resolveCommandFromContext(context?: FriendlyErrorContext): IpcCommand | undefined {
  if (!context) return undefined;
  return typeof context === "string" ? context : context.command;
}

function inferKindFromRawText(raw: string): ErrorKind {
  const trimmed = raw.trim();
  if (!trimmed) return "internal";

  const prefixMatch = KIND_PREFIX_RE.exec(trimmed);
  if (prefixMatch?.[1]) {
    const candidate = prefixMatch[1].toLowerCase();
    if (VALID_ERROR_KINDS.has(candidate)) {
      return candidate as ErrorKind;
    }
  }

  const lower = trimmed.toLowerCase();
  if (/\bunsupported\b|not supported|not implemented/.test(lower)) return "unsupported";
  if (/vault_locked|vault is locked/.test(lower)) return "vault_locked";
  if (/read_only|read-only|readonly/.test(lower)) return "read_only";
  if (/permission_denied|permission denied|\beacces\b|\beperm\b/.test(lower)) {
    return "permission_denied";
  }
  if (/firewall_blocked|rate limit|too many (writes|reads)/.test(lower)) {
    return "firewall_blocked";
  }
  if (/unique constraint|already exists|\bconflict\b/.test(lower)) return "conflict";
  if (/\bnot found\b|\benoent\b|no such file|does not exist/.test(lower)) return "not_found";
  if (/\bcancel(l)?ed\b/.test(lower)) return "cancelled";
  if (/invalid|must differ|cannot be empty|malformed/.test(lower)) return "invalid_input";
  if (/decrypt|wrong password|bad password|invalid password|cipher|aead/.test(lower)) {
    return "crypto";
  }
  if (/checksum|sha256|corrupt|integrity/.test(lower)) return "integrity";
  if (/download|timed out|timeout|network|dns|connection refused|http \d{3}/.test(lower)) {
    return "download";
  }
  if (/sqlite|database is locked|disk i\/o/.test(lower)) return "storage";
  if (/serialize|deserialize|json|toml|parse error/.test(lower)) return "serialization";
  if (/daemon|sidecar/.test(lower)) return "daemon";
  if (/embedding|onnx|tokenizer/.test(lower)) return "embedding";

  return "internal";
}

/** Extract raw technical text from an error for the collapsed technical details section. */
export function extractErrorDetails(err: unknown): string | null {
  if (err == null) return null;
  if (isDisplayError(err)) {
    return err.details;
  }
  if (err instanceof IpcError) {
    const msg = err.message.trim();
    const alreadyPrefixed = KIND_PREFIX_RE.test(msg);
    const body = alreadyPrefixed ? msg : `${err.kind}: ${msg}`;
    return `[${err.command}] ${body}`.trim();
  }
  if (isErrorPayloadLike(err)) {
    const msg = err.message.trim();
    return KIND_PREFIX_RE.test(msg) ? msg : `${err.kind}: ${msg}`;
  }
  if (err instanceof Error) {
    const msg = err.message.trim();
    return msg || err.name || null;
  }
  if (typeof err === "string") {
    const trimmed = err.trim();
    return trimmed || null;
  }
  try {
    const text = String(err).trim();
    return text || null;
  } catch {
    return null;
  }
}

function extractMeta(
  err: unknown,
  context?: FriendlyErrorContext,
): {
  kind: ErrorKind;
  command: IpcCommand | undefined;
  rawMessage: string;
} {
  const ctxCommand = resolveCommandFromContext(context);

  if (err instanceof IpcError) {
    return {
      kind: err.kind,
      command: ctxCommand ?? err.command,
      rawMessage: err.message,
    };
  }
  if (isErrorPayloadLike(err)) {
    return {
      kind: err.kind,
      command: ctxCommand,
      rawMessage: err.message,
    };
  }
  if (isDisplayError(err)) {
    const raw = err.details ?? err.message;
    return {
      kind: err.kind ?? inferKindFromRawText(raw),
      command: ctxCommand ?? err.command,
      rawMessage: raw,
    };
  }
  const rawMessage =
    err instanceof Error ? err.message : typeof err === "string" ? err : String(err ?? "");
  return {
    kind: inferKindFromRawText(rawMessage),
    command: ctxCommand,
    rawMessage,
  };
}

/**
 * Convert any backend/runtime error into a plain-language localized sentence suitable
 * for non-programmers. Never exposes raw SQLite, Rust, or IPC error strings directly.
 */
export function friendlyError(
  err: unknown,
  t: TFunction,
  context?: FriendlyErrorContext,
): string {
  if (isDisplayError(err)) {
    return err.message;
  }

  const { kind, command, rawMessage } = extractMeta(err, context);

  // Special case: missing local OCR engine
  if (OCR_NOT_INSTALLED_RE.test(rawMessage)) {
    return t("errors.overrides.ocrNotInstalled");
  }

  // Command-specific plain-language overrides
  if (command === "create_project") {
    if (kind === "conflict") {
      return t("errors.overrides.createProjectConflict");
    }
    if (kind === "invalid_input") {
      return t("errors.overrides.createProjectInvalidInput");
    }
  }

  if (command === "update_project" && kind === "conflict") {
    return t("errors.overrides.updateProjectConflict");
  }

  if (command === "delete_project") {
    if (kind === "not_found") {
      return t("errors.overrides.deleteProjectNotFound");
    }
    if (kind === "invalid_input") {
      return t("errors.overrides.deleteProjectInvalidInput");
    }
  }

  if (command === "create_branch" && kind === "conflict") {
    return t("errors.overrides.createBranchConflict");
  }

  if ((command === "vault_unlock" || command === "vault_setup") && kind === "crypto") {
    return t("errors.overrides.vaultWrongPassword");
  }

  if (command === "import_backup" && kind === "crypto") {
    return t("errors.overrides.backupWrongPassword");
  }

  if (
    (command === "toggle_connector" || command === "toggle_capture_integration") &&
    (kind === "permission_denied" || kind === "io")
  ) {
    return t("errors.overrides.connectorWriteFailed");
  }

  if (
    (command === "install_engine" ||
      command === "install_ocr" ||
      command === "install_theme" ||
      command === "search_theme_registry") &&
    (kind === "download" || kind === "io")
  ) {
    return t("errors.kinds.download");
  }

  // Domain-specific fallback when command wasn't provided
  const domain = typeof context === "object" ? context?.domain : undefined;
  if (domain === "folder" && kind === "conflict") {
    return t("errors.overrides.createProjectConflict");
  }

  return t(`errors.kinds.${kind}`);
}

/** Build a `DisplayError` combining a friendly sentence with collapsed raw technical details. */
export function toDisplayError(
  err: unknown,
  t: TFunction,
  context?: FriendlyErrorContext,
): DisplayError {
  if (isDisplayError(err)) {
    return err;
  }
  const { kind, command } = extractMeta(err, context);
  const message = friendlyError(err, t, context);
  const details = extractErrorDetails(err);
  return {
    message,
    details,
    kind,
    command,
  };
}

/** Store-friendly helper using the shared `i18n` instance outside React components. */
export function toStoreDisplayError(
  err: unknown,
  context?: FriendlyErrorContext,
): DisplayError {
  return toDisplayError(err, i18n.t.bind(i18n), context);
}

/** Return the plain-language sentence from either a `DisplayError` or plain string. */
export function getErrorSummary(err: DisplayError | string | null | undefined): string {
  if (!err) return "";
  return typeof err === "string" ? err : err.message;
}

/** Test a regex against both the friendly message and raw technical details of an error. */
export function errorMatchesPattern(
  err: DisplayError | string | null | undefined,
  pattern: RegExp,
): boolean {
  if (!err) return false;
  if (typeof err === "string") return pattern.test(err);
  return pattern.test(err.message) || Boolean(err.details && pattern.test(err.details));
}
