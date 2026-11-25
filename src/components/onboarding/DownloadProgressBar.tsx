import { useTranslation } from "react-i18next";
import { AlertCircle, CheckCircle2, Loader2, X } from "lucide-react";
import { formatBytes, formatPercent } from "@/lib/format";
import type { DownloadProgress } from "@/types/contracts";

interface DownloadProgressBarProps {
  progress: DownloadProgress | null;
  isInstalling: boolean;
  isCancelling: boolean;
  error: string | null;
  onCancel: () => void;
}

export function DownloadProgressBar({
  progress,
  isInstalling,
  isCancelling,
  error,
  onCancel,
}: DownloadProgressBarProps) {
  const { t } = useTranslation();

  if (!progress && !isInstalling && !error) {
    return null;
  }

  const phase = progress?.phase ?? (isInstalling ? "queued" : "failed");
  const percent = progress
    ? phase === "completed" || phase === "verifying" || phase === "extracting"
      ? 100
      : formatPercent(progress.downloaded_bytes, progress.total_bytes)
    : 0;

  const isError = phase === "failed" || phase === "cancelled" || (!isInstalling && error !== null);
  const isDone = phase === "completed" && !isError;
  const canCancel =
    isInstalling &&
    phase !== "completed" &&
    phase !== "failed" &&
    phase !== "cancelled";

  return (
    <div
      className={`rounded-xl border p-4 ${
        isError
          ? "border-red-500/35 bg-red-950/25"
          : isDone
            ? "border-emerald-500/35 bg-emerald-950/20"
            : "border-cobalt-500/35 bg-cobalt-900/40"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-100">
          {isError ? (
            <AlertCircle size={16} className="shrink-0 text-red-400" aria-hidden />
          ) : isDone ? (
            <CheckCircle2 size={16} className="shrink-0 text-emerald-400" aria-hidden />
          ) : (
            <Loader2 size={16} className="shrink-0 animate-spin text-cobalt-300" aria-hidden />
          )}
          <span>{t(`onboarding.download.${phase}`)}</span>
          {progress && progress.attempt > 1 && (
            <span className="rounded bg-white/10 px-1.5 py-0.5 text-[11px] text-slate-300">
              {t("onboarding.download.attempt", { attempt: progress.attempt })}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-slate-300">{percent}%</span>
          {canCancel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={isCancelling}
              className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 py-1 text-xs text-slate-200 transition hover:bg-white/10 disabled:opacity-50"
            >
              <X size={12} aria-hidden />
              {isCancelling ? t("onboarding.download.cancelling") : t("onboarding.download.cancel")}
            </button>
          )}
        </div>
      </div>

      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className={`h-full rounded-full transition-all duration-200 ${
            isError ? "bg-red-500" : isDone ? "bg-emerald-500" : "bg-cobalt-500"
          }`}
          style={{ width: `${percent}%` }}
        />
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
        <span className="font-mono">
          {progress
            ? progress.total_bytes !== null
              ? `${formatBytes(progress.downloaded_bytes)} / ${formatBytes(progress.total_bytes)}`
              : formatBytes(progress.downloaded_bytes)
            : "0 B"}
        </span>
        {progress?.artifact_id && (
          <span className="truncate font-mono text-[11px] text-slate-500">
            {progress.artifact_id}
          </span>
        )}
      </div>

      {(error || progress?.message) && (
        <p className={`mt-2 text-xs ${isError ? "text-red-300" : "text-slate-400"}`}>
          {error ?? progress?.message}
        </p>
      )}
    </div>
  );
}
