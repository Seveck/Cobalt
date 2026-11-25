import { create } from "zustand";
import type {
  GraphNode,
  MemoryCategory,
  MemoryStatus,
  SourceType,
  Uuid,
  VisualFilters,
} from "@/types/contracts";

function createInitialFilters(): VisualFilters {
  return {
    sourceTypes: [],
    projectIds: [],
    categories: [],
    statuses: [],
    onlyReusable: false,
    solo: null,
  };
}

function toggleItem<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

/** Pure filter predicate used by the 3D renderer (scales non-matching instances to 0). */
export function matchesVisualFilters(
  node: GraphNode,
  filters: VisualFilters,
  searchQuery: string,
): boolean {
  if (filters.solo) {
    const { dimension, value } = filters.solo;
    if (dimension === "source_type" && node.source_type !== value) return false;
    if (dimension === "category" && node.category !== value) return false;
    if (dimension === "status" && node.status !== value) return false;
    if (dimension === "project") {
      const nodeProject = node.project_id ?? "global";
      if (nodeProject !== value) return false;
    }
  } else {
    if (filters.sourceTypes.length > 0 && !filters.sourceTypes.includes(node.source_type)) {
      return false;
    }
    if (filters.projectIds.length > 0 && !filters.projectIds.includes(node.project_id)) {
      return false;
    }
    if (filters.categories.length > 0 && !filters.categories.includes(node.category)) {
      return false;
    }
    if (filters.statuses.length > 0 && !filters.statuses.includes(node.status)) {
      return false;
    }
  }

  if (filters.onlyReusable && !node.is_reusable) return false;

  const trimmed = searchQuery.trim().toLowerCase();
  if (trimmed.length > 0 && !node.preview.toLowerCase().includes(trimmed)) {
    return false;
  }

  return true;
}

export interface FiltersState {
  filters: VisualFilters;
  searchQuery: string;
  toggleSourceType: (sourceType: SourceType) => void;
  toggleProjectId: (projectId: Uuid | null) => void;
  toggleCategory: (category: MemoryCategory) => void;
  toggleStatus: (status: MemoryStatus) => void;
  setOnlyReusable: (onlyReusable: boolean) => void;
  setSolo: (solo: VisualFilters["solo"]) => void;
  setSearchQuery: (query: string) => void;
  resetFilters: () => void;
}

export const useFiltersStore = create<FiltersState>((set) => ({
  filters: createInitialFilters(),
  searchQuery: "",

  toggleSourceType: (sourceType) =>
    set((state) => ({
      filters: {
        ...state.filters,
        solo: null,
        sourceTypes: toggleItem(state.filters.sourceTypes, sourceType),
      },
    })),

  toggleProjectId: (projectId) =>
    set((state) => ({
      filters: {
        ...state.filters,
        solo: null,
        projectIds: toggleItem(state.filters.projectIds, projectId),
      },
    })),

  toggleCategory: (category) =>
    set((state) => ({
      filters: {
        ...state.filters,
        solo: null,
        categories: toggleItem(state.filters.categories, category),
      },
    })),

  toggleStatus: (status) =>
    set((state) => ({
      filters: {
        ...state.filters,
        solo: null,
        statuses: toggleItem(state.filters.statuses, status),
      },
    })),

  setOnlyReusable: (onlyReusable) =>
    set((state) => ({ filters: { ...state.filters, onlyReusable } })),

  setSolo: (solo) => set((state) => ({ filters: { ...state.filters, solo } })),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  resetFilters: () => set({ filters: createInitialFilters(), searchQuery: "" }),
}));
