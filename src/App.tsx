import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { backendOn } from "@/lib/backend";
import { isTauri } from "@/lib/ipc";
import {
  QUICKNOTE_CONFLICTS_STORAGE_KEY,
  QUICKNOTE_INSPECT_STORAGE_KEY,
} from "@/lib/savings";
import { applyThemeToRoot } from "@/lib/themeEngine";
import { Skeleton } from "@/components/ui";
import {
  useBranchesStore,
  useCliActivityStore,
  useFiltersStore,
  useHardwareStore,
  useIngestStore,
  useMemoryStore,
  useProposalsStore,
  useSettingsStore,
  useSynapticStore,
  useTelemetryStore,
  useThemeStore,
  useUiStore,
} from "@/stores";
import { BrainCanvas } from "@/components/canvas3d";
import { ConnectorsView } from "@/components/connectors/ConnectorsView";
import { LibraryView } from "@/components/library/LibraryView";
import { OnboardingScreen } from "@/components/onboarding";
import { DropIngestHost } from "@/components/projects/DropIngestHost";
import { SettingsView } from "@/components/settings/SettingsView";
import { CliActivityShellBar } from "@/components/shell/CliActivityShellBar";
import { CobaltMark } from "@/components/shell/CobaltMark";
import { DesktopOnlyNotice } from "@/components/shell/DesktopOnlyNotice";
import { IngestShellIndicator } from "@/components/shell/IngestShellIndicator";
import { ProposalsPanel } from "@/components/shell/ProposalsPanel";
import { Sidebar } from "@/components/shell/Sidebar";
import { TopShellBar } from "@/components/shell/TopShellBar";
import { WelcomeGreeting } from "@/components/shell/WelcomeGreeting";
import { StatsView } from "@/components/stats/StatsView";
import { ThemeEditorPanel } from "@/components/store/ThemeEditorPanel";
import { ThemeStoreView } from "@/components/store/ThemeStoreView";
import { ThemeToastHost } from "@/components/store/ThemeToastHost";
import { TelemetryView } from "@/components/telemetry/TelemetryView";
import { ToolsView } from "@/components/tools/ToolsView";
import { BUILTIN_THEME_ID, type ConflictHint } from "@/types/contracts";

export default function App() {
  if (!isTauri()) {
    return <DesktopOnlyNotice />;
  }
  return <DesktopApp />;
}

function DesktopApp() {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;

  const activeNav = useUiStore((s) => s.activeNav);
  const showOnboardingOverride = useUiStore((s) => s.showOnboardingOverride);
  const loadAppInfo = useUiStore((s) => s.loadAppInfo);

  const settings = useSettingsStore((s) => s.settings);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const syncReadOnly = useSettingsStore((s) => s.syncReadOnly);
  const loadDaemonStatus = useSettingsStore((s) => s.loadDaemonStatus);
  const setDaemonStatus = useSettingsStore((s) => s.setDaemonStatus);
  const loadVaultStatus = useSettingsStore((s) => s.loadVaultStatus);
  const setVaultStatus = useSettingsStore((s) => s.setVaultStatus);

  const loadHardwareAll = useHardwareStore((s) => s.loadAll);
  const subscribeDownloadProgress = useHardwareStore((s) => s.subscribeDownloadProgress);
  const subscribeEngineSwapProgress = useHardwareStore((s) => s.subscribeEngineSwapProgress);
  const subscribeIngestProgress = useIngestStore((s) => s.subscribeIngestProgress);

  const loadGraph = useMemoryStore((s) => s.loadGraph);
  const loadBranches = useBranchesStore((s) => s.loadBranches);
  const activeManifest = useThemeStore((s) => s.manifest);
  const loadInstalledThemes = useThemeStore((s) => s.loadInstalledThemes);
  const setActiveTheme = useThemeStore((s) => s.setActiveTheme);

  useEffect(() => {
    applyThemeToRoot(activeManifest);
  }, [activeManifest]);
  const pushActivity = useTelemetryStore((s) => s.pushActivity);
  const ingestActivity = useSynapticStore((s) => s.ingestActivity);
  const pulseMemoryChange = useSynapticStore((s) => s.pulseMemoryChange);
  const ingestCliActivity = useCliActivityStore((s) => s.ingestCliActivity);
  const loadInitialPendingProposals = useProposalsStore((s) => s.loadInitialPendingCount);
  const syncProposalsPendingFromEvent = useProposalsStore((s) => s.syncPendingCountFromEvent);

  useEffect(() => {
    void loadAppInfo();
    void loadSettings().then((loaded) => {
      if (loaded.active_theme_id && loaded.active_theme_id !== BUILTIN_THEME_ID) {
        void setActiveTheme(loaded.active_theme_id);
      }
    });
    void loadHardwareAll();
    void loadBranches();
    void loadInstalledThemes();
    void loadDaemonStatus();
    void loadVaultStatus();
    void loadGraph();
    void loadInitialPendingProposals();

    let active = true;
    let refreshTimer: number | null = null;
    const unlisteners: Array<() => void> = [];

    const register = (promise: Promise<() => void>) => {
      void promise.then((fn) => {
        if (active) {
          unlisteners.push(fn);
        } else {
          fn();
        }
      });
    };

    register(subscribeDownloadProgress());
    register(subscribeEngineSwapProgress());
    register(subscribeIngestProgress());

    register(
      backendOn("cobalt://mcp-activity", (payload) => {
        pushActivity(payload);
        ingestActivity(payload);
      }),
    );

    register(
      backendOn("cobalt://memory-changed", (payload) => {
        useMemoryStore.getState().recordMemoryChange(payload);
        pulseMemoryChange(payload.kind, payload.memory_ids, payload.source_client);
        if (payload.kind === "deleted") {
          useMemoryStore.getState().pruneSelectedNodes(payload.memory_ids);
        }
        if (refreshTimer !== null) {
          window.clearTimeout(refreshTimer);
        }
        refreshTimer = window.setTimeout(() => {
          refreshTimer = null;
          void useMemoryStore.getState().loadGraph();
        }, 220);
      }),
    );

    register(
      backendOn("cobalt://read-only-changed", (payload) => {
        syncReadOnly(payload.read_only);
      }),
    );

    register(
      backendOn("cobalt://daemon-status", (payload) => {
        setDaemonStatus(payload);
      }),
    );

    register(
      backendOn("cobalt://vault-status", (payload) => {
        setVaultStatus(payload);
      }),
    );

    register(
      backendOn("cobalt://cli-activity", (payload) => {
        ingestCliActivity(payload);
      }),
    );

    register(
      backendOn("cobalt://proposals-changed", (payload) => {
        syncProposalsPendingFromEvent(payload.pending);
      }),
    );

    register(
      backendOn("cobalt://themes-changed", (payload) => {
        const themeState = useThemeStore.getState();
        themeState.bumpThemesVersion();
        void themeState.loadInstalledThemes();

        if (payload.applied) {
          void themeState.setActiveTheme(payload.theme_id);
          void useSettingsStore.getState().loadSettings();
        }

        if (payload.source_client !== "cobalt-ui") {
          themeState.pushThemeToast({
            kind: "ai_created",
            message: tRef.current("store.aiThemeCreatedToast", {
              name: payload.name,
              client: payload.source_client,
            }),
            themeId: payload.theme_id,
            themeName: payload.name,
            applied: payload.applied,
          });
        }
      }),
    );

    const onStorage = (event: StorageEvent) => {
      if (!event.newValue) return;
      if (event.key === QUICKNOTE_CONFLICTS_STORAGE_KEY) {
        try {
          const parsed = JSON.parse(event.newValue) as { conflicts?: ConflictHint[] };
          if (Array.isArray(parsed.conflicts) && parsed.conflicts.length > 0) {
            useThemeStore.getState().pushThemeToast({
              kind: "warning",
              message: tRef.current("conflicts.possibleToast", {
                count: parsed.conflicts.length,
              }),
              conflicts: parsed.conflicts,
            });
          }
        } catch {
          // Ignore malformed payload.
        }
      } else if (event.key === QUICKNOTE_INSPECT_STORAGE_KEY) {
        try {
          const parsed = JSON.parse(event.newValue) as { memoryId?: string };
          if (typeof parsed.memoryId === "string" && parsed.memoryId.length > 0) {
            useFiltersStore.getState().resetFilters();
            useMemoryStore.getState().setSelectedNodeId(parsed.memoryId);
            useUiStore.getState().setActiveNav("brain");
          }
        } catch {
          // Ignore malformed payload.
        }
      }
    };
    window.addEventListener("storage", onStorage);

    return () => {
      active = false;
      window.removeEventListener("storage", onStorage);
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };
  }, [
    ingestActivity,
    ingestCliActivity,
    loadAppInfo,
    loadBranches,
    loadDaemonStatus,
    loadGraph,
    loadHardwareAll,
    loadInitialPendingProposals,
    loadInstalledThemes,
    loadSettings,
    loadVaultStatus,
    pulseMemoryChange,
    pushActivity,
    setActiveTheme,
    setDaemonStatus,
    setVaultStatus,
    subscribeDownloadProgress,
    subscribeEngineSwapProgress,
    subscribeIngestProgress,
    syncProposalsPendingFromEvent,
    syncReadOnly,
  ]);

  if (!settingsLoaded) {
    return (
      <div className="cobalt-grid-bg cobalt-view-fade flex h-full w-full flex-col items-center justify-center gap-4 text-xs text-bone-muted">
        <CobaltMark size={26} />
        <div className="w-44 space-y-2 text-center">
          <Skeleton className="h-1.5 w-full" />
          <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-bone-muted">
            {t("shell.loading")}
          </div>
        </div>
      </div>
    );
  }

  if (!settings.onboarding_completed || showOnboardingOverride) {
    return (
      <div className="cobalt-view-enter h-full w-full">
        <OnboardingScreen />
      </div>
    );
  }

  return (
    <div className="flex h-full w-full overflow-hidden bg-void text-bone">
      <Sidebar />
      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-void">
        <TopShellBar />
        <IngestShellIndicator />
        <CliActivityShellBar />
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-void">
            <div
              key={activeNav}
              className={`h-full w-full ${activeNav === "brain" ? "cobalt-view-fade" : "cobalt-view-enter"}`}
            >
              {activeNav === "brain" && <BrainCanvas />}
              {activeNav === "library" && <LibraryView />}
              {activeNav === "telemetry" && <TelemetryView />}
              {activeNav === "stats" && <StatsView />}
              {activeNav === "connectors" && <ConnectorsView />}
              {activeNav === "tools" && <ToolsView />}
              {activeNav === "store" && <ThemeStoreView />}
              {activeNav === "settings" && <SettingsView />}
            </div>
            <WelcomeGreeting />
          </main>
          <ProposalsPanel />
          <ThemeEditorPanel />
        </div>
        <ThemeToastHost />
        <DropIngestHost />
      </div>
    </div>
  );
}
