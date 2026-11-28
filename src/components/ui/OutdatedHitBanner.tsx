import { useTranslation } from "react-i18next";
import { AlertTriangle, ArrowUpRight } from "lucide-react";
import { truncateMemoryPreview } from "@/lib/projects";
import type { Uuid } from "@/types/contracts";

export interface OutdatedHitBannerProps {
  outrankedById: Uuid;
  winnerPreview?: string | null;
  onOpenWinner: (winnerId: Uuid) => void;
  compact?: boolean;
}

/**
 * Marks a search result contradicted by a more authoritative memory (`SearchHit.outranked_by`,
 * contract v1.16.0: project > global, newer > older) with a direct link to the winning memory.
 */
export function OutdatedHitBanner({
  outrankedById,
  winnerPreview,
  onOpenWinner,
  compact = false,
}: OutdatedHitBannerProps) {
  const { t } = useTranslation();

  const targetText = winnerPreview
    ? truncateMemoryPreview(winnerPreview, compact ? 34 : 52)
    : outrankedById.slice(0, 8);

  if (compact) {
    return (
      <div
        title={t("outdated.tooltip")}
        className="mt-1 flex flex-wrap items-center justify-between gap-1.5 rounded-[2px] border border-ochre-rule/80 bg-ochre-wash/80 px-1.5 py-1 font-mono text-[10px] text-ochre"
      >
        <span className="inline-flex items-center gap-1 font-medium">
          <AlertTriangle size={10} className="shrink-0" aria-hidden />
          <span>{t("outdated.badge")}</span>
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenWinner(outrankedById);
          }}
          title={winnerPreview ?? outrankedById}
          className="inline-flex max-w-full items-center gap-0.5 truncate text-cobalt-ink underline-offset-2 hover:underline focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none"
        >
          <span className="truncate">{t("outdated.viewWinnerShort", { target: targetText })}</span>
          <ArrowUpRight size={10} className="shrink-0" aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <div
      title={t("outdated.tooltip")}
      className="flex flex-wrap items-center justify-between gap-2 rounded-[2px] border border-ochre-rule bg-ochre-wash/85 px-2.5 py-1.5 text-[11px] text-ochre"
    >
      <span className="inline-flex items-center gap-1.5 font-mono text-[10px] font-semibold">
        <AlertTriangle size={11} className="shrink-0" aria-hidden />
        <span>{t("outdated.badge")}</span>
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onOpenWinner(outrankedById);
        }}
        title={winnerPreview ?? outrankedById}
        className="inline-flex max-w-full items-center gap-1 rounded-[2px] border border-ochre-rule/70 bg-surface/90 px-2 py-0.5 font-mono text-[10px] font-medium text-bone transition-colors hover:border-cobalt-ink hover:text-cobalt-ink focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none"
      >
        <span className="max-w-[210px] truncate">
          {t("outdated.viewWinner", { target: targetText })}
        </span>
        <ArrowUpRight size={11} className="shrink-0 text-cobalt-ink" aria-hidden />
      </button>
    </div>
  );
}
