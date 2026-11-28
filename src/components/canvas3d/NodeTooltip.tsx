import { useTranslation } from "react-i18next";
import { Folder, FolderCode, Globe, Inbox, Pin, Repeat } from "lucide-react";
import { isCodeProject, isUnsortedProject, resolveProjectColor } from "@/lib/projects";
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
      // Whole-pixel left/top (no translate3d): a GPU-composited layer at fractional
      // offsets renders blurry text in WebKitGTK.
      style={{ left: Math.round(left), top: Math.round(top) }}
      className="pointer-events-none absolute z-20 w-72 rounded-[2px] border border-rule-strong border-t-2 border-t-cobalt bg-surface p-3 shadow-[0_12px_32px_rgba(0,0,0,0.72)]"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className="h-2 w-2 shrink-0 rounded-[1px]"
            style={{ backgroundColor: resolveProjectColor(project) }}
          />
          {!project ? (
            <Globe size={11} className="shrink-0 text-bone-subtle" aria-hidden />
          ) : isUnsortedProject(project) ? (
            <Inbox size={11} className="shrink-0 text-bone-subtle" aria-hidden />
          ) : isCodeProject(project) ? (
            <FolderCode size={11} className="shrink-0 text-bone-subtle" aria-hidden />
          ) : (
            <Folder size={11} className="shrink-0 text-bone-subtle" aria-hidden />
          )}
          <span
            className={`truncate font-mono text-[11px] font-medium ${
              isUnsortedProject(project) ? "text-bone-subtle italic" : "text-bone-muted"
            }`}
          >
            {project ? project.name : t("brain.globalScope")}
          </span>
        </div>

        <span className="shrink-0 rounded-[2px] border border-rule bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] uppercase text-bone-muted">
          {node.source_type}
        </span>
      </div>

      <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-bone">{node.preview}</p>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 font-mono text-[10px]">
        <span className="rounded-[2px] border border-cobalt-rule bg-cobalt-wash px-1.5 py-0.5 font-medium text-cobalt-ink">
          {t(`categories.${node.category}`)}
        </span>

        {node.is_core_pin && (
          <span className="inline-flex items-center gap-1 rounded-[2px] border border-ochre-rule bg-ochre-wash px-1.5 py-0.5 font-medium text-ochre">
            <Pin size={10} aria-hidden />
            {t("brain.corePin")}
          </span>
        )}

        {node.is_reusable && (
          <span className="inline-flex items-center gap-1 rounded-[2px] border border-pulse-reuse/40 bg-pulse-reuse/15 px-1.5 py-0.5 font-medium text-pulse-reuse">
            <Repeat size={10} aria-hidden />
            {t("brain.reusable")}
          </span>
        )}
      </div>

      <div className="mt-2.5 flex items-center justify-between border-t border-rule pt-2 font-mono text-[10px] tabular-nums text-bone-subtle">
        <span>{t("brain.hits", { count: node.hit_count })}</span>
        <span>{t("brain.tokens", { count: node.chunk_tokens })}</span>
        <span>{t("brain.confidence", { value: Math.round(node.confidence * 100) })}</span>
      </div>
    </div>
  );
}
