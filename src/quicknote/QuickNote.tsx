import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@/lib/ipc";

/**
 * Frameless quick-note window (label `quicknote`). Phase 0: layout + Esc to hide.
 * [GEMINI] wires `submit_quick_note` in Phase 3 (Enter -> save -> hide).
 */
export default function QuickNote() {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTauri()) {
        void getCurrentWindow().hide();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-full flex-col justify-center gap-2 rounded-xl border border-cobalt-600/40 bg-void/95 px-4">
      <input
        ref={inputRef}
        className="w-full bg-transparent text-lg text-slate-100 outline-none placeholder:text-slate-500"
        placeholder={t("quicknote.placeholder")}
        aria-label={t("quicknote.placeholder")}
      />
      <span className="text-xs text-slate-500">{t("quicknote.hint")}</span>
    </div>
  );
}
