import { create } from "zustand";
import { resolveOperationPulseColor, toLuminousPulseHex } from "@/lib/pulseColors";
import { useThemeStore } from "@/stores/theme";
import type {
  McpActivity,
  MemoryChangeKind,
  TelemetryOperation,
  Uuid,
} from "@/types/contracts";

export interface SynapticPulse {
  memoryId: Uuid;
  /** Luminous hex color (already lightened ≥ 40% for high visibility on dark backgrounds). */
  colorHex: string;
  /** Peak intensity in [0.65 .. 1.0], weighted by `similarity_score`. */
  intensity: number;
  startedAt: number;
  durationMs: number;
}

export const DEFAULT_PULSE_DURATION_MS = 6000;
export const MAX_RECENT_ACTIVITIES = 12;

const CHANGE_PULSE_OPERATIONS: Record<MemoryChangeKind, TelemetryOperation> = {
  created: "write",
  updated: "update",
  superseded: "update",
  archived: "blocked_firewall",
  deleted: "blocked_firewall",
  restored: "write",
};

export interface SynapticState {
  /** High-frequency pulse map read directly in `useFrame` without re-rendering React. */
  pulses: Map<Uuid, SynapticPulse>;
  pulseEpoch: number;
  /** Monotonic counter incremented on every incoming `McpActivity` (drives HUD slide-in + glow). */
  activityEpoch: number;
  latestActivity: McpActivity | null;
  recentFeed: McpActivity[];
  hudVisible: boolean;
  hudExpanded: boolean;
  ingestActivity: (activity: McpActivity) => void;
  pulseMemoryChange: (kind: MemoryChangeKind, memoryIds: readonly Uuid[]) => void;
  pulseNodes: (
    memoryIds: readonly Uuid[],
    colorHex: string,
    durationMs?: number,
    intensity?: number,
  ) => void;
  dismissHud: () => void;
  toggleHudExpanded: () => void;
}

export const useSynapticStore = create<SynapticState>((set, get) => ({
  pulses: new Map<Uuid, SynapticPulse>(),
  pulseEpoch: 0,
  activityEpoch: 0,
  latestActivity: null,
  recentFeed: [],
  hudVisible: false,
  hudExpanded: false,

  ingestActivity: (activity) => {
    const now = performance.now();
    const palette = useThemeStore.getState().manifest.palette;
    const baseHex = resolveOperationPulseColor(activity.operation, palette);
    const luminousHex = toLuminousPulseHex(baseHex);
    const pulses = get().pulses;

    for (const matched of activity.matched_nodes) {
      const score = Number.isFinite(matched.similarity_score) ? matched.similarity_score : 0.85;
      const intensity = Math.max(0.65, Math.min(1.0, score));
      pulses.set(matched.memory_id, {
        memoryId: matched.memory_id,
        colorHex: luminousHex,
        intensity,
        startedAt: now,
        durationMs: DEFAULT_PULSE_DURATION_MS,
      });
    }

    set((state) => ({
      pulseEpoch: state.pulseEpoch + 1,
      activityEpoch: state.activityEpoch + 1,
      latestActivity: activity,
      recentFeed: [activity, ...state.recentFeed].slice(0, MAX_RECENT_ACTIVITIES),
      hudVisible: true,
    }));
  },

  pulseMemoryChange: (kind, memoryIds) => {
    if (memoryIds.length === 0) return;
    const palette = useThemeStore.getState().manifest.palette;
    const baseHex = resolveOperationPulseColor(CHANGE_PULSE_OPERATIONS[kind], palette);
    get().pulseNodes(memoryIds, baseHex, DEFAULT_PULSE_DURATION_MS, 0.9);
  },

  pulseNodes: (memoryIds, colorHex, durationMs = DEFAULT_PULSE_DURATION_MS, intensity = 0.95) => {
    if (memoryIds.length === 0) return;
    const now = performance.now();
    const pulses = get().pulses;
    const luminousHex = toLuminousPulseHex(colorHex);
    const clampedIntensity = Math.max(0.5, Math.min(1.0, intensity));
    for (const id of memoryIds) {
      pulses.set(id, {
        memoryId: id,
        colorHex: luminousHex,
        intensity: clampedIntensity,
        startedAt: now,
        durationMs,
      });
    }
    set((state) => ({ pulseEpoch: state.pulseEpoch + 1 }));
  },

  dismissHud: () => set({ hudVisible: false, hudExpanded: false }),
  toggleHudExpanded: () => set((state) => ({ hudExpanded: !state.hudExpanded })),
}));
