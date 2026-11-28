import { create } from "zustand";
import { backendCall } from "@/lib/backend";
import { toStoreDisplayError, type DisplayError } from "@/lib/friendlyError";
import {
  MAIN_BRANCH_ID,
  type Branch,
  type BranchMergeReport,
  type Uuid,
} from "@/types/contracts";

export interface BranchesState {
  branches: Branch[];
  activeBranchId: Uuid;
  loading: boolean;
  mutating: boolean;
  error: DisplayError | null;
  lastMergeReport: BranchMergeReport | null;
  loadBranches: () => Promise<void>;
  setActiveBranchId: (branchId: Uuid) => void;
  createBranch: (name: string, parentBranchId?: Uuid | null) => Promise<Branch | null>;
  switchBranch: (branchId: Uuid) => Promise<Branch | null>;
  mergeBranch: (branchId: Uuid) => Promise<BranchMergeReport | null>;
  discardBranch: (branchId: Uuid) => Promise<boolean>;
  clearMergeReport: () => void;
  clearError: () => void;
}

export const useBranchesStore = create<BranchesState>((set, get) => ({
  branches: [],
  activeBranchId: MAIN_BRANCH_ID,
  loading: false,
  mutating: false,
  error: null,
  lastMergeReport: null,

  loadBranches: async () => {
    set({ loading: true, error: null });
    try {
      const branches = await backendCall("list_branches");
      const active = branches.find((b) => b.is_active);
      set({
        branches,
        activeBranchId: active ? active.id : MAIN_BRANCH_ID,
        loading: false,
      });
    } catch (err: unknown) {
      set({ loading: false, error: toStoreDisplayError(err, "list_branches") });
    }
  },

  setActiveBranchId: (activeBranchId) => set({ activeBranchId }),

  createBranch: async (name, parentBranchId) => {
    set({ mutating: true, error: null });
    try {
      const created = await backendCall("create_branch", {
        name: name.trim(),
        parent_branch_id: parentBranchId ?? get().activeBranchId,
      });
      await get().loadBranches();
      set({ mutating: false });
      return created;
    } catch (err: unknown) {
      set({ mutating: false, error: toStoreDisplayError(err, "create_branch") });
      return null;
    }
  },

  switchBranch: async (branchId) => {
    set({ mutating: true, error: null });
    try {
      const active = await backendCall("switch_branch", { id: branchId });
      await get().loadBranches();
      set({ activeBranchId: active.id, mutating: false });
      return active;
    } catch (err: unknown) {
      set({ mutating: false, error: toStoreDisplayError(err, "switch_branch") });
      return null;
    }
  },

  mergeBranch: async (branchId) => {
    set({ mutating: true, error: null });
    try {
      const report = await backendCall("merge_branch", { id: branchId });
      await get().loadBranches();
      set({ lastMergeReport: report, mutating: false });
      return report;
    } catch (err: unknown) {
      set({ mutating: false, error: toStoreDisplayError(err, "merge_branch") });
      return null;
    }
  },

  discardBranch: async (branchId) => {
    set({ mutating: true, error: null });
    try {
      await backendCall("discard_branch", { id: branchId });
      await get().loadBranches();
      set({ mutating: false });
      return true;
    } catch (err: unknown) {
      set({ mutating: false, error: toStoreDisplayError(err, "discard_branch") });
      return false;
    }
  },

  clearMergeReport: () => set({ lastMergeReport: null }),
  clearError: () => set({ error: null }),
}));
