import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2, Sparkles, X } from "lucide-react";
import { useSettingsStore, useThemeStore, type ThemeToast } from "@/stores";

const STANDARD_TOAST_MS = 5000;
const AI_TOAST_MS = 14000;

function ThemeToastItem({ toast }: { toast: ThemeToast }) {
  const { t } = useTranslation();
  const activeThemeId = useThemeStore((s) => s.activeThemeId);
  const setActiveTheme = useThemeStore((s) => s.setActiveTheme);
  const dismissThemeToast = useThemeStore((s) => s.dismissThemeToast);
  const markThemeToastApplied = useThemeStore((s) => s.markThemeToastApplied);
  const patchSettings = useSettingsStore((s) => s.patchSettings);

  const [applying, setApplying] = useState(false);

  useEffect(() => {
    const duration = toast.kind === "ai_created" ? AI_TOAST_MS : STANDARD_TOAST_MS;
    const timer = window.setTimeout(() => {
      dismissThemeToast(toast.id);
    }, duration);
    return () => window.clearTimeout(timer);
  }, [dismissThemeToast, toast.id, toast.kind]);

  const isAlreadyActive =
    Boolean(toast.themeId) && (toast.applied || activeThemeId === toast.themeId);

  const handleApply = async () => {
    if (!toast.themeId || applying) return;
    setApplying(true);
    try {
      const ok = await setActiveTheme(toast.themeId);
      if (ok) {
        await patchSettings({ active_theme_id: toast.themeId });
        markThemeToastApplied(toast.themeId);
      }
    } finally {
      setApplying(false);
    }
  };

  return (
    <div
      role="status"
      aria-live="polite"
      style={{ boxShadow: "var(--cobalt-shadow-elevated)" }}
      className="cobalt-panel-enter-up pointer-events-auto flex items-start gap-2.5 rounded-[2px] border border-cobalt-rule bg-surface px-3.5 py-3 text-xs text-bone"
    >
      <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[2px] border border-cobalt-rule bg-cobalt-wash text-cobalt-ink">
        {toast.kind === "ai_created" ? (
          <Sparkles size={11} aria-hidden />
        ) : (
          <Check size={11} aria-hidden />
        )}
      </span>

      <div className="min-w-0 flex-1 space-y-2">
        <p className="leading-snug text-bone">{toast.message}</p>

        {toast.kind === "ai_created" && toast.themeId && (
          <div className="flex items-center gap-2">
            {isAlreadyActive ? (
              <span className="inline-flex items-center gap-1 rounded-[2px] border border-verdigris-rule bg-verdigris-wash px-2 py-0.5 font-mono text-[10px] font-medium text-verdigris">
                <Check size={10} aria-hidden />
                {t("store.inUse")}
              </span>
            ) : (
              <button
                type="button"
                disabled={applying}
                onClick={() => void handleApply()}
                className="inline-flex items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-2.5 py-1 font-mono text-[10px] font-semibold text-on-accent hover:bg-cobalt-bright disabled:opacity-45"
              >
                {applying ? (
                  <Loader2 size={10} className="animate-spin" aria-hidden />
                ) : (
                  <Sparkles size={10} aria-hidden />
                )}
                {t("common.apply")}
              </button>
            )}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => dismissThemeToast(toast.id)}
        aria-label={t("common.close")}
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[2px] text-bone-subtle hover:bg-surface-2 hover:text-bone"
      >
        <X size={12} aria-hidden />
      </button>
    </div>
  );
}

export function ThemeToastHost() {
  const toasts = useThemeStore((s) => s.themeToasts);
  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((toast) => (
        <ThemeToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
