import { create } from "zustand";
import { BRIGHT_OPERATION_COLORS } from "@/lib/pulseColors";
import { resolveNodesForTouchedFiles } from "@/lib/sourceDocCache";
import { useMemoryStore } from "@/stores/memory";
import { DEFAULT_PULSE_DURATION_MS, useSynapticStore } from "@/stores/synaptic";
import type {
  CliActivity,
  CliActivityKind,
  Uuid,
} from "@/types/contracts";

export interface CliActivityEntry {
  id: string;
  activity: CliActivity;
  matchedNodeIds: Uuid[];
}

export const CLI_ACTIVITY_COLORS: Record<CliActivityKind, string> = {
  session_start: BRIGHT_OPERATION_COLORS.read,
  file_edit: BRIGHT_OPERATION_COLORS.update,
  command: BRIGHT_OPERATION_COLORS.read,
  turn_end: BRIGHT_OPERATION_COLORS.handoff,
  session_end: BRIGHT_OPERATION_COLORS.handoff,
  git_commit: BRIGHT_OPERATION_COLORS.write,
};

const MAX_FEED_ENTRIES = 24;
let entryCounter = 0;

export interface CliActivityState {
  entries: CliActivityEntry[];
  visible: boolean;
  expanded: boolean;
  ingestCliActivity: (activity: CliActivity) => void;
  dismissBar: () => void;
  toggleExpanded: () => void;
  setExpanded: (expanded: boolean) => void;
  clearFeed: () => void;
}

export const useCliActivityStore = create<CliActivityState>((set) => ({
  entries: [],
  visible: false,
  expanded: false,

  ingestCliActivity: (activity) => {
    entryCounter += 1;
    const id = `cli-${Date.now()}-${entryCounter}`;

    set((state) => ({
      entries: [{ id, activity, matchedNodeIds: [] }, ...state.entries].slice(0, MAX_FEED_ENTRIES),
      visible: true,
    }));

    if (activity.files.length > 0) {
      const graph = useMemoryStore.getState().graph;
      void resolveNodesForTouchedFiles(
        graph,
        activity.files,
        activity.cwd,
        activity.project_id,
      ).then((matchedIds) => {
        if (matchedIds.length === 0) return;
        const pulseColor = CLI_ACTIVITY_COLORS[activity.kind];
        useSynapticStore
          .getState()
          .pulseNodes(matchedIds, pulseColor, DEFAULT_PULSE_DURATION_MS, 0.95);
        set((state) => ({
          entries: state.entries.map((entry) =>
            entry.id === id ? { ...entry, matchedNodeIds: matchedIds } : entry,
          ),
        }));
      });
    }
  },

  dismissBar: () => set({ visible: false, expanded: false }),
  toggleExpanded: () => set((state) => ({ expanded: !state.expanded })),
  setExpanded: (expanded) => set({ expanded }),
  clearFeed: () => set({ entries: [], visible: false, expanded: false }),
}));
