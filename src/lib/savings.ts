import type { ClientPermission, SavingsSettings } from "@/types/contracts";

export const QUICKNOTE_CONFLICTS_STORAGE_KEY = "cobalt.quicknoteConflicts";
export const QUICKNOTE_INSPECT_STORAGE_KEY = "cobalt.quicknoteInspectMemory";

/** Normalize an AI client identifier for tolerant lookup across hyphen/underscore variants. */
export function normalizeClientKey(client: string): string {
  return client.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/**
 * Returns `true` for internal Cobalt or VCS client names that should be excluded from
 * per-AI permission and pricing lists (e.g. `cobalt-ingest`, `cobalt_ui`, `git`).
 */
export function isInternalClient(client: string): boolean {
  const norm = normalizeClientKey(client);
  return (
    norm.length === 0 ||
    norm === "git" ||
    norm === "cobalt" ||
    norm.startsWith("cobalt_") ||
    norm === "quicknote" ||
    norm === "quick_note" ||
    norm === "system" ||
    norm === "internal"
  );
}

/** Resolve the effective permission for a client (`read_write` when absent). */
export function resolveClientPermission(
  permissions: Record<string, ClientPermission> | undefined,
  clientKey: string,
): ClientPermission {
  if (!permissions) return "read_write";
  const exact = permissions[clientKey];
  if (exact) return exact;
  const targetNorm = normalizeClientKey(clientKey);
  for (const [key, value] of Object.entries(permissions)) {
    if (normalizeClientKey(key) === targetNorm) {
      return value;
    }
  }
  return "read_write";
}

/** Resolve USD per 1M tokens for an optional client, falling back to the global price. */
export function resolvePricePerMillion(
  savings: SavingsSettings | undefined,
  clientName?: string | null,
): number {
  const globalPrice =
    savings && Number.isFinite(savings.usd_per_million_tokens) && savings.usd_per_million_tokens >= 0
      ? savings.usd_per_million_tokens
      : 3;

  if (!savings || !clientName) {
    return globalPrice;
  }

  const prices = savings.client_prices ?? {};
  const exact = prices[clientName];
  if (typeof exact === "number" && Number.isFinite(exact) && exact >= 0) {
    return exact;
  }

  const targetNorm = normalizeClientKey(clientName);
  for (const [key, value] of Object.entries(prices)) {
    if (
      normalizeClientKey(key) === targetNorm &&
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0
    ) {
      return value;
    }
  }

  return globalPrice;
}

/** Compute estimated USD saved for a token count (optionally using per-client pricing). */
export function calculateSavingsUsd(
  tokens: number,
  savings: SavingsSettings | undefined,
  clientName?: string | null,
): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  const pricePerMillion = resolvePricePerMillion(savings, clientName);
  return (tokens / 1_000_000) * pricePerMillion;
}

/** Compute estimated seconds saved for a token count (`tokens / tokens_per_second`). */
export function calculateSavingsSeconds(
  tokens: number,
  savings: SavingsSettings | undefined,
): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  const tps =
    savings && Number.isFinite(savings.tokens_per_second) && savings.tokens_per_second > 0
      ? savings.tokens_per_second
      : 1000;
  return tokens / tps;
}

/** Format a USD estimate cleanly across sub-cent, dollar, and thousand-dollar scales. */
export function formatUsdEstimate(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 0.001) return "<$0.01";
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  if (usd < 1000) return `$${usd.toFixed(1)}`;
  return `$${Math.round(usd).toLocaleString("en-US")}`;
}

/** Humanize a duration in seconds (e.g. `14 s`, `3 min 20 s`, `2 h 15 min`, `1 d 4 h`). */
export function formatDurationHuman(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0 s";
  if (seconds < 1) return "< 1 s";
  if (seconds < 60) {
    return `${Math.round(seconds)} s`;
  }
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const remSec = Math.round(seconds % 60);
    if (remSec === 60) return `${mins + 1} min`;
    if (mins < 5 && remSec > 0) return `${mins} min ${remSec} s`;
    return `${Math.round(seconds / 60)} min`;
  }
  if (seconds < 86_400) {
    const hours = Math.floor(seconds / 3600);
    const remMin = Math.round((seconds % 3600) / 60);
    if (remMin === 60) return `${hours + 1} h`;
    if (remMin > 0) return `${hours} h ${remMin} min`;
    return `${hours} h`;
  }
  const days = Math.floor(seconds / 86_400);
  const remHours = Math.round((seconds % 86_400) / 3600);
  if (remHours === 24) return `${days + 1} d`;
  if (remHours > 0) return `${days} d ${remHours} h`;
  return `${days} d`;
}

export interface FormattedSavings {
  usd: string;
  time: string;
  approxUsd: string;
  approxTime: string;
  combined: string;
}

/** Format saved tokens into estimated money (`≈ $X`) and time (`≈ Y`). */
export function formatSavingsEstimate(
  tokens: number,
  savings: SavingsSettings | undefined,
  clientName?: string | null,
): FormattedSavings {
  const usd = formatUsdEstimate(calculateSavingsUsd(tokens, savings, clientName));
  const time = formatDurationHuman(calculateSavingsSeconds(tokens, savings));
  const approxUsd = `≈ ${usd}`;
  const approxTime = `≈ ${time}`;
  return {
    usd,
    time,
    approxUsd,
    approxTime,
    combined: `${approxUsd} · ${approxTime}`,
  };
}

/** Known contradiction reason keys from contract v1.15.0. */
export const KNOWN_CONFLICT_REASONS = [
  "negation",
  "different_value",
  "opposite_choice",
] as const;
export type KnownConflictReason = (typeof KNOWN_CONFLICT_REASONS)[number];

/** Resolve a contradiction reason string to its i18n key when known, otherwise `null`. */
export function conflictReasonI18nKey(reason: string): string | null {
  const normalized = reason.trim().toLowerCase();
  if ((KNOWN_CONFLICT_REASONS as readonly string[]).includes(normalized)) {
    return `cleanBrain.conflictReasons.${normalized}`;
  }
  return null;
}
