import { create } from "zustand";
import i18n from "@/i18n";
import { backendCall } from "@/lib/backend";
import { createDefaultSettings } from "@/lib/format";
import type { AppSettings, DaemonStatus, Language, VaultStatus } from "@/types/contracts";

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
  daemonStatus: DaemonStatus | null;
  vaultStatus: VaultStatus | null;
  loaded: boolean;
  saving: boolean;
  error: string | null;
  loadSettings: () => Promise<AppSettings>;
  updateSettings: (next: AppSettings) => Promise<AppSettings>;
  patchSettings: (partial: Partial<AppSettings>) => Promise<AppSettings>;
  setLanguage: (language: Language) => Promise<void>;
  setReadOnly: (readOnly: boolean) => Promise<boolean>;
  setIndexingPaused: (paused: boolean) => Promise<boolean>;
  syncReadOnly: (readOnly: boolean) => void;
  loadDaemonStatus: () => Promise<void>;
  setDaemonStatus: (status: DaemonStatus) => void;
  loadVaultStatus: () => Promise<void>;
  setVaultStatus: (status: VaultStatus) => void;
  clearError: () => void;
}

function normalizeLoadedSettings(loaded: AppSettings): AppSettings {
  const defaults = createDefaultSettings();
  return {
    ...defaults,
    ...loaded,
    search: {
      ...defaults.search,
      ...(loaded.search ?? {}),
      rrf: {
        ...defaults.search.rrf,
        ...(loaded.search?.rrf ?? {}),
      },
    },
    mcp: {
      ...defaults.mcp,
      ...(loaded.mcp ?? {}),
      tool_docstring_overrides: {
        ...defaults.mcp.tool_docstring_overrides,
        ...(loaded.mcp?.tool_docstring_overrides ?? {}),
      },
      client_permissions: {
        ...defaults.mcp.client_permissions,
        ...(loaded.mcp?.client_permissions ?? {}),
      },
      optional_tools: Array.isArray(loaded.mcp?.optional_tools)
        ? loaded.mcp.optional_tools
        : defaults.mcp.optional_tools,
    },
    capture: { ...defaults.capture, ...(loaded.capture ?? {}) },
    savings: {
      ...defaults.savings,
      ...(loaded.savings ?? {}),
      client_prices: {
        ...defaults.savings.client_prices,
        ...(loaded.savings?.client_prices ?? {}),
      },
    },
  };
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: createDefaultSettings(),
  daemonStatus: null,
  vaultStatus: null,
  loaded: false,
  saving: false,
  error: null,

  loadSettings: async () => {
    try {
      const loaded = await backendCall("get_settings");
      const settings = normalizeLoadedSettings(loaded);
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
      const saved = normalizeLoadedSettings(await backendCall("update_settings", next));
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

  setReadOnly: async (readOnly) => {
    set({ saving: true, error: null });
    try {
      const applied = await backendCall("set_read_only", { read_only: readOnly });
      set((state) => ({
        saving: false,
        settings: { ...state.settings, read_only: applied },
        daemonStatus: state.daemonStatus
          ? { ...state.daemonStatus, read_only: applied }
          : state.daemonStatus,
      }));
      return applied;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      set({ saving: false, error: message });
      return get().settings.read_only;
    }
  },

  setIndexingPaused: async (paused) => {
    const current = get().settings;
    const saved = await get().updateSettings({
      ...current,
      capture: {
        ...current.capture,
        indexing_paused: paused,
      },
    });
    return saved.capture.indexing_paused;
  },

  syncReadOnly: (readOnly) =>
    set((state) => ({
      settings: { ...state.settings, read_only: readOnly },
      daemonStatus: state.daemonStatus
        ? { ...state.daemonStatus, read_only: readOnly }
        : state.daemonStatus,
    })),

  loadDaemonStatus: async () => {
    try {
      const status = await backendCall("get_daemon_status");
      set((state) => ({
        daemonStatus: status,
        settings: { ...state.settings, read_only: status.read_only },
      }));
    } catch {
      // Daemon status may be temporarily unavailable during startup.
    }
  },

  setDaemonStatus: (daemonStatus) =>
    set((state) => ({
      daemonStatus,
      settings: { ...state.settings, read_only: daemonStatus.read_only },
    })),

  loadVaultStatus: async () => {
    try {
      const vaultStatus = await backendCall("vault_status");
      set({ vaultStatus });
    } catch {
      // Vault status optional during startup.
    }
  },

  setVaultStatus: (vaultStatus) => set({ vaultStatus }),
  clearError: () => set({ error: null }),
}));
