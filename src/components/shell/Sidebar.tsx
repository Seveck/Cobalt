import { useTranslation } from "react-i18next";
import {
  Brain,
  Gauge,
  Library,
  Plug,
  Settings,
  Shield,
  Store,
  type LucideIcon,
} from "lucide-react";
import { SUPPORTED_LANGUAGES } from "@/i18n";
import {
  useSettingsStore,
  useUiStore,
  type NavSection,
} from "@/stores";
import { CONTRACT_VERSION, type Language } from "@/types/contracts";
import { MockBadge } from "./MockBadge";

interface NavItem {
  key: NavSection;
  icon: LucideIcon;
}

const NAV_ITEMS: readonly NavItem[] = [
  { key: "brain", icon: Brain },
  { key: "library", icon: Library },
  { key: "telemetry", icon: Gauge },
  { key: "connectors", icon: Plug },
  { key: "store", icon: Store },
  { key: "settings", icon: Settings },
];

export function Sidebar() {
  const { t, i18n } = useTranslation();
  const activeNav = useUiStore((s) => s.activeNav);
  const setActiveNav = useUiStore((s) => s.setActiveNav);
  const appInfo = useUiStore((s) => s.appInfo);
  const globalMockMode = useUiStore((s) => s.globalMockMode);

  const settings = useSettingsStore((s) => s.settings);
  const saving = useSettingsStore((s) => s.saving);
  const setLanguage = useSettingsStore((s) => s.setLanguage);

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-white/10 bg-cobalt-900/40 p-3">
      {/* Brand */}
      <div className="mb-4 px-2 pt-1">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-cobalt-600/30 text-cobalt-300">
              <Brain size={16} aria-hidden />
            </span>
            <span className="text-base font-semibold tracking-wide text-slate-100">
              {t("app.name")}
            </span>
          </div>
          {globalMockMode && <MockBadge />}
        </div>
        <p className="mt-1.5 text-[11px] leading-snug text-slate-400">{t("app.tagline")}</p>
      </div>

      {/* Primary navigation */}
      <nav aria-label={t("app.name")} className="flex flex-1 flex-col gap-1">
        {NAV_ITEMS.map(({ key, icon: Icon }) => {
          const active = activeNav === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setActiveNav(key)}
              aria-current={active ? "page" : undefined}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm font-medium transition ${
                active
                  ? "bg-cobalt-600/30 text-white shadow-[inset_0_0_0_1px_rgba(47,107,255,0.4)]"
                  : "text-slate-300 hover:bg-white/5 hover:text-slate-100"
              }`}
            >
              <Icon
                size={16}
                className={active ? "text-cobalt-300" : "text-slate-400"}
                aria-hidden
              />
              <span>{t(`nav.${key}`)}</span>
            </button>
          );
        })}
      </nav>

      {/* Footer status & language */}
      <div className="mt-4 space-y-2.5 border-t border-white/10 px-2 pt-3 text-xs text-slate-400">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded-full border border-cobalt-500/30 bg-cobalt-600/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-cobalt-300">
            {t(`tiers.${settings.hardware_tier}`)}
          </span>
          {settings.read_only && (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/30 bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-300">
              <Shield size={10} aria-hidden />
              {t("shell.readOnly")}
            </span>
          )}
        </div>

        <label className="flex items-center justify-between gap-2">
          <span>{t("shell.language")}</span>
          <select
            disabled={saving}
            aria-label={t("shell.language")}
            className="rounded-md border border-white/10 bg-void px-2 py-1 text-xs text-slate-200 outline-none focus:border-cobalt-500"
            value={(i18n.resolvedLanguage as Language | undefined) ?? settings.language}
            onChange={(e) => void setLanguage(e.target.value as Language)}
          >
            {SUPPORTED_LANGUAGES.map((lng) => (
              <option key={lng} value={lng}>
                {lng.toUpperCase()}
              </option>
            ))}
          </select>
        </label>

        <div className="space-y-0.5 text-[11px] text-slate-500">
          {appInfo && <div>{t("shell.version", { version: appInfo.version })}</div>}
          <div>{t("shell.contract", { version: CONTRACT_VERSION })}</div>
        </div>
      </div>
    </aside>
  );
}
