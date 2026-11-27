import { create } from "zustand";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { backendCall, backendOn } from "@/lib/backend";
import {
  DEFAULT_OCR_MODEL,
  type DownloadProgress,
  type EmbeddingModelSpec,
  type EngineInstallRequest,
  type EngineKind,
  type EngineStatus,
  type EngineSwapProgress,
  type EngineSwapReport,
  type EngineSwapRequest,
  type HardwareProfile,
  type OcrStatus,
} from "@/types/contracts";

const KNOWN_OCR_MODEL_IDS = [DEFAULT_OCR_MODEL, "ocrs-latin"] as const;

export interface OcrArtifactBytes {
  downloaded: number;
  total: number | null;
}

function resolveOcrModelId(
  artifactId: string,
  ocrModels: readonly OcrStatus[],
): string | null {
  const knownIds = new Set<string>(KNOWN_OCR_MODEL_IDS);
  for (const model of ocrModels) {
    knownIds.add(model.model_id);
  }
  const slashIdx = artifactId.indexOf("/");
  const prefix = slashIdx >= 0 ? artifactId.slice(0, slashIdx) : artifactId;
  if (knownIds.has(prefix)) {
    return prefix;
  }
  if (prefix.startsWith("paddleocr-") || prefix.startsWith("ocrs-")) {
    return prefix;
  }
  return null;
}

function pickActiveOcrStatus(models: readonly OcrStatus[]): OcrStatus | null {
  return (
    models.find((model) => model.active) ??
    models.find((model) => model.model_id === DEFAULT_OCR_MODEL) ??
    models[0] ??
    null
  );
}

function omitRecordKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

export interface HardwareState {
  profile: HardwareProfile | null;
  models: EmbeddingModelSpec[];
  engineStatus: EngineStatus | null;
  ocrModels: OcrStatus[];
  ocrStatus: OcrStatus | null;
  downloadProgress: DownloadProgress | null;
  isInstalling: boolean;
  isCancelling: boolean;
  ocrDownloadProgressByModel: Record<string, DownloadProgress>;
  ocrArtifactBytesByModel: Record<string, Record<string, OcrArtifactBytes>>;
  ocrInstallingByModel: Record<string, boolean>;
  ocrCancellingByModel: Record<string, boolean>;
  ocrRemovingByModel: Record<string, boolean>;
  ocrErrorByModel: Record<string, string | null>;
  swapProgress: EngineSwapProgress | null;
  swapReport: EngineSwapReport | null;
  isSwapping: boolean;
  loading: boolean;
  error: string | null;
  loadAll: () => Promise<void>;
  loadProfile: () => Promise<HardwareProfile | null>;
  loadModels: () => Promise<EmbeddingModelSpec[]>;
  loadEngineStatus: () => Promise<EngineStatus | null>;
  loadOcrModels: () => Promise<OcrStatus[]>;
  loadOcrStatus: () => Promise<OcrStatus | null>;
  installEngine: (req: EngineInstallRequest) => Promise<EngineStatus | null>;
  cancelDownload: () => Promise<void>;
  installOcr: (modelId?: string) => Promise<OcrStatus | null>;
  cancelOcrDownload: (modelId?: string) => Promise<void>;
  removeOcr: (modelId: string) => Promise<number | null>;
  swapEngine: (req: EngineSwapRequest) => Promise<EngineSwapReport | null>;
  removeEngineArtifacts: (
    engine: EngineKind | null,
    modelId: string | null,
  ) => Promise<number | null>;
  setDownloadProgress: (progress: DownloadProgress | null) => void;
  setSwapProgress: (progress: EngineSwapProgress | null) => void;
  clearSwapReport: () => void;
  clearError: () => void;
  clearOcrError: (modelId?: string) => void;
  subscribeDownloadProgress: () => Promise<UnlistenFn>;
  subscribeEngineSwapProgress: () => Promise<UnlistenFn>;
}

export const useHardwareStore = create<HardwareState>((set, get) => ({
  profile: null,
  models: [],
  engineStatus: null,
  ocrModels: [],
  ocrStatus: null,
  downloadProgress: null,
  isInstalling: false,
  isCancelling: false,
  ocrDownloadProgressByModel: {},
  ocrArtifactBytesByModel: {},
  ocrInstallingByModel: {},
  ocrCancellingByModel: {},
  ocrRemovingByModel: {},
  ocrErrorByModel: {},
  swapProgress: null,
  swapReport: null,
  isSwapping: false,
  loading: false,
  error: null,

  loadAll: async () => {
    set({ loading: true, error: null });
    try {
      const [profile, models, engineStatus, ocrModels] = await Promise.all([
        backendCall("get_hardware_profile"),
        backendCall("list_embedding_models"),
        backendCall("get_engine_status"),
        backendCall("list_ocr_models").catch(() => []),
      ]);
      const ocrStatus =
        pickActiveOcrStatus(ocrModels) ??
        (await backendCall("get_ocr_status").catch(() => null));
      set({ profile, models, engineStatus, ocrModels, ocrStatus, loading: false });
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

  loadOcrModels: async () => {
    try {
      const ocrModels = await backendCall("list_ocr_models");
      const ocrStatus = pickActiveOcrStatus(ocrModels);
      set({ ocrModels, ocrStatus });
      return ocrModels;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const fallbackModelId = get().ocrStatus?.model_id ?? DEFAULT_OCR_MODEL;
      set((state) => ({
        ocrErrorByModel: {
          ...state.ocrErrorByModel,
          [fallbackModelId]: message,
        },
      }));
      return get().ocrModels;
    }
  },

  loadOcrStatus: async () => {
    const models = await get().loadOcrModels();
    const active = pickActiveOcrStatus(models);
    if (active) {
      return active;
    }
    try {
      const ocrStatus = await backendCall("get_ocr_status");
      set({ ocrStatus });
      return ocrStatus;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      set((state) => ({
        ocrErrorByModel: {
          ...state.ocrErrorByModel,
          [DEFAULT_OCR_MODEL]: message,
        },
      }));
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

  installOcr: async (modelId) => {
    const targetModelId = modelId ?? get().ocrStatus?.model_id ?? DEFAULT_OCR_MODEL;
    set((state) => ({
      ocrInstallingByModel: { ...state.ocrInstallingByModel, [targetModelId]: true },
      ocrCancellingByModel: { ...state.ocrCancellingByModel, [targetModelId]: false },
      ocrErrorByModel: { ...state.ocrErrorByModel, [targetModelId]: null },
      ocrDownloadProgressByModel: omitRecordKey(state.ocrDownloadProgressByModel, targetModelId),
      ocrArtifactBytesByModel: omitRecordKey(state.ocrArtifactBytesByModel, targetModelId),
    }));
    try {
      const installedStatus = await backendCall("install_ocr", { model_id: targetModelId });
      const refreshedModels = await backendCall("list_ocr_models").catch(() => null);
      set((state) => {
        const nextModels =
          refreshedModels ??
          (state.ocrModels.some((m) => m.model_id === installedStatus.model_id)
            ? state.ocrModels.map((m) =>
                m.model_id === installedStatus.model_id
                  ? { ...installedStatus, active: m.active || installedStatus.active }
                  : m,
              )
            : [...state.ocrModels, installedStatus]);
        return {
          ocrModels: nextModels,
          ocrStatus: pickActiveOcrStatus(nextModels) ?? installedStatus,
          ocrInstallingByModel: { ...state.ocrInstallingByModel, [targetModelId]: false },
          ocrCancellingByModel: { ...state.ocrCancellingByModel, [targetModelId]: false },
          ocrDownloadProgressByModel: omitRecordKey(
            state.ocrDownloadProgressByModel,
            targetModelId,
          ),
          ocrArtifactBytesByModel: omitRecordKey(state.ocrArtifactBytesByModel, targetModelId),
        };
      });
      return (
        get().ocrModels.find((m) => m.model_id === installedStatus.model_id) ?? installedStatus
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      set((state) => ({
        ocrInstallingByModel: { ...state.ocrInstallingByModel, [targetModelId]: false },
        ocrCancellingByModel: { ...state.ocrCancellingByModel, [targetModelId]: false },
        ocrErrorByModel: { ...state.ocrErrorByModel, [targetModelId]: message },
      }));
      void get().loadOcrModels();
      return null;
    }
  },

  cancelOcrDownload: async (modelId) => {
    const targetModelId = modelId ?? get().ocrStatus?.model_id ?? DEFAULT_OCR_MODEL;
    const progress = get().ocrDownloadProgressByModel[targetModelId];
    const artifactId = progress?.artifact_id ?? targetModelId;
    set((state) => ({
      ocrCancellingByModel: { ...state.ocrCancellingByModel, [targetModelId]: true },
    }));
    try {
      await backendCall("cancel_download", { artifact_id: artifactId });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      set((state) => ({
        ocrErrorByModel: { ...state.ocrErrorByModel, [targetModelId]: message },
        ocrCancellingByModel: { ...state.ocrCancellingByModel, [targetModelId]: false },
      }));
    }
  },

  removeOcr: async (modelId) => {
    set((state) => ({
      ocrRemovingByModel: { ...state.ocrRemovingByModel, [modelId]: true },
      ocrErrorByModel: { ...state.ocrErrorByModel, [modelId]: null },
    }));
    try {
      const freedBytes = await backendCall("remove_ocr", { model_id: modelId });
      set((state) => ({
        ocrDownloadProgressByModel: omitRecordKey(state.ocrDownloadProgressByModel, modelId),
        ocrArtifactBytesByModel: omitRecordKey(state.ocrArtifactBytesByModel, modelId),
      }));
      await get().loadOcrModels();
      set((state) => ({
        ocrRemovingByModel: { ...state.ocrRemovingByModel, [modelId]: false },
      }));
      return freedBytes;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      set((state) => ({
        ocrRemovingByModel: { ...state.ocrRemovingByModel, [modelId]: false },
        ocrErrorByModel: { ...state.ocrErrorByModel, [modelId]: message },
      }));
      return null;
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
  clearOcrError: (modelId) => {
    if (modelId) {
      set((state) => ({
        ocrErrorByModel: { ...state.ocrErrorByModel, [modelId]: null },
      }));
    } else {
      set({ ocrErrorByModel: {} });
    }
  },

  subscribeDownloadProgress: () =>
    backendOn("cobalt://download-progress", (payload) => {
      const ocrModelId = resolveOcrModelId(payload.artifact_id, get().ocrModels);
      if (ocrModelId) {
        const isTerminal = payload.phase === "failed" || payload.phase === "cancelled";
        const artifactDownloaded =
          payload.phase === "completed" && payload.total_bytes !== null
            ? payload.total_bytes
            : payload.downloaded_bytes;
        set((state) => {
          const prevArtifacts = state.ocrArtifactBytesByModel[ocrModelId] ?? {};
          return {
            ocrDownloadProgressByModel: {
              ...state.ocrDownloadProgressByModel,
              [ocrModelId]: payload,
            },
            ocrArtifactBytesByModel: {
              ...state.ocrArtifactBytesByModel,
              [ocrModelId]: {
                ...prevArtifacts,
                [payload.artifact_id]: {
                  downloaded: artifactDownloaded,
                  total: payload.total_bytes,
                },
              },
            },
            ocrCancellingByModel: isTerminal
              ? { ...state.ocrCancellingByModel, [ocrModelId]: false }
              : state.ocrCancellingByModel,
          };
        });
      } else {
        set({ downloadProgress: payload });
      }
    }),

  subscribeEngineSwapProgress: () =>
    backendOn("cobalt://engine-swap-progress", (payload) => {
      set({ swapProgress: payload });
    }),
}));
