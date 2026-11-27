import { create } from "zustand";
import { backendCall } from "@/lib/backend";
import type { LibraryFilter, ReusableAsset } from "@/types/contracts";

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
  error: string | null;
  loadLibrary: (override?: Partial<LibraryFilter>) => Promise<void>;
  setFilter: (patch: Partial<LibraryFilter>) => void;
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
      const message = err instanceof Error ? err.message : String(err);
      set({ loading: false, error: message });
    }
  },

  setFilter: (patch) => set((state) => ({ filter: { ...state.filter, ...patch } })),
}));
