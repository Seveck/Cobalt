import { create } from "zustand";
import { backendCall } from "@/lib/backend";
import type { GraphData, GraphQuery, Uuid } from "@/types/contracts";

const DEFAULT_GRAPH_QUERY: GraphQuery = {
  branch_id: null,
  include_archived: true,
  include_superseded: true,
  min_edge_weight: null,
  limit: null,
};

export interface CameraFocusRequest {
  nodeIds: Uuid[];
  nonce: number;
}

export interface MemoryState {
  graph: GraphData | null;
  graphRevision: number;
  selectedNodeId: Uuid | null;
  hoveredNodeId: Uuid | null;
  highlightedNodeIds: ReadonlySet<Uuid>;
  focusRequest: CameraFocusRequest | null;
  loading: boolean;
  error: string | null;
  loadGraph: (query?: Partial<GraphQuery>) => Promise<void>;
  setSelectedNodeId: (id: Uuid | null) => void;
  setHoveredNodeId: (id: Uuid | null) => void;
  setHighlightedNodeIds: (ids: readonly Uuid[]) => void;
  requestFocusNodes: (ids: readonly Uuid[]) => void;
  clearFocusRequest: () => void;
}

let focusNonceCounter = 0;

export const useMemoryStore = create<MemoryState>((set) => ({
  graph: null,
  graphRevision: 0,
  selectedNodeId: null,
  hoveredNodeId: null,
  highlightedNodeIds: new Set<Uuid>(),
  focusRequest: null,
  loading: false,
  error: null,

  loadGraph: async (query) => {
    set({ loading: true, error: null });
    try {
      const merged: GraphQuery = { ...DEFAULT_GRAPH_QUERY, ...query };
      const graph = await backendCall("get_graph", merged);
      set((state) => ({
        graph,
        graphRevision: state.graphRevision + 1,
        loading: false,
      }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      set({ loading: false, error: message });
    }
  },

  setSelectedNodeId: (selectedNodeId) => set({ selectedNodeId }),
  setHoveredNodeId: (hoveredNodeId) => set({ hoveredNodeId }),
  setHighlightedNodeIds: (ids) =>
    set((state) => {
      const next = new Set(ids);
      if (next.size === state.highlightedNodeIds.size) {
        let same = true;
        for (const id of next) {
          if (!state.highlightedNodeIds.has(id)) {
            same = false;
            break;
          }
        }
        if (same) return state;
      }
      return { highlightedNodeIds: next };
    }),
  requestFocusNodes: (ids) => {
    const unique = Array.from(new Set(ids.filter(Boolean)));
    if (unique.length === 0) return;
    focusNonceCounter += 1;
    set({ focusRequest: { nodeIds: unique, nonce: focusNonceCounter } });
  },
  clearFocusRequest: () => set({ focusRequest: null }),
}));
