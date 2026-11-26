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

export interface UiState {
  activeNav: NavSection;
  sidebarCollapsed: boolean;
  appInfo: AppInfo | null;
  showOnboardingOverride: boolean;
  globalMockMode: boolean;
  setActiveNav: (nav: NavSection) => void;
  toggleSidebar: () => void;
  setShowOnboardingOverride: (open: boolean) => void;
  loadAppInfo: () => Promise<void>;
}

export const useUiStore = create<UiState>((set) => ({
  activeNav: "brain",
  sidebarCollapsed: false,
  appInfo: null,
  showOnboardingOverride: false,
  globalMockMode: isGlobalMockMode(),
  setActiveNav: (activeNav) => set({ activeNav }),
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  setShowOnboardingOverride: (showOnboardingOverride) => set({ showOnboardingOverride }),
  loadAppInfo: async () => {
    try {
      const appInfo = await backendCall("app_info");
      set({ appInfo });
    } catch (err: unknown) {
      console.error("app_info failed", err);
    }
  },
}));
