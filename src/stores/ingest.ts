import { create } from "zustand";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { backendCall, backendOn } from "@/lib/backend";
import { toStoreDisplayError, type DisplayError } from "@/lib/friendlyError";
import { IpcError } from "@/lib/ipc";
import {
  extractFileName,
  isOcrNotInstalledMessage,
  isTerminalIngestStage,
  reportHasOcrNotInstalledError,
} from "@/lib/ingest";
import {
  INGEST_STAGES,
  type IngestProgress,
  type IngestReport,
  type IngestRequest,
  type PastLifeImportRequest,
  type Uuid,
} from "@/types/contracts";
import { useMemoryStore } from "./memory";

export type IngestJobStatus = "running" | "paused" | "completed" | "cancelled" | "failed";
export type IngestJobOrigin = "files" | "past_life" | "external";

export interface IngestJob {
  /** Stable frontend key (`jobId` for external/background jobs, or a local id for UI-started jobs). */
  id: string;
  /** Backend `IngestProgress.job_id`, used for `cancel_ingest({ id })`. */
  jobId: Uuid | null;
  origin: IngestJobOrigin;
  /** True for jobs initiated by Cobalt itself (watcher, CLI hooks, auto-watch). */
  background: boolean;
  /** Project associated with this ingest job, if known. */
  projectId: Uuid | null;
  /** Estimated remaining seconds reported by the backend, if available. */
  etaSeconds: number | null;
  /** Short human-readable label (e.g. first file/folder name or source label). */
  label: string;
  /** Requested root paths (used to correlate concurrent UI jobs with backend events). */
  requestedPaths: string[];
  /** Saved request for UI-started `ingest_paths` jobs so Pause -> Resume can re-run it. */
  ingestRequest: IngestRequest | null;
  /** Saved request for UI-started `import_past_life` jobs so Pause -> Resume can re-run it. */
  pastLifeRequest: PastLifeImportRequest | null;
  status: IngestJobStatus;
  stage: string;
  processed: number;
  total: number;
  currentPath: string | null;
  /** Chunks of the current file already embedded (`null` outside the embedding stage). */
  fileChunksDone: number | null;
  /** Total chunks of the current file (`null` outside the embedding stage). */
  fileChunksTotal: number | null;
  startedAt: number;
  finishedAt: number | null;
  cancelling: boolean;
  /** True when the user clicked Pause (cancel_ingest while keeping the request for Resume). */
  pausing: boolean;
  /** True if the user clicked Cancel/Pause before the first backend progress event delivered `job_id`. */
  cancelQueued: boolean;
  /** True while this job was launched by a frontend IPC call that is still in flight. */
  awaitingPromise: boolean;
  report: IngestReport | null;
  error: DisplayError | null;
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
  pauseJob: (id: string) => Promise<boolean>;
  resumeJob: (id: string) => Promise<IngestReport | null>;
  cancelJob: (id: string) => Promise<boolean>;
  dismissJob: (id: string) => void;
  clearFinished: () => void;
  setExpanded: (expanded: boolean) => void;
  toggleExpanded: () => void;
  openReport: (id: string) => void;
  closeReport: () => void;
}

const AUTO_REMOVE_FINISHED_MS = 5000;
const MAX_RETAINED_FOREGROUND_FINISHED = 12;
const MAX_RETAINED_BACKGROUND_FINISHED = 150;

let localJobSeq = 0;
const autoRemoveTimers = new Map<string, number>();

function nextLocalJobId(): string {
  localJobSeq += 1;
  return `local-ingest-${localJobSeq}`;
}

function clearAutoRemoveTimer(id: string): void {
  const timerId = autoRemoveTimers.get(id);
  if (timerId !== undefined) {
    window.clearTimeout(timerId);
    autoRemoveTimers.delete(id);
  }
}

function isFinishedStatus(status: IngestJobStatus): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
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
  const activeOrPaused = jobs.filter((j) => j.status === "running" || j.status === "paused");
  const fgFinished = jobs.filter((j) => !j.background && isFinishedStatus(j.status));
  const bgFinished = jobs.filter((j) => j.background && isFinishedStatus(j.status));

  if (
    fgFinished.length <= MAX_RETAINED_FOREGROUND_FINISHED &&
    bgFinished.length <= MAX_RETAINED_BACKGROUND_FINISHED
  ) {
    return jobs;
  }

  const keptFg = fgFinished.slice(0, MAX_RETAINED_FOREGROUND_FINISHED);
  const keptBg = bgFinished.slice(0, MAX_RETAINED_BACKGROUND_FINISHED);

  if (
    pinnedReportId &&
    !keptFg.some((j) => j.id === pinnedReportId) &&
    !keptBg.some((j) => j.id === pinnedReportId) &&
    !activeOrPaused.some((j) => j.id === pinnedReportId)
  ) {
    const pinned = fgFinished.find((j) => j.id === pinnedReportId) ?? bgFinished.find((j) => j.id === pinnedReportId);
    if (pinned) {
      if (pinned.background) {
        keptBg[keptBg.length - 1] = pinned;
      } else {
        keptFg[keptFg.length - 1] = pinned;
      }
    }
  }

  const keepIds = new Set([
    ...activeOrPaused.map((j) => j.id),
    ...keptFg.map((j) => j.id),
    ...keptBg.map((j) => j.id),
  ]);
  for (const job of jobs) {
    if (!keepIds.has(job.id)) {
      clearAutoRemoveTimer(job.id);
    }
  }
  return jobs.filter((j) => keepIds.has(j.id));
}

function findJobIndexByIdOrJobId(jobs: readonly IngestJob[], idOrJobId: string): number {
  return jobs.findIndex((j) => j.id === idOrJobId || j.jobId === idOrJobId);
}

export const useIngestStore = create<IngestState>((set, get) => {
  const scheduleAutoRemove = (id: string, delayMs: number = AUTO_REMOVE_FINISHED_MS) => {
    clearAutoRemoveTimer(id);
    const timer = window.setTimeout(() => {
      autoRemoveTimers.delete(id);
      set((state) => {
        if (state.reportJobId === id) {
          return state;
        }
        const target = state.jobs.find((j) => j.id === id);
        if (
          !target ||
          !isFinishedStatus(target.status) ||
          isOcrNotInstalledMessage(target.error) ||
          reportHasOcrNotInstalledError(target.report)
        ) {
          return state;
        }
        const jobs = state.jobs.filter((j) => j.id !== id);
        const expanded = jobs.length === 0 ? false : state.expanded;
        return { jobs, expanded };
      });
    }, Math.max(0, delayMs));
    autoRemoveTimers.set(id, timer);
  };

  const handleProgressEvent = (payload: IngestProgress) => {
    const now = Date.now();
    const terminal = isTerminalIngestStage(payload.stage);
    const isBackground = Boolean(payload.background);
    let deferredCancelJobId: Uuid | null = null;
    const newlyFinishedIds: string[] = [];

    set((state) => {
      const jobs = [...state.jobs];

      // 1. Existing job already bound to this backend `job_id`
      let idx = jobs.findIndex((j) => j.jobId === payload.job_id);

      // 2. Otherwise correlate ONLY foreground events with an unbound UI-launched running job
      if (idx === -1 && !isBackground) {
        idx = jobs.findIndex(
          (j) =>
            j.jobId === null &&
            !j.background &&
            j.status === "running" &&
            pathMatchesRequested(payload.current_path, j.requestedPaths),
        );
      }
      if (idx === -1 && !isBackground) {
        // FIFO fallback to the oldest unbound foreground running job
        for (let i = jobs.length - 1; i >= 0; i -= 1) {
          const candidate = jobs[i];
          if (
            candidate &&
            candidate.jobId === null &&
            !candidate.background &&
            candidate.status === "running"
          ) {
            idx = i;
            break;
          }
        }
      }

      // 3. Guard against late terminal event arriving right after a fast foreground IPC promise settled
      if (idx === -1 && !isBackground && terminal !== null) {
        const recentUnboundIdx = jobs.findIndex(
          (j) =>
            j.jobId === null &&
            !j.background &&
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
            fileChunksDone: null,
            fileChunksTotal: null,
            etaSeconds: null,
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

        // Never revert an already finished or paused job back to running on out-of-order events.
        if (existing.status !== "running") {
          jobs[idx] = {
            ...existing,
            jobId: payload.job_id,
            processed: Math.max(existing.processed, payload.processed),
            total: Math.max(existing.total, payload.total),
            currentPath: payload.current_path ?? existing.currentPath,
            fileChunksDone: null,
            fileChunksTotal: null,
            etaSeconds: null,
          };
          return { jobs };
        }

        let nextStatus: IngestJobStatus = existing.status;
        let nextStage = payload.stage;
        let nextFinishedAt = existing.finishedAt;
        let nextCancelling = existing.cancelling;
        let nextPausing = existing.pausing;
        let nextEtaSeconds: number | null = payload.eta_seconds ?? null;
        let nextFileChunksDone: number | null = payload.file_chunks_done ?? null;
        let nextFileChunksTotal: number | null = payload.file_chunks_total ?? null;

        // Finish jobs directly on terminal stages from the event itself (not only on promise resolution).
        if (terminal !== null) {
          const canPause =
            existing.pausing &&
            !existing.background &&
            (existing.ingestRequest !== null || existing.pastLifeRequest !== null);

          if (terminal === INGEST_STAGES.cancelled || (terminal === INGEST_STAGES.completed && wasCancelling)) {
            if (canPause) {
              nextStatus = "paused";
              nextStage = "paused";
            } else {
              nextStatus = "cancelled";
              nextStage = INGEST_STAGES.cancelled;
            }
          } else if (terminal === INGEST_STAGES.failed) {
            nextStatus = "failed";
            nextStage = INGEST_STAGES.failed;
          } else {
            nextStatus = "completed";
            nextStage = INGEST_STAGES.completed;
          }

          nextFinishedAt = existing.finishedAt ?? now;
          nextCancelling = false;
          nextPausing = false;
          nextEtaSeconds = null;
          nextFileChunksDone = null;
          nextFileChunksTotal = null;

          if (isFinishedStatus(nextStatus)) {
            newlyFinishedIds.push(existing.id);
          }
        }

        jobs[idx] = {
          ...existing,
          jobId: payload.job_id,
          background: existing.background || isBackground,
          projectId: payload.project_id ?? existing.projectId,
          etaSeconds: nextEtaSeconds,
          stage: nextStage,
          processed: payload.processed,
          total: payload.total > 0 ? payload.total : existing.total,
          currentPath: payload.current_path ?? existing.currentPath,
          fileChunksDone: nextFileChunksDone,
          fileChunksTotal: nextFileChunksTotal,
          status: nextStatus,
          finishedAt: nextFinishedAt,
          cancelling: nextCancelling,
          pausing: nextPausing,
          cancelQueued: existing.jobId === null ? false : existing.cancelQueued,
        };
        return { jobs: trimFinishedJobs(jobs, state.reportJobId) };
      }

      // 4. Background or external daemon-initiated ingest job not started by this UI session
      const externalLabel =
        extractFileName(payload.current_path) ?? payload.job_id.slice(0, 8);
      const externalStatus: IngestJobStatus =
        terminal === INGEST_STAGES.cancelled
          ? "cancelled"
          : terminal === INGEST_STAGES.failed
            ? "failed"
            : terminal === INGEST_STAGES.completed
              ? "completed"
              : "running";

      const created: IngestJob = {
        id: payload.job_id,
        jobId: payload.job_id,
        origin: "external",
        background: isBackground,
        projectId: payload.project_id ?? null,
        etaSeconds: externalStatus === "running" ? (payload.eta_seconds ?? null) : null,
        label: externalLabel,
        requestedPaths: payload.current_path ? [payload.current_path] : [],
        ingestRequest: null,
        pastLifeRequest: null,
        status: externalStatus,
        stage: payload.stage,
        processed: payload.processed,
        total: payload.total,
        currentPath: payload.current_path,
        fileChunksDone: externalStatus === "running" ? (payload.file_chunks_done ?? null) : null,
        fileChunksTotal: externalStatus === "running" ? (payload.file_chunks_total ?? null) : null,
        startedAt: now,
        finishedAt: externalStatus === "running" ? null : now,
        cancelling: false,
        pausing: false,
        cancelQueued: false,
        awaitingPromise: false,
        report: null,
        error: null,
      };

      if (isFinishedStatus(externalStatus)) {
        newlyFinishedIds.push(created.id);
      }

      return { jobs: trimFinishedJobs([created, ...jobs], state.reportJobId) };
    });

    for (const finishedId of newlyFinishedIds) {
      scheduleAutoRemove(finishedId);
    }

    if (deferredCancelJobId) {
      void backendCall("cancel_ingest", { id: deferredCancelJobId }).catch((err: unknown) => {
        console.error("Deferred cancel_ingest failed", err);
      });
    }
  };

  const finalizePromiseSuccess = (localId: string, report: IngestReport) => {
    const now = Date.now();
    let shouldAutoRemove = false;

    set((state) => {
      const idx = findJobIndexByIdOrJobId(state.jobs, localId);
      if (idx === -1) return state;
      const existing = state.jobs[idx]!;
      const canPause =
        !existing.background &&
        (existing.ingestRequest !== null || existing.pastLifeRequest !== null);
      const isPaused = existing.status === "paused" || (existing.pausing && canPause);
      const wasCancelled =
        !isPaused &&
        (existing.cancelling ||
          existing.cancelQueued ||
          existing.status === "cancelled" ||
          isTerminalIngestStage(existing.stage) === "cancelled");

      const totalFiles =
        existing.total > 0
          ? existing.total
          : report.documents_created +
            report.documents_updated +
            report.documents_unchanged +
            report.skipped_ignored +
            report.errors.length;

      const nextStatus: IngestJobStatus = isPaused
        ? "paused"
        : wasCancelled
          ? "cancelled"
          : "completed";
      const nextStage = isPaused
        ? "paused"
        : wasCancelled
          ? INGEST_STAGES.cancelled
          : INGEST_STAGES.completed;

      const hasOcrMissing = reportHasOcrNotInstalledError(report);
      if (isFinishedStatus(nextStatus) && !hasOcrMissing) {
        shouldAutoRemove = true;
      } else if (hasOcrMissing) {
        clearAutoRemoveTimer(existing.id);
      }

      const updated: IngestJob = {
        ...existing,
        status: nextStatus,
        stage: nextStage,
        processed: isPaused || wasCancelled ? existing.processed : Math.max(existing.processed, totalFiles),
        total: Math.max(existing.total, totalFiles),
        fileChunksDone: null,
        fileChunksTotal: null,
        etaSeconds: null,
        finishedAt: existing.finishedAt ?? now,
        cancelling: false,
        pausing: false,
        cancelQueued: false,
        awaitingPromise: false,
        report,
        error: null,
      };
      const jobs = [...state.jobs];
      jobs[idx] = updated;
      return { jobs: trimFinishedJobs(jobs, state.reportJobId) };
    });

    if (shouldAutoRemove) {
      scheduleAutoRemove(localId);
    }

    void useMemoryStore.getState().loadGraph();
  };

  const finalizePromiseError = (localId: string, err: unknown) => {
    const now = Date.now();
    const displayErr = toStoreDisplayError(err, "ingest_paths");
    let shouldAutoRemove = false;

    set((state) => {
      const idx = findJobIndexByIdOrJobId(state.jobs, localId);
      if (idx === -1) return state;
      const existing = state.jobs[idx]!;
      const canPause =
        !existing.background &&
        (existing.ingestRequest !== null || existing.pastLifeRequest !== null);
      const isPaused = existing.status === "paused" || (existing.pausing && canPause);
      const cancelled =
        !isPaused &&
        (existing.cancelling ||
          existing.cancelQueued ||
          existing.status === "cancelled" ||
          isCancelledError(err));

      const nextStatus: IngestJobStatus = isPaused
        ? "paused"
        : cancelled
          ? "cancelled"
          : "failed";
      const nextStage = isPaused
        ? "paused"
        : cancelled
          ? INGEST_STAGES.cancelled
          : INGEST_STAGES.failed;

      const hasOcrMissing = !isPaused && !cancelled && isOcrNotInstalledMessage(displayErr);
      if (isFinishedStatus(nextStatus) && !hasOcrMissing) {
        shouldAutoRemove = true;
      } else if (hasOcrMissing) {
        clearAutoRemoveTimer(existing.id);
      }

      const updated: IngestJob = {
        ...existing,
        status: nextStatus,
        stage: nextStage,
        fileChunksDone: null,
        fileChunksTotal: null,
        etaSeconds: null,
        finishedAt: existing.finishedAt ?? now,
        cancelling: false,
        pausing: false,
        cancelQueued: false,
        awaitingPromise: false,
        error: isPaused || cancelled ? null : displayErr,
      };
      const jobs = [...state.jobs];
      jobs[idx] = updated;
      return { jobs: trimFinishedJobs(jobs, state.reportJobId) };
    });

    if (shouldAutoRemove) {
      scheduleAutoRemove(localId);
    }

    // Partial results may have been committed before pause/cancellation
    void useMemoryStore.getState().loadGraph();
  };

  const runIngestPathsWithId = async (localId: string, req: IngestRequest): Promise<IngestReport | null> => {
    try {
      const report = await backendCall("ingest_paths", req);
      finalizePromiseSuccess(localId, report);
      return report;
    } catch (err: unknown) {
      finalizePromiseError(localId, err);
      return null;
    }
  };

  const runImportPastLifeWithId = async (
    localId: string,
    req: PastLifeImportRequest,
  ): Promise<IngestReport | null> => {
    try {
      const report = await backendCall("import_past_life", req);
      finalizePromiseSuccess(localId, report);
      return report;
    } catch (err: unknown) {
      finalizePromiseError(localId, err);
      return null;
    }
  };

  return {
    jobs: [],
    expanded: false,
    reportJobId: null,

    subscribeIngestProgress: () => backendOn("cobalt://ingest-progress", handleProgressEvent),

    startIngestPaths: async (req, options) => {
      if (req.paths.length === 0) return null;
      const localId = nextLocalJobId();
      const savedReq: IngestRequest = { ...req, paths: [...req.paths] };
      const job: IngestJob = {
        id: localId,
        jobId: null,
        origin: "files",
        background: false,
        projectId: req.project_id,
        etaSeconds: null,
        label: options?.label ?? buildLabelFromPaths(req.paths, "Import"),
        requestedPaths: [...req.paths],
        ingestRequest: savedReq,
        pastLifeRequest: null,
        status: "running",
        stage: "starting",
        processed: 0,
        total: req.paths.length,
        currentPath: req.paths[0] ?? null,
        fileChunksDone: null,
        fileChunksTotal: null,
        startedAt: Date.now(),
        finishedAt: null,
        cancelling: false,
        pausing: false,
        cancelQueued: false,
        awaitingPromise: true,
        report: null,
        error: null,
      };

      set((state) => ({
        jobs: trimFinishedJobs([job, ...state.jobs], state.reportJobId),
      }));

      return runIngestPathsWithId(localId, savedReq);
    },

    startImportPastLife: async (req, options) => {
      if (!req.path.trim()) return null;
      const localId = nextLocalJobId();
      const trimmedPath = req.path.trim();
      const savedReq: PastLifeImportRequest = { ...req, path: trimmedPath };
      const job: IngestJob = {
        id: localId,
        jobId: null,
        origin: "past_life",
        background: false,
        projectId: req.project_id,
        etaSeconds: null,
        label: options?.label ?? buildLabelFromPaths([trimmedPath], req.source),
        requestedPaths: [trimmedPath],
        ingestRequest: null,
        pastLifeRequest: savedReq,
        status: "running",
        stage: "starting",
        processed: 0,
        total: 0,
        currentPath: trimmedPath,
        fileChunksDone: null,
        fileChunksTotal: null,
        startedAt: Date.now(),
        finishedAt: null,
        cancelling: false,
        pausing: false,
        cancelQueued: false,
        awaitingPromise: true,
        report: null,
        error: null,
      };

      set((state) => ({
        jobs: trimFinishedJobs([job, ...state.jobs], state.reportJobId),
      }));

      return runImportPastLifeWithId(localId, savedReq);
    },

    pauseJob: async (id) => {
      const state = get();
      const idx = findJobIndexByIdOrJobId(state.jobs, id);
      if (idx === -1) return false;
      const target = state.jobs[idx]!;
      const canPause =
        !target.background &&
        (target.ingestRequest !== null || target.pastLifeRequest !== null);
      if (!canPause || target.status !== "running" || target.cancelling) return false;

      clearAutoRemoveTimer(target.id);

      if (!target.jobId) {
        set((s) => ({
          jobs: s.jobs.map((j) =>
            j.id === target.id
              ? { ...j, pausing: true, cancelling: true, cancelQueued: true, stage: "pausing" }
              : j,
          ),
        }));
        return true;
      }

      const backendJobId = target.jobId;
      set((s) => ({
        jobs: s.jobs.map((j) =>
          j.id === target.id
            ? { ...j, pausing: true, cancelling: true, stage: "pausing" }
            : j,
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
                    pausing: false,
                    cancelling: false,
                    fileChunksDone: null,
                    fileChunksTotal: null,
                    etaSeconds: null,
                    status: "paused" as const,
                    stage: "paused",
                    finishedAt: Date.now(),
                  }
                : j,
            ),
          }));
        }
        return cancelled;
      } catch (err: unknown) {
        console.error("pauseJob (cancel_ingest) failed", err);
        set((s) => ({
          jobs: s.jobs.map((j) =>
            j.id === target.id ? { ...j, pausing: false, cancelling: false } : j,
          ),
        }));
        return false;
      }
    },

    resumeJob: async (id) => {
      const state = get();
      const idx = findJobIndexByIdOrJobId(state.jobs, id);
      if (idx === -1) return null;
      const target = state.jobs[idx]!;
      if (target.status !== "paused") return null;

      clearAutoRemoveTimer(target.id);

      if (target.ingestRequest) {
        const req: IngestRequest = {
          ...target.ingestRequest,
          paths: [...target.ingestRequest.paths],
        };
        set((s) => ({
          jobs: s.jobs.map((j) =>
            j.id === target.id
              ? {
                  ...j,
                  jobId: null,
                  status: "running" as const,
                  stage: "starting",
                  fileChunksDone: null,
                  fileChunksTotal: null,
                  etaSeconds: null,
                  startedAt: Date.now(),
                  finishedAt: null,
                  cancelling: false,
                  pausing: false,
                  cancelQueued: false,
                  awaitingPromise: true,
                  report: null,
                  error: null,
                }
              : j,
          ),
        }));
        return runIngestPathsWithId(target.id, req);
      }

      if (target.pastLifeRequest) {
        const req: PastLifeImportRequest = { ...target.pastLifeRequest };
        set((s) => ({
          jobs: s.jobs.map((j) =>
            j.id === target.id
              ? {
                  ...j,
                  jobId: null,
                  status: "running" as const,
                  stage: "starting",
                  fileChunksDone: null,
                  fileChunksTotal: null,
                  etaSeconds: null,
                  startedAt: Date.now(),
                  finishedAt: null,
                  cancelling: false,
                  pausing: false,
                  cancelQueued: false,
                  awaitingPromise: true,
                  report: null,
                  error: null,
                }
              : j,
          ),
        }));
        return runImportPastLifeWithId(target.id, req);
      }

      return null;
    },

    cancelJob: async (id) => {
      const state = get();
      const idx = findJobIndexByIdOrJobId(state.jobs, id);
      if (idx === -1) return false;
      const target = state.jobs[idx]!;
      if (target.status !== "running" || target.cancelling) return false;

      if (!target.jobId) {
        set((s) => ({
          jobs: s.jobs.map((j) =>
            j.id === target.id
              ? { ...j, pausing: false, cancelling: true, cancelQueued: true, stage: "cancelling" }
              : j,
          ),
        }));
        return true;
      }

      const backendJobId = target.jobId;
      set((s) => ({
        jobs: s.jobs.map((j) =>
          j.id === target.id
            ? { ...j, pausing: false, cancelling: true, stage: "cancelling" }
            : j,
        ),
      }));

      try {
        const cancelled = await backendCall("cancel_ingest", { id: backendJobId });
        if (!cancelled) {
          let markCancelled = false;
          set((s) => ({
            jobs: s.jobs.map((j) => {
              if (j.id !== target.id || j.status !== "running") return j;
              if (j.awaitingPromise) {
                return { ...j, cancelling: false };
              }
              markCancelled = true;
              return {
                ...j,
                cancelling: false,
                fileChunksDone: null,
                fileChunksTotal: null,
                etaSeconds: null,
                status: "cancelled" as const,
                stage: INGEST_STAGES.cancelled,
                finishedAt: Date.now(),
              };
            }),
          }));
          if (markCancelled) {
            scheduleAutoRemove(target.id);
          }
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
      clearAutoRemoveTimer(id);
      set((state) => {
        const jobs = state.jobs.filter((j) => j.id !== id);
        const reportJobId = state.reportJobId === id ? null : state.reportJobId;
        const expanded = jobs.length === 0 ? false : state.expanded;
        return { jobs, reportJobId, expanded };
      });
    },

    clearFinished: () => {
      set((state) => {
        for (const job of state.jobs) {
          if (isFinishedStatus(job.status)) {
            clearAutoRemoveTimer(job.id);
          }
        }
        const jobs = state.jobs.filter((j) => !isFinishedStatus(j.status));
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

    closeReport: () => {
      const prevId = get().reportJobId;
      set({ reportJobId: null });
      if (!prevId) return;
      const target = get().jobs.find((j) => j.id === prevId);
      if (target && isFinishedStatus(target.status)) {
        const elapsedSinceFinish = target.finishedAt ? Date.now() - target.finishedAt : AUTO_REMOVE_FINISHED_MS;
        const remaining = AUTO_REMOVE_FINISHED_MS - elapsedSinceFinish;
        scheduleAutoRemove(prevId, Math.max(250, remaining));
      }
    },
  };
});
