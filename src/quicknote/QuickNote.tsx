import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { backendCall } from "@/lib/backend";
import { isTauri } from "@/lib/ipc";

/**
 * Frameless quick-note window (label `quicknote`). Phase 0: layout + Esc to hide.
 * [GEMINI] wires `submit_quick_note` in Phase 3 (Enter -> save -> hide).
 */
export default function QuickNote() {
  const { t, i18n } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();

    void backendCall("get_settings")
      .then((settings) => {
        if (typeof document !== "undefined") {
          document.documentElement.lang = settings.language;
        }
        if (i18n.resolvedLanguage !== settings.language) {
          void i18n.changeLanguage(settings.language);
        }
      })
      .catch(() => {
        // Keep OS-detected fallback language if settings are unavailable.
      });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTauri()) {
        void getCurrentWindow().hide();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [i18n]);

  return (
    <div className="flex h-full flex-col justify-center gap-2 rounded-[2px] border border-cobalt-rule border-t-2 border-t-cobalt bg-surface px-4">
      <input
        ref={inputRef}
        type="text"
        className="w-full rounded-[2px] border border-rule bg-void px-3 py-2 text-base text-bone placeholder:text-bone-subtle focus:border-cobalt-ink focus:outline-none"
        placeholder={t("quicknote.placeholder")}
        aria-label={t("quicknote.placeholder")}
      />
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
        {t("quicknote.hint")}
      </span>
    </div>
  );
}
