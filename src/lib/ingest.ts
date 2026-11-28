import type { TFunction } from "i18next";
import { errorMatchesPattern, type DisplayError } from "@/lib/friendlyError";
import { INGEST_STAGES, type IngestIssue, type IngestReport } from "@/types/contracts";

export type IngestStageKey =
  | "starting"
  | "queued"
  | "scanning"
  | "reading"
  | "parsing"
  | "chunking"
  | "ocr"
  | "redacting"
  | "embedding"
  | "indexing"
  | "saving"
  | "importing"
  | "pausing"
  | "paused"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed";

export type SkipReasonCategory = "ignored" | "binary" | "too_large" | "unsupported" | "other";

export interface AnalyzedIngestReport {
  documentsCreated: number;
  documentsUpdated: number;
  documentsUnchanged: number;
  memoriesCreated: number;
  memoriesSuperseded: number;
  skippedCount: number;
  redactedSecrets: number;
  totalTokens: number;
  skipIssues: IngestIssue[];
  errorIssues: IngestIssue[];
  skipReasonCategories: SkipReasonCategory[];
  hasOcrNotInstalledError: boolean;
}

const OCR_NOT_INSTALLED_PATTERN = /ocr is not installed/i;

const SKIP_ISSUE_PATTERN =
  /\b(skip|skipped|omit|omitted|ignor|ignored|binary|binario|too large|exceeds|2\s*mib|2\s*mb|size limit|unsupported|no soportado)\b/i;

/** Returns true when a backend error or ingest issue indicates the local OCR model is missing. */
export function isOcrNotInstalledMessage(
  message: DisplayError | string | null | undefined,
): boolean {
  return errorMatchesPattern(message, OCR_NOT_INSTALLED_PATTERN);
}

/** Returns true when an `IngestReport` contains any issue reporting OCR is not installed. */
export function reportHasOcrNotInstalledError(report: IngestReport | null | undefined): boolean {
  if (!report) return false;
  return report.errors.some((issue) => isOcrNotInstalledMessage(issue.message));
}

/** Extract just the filename from a Unix or Windows path. */
export function extractFileName(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  const trimmed = filePath.replace(/[\\/]+$/, "");
  if (!trimmed) return filePath;
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

/** Format an elapsed duration in milliseconds as concise human time (`14s`, `2m 05s`, `1h 04m`). */
export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** Format backend `eta_seconds` as plain-language remaining time (e.g. `quedan ~3 min` / `~3 min left`). */
export function formatIngestEta(
  etaSeconds: number | null | undefined,
  t: TFunction,
): string | null {
  if (etaSeconds == null || !Number.isFinite(etaSeconds) || etaSeconds <= 0) {
    return null;
  }
  if (etaSeconds < 60) {
    return t("ingest.etaLessThanMin");
  }
  if (etaSeconds < 3600) {
    const minutes = Math.max(1, Math.round(etaSeconds / 60));
    return t("ingest.etaMinutes", { count: minutes });
  }
  const hours = Math.floor(etaSeconds / 3600);
  const minutes = Math.round((etaSeconds % 3600) / 60);
  if (minutes === 0) {
    return t("ingest.etaHours", { hours });
  }
  return t("ingest.etaHoursMinutes", { hours, minutes });
}

/** Map a raw backend `IngestProgress.stage` string to a known i18n stage key. */
export function resolveIngestStageKey(stage: string): IngestStageKey | null {
  const raw = stage.trim().toLowerCase();
  if (!raw) return null;

  if (raw === INGEST_STAGES.scanning) return "scanning";
  if (raw === INGEST_STAGES.reading) return "reading";
  if (raw === INGEST_STAGES.embedding) return "embedding";
  if (raw === INGEST_STAGES.saving) return "saving";
  if (raw === INGEST_STAGES.completed) return "completed";
  if (raw === INGEST_STAGES.cancelled) return "cancelled";
  if (raw === INGEST_STAGES.failed) return "failed";

  if (raw === "starting" || raw === "init" || raw === "initializing" || raw === "preparing") {
    return "starting";
  }
  if (raw === "queued" || raw === "pending") return "queued";
  if (raw.startsWith("scan") || raw.startsWith("walk") || raw.startsWith("discover") || raw.startsWith("collect")) {
    return "scanning";
  }
  if (raw.startsWith("read") || raw.startsWith("load") || raw.startsWith("extract")) {
    return "reading";
  }
  if (raw.startsWith("pars")) return "parsing";
  if (raw.startsWith("chunk") || raw.startsWith("split")) return "chunking";
  if (raw === "ocr" || raw.includes("ocr")) return "ocr";
  if (raw.startsWith("redact") || raw.startsWith("sanitiz")) return "redacting";
  if (raw.startsWith("embed") || raw.startsWith("vector")) return "embedding";
  if (raw.startsWith("index")) return "indexing";
  if (raw.startsWith("sav") || raw.startsWith("stor") || raw.startsWith("writ") || raw.startsWith("commit")) {
    return "saving";
  }
  if (raw.startsWith("import")) return "importing";
  if (raw === "pausing") return "pausing";
  if (raw === "paused") return "paused";
  if (raw === "cancelling" || raw === "canceling" || raw === "stopping") return "cancelling";
  if (raw === "cancelled" || raw === "canceled" || raw === "stopped" || raw === "aborted") {
    return "cancelled";
  }
  if (raw === "completed" || raw === "complete" || raw === "done" || raw === "finished") {
    return "completed";
  }
  if (raw === "failed" || raw === "error") return "failed";

  return null;
}

/** Detect whether a backend stage string signals a terminal job state (`INGEST_STAGES`). */
export function isTerminalIngestStage(stage: string): "completed" | "cancelled" | "failed" | null {
  const key = resolveIngestStageKey(stage);
  if (key === INGEST_STAGES.completed) return "completed";
  if (key === INGEST_STAGES.cancelled) return "cancelled";
  if (key === INGEST_STAGES.failed) return "failed";
  return null;
}

/** Translate a backend ingest stage string into plain, non-technical language. */
export function formatIngestStage(stage: string, t: TFunction): string {
  const key = resolveIngestStageKey(stage);
  if (key) {
    return t(`ingest.stages.${key}`);
  }
  const cleaned = stage.trim().replace(/[_-]+/g, " ");
  if (!cleaned) {
    return t("ingest.stages.indexing");
  }
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function classifySkipReason(message: string): SkipReasonCategory {
  const lower = message.toLowerCase();
  if (/binary|binario|non-text|nul byte|null byte/.test(lower)) return "binary";
  if (/2\s*mib|2\s*mb|too large|exceeds|size limit|demasiado grande|muy grande/.test(lower)) {
    return "too_large";
  }
  if (/memoryignore|gitignore|ignor/.test(lower)) return "ignored";
  if (/unsupported|no soportado|extension/.test(lower)) return "unsupported";
  return "other";
}

/**
 * Inspect an `IngestReport` to separate skip-reason notices from hard errors and
 * surface plain-language skip categories without dropping any backend issue.
 */
export function analyzeIngestReport(report: IngestReport): AnalyzedIngestReport {
  const skipIssues: IngestIssue[] = [];
  const errorIssues: IngestIssue[] = [];
  const reasonSet = new Set<SkipReasonCategory>();
  let hasOcrNotInstalledError = false;

  for (const issue of report.errors) {
    if (isOcrNotInstalledMessage(issue.message)) {
      hasOcrNotInstalledError = true;
      errorIssues.push(issue);
    } else if (SKIP_ISSUE_PATTERN.test(issue.message)) {
      skipIssues.push(issue);
      reasonSet.add(classifySkipReason(issue.message));
    } else {
      errorIssues.push(issue);
    }
  }

  const skippedCount = Math.max(report.skipped_ignored, skipIssues.length);
  if (report.skipped_ignored > skipIssues.length && reasonSet.size === 0) {
    reasonSet.add("ignored");
  }

  return {
    documentsCreated: report.documents_created,
    documentsUpdated: report.documents_updated,
    documentsUnchanged: report.documents_unchanged,
    memoriesCreated: report.memories_created,
    memoriesSuperseded: report.memories_superseded,
    skippedCount,
    redactedSecrets: report.redacted_secrets,
    totalTokens: report.total_tokens,
    skipIssues,
    errorIssues,
    skipReasonCategories: [...reasonSet],
    hasOcrNotInstalledError,
  };
}
