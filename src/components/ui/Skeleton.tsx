export interface SkeletonProps {
  className?: string;
}

/**
 * GPU-composited shimmer placeholder (`transform` only, no layout thrash).
 * Automatically becomes static under Reduced motion / `prefers-reduced-motion`.
 */
export function Skeleton({ className = "h-4 w-full" }: SkeletonProps) {
  return <div aria-hidden="true" className={`cobalt-skeleton rounded-[2px] ${className}`} />;
}
