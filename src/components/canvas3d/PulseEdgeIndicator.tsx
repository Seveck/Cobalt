import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  EyeOff,
  FilterX,
} from "lucide-react";
import { hexToRgba, toLuminousPulseHex } from "@/lib/pulseColors";
import type { Uuid } from "@/types/contracts";
import type { PulseVisibilitySummary, ViewportEdge } from "./BrainScene";

export interface PulseIndicatorSafeInsets {
  /** Safe distance from top of viewport container (strictly below the top toolbar). */
  top: number;
  /** Safe distance from bottom of viewport container (strictly above FilterDock / TimeTravelBar). */
  bottom: number;
  /** Width of the 3D viewport container in CSS pixels. */
  containerWidth: number;
  /** Height of the 3D viewport container in CSS pixels. */
  containerHeight: number;
  /** Right boundary of the bottom-left SynapticHud (0 when HUD is hidden). */
  hudRight: number;
  /** Distance from container bottom to the top of SynapticHud (0 when HUD is hidden). */
  hudTopFromBottom: number;
}

interface PulseEdgeIndicatorProps {
  summary: PulseVisibilitySummary | null;
  safeInsets?: PulseIndicatorSafeInsets;
  onFocusOffScreen: (ids: readonly Uuid[]) => void;
  onRevealFiltered: (ids: readonly Uuid[]) => void;
}

const DEFAULT_SAFE_INSETS: PulseIndicatorSafeInsets = {
  top: 68,
  bottom: 72,
  containerWidth: 800,
  containerHeight: 600,
  hudRight: 0,
  hudTopFromBottom: 0,
};

const EDGE_MARGIN_PX = 12;
const BADGE_HALF_HEIGHT_PX = 18;
const BADGE_HALF_WIDTH_PX = 132;

function EdgeArrow({ edge, color }: { edge: ViewportEdge; color: string }) {
  const props = { size: 13, style: { color }, "aria-hidden": true as const, className: "shrink-0" };
  switch (edge) {
    case "top":
      return <ArrowUp {...props} />;
    case "bottom":
      return <ArrowDown {...props} />;
    case "left":
      return <ArrowLeft {...props} />;
    case "right":
      return <ArrowRight {...props} />;
  }
}

/**
 * Compact viewport-edge badge shown whenever active live AI pulses are off-screen
 * or hidden by Visual Filter Dock, positioned strictly inside the toolbar-free safe zone.
 */
export function PulseEdgeIndicator({
  summary,
  safeInsets = DEFAULT_SAFE_INSETS,
  onFocusOffScreen,
  onRevealFiltered,
}: PulseEdgeIndicatorProps) {
  const { t } = useTranslation();

  if (!summary) return null;

  const { offScreenCount, filteredOutCount, missingFromGraphCount, edge, edgeOffset } = summary;
  const totalOutOfView = offScreenCount + missingFromGraphCount;
  if (totalOutOfView === 0 && filteredOutCount === 0) return null;

  const luminous = toLuminousPulseHex(summary.colorHex, 0.42);
  const borderColor = hexToRgba(luminous, 0.72);
  const glowShadow = `0 0 18px ${hexToRgba(luminous, 0.4)}, 0 8px 24px rgba(0, 0, 0, 0.72)`;

  const safeTop = Math.max(56, Math.round(safeInsets.top));
  const safeBottom = Math.max(56, Math.round(safeInsets.bottom));
  const containerW = Math.max(320, safeInsets.containerWidth);
  const containerH = Math.max(240, safeInsets.containerHeight);
  const hudActive = safeInsets.hudTopFromBottom > 0;
  const minCenterX = Math.min(containerW * 0.5, BADGE_HALF_WIDTH_PX + EDGE_MARGIN_PX);
  const maxCenterX = Math.max(minCenterX, containerW - BADGE_HALF_WIDTH_PX - EDGE_MARGIN_PX);

  // Case 1: Off-screen nodes (pin to the edge pointing toward them, strictly outside toolbars/HUD)
  if (offScreenCount > 0 && edge) {
    let posStyle: CSSProperties;

    if (edge === "left" || edge === "right") {
      const sideBottom =
        edge === "left" && hudActive
          ? Math.max(safeBottom, Math.round(safeInsets.hudTopFromBottom) + EDGE_MARGIN_PX)
          : safeBottom;
      const minY = safeTop + BADGE_HALF_HEIGHT_PX;
      const maxY = Math.max(minY, containerH - sideBottom - BADGE_HALF_HEIGHT_PX);
      const tNorm = Math.max(0, Math.min(1, (edgeOffset - 0.2) / (0.78 - 0.2)));
      const topPx = Math.round(minY + tNorm * (maxY - minY));
      posStyle =
        edge === "left"
          ? { left: "0.75rem", top: `${topPx}px`, transform: "translateY(-50%)" }
          : { right: "0.75rem", top: `${topPx}px`, transform: "translateY(-50%)" };
    } else if (edge === "top") {
      const centerX = Math.round(
        Math.max(minCenterX, Math.min(maxCenterX, edgeOffset * containerW)),
      );
      posStyle = {
        top: `${safeTop}px`,
        left: `${centerX}px`,
        transform: "translateX(-50%)",
      };
    } else {
      // Bottom edge: clear both FilterDock/TimeTravelBar and the bottom-left SynapticHud
      if (hudActive) {
        const rightLaneMinX = safeInsets.hudRight + EDGE_MARGIN_PX + BADGE_HALF_WIDTH_PX;
        if (maxCenterX >= rightLaneMinX) {
          const centerX = Math.round(
            Math.max(rightLaneMinX, Math.min(maxCenterX, edgeOffset * containerW)),
          );
          posStyle = {
            bottom: `${safeBottom}px`,
            left: `${centerX}px`,
            transform: "translateX(-50%)",
          };
        } else {
          const maxLift = Math.max(safeBottom, containerH - safeTop - BADGE_HALF_HEIGHT_PX * 2);
          const liftedBottom = Math.min(
            Math.max(safeBottom, Math.round(safeInsets.hudTopFromBottom) + EDGE_MARGIN_PX),
            maxLift,
          );
          posStyle = {
            bottom: `${liftedBottom}px`,
            left: "50%",
            transform: "translateX(-50%)",
          };
        }
      } else {
        const centerX = Math.round(
          Math.max(minCenterX, Math.min(maxCenterX, edgeOffset * containerW)),
        );
        posStyle = {
          bottom: `${safeBottom}px`,
          left: `${centerX}px`,
          transform: "translateX(-50%)",
        };
      }
    }

    return (
      <button
        type="button"
        onClick={() => onFocusOffScreen(summary.offScreenIds)}
        title={t("synaptic.focusOffScreenHint")}
        style={{
          ...posStyle,
          borderColor,
          boxShadow: glowShadow,
        }}
        className="pointer-events-auto absolute z-25 inline-flex items-center gap-2 rounded-[2px] border bg-surface/95 px-3 py-1.5 font-mono text-xs font-medium text-bone backdrop-blur-xs transition-transform hover:scale-[1.03] focus-visible:outline-none"
      >
        {(edge === "left" || edge === "top") && <EdgeArrow edge={edge} color={luminous} />}
        <span
          className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full"
          style={{
            backgroundColor: luminous,
            boxShadow: `0 0 10px ${luminous}`,
          }}
          aria-hidden
        />
        <span className="whitespace-nowrap">
          {t("synaptic.outOfView", { count: totalOutOfView })}
        </span>
        {filteredOutCount > 0 && (
          <span className="whitespace-nowrap text-[11px] text-bone-muted">
            · {t("synaptic.filteredSuffix", { count: filteredOutCount })}
          </span>
        )}
        {(edge === "right" || edge === "bottom") && <EdgeArrow edge={edge} color={luminous} />}
      </button>
    );
  }

  // Case 2: All hidden pulsing nodes are filtered out by Visual Filter Dock
  if (filteredOutCount > 0) {
    return (
      <button
        type="button"
        onClick={() => onRevealFiltered(summary.filteredOutIds)}
        title={t("synaptic.clearFiltersHint")}
        style={{ top: `${safeTop}px`, borderColor, boxShadow: glowShadow }}
        className="pointer-events-auto absolute left-1/2 z-25 inline-flex -translate-x-1/2 items-center gap-2 rounded-[2px] border bg-surface/95 px-3 py-1.5 font-mono text-xs font-medium text-bone backdrop-blur-xs transition-transform hover:scale-[1.03] focus-visible:outline-none"
      >
        <span
          className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full"
          style={{
            backgroundColor: luminous,
            boxShadow: `0 0 10px ${luminous}`,
          }}
          aria-hidden
        />
        <FilterX size={13} style={{ color: luminous }} aria-hidden />
        <span className="whitespace-nowrap">
          {t("synaptic.filteredOut", { count: filteredOutCount })}
        </span>
      </button>
    );
  }

  // Case 3: Nodes exist in activity payload but are outside the loaded branch/graph
  return (
    <div
      style={{ top: `${safeTop}px`, borderColor, boxShadow: glowShadow }}
      className="pointer-events-none absolute left-1/2 z-25 inline-flex -translate-x-1/2 items-center gap-2 rounded-[2px] border bg-surface/95 px-3 py-1.5 font-mono text-xs font-medium text-bone backdrop-blur-xs"
    >
      <span
        className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full"
        style={{
          backgroundColor: luminous,
          boxShadow: `0 0 10px ${luminous}`,
        }}
        aria-hidden
      />
      <EyeOff size={13} style={{ color: luminous }} aria-hidden />
      <span className="whitespace-nowrap">
        {t("synaptic.outOfView", { count: totalOutOfView })}
      </span>
    </div>
  );
}
