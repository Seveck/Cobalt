import { create } from "zustand";
import { backendCall } from "@/lib/backend";
import { toStoreDisplayError, type DisplayError } from "@/lib/friendlyError";
import type { LibraryFilter, ReusableAsset, Uuid } from "@/types/contracts";

const DEFAULT_LIBRARY_FILTER: LibraryFilter = {
  query: null,
  source_types: [],
  project_ids: [],
  availability: [],
  limit: 100,
  offset: 0,
};

export interface LibraryState {
  assets: ReusableAsset[];
  filter: LibraryFilter;
  loading: boolean;
  error: DisplayError | null;
  loadLibrary: (override?: Partial<LibraryFilter>) => Promise<void>;
  setFilter: (patch: Partial<LibraryFilter>) => void;
  clearProjectFilter: (projectId: Uuid) => void;
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  assets: [],
  filter: DEFAULT_LIBRARY_FILTER,
  loading: false,
  error: null,

  loadLibrary: async (override) => {
    const nextFilter: LibraryFilter = { ...get().filter, ...override };
    set({
      filter: nextFilter,
      loading: true,
      error: null,
    });
    try {
      const assets = await backendCall("list_library", nextFilter);
      set({ assets, loading: false });
    } catch (err: unknown) {
      set({ loading: false, error: toStoreDisplayError(err, "list_library") });
    }
  },

  setFilter: (patch) => set((state) => ({ filter: { ...state.filter, ...patch } })),
  clearProjectFilter: (projectId) =>
    set((state) => {
      if (!state.filter.project_ids.includes(projectId)) return state;
      return {
        filter: {
          ...state.filter,
          project_ids: state.filter.project_ids.filter((id) => id !== projectId),
        },
      };
    }),
}));
