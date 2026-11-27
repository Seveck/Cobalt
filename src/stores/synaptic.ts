import { create } from "zustand";
import { resolveOperationPulseColor, toLuminousPulseHex } from "@/lib/pulseColors";
import { useThemeStore } from "@/stores/theme";
import type {
  McpActivity,
  MemoryChangeKind,
  TelemetryOperation,
  Uuid,
} from "@/types/contracts";

export type SynapticPulseKind = "ai" | "flicker";

export interface SynapticPulse {
  memoryId: Uuid;
  /** Luminous hex color for AI pulses, or subtle operation tint for internal flickers. */
  colorHex: string;
  /** Peak intensity in [0.65 .. 1.0] for AI pulses, or faint (~0.35) for internal flickers. */
  intensity: number;
  startedAt: number;
  durationMs: number;
  /** `"ai"` triggers strong halo + dimming + off-screen count; `"flicker"` is a faint 1 s tint only. */
  kind: SynapticPulseKind;
}

export const DEFAULT_PULSE_DURATION_MS = 6000;
export const INTERNAL_FLICKER_DURATION_MS = 1000;
export const INTERNAL_FLICKER_MAX_NODES = 20;
export const INTERNAL_FLICKER_INTENSITY = 0.35;
export const MAX_RECENT_ACTIVITIES = 12;

/**
 * Non-AI / background sources for `cobalt://memory-changed` that must never trigger
 * the strong synaptic pulse, dimming, or off-screen count.
 */
export const INTERNAL_MEMORY_SOURCES: ReadonlySet<string> = new Set([
  "cobalt-ingest",
  "cobalt-capture",
  "cobalt-library",
  "cobalt-ui",
  "cobalt-quicknote",
  "cobalt-import",
  "git",
]);

/** Returns true when a `source_client` belongs to Cobalt internals/indexing rather than an AI. */
export function isInternalMemorySource(sourceClient: string | null | undefined): boolean {
  if (sourceClient == null) return true;
  const normalized = sourceClient.trim().toLowerCase();
  if (normalized.length === 0) return true;
  return INTERNAL_MEMORY_SOURCES.has(normalized);
}

const CHANGE_PULSE_OPERATIONS: Record<MemoryChangeKind, TelemetryOperation> = {
  created: "write",
  updated: "update",
  superseded: "update",
  archived: "blocked_firewall",
  deleted: "blocked_firewall",
  restored: "write",
};

/** Rolling 1 s window tracking internal change volume to suppress flickers during bulk indexing (> 20 nodes). */
interface InternalBurstSample {
  ts: number;
  count: number;
}
const internalBurstWindow: InternalBurstSample[] = [];

function recordInternalBurstAndCheckSuppressed(now: number, incomingCount: number): boolean {
  const cutoff = now - INTERNAL_FLICKER_DURATION_MS;
  while (internalBurstWindow.length > 0 && (internalBurstWindow[0]?.ts ?? 0) < cutoff) {
    internalBurstWindow.shift();
  }
  internalBurstWindow.push({ ts: now, count: incomingCount });
  if (incomingCount > INTERNAL_FLICKER_MAX_NODES) {
    return true;
  }
  let total = 0;
  for (const sample of internalBurstWindow) {
    total += sample.count;
  }
  return total > INTERNAL_FLICKER_MAX_NODES;
}

function clearInternalFlickers(pulses: Map<Uuid, SynapticPulse>): boolean {
  let removed = false;
  for (const [id, entry] of pulses.entries()) {
    if (entry.kind === "flicker") {
      pulses.delete(id);
      removed = true;
    }
  }
  return removed;
}

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
  pulseMemoryChange: (
    kind: MemoryChangeKind,
    memoryIds: readonly Uuid[],
    sourceClient?: string | null,
  ) => void;
  pulseNodes: (
    memoryIds: readonly Uuid[],
    colorHex: string,
    durationMs?: number,
    intensity?: number,
    kind?: SynapticPulseKind,
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
    const manifest = useThemeStore.getState().manifest;
    const isLightMode = manifest.ui?.mode === "light";
    const baseHex = resolveOperationPulseColor(activity.operation, manifest.palette);
    const pulseHex = isLightMode ? baseHex : toLuminousPulseHex(baseHex);
    const pulses = get().pulses;

    for (const matched of activity.matched_nodes) {
      const score = Number.isFinite(matched.similarity_score) ? matched.similarity_score : 0.85;
      const intensity = Math.max(0.65, Math.min(1.0, score));
      pulses.set(matched.memory_id, {
        memoryId: matched.memory_id,
        colorHex: pulseHex,
        intensity,
        startedAt: now,
        durationMs: DEFAULT_PULSE_DURATION_MS,
        kind: "ai",
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

  pulseMemoryChange: (kind, memoryIds, sourceClient = null) => {
    if (memoryIds.length === 0) return;
    const palette = useThemeStore.getState().manifest.palette;
    const baseHex = resolveOperationPulseColor(CHANGE_PULSE_OPERATIONS[kind], palette);

    if (!isInternalMemorySource(sourceClient)) {
      get().pulseNodes(memoryIds, baseHex, DEFAULT_PULSE_DURATION_MS, 0.9, "ai");
      return;
    }

    const now = performance.now();
    const pulses = get().pulses;
    if (recordInternalBurstAndCheckSuppressed(now, memoryIds.length)) {
      if (clearInternalFlickers(pulses)) {
        set((state) => ({ pulseEpoch: state.pulseEpoch + 1 }));
      }
      return;
    }

    get().pulseNodes(
      memoryIds,
      baseHex,
      INTERNAL_FLICKER_DURATION_MS,
      INTERNAL_FLICKER_INTENSITY,
      "flicker",
    );
  },

  pulseNodes: (
    memoryIds,
    colorHex,
    durationMs = DEFAULT_PULSE_DURATION_MS,
    intensity = 0.95,
    kind = "ai",
  ) => {
    if (memoryIds.length === 0) return;
    const now = performance.now();
    const pulses = get().pulses;

    if (kind === "flicker") {
      const clampedIntensity = Math.max(0.05, Math.min(0.45, intensity));
      let added = false;
      for (const id of memoryIds) {
        const existing = pulses.get(id);
        // Never let a faint internal flicker overwrite an active AI pulse
        if (existing && existing.kind === "ai" && now - existing.startedAt < existing.durationMs) {
          continue;
        }
        pulses.set(id, {
          memoryId: id,
          colorHex,
          intensity: clampedIntensity,
          startedAt: now,
          durationMs,
          kind: "flicker",
        });
        added = true;
      }
      if (added) {
        set((state) => ({ pulseEpoch: state.pulseEpoch + 1 }));
      }
      return;
    }

    const isLightMode = useThemeStore.getState().manifest.ui?.mode === "light";
    const pulseHex = isLightMode ? colorHex : toLuminousPulseHex(colorHex);
    const clampedIntensity = Math.max(0.5, Math.min(1.0, intensity));
    for (const id of memoryIds) {
      pulses.set(id, {
        memoryId: id,
        colorHex: pulseHex,
        intensity: clampedIntensity,
        startedAt: now,
        durationMs,
        kind: "ai",
      });
    }
    set((state) => ({ pulseEpoch: state.pulseEpoch + 1 }));
  },

  dismissHud: () => set({ hudVisible: false, hudExpanded: false }),
  toggleHudExpanded: () => set((state) => ({ hudExpanded: !state.hudExpanded })),
}));
