import { useTranslation } from "react-i18next";
import { Pin, Repeat } from "lucide-react";
import type { GraphNode, Project } from "@/types/contracts";

export interface TooltipPointer {
  x: number;
  y: number;
}

interface NodeTooltipProps {
  node: GraphNode;
  project: Project | null;
  pointer: TooltipPointer;
  containerWidth: number;
  containerHeight: number;
}

export function NodeTooltip({
  node,
  project,
  pointer,
  containerWidth,
  containerHeight,
}: NodeTooltipProps) {
  const { t } = useTranslation();

  const tooltipWidth = 288;
  const tooltipHeight = 148;
  const offset = 16;

  const left =
    pointer.x + offset + tooltipWidth > containerWidth
      ? Math.max(12, pointer.x - tooltipWidth - offset)
      : pointer.x + offset;

  const top =
    pointer.y + offset + tooltipHeight > containerHeight
      ? Math.max(12, pointer.y - tooltipHeight - offset)
      : pointer.y + offset;

  return (
    <div
      style={{ transform: `translate3d(${left}px, ${top}px, 0)` }}
      className="pointer-events-none absolute top-0 left-0 z-20 w-72 rounded-xl border border-white/15 bg-void/95 p-3 shadow-2xl backdrop-blur-md"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: project?.color_hex ?? "#94A3B8" }}
          />
          <span className="truncate text-xs font-medium text-slate-300">
            {project ? project.name : t("brain.globalScope")}
          </span>
        </div>

        <span className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] uppercase text-slate-300">
          {node.source_type}
        </span>
      </div>

      <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-slate-100">{node.preview}</p>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[10px]">
        <span className="rounded bg-cobalt-600/30 px-1.5 py-0.5 font-medium text-cobalt-300">
          {t(`categories.${node.category}`)}
        </span>

        {node.is_core_pin && (
          <span className="inline-flex items-center gap-1 rounded bg-amber-400/20 px-1.5 py-0.5 font-medium text-amber-300">
            <Pin size={10} aria-hidden />
            {t("brain.corePin")}
          </span>
        )}

        {node.is_reusable && (
          <span className="inline-flex items-center gap-1 rounded bg-violet-500/20 px-1.5 py-0.5 font-medium text-violet-300">
            <Repeat size={10} aria-hidden />
            {t("brain.reusable")}
          </span>
        )}
      </div>

      <div className="mt-2 flex items-center justify-between border-t border-white/10 pt-2 font-mono text-[10px] text-slate-400">
        <span>{t("brain.hits", { count: node.hit_count })}</span>
        <span>{t("brain.tokens", { count: node.chunk_tokens })}</span>
        <span>{t("brain.confidence", { value: Math.round(node.confidence * 100) })}</span>
      </div>
    </div>
  );
}
