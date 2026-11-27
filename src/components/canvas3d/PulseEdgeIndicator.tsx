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

interface PulseEdgeIndicatorProps {
  summary: PulseVisibilitySummary | null;
  onFocusOffScreen: (ids: readonly Uuid[]) => void;
  onRevealFiltered: (ids: readonly Uuid[]) => void;
}

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
 * or hidden by Visual Filter Dock, so live activity is never silently invisible.
 */
export function PulseEdgeIndicator({
  summary,
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

  // Case 1: Off-screen nodes (pin to the edge pointing toward them)
  if (offScreenCount > 0 && edge) {
    const posStyle: CSSProperties =
      edge === "left"
        ? { left: "0.75rem", top: `${edgeOffset * 100}%`, transform: "translateY(-50%)" }
        : edge === "right"
          ? { right: "0.75rem", top: `${edgeOffset * 100}%`, transform: "translateY(-50%)" }
          : edge === "top"
            ? { top: "4rem", left: `${edgeOffset * 100}%`, transform: "translateX(-50%)" }
            : { bottom: "6.5rem", left: `${edgeOffset * 100}%`, transform: "translateX(-50%)" };

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
        style={{ borderColor, boxShadow: glowShadow }}
        className="pointer-events-auto absolute top-16 left-1/2 z-25 inline-flex -translate-x-1/2 items-center gap-2 rounded-[2px] border bg-surface/95 px-3 py-1.5 font-mono text-xs font-medium text-bone backdrop-blur-xs transition-transform hover:scale-[1.03] focus-visible:outline-none"
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
      style={{ borderColor, boxShadow: glowShadow }}
      className="pointer-events-none absolute top-16 left-1/2 z-25 inline-flex -translate-x-1/2 items-center gap-2 rounded-[2px] border bg-surface/95 px-3 py-1.5 font-mono text-xs font-medium text-bone backdrop-blur-xs"
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
