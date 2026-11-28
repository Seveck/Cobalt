import { create } from "zustand";
import { backendCall } from "@/lib/backend";
import { toStoreDisplayError, type DisplayError } from "@/lib/friendlyError";
import type { GraphData, GraphQuery, MemoryChanged, Uuid } from "@/types/contracts";

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
  memoryChangeVersion: number;
  lastMemoryChange: MemoryChanged | null;
  selectedNodeId: Uuid | null;
  selectedNodeIds: ReadonlySet<Uuid>;
  hoveredNodeId: Uuid | null;
  highlightedNodeIds: ReadonlySet<Uuid>;
  focusRequest: CameraFocusRequest | null;
  loading: boolean;
  error: DisplayError | null;
  loadGraph: (query?: Partial<GraphQuery>) => Promise<void>;
  recordMemoryChange: (payload: MemoryChanged) => void;
  setSelectedNodeId: (id: Uuid | null) => void;
  toggleNodeSelection: (id: Uuid) => void;
  setSelectedNodeIds: (ids: readonly Uuid[]) => void;
  clearMultiSelection: () => void;
  pruneSelectedNodes: (deletedIds: readonly Uuid[]) => void;
  setHoveredNodeId: (id: Uuid | null) => void;
  setHighlightedNodeIds: (ids: readonly Uuid[]) => void;
  requestFocusNodes: (ids: readonly Uuid[]) => void;
  clearFocusRequest: () => void;
}

let focusNonceCounter = 0;

export const useMemoryStore = create<MemoryState>((set) => ({
  graph: null,
  graphRevision: 0,
  memoryChangeVersion: 0,
  lastMemoryChange: null,
  selectedNodeId: null,
  selectedNodeIds: new Set<Uuid>(),
  hoveredNodeId: null,
  highlightedNodeIds: new Set<Uuid>(),
  focusRequest: null,
  loading: false,
  error: null,

  recordMemoryChange: (payload) =>
    set((state) => ({
      memoryChangeVersion: state.memoryChangeVersion + 1,
      lastMemoryChange: payload,
    })),

  loadGraph: async (query) => {
    set({ loading: true, error: null });
    try {
      const merged: GraphQuery = { ...DEFAULT_GRAPH_QUERY, ...query };
      const graph = await backendCall("get_graph", merged);
      const validIds = new Set(graph.nodes.map((n) => n.id));
      set((state) => {
        let nextMulti = state.selectedNodeIds;
        if (state.selectedNodeIds.size > 0) {
          let changed = false;
          const pruned = new Set<Uuid>();
          for (const id of state.selectedNodeIds) {
            if (validIds.has(id)) pruned.add(id);
            else changed = true;
          }
          if (changed) nextMulti = pruned;
        }
        return {
          graph,
          graphRevision: state.graphRevision + 1,
          selectedNodeIds: nextMulti,
          loading: false,
        };
      });
    } catch (err: unknown) {
      set({ loading: false, error: toStoreDisplayError(err, "get_graph") });
    }
  },

  setSelectedNodeId: (selectedNodeId) =>
    set((state) => ({
      selectedNodeId,
      selectedNodeIds: state.selectedNodeIds.size > 0 ? new Set<Uuid>() : state.selectedNodeIds,
    })),

  toggleNodeSelection: (id) =>
    set((state) => {
      const next = new Set<Uuid>(state.selectedNodeIds);
      // Seed from active single selection when entering multi-select with Shift/Ctrl+click
      if (next.size === 0 && state.selectedNodeId && state.selectedNodeId !== id) {
        next.add(state.selectedNodeId);
      }
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return {
        selectedNodeIds: next,
        selectedNodeId: next.size > 0 ? null : state.selectedNodeId,
      };
    }),

  setSelectedNodeIds: (ids) =>
    set(() => {
      const next = new Set(ids.filter(Boolean));
      return {
        selectedNodeIds: next,
        selectedNodeId: next.size > 0 ? null : null,
      };
    }),

  clearMultiSelection: () =>
    set((state) =>
      state.selectedNodeIds.size === 0 ? state : { selectedNodeIds: new Set<Uuid>() },
    ),

  pruneSelectedNodes: (deletedIds) =>
    set((state) => {
      if (deletedIds.length === 0) return state;
      const deletedSet = new Set(deletedIds);
      const nextSingle =
        state.selectedNodeId && deletedSet.has(state.selectedNodeId)
          ? null
          : state.selectedNodeId;
      let nextMulti = state.selectedNodeIds;
      if (state.selectedNodeIds.size > 0) {
        let changed = false;
        const filtered = new Set<Uuid>();
        for (const id of state.selectedNodeIds) {
          if (!deletedSet.has(id)) filtered.add(id);
          else changed = true;
        }
        if (changed) nextMulti = filtered;
      }
      if (nextSingle === state.selectedNodeId && nextMulti === state.selectedNodeIds) {
        return state;
      }
      return { selectedNodeId: nextSingle, selectedNodeIds: nextMulti };
    }),

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
