import { create } from "zustand";
import { backendCall } from "@/lib/backend";
import type { AppInfo } from "@/types/contracts";

export type NavSection =
  | "brain"
  | "library"
  | "telemetry"
  | "connectors"
  | "tools"
  | "store"
  | "settings";

export type ToolsTab = "projects" | "web_bridge" | "importer" | "capsules" | "backup";
export type SettingsSectionId = "ocr";

export interface OpenSettingsSectionOptions {
  autoInstall?: boolean;
}

export interface UiState {
  activeNav: NavSection;
  toolsTab: ToolsTab;
  settingsFocusSection: SettingsSectionId | null;
  settingsFocusAutoInstall: boolean;
  sidebarCollapsed: boolean;
  appInfo: AppInfo | null;
  showOnboardingOverride: boolean;
  welcomeDismissed: boolean;
  setActiveNav: (nav: NavSection) => void;
  setToolsTab: (tab: ToolsTab) => void;
  openToolsTab: (tab: ToolsTab) => void;
  openSettingsSection: (
    section: SettingsSectionId,
    options?: OpenSettingsSectionOptions,
  ) => void;
  clearSettingsFocusSection: () => void;
  toggleSidebar: () => void;
  setShowOnboardingOverride: (open: boolean) => void;
  dismissWelcome: () => void;
  loadAppInfo: () => Promise<void>;
}

export const useUiStore = create<UiState>((set) => ({
  activeNav: "brain",
  toolsTab: "projects",
  settingsFocusSection: null,
  settingsFocusAutoInstall: false,
  sidebarCollapsed: false,
  appInfo: null,
  showOnboardingOverride: false,
  welcomeDismissed: false,
  setActiveNav: (activeNav) => set({ activeNav }),
  setToolsTab: (toolsTab) => set({ toolsTab }),
  openToolsTab: (toolsTab) => set({ activeNav: "tools", toolsTab }),
  openSettingsSection: (settingsFocusSection, options) =>
    set({
      activeNav: "settings",
      settingsFocusSection,
      settingsFocusAutoInstall: Boolean(options?.autoInstall),
    }),
  clearSettingsFocusSection: () =>
    set({ settingsFocusSection: null, settingsFocusAutoInstall: false }),
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  setShowOnboardingOverride: (showOnboardingOverride) => set({ showOnboardingOverride }),
  dismissWelcome: () => set({ welcomeDismissed: true }),
  loadAppInfo: async () => {
    try {
      const appInfo = await backendCall("app_info");
      set({ appInfo });
    } catch (err: unknown) {
      console.error("app_info failed", err);
    }
  },
}));
