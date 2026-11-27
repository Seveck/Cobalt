import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export interface TooltipAnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export interface TooltipPosition {
  left: number;
  top: number;
  placement: "top" | "bottom";
}

export interface StatsTooltipProps {
  /** Optional DOM id so the trigger element can reference it via `aria-describedby`. */
  id?: string;
  /** Viewport bounding rect of the hovered/focused anchor element, or `null` when hidden. */
  anchorRect: TooltipAnchorRect | null;
  /** Content rendered inside the floating tooltip. */
  content: ReactNode;
  /** Called on scroll, window resize, or Escape so the owner clears its active target. */
  onDismiss?: () => void;
  /** Maximum width in pixels before text wraps onto multiple lines (default `280`). */
  maxWidth?: number;
  /** Minimum margin from every viewport edge in pixels (default `8`). */
  viewportPadding?: number;
  /** Gap between the anchor element and the tooltip in pixels (default `8`). */
  offset?: number;
}

/** Snapshot an element's viewport rect into a plain serializable object. */
export function readAnchorRect(element: Element): TooltipAnchorRect {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

/**
 * Pure collision-aware tooltip placement in viewport coordinates:
 * - Horizontally centered over the anchor, clamped to stay `>= viewportPadding` inside both edges.
 * - Vertically prefers above the anchor, flips below near the top edge, and clamps if constrained.
 */
export function computeTooltipPosition(
  anchor: TooltipAnchorRect,
  tooltipWidth: number,
  tooltipHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  viewportPadding = 8,
  offset = 8,
): TooltipPosition {
  const anchorCenterX = anchor.left + anchor.width / 2;
  const idealLeft = anchorCenterX - tooltipWidth / 2;
  const maxLeft = Math.max(viewportPadding, viewportWidth - viewportPadding - tooltipWidth);
  const left = Math.round(Math.min(Math.max(idealLeft, viewportPadding), maxLeft));

  const topAbove = anchor.top - offset - tooltipHeight;
  const topBelow = anchor.bottom + offset;
  const fitsAbove = topAbove >= viewportPadding;
  const fitsBelow = topBelow + tooltipHeight <= viewportHeight - viewportPadding;

  let placement: "top" | "bottom";
  let rawTop: number;

  if (fitsAbove) {
    placement = "top";
    rawTop = topAbove;
  } else if (fitsBelow) {
    placement = "bottom";
    rawTop = topBelow;
  } else {
    const spaceAbove = anchor.top;
    const spaceBelow = viewportHeight - anchor.bottom;
    if (spaceAbove >= spaceBelow) {
      placement = "top";
      rawTop = topAbove;
    } else {
      placement = "bottom";
      rawTop = topBelow;
    }
  }

  const maxTop = Math.max(viewportPadding, viewportHeight - viewportPadding - tooltipHeight);
  const top = Math.round(Math.min(Math.max(rawTop, viewportPadding), maxTop));

  return { left, top, placement };
}

function getViewportSize(): { width: number; height: number } {
  if (typeof window === "undefined") {
    return { width: 1024, height: 768 };
  }
  const width = document.documentElement.clientWidth || window.innerWidth;
  const height = document.documentElement.clientHeight || window.innerHeight;
  return { width, height };
}

/**
 * Portal-rendered, collision-aware floating tooltip for statistics charts.
 * Mounted directly on `document.body` so ancestor `overflow` or scroll containers never clip it.
 */
export function StatsTooltip({
  id,
  anchorRect,
  content,
  onDismiss,
  maxWidth = 280,
  viewportPadding = 8,
  offset = 8,
}: StatsTooltipProps) {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<TooltipPosition | null>(null);

  const isVisible = anchorRect !== null && content !== null && content !== undefined && content !== "";

  useLayoutEffect(() => {
    if (!isVisible || !anchorRect || !tooltipRef.current) {
      setPosition(null);
      return;
    }

    const { width, height } = tooltipRef.current.getBoundingClientRect();
    const viewport = getViewportSize();
    const next = computeTooltipPosition(
      anchorRect,
      width,
      height,
      viewport.width,
      viewport.height,
      viewportPadding,
      offset,
    );

    setPosition((prev) =>
      prev &&
      prev.left === next.left &&
      prev.top === next.top &&
      prev.placement === next.placement
        ? prev
        : next,
    );
  }, [anchorRect, content, isVisible, maxWidth, offset, viewportPadding]);

  useEffect(() => {
    if (!isVisible || !onDismiss) return;

    const handleScroll = () => onDismiss();
    const handleResize = () => onDismiss();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onDismiss();
      }
    };

    // Capture phase catches scroll events from any scrollable ancestor (horizontal or vertical).
    window.addEventListener("scroll", handleScroll, { capture: true, passive: true });
    window.addEventListener("resize", handleResize, { passive: true });
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("scroll", handleScroll, { capture: true });
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isVisible, onDismiss]);

  if (!isVisible || typeof document === "undefined") {
    return null;
  }

  const viewport = getViewportSize();
  const effectiveMaxWidth = Math.max(
    120,
    Math.min(maxWidth, viewport.width - viewportPadding * 2),
  );

  return createPortal(
    <div
      ref={tooltipRef}
      id={id}
      role="tooltip"
      data-placement={position?.placement ?? "top"}
      className="pointer-events-none fixed left-0 top-0 z-[60] w-max whitespace-normal break-words rounded-[2px] border border-rule-strong bg-void/95 px-2.5 py-1.5 font-mono text-[11px] leading-snug text-bone shadow-[0_10px_28px_rgba(0,0,0,0.72)]"
      style={{
        maxWidth: effectiveMaxWidth,
        transform: position
          ? `translate3d(${position.left}px, ${position.top}px, 0)`
          : "translate3d(-9999px, -9999px, 0)",
        visibility: position ? "visible" : "hidden",
      }}
    >
      {content}
    </div>,
    document.body,
  );
}
