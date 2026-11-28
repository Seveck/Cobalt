import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, ChevronRight, X } from "lucide-react";
import { isDisplayError, toDisplayError, type DisplayError } from "@/lib/friendlyError";

export interface ErrorAlertProps {
  /**
   * Error to display. Pass a `DisplayError` (from `toDisplayError` / store state)
   * or a plain localized validation string. If `treatStringAsRaw` is true, plain strings
   * are converted via `toDisplayError` so raw backend text never leaks.
   */
  error: DisplayError | string | null | undefined;
  /** Set true when passing raw backend error strings (e.g. `connector.error`, `engineStatus.last_error`). */
  treatStringAsRaw?: boolean;
  /** Optional compact density for tight dialogs or dropdowns. */
  compact?: boolean;
  /** Optional inline actions (e.g. Retry or Install OCR button). */
  actions?: ReactNode;
  /** Optional dismiss handler. */
  onDismiss?: () => void;
  /** Hide the collapsible technical details disclosure. */
  hideDetails?: boolean;
  className?: string;
}

export function ErrorAlert({
  error,
  treatStringAsRaw = false,
  compact = false,
  actions,
  onDismiss,
  hideDetails = false,
  className = "",
}: ErrorAlertProps) {
  const { t } = useTranslation();

  if (!error) return null;

  const resolved: DisplayError = isDisplayError(error)
    ? error
    : treatStringAsRaw
      ? toDisplayError(error, t)
      : { message: error, details: null };

  const showDetails =
    !hideDetails &&
    Boolean(resolved.details) &&
    resolved.details!.trim().length > 0 &&
    resolved.details!.trim() !== resolved.message.trim();

  return (
    <div
      role="alert"
      className={`rounded-[2px] border border-cinnabar-rule bg-cinnabar-wash text-cinnabar ${
        compact ? "px-2.5 py-2 text-[11px]" : "px-3.5 py-2.5 text-xs"
      } ${className}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <AlertCircle
            size={compact ? 12 : 14}
            className="mt-0.5 shrink-0 text-cinnabar"
            aria-hidden
          />
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="break-words leading-relaxed">{resolved.message}</p>

            {showDetails && (
              <details className="group text-[11px] text-cinnabar/85">
                <summary className="inline-flex cursor-pointer list-none items-center gap-1 select-none font-mono text-[10px] opacity-85 transition-opacity hover:opacity-100 [&::-webkit-details-marker]:hidden">
                  <ChevronRight
                    size={11}
                    className="shrink-0 transition-transform group-open:rotate-90"
                    aria-hidden
                  />
                  <span>{t("errors.viewTechnicalDetails")}</span>
                </summary>
                <pre className="mt-1.5 max-h-36 overflow-auto rounded-[2px] border border-cinnabar-rule/60 bg-void/70 p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap break-all text-bone-muted">
                  {resolved.details}
                </pre>
              </details>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {actions}
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              aria-label={t("common.close")}
              className="rounded-[2px] p-0.5 text-cinnabar/85 transition-colors hover:bg-cinnabar/15 hover:text-cinnabar"
            >
              <X size={compact ? 11 : 13} aria-hidden />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
