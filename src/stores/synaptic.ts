import { create } from "zustand";
import {
  OPERATION_COLORS,
  type McpActivity,
  type MemoryChangeKind,
  type Uuid,
} from "@/types/contracts";

export interface SynapticPulse {
  memoryId: Uuid;
  colorHex: string;
  /** Peak intensity in [0.25 .. 1.0], weighted by `similarity_score`. */
  intensity: number;
  startedAt: number;
  durationMs: number;
}

const DEFAULT_PULSE_DURATION_MS = 2800;
const CHANGE_PULSE_COLORS: Record<MemoryChangeKind, string> = {
  created: OPERATION_COLORS.write,
  updated: OPERATION_COLORS.update,
  superseded: OPERATION_COLORS.update,
  archived: OPERATION_COLORS.blocked_firewall,
  deleted: OPERATION_COLORS.blocked_firewall,
  restored: OPERATION_COLORS.write,
};

export interface SynapticState {
  /** High-frequency pulse map read directly in `useFrame` without re-rendering React. */
  pulses: Map<Uuid, SynapticPulse>;
  pulseEpoch: number;
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
  latestActivity: null,
  recentFeed: [],
  hudVisible: false,
  hudExpanded: false,

  ingestActivity: (activity) => {
    const now = performance.now();
    const colorHex = OPERATION_COLORS[activity.operation];
    const pulses = get().pulses;

    for (const matched of activity.matched_nodes) {
      const score = Number.isFinite(matched.similarity_score) ? matched.similarity_score : 0.7;
      const intensity = Math.max(0.3, Math.min(1.0, score));
      pulses.set(matched.memory_id, {
        memoryId: matched.memory_id,
        colorHex,
        intensity,
        startedAt: now,
        durationMs: DEFAULT_PULSE_DURATION_MS,
      });
    }

    set((state) => ({
      pulseEpoch: state.pulseEpoch + 1,
      latestActivity: activity,
      recentFeed: [activity, ...state.recentFeed].slice(0, 12),
      hudVisible: true,
    }));
  },

  pulseMemoryChange: (kind, memoryIds) => {
    if (memoryIds.length === 0) return;
    get().pulseNodes(memoryIds, CHANGE_PULSE_COLORS[kind], 1800, 0.75);
  },

  pulseNodes: (memoryIds, colorHex, durationMs = DEFAULT_PULSE_DURATION_MS, intensity = 0.9) => {
    if (memoryIds.length === 0) return;
    const now = performance.now();
    const pulses = get().pulses;
    const clampedIntensity = Math.max(0.25, Math.min(1.0, intensity));
    for (const id of memoryIds) {
      pulses.set(id, {
        memoryId: id,
        colorHex,
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
