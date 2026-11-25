import { create } from "zustand";
import { backendCall, isCommandMocked } from "@/lib/backend";
import { MINIMAL_THEME_MANIFEST } from "@/themes/minimal";
import { BUILTIN_THEME_ID, type InstalledTheme, type ThemeManifest } from "@/types/contracts";

export interface ThemeState {
  activeThemeId: string;
  manifest: ThemeManifest;
  installedThemes: InstalledTheme[];
  loading: boolean;
  isMockData: boolean;
  setActiveTheme: (themeId: string) => Promise<void>;
  loadInstalledThemes: () => Promise<void>;
}

export const useThemeStore = create<ThemeState>((set) => ({
  activeThemeId: BUILTIN_THEME_ID,
  manifest: MINIMAL_THEME_MANIFEST,
  installedThemes: [],
  loading: false,
  isMockData: isCommandMocked("list_installed_themes"),

  setActiveTheme: async (themeId) => {
    if (themeId === BUILTIN_THEME_ID) {
      set({ activeThemeId: BUILTIN_THEME_ID, manifest: MINIMAL_THEME_MANIFEST });
      return;
    }
    set({ loading: true });
    try {
      const manifest = await backendCall("get_theme_manifest", { theme_id: themeId });
      set({ activeThemeId: themeId, manifest, loading: false });
    } catch {
      set({
        activeThemeId: BUILTIN_THEME_ID,
        manifest: MINIMAL_THEME_MANIFEST,
        loading: false,
      });
    }
  },

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
