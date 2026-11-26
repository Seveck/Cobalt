import { create } from "zustand";
import { backendCall, isCommandMocked } from "@/lib/backend";
import type { GraphData, GraphQuery, Uuid } from "@/types/contracts";

const DEFAULT_GRAPH_QUERY: GraphQuery = {
  branch_id: null,
  include_archived: true,
  include_superseded: true,
  min_edge_weight: null,
  limit: null,
};

export interface MemoryState {
  graph: GraphData | null;
  graphRevision: number;
  selectedNodeId: Uuid | null;
  hoveredNodeId: Uuid | null;
  highlightedNodeIds: ReadonlySet<Uuid>;
  loading: boolean;
  error: string | null;
  isMockData: boolean;
  loadGraph: (query?: Partial<GraphQuery>) => Promise<void>;
  setSelectedNodeId: (id: Uuid | null) => void;
  setHoveredNodeId: (id: Uuid | null) => void;
  setHighlightedNodeIds: (ids: readonly Uuid[]) => void;
}

export const useMemoryStore = create<MemoryState>((set) => ({
  graph: null,
  graphRevision: 0,
  selectedNodeId: null,
  hoveredNodeId: null,
  highlightedNodeIds: new Set<Uuid>(),
  loading: false,
  error: null,
  isMockData: isCommandMocked("get_graph"),

  loadGraph: async (query) => {
    set({ loading: true, error: null, isMockData: isCommandMocked("get_graph") });
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
  setHighlightedNodeIds: (ids) => set({ highlightedNodeIds: new Set(ids) }),
}));
