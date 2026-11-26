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
  showConnections: boolean;
  installedThemes: InstalledTheme[];
  loading: boolean;
  error: string | null;
  isMockData: boolean;
  setActiveTheme: (themeId: string) => Promise<boolean>;
  setActiveLayout: (layout: LayoutType) => void;
  setClusterSizeMetric: (metric: ClusterSizeMetric) => void;
  setShowConnections: (show: boolean) => void;
  toggleShowConnections: () => void;
  loadInstalledThemes: () => Promise<InstalledTheme[]>;
}

export const useThemeStore = create<ThemeState>((set) => ({
  activeThemeId: BUILTIN_THEME_ID,
  manifest: MINIMAL_THEME_MANIFEST,
  activeLayout: MINIMAL_THEME_MANIFEST.layout_type,
  clusterSizeMetric: "vectors",
  showConnections: false,
  installedThemes: [],
  loading: false,
  error: null,
  isMockData: isCommandMocked("list_installed_themes"),

  setActiveTheme: async (themeId) => {
    set({ loading: true, error: null });
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
