import { create } from "zustand";
import { backendCall } from "@/lib/backend";
import type { AppInfo } from "@/types/contracts";

export type NavSection =
  | "brain"
  | "library"
  | "telemetry"
  | "stats"
  | "connectors"
  | "tools"
  | "store"
  | "settings";

export type ToolsTab = "projects" | "web_bridge" | "importer" | "capsules" | "backup";
export type SettingsSectionId = "ocr" | "savings";
export type ConnectorsSectionId = "ai_tools";

export interface OpenSettingsSectionOptions {
  autoInstall?: boolean;
}

const SIDEBAR_COLLAPSED_STORAGE_KEY = "cobalt.sidebarCollapsed";
const LAYOUTS_PANEL_COLLAPSED_STORAGE_KEY = "cobalt.layoutsPanelCollapsed";
const NARROW_WINDOW_BREAKPOINT_PX = 900;
const LAYOUTS_PANEL_NARROW_BREAKPOINT_PX = 1024;

function readInitialCollapsedFlag(storageKey: string, narrowBreakpointPx: number): boolean {
  if (typeof window === "undefined") return false;
  if (window.innerWidth < narrowBreakpointPx) {
    return true;
  }
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === "true") return true;
    if (stored === "false") return false;
  } catch {
    // Ignore storage access errors in restricted environments.
  }
  return false;
}

function writeCollapsedFlag(storageKey: string, collapsed: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, collapsed ? "true" : "false");
  } catch {
    // Ignore storage quota or restricted storage errors.
  }
}

export interface UiState {
  activeNav: NavSection;
  toolsTab: ToolsTab;
  unsortedViewOpen: boolean;
  settingsFocusSection: SettingsSectionId | null;
  settingsFocusAutoInstall: boolean;
  connectorsFocusSection: ConnectorsSectionId | null;
  sidebarCollapsed: boolean;
  layoutsPanelCollapsed: boolean;
  appInfo: AppInfo | null;
  showOnboardingOverride: boolean;
  welcomeDismissed: boolean;
  setActiveNav: (nav: NavSection) => void;
  setToolsTab: (tab: ToolsTab) => void;
  openToolsTab: (tab: ToolsTab) => void;
  openUnsortedView: () => void;
  setUnsortedViewOpen: (open: boolean) => void;
  openSettingsSection: (
    section: SettingsSectionId,
    options?: OpenSettingsSectionOptions,
  ) => void;
  clearSettingsFocusSection: () => void;
  openConnectorsSection: (section: ConnectorsSectionId) => void;
  clearConnectorsFocusSection: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  setLayoutsPanelCollapsed: (collapsed: boolean) => void;
  toggleLayoutsPanel: () => void;
  setShowOnboardingOverride: (open: boolean) => void;
  dismissWelcome: () => void;
  loadAppInfo: () => Promise<void>;
}

export const useUiStore = create<UiState>((set) => ({
  activeNav: "brain",
  toolsTab: "projects",
  unsortedViewOpen: false,
  settingsFocusSection: null,
  settingsFocusAutoInstall: false,
  connectorsFocusSection: null,
  sidebarCollapsed: readInitialCollapsedFlag(
    SIDEBAR_COLLAPSED_STORAGE_KEY,
    NARROW_WINDOW_BREAKPOINT_PX,
  ),
  layoutsPanelCollapsed: readInitialCollapsedFlag(
    LAYOUTS_PANEL_COLLAPSED_STORAGE_KEY,
    LAYOUTS_PANEL_NARROW_BREAKPOINT_PX,
  ),
  appInfo: null,
  showOnboardingOverride: false,
  welcomeDismissed: false,
  setActiveNav: (activeNav) => set({ activeNav }),
  setToolsTab: (toolsTab) => set({ toolsTab }),
  openToolsTab: (toolsTab) => set({ activeNav: "tools", toolsTab }),
  openUnsortedView: () =>
    set({ activeNav: "tools", toolsTab: "projects", unsortedViewOpen: true }),
  setUnsortedViewOpen: (unsortedViewOpen) => set({ unsortedViewOpen }),
  openSettingsSection: (settingsFocusSection, options) =>
    set({
      activeNav: "settings",
      settingsFocusSection,
      settingsFocusAutoInstall: Boolean(options?.autoInstall),
    }),
  clearSettingsFocusSection: () =>
    set({ settingsFocusSection: null, settingsFocusAutoInstall: false }),
  openConnectorsSection: (connectorsFocusSection) =>
    set({ activeNav: "connectors", connectorsFocusSection }),
  clearConnectorsFocusSection: () => set({ connectorsFocusSection: null }),
  setSidebarCollapsed: (collapsed) => {
    writeCollapsedFlag(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed);
    set({ sidebarCollapsed: collapsed });
  },
  toggleSidebar: () =>
    set((state) => {
      const next = !state.sidebarCollapsed;
      writeCollapsedFlag(SIDEBAR_COLLAPSED_STORAGE_KEY, next);
      return { sidebarCollapsed: next };
    }),
  setLayoutsPanelCollapsed: (collapsed) => {
    writeCollapsedFlag(LAYOUTS_PANEL_COLLAPSED_STORAGE_KEY, collapsed);
    set({ layoutsPanelCollapsed: collapsed });
  },
  toggleLayoutsPanel: () =>
    set((state) => {
      const next = !state.layoutsPanelCollapsed;
      writeCollapsedFlag(LAYOUTS_PANEL_COLLAPSED_STORAGE_KEY, next);
      return { layoutsPanelCollapsed: next };
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
