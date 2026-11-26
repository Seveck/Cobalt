import { create } from "zustand";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { backendCall, backendOn } from "@/lib/backend";
import type {
  DownloadProgress,
  EmbeddingModelSpec,
  EngineInstallRequest,
  EngineKind,
  EngineStatus,
  EngineSwapProgress,
  EngineSwapReport,
  EngineSwapRequest,
  HardwareProfile,
} from "@/types/contracts";

export interface HardwareState {
  profile: HardwareProfile | null;
  models: EmbeddingModelSpec[];
  engineStatus: EngineStatus | null;
  downloadProgress: DownloadProgress | null;
  isInstalling: boolean;
  isCancelling: boolean;
  swapProgress: EngineSwapProgress | null;
  swapReport: EngineSwapReport | null;
  isSwapping: boolean;
  loading: boolean;
  error: string | null;
  loadAll: () => Promise<void>;
  loadProfile: () => Promise<HardwareProfile | null>;
  loadModels: () => Promise<EmbeddingModelSpec[]>;
  loadEngineStatus: () => Promise<EngineStatus | null>;
  installEngine: (req: EngineInstallRequest) => Promise<EngineStatus | null>;
  cancelDownload: () => Promise<void>;
  swapEngine: (req: EngineSwapRequest) => Promise<EngineSwapReport | null>;
  removeEngineArtifacts: (
    engine: EngineKind | null,
    modelId: string | null,
  ) => Promise<number | null>;
  setDownloadProgress: (progress: DownloadProgress | null) => void;
  setSwapProgress: (progress: EngineSwapProgress | null) => void;
  clearSwapReport: () => void;
  clearError: () => void;
  subscribeDownloadProgress: () => Promise<UnlistenFn>;
  subscribeEngineSwapProgress: () => Promise<UnlistenFn>;
}

export const useHardwareStore = create<HardwareState>((set, get) => ({
  profile: null,
  models: [],
  engineStatus: null,
  downloadProgress: null,
  isInstalling: false,
  isCancelling: false,
  swapProgress: null,
  swapReport: null,
  isSwapping: false,
  loading: false,
  error: null,

  loadAll: async () => {
    set({ loading: true, error: null });
    try {
      const [profile, models, engineStatus] = await Promise.all([
        backendCall("get_hardware_profile"),
        backendCall("list_embedding_models"),
        backendCall("get_engine_status"),
      ]);
      set({ profile, models, engineStatus, loading: false });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      set({ loading: false, error: message });
    }
  },

  loadProfile: async () => {
    try {
      const profile = await backendCall("get_hardware_profile");
      set({ profile });
      return profile;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      return null;
    }
  },

  loadModels: async () => {
    try {
      const models = await backendCall("list_embedding_models");
      set({ models });
      return models;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      return [];
    }
  },

  loadEngineStatus: async () => {
    try {
      const engineStatus = await backendCall("get_engine_status");
      set({ engineStatus });
      return engineStatus;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      return null;
    }
  },

  installEngine: async (req) => {
    set({ isInstalling: true, isCancelling: false, error: null, downloadProgress: null });
    try {
      const engineStatus = await backendCall("install_engine", req);
      set({ engineStatus, isInstalling: false, isCancelling: false });
      return engineStatus;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      set({ isInstalling: false, isCancelling: false, error: message });
      return null;
    }
  },

  cancelDownload: async () => {
    const progress = get().downloadProgress;
    const artifactId = progress?.artifact_id ?? "";
    set({ isCancelling: true });
    try {
      await backendCall("cancel_download", { artifact_id: artifactId });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message, isCancelling: false });
    }
  },

  swapEngine: async (req) => {
    set({ isSwapping: true, error: null, swapProgress: null, swapReport: null });
    try {
      const report = await backendCall("swap_engine", req);
      const engineStatus = await backendCall("get_engine_status");
      set({ swapReport: report, engineStatus, isSwapping: false });
      return report;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      set({ isSwapping: false, error: message });
      return null;
    }
  },

  removeEngineArtifacts: async (engine, modelId) => {
    set({ error: null });
    try {
      const reclaimed = await backendCall("remove_engine_artifacts", {
        engine,
        model_id: modelId,
      });
      await get().loadEngineStatus();
      set((state) => ({
        swapReport: state.swapReport
          ? { ...state.swapReport, reclaimable_bytes: 0 }
          : state.swapReport,
      }));
      return reclaimed;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      return null;
    }
  },

  setDownloadProgress: (downloadProgress) => set({ downloadProgress }),
  setSwapProgress: (swapProgress) => set({ swapProgress }),
  clearSwapReport: () => set({ swapReport: null, swapProgress: null }),
  clearError: () => set({ error: null }),

  subscribeDownloadProgress: () =>
    backendOn("cobalt://download-progress", (payload) => {
      set({ downloadProgress: payload });
    }),

  subscribeEngineSwapProgress: () =>
    backendOn("cobalt://engine-swap-progress", (payload) => {
      set({ swapProgress: payload });
    }),
}));
