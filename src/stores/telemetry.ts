import { create } from "zustand";
import { backendCall } from "@/lib/backend";
import { toStoreDisplayError, type DisplayError } from "@/lib/friendlyError";
import type { McpActivity, TelemetryRange, TelemetrySummary } from "@/types/contracts";

const DEFAULT_RANGE: TelemetryRange = {
  from: null,
  to: null,
  session_only: false,
};

export interface TelemetryState {
  summary: TelemetrySummary | null;
  recentActivity: McpActivity[];
  loading: boolean;
  error: DisplayError | null;
  loadSummary: (range?: Partial<TelemetryRange>) => Promise<void>;
  pushActivity: (activity: McpActivity) => void;
}

export const useTelemetryStore = create<TelemetryState>((set) => ({
  summary: null,
  recentActivity: [],
  loading: false,
  error: null,

  loadSummary: async (range) => {
    set({ loading: true, error: null });
    try {
      const summary = await backendCall("get_telemetry_summary", {
        ...DEFAULT_RANGE,
        ...range,
      });
      set({ summary, loading: false });
    } catch (err: unknown) {
      set({ loading: false, error: toStoreDisplayError(err, "get_telemetry_summary") });
    }
  },

  pushActivity: (activity) =>
    set((state) => ({
      recentActivity: [activity, ...state.recentActivity].slice(0, 50),
    })),
}));
