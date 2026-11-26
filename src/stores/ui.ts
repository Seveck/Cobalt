import { create } from "zustand";
import { backendCall, isGlobalMockMode } from "@/lib/backend";
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

export interface UiState {
  activeNav: NavSection;
  toolsTab: ToolsTab;
  sidebarCollapsed: boolean;
  appInfo: AppInfo | null;
  showOnboardingOverride: boolean;
  welcomeDismissed: boolean;
  globalMockMode: boolean;
  setActiveNav: (nav: NavSection) => void;
  setToolsTab: (tab: ToolsTab) => void;
  openToolsTab: (tab: ToolsTab) => void;
  toggleSidebar: () => void;
  setShowOnboardingOverride: (open: boolean) => void;
  dismissWelcome: () => void;
  loadAppInfo: () => Promise<void>;
}

export const useUiStore = create<UiState>((set) => ({
  activeNav: "brain",
  toolsTab: "projects",
  sidebarCollapsed: false,
  appInfo: null,
  showOnboardingOverride: false,
  welcomeDismissed: false,
  globalMockMode: isGlobalMockMode(),
  setActiveNav: (activeNav) => set({ activeNav }),
  setToolsTab: (toolsTab) => set({ toolsTab }),
  openToolsTab: (toolsTab) => set({ activeNav: "tools", toolsTab }),
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
