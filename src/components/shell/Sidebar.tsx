import { useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Gauge,
  Library,
  Network,
  Plug,
  Settings,
  Shield,
  Store,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { SUPPORTED_LANGUAGES } from "@/i18n";
import {
  useSettingsStore,
  useUiStore,
  type NavSection,
} from "@/stores";
import { Select, type SelectOption } from "@/components/ui";
import type { Language } from "@/types/contracts";
import { CobaltMark } from "./CobaltMark";
import { MockBadge } from "./MockBadge";

interface NavItem {
  key: NavSection;
  icon: LucideIcon;
}

const NAV_ITEMS: readonly NavItem[] = [
  { key: "brain", icon: Network },
  { key: "library", icon: Library },
  { key: "telemetry", icon: Gauge },
  { key: "connectors", icon: Plug },
  { key: "tools", icon: Wrench },
  { key: "store", icon: Store },
  { key: "settings", icon: Settings },
];

export function Sidebar() {
  const { t, i18n } = useTranslation();
  const langLabelId = useId();
  const activeNav = useUiStore((s) => s.activeNav);
  const setActiveNav = useUiStore((s) => s.setActiveNav);
  const globalMockMode = useUiStore((s) => s.globalMockMode);

  const settings = useSettingsStore((s) => s.settings);
  const saving = useSettingsStore((s) => s.saving);
  const setLanguage = useSettingsStore((s) => s.setLanguage);

  const languageOptions = useMemo<SelectOption<Language>[]>(
    () =>
      SUPPORTED_LANGUAGES.map((lng) => ({
        value: lng,
        label: t(`languages.${lng}Short`),
        detail: t(`languages.${lng}`),
      })),
    [t],
  );

  const currentLanguage = (i18n.resolvedLanguage as Language | undefined) ?? settings.language;

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-rule bg-surface">
      {/* Brand masthead */}
      <div className="border-b border-rule px-4 py-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <CobaltMark size={20} />
            <div className="flex items-baseline gap-1.5">
              <span className="font-display text-lg font-semibold tracking-tight text-bone">
                {t("app.name")}
              </span>
              <span className="rounded-[2px] border border-cobalt-rule bg-cobalt-wash px-1 py-0.5 font-mono text-[9px] font-medium leading-none tracking-wider text-cobalt-ink">
                Co·27
              </span>
            </div>
          </div>
          {globalMockMode && <MockBadge />}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-bone-muted">{t("app.tagline")}</p>
      </div>

      {/* Primary navigation */}
      <nav aria-label={t("app.name")} className="flex flex-1 flex-col gap-0.5 p-2.5">
        {NAV_ITEMS.map(({ key, icon: Icon }) => {
          const active = activeNav === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setActiveNav(key)}
              aria-current={active ? "page" : undefined}
              className={`group flex w-full items-center justify-between gap-2 rounded-[2px] border px-2.5 py-2 text-left text-[13px] font-medium transition-colors focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none ${
                active
                  ? "border-cobalt-rule/70 border-l-2 border-l-cobalt bg-cobalt-wash text-bone"
                  : "border-transparent bg-surface text-bone-muted hover:border-rule hover:bg-surface-2 hover:text-bone"
              }`}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <Icon
                  size={15}
                  className={
                    active ? "shrink-0 text-cobalt-ink" : "shrink-0 text-bone-subtle group-hover:text-bone-muted"
                  }
                  aria-hidden
                />
                <span className="truncate">{t(`nav.${key}`)}</span>
              </span>
            </button>
          );
        })}
      </nav>

      {/* Footer status & language */}
      <div className="space-y-3 border-t border-rule bg-surface px-4 py-3.5 text-xs text-bone-muted">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded-[2px] border border-cobalt-rule bg-cobalt-wash px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-cobalt-ink">
            {t(`tiers.${settings.hardware_tier}`)}
          </span>
          {settings.read_only && (
            <span className="inline-flex items-center gap-1 rounded-[2px] border border-ochre-rule bg-ochre-wash px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-ochre">
              <Shield size={10} aria-hidden />
              {t("shell.readOnly")}
            </span>
          )}
        </div>

        <div className="flex items-center justify-between gap-2">
          <span
            id={langLabelId}
            className="font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle"
          >
            {t("shell.language")}
          </span>
          <Select<Language>
            value={currentLanguage}
            options={languageOptions}
            disabled={saving}
            size="sm"
            placement="top"
            align="right"
            ariaLabelledBy={langLabelId}
            className="w-20"
            menuClassName="w-40"
            onChange={(nextLang) => void setLanguage(nextLang)}
          />
        </div>
      </div>
    </aside>
  );
}
