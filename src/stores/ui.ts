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

const SIDEBAR_COLLAPSED_STORAGE_KEY = "cobalt.sidebarCollapsed";
const NARROW_WINDOW_BREAKPOINT_PX = 900;

function readInitialSidebarCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  if (window.innerWidth < NARROW_WINDOW_BREAKPOINT_PX) {
    return true;
  }
  try {
    const stored = window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY);
    if (stored === "true") return true;
    if (stored === "false") return false;
  } catch {
    // Ignore storage access errors in restricted environments.
  }
  return false;
}

function writeSidebarCollapsed(collapsed: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? "true" : "false");
  } catch {
    // Ignore storage quota or restricted storage errors.
  }
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
  setSidebarCollapsed: (collapsed: boolean) => void;
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
  sidebarCollapsed: readInitialSidebarCollapsed(),
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
  setSidebarCollapsed: (collapsed) => {
    writeSidebarCollapsed(collapsed);
    set({ sidebarCollapsed: collapsed });
  },
  toggleSidebar: () =>
    set((state) => {
      const next = !state.sidebarCollapsed;
      writeSidebarCollapsed(next);
      return { sidebarCollapsed: next };
    }),
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
