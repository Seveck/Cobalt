import { create } from "zustand";
import i18n from "@/i18n";
import { backendCall } from "@/lib/backend";
import { createDefaultSettings } from "@/lib/format";
import type { AppSettings, Language } from "@/types/contracts";

async function applyLanguageToDom(language: Language): Promise<void> {
  if (typeof document !== "undefined") {
    document.documentElement.lang = language;
  }
  if (i18n.resolvedLanguage !== language) {
    await i18n.changeLanguage(language);
  }
}

export interface SettingsState {
  settings: AppSettings;
  loaded: boolean;
  saving: boolean;
  error: string | null;
  loadSettings: () => Promise<AppSettings>;
  updateSettings: (next: AppSettings) => Promise<AppSettings>;
  patchSettings: (partial: Partial<AppSettings>) => Promise<AppSettings>;
  setLanguage: (language: Language) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: createDefaultSettings(),
  loaded: false,
  saving: false,
  error: null,

  loadSettings: async () => {
    try {
      const settings = await backendCall("get_settings");
      await applyLanguageToDom(settings.language);
      set({ settings, loaded: true, error: null });
      return settings;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      set({ loaded: true, error: message });
      return get().settings;
    }
  },

  updateSettings: async (next) => {
    set({ saving: true, error: null });
    try {
      const saved = await backendCall("update_settings", next);
      await applyLanguageToDom(saved.language);
      set({ settings: saved, saving: false });
      return saved;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      set({ saving: false, error: message });
      return get().settings;
    }
  },

  patchSettings: async (partial) => {
    const merged: AppSettings = { ...get().settings, ...partial };
    return get().updateSettings(merged);
  },

  setLanguage: async (language) => {
    await applyLanguageToDom(language);
    const current = get().settings;
    if (current.language === language && get().loaded) return;
    await get().updateSettings({ ...current, language });
  },
}));
