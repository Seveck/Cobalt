import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ChevronDown, ChevronUp, X } from "lucide-react";
import { useThemeStore } from "@/stores";

interface ThemeWarningsBannerProps {
  className?: string;
}

/**
 * Non-blocking warning display for theme shader compile/link errors,
 * frame-time watchdog trips, and custom mesh load fallbacks (THEME_SPEC §6.2).
 */
export function ThemeWarningsBanner({ className = "" }: ThemeWarningsBannerProps) {
  const { t } = useTranslation();
  const warnings = useThemeStore((s) => s.themeWarnings);
  const dismissWarning = useThemeStore((s) => s.dismissThemeWarning);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());

  if (warnings.length === 0) return null;

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className={`space-y-1.5 ${className}`}
    >
      {warnings.map((warning) => {
        const isExpanded = expandedIds.has(warning.id);
        const hasDetail = Boolean(warning.detail && warning.detail.trim().length > 0);

        return (
          <div
            key={warning.id}
            className="cobalt-panel-enter-down rounded-[2px] border border-ochre-rule bg-surface/95 px-3 py-2 text-xs text-bone shadow-sm backdrop-blur-xs"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-start gap-2">
                <AlertTriangle
                  size={13}
                  className="mt-0.5 shrink-0 text-ochre"
                  aria-hidden
                />
                <div className="min-w-0">
                  <div className="leading-snug text-ochre">
                    {(() => {
                      const params =
                        warning.layer !== undefined
                          ? {
                              ...warning.summaryParams,
                              layer: t(`themes.layers.${warning.layer}`),
                            }
                          : warning.summaryParams;
                      return params ? t(warning.summaryKey, params) : t(warning.summaryKey);
                    })()}
                  </div>
                  {hasDetail && (
                    <button
                      type="button"
                      onClick={() => toggleExpand(warning.id)}
                      className="mt-1 inline-flex items-center gap-1 font-mono text-[10px] text-bone-muted underline-offset-2 hover:text-bone hover:underline"
                    >
                      {isExpanded ? (
                        <>
                          <ChevronUp size={11} aria-hidden />
                          {t("themes.hideCompilerLog")}
                        </>
                      ) : (
                        <>
                          <ChevronDown size={11} aria-hidden />
                          {t("themes.showCompilerLog")}
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>

              <button
                type="button"
                onClick={() => dismissWarning(warning.id)}
                aria-label={t("common.close")}
                title={t("common.close")}
                className="shrink-0 rounded-[1px] p-0.5 text-bone-subtle transition-colors hover:bg-surface-2 hover:text-bone"
              >
                <X size={12} aria-hidden />
              </button>
            </div>

            {hasDetail && isExpanded && (
              <pre className="mt-2 max-h-40 overflow-auto rounded-[2px] border border-rule bg-void p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-bone-muted">
                {warning.detail}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}
