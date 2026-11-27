import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "@/lib/usePrefersReducedMotion";

const DEFAULT_COUNT_UP_MS = 460;

/**
 * Smoothly counts an integer value from its previous value (starting at 0 on mount)
 * to `target` using `requestAnimationFrame` with ease-out cubic easing.
 * Immediately snaps to `target` when Reduced motion or `prefers-reduced-motion` is active.
 */
export function useCountUp(target: number, durationMs: number = DEFAULT_COUNT_UP_MS): number {
  const reducedMotion = usePrefersReducedMotion();
  const safeTarget = Number.isFinite(target) ? Math.round(target) : 0;

  const [display, setDisplay] = useState<number>(() => (reducedMotion ? safeTarget : 0));
  const currentRef = useRef<number>(reducedMotion ? safeTarget : 0);

  useEffect(() => {
    if (reducedMotion || durationMs <= 0) {
      currentRef.current = safeTarget;
      setDisplay(safeTarget);
      return;
    }

    const from = currentRef.current;
    if (from === safeTarget) {
      setDisplay(safeTarget);
      return;
    }

    let rafId = 0;
    const startTs = performance.now();

    const step = (now: number) => {
      const elapsed = now - startTs;
      const progress = Math.min(1, elapsed / durationMs);
      const eased = 1 - Math.pow(1 - progress, 3);
      const next = Math.round(from + (safeTarget - from) * eased);
      if (next !== currentRef.current) {
        currentRef.current = next;
        setDisplay(next);
      }
      if (progress < 1) {
        rafId = window.requestAnimationFrame(step);
      } else {
        currentRef.current = safeTarget;
        setDisplay(safeTarget);
      }
    };

    rafId = window.requestAnimationFrame(step);
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [durationMs, reducedMotion, safeTarget]);

  return display;
}

export interface AnimatedNumberProps {
  value: number;
  format?: (value: number) => string;
  durationMs?: number;
  className?: string;
}

export function AnimatedNumber({
  value,
  format,
  durationMs = DEFAULT_COUNT_UP_MS,
  className,
}: AnimatedNumberProps) {
  const animated = useCountUp(value, durationMs);
  const text = format ? format(animated) : animated.toLocaleString();
  return <span className={className}>{text}</span>;
}
