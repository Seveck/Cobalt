import { create } from "zustand";
import { backendCall, isCommandMocked } from "@/lib/backend";
import { MINIMAL_THEME_MANIFEST } from "@/themes/minimal";
import {
  BUILTIN_THEME_ID,
  type ClusterSizeMetric,
  type InstalledTheme,
  type LayoutType,
  type ThemeManifest,
} from "@/types/contracts";

const DISABLE_THEME_SHADERS_STORAGE_KEY = "cobalt.disableThemeShaders";

function readDisableThemeShaders(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(DISABLE_THEME_SHADERS_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeDisableThemeShaders(disabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DISABLE_THEME_SHADERS_STORAGE_KEY, disabled ? "true" : "false");
  } catch {
    // Ignore storage quota or restricted storage errors.
  }
}

export type ThemeWarningKind =
  | "shader_compile"
  | "shader_load"
  | "shader_watchdog"
  | "mesh_load"
  | "node_mesh_fallback";

export interface ThemeRuntimeWarning {
  id: string;
  themeId: string;
  kind: ThemeWarningKind;
  layer?: "node" | "edge" | "background" | "mesh";
  summaryKey: string;
  summaryParams?: Record<string, string | number>;
  detail?: string;
}

export interface ThemeState {
  activeThemeId: string;
  manifest: ThemeManifest;
  activeLayout: LayoutType;
  clusterSizeMetric: ClusterSizeMetric;
  showConnections: boolean;
  installedThemes: InstalledTheme[];
  disableThemeShaders: boolean;
  shadersDisabledForSession: boolean;
  themeWarnings: ThemeRuntimeWarning[];
  loading: boolean;
  error: string | null;
  isMockData: boolean;
  setActiveTheme: (themeId: string) => Promise<boolean>;
  setActiveLayout: (layout: LayoutType) => void;
  setClusterSizeMetric: (metric: ClusterSizeMetric) => void;
  setShowConnections: (show: boolean) => void;
  toggleShowConnections: () => void;
  setDisableThemeShaders: (disabled: boolean) => void;
  tripShaderWatchdog: (themeId: string, avgFrameMs: number) => void;
  resetSessionShaderWatchdog: () => void;
  pushThemeWarning: (warning: ThemeRuntimeWarning) => void;
  dismissThemeWarning: (id: string) => void;
  clearThemeWarnings: (themeId?: string) => void;
  loadInstalledThemes: () => Promise<InstalledTheme[]>;
}

export const useThemeStore = create<ThemeState>((set) => ({
  activeThemeId: BUILTIN_THEME_ID,
  manifest: MINIMAL_THEME_MANIFEST,
  activeLayout: MINIMAL_THEME_MANIFEST.layout_type,
  clusterSizeMetric: "vectors",
  showConnections: false,
  installedThemes: [],
  disableThemeShaders: readDisableThemeShaders(),
  shadersDisabledForSession: false,
  themeWarnings: [],
  loading: false,
  error: null,
  isMockData: isCommandMocked("list_installed_themes"),

  setActiveTheme: async (themeId) => {
    set((state) => ({
      loading: true,
      error: null,
      themeWarnings: state.themeWarnings.filter((w) => w.kind === "shader_watchdog"),
    }));
    try {
      const manifest = await backendCall("get_theme_manifest", { theme_id: themeId });
      set({
        activeThemeId: themeId,
        manifest,
        activeLayout: manifest.layout_type,
        loading: false,
      });
      return true;
    } catch (err: unknown) {
      if (themeId === BUILTIN_THEME_ID) {
        set({
          activeThemeId: BUILTIN_THEME_ID,
          manifest: MINIMAL_THEME_MANIFEST,
          activeLayout: MINIMAL_THEME_MANIFEST.layout_type,
          loading: false,
        });
        return true;
      }
      const message = err instanceof Error ? err.message : String(err);
      set({
        activeThemeId: BUILTIN_THEME_ID,
        manifest: MINIMAL_THEME_MANIFEST,
        activeLayout: MINIMAL_THEME_MANIFEST.layout_type,
        loading: false,
        error: message,
      });
      return false;
    }
  },

  setActiveLayout: (activeLayout) => set({ activeLayout }),
  setClusterSizeMetric: (clusterSizeMetric) => set({ clusterSizeMetric }),
  setShowConnections: (showConnections) => set({ showConnections }),
  toggleShowConnections: () => set((state) => ({ showConnections: !state.showConnections })),

  setDisableThemeShaders: (disabled) => {
    writeDisableThemeShaders(disabled);
    set((state) => ({
      disableThemeShaders: disabled,
      themeWarnings: disabled
        ? state.themeWarnings.filter(
            (w) => w.kind !== "shader_compile" && w.kind !== "shader_load",
          )
        : state.themeWarnings,
    }));
  },

  tripShaderWatchdog: (themeId, avgFrameMs) =>
    set((state) => {
      if (state.shadersDisabledForSession) return state;
      const warning: ThemeRuntimeWarning = {
        id: "shader-watchdog-session",
        themeId,
        kind: "shader_watchdog",
        summaryKey: "themes.warnings.watchdogTripped",
        summaryParams: { ms: avgFrameMs },
      };
      const existing = state.themeWarnings.filter((w) => w.id !== warning.id);
      return {
        shadersDisabledForSession: true,
        themeWarnings: [...existing, warning],
      };
    }),

  resetSessionShaderWatchdog: () =>
    set((state) => ({
      shadersDisabledForSession: false,
      themeWarnings: state.themeWarnings.filter((w) => w.kind !== "shader_watchdog"),
    })),

  pushThemeWarning: (warning) =>
    set((state) => {
      const idx = state.themeWarnings.findIndex((w) => w.id === warning.id);
      if (idx >= 0) {
        const next = [...state.themeWarnings];
        next[idx] = warning;
        return { themeWarnings: next };
      }
      return { themeWarnings: [...state.themeWarnings, warning] };
    }),

  dismissThemeWarning: (id) =>
    set((state) => ({
      themeWarnings: state.themeWarnings.filter((w) => w.id !== id),
    })),

  clearThemeWarnings: (themeId) =>
    set((state) => ({
      themeWarnings: themeId
        ? state.themeWarnings.filter((w) => w.themeId !== themeId)
        : [],
    })),

  loadInstalledThemes: async () => {
    set({ loading: true, error: null, isMockData: isCommandMocked("list_installed_themes") });
    try {
      const installedThemes = await backendCall("list_installed_themes");
      set({ installedThemes, loading: false });
      return installedThemes;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      set({ loading: false, error: message });
      return [];
    }
  },
}));
