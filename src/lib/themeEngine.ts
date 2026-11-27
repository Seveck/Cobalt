import {
  BUILTIN_THEME_IDS,
  type ThemeManifest,
  type ThemePalette,
  type ThemeUi,
} from "@/types/contracts";

const BUILTIN_THEME_ID_SET: ReadonlySet<string> = new Set(BUILTIN_THEME_IDS);

/** True for any theme bundled with Cobalt (always installed, never uninstallable). */
export function isBuiltinThemeId(themeId: string): boolean {
  return BUILTIN_THEME_ID_SET.has(themeId);
}

export interface GeneratedUiTokens {
  mode: "light" | "dark";
  void: string;
  sidebar: string;
  surface: string;
  surface2: string;
  surface3: string;
  rule: string;
  ruleStrong: string;
  bone: string;
  boneMuted: string;
  boneSubtle: string;
  cobalt: string;
  cobaltBright: string;
  cobaltInk: string;
  cobaltWash: string;
  cobaltRule: string;
  onAccent: string;
  ochre: string;
  ochreWash: string;
  ochreRule: string;
  verdigris: string;
  verdigrisWash: string;
  verdigrisRule: string;
  cinnabar: string;
  cinnabarWash: string;
  cinnabarRule: string;
  radiusPx: number;
  radiusSmPx: number;
  densityScale: number;
  spacingRem: string;
  cssVars: Record<string, string>;
}

const MANAGED_CSS_VARS = [
  "--color-void",
  "--color-sidebar",
  "--color-surface",
  "--color-surface-2",
  "--color-surface-3",
  "--color-bone",
  "--color-bone-muted",
  "--color-bone-subtle",
  "--color-rule",
  "--color-rule-strong",
  "--color-cobalt",
  "--color-cobalt-bright",
  "--color-cobalt-ink",
  "--color-cobalt-wash",
  "--color-cobalt-rule",
  "--color-on-accent",
  "--color-ochre",
  "--color-ochre-wash",
  "--color-ochre-rule",
  "--color-verdigris",
  "--color-verdigris-wash",
  "--color-verdigris-rule",
  "--color-cinnabar",
  "--color-cinnabar-wash",
  "--color-cinnabar-rule",
  "--color-pulse-read",
  "--color-pulse-reuse",
  "--color-pulse-write",
  "--color-pulse-update",
  "--color-pulse-blocked",
  "--heatmap-0-fill",
  "--heatmap-0-border",
  "--heatmap-1-fill",
  "--heatmap-1-border",
  "--heatmap-2-fill",
  "--heatmap-2-border",
  "--heatmap-3-fill",
  "--heatmap-3-border",
  "--heatmap-4-fill",
  "--heatmap-4-border",
  "--cobalt-radius",
  "--cobalt-radius-sm",
  "--cobalt-density",
  "--cobalt-shadow-elevated",
  "--spacing",
] as const;

const DENSITY_CONFIG: Record<ThemeUi["density"], { scale: number; spacingRem: string }> = {
  compact: { scale: 0.85, spacingRem: "0.225rem" },
  comfortable: { scale: 1.0, spacingRem: "0.25rem" },
  spacious: { scale: 1.15, spacingRem: "0.27rem" },
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function normalizeHex(hex: string, fallback = "#3D6EF0"): string {
  const clean = hex.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(clean)) return clean;
  if (/^#[0-9a-fA-F]{3}$/.test(clean)) {
    return `#${clean[1]}${clean[1]}${clean[2]}${clean[2]}${clean[3]}${clean[3]}`;
  }
  return fallback;
}

/** Relative WCAG luminance [0..1] of a #RRGGBB color. */
function hexRelativeLuminance(hex: string): number {
  const clean = normalizeHex(hex).slice(1);
  const channels = [
    Number.parseInt(clean.slice(0, 2), 16) / 255,
    Number.parseInt(clean.slice(2, 4), 16) / 255,
    Number.parseInt(clean.slice(4, 6), 16) / 255,
  ].map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

/**
 * Generate the complete Cobalt app-chrome token set from `ThemeUi` in OKLCH
 * (THEME_SPEC §3.1 + approved style-lab generator).
 */
export function generateThemeUiTokens(
  ui: ThemeUi,
  palette?: ThemePalette | null,
): GeneratedUiTokens {
  const dark = ui.mode === "dark";
  const h = Math.round(clamp(ui.base_hue, 0, 360));
  const tint = clamp(ui.base_tint, 0, 100);
  const contrast = clamp(ui.contrast, 0, 100);
  const radiusPx = Math.round(clamp(ui.radius, 0, 16));
  const radiusSmPx = radiusPx <= 2 ? 1 : Math.max(2, radiusPx - 2);
  const density = DENSITY_CONFIG[ui.density] ?? DENSITY_CONFIG.comfortable;

  const c = 0.004 + (tint / 100) * 0.045;
  const k = contrast / 100;

  const L: [number, number, number, number] = dark
    ? [0.17 - 0.04 * k, 0.21 - 0.03 * k, 0.25 - 0.02 * k, 0.30 - 0.01 * k]
    : [0.975, 0.995, 0.955, 0.93 - 0.02 * k];

  const fgL = dark ? 0.90 + 0.07 * k : 0.27 - 0.12 * k;
  const mutedL = dark ? 0.68 + 0.06 * k : 0.47 - 0.08 * k;
  const subtleL = dark ? 0.52 : 0.62;
  const sideL = dark ? Math.max(0.08, L[0] - 0.01) : 0.955;
  const ruleL = dark ? L[2] + 0.02 : 0.90;
  const ruleStrongL = dark ? Math.min(0.46, L[3] + 0.06) : Math.max(0.74, 0.82 - 0.04 * k);

  const ok = (l: number, cc = c) => `oklch(${l.toFixed(3)} ${cc.toFixed(3)} ${h})`;

  const bgVoid = ok(L[0]);
  const sidebar = ok(sideL);
  const surface = ok(L[1]);
  const surface2 = ok(L[2]);
  const surface3 = ok(L[3]);
  const rule = ok(ruleL, c * 0.8);
  const ruleStrong = ok(ruleStrongL, c * 0.9);
  const bone = ok(fgL, c * 0.5);
  const boneMuted = ok(mutedL, c * 0.7);
  const boneSubtle = ok(subtleL, c * 0.6);

  const accent = normalizeHex(ui.accent);
  const onAccent = hexRelativeLuminance(accent) > 0.45 ? "#111317" : "#ffffff";
  const cobaltBright = dark
    ? `color-mix(in oklch, ${accent} 86%, white)`
    : `color-mix(in oklch, ${accent} 88%, black)`;
  const cobaltInk = dark
    ? `color-mix(in oklch, ${accent} 68%, white)`
    : `color-mix(in oklch, ${accent} 86%, black)`;
  const cobaltWash = dark
    ? `color-mix(in oklch, ${accent} 18%, ${surface})`
    : `color-mix(in oklch, ${accent} 12%, ${surface})`;
  const cobaltRule = dark
    ? `color-mix(in oklch, ${accent} 48%, ${surface2})`
    : `color-mix(in oklch, ${accent} 36%, ${rule})`;

  const ochre = dark ? "#d4a359" : "oklch(0.560 0.130 68)";
  const ochreWash = dark
    ? `color-mix(in oklch, ${ochre} 16%, ${surface})`
    : `color-mix(in oklch, ${ochre} 12%, ${surface})`;
  const ochreRule = dark
    ? `color-mix(in oklch, ${ochre} 44%, ${surface2})`
    : `color-mix(in oklch, ${ochre} 36%, ${rule})`;

  const verdigris = dark ? "#34b37e" : "oklch(0.500 0.130 160)";
  const verdigrisWash = dark
    ? `color-mix(in oklch, ${verdigris} 16%, ${surface})`
    : `color-mix(in oklch, ${verdigris} 12%, ${surface})`;
  const verdigrisRule = dark
    ? `color-mix(in oklch, ${verdigris} 44%, ${surface2})`
    : `color-mix(in oklch, ${verdigris} 36%, ${rule})`;

  const cinnabar = dark ? "#e05252" : "oklch(0.530 0.190 25)";
  const cinnabarWash = dark
    ? `color-mix(in oklch, ${cinnabar} 16%, ${surface})`
    : `color-mix(in oklch, ${cinnabar} 11%, ${surface})`;
  const cinnabarRule = dark
    ? `color-mix(in oklch, ${cinnabar} 44%, ${surface2})`
    : `color-mix(in oklch, ${cinnabar} 36%, ${rule})`;

  const cssVars: Record<string, string> = {
    "--color-void": bgVoid,
    "--color-sidebar": sidebar,
    "--color-surface": surface,
    "--color-surface-2": surface2,
    "--color-surface-3": surface3,
    "--color-bone": bone,
    "--color-bone-muted": boneMuted,
    "--color-bone-subtle": boneSubtle,
    "--color-rule": rule,
    "--color-rule-strong": ruleStrong,
    "--color-cobalt": accent,
    "--color-cobalt-bright": cobaltBright,
    "--color-cobalt-ink": cobaltInk,
    "--color-cobalt-wash": cobaltWash,
    "--color-cobalt-rule": cobaltRule,
    "--color-on-accent": onAccent,
    "--color-ochre": ochre,
    "--color-ochre-wash": ochreWash,
    "--color-ochre-rule": ochreRule,
    "--color-verdigris": verdigris,
    "--color-verdigris-wash": verdigrisWash,
    "--color-verdigris-rule": verdigrisRule,
    "--color-cinnabar": cinnabar,
    "--color-cinnabar-wash": cinnabarWash,
    "--color-cinnabar-rule": cinnabarRule,
    "--heatmap-0-fill": surface2,
    "--heatmap-0-border": rule,
    "--heatmap-1-fill": `color-mix(in oklch, ${accent} 30%, ${surface2})`,
    "--heatmap-1-border": `color-mix(in oklch, ${accent} 42%, ${rule})`,
    "--heatmap-2-fill": `color-mix(in oklch, ${accent} 55%, ${surface2})`,
    "--heatmap-2-border": `color-mix(in oklch, ${accent} 66%, ${rule})`,
    "--heatmap-3-fill": `color-mix(in oklch, ${accent} 78%, ${surface2})`,
    "--heatmap-3-border": `color-mix(in oklch, ${accent} 88%, ${rule})`,
    "--heatmap-4-fill": accent,
    "--heatmap-4-border": cobaltBright,
    "--cobalt-radius": `${radiusPx}px`,
    "--cobalt-radius-sm": `${radiusSmPx}px`,
    "--cobalt-density": String(density.scale),
    "--cobalt-shadow-elevated": dark
      ? "0 14px 36px rgba(0, 0, 0, 0.52)"
      : "0 12px 30px rgba(15, 23, 42, 0.14)",
    "--spacing": density.spacingRem,
  };

  if (palette) {
    if (palette.pulse_read) cssVars["--color-pulse-read"] = palette.pulse_read;
    if (palette.pulse_reuse) cssVars["--color-pulse-reuse"] = palette.pulse_reuse;
    if (palette.pulse_write) cssVars["--color-pulse-write"] = palette.pulse_write;
    if (palette.pulse_update) cssVars["--color-pulse-update"] = palette.pulse_update;
    if (palette.pulse_blocked) cssVars["--color-pulse-blocked"] = palette.pulse_blocked;
  }

  return {
    mode: ui.mode,
    void: bgVoid,
    sidebar,
    surface,
    surface2,
    surface3,
    rule,
    ruleStrong,
    bone,
    boneMuted,
    boneSubtle,
    cobalt: accent,
    cobaltBright,
    cobaltInk,
    cobaltWash,
    cobaltRule,
    onAccent,
    ochre,
    ochreWash,
    ochreRule,
    verdigris,
    verdigrisWash,
    verdigrisRule,
    cinnabar,
    cinnabarWash,
    cinnabarRule,
    radiusPx,
    radiusSmPx,
    densityScale: density.scale,
    spacingRem: density.spacingRem,
    cssVars,
  };
}

/**
 * Preview chrome tokens for brain-only themes (e.g. `cobalt-minimal`) that keep
 * Cobalt's default obsidian chrome.
 */
export const DEFAULT_CHROME_PREVIEW_TOKENS: Omit<GeneratedUiTokens, "cssVars"> = {
  mode: "dark",
  void: "#0b0c0e",
  sidebar: "#111317",
  surface: "#111317",
  surface2: "#171a21",
  surface3: "#1f232c",
  rule: "#23262f",
  ruleStrong: "#363c4a",
  bone: "#ece9e1",
  boneMuted: "#a4a096",
  boneSubtle: "#6f6c65",
  cobalt: "#0047ab",
  cobaltBright: "#1c5ed6",
  cobaltInk: "#79a8ff",
  cobaltWash: "#0f1c35",
  cobaltRule: "#254d99",
  onAccent: "#ffffff",
  ochre: "#d4a359",
  ochreWash: "#231c10",
  ochreRule: "#664c22",
  verdigris: "#34b37e",
  verdigrisWash: "#0e221a",
  verdigrisRule: "#1f5c42",
  cinnabar: "#e05252",
  cinnabarWash: "#261214",
  cinnabarRule: "#6e2729",
  radiusPx: 2,
  radiusSmPx: 1,
  densityScale: 1,
  spacingRem: "0.25rem",
};

/** Resolve chrome preview tokens for any manifest (whole-app `ui` or default obsidian). */
export function resolvePreviewTokens(manifest: ThemeManifest): Omit<GeneratedUiTokens, "cssVars"> {
  if (manifest.ui) {
    return generateThemeUiTokens(manifest.ui, manifest.palette);
  }
  return DEFAULT_CHROME_PREVIEW_TOKENS;
}

/**
 * Apply or clear whole-app theme CSS variables on `:root` live with zero reload.
 * Themes without `ui` (such as `cobalt-minimal`) restore the default obsidian chrome.
 */
export function applyThemeToRoot(manifest: ThemeManifest): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;

  if (!manifest.ui) {
    for (const key of MANAGED_CSS_VARS) {
      root.style.removeProperty(key);
    }
    root.style.removeProperty("color-scheme");
    delete root.dataset.themeUi;
    delete root.dataset.themeMode;
    delete root.dataset.themeDensity;
    return;
  }

  const tokens = generateThemeUiTokens(manifest.ui, manifest.palette);
  for (const [key, value] of Object.entries(tokens.cssVars)) {
    root.style.setProperty(key, value);
  }
  root.style.colorScheme = tokens.mode;
  root.dataset.themeUi = "true";
  root.dataset.themeMode = tokens.mode;
  root.dataset.themeDensity = manifest.ui.density;
}

export type UiSize = "small" | "normal" | "large";

export const UI_SIZE_OPTIONS: readonly UiSize[] = ["small", "normal", "large"] as const;

export const UI_SIZE_SCALES: Record<UiSize, string> = {
  small: "92%",
  normal: "100%",
  large: "112%",
};

export function isValidUiSize(value: unknown): value is UiSize {
  return value === "small" || value === "normal" || value === "large";
}

/** Apply root font scale onto `:root` so Tailwind `rem` typography scales app-wide. */
export function applyUiSizeToRoot(size: UiSize): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.style.setProperty("--cobalt-font-scale", UI_SIZE_SCALES[size] ?? "100%");
  root.dataset.uiSize = size;
}

/** Baseline `ThemeUi` used when customizing a brain-only theme (e.g. `cobalt-minimal`). */
export const DEFAULT_EDITOR_UI: ThemeUi = {
  mode: "dark",
  base_hue: 225,
  base_tint: 16,
  contrast: 72,
  accent: "#0047AB",
  radius: 2,
  density: "comfortable",
};

/** Curated accent swatches (from style-lab + mineral cobalt). */
export const ACCENT_SWATCHES: readonly string[] = [
  "#3D6EF0",
  "#0047AB",
  "#2AA7A0",
  "#7C6CF0",
  "#D9922B",
  "#D0566F",
  "#5C9E4F",
] as const;

/** Quick swatches for the 3D brain canvas background. */
export const BRAIN_BG_SWATCHES: readonly string[] = [
  "#05070D",
  "#0F0A06",
  "#000E12",
  "#0B0C15",
  "#111317",
  "#EEF9FF",
  "#F5F3EE",
] as const;

/** Normalize a `#RRGGBB` or `#RGB` hex string to uppercase `#RRGGBB`. */
export function normalizeHexColor(hex: string, fallback = "#3D6EF0"): string {
  const clean = hex.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(clean)) return clean.toUpperCase();
  if (/^#[0-9a-fA-F]{3}$/.test(clean)) {
    return `#${clean[1]}${clean[1]}${clean[2]}${clean[2]}${clean[3]}${clean[3]}`.toUpperCase();
  }
  return fallback.toUpperCase();
}

const THEME_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** True when `id` matches THEME_SPEC §3 and is not a reserved built-in theme id. */
export function isValidCustomThemeId(id: string): boolean {
  return THEME_ID_PATTERN.test(id) && !isBuiltinThemeId(id);
}

/**
 * Derive a valid, non-builtin `.cobalt-theme` slug id from any user-entered theme name.
 * Always matches `^[a-z0-9][a-z0-9-]{1,63}$` and never collides with `BUILTIN_THEME_IDS`.
 */
export function slugifyThemeId(name: string): string {
  let slug = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  if (slug.length === 0) {
    slug = "custom-theme";
  } else if (slug.length === 1) {
    slug = `${slug}-theme`;
  }

  if (slug.length > 64) {
    slug = slug.slice(0, 64).replace(/-+$/g, "");
  }

  if (isBuiltinThemeId(slug)) {
    const suffix = "-custom";
    const base = slug.slice(0, Math.max(1, 64 - suffix.length)).replace(/-+$/g, "");
    slug = `${base}${suffix}`;
  }

  if (!isValidCustomThemeId(slug)) {
    return "custom-theme";
  }
  return slug;
}

/** Deep-clone a `ThemeManifest` so editor drafts never mutate committed manifests. */
export function cloneThemeManifest(manifest: ThemeManifest): ThemeManifest {
  return {
    ...manifest,
    layout_params: { ...manifest.layout_params },
    palette: {
      ...manifest.palette,
      category_colors: { ...manifest.palette.category_colors },
    },
    node_geometry: { ...manifest.node_geometry },
    camera: {
      ...manifest.camera,
      position: [manifest.camera.position[0], manifest.camera.position[1], manifest.camera.position[2]],
      target: [manifest.camera.target[0], manifest.camera.target[1], manifest.camera.target[2]],
    },
    shaders: { ...manifest.shaders },
    ui: manifest.ui ? { ...manifest.ui } : null,
  };
}

/** Sync reduced-motion app preference onto `:root` so CSS transitions respect it too. */
export function applyReducedMotionToRoot(reduced: boolean): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (reduced) {
    root.dataset.reducedMotion = "true";
  } else {
    delete root.dataset.reducedMotion;
  }
}
