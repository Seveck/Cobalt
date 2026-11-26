import { create } from "zustand";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { backendCall, backendOn } from "@/lib/backend";
import { IpcError } from "@/lib/ipc";
import { extractFileName, isTerminalIngestStage } from "@/lib/ingest";
import type {
  IngestProgress,
  IngestReport,
  IngestRequest,
  PastLifeImportRequest,
  Uuid,
} from "@/types/contracts";
import { useMemoryStore } from "./memory";

export type IngestJobStatus = "running" | "completed" | "cancelled" | "failed";
export type IngestJobOrigin = "files" | "past_life" | "external";

export interface IngestJob {
  /** Stable frontend key (becomes `jobId` once known, or a temporary local id until first event). */
  id: string;
  /** Backend `IngestProgress.job_id`, used for `cancel_ingest({ id })`. */
  jobId: Uuid | null;
  origin: IngestJobOrigin;
  /** Short human-readable label (e.g. first file/folder name or source label). */
  label: string;
  /** Requested root paths (used to correlate concurrent jobs with backend events). */
  requestedPaths: string[];
  status: IngestJobStatus;
  stage: string;
  processed: number;
  total: number;
  currentPath: string | null;
  startedAt: number;
  finishedAt: number | null;
  cancelling: boolean;
  /** True if the user clicked Cancel before the first backend progress event delivered `job_id`. */
  cancelQueued: boolean;
  /** True while this job was launched by a frontend IPC call that is still in flight. */
  awaitingPromise: boolean;
  report: IngestReport | null;
  error: string | null;
}

export interface IngestState {
  jobs: IngestJob[];
  expanded: boolean;
  reportJobId: string | null;
  subscribeIngestProgress: () => Promise<UnlistenFn>;
  startIngestPaths: (
    req: IngestRequest,
    options?: { label?: string },
  ) => Promise<IngestReport | null>;
  startImportPastLife: (
    req: PastLifeImportRequest,
    options?: { label?: string },
  ) => Promise<IngestReport | null>;
  cancelJob: (id: string) => Promise<boolean>;
  dismissJob: (id: string) => void;
  clearFinished: () => void;
  setExpanded: (expanded: boolean) => void;
  toggleExpanded: () => void;
  openReport: (id: string) => void;
  closeReport: () => void;
}

const MAX_RETAINED_FINISHED_JOBS = 12;
let localJobSeq = 0;

function nextLocalJobId(): string {
  localJobSeq += 1;
  return `local-ingest-${localJobSeq}`;
}

function buildLabelFromPaths(paths: readonly string[], fallback: string): string {
  if (paths.length === 0) return fallback;
  const first = extractFileName(paths[0]) ?? paths[0] ?? fallback;
  if (paths.length === 1) return first;
  return `${first} (+${paths.length - 1})`;
}

function pathMatchesRequested(currentPath: string | null, requestedPaths: readonly string[]): boolean {
  if (!currentPath || requestedPaths.length === 0) return false;
  const normalizedCurrent = currentPath.replace(/\\/g, "/");
  return requestedPaths.some((reqPath) => {
    const normalizedReq = reqPath.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!normalizedReq) return false;
    return (
      normalizedCurrent === normalizedReq ||
      normalizedCurrent.startsWith(`${normalizedReq}/`) ||
      extractFileName(normalizedCurrent) === extractFileName(normalizedReq)
    );
  });
}

function isCancelledError(err: unknown): boolean {
  if (err instanceof IpcError && err.kind === "cancelled") {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /\bcancel(l)?ed\b/i.test(msg);
}

function trimFinishedJobs(jobs: IngestJob[], pinnedReportId: string | null): IngestJob[] {
  const running = jobs.filter((j) => j.status === "running");
  const finished = jobs.filter((j) => j.status !== "running");
  if (finished.length <= MAX_RETAINED_FINISHED_JOBS) {
    return jobs;
  }
  const keptFinished = finished.slice(0, MAX_RETAINED_FINISHED_JOBS);
  if (
    pinnedReportId &&
    !keptFinished.some((j) => j.id === pinnedReportId) &&
    !running.some((j) => j.id === pinnedReportId)
  ) {
    const pinned = finished.find((j) => j.id === pinnedReportId);
    if (pinned) {
      keptFinished[keptFinished.length - 1] = pinned;
    }
  }
  const keepIds = new Set([...running.map((j) => j.id), ...keptFinished.map((j) => j.id)]);
  return jobs.filter((j) => keepIds.has(j.id));
}

function findJobIndexByIdOrJobId(jobs: readonly IngestJob[], idOrJobId: string): number {
  return jobs.findIndex((j) => j.id === idOrJobId || j.jobId === idOrJobId);
}

export const useIngestStore = create<IngestState>((set, get) => {
  const handleProgressEvent = (payload: IngestProgress) => {
    const now = Date.now();
    const terminal = isTerminalIngestStage(payload.stage);
    let deferredCancelJobId: Uuid | null = null;

    set((state) => {
      const jobs = [...state.jobs];

      // 1. Existing job already bound to this backend `job_id`
      let idx = jobs.findIndex((j) => j.jobId === payload.job_id);

      // 2. Otherwise correlate with an unbound frontend-launched running job
      if (idx === -1) {
        idx = jobs.findIndex(
          (j) =>
            j.jobId === null &&
            j.status === "running" &&
            pathMatchesRequested(payload.current_path, j.requestedPaths),
        );
      }
      if (idx === -1) {
        // FIFO fallback to the oldest unbound running job
        for (let i = jobs.length - 1; i >= 0; i -= 1) {
          const candidate = jobs[i];
          if (candidate && candidate.jobId === null && candidate.status === "running") {
            idx = i;
            break;
          }
        }
      }

      // 3. Guard against late terminal event arriving right after a fast IPC promise already finished
      if (idx === -1 && terminal !== null) {
        const recentUnboundIdx = jobs.findIndex(
          (j) =>
            j.jobId === null &&
            j.status !== "running" &&
            j.finishedAt !== null &&
            now - j.finishedAt < 3000 &&
            (pathMatchesRequested(payload.current_path, j.requestedPaths) ||
              j.requestedPaths.length > 0),
        );
        if (recentUnboundIdx !== -1) {
          const existing = jobs[recentUnboundIdx]!;
          jobs[recentUnboundIdx] = {
            ...existing,
            jobId: payload.job_id,
            processed: Math.max(existing.processed, payload.processed),
            total: Math.max(existing.total, payload.total),
            currentPath: payload.current_path ?? existing.currentPath,
          };
          return { jobs };
        }
      }

      if (idx !== -1) {
        const existing = jobs[idx]!;
        const wasCancelling = existing.cancelling || existing.cancelQueued;
        if (existing.jobId === null && existing.cancelQueued && terminal === null) {
          deferredCancelJobId = payload.job_id;
        }

        let nextStatus: IngestJobStatus = existing.status;
        let nextFinishedAt = existing.finishedAt;
        let nextCancelling = existing.cancelling;

        if (terminal === "cancelled") {
          nextStatus = "cancelled";
          nextFinishedAt = existing.finishedAt ?? now;
          nextCancelling = false;
        } else if (terminal === "failed") {
          nextStatus = "failed";
          nextFinishedAt = existing.finishedAt ?? now;
          nextCancelling = false;
        } else if (terminal === "completed" && !existing.awaitingPromise) {
          nextStatus = wasCancelling ? "cancelled" : "completed";
          nextFinishedAt = existing.finishedAt ?? now;
          nextCancelling = false;
        }

        jobs[idx] = {
          ...existing,
          jobId: payload.job_id,
          stage: payload.stage,
          processed: payload.processed,
          total: payload.total > 0 ? payload.total : existing.total,
          currentPath: payload.current_path ?? existing.currentPath,
          status: nextStatus,
          finishedAt: nextFinishedAt,
          cancelling: nextCancelling,
          cancelQueued: existing.jobId === null ? false : existing.cancelQueued,
        };
        return { jobs: trimFinishedJobs(jobs, state.reportJobId) };
      }

      // 4. External / daemon-initiated ingest job not started by this UI session
      const externalLabel =
        extractFileName(payload.current_path) ?? payload.job_id.slice(0, 8);
      const externalStatus: IngestJobStatus =
        terminal === "cancelled"
          ? "cancelled"
          : terminal === "failed"
            ? "failed"
            : terminal === "completed"
              ? "completed"
              : "running";

      const created: IngestJob = {
        id: payload.job_id,
        jobId: payload.job_id,
        origin: "external",
        label: externalLabel,
        requestedPaths: payload.current_path ? [payload.current_path] : [],
        status: externalStatus,
        stage: payload.stage,
        processed: payload.processed,
        total: payload.total,
        currentPath: payload.current_path,
        startedAt: now,
        finishedAt: externalStatus === "running" ? null : now,
        cancelling: false,
        cancelQueued: false,
        awaitingPromise: false,
        report: null,
        error: null,
      };

      return { jobs: trimFinishedJobs([created, ...jobs], state.reportJobId) };
    });

    if (deferredCancelJobId) {
      void backendCall("cancel_ingest", { id: deferredCancelJobId }).catch((err: unknown) => {
        console.error("Deferred cancel_ingest failed", err);
      });
    }
  };

  const finalizePromiseSuccess = (localId: string, report: IngestReport) => {
    const now = Date.now();
    set((state) => {
      const idx = findJobIndexByIdOrJobId(state.jobs, localId);
      if (idx === -1) return state;
      const existing = state.jobs[idx]!;
      const wasCancelled =
        existing.cancelling ||
        existing.cancelQueued ||
        existing.status === "cancelled" ||
        isTerminalIngestStage(existing.stage) === "cancelled";

      const totalFiles =
        existing.total > 0
          ? existing.total
          : report.documents_created +
            report.documents_updated +
            report.documents_unchanged +
            report.skipped_ignored +
            report.errors.length;

      const updated: IngestJob = {
        ...existing,
        status: wasCancelled ? "cancelled" : "completed",
        stage: wasCancelled ? "cancelled" : "completed",
        processed: wasCancelled ? existing.processed : Math.max(existing.processed, totalFiles),
        total: Math.max(existing.total, totalFiles),
        finishedAt: existing.finishedAt ?? now,
        cancelling: false,
        cancelQueued: false,
        awaitingPromise: false,
        report,
        error: null,
      };
      const jobs = [...state.jobs];
      jobs[idx] = updated;
      return { jobs: trimFinishedJobs(jobs, state.reportJobId) };
    });

    void useMemoryStore.getState().loadGraph();
  };

  const finalizePromiseError = (localId: string, err: unknown) => {
    const now = Date.now();
    const message = err instanceof Error ? err.message : String(err);

    set((state) => {
      const idx = findJobIndexByIdOrJobId(state.jobs, localId);
      if (idx === -1) return state;
      const existing = state.jobs[idx]!;
      const cancelled =
        existing.cancelling ||
        existing.cancelQueued ||
        existing.status === "cancelled" ||
        isCancelledError(err);

      const updated: IngestJob = {
        ...existing,
        status: cancelled ? "cancelled" : "failed",
        stage: cancelled ? "cancelled" : "failed",
        finishedAt: existing.finishedAt ?? now,
        cancelling: false,
        cancelQueued: false,
        awaitingPromise: false,
        error: cancelled ? null : message,
      };
      const jobs = [...state.jobs];
      jobs[idx] = updated;
      return { jobs: trimFinishedJobs(jobs, state.reportJobId) };
    });

    // Partial results may have been committed before cancellation
    void useMemoryStore.getState().loadGraph();
  };

  return {
    jobs: [],
    expanded: false,
    reportJobId: null,

    subscribeIngestProgress: () => backendOn("cobalt://ingest-progress", handleProgressEvent),

    startIngestPaths: async (req, options) => {
      if (req.paths.length === 0) return null;
      const localId = nextLocalJobId();
      const job: IngestJob = {
        id: localId,
        jobId: null,
        origin: "files",
        label: options?.label ?? buildLabelFromPaths(req.paths, "Import"),
        requestedPaths: [...req.paths],
        status: "running",
        stage: "starting",
        processed: 0,
        total: req.paths.length,
        currentPath: req.paths[0] ?? null,
        startedAt: Date.now(),
        finishedAt: null,
        cancelling: false,
        cancelQueued: false,
        awaitingPromise: true,
        report: null,
        error: null,
      };

      set((state) => ({
        jobs: trimFinishedJobs([job, ...state.jobs], state.reportJobId),
      }));

      try {
        const report = await backendCall("ingest_paths", req);
        finalizePromiseSuccess(localId, report);
        return report;
      } catch (err: unknown) {
        finalizePromiseError(localId, err);
        return null;
      }
    },

    startImportPastLife: async (req, options) => {
      if (!req.path.trim()) return null;
      const localId = nextLocalJobId();
      const trimmedPath = req.path.trim();
      const job: IngestJob = {
        id: localId,
        jobId: null,
        origin: "past_life",
        label: options?.label ?? buildLabelFromPaths([trimmedPath], req.source),
        requestedPaths: [trimmedPath],
        status: "running",
        stage: "starting",
        processed: 0,
        total: 0,
        currentPath: trimmedPath,
        startedAt: Date.now(),
        finishedAt: null,
        cancelling: false,
        cancelQueued: false,
        awaitingPromise: true,
        report: null,
        error: null,
      };

      set((state) => ({
        jobs: trimFinishedJobs([job, ...state.jobs], state.reportJobId),
      }));

      try {
        const report = await backendCall("import_past_life", {
          ...req,
          path: trimmedPath,
        });
        finalizePromiseSuccess(localId, report);
        return report;
      } catch (err: unknown) {
        finalizePromiseError(localId, err);
        return null;
      }
    },

    cancelJob: async (id) => {
      const state = get();
      const idx = findJobIndexByIdOrJobId(state.jobs, id);
      if (idx === -1) return false;
      const target = state.jobs[idx]!;
      if (target.status !== "running" || target.cancelling) return false;

      if (!target.jobId) {
        // Mark cancellation queued; fires immediately when the first progress event delivers `job_id`.
        set((s) => ({
          jobs: s.jobs.map((j) =>
            j.id === target.id
              ? { ...j, cancelling: true, cancelQueued: true, stage: "cancelling" }
              : j,
          ),
        }));
        return true;
      }

      const backendJobId = target.jobId;
      set((s) => ({
        jobs: s.jobs.map((j) =>
          j.id === target.id ? { ...j, cancelling: true, stage: "cancelling" } : j,
        ),
      }));

      try {
        const cancelled = await backendCall("cancel_ingest", { id: backendJobId });
        if (!cancelled) {
          set((s) => ({
            jobs: s.jobs.map((j) =>
              j.id === target.id && j.status === "running"
                ? {
                    ...j,
                    cancelling: false,
                    ...(j.awaitingPromise
                      ? {}
                      : { status: "cancelled" as const, stage: "cancelled", finishedAt: Date.now() }),
                  }
                : j,
            ),
          }));
        }
        return cancelled;
      } catch (err: unknown) {
        console.error("cancel_ingest failed", err);
        set((s) => ({
          jobs: s.jobs.map((j) =>
            j.id === target.id ? { ...j, cancelling: false } : j,
          ),
        }));
        return false;
      }
    },

    dismissJob: (id) => {
      set((state) => {
        const jobs = state.jobs.filter((j) => j.id !== id);
        const reportJobId = state.reportJobId === id ? null : state.reportJobId;
        const expanded = jobs.length === 0 ? false : state.expanded;
        return { jobs, reportJobId, expanded };
      });
    },

    clearFinished: () => {
      set((state) => {
        const jobs = state.jobs.filter((j) => j.status === "running");
        const reportStillExists = jobs.some((j) => j.id === state.reportJobId);
        return {
          jobs,
          reportJobId: reportStillExists ? state.reportJobId : null,
          expanded: jobs.length === 0 ? false : state.expanded,
        };
      });
    },

    setExpanded: (expanded) =>
      set((state) => ({
        expanded,
        reportJobId: expanded ? state.reportJobId : null,
      })),

    toggleExpanded: () =>
      set((state) => {
        const next = !state.expanded;
        return {
          expanded: next,
          reportJobId: next ? state.reportJobId : null,
        };
      }),

    openReport: (id) =>
      set({
        expanded: true,
        reportJobId: id,
      }),

    closeReport: () =>
      set({
        reportJobId: null,
      }),
  };
});
