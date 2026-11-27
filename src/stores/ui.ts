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

export interface UiState {
  activeNav: NavSection;
  toolsTab: ToolsTab;
  settingsFocusSection: SettingsSectionId | null;
  sidebarCollapsed: boolean;
  appInfo: AppInfo | null;
  showOnboardingOverride: boolean;
  welcomeDismissed: boolean;
  setActiveNav: (nav: NavSection) => void;
  setToolsTab: (tab: ToolsTab) => void;
  openToolsTab: (tab: ToolsTab) => void;
  openSettingsSection: (section: SettingsSectionId) => void;
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
  sidebarCollapsed: false,
  appInfo: null,
  showOnboardingOverride: false,
  welcomeDismissed: false,
  setActiveNav: (activeNav) => set({ activeNav }),
  setToolsTab: (toolsTab) => set({ toolsTab }),
  openToolsTab: (toolsTab) => set({ activeNav: "tools", toolsTab }),
  openSettingsSection: (settingsFocusSection) =>
    set({ activeNav: "settings", settingsFocusSection }),
  clearSettingsFocusSection: () => set({ settingsFocusSection: null }),
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
