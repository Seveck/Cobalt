import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Brain, Gauge, Library, Plug, Settings, Store } from "lucide-react";
import { call, isTauri } from "@/lib/ipc";
import { CONTRACT_VERSION, type AppInfo, type Language } from "@/types/contracts";
import { SUPPORTED_LANGUAGES } from "@/i18n";

const NAV = [
  { key: "brain", icon: Brain },
  { key: "library", icon: Library },
  { key: "telemetry", icon: Gauge },
  { key: "connectors", icon: Plug },
  { key: "store", icon: Store },
  { key: "settings", icon: Settings },
] as const;

/**
 * Phase 0 shell. [GEMINI] replaces it in Phase 1 with the full navigation,
 * Zustand stores, onboarding and the R3F canvas.
 */
export default function App() {
  const { t, i18n } = useTranslation();
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    call("app_info")
      .then(setInfo)
      .catch((err: unknown) => console.error("app_info failed", err));
  }, []);

  return (
    <div className="flex h-full">
      <nav className="flex w-56 flex-col gap-1 border-r border-white/5 bg-cobalt-900/40 p-3">
        <div className="mb-4 px-2">
          <div className="text-lg font-semibold tracking-wide text-cobalt-300">{t("app.name")}</div>
          <div className="text-xs text-slate-400">{t("app.tagline")}</div>
        </div>
        {NAV.map(({ key, icon: Icon }) => (
          <div
            key={key}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-300"
          >
            <Icon size={16} aria-hidden />
            {t(`nav.${key}`)}
          </div>
        ))}
        <div className="mt-auto space-y-2 px-2 text-xs text-slate-500">
          <label className="flex items-center justify-between gap-2">
            {t("shell.language")}
            <select
              className="rounded bg-white/5 px-1 py-0.5 text-slate-200"
              value={i18n.resolvedLanguage}
              onChange={(e) => void i18n.changeLanguage(e.target.value as Language)}
            >
              {SUPPORTED_LANGUAGES.map((lng) => (
                <option key={lng} value={lng}>
                  {lng.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
          {info && <div>{t("shell.version", { version: info.version })}</div>}
          <div>{t("shell.contract", { version: CONTRACT_VERSION })}</div>
        </div>
      </nav>
      <main className="flex flex-1 items-center justify-center">
        {!isTauri() && <p className="text-sm text-slate-500">{t("shell.browserPreview")}</p>}
      </main>
    </div>
  );
}
