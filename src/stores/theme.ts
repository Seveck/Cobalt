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

export interface ThemeState {
  activeThemeId: string;
  manifest: ThemeManifest;
  activeLayout: LayoutType;
  clusterSizeMetric: ClusterSizeMetric;
  installedThemes: InstalledTheme[];
  loading: boolean;
  isMockData: boolean;
  setActiveTheme: (themeId: string) => Promise<void>;
  setActiveLayout: (layout: LayoutType) => void;
  setClusterSizeMetric: (metric: ClusterSizeMetric) => void;
  loadInstalledThemes: () => Promise<void>;
}

export const useThemeStore = create<ThemeState>((set) => ({
  activeThemeId: BUILTIN_THEME_ID,
  manifest: MINIMAL_THEME_MANIFEST,
  activeLayout: MINIMAL_THEME_MANIFEST.layout_type,
  clusterSizeMetric: "vectors",
  installedThemes: [],
  loading: false,
  isMockData: isCommandMocked("list_installed_themes"),

  setActiveTheme: async (themeId) => {
    if (themeId === BUILTIN_THEME_ID) {
      set({
        activeThemeId: BUILTIN_THEME_ID,
        manifest: MINIMAL_THEME_MANIFEST,
        activeLayout: MINIMAL_THEME_MANIFEST.layout_type,
      });
      return;
    }
    set({ loading: true });
    try {
      const manifest = await backendCall("get_theme_manifest", { theme_id: themeId });
      set({
        activeThemeId: themeId,
        manifest,
        activeLayout: manifest.layout_type,
        loading: false,
      });
    } catch {
      set({
        activeThemeId: BUILTIN_THEME_ID,
        manifest: MINIMAL_THEME_MANIFEST,
        activeLayout: MINIMAL_THEME_MANIFEST.layout_type,
        loading: false,
      });
    }
  },

  setActiveLayout: (activeLayout) => set({ activeLayout }),
  setClusterSizeMetric: (clusterSizeMetric) => set({ clusterSizeMetric }),

  loadInstalledThemes: async () => {
    set({ loading: true, isMockData: isCommandMocked("list_installed_themes") });
    try {
      const installedThemes = await backendCall("list_installed_themes");
      set({ installedThemes, loading: false });
    } catch {
      set({ loading: false });
    }
  },
}));
