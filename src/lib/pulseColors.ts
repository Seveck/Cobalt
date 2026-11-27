import type { TelemetryOperation, ThemePalette } from "@/types/contracts";

/** Bright, high-contrast default pulse colors matching `cobalt-minimal`. */
export const BRIGHT_OPERATION_COLORS: Record<TelemetryOperation, string> = {
  read: "#60A5FA",
  reuse: "#A78BFA",
  write: "#34D399",
  update: "#FBBF24",
  handoff: "#38BDF8",
  blocked_firewall: "#F87171",
};

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseHexRgb(hex: string): Rgb | null {
  const clean = hex.trim().replace(/^#/, "");
  if (clean.length === 3) {
    const r = Number.parseInt(clean[0]! + clean[0]!, 16);
    const g = Number.parseInt(clean[1]! + clean[1]!, 16);
    const b = Number.parseInt(clean[2]! + clean[2]!, 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
    return { r, g, b };
  }
  if (clean.length >= 6) {
    const r = Number.parseInt(clean.slice(0, 2), 16);
    const g = Number.parseInt(clean.slice(2, 4), 16);
    const b = Number.parseInt(clean.slice(4, 6), 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
    return { r, g, b };
  }
  return null;
}

function rgbToHex({ r, g, b }: Rgb): string {
  const toByte = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`.toUpperCase();
}

function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) * 0.5;
  if (max === min) {
    return { h: 0, s: 0, l };
  }
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) {
    h = (gn - bn) / d + (gn < bn ? 6 : 0);
  } else if (max === gn) {
    h = (bn - rn) / d + 2;
  } else {
    h = (rn - gn) / d + 4;
  }
  return { h: h / 6, s, l };
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  if (s === 0) {
    const v = l * 255;
    return { r: v, g: v, b: v };
  }
  const hue2rgb = (p: number, q: number, tInput: number) => {
    let t = tInput;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: hue2rgb(p, q, h + 1 / 3) * 255,
    g: hue2rgb(p, q, h) * 255,
    b: hue2rgb(p, q, h - 1 / 3) * 255,
  };
}

/**
 * Resolve the operation pulse color from the active theme's palette, falling back
 * to Cobalt's high-contrast defaults.
 */
export function resolveOperationPulseColor(
  operation: TelemetryOperation,
  palette?: ThemePalette | null,
): string {
  if (palette) {
    switch (operation) {
      case "read":
        return palette.pulse_read || BRIGHT_OPERATION_COLORS.read;
      case "reuse":
        return palette.pulse_reuse || BRIGHT_OPERATION_COLORS.reuse;
      case "write":
        return palette.pulse_write || BRIGHT_OPERATION_COLORS.write;
      case "update":
        return palette.pulse_update || BRIGHT_OPERATION_COLORS.update;
      case "blocked_firewall":
        return palette.pulse_blocked || BRIGHT_OPERATION_COLORS.blocked_firewall;
      case "handoff":
        return BRIGHT_OPERATION_COLORS.handoff;
    }
  }
  return BRIGHT_OPERATION_COLORS[operation];
}

/**
 * Produce a luminous, high-visibility variant of a pulse color for rendering on dark
 * backgrounds: ensures dark colors are lifted first, then lightens ≥ 42% toward white
 * while keeping the operation hue crisp and distinguishable.
 */
export function toLuminousPulseHex(hex: string, lightenRatio = 0.44): string {
  const parsed = parseHexRgb(hex);
  if (!parsed) return "#A3CBFC";

  // Lift very dark theme colors (such as legacy #0047AB) before mixing toward white
  // so they become vivid luminous hues rather than washed-out grey.
  const hsl = rgbToHsl(parsed);
  const baseRgb =
    hsl.l < 0.6
      ? hslToRgb(hsl.h, Math.min(1, Math.max(hsl.s, 0.85)), 0.62)
      : parsed;

  const mix = Math.max(0.4, Math.min(0.75, lightenRatio));
  return rgbToHex({
    r: baseRgb.r + (255 - baseRgb.r) * mix,
    g: baseRgb.g + (255 - baseRgb.g) * mix,
    b: baseRgb.b + (255 - baseRgb.b) * mix,
  });
}

/** Convert a `#RRGGBB` hex color into an `rgba(r, g, b, alpha)` CSS string. */
export function hexToRgba(hex: string, alpha: number): string {
  const parsed = parseHexRgb(hex) ?? { r: 96, g: 165, b: 250 };
  const clamped = Math.max(0, Math.min(1, alpha));
  return `rgba(${parsed.r}, ${parsed.g}, ${parsed.b}, ${clamped})`;
}
