import { useTranslation } from "react-i18next";
import { Monitor, Terminal } from "lucide-react";
import { SUPPORTED_LANGUAGES } from "@/i18n";
import type { Language } from "@/types/contracts";
import { CobaltMark } from "./CobaltMark";

/**
 * Full-screen notice rendered when the frontend is opened in a plain browser
 * outside the Tauri desktop runtime. Zero IPC calls and zero simulated data.
 */
export function DesktopOnlyNotice() {
  const { t, i18n } = useTranslation();
  const currentLang = (i18n.resolvedLanguage as Language | undefined) ?? "en";

  const handleChangeLanguage = (lng: Language) => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = lng;
    }
    void i18n.changeLanguage(lng);
  };

  return (
    <div className="cobalt-grid-bg flex min-h-full w-full items-center justify-center bg-void p-6 text-bone">
      <div className="w-full max-w-lg overflow-hidden rounded-[2px] border border-rule-strong bg-surface shadow-[0_24px_64px_rgba(0,0,0,0.65)]">
        <div className="h-[2px] w-full bg-cobalt" aria-hidden />

        {/* Header */}
        <header className="flex items-center justify-between gap-3 border-b border-rule px-6 py-4">
          <div className="flex items-center gap-2.5">
            <CobaltMark size={20} />
            <div className="flex items-baseline gap-1.5">
              <span className="font-display text-base font-semibold tracking-tight text-bone">
                {t("app.name")}
              </span>
              <span className="rounded-[2px] border border-cobalt-rule bg-cobalt-wash px-1 py-0.5 font-mono text-[9px] font-medium leading-none tracking-wider text-cobalt-ink">
                Co·27
              </span>
            </div>
          </div>

          <div
            role="group"
            aria-label={t("shell.language")}
            className="inline-flex rounded-[2px] border border-rule bg-void p-0.5 font-mono text-[10px]"
          >
            {SUPPORTED_LANGUAGES.map((lng) => {
              const active = currentLang === lng;
              return (
                <button
                  key={lng}
                  type="button"
                  onClick={() => handleChangeLanguage(lng)}
                  aria-pressed={active}
                  className={`rounded-[1px] px-2 py-0.5 uppercase transition-colors ${
                    active
                      ? "bg-cobalt-wash font-semibold text-cobalt-ink"
                      : "text-bone-muted hover:text-bone"
                  }`}
                >
                  {t(`languages.${lng}Short`)}
                </button>
              );
            })}
          </div>
        </header>

        {/* Body */}
        <main className="space-y-4 px-6 py-6">
          <div className="flex items-start gap-3.5">
            <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-[2px] border border-cobalt-rule bg-cobalt-wash text-cobalt-ink">
              <Monitor size={18} aria-hidden />
            </div>
            <div className="space-y-1.5">
              <h1 className="font-display text-xl font-medium tracking-tight text-bone">
                {t("shell.desktopOnlyTitle")}
              </h1>
              <p className="text-sm leading-relaxed text-bone-muted">
                {t("shell.desktopOnlyDesc")}
              </p>
            </div>
          </div>

          <div className="rounded-[2px] border border-rule bg-void p-3.5">
            <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
              <Terminal size={11} className="text-cobalt-ink" aria-hidden />
              <span>{t("shell.desktopOnlyCommandLabel")}</span>
            </div>
            <pre className="mt-2 font-mono text-sm font-medium text-cobalt-ink">
              <code>pnpm dev:app</code>
            </pre>
          </div>
        </main>
      </div>
    </div>
  );
}
