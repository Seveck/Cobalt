import { create } from "zustand";
import { backendCall, isCommandMocked } from "@/lib/backend";
import { MAIN_BRANCH_ID, type Branch, type Uuid } from "@/types/contracts";

export interface BranchesState {
  branches: Branch[];
  activeBranchId: Uuid;
  loading: boolean;
  error: string | null;
  isMockData: boolean;
  loadBranches: () => Promise<void>;
  setActiveBranchId: (branchId: Uuid) => void;
}

export const useBranchesStore = create<BranchesState>((set) => ({
  branches: [],
  activeBranchId: MAIN_BRANCH_ID,
  loading: false,
  error: null,
  isMockData: isCommandMocked("list_branches"),

  loadBranches: async () => {
    set({ loading: true, error: null, isMockData: isCommandMocked("list_branches") });
    try {
      const branches = await backendCall("list_branches");
      const active = branches.find((b) => b.is_active);
      set({
        branches,
        activeBranchId: active ? active.id : MAIN_BRANCH_ID,
        loading: false,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      set({ loading: false, error: message });
    }
  },

  setActiveBranchId: (activeBranchId) => set({ activeBranchId }),
}));
