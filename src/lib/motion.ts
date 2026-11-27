import type { CSSProperties } from "react";

const MAX_STAGGER_STEP_MS = 30;
const DEFAULT_STAGGER_STEP_MS = 24;
const DEFAULT_STAGGER_CAP_ITEMS = 10;

/**
 * Computes a capped CSS custom-property delay (`--cobalt-stagger-delay`) for
 * GPU-only staggered list & card enter animations (`.cobalt-stagger-item`).
 * Step is capped at <= 30 ms per item and capped at `maxItems` so long lists
 * remain crisp and responsive.
 */
export function staggerStyle(
  index: number,
  stepMs: number = DEFAULT_STAGGER_STEP_MS,
  maxItems: number = DEFAULT_STAGGER_CAP_ITEMS,
): CSSProperties {
  const safeStep = Math.max(0, Math.min(MAX_STAGGER_STEP_MS, stepMs));
  const clampedIdx = Math.max(0, Math.min(index, maxItems));
  return {
    "--cobalt-stagger-delay": `${clampedIdx * safeStep}ms`,
  } as CSSProperties;
}
