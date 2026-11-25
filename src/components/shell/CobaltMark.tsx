interface CobaltMarkProps {
  size?: number;
  className?: string;
}

/**
 * Geometric hexagonal mineral emblem for Cobalt (Co · 27).
 * Rendered with crisp vector facets — no glow filters or gradients.
 */
export function CobaltMark({ size = 20, className = "" }: CobaltMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={className}
    >
      <polygon
        points="12,1.75 20.88,6.88 20.88,17.12 12,22.25 3.12,17.12 3.12,6.88"
        fill="#0047AB"
        stroke="#79A8FF"
        strokeWidth="1.25"
      />
      <polyline
        points="3.12,6.88 12,12 20.88,6.88"
        stroke="#ECE9E1"
        strokeWidth="1.15"
        strokeOpacity="0.85"
      />
      <line
        x1="12"
        y1="12"
        x2="12"
        y2="22.25"
        stroke="#ECE9E1"
        strokeWidth="1.15"
        strokeOpacity="0.85"
      />
      <rect x="10.25" y="10.25" width="3.5" height="3.5" fill="#ECE9E1" />
    </svg>
  );
}
