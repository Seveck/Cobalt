import { useTranslation } from "react-i18next";
import {
  Box,
  Boxes,
  Brain,
  ChevronLeft,
  ChevronRight,
  Compass,
  GitFork,
  Layers,
  LayoutGrid,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { useUiStore } from "@/stores";
import type { ClusterSizeMetric, LayoutType } from "@/types/contracts";
import { BUILTIN_LAYOUT_TYPES } from "./layouts";

interface LayoutsPanelProps {
  activeLayout: LayoutType;
  clusterSizeMetric: ClusterSizeMetric;
  hasCustomMesh?: boolean;
  onSelectLayout: (layout: LayoutType) => void;
  onSelectSizeMetric: (metric: ClusterSizeMetric) => void;
}

const LAYOUT_ICONS: Record<LayoutType, LucideIcon> = {
  galaxy: Sparkles,
  brain: Brain,
  neural_net: Layers,
  knowledge_tree: GitFork,
  project_clusters: Boxes,
  project_islands: LayoutGrid,
  custom_mesh: Box,
};

export function LayoutsPanel({
  activeLayout,
  clusterSizeMetric,
  hasCustomMesh = false,
  onSelectLayout,
  onSelectSizeMetric,
}: LayoutsPanelProps) {
  const { t } = useTranslation();
  const collapsed = useUiStore((s) => s.layoutsPanelCollapsed);
  const toggleLayoutsPanel = useUiStore((s) => s.toggleLayoutsPanel);

  const visibleLayouts: readonly LayoutType[] =
    hasCustomMesh || activeLayout === "custom_mesh"
      ? [...BUILTIN_LAYOUT_TYPES, "custom_mesh"]
      : BUILTIN_LAYOUT_TYPES;

  const toggleLabel = collapsed
    ? t("brain.layouts.expandPanel")
    : t("brain.layouts.collapsePanel");

  const handleCycleClusterMetric = () => {
    onSelectSizeMetric(clusterSizeMetric === "vectors" ? "tokens" : "vectors");
  };

  return (
    <aside
      aria-label={t("brain.layouts.label")}
      className={`flex shrink-0 flex-col overflow-hidden border-l border-rule bg-surface transition-[width] duration-200 ease-out motion-reduce:transition-none ${
        collapsed ? "w-12" : "w-64"
      }`}
    >
      {/* Header (mirrors left Sidebar masthead) */}
      {collapsed ? (
        <div className="flex flex-col items-center gap-2 border-b border-rule px-1.5 py-3">
          <button
            type="button"
            onClick={toggleLayoutsPanel}
            aria-label={toggleLabel}
            aria-expanded={false}
            title={toggleLabel}
            className="inline-flex h-7 w-full items-center justify-center rounded-[2px] border border-transparent text-bone-muted transition-colors hover:border-rule hover:bg-surface-2 hover:text-bone focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none"
          >
            <ChevronLeft size={14} aria-hidden />
          </button>
        </div>
      ) : (
        <div className="border-b border-rule px-4 py-3.5">
          <div className="flex w-56 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2 whitespace-nowrap">
              <Compass size={15} className="shrink-0 text-cobalt-ink" aria-hidden />
              <span className="truncate font-display text-sm font-semibold tracking-tight text-bone">
                {t("brain.layouts.label")}
              </span>
            </div>
            <button
              type="button"
              onClick={toggleLayoutsPanel}
              aria-label={toggleLabel}
              aria-expanded={true}
              title={toggleLabel}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[2px] border border-transparent text-bone-subtle transition-colors hover:border-rule hover:bg-surface-2 hover:text-bone focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none"
            >
              <ChevronRight size={14} aria-hidden />
            </button>
          </div>
          <p className="mt-1.5 w-56 text-[11px] leading-relaxed text-bone-muted">
            {t("brain.layouts.panelSubtitle")}
          </p>
        </div>
      )}

      {/* Vertical layout list */}
      <div
        role="group"
        aria-label={t("brain.layouts.label")}
        className={`flex flex-1 flex-col gap-1 overflow-y-auto ${
          collapsed ? "px-1.5 py-2.5" : "p-2.5"
        }`}
      >
        {visibleLayouts.map((layout) => {
          const Icon = LAYOUT_ICONS[layout];
          const active = activeLayout === layout;
          const name = t(`brain.layouts.${layout}`);
          const description = t(`brain.layouts.descriptions.${layout}`);

          return (
            <button
              key={layout}
              type="button"
              onClick={() => onSelectLayout(layout)}
              aria-pressed={active}
              aria-label={collapsed ? name : undefined}
              title={collapsed ? `${name} — ${description}` : description}
              className={`group flex w-full rounded-[2px] border transition-colors focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none ${
                collapsed
                  ? "h-9 items-center justify-center px-0"
                  : "items-start gap-2.5 px-2.5 py-2 text-left"
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
                <>
                  <Icon
                    size={15}
                    className={`mt-0.5 shrink-0 ${
                      active
                        ? "text-cobalt-ink"
                        : "text-bone-subtle group-hover:text-bone-muted"
                    }`}
                    aria-hidden
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-center justify-between gap-1.5">
                      <span className="truncate text-[13px] font-medium leading-tight">
                        {name}
                      </span>
                      {active && (
                        <span
                          className="h-1.5 w-1.5 shrink-0 rounded-full bg-cobalt-ink"
                          aria-hidden
                        />
                      )}
                    </span>
                    <span
                      className={`mt-0.5 truncate text-[11px] leading-snug ${
                        active ? "text-bone-muted" : "text-bone-subtle"
                      }`}
                    >
                      {description}
                    </span>
                  </span>
                </>
              )}
            </button>
          );
        })}
      </div>

      {/* Contextual cluster size metric footer when project_clusters is active */}
      {activeLayout === "project_clusters" &&
        (collapsed ? (
          <div className="flex flex-col items-center border-t border-rule bg-surface px-1.5 py-2.5">
            <button
              type="button"
              onClick={handleCycleClusterMetric}
              title={`${t("brain.clusterMetric.label")}: ${t(
                `brain.clusterMetric.${clusterSizeMetric}`,
              )}`}
              aria-label={`${t("brain.clusterMetric.label")}: ${t(
                `brain.clusterMetric.${clusterSizeMetric}`,
              )}`}
              className="inline-flex h-7 w-full items-center justify-center rounded-[2px] border border-cobalt-rule bg-cobalt-wash font-mono text-[10px] font-medium uppercase tracking-wider text-cobalt-ink transition-colors hover:bg-surface-2 focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none"
            >
              {clusterSizeMetric === "vectors" ? "V" : "T"}
            </button>
          </div>
        ) : (
          <div className="border-t border-rule bg-surface px-4 py-3 text-xs text-bone-muted">
            <div className="w-56 space-y-2">
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
                {t("brain.clusterMetric.label")}
              </div>
              <div
                role="group"
                aria-label={t("brain.clusterMetric.label")}
                className="grid grid-cols-2 gap-1 rounded-[2px] border border-rule-strong bg-void p-0.5 font-mono text-[10px]"
              >
                {(["vectors", "tokens"] as const).map((metric) => {
                  const active = clusterSizeMetric === metric;
                  return (
                    <button
                      key={metric}
                      type="button"
                      onClick={() => onSelectSizeMetric(metric)}
                      aria-pressed={active}
                      className={`rounded-[1px] px-2 py-1 uppercase tracking-[0.08em] transition-colors focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none ${
                        active
                          ? "bg-cobalt font-semibold text-bone"
                          : "text-bone-muted hover:bg-surface-2 hover:text-bone"
                      }`}
                    >
                      {t(`brain.clusterMetric.${metric}`)}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        ))}
    </aside>
  );
}
