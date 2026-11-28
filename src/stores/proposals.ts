import { create } from "zustand";
import { backendCall } from "@/lib/backend";
import { toStoreDisplayError, type DisplayError } from "@/lib/friendlyError";
import { isUnsupportedError } from "@/lib/ipc";
import type { MemoryProposal, ProposalStatus, Uuid } from "@/types/contracts";
import { useMemoryStore } from "./memory";

function sortNewestFirst(items: readonly MemoryProposal[]): MemoryProposal[] {
  return [...items].sort((a, b) => {
    const timeDiff = Date.parse(b.created_at) - Date.parse(a.created_at);
    if (Number.isFinite(timeDiff) && timeDiff !== 0) {
      return timeDiff;
    }
    return b.created_at.localeCompare(a.created_at);
  });
}

function upsertProposal(
  list: readonly MemoryProposal[],
  proposal: MemoryProposal,
): MemoryProposal[] {
  const without = list.filter((item) => item.id !== proposal.id);
  return sortNewestFirst([proposal, ...without]);
}

export interface BulkActionResult {
  succeeded: number;
  failed: number;
}

export interface ProposalsState {
  open: boolean;
  activeTab: ProposalStatus;
  pendingCount: number;
  itemsByStatus: Record<ProposalStatus, MemoryProposal[]>;
  loadingTab: ProposalStatus | null;
  unsupported: boolean;
  error: DisplayError | null;
  busyIds: Record<Uuid, boolean>;
  bulkBusy: "accept" | "reject" | null;
  openPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;
  setActiveTab: (tab: ProposalStatus) => void;
  syncPendingCountFromEvent: (pending: number) => void;
  loadInitialPendingCount: () => Promise<void>;
  loadProposals: (status?: ProposalStatus) => Promise<void>;
  acceptProposal: (id: Uuid, editedContent?: string | null) => Promise<MemoryProposal | null>;
  rejectProposal: (id: Uuid) => Promise<MemoryProposal | null>;
  acceptAllPending: (draftEdits?: Record<string, string>) => Promise<BulkActionResult>;
  rejectAllPending: () => Promise<BulkActionResult>;
  clearError: () => void;
}

const EMPTY_ITEMS_BY_STATUS: Record<ProposalStatus, MemoryProposal[]> = {
  pending: [],
  accepted: [],
  rejected: [],
};

export const useProposalsStore = create<ProposalsState>((set, get) => ({
  open: false,
  activeTab: "pending",
  pendingCount: 0,
  itemsByStatus: EMPTY_ITEMS_BY_STATUS,
  loadingTab: null,
  unsupported: false,
  error: null,
  busyIds: {},
  bulkBusy: null,

  openPanel: () => {
    const tab = get().activeTab;
    set({ open: true, error: null });
    void get().loadProposals(tab);
    if (tab !== "pending") {
      void get().loadProposals("pending");
    }
  },

  closePanel: () => set({ open: false }),

  togglePanel: () => {
    if (get().open) {
      get().closePanel();
    } else {
      get().openPanel();
    }
  },

  setActiveTab: (tab) => {
    set({ activeTab: tab, error: null });
    void get().loadProposals(tab);
  },

  syncPendingCountFromEvent: (pending) => {
    const safePending = Number.isFinite(pending) ? Math.max(0, Math.round(pending)) : 0;
    set({ pendingCount: safePending, unsupported: false });
    if (get().open) {
      void get().loadProposals(get().activeTab);
      if (get().activeTab !== "pending") {
        void get().loadProposals("pending");
      }
    }
  },

  loadInitialPendingCount: async () => {
    try {
      const items = await backendCall("list_proposals", { status: "pending" });
      const sorted = sortNewestFirst(items);
      set((state) => ({
        pendingCount: sorted.length,
        unsupported: false,
        itemsByStatus: {
          ...state.itemsByStatus,
          pending: sorted,
        },
      }));
    } catch (err: unknown) {
      if (isUnsupportedError(err)) {
        set({
          unsupported: true,
          pendingCount: 0,
          itemsByStatus: EMPTY_ITEMS_BY_STATUS,
          error: null,
        });
      }
      // Keep startup quiet on transient errors; opening the panel will surface actionable errors.
    }
  },

  loadProposals: async (status) => {
    const targetStatus = status ?? get().activeTab;
    set({ loadingTab: targetStatus, error: null });
    try {
      const items = await backendCall("list_proposals", { status: targetStatus });
      const sorted = sortNewestFirst(items);
      set((state) => ({
        loadingTab: state.loadingTab === targetStatus ? null : state.loadingTab,
        unsupported: false,
        error: null,
        pendingCount: targetStatus === "pending" ? sorted.length : state.pendingCount,
        itemsByStatus: {
          ...state.itemsByStatus,
          [targetStatus]: sorted,
        },
      }));
    } catch (err: unknown) {
      if (isUnsupportedError(err)) {
        set((state) => ({
          loadingTab: state.loadingTab === targetStatus ? null : state.loadingTab,
          unsupported: true,
          pendingCount: 0,
          itemsByStatus: EMPTY_ITEMS_BY_STATUS,
          error: null,
        }));
        return;
      }
      set((state) => ({
        loadingTab: state.loadingTab === targetStatus ? null : state.loadingTab,
        error: toStoreDisplayError(err, "list_proposals"),
      }));
    }
  },

  acceptProposal: async (id, editedContent) => {
    set((state) => ({
      busyIds: { ...state.busyIds, [id]: true },
      error: null,
    }));
    try {
      const trimmed = typeof editedContent === "string" ? editedContent.trim() : null;
      const args = trimmed !== null && trimmed.length > 0 ? { id, content: trimmed } : { id };
      const updated = await backendCall("accept_proposal", args);

      set((state) => {
        const nextPending = state.itemsByStatus.pending.filter((item) => item.id !== id);
        const nextBusy = { ...state.busyIds };
        delete nextBusy[id];
        return {
          busyIds: nextBusy,
          pendingCount: nextPending.length,
          itemsByStatus: {
            ...state.itemsByStatus,
            pending: nextPending,
            accepted: upsertProposal(state.itemsByStatus.accepted, updated),
          },
        };
      });

      void useMemoryStore.getState().loadGraph();
      return updated;
    } catch (err: unknown) {
      set((state) => {
        const nextBusy = { ...state.busyIds };
        delete nextBusy[id];
        return {
          busyIds: nextBusy,
          error: isUnsupportedError(err) ? null : toStoreDisplayError(err, "accept_proposal"),
          unsupported: isUnsupportedError(err) ? true : state.unsupported,
        };
      });
      return null;
    }
  },

  rejectProposal: async (id) => {
    set((state) => ({
      busyIds: { ...state.busyIds, [id]: true },
      error: null,
    }));
    try {
      const updated = await backendCall("reject_proposal", { id });

      set((state) => {
        const nextPending = state.itemsByStatus.pending.filter((item) => item.id !== id);
        const nextBusy = { ...state.busyIds };
        delete nextBusy[id];
        return {
          busyIds: nextBusy,
          pendingCount: nextPending.length,
          itemsByStatus: {
            ...state.itemsByStatus,
            pending: nextPending,
            rejected: upsertProposal(state.itemsByStatus.rejected, updated),
          },
        };
      });

      return updated;
    } catch (err: unknown) {
      set((state) => {
        const nextBusy = { ...state.busyIds };
        delete nextBusy[id];
        return {
          busyIds: nextBusy,
          error: isUnsupportedError(err) ? null : toStoreDisplayError(err, "reject_proposal"),
          unsupported: isUnsupportedError(err) ? true : state.unsupported,
        };
      });
      return null;
    }
  },

  acceptAllPending: async (draftEdits) => {
    const pendingItems = [...get().itemsByStatus.pending];
    if (pendingItems.length === 0) {
      return { succeeded: 0, failed: 0 };
    }
    set({ bulkBusy: "accept", error: null });

    let succeeded = 0;
    let failed = 0;
    let lastError: DisplayError | null = null;
    const acceptedList: MemoryProposal[] = [];
    const succeededIds = new Set<Uuid>();

    for (const item of pendingItems) {
      const draft = draftEdits?.[item.id];
      const trimmedDraft = typeof draft === "string" ? draft.trim() : "";
      const hasEditedContent =
        trimmedDraft.length > 0 && trimmedDraft !== item.content.trim();
      try {
        const updated = await backendCall(
          "accept_proposal",
          hasEditedContent ? { id: item.id, content: trimmedDraft } : { id: item.id },
        );
        acceptedList.push(updated);
        succeededIds.add(item.id);
        succeeded += 1;
      } catch (err: unknown) {
        failed += 1;
        lastError = toStoreDisplayError(err, "accept_proposal");
      }
    }

    set((state) => {
      const nextPending = state.itemsByStatus.pending.filter((item) => !succeededIds.has(item.id));
      let nextAccepted = state.itemsByStatus.accepted;
      for (const acc of acceptedList) {
        nextAccepted = upsertProposal(nextAccepted, acc);
      }
      return {
        bulkBusy: null,
        error: lastError,
        pendingCount: nextPending.length,
        itemsByStatus: {
          ...state.itemsByStatus,
          pending: nextPending,
          accepted: nextAccepted,
        },
      };
    });

    if (succeeded > 0) {
      void useMemoryStore.getState().loadGraph();
    }
    return { succeeded, failed };
  },

  rejectAllPending: async () => {
    const pendingItems = [...get().itemsByStatus.pending];
    if (pendingItems.length === 0) {
      return { succeeded: 0, failed: 0 };
    }
    set({ bulkBusy: "reject", error: null });

    let succeeded = 0;
    let failed = 0;
    let lastError: DisplayError | null = null;
    const rejectedList: MemoryProposal[] = [];
    const succeededIds = new Set<Uuid>();

    for (const item of pendingItems) {
      try {
        const updated = await backendCall("reject_proposal", { id: item.id });
        rejectedList.push(updated);
        succeededIds.add(item.id);
        succeeded += 1;
      } catch (err: unknown) {
        failed += 1;
        lastError = toStoreDisplayError(err, "reject_proposal");
      }
    }

    set((state) => {
      const nextPending = state.itemsByStatus.pending.filter((item) => !succeededIds.has(item.id));
      let nextRejected = state.itemsByStatus.rejected;
      for (const rej of rejectedList) {
        nextRejected = upsertProposal(nextRejected, rej);
      }
      return {
        bulkBusy: null,
        error: lastError,
        pendingCount: nextPending.length,
        itemsByStatus: {
          ...state.itemsByStatus,
          pending: nextPending,
          rejected: nextRejected,
        },
      };
    });

    return { succeeded, failed };
  },

  clearError: () => set({ error: null }),
}));
