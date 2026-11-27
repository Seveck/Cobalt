import { useTranslation } from "react-i18next";
import { Bell, Shield } from "lucide-react";
import { usePrefersReducedMotion } from "@/lib/usePrefersReducedMotion";
import { useProposalsStore, useSettingsStore, useUiStore } from "@/stores";

/**
 * Compact persistent top shell bar shown across all views.
 * Hosts the current section label and the Memory Proposals ("Propuestas") inbox trigger.
 */
export function TopShellBar() {
  const { t } = useTranslation();
  const prefersReducedMotion = usePrefersReducedMotion();

  const activeNav = useUiStore((s) => s.activeNav);
  const readOnly = useSettingsStore((s) => s.settings.read_only);

  const open = useProposalsStore((s) => s.open);
  const pendingCount = useProposalsStore((s) => s.pendingCount);
  const togglePanel = useProposalsStore((s) => s.togglePanel);

  const badgeText = pendingCount > 99 ? "99+" : String(pendingCount);
  const buttonAriaLabel =
    pendingCount > 0
      ? t("proposals.triggerAriaWithCount", { count: pendingCount })
      : t("proposals.triggerAria");

  return (
    <header className="relative z-30 flex h-10 shrink-0 items-center justify-between gap-3 border-b border-rule bg-surface/95 px-4">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="truncate font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-bone-muted">
          {t(`nav.${activeNav}`)}
        </span>
        {readOnly && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-[2px] border border-ochre-rule bg-ochre-wash px-1.5 py-0.5 font-mono text-[9px] font-medium uppercase tracking-[0.08em] text-ochre">
            <Shield size={9} aria-hidden />
            {t("shell.readOnly")}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={togglePanel}
          aria-expanded={open}
          aria-controls="cobalt-proposals-panel"
          aria-label={buttonAriaLabel}
          title={buttonAriaLabel}
          className={`inline-flex h-7 items-center gap-1.5 rounded-[2px] border px-2.5 text-xs font-medium ${
            prefersReducedMotion ? "" : "transition-colors"
          } focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none ${
            open
              ? "border-cobalt-rule bg-cobalt-wash text-bone"
              : pendingCount > 0
                ? "border-cobalt-rule/80 bg-surface-2 text-bone hover:border-cobalt-rule hover:bg-cobalt-wash"
                : "border-rule bg-surface-2 text-bone-muted hover:border-rule-strong hover:text-bone"
          }`}
        >
          <Bell
            size={13}
            className={
              open || pendingCount > 0 ? "shrink-0 text-cobalt-ink" : "shrink-0 text-bone-subtle"
            }
            aria-hidden
          />
          <span className="hidden sm:inline">{t("proposals.title")}</span>
          {pendingCount > 0 && (
            <span className="inline-flex min-w-[1.25rem] items-center justify-center rounded-[2px] bg-cobalt px-1.5 py-0.5 font-mono text-[10px] leading-none font-semibold tabular-nums text-on-accent">
              {badgeText}
            </span>
          )}
        </button>
      </div>
    </header>
  );
}
