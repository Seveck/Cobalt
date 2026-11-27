import { useEffect, useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Gauge,
  Leaf,
  Library,
  Network,
  Plug,
  Settings,
  Shield,
  Store,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { SUPPORTED_LANGUAGES } from "@/i18n";
import {
  useSettingsStore,
  useUiStore,
  type NavSection,
} from "@/stores";
import { Select, type SelectOption } from "@/components/ui";
import type { HardwareTier, Language } from "@/types/contracts";
import { CobaltMark } from "./CobaltMark";

interface NavItem {
  key: NavSection;
  icon: LucideIcon;
}

const NAV_ITEMS: readonly NavItem[] = [
  { key: "brain", icon: Network },
  { key: "library", icon: Library },
  { key: "telemetry", icon: Gauge },
  { key: "stats", icon: BarChart3 },
  { key: "connectors", icon: Plug },
  { key: "tools", icon: Wrench },
  { key: "store", icon: Store },
  { key: "settings", icon: Settings },
];

const TIER_ICONS: Record<HardwareTier, LucideIcon> = {
  eco: Leaf,
  balanced: Cpu,
  ultra: Zap,
};

function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function Sidebar() {
  const { t, i18n } = useTranslation();
  const langLabelId = useId();
  const activeNav = useUiStore((s) => s.activeNav);
  const setActiveNav = useUiStore((s) => s.setActiveNav);
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);

  const settings = useSettingsStore((s) => s.settings);
  const saving = useSettingsStore((s) => s.saving);
  const setLanguage = useSettingsStore((s) => s.setLanguage);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) {
        return;
      }
      if (event.key.toLowerCase() !== "b") {
        return;
      }
      if (isEditableEventTarget(event.target)) {
        return;
      }
      event.preventDefault();
      toggleSidebar();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleSidebar]);

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
  const TierIcon = TIER_ICONS[settings.hardware_tier];

  const isMac =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform ?? "");
  const shortcutHint = isMac ? "⌘B" : "Ctrl+B";
  const toggleLabel = collapsed ? t("shell.expandSidebar") : t("shell.collapseSidebar");
  const toggleTooltip = `${toggleLabel} (${shortcutHint})`;

  const handleCycleLanguage = () => {
    const idx = SUPPORTED_LANGUAGES.indexOf(currentLanguage);
    const nextLang = SUPPORTED_LANGUAGES[(idx + 1) % SUPPORTED_LANGUAGES.length] ?? "en";
    void setLanguage(nextLang);
  };

  return (
    <aside
      className={`flex shrink-0 flex-col overflow-hidden border-r border-rule bg-surface transition-[width] duration-200 ease-out motion-reduce:transition-none ${
        collapsed ? "w-12" : "w-60"
      }`}
    >
      {/* Brand masthead */}
      {collapsed ? (
        <div className="flex flex-col items-center gap-2 border-b border-rule px-1.5 py-3">
          <span
            title={t("app.name")}
            className="inline-flex h-6 w-6 items-center justify-center"
          >
            <CobaltMark size={18} />
          </span>
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label={toggleLabel}
            aria-expanded={false}
            title={toggleTooltip}
            className="inline-flex h-7 w-full items-center justify-center rounded-[2px] border border-transparent text-bone-muted transition-colors hover:border-rule hover:bg-surface-2 hover:text-bone focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none"
          >
            <ChevronRight size={14} aria-hidden />
          </button>
        </div>
      ) : (
        <div className="border-b border-rule px-4 py-4">
          <div className="flex w-52 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2.5">
              <CobaltMark size={20} className="shrink-0" />
              <div className="flex items-baseline gap-1.5 whitespace-nowrap">
                <span className="font-display text-lg font-semibold tracking-tight text-bone">
                  {t("app.name")}
                </span>
                <span className="rounded-[2px] border border-cobalt-rule bg-cobalt-wash px-1 py-0.5 font-mono text-[9px] font-medium leading-none tracking-wider text-cobalt-ink">
                  Co·27
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={toggleSidebar}
              aria-label={toggleLabel}
              aria-expanded={true}
              title={toggleTooltip}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[2px] border border-transparent text-bone-subtle transition-colors hover:border-rule hover:bg-surface-2 hover:text-bone focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none"
            >
              <ChevronLeft size={14} aria-hidden />
            </button>
          </div>
          <p className="mt-2 w-52 text-[11px] leading-relaxed text-bone-muted">
            {t("app.tagline")}
          </p>
        </div>
      )}

      {/* Primary navigation */}
      <nav
        aria-label={t("app.name")}
        className={`flex flex-1 flex-col gap-0.5 ${collapsed ? "px-1.5 py-2.5" : "p-2.5"}`}
      >
        {NAV_ITEMS.map(({ key, icon: Icon }) => {
          const active = activeNav === key;
          const label = t(`nav.${key}`);
          return (
            <button
              key={key}
              type="button"
              onClick={() => setActiveNav(key)}
              aria-current={active ? "page" : undefined}
              aria-label={collapsed ? label : undefined}
              title={collapsed ? label : undefined}
              className={`group flex w-full items-center rounded-[2px] border text-[13px] font-medium transition-colors focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none ${
                collapsed
                  ? "h-9 justify-center px-0"
                  : "justify-between gap-2 px-2.5 py-2 text-left"
              } ${
                active
                  ? "border-cobalt-rule/70 border-l-2 border-l-cobalt bg-cobalt-wash text-bone"
                  : "border-transparent bg-surface text-bone-muted hover:border-rule hover:bg-surface-2 hover:text-bone"
              }`}
            >
              {collapsed ? (
                <Icon
                  size={15}
                  className={
                    active
                      ? "shrink-0 text-cobalt-ink"
                      : "shrink-0 text-bone-subtle group-hover:text-bone-muted"
                  }
                  aria-hidden
                />
              ) : (
                <span className="flex min-w-0 items-center gap-2.5 whitespace-nowrap">
                  <Icon
                    size={15}
                    className={
                      active
                        ? "shrink-0 text-cobalt-ink"
                        : "shrink-0 text-bone-subtle group-hover:text-bone-muted"
                    }
                    aria-hidden
                  />
                  <span className="truncate">{label}</span>
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Footer status & language */}
      {collapsed ? (
        <div className="flex flex-col items-center gap-2 border-t border-rule bg-surface px-1.5 py-3 text-xs text-bone-muted">
          <span
            title={t(`tiers.${settings.hardware_tier}`)}
            aria-label={t(`tiers.${settings.hardware_tier}`)}
            className="inline-flex h-7 w-full items-center justify-center rounded-[2px] border border-cobalt-rule bg-cobalt-wash text-cobalt-ink"
          >
            <TierIcon size={13} aria-hidden />
          </span>

          {settings.read_only && (
            <span
              title={t("shell.readOnly")}
              aria-label={t("shell.readOnly")}
              className="inline-flex h-7 w-full items-center justify-center rounded-[2px] border border-ochre-rule bg-ochre-wash text-ochre"
            >
              <Shield size={13} aria-hidden />
            </span>
          )}

          <button
            type="button"
            disabled={saving}
            onClick={handleCycleLanguage}
            title={`${t("shell.language")}: ${t(`languages.${currentLanguage}`)}`}
            aria-label={`${t("shell.language")}: ${t(`languages.${currentLanguage}`)}`}
            className="inline-flex h-7 w-full items-center justify-center rounded-[2px] border border-rule-strong bg-surface-2 font-mono text-[10px] font-medium uppercase tracking-wider text-bone transition-colors hover:border-cobalt-ink/60 hover:bg-surface-3 focus-visible:border-cobalt-ink focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45"
          >
            {t(`languages.${currentLanguage}Short`)}
          </button>
        </div>
      ) : (
        <div className="border-t border-rule bg-surface px-4 py-3.5 text-xs text-bone-muted">
          <div className="w-52 space-y-3">
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
        </div>
      )}
    </aside>
  );
}
