import { create } from "zustand";
import { resolveNodesForTouchedFiles } from "@/lib/sourceDocCache";
import { useMemoryStore } from "@/stores/memory";
import { useSynapticStore } from "@/stores/synaptic";
import {
  OPERATION_COLORS,
  type CliActivity,
  type CliActivityKind,
  type Uuid,
} from "@/types/contracts";

export interface CliActivityEntry {
  id: string;
  activity: CliActivity;
  matchedNodeIds: Uuid[];
}

export const CLI_ACTIVITY_COLORS: Record<CliActivityKind, string> = {
  session_start: OPERATION_COLORS.read,
  file_edit: OPERATION_COLORS.update,
  command: OPERATION_COLORS.read,
  turn_end: OPERATION_COLORS.handoff,
  session_end: OPERATION_COLORS.handoff,
  git_commit: OPERATION_COLORS.write,
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
        useSynapticStore.getState().pulseNodes(matchedIds, pulseColor, 3200, 0.95);
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
