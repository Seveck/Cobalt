import { create } from "zustand";
import { backendCall } from "@/lib/backend";
import {
  applyReducedMotionToRoot,
  applyThemeToRoot,
  applyUiSizeToRoot,
  cloneThemeManifest,
  isBuiltinThemeId,
  isValidUiSize,
  type UiSize,
} from "@/lib/themeEngine";
import { MINIMAL_THEME_MANIFEST } from "@/themes/minimal";
import {
  BUILTIN_THEME_ID,
  type ClusterSizeMetric,
  type InstalledTheme,
  type LayoutType,
  type ThemeManifest,
} from "@/types/contracts";

const DISABLE_THEME_SHADERS_STORAGE_KEY = "cobalt.disableThemeShaders";
const REDUCED_MOTION_STORAGE_KEY = "cobalt.reducedMotion";
const AUTO_ROTATE_PAUSED_STORAGE_KEY = "cobalt.autoRotatePaused";
const UI_SIZE_STORAGE_KEY = "cobalt.uiSize";

function readStorageBool(key: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

function writeStorageBool(key: string, value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value ? "true" : "false");
  } catch {
    // Ignore storage quota or restricted storage errors.
  }
}

function readStorageUiSize(): UiSize {
  if (typeof window === "undefined") return "normal";
  try {
    const raw = window.localStorage.getItem(UI_SIZE_STORAGE_KEY);
    return isValidUiSize(raw) ? raw : "normal";
  } catch {
    return "normal";
  }
}

function writeStorageUiSize(size: UiSize): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(UI_SIZE_STORAGE_KEY, size);
  } catch {
    // Ignore storage quota or restricted storage errors.
  }
}

const initialReducedMotion = readStorageBool(REDUCED_MOTION_STORAGE_KEY);
applyReducedMotionToRoot(initialReducedMotion);

const initialUiSize = readStorageUiSize();
applyUiSizeToRoot(initialUiSize);

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

export type ThemeEditorMode = "create" | "edit";

export interface OpenThemeEditorOptions {
  manifest?: ThemeManifest;
  mode?: ThemeEditorMode;
}

export interface ThemeToast {
  id: string;
  kind: "ai_created" | "exported" | "saved" | "info";
  message: string;
  themeId?: string;
  themeName?: string;
  applied?: boolean;
}

let toastCounter = 0;

export interface ThemeState {
  activeThemeId: string;
  /** Currently displayed manifest (live editor draft while editing, otherwise `committedManifest`). */
  manifest: ThemeManifest;
  /** Last applied / saved active theme manifest (reverted to on editor discard/close). */
  committedManifest: ThemeManifest;
  activeLayout: LayoutType;
  clusterSizeMetric: ClusterSizeMetric;
  showConnections: boolean;
  installedThemes: InstalledTheme[];
  themesVersion: number;
  uiSize: UiSize;
  disableThemeShaders: boolean;
  reducedMotion: boolean;
  autoRotatePaused: boolean;
  shadersDisabledForSession: boolean;
  themeWarnings: ThemeRuntimeWarning[];
  themeEditorOpen: boolean;
  themeEditorMode: ThemeEditorMode;
  themeEditorBaseManifest: ThemeManifest | null;
  themeEditorInitialUiSize: UiSize | null;
  themeEditorDirty: boolean;
  themeToasts: ThemeToast[];
  loading: boolean;
  error: string | null;
  setActiveTheme: (themeId: string) => Promise<boolean>;
  setActiveLayout: (layout: LayoutType) => void;
  setClusterSizeMetric: (metric: ClusterSizeMetric) => void;
  setShowConnections: (show: boolean) => void;
  toggleShowConnections: () => void;
  setUiSize: (size: UiSize) => void;
  previewUiSize: (size: UiSize) => void;
  setDisableThemeShaders: (disabled: boolean) => void;
  setReducedMotion: (reduced: boolean) => void;
  setAutoRotatePaused: (paused: boolean) => void;
  toggleAutoRotatePaused: () => void;
  tripShaderWatchdog: (themeId: string, avgFrameMs: number) => void;
  resetSessionShaderWatchdog: () => void;
  pushThemeWarning: (warning: ThemeRuntimeWarning) => void;
  dismissThemeWarning: (id: string) => void;
  clearThemeWarnings: (themeId?: string) => void;
  loadInstalledThemes: () => Promise<InstalledTheme[]>;
  bumpThemesVersion: () => void;
  openThemeEditor: (options?: OpenThemeEditorOptions) => void;
  updateThemeEditorDraft: (updater: (current: ThemeManifest) => ThemeManifest) => void;
  resetThemeEditor: () => void;
  discardAndCloseThemeEditor: () => void;
  commitThemeEditorSave: (savedManifest: ThemeManifest) => void;
  pushThemeToast: (toast: Omit<ThemeToast, "id">) => string;
  dismissThemeToast: (id: string) => void;
  markThemeToastApplied: (themeId: string) => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  activeThemeId: BUILTIN_THEME_ID,
  manifest: MINIMAL_THEME_MANIFEST,
  committedManifest: MINIMAL_THEME_MANIFEST,
  activeLayout: MINIMAL_THEME_MANIFEST.layout_type,
  clusterSizeMetric: "vectors",
  showConnections: false,
  installedThemes: [],
  themesVersion: 0,
  uiSize: initialUiSize,
  disableThemeShaders: readStorageBool(DISABLE_THEME_SHADERS_STORAGE_KEY),
  reducedMotion: initialReducedMotion,
  autoRotatePaused: readStorageBool(AUTO_ROTATE_PAUSED_STORAGE_KEY),
  shadersDisabledForSession: false,
  themeWarnings: [],
  themeEditorOpen: false,
  themeEditorMode: "create",
  themeEditorBaseManifest: null,
  themeEditorInitialUiSize: null,
  themeEditorDirty: false,
  themeToasts: [],
  loading: false,
  error: null,

  setActiveTheme: async (themeId) => {
    set((state) => ({
      loading: true,
      error: null,
      themeWarnings: state.themeWarnings.filter((w) => w.kind === "shader_watchdog"),
    }));
    try {
      const manifest = await backendCall("get_theme_manifest", { theme_id: themeId });
      applyThemeToRoot(manifest);
      const prevInitialSize = get().themeEditorInitialUiSize;
      if (get().themeEditorOpen && prevInitialSize) {
        applyUiSizeToRoot(prevInitialSize);
      }
      set((state) => ({
        activeThemeId: themeId,
        manifest,
        committedManifest: manifest,
        activeLayout: manifest.layout_type,
        uiSize: state.themeEditorOpen && prevInitialSize ? prevInitialSize : state.uiSize,
        themeEditorOpen: false,
        themeEditorBaseManifest: null,
        themeEditorInitialUiSize: null,
        themeEditorDirty: false,
        loading: false,
      }));
      return true;
    } catch (err: unknown) {
      applyThemeToRoot(MINIMAL_THEME_MANIFEST);
      if (themeId === BUILTIN_THEME_ID) {
        set({
          activeThemeId: BUILTIN_THEME_ID,
          manifest: MINIMAL_THEME_MANIFEST,
          committedManifest: MINIMAL_THEME_MANIFEST,
          activeLayout: MINIMAL_THEME_MANIFEST.layout_type,
          loading: false,
        });
        return true;
      }
      const message = err instanceof Error ? err.message : String(err);
      set({
        activeThemeId: BUILTIN_THEME_ID,
        manifest: MINIMAL_THEME_MANIFEST,
        committedManifest: MINIMAL_THEME_MANIFEST,
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

  setUiSize: (size) => {
    writeStorageUiSize(size);
    applyUiSizeToRoot(size);
    set((state) => ({
      uiSize: size,
      // Keep editor's revert baseline in sync if changed directly from Settings.
      themeEditorInitialUiSize: state.themeEditorOpen ? size : state.themeEditorInitialUiSize,
    }));
  },

  previewUiSize: (size) => {
    applyUiSizeToRoot(size);
    set({ uiSize: size, themeEditorDirty: true });
  },

  setDisableThemeShaders: (disabled) => {
    writeStorageBool(DISABLE_THEME_SHADERS_STORAGE_KEY, disabled);
    set((state) => ({
      disableThemeShaders: disabled,
      themeWarnings: disabled
        ? state.themeWarnings.filter(
            (w) => w.kind !== "shader_compile" && w.kind !== "shader_load",
          )
        : state.themeWarnings,
    }));
  },

  setReducedMotion: (reduced) => {
    writeStorageBool(REDUCED_MOTION_STORAGE_KEY, reduced);
    applyReducedMotionToRoot(reduced);
    set({ reducedMotion: reduced });
  },

  setAutoRotatePaused: (paused) => {
    writeStorageBool(AUTO_ROTATE_PAUSED_STORAGE_KEY, paused);
    set({ autoRotatePaused: paused });
  },

  toggleAutoRotatePaused: () =>
    set((state) => {
      const next = !state.autoRotatePaused;
      writeStorageBool(AUTO_ROTATE_PAUSED_STORAGE_KEY, next);
      return { autoRotatePaused: next };
    }),

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
    set({ loading: true, error: null });
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

  bumpThemesVersion: () => set((state) => ({ themesVersion: state.themesVersion + 1 })),

  openThemeEditor: (options) => {
    const state = get();
    const target = cloneThemeManifest(options?.manifest ?? state.committedManifest);
    const mode: ThemeEditorMode =
      options?.mode ?? (isBuiltinThemeId(target.id) ? "create" : "edit");
    const baselineUiSize = state.themeEditorOpen
      ? (state.themeEditorInitialUiSize ?? state.uiSize)
      : state.uiSize;

    applyThemeToRoot(target);
    set({
      manifest: target,
      themeEditorOpen: true,
      themeEditorMode: mode,
      themeEditorBaseManifest: cloneThemeManifest(target),
      themeEditorInitialUiSize: baselineUiSize,
      themeEditorDirty: false,
    });
  },

  updateThemeEditorDraft: (updater) => {
    const current = get().manifest;
    const next = updater(cloneThemeManifest(current));
    applyThemeToRoot(next);
    set({
      manifest: next,
      themeEditorDirty: true,
    });
  },

  resetThemeEditor: () => {
    const state = get();
    if (!state.themeEditorBaseManifest) return;
    const restored = cloneThemeManifest(state.themeEditorBaseManifest);
    const restoredSize = state.themeEditorInitialUiSize ?? state.uiSize;
    applyThemeToRoot(restored);
    applyUiSizeToRoot(restoredSize);
    set({
      manifest: restored,
      uiSize: restoredSize,
      themeEditorDirty: false,
    });
  },

  discardAndCloseThemeEditor: () => {
    const state = get();
    const committed = cloneThemeManifest(state.committedManifest);
    const restoredSize = state.themeEditorInitialUiSize ?? state.uiSize;
    applyThemeToRoot(committed);
    applyUiSizeToRoot(restoredSize);
    set({
      manifest: committed,
      uiSize: restoredSize,
      themeEditorOpen: false,
      themeEditorBaseManifest: null,
      themeEditorInitialUiSize: null,
      themeEditorDirty: false,
    });
  },

  commitThemeEditorSave: (savedManifest) => {
    const state = get();
    const committed = cloneThemeManifest(savedManifest);
    writeStorageUiSize(state.uiSize);
    applyUiSizeToRoot(state.uiSize);
    applyThemeToRoot(committed);
    set({
      activeThemeId: committed.id,
      manifest: committed,
      committedManifest: committed,
      activeLayout: committed.layout_type,
      themeEditorOpen: false,
      themeEditorBaseManifest: null,
      themeEditorInitialUiSize: null,
      themeEditorDirty: false,
      themesVersion: state.themesVersion + 1,
    });
  },

  pushThemeToast: (toast) => {
    const id = `theme-toast-${++toastCounter}`;
    set((state) => ({
      themeToasts: [...state.themeToasts.slice(-3), { ...toast, id }],
    }));
    return id;
  },

  dismissThemeToast: (id) =>
    set((state) => ({
      themeToasts: state.themeToasts.filter((item) => item.id !== id),
    })),

  markThemeToastApplied: (themeId) =>
    set((state) => ({
      themeToasts: state.themeToasts.map((item) =>
        item.themeId === themeId ? { ...item, applied: true } : item,
      ),
    })),
}));
