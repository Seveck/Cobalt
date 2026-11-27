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

  if (!progress && !isInstalling && error) {
    return (
      <div
        role="alert"
        className="flex items-start gap-2.5 rounded-[2px] border border-cinnabar-rule bg-cinnabar-wash p-4 text-xs text-cinnabar"
      >
        <AlertCircle size={15} className="mt-0.5 shrink-0" aria-hidden />
        <p className="leading-relaxed">{error}</p>
      </div>
    );
  }

  const phase = progress?.phase ?? (isInstalling ? "queued" : "failed");
  const percent = progress
    ? phase === "completed" || phase === "verifying" || phase === "extracting"
      ? 100
      : formatPercent(progress.downloaded_bytes, progress.total_bytes)
    : 0;

  const isError = phase === "failed" || phase === "cancelled" || (!isInstalling && error !== null);
  const isDone = phase === "completed" && !isError;
  const displayPhase = isError && phase === "completed" ? "failed" : phase;
  const canCancel =
    isInstalling &&
    phase !== "completed" &&
    phase !== "failed" &&
    phase !== "cancelled";

  return (
    <div
      role={isError ? "alert" : undefined}
      className={`rounded-[2px] border p-4 ${
        isError
          ? "border-cinnabar-rule bg-cinnabar-wash"
          : isDone
            ? "border-verdigris-rule bg-verdigris-wash"
            : "border-cobalt-rule bg-cobalt-wash"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-bone">
          {isError ? (
            <AlertCircle size={15} className="shrink-0 text-cinnabar" aria-hidden />
          ) : isDone ? (
            <CheckCircle2 size={15} className="shrink-0 text-verdigris" aria-hidden />
          ) : (
            <Loader2 size={15} className="shrink-0 animate-spin text-cobalt-ink" aria-hidden />
          )}
          <span>{t(`onboarding.download.${displayPhase}`)}</span>
          {progress && progress.attempt > 1 && (
            <span className="rounded-[2px] border border-rule-strong bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-bone-muted">
              {t("onboarding.download.attempt", { attempt: progress.attempt })}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          <span className="font-mono text-xs tabular-nums text-bone">{percent}%</span>
          {canCancel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={isCancelling}
              className="inline-flex items-center gap-1 rounded-[2px] border border-rule-strong bg-surface-2 px-2.5 py-1 text-xs font-medium text-bone transition-colors hover:border-cinnabar-rule hover:bg-surface-3 focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none disabled:opacity-45"
            >
              <X size={12} aria-hidden />
              {isCancelling ? t("onboarding.download.cancelling") : t("onboarding.download.cancel")}
            </button>
          )}
        </div>
      </div>

      <div className="mt-3 h-1.5 w-full overflow-hidden border border-rule bg-void">
        <div
          className={`h-full transition-all duration-200 ${
            isError ? "bg-cinnabar" : isDone ? "bg-verdigris" : "bg-cobalt-bright"
          }`}
          style={{ width: `${percent}%` }}
        />
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-bone-muted">
        <span className="font-mono tabular-nums">
          {progress
            ? progress.total_bytes !== null
              ? `${formatBytes(progress.downloaded_bytes)} / ${formatBytes(progress.total_bytes)}`
              : formatBytes(progress.downloaded_bytes)
            : "0 B"}
        </span>
        {progress?.artifact_id && (
          <span className="truncate font-mono text-[11px] text-bone-subtle">
            {progress.artifact_id}
          </span>
        )}
      </div>

      {(error || progress?.message) && (
        <p className={`mt-2 text-xs ${isError ? "text-cinnabar" : "text-bone-muted"}`}>
          {error ?? progress?.message}
        </p>
      )}
    </div>
  );
}
