import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { backendOn } from "@/lib/backend";
import {
  useBranchesStore,
  useHardwareStore,
  useMemoryStore,
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
import { SettingsView } from "@/components/settings/SettingsView";
import { CobaltMark } from "@/components/shell/CobaltMark";
import { Sidebar } from "@/components/shell/Sidebar";
import { ThemeStoreView } from "@/components/store/ThemeStoreView";
import { TelemetryView } from "@/components/telemetry/TelemetryView";

export default function App() {
  const { t } = useTranslation();

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

  const loadGraph = useMemoryStore((s) => s.loadGraph);
  const loadBranches = useBranchesStore((s) => s.loadBranches);
  const loadInstalledThemes = useThemeStore((s) => s.loadInstalledThemes);
  const pushActivity = useTelemetryStore((s) => s.pushActivity);
  const ingestActivity = useSynapticStore((s) => s.ingestActivity);
  const pulseMemoryChange = useSynapticStore((s) => s.pulseMemoryChange);

  useEffect(() => {
    void loadAppInfo();
    void loadSettings();
    void loadHardwareAll();
    void loadBranches();
    void loadInstalledThemes();
    void loadDaemonStatus();
    void loadVaultStatus();
    void loadGraph();

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

    register(
      backendOn("cobalt://mcp-activity", (payload) => {
        pushActivity(payload);
        ingestActivity(payload);
      }),
    );

    register(
      backendOn("cobalt://memory-changed", (payload) => {
        pulseMemoryChange(payload.kind, payload.memory_ids);
        if (payload.kind === "deleted") {
          const selected = useMemoryStore.getState().selectedNodeId;
          if (selected && payload.memory_ids.includes(selected)) {
            useMemoryStore.getState().setSelectedNodeId(null);
          }
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

    return () => {
      active = false;
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };
  }, [
    ingestActivity,
    loadAppInfo,
    loadBranches,
    loadDaemonStatus,
    loadGraph,
    loadHardwareAll,
    loadInstalledThemes,
    loadSettings,
    loadVaultStatus,
    pulseMemoryChange,
    pushActivity,
    setDaemonStatus,
    setVaultStatus,
    subscribeDownloadProgress,
    syncReadOnly,
  ]);

  if (!settingsLoaded) {
    return (
      <div className="cobalt-grid-bg flex h-full w-full flex-col items-center justify-center gap-3 text-xs text-bone-muted">
        <CobaltMark size={26} />
        <div className="flex items-center gap-2 font-mono uppercase tracking-[0.14em]">
          <Loader2 size={13} className="animate-spin text-cobalt-ink" aria-hidden />
          <span>{t("shell.loading")}</span>
        </div>
      </div>
    );
  }

  if (!settings.onboarding_completed || showOnboardingOverride) {
    return <OnboardingScreen />;
  }

  return (
    <div className="flex h-full w-full overflow-hidden bg-void text-bone">
      <Sidebar />
      <main className="relative flex-1 overflow-hidden bg-void">
        {activeNav === "brain" && <BrainCanvas />}
        {activeNav === "library" && <LibraryView />}
        {activeNav === "telemetry" && <TelemetryView />}
        {activeNav === "connectors" && <ConnectorsView />}
        {activeNav === "store" && <ThemeStoreView />}
        {activeNav === "settings" && <SettingsView />}
      </main>
    </div>
  );
}
