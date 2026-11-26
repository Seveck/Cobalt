import { useTranslation } from "react-i18next";
import { Boxes, Brain, GitFork, LayoutGrid, Layers, Sparkles } from "lucide-react";
import type { ClusterSizeMetric, LayoutType } from "@/types/contracts";
import { BUILTIN_LAYOUT_TYPES, type BuiltinLayoutType } from "./layouts";

interface LayoutSwitcherProps {
  activeLayout: LayoutType;
  clusterSizeMetric: ClusterSizeMetric;
  onSelectLayout: (layout: LayoutType) => void;
  onSelectSizeMetric: (metric: ClusterSizeMetric) => void;
}

const LAYOUT_ICONS: Record<BuiltinLayoutType, typeof Sparkles> = {
  galaxy: Sparkles,
  brain: Brain,
  neural_net: Layers,
  knowledge_tree: GitFork,
  project_clusters: Boxes,
  project_islands: LayoutGrid,
};

export function LayoutSwitcher({
  activeLayout,
  clusterSizeMetric,
  onSelectLayout,
  onSelectSizeMetric,
}: LayoutSwitcherProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <div
        role="group"
        aria-label={t("brain.layouts.label")}
        className="inline-flex items-center rounded-[2px] border border-rule-strong bg-surface/95 p-0.5"
      >
        {BUILTIN_LAYOUT_TYPES.map((layout) => {
          const Icon = LAYOUT_ICONS[layout];
          const active = activeLayout === layout;
          return (
            <button
              key={layout}
              type="button"
              onClick={() => onSelectLayout(layout)}
              aria-pressed={active}
              title={t(`brain.layouts.${layout}`)}
              className={`inline-flex items-center gap-1.5 rounded-[1px] px-2 py-1 font-mono text-[11px] transition-colors focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none ${
                active
                  ? "bg-cobalt-wash font-semibold text-cobalt-ink"
                  : "text-bone-muted hover:bg-surface-2 hover:text-bone"
              }`}
            >
              <Icon size={12} aria-hidden />
              <span className="hidden xl:inline">{t(`brain.layouts.${layout}`)}</span>
            </button>
          );
        })}
      </div>

      {activeLayout === "project_clusters" && (
        <div
          role="group"
          aria-label={t("brain.clusterMetric.label")}
          className="inline-flex items-center rounded-[2px] border border-cobalt-rule bg-surface/95 p-0.5 font-mono text-[10px]"
        >
          {(["vectors", "tokens"] as const).map((metric) => {
            const active = clusterSizeMetric === metric;
            return (
              <button
                key={metric}
                type="button"
                onClick={() => onSelectSizeMetric(metric)}
                aria-pressed={active}
                className={`rounded-[1px] px-2 py-1 uppercase tracking-[0.08em] transition-colors ${
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
      )}
    </div>
  );
}
