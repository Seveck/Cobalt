import { create } from "zustand";
import { backendCall, isCommandMocked } from "@/lib/backend";
import type { GraphData, GraphQuery, Uuid } from "@/types/contracts";

const DEFAULT_GRAPH_QUERY: GraphQuery = {
  branch_id: null,
  include_archived: false,
  include_superseded: false,
  min_edge_weight: null,
  limit: null,
};

export interface MemoryState {
  graph: GraphData | null;
  selectedNodeId: Uuid | null;
  hoveredNodeId: Uuid | null;
  loading: boolean;
  error: string | null;
  isMockData: boolean;
  loadGraph: (query?: Partial<GraphQuery>) => Promise<void>;
  setSelectedNodeId: (id: Uuid | null) => void;
  setHoveredNodeId: (id: Uuid | null) => void;
}

export const useMemoryStore = create<MemoryState>((set) => ({
  graph: null,
  selectedNodeId: null,
  hoveredNodeId: null,
  loading: false,
  error: null,
  isMockData: isCommandMocked("get_graph"),

  loadGraph: async (query) => {
    set({ loading: true, error: null, isMockData: isCommandMocked("get_graph") });
    try {
      const merged: GraphQuery = { ...DEFAULT_GRAPH_QUERY, ...query };
      const graph = await backendCall("get_graph", merged);
      set({ graph, loading: false });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      set({ loading: false, error: message });
    }
  },

  setSelectedNodeId: (selectedNodeId) => set({ selectedNodeId }),
  setHoveredNodeId: (hoveredNodeId) => set({ hoveredNodeId }),
}));
