import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import {
  useBranchesStore,
  useHardwareStore,
  useMemoryStore,
  useSettingsStore,
  useThemeStore,
  useUiStore,
} from "@/stores";
import { BrainCanvas } from "@/components/canvas3d";
import { ConnectorsView } from "@/components/connectors/ConnectorsView";
import { LibraryView } from "@/components/library/LibraryView";
import { OnboardingScreen } from "@/components/onboarding";
import { SettingsView } from "@/components/settings/SettingsView";
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

  const loadHardwareAll = useHardwareStore((s) => s.loadAll);
  const subscribeDownloadProgress = useHardwareStore((s) => s.subscribeDownloadProgress);

  const loadGraph = useMemoryStore((s) => s.loadGraph);
  const loadBranches = useBranchesStore((s) => s.loadBranches);
  const loadInstalledThemes = useThemeStore((s) => s.loadInstalledThemes);

  useEffect(() => {
    void loadAppInfo();
    void loadSettings();
    void loadHardwareAll();
    void loadBranches();
    void loadInstalledThemes();
    void loadGraph();

    let active = true;
    let unlisten: (() => void) | null = null;

    void subscribeDownloadProgress().then((fn) => {
      if (active) {
        unlisten = fn;
      } else {
        fn();
      }
    });

    return () => {
      active = false;
      unlisten?.();
    };
  }, [
    loadAppInfo,
    loadSettings,
    loadHardwareAll,
    loadBranches,
    loadInstalledThemes,
    loadGraph,
    subscribeDownloadProgress,
  ]);

  if (!settingsLoaded) {
    return (
      <div className="flex h-full w-full items-center justify-center gap-2 bg-void text-sm text-slate-400">
        <Loader2 size={16} className="animate-spin text-cobalt-300" aria-hidden />
        <span>{t("shell.loading")}</span>
      </div>
    );
  }

  if (!settings.onboarding_completed || showOnboardingOverride) {
    return <OnboardingScreen />;
  }

  return (
    <div className="flex h-full w-full overflow-hidden bg-void text-slate-100">
      <Sidebar />
      <main className="relative flex-1 overflow-hidden">
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
