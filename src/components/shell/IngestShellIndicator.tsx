import { useEffect, useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  FileText,
  FileWarning,
  FolderOpen,
  FolderSync,
  Loader2,
  Pause,
  Play,
  X,
} from "lucide-react";
import {
  analyzeIngestReport,
  extractFileName,
  formatElapsed,
  formatIngestEta,
  formatIngestStage,
  type AnalyzedIngestReport,
} from "@/lib/ingest";
import {
  useIngestStore,
  useMemoryStore,
  useSettingsStore,
  useUiStore,
  type IngestJob,
} from "@/stores";
import type { Uuid } from "@/types/contracts";

interface BackgroundProjectGroup {
  key: string;
  projectId: Uuid | null;
  projectName: string;
  projectColor: string | null;
  jobs: IngestJob[];
  runningJobs: IngestJob[];
  isRunning: boolean;
  fileCount: number;
  etaSeconds: number | null;
  activeChunkJob: IngestJob | null;
  latestUpdatedAt: number;
}

function jobElapsedMs(job: IngestJob, now: number): number {
  return Math.max(0, (job.finishedAt ?? now) - job.startedAt);
}

function jobPercent(job: IngestJob): number {
  if (job.total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((job.processed / job.total) * 100)));
}

function hasFileChunkProgress(job: IngestJob): boolean {
  return (
    job.fileChunksDone !== null &&
    job.fileChunksTotal !== null &&
    job.fileChunksTotal > 0
  );
}

function fileChunkPercent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

function formatFileChunkLabel(
  currentPath: string | null,
  done: number,
  total: number,
  t: TFunction,
): string {
  const fileName = extractFileName(currentPath);
  if (fileName) {
    return t("ingest.fileChunkProgress", {
      file: fileName,
      done,
      total,
    });
  }
  return t("ingest.chunkProgressOnly", { done, total });
}

function FileChunkProgress({
  currentPath,
  chunksDone,
  chunksTotal,
}: {
  currentPath: string | null;
  chunksDone: number | null;
  chunksTotal: number | null;
}) {
  const { t } = useTranslation();
  if (chunksDone === null || chunksTotal === null || chunksTotal <= 0) {
    return null;
  }

  const pct = fileChunkPercent(chunksDone, chunksTotal);
  const label = formatFileChunkLabel(currentPath, chunksDone, chunksTotal, t);

  return (
    <div className="space-y-1">
      <div className="h-[3px] w-full overflow-hidden rounded-[1px] bg-void/90">
        <div
          className="h-full bg-cobalt-ink/85 transition-all duration-150"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div
        className="truncate font-mono text-[10px] tabular-nums text-bone-muted"
        title={currentPath ?? undefined}
      >
        {label}
      </div>
    </div>
  );
}

function isPausableJob(job: IngestJob): boolean {
  return !job.background && (job.ingestRequest !== null || job.pastLifeRequest !== null);
}

function formatSkipReasonsSummary(
  analyzed: AnalyzedIngestReport,
  t: (key: string) => string,
): string {
  if (analyzed.skipReasonCategories.length === 0) {
    return t("ingest.skipReasons.default");
  }
  const labels = analyzed.skipReasonCategories.map((cat) =>
    t(`ingest.skipReasons.${cat}`),
  );
  return labels.join(", ");
}

function JobStatusBadge({ status }: { status: IngestJob["status"] }) {
  const { t } = useTranslation();
  if (status === "running") {
    return (
      <span className="inline-flex items-center gap-1 rounded-[2px] border border-cobalt-rule bg-cobalt-wash px-1.5 py-0.5 font-mono text-[10px] font-medium text-cobalt-ink">
        <Loader2 size={10} className="animate-spin" aria-hidden />
        {t("ingest.status.running")}
      </span>
    );
  }
  if (status === "paused") {
    return (
      <span className="inline-flex items-center gap-1 rounded-[2px] border border-ochre-rule bg-ochre-wash px-1.5 py-0.5 font-mono text-[10px] font-medium text-ochre">
        <Pause size={10} aria-hidden />
        {t("ingest.status.paused")}
      </span>
    );
  }
  if (status === "completed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-[2px] border border-verdigris-rule bg-verdigris-wash px-1.5 py-0.5 font-mono text-[10px] font-medium text-verdigris">
        <CheckCircle2 size={10} aria-hidden />
        {t("ingest.status.completed")}
      </span>
    );
  }
  if (status === "cancelled") {
    return (
      <span className="inline-flex items-center gap-1 rounded-[2px] border border-ochre-rule bg-ochre-wash px-1.5 py-0.5 font-mono text-[10px] font-medium text-ochre">
        <Ban size={10} aria-hidden />
        {t("ingest.status.cancelled")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-[2px] border border-cinnabar-rule bg-cinnabar-wash px-1.5 py-0.5 font-mono text-[10px] font-medium text-cinnabar">
      <AlertTriangle size={10} aria-hidden />
      {t("ingest.status.failed")}
    </span>
  );
}

function GlobalIndexingPauseButton({
  paused,
  disabled,
  onToggle,
}: {
  paused: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      title={paused ? t("ingest.actions.resumeIndexingHint") : t("ingest.actions.pauseIndexingHint")}
      className={`inline-flex shrink-0 items-center gap-1 rounded-[2px] border px-2 py-0.5 font-mono text-[11px] font-medium transition-colors disabled:opacity-50 ${
        paused
          ? "border-verdigris-rule bg-verdigris-wash text-verdigris hover:bg-verdigris hover:text-void"
          : "border-ochre-rule/80 bg-ochre-wash/70 text-ochre hover:bg-ochre-wash"
      }`}
    >
      {paused ? <Play size={10} aria-hidden /> : <Pause size={10} aria-hidden />}
      <span>{paused ? t("ingest.actions.resumeIndexing") : t("ingest.actions.pauseIndexing")}</span>
    </button>
  );
}

function CompactSummaryLine({ job }: { job: IngestJob }) {
  const { t } = useTranslation();

  if (job.error) {
    return <span className="truncate text-cinnabar">{job.error}</span>;
  }

  if (!job.report) {
    if (job.status === "paused") {
      return (
        <span className="truncate text-bone-muted">
          {job.total > 0
            ? t("ingest.summary.pausedPartial", {
                processed: job.processed,
                total: job.total,
              })
            : t("ingest.summary.pausedGeneric")}
        </span>
      );
    }
    if (job.status === "cancelled") {
      return (
        <span className="truncate text-bone-muted">
          {job.total > 0
            ? t("ingest.summary.stoppedPartial", {
                processed: job.processed,
                total: job.total,
              })
            : t("ingest.summary.stoppedNoFiles")}
        </span>
      );
    }
    return (
      <span className="truncate text-bone-muted">
        {job.total > 0
          ? t("ingest.summary.processedCount", {
              processed: job.processed,
              total: job.total,
            })
          : t("ingest.status.completed")}
      </span>
    );
  }

  const analyzed = analyzeIngestReport(job.report);
  const skipHint =
    analyzed.skippedCount > 0 ? formatSkipReasonsSummary(analyzed, t) : null;

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 font-mono text-[11px] tabular-nums text-bone-muted">
      <span className="text-bone">
        {t("ingest.summary.created", { count: analyzed.documentsCreated })}
      </span>
      {analyzed.documentsUpdated > 0 && (
        <span>{t("ingest.summary.updated", { count: analyzed.documentsUpdated })}</span>
      )}
      {(analyzed.documentsUnchanged > 0 || analyzed.documentsCreated === 0) && (
        <span>{t("ingest.summary.unchanged", { count: analyzed.documentsUnchanged })}</span>
      )}
      {analyzed.skippedCount > 0 && (
        <span className="text-ochre" title={skipHint ?? undefined}>
          {t("ingest.summary.skippedWithReason", {
            count: analyzed.skippedCount,
            reason: skipHint,
          })}
        </span>
      )}
      {analyzed.errorIssues.length > 0 && (
        <span className="text-cinnabar">
          {t("ingest.summary.errors", { count: analyzed.errorIssues.length })}
        </span>
      )}
    </span>
  );
}

function IngestReportDetail({
  job,
  now,
  canGoBack,
  onBack,
  onDismiss,
  onOpenImporter,
}: {
  job: IngestJob;
  now: number;
  canGoBack: boolean;
  onBack: () => void;
  onDismiss: () => void;
  onOpenImporter: () => void;
}) {
  const { t } = useTranslation();
  const analyzed = useMemo(
    () => (job.report ? analyzeIngestReport(job.report) : null),
    [job.report],
  );
  const elapsed = formatElapsed(jobElapsedMs(job, now));

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-start justify-between gap-3 border-b border-rule pb-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            {canGoBack && (
              <button
                type="button"
                onClick={onBack}
                className="inline-flex items-center gap-1 rounded-[2px] border border-rule bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-bone-muted hover:border-rule-strong hover:text-bone"
              >
                <ArrowLeft size={10} aria-hidden />
                {t("ingest.report.backToList")}
              </button>
            )}
            <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-cobalt-ink">
              {t("ingest.report.title")}
            </span>
            <JobStatusBadge status={job.status} />
            <span className="inline-flex items-center gap-1 font-mono text-[10px] tabular-nums text-bone-subtle">
              <Clock size={10} aria-hidden />
              {elapsed}
            </span>
          </div>
          <div className="truncate text-xs font-medium text-bone" title={job.label}>
            {job.label}
          </div>
        </div>
      </div>

      {job.error && (
        <div className="rounded-[2px] border border-cinnabar-rule bg-cinnabar-wash p-2.5 text-xs text-cinnabar">
          {job.error}
        </div>
      )}

      {!analyzed && !job.error && (
        <div className="rounded-[2px] border border-rule bg-void p-3 text-xs text-bone-muted">
          {job.status === "cancelled"
            ? t("ingest.report.cancelledWithoutReport", {
                processed: job.processed,
                total: job.total,
              })
            : t("ingest.report.noDetailedReport", {
                processed: job.processed,
                total: job.total,
              })}
        </div>
      )}

      {analyzed && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-[2px] border border-rule bg-void px-2.5 py-2">
              <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-bone-subtle">
                {t("ingest.report.filesCreated")}
              </div>
              <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-bone">
                {analyzed.documentsCreated}
              </div>
            </div>
            <div className="rounded-[2px] border border-rule bg-void px-2.5 py-2">
              <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-bone-subtle">
                {t("ingest.report.filesUnchanged")}
              </div>
              <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-bone">
                {analyzed.documentsUnchanged}
              </div>
            </div>
            <div className="rounded-[2px] border border-rule bg-void px-2.5 py-2">
              <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-bone-subtle">
                {t("ingest.report.skipped")}
              </div>
              <div
                className={`mt-0.5 font-mono text-sm font-semibold tabular-nums ${
                  analyzed.skippedCount > 0 ? "text-ochre" : "text-bone"
                }`}
              >
                {analyzed.skippedCount}
              </div>
            </div>
            <div className="rounded-[2px] border border-rule bg-void px-2.5 py-2">
              <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-bone-subtle">
                {t("ingest.report.errors")}
              </div>
              <div
                className={`mt-0.5 font-mono text-sm font-semibold tabular-nums ${
                  analyzed.errorIssues.length > 0 ? "text-cinnabar" : "text-bone"
                }`}
              >
                {analyzed.errorIssues.length}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-y border-rule py-2 font-mono text-[11px] tabular-nums text-bone-muted">
            <span>
              {t("tools.importer.memsCreated")}:{" "}
              <strong className="text-bone">{analyzed.memoriesCreated}</strong>
            </span>
            {analyzed.documentsUpdated > 0 && (
              <span>
                {t("tools.importer.docsUpdated")}:{" "}
                <strong className="text-bone">{analyzed.documentsUpdated}</strong>
              </span>
            )}
            {analyzed.memoriesSuperseded > 0 && (
              <span>
                {t("ingest.report.memoriesUpdated")}:{" "}
                <strong className="text-bone">{analyzed.memoriesSuperseded}</strong>
              </span>
            )}
            <span>
              {t("tools.importer.tokensIndexed")}:{" "}
              <strong className="text-bone">{analyzed.totalTokens.toLocaleString()}</strong>
            </span>
            {analyzed.redactedSecrets > 0 && (
              <span className="text-ochre">
                {t("tools.importer.redactedSecrets")}:{" "}
                <strong>{analyzed.redactedSecrets}</strong>
              </span>
            )}
          </div>

          {analyzed.skippedCount > 0 && (
            <div className="space-y-1.5 rounded-[2px] border border-ochre-rule/70 bg-ochre-wash/50 p-3">
              <div className="flex items-center gap-1.5 font-mono text-[11px] font-semibold text-ochre">
                <FileWarning size={12} aria-hidden />
                <span>
                  {t("ingest.report.skippedSectionTitle", { count: analyzed.skippedCount })}
                </span>
              </div>
              <p className="text-[11px] leading-relaxed text-bone-muted">
                {t("ingest.report.skippedRulesHint")}
              </p>
              {analyzed.skipIssues.length > 0 && (
                <ul className="max-h-32 space-y-1 overflow-y-auto pt-1 font-mono text-[11px]">
                  {analyzed.skipIssues.map((issue, idx) => (
                    <li
                      key={`${issue.path}-${idx}`}
                      className="flex items-baseline justify-between gap-2 rounded-[2px] bg-void/70 px-2 py-1"
                    >
                      <span className="truncate text-bone" title={issue.path}>
                        {extractFileName(issue.path) ?? issue.path}
                      </span>
                      <span className="shrink-0 text-[10px] text-ochre">{issue.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {analyzed.errorIssues.length > 0 && (
            <div className="space-y-1.5 rounded-[2px] border border-cinnabar-rule/80 bg-cinnabar-wash/50 p-3">
              <div className="flex items-center gap-1.5 font-mono text-[11px] font-semibold text-cinnabar">
                <AlertTriangle size={12} aria-hidden />
                <span>
                  {t("ingest.report.errorsSectionTitle", {
                    count: analyzed.errorIssues.length,
                  })}
                </span>
              </div>
              <ul className="max-h-36 space-y-1 overflow-y-auto font-mono text-[11px]">
                {analyzed.errorIssues.map((issue, idx) => (
                  <li
                    key={`${issue.path}-${idx}`}
                    className="space-y-0.5 rounded-[2px] bg-void/70 px-2 py-1.5"
                  >
                    <div className="truncate text-bone" title={issue.path}>
                      {extractFileName(issue.path) ?? issue.path}
                    </div>
                    <div className="text-[10px] text-cinnabar">{issue.message}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      <div className="flex items-center justify-between gap-2 pt-1">
        <button
          type="button"
          onClick={onOpenImporter}
          className="inline-flex items-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface-2 px-2.5 py-1 font-mono text-[11px] text-bone-muted hover:border-cobalt-ink/60 hover:text-bone"
        >
          <FolderOpen size={11} aria-hidden />
          {t("ingest.actions.openImporter")}
        </button>
        {job.status !== "running" && (
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-[2px] border border-rule bg-surface-2 px-2.5 py-1 font-mono text-[11px] text-bone-muted hover:border-rule-strong hover:text-bone"
          >
            {t("ingest.actions.dismiss")}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Persistent shell ingest progress bar + non-blocking expandable details/report panel.
 * Visible from every view whenever jobs exist or global indexing is paused.
 */
export function IngestShellIndicator() {
  const { t } = useTranslation();

  const jobs = useIngestStore((s) => s.jobs);
  const expanded = useIngestStore((s) => s.expanded);
  const reportJobId = useIngestStore((s) => s.reportJobId);
  const pauseJob = useIngestStore((s) => s.pauseJob);
  const resumeJob = useIngestStore((s) => s.resumeJob);
  const cancelJob = useIngestStore((s) => s.cancelJob);
  const dismissJob = useIngestStore((s) => s.dismissJob);
  const clearFinished = useIngestStore((s) => s.clearFinished);
  const toggleExpanded = useIngestStore((s) => s.toggleExpanded);
  const setExpanded = useIngestStore((s) => s.setExpanded);
  const openReport = useIngestStore((s) => s.openReport);
  const closeReport = useIngestStore((s) => s.closeReport);

  const indexingPaused = useSettingsStore((s) => s.settings.capture.indexing_paused);
  const savingSettings = useSettingsStore((s) => s.saving);
  const setIndexingPaused = useSettingsStore((s) => s.setIndexingPaused);

  const graphProjects = useMemoryStore((s) => s.graph?.projects);
  const openToolsTab = useUiStore((s) => s.openToolsTab);

  const projectLookup = useMemo(() => {
    const map = new Map<Uuid, { name: string; color: string }>();
    for (const stat of graphProjects ?? []) {
      map.set(stat.project.id, {
        name: stat.project.name,
        color: stat.project.color_hex,
      });
    }
    return map;
  }, [graphProjects]);

  const foregroundJobs = useMemo(
    () => jobs.filter((j) => !j.background),
    [jobs],
  );
  const backgroundJobs = useMemo(
    () => jobs.filter((j) => j.background),
    [jobs],
  );

  const fgRunning = useMemo(
    () => foregroundJobs.filter((j) => j.status === "running"),
    [foregroundJobs],
  );
  const fgPaused = useMemo(
    () => foregroundJobs.filter((j) => j.status === "paused"),
    [foregroundJobs],
  );
  const fgFinished = useMemo(
    () => foregroundJobs.filter((j) => j.status !== "running" && j.status !== "paused"),
    [foregroundJobs],
  );

  // Group ALL background jobs (background=true) into ONE compact row per project
  const backgroundGroups = useMemo<BackgroundProjectGroup[]>(() => {
    const map = new Map<string, IngestJob[]>();
    for (const job of backgroundJobs) {
      const key = job.projectId ?? "__global__";
      const list = map.get(key);
      if (list) {
        list.push(job);
      } else {
        map.set(key, [job]);
      }
    }

    const groups: BackgroundProjectGroup[] = [];
    for (const [key, groupJobs] of map.entries()) {
      const projectId = key === "__global__" ? null : key;
      const projMeta = projectId ? projectLookup.get(projectId) : undefined;
      const projectName = projMeta?.name ?? t("brain.globalScope");
      const runningJobs = groupJobs.filter((j) => j.status === "running");

      let fileCount = 0;
      let maxEta: number | null = null;
      let activeChunkJob: IngestJob | null = null;
      let latestUpdatedAt = 0;

      for (const job of groupJobs) {
        latestUpdatedAt = Math.max(latestUpdatedAt, job.finishedAt ?? job.startedAt);
      }
      for (const job of runningJobs) {
        if (job.total > 0) {
          fileCount += job.total;
        }
        if (job.etaSeconds != null && job.etaSeconds > 0) {
          maxEta = maxEta === null ? job.etaSeconds : Math.max(maxEta, job.etaSeconds);
        }
        if (activeChunkJob === null && hasFileChunkProgress(job)) {
          activeChunkJob = job;
        }
      }

      groups.push({
        key,
        projectId,
        projectName,
        projectColor: projMeta?.color ?? null,
        jobs: groupJobs,
        runningJobs,
        isRunning: runningJobs.length > 0,
        fileCount,
        etaSeconds: maxEta,
        activeChunkJob,
        latestUpdatedAt,
      });
    }

    groups.sort((a, b) => {
      if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1;
      return b.latestUpdatedAt - a.latestUpdatedAt;
    });
    return groups;
  }, [backgroundJobs, projectLookup, t]);

  const runningBgGroups = useMemo(
    () => backgroundGroups.filter((g) => g.isRunning),
    [backgroundGroups],
  );

  const totalActiveCount = fgRunning.length + runningBgGroups.length;
  const hasRunning = totalActiveCount > 0;
  const hasAnyFinished =
    fgFinished.length > 0 || backgroundGroups.some((g) => !g.isRunning);

  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!hasRunning) return;
    setNow(Date.now());
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [hasRunning]);

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setExpanded(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded, setExpanded]);

  if (jobs.length === 0 && !indexingPaused) {
    return null;
  }

  const leadFgRunning = fgRunning[0] ?? null;
  const leadBgRunning = runningBgGroups[0] ?? null;
  const leadFgPaused = fgPaused[0] ?? null;
  const leadFgFinished = fgFinished[0] ?? null;
  const leadBgFinished = backgroundGroups[0] ?? null;
  const activeReportJob = reportJobId
    ? (jobs.find((j) => j.id === reportJobId) ?? null)
    : null;

  const leadPct = leadFgRunning ? jobPercent(leadFgRunning) : 100;
  const leadFileName = leadFgRunning ? extractFileName(leadFgRunning.currentPath) : null;
  const leadStage = leadFgRunning ? formatIngestStage(leadFgRunning.stage, t) : null;
  const leadElapsed = leadFgRunning ? formatElapsed(jobElapsedMs(leadFgRunning, now)) : null;
  const leadEta = leadFgRunning
    ? formatIngestEta(leadFgRunning.etaSeconds, t)
    : leadBgRunning
      ? formatIngestEta(leadBgRunning.etaSeconds, t)
      : null;
  const leadChunkJob =
    leadFgRunning && hasFileChunkProgress(leadFgRunning)
      ? leadFgRunning
      : !leadFgRunning && leadBgRunning?.activeChunkJob
        ? leadBgRunning.activeChunkJob
        : null;
  const leadChunkLabel =
    leadChunkJob && leadChunkJob.fileChunksDone !== null && leadChunkJob.fileChunksTotal !== null
      ? formatFileChunkLabel(
          leadChunkJob.currentPath,
          leadChunkJob.fileChunksDone,
          leadChunkJob.fileChunksTotal,
          t,
        )
      : null;
  const leadChunkPct =
    leadChunkJob && leadChunkJob.fileChunksDone !== null && leadChunkJob.fileChunksTotal !== null
      ? fileChunkPercent(leadChunkJob.fileChunksDone, leadChunkJob.fileChunksTotal)
      : null;

  const formatBgRowText = (group: BackgroundProjectGroup): string => {
    const prefix = group.isRunning
      ? t("ingest.background.keepingUpToDate")
      : t("ingest.background.upToDate");
    if (!group.isRunning || group.fileCount <= 0) {
      return `${prefix} · ${group.projectName}`;
    }
    const filesText =
      group.fileCount === 1
        ? t("ingest.background.fileOne")
        : t("ingest.background.fileMany", { count: group.fileCount });
    return `${prefix} · ${group.projectName} · ${filesText}`;
  };

  const handleToggleGlobalPause = () => {
    void setIndexingPaused(!indexingPaused);
  };

  return (
    <div
      className="relative z-30 shrink-0 border-b border-rule bg-surface"
      role="region"
      aria-label={t("ingest.regionLabel")}
      aria-live="polite"
    >
      {/* Compact persistent shell bar */}
      <div className="flex min-h-10 items-center justify-between gap-3 px-4 py-1.5">
        {leadFgRunning ? (
          <>
            <button
              type="button"
              onClick={toggleExpanded}
              aria-expanded={expanded}
              className="flex min-w-0 flex-1 items-center gap-2.5 text-left focus-visible:outline-none"
            >
              <Loader2 size={13} className="shrink-0 animate-spin text-cobalt-ink" aria-hidden />

              {totalActiveCount > 1 && (
                <span className="shrink-0 rounded-[2px] border border-cobalt-rule bg-cobalt-wash px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums text-cobalt-ink">
                  {t("ingest.concurrentActive", { count: totalActiveCount })}
                </span>
              )}

              <span className="shrink-0 font-mono text-xs font-medium text-cobalt-ink">
                {leadStage}
              </span>

              {(leadChunkLabel || leadFileName) && (
                <span
                  className="min-w-0 truncate font-mono text-[11px] tabular-nums text-bone-muted"
                  title={leadFgRunning.currentPath ?? undefined}
                >
                  {leadChunkLabel ?? leadFileName}
                </span>
              )}

              <div className="hidden h-1.5 w-24 shrink-0 overflow-hidden rounded-[1px] bg-void md:block">
                <div
                  className={`h-full bg-cobalt transition-all duration-200 ${
                    leadFgRunning.total === 0 ? "w-1/3 animate-pulse" : ""
                  }`}
                  style={leadFgRunning.total > 0 ? { width: `${leadPct}%` } : undefined}
                />
              </div>

              {leadFgRunning.total > 0 && (
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-bone">
                  {leadFgRunning.processed}/{leadFgRunning.total}
                </span>
              )}

              {leadEta && (
                <span className="shrink-0 font-mono text-[10px] tabular-nums text-cobalt-ink">
                  {leadEta}
                </span>
              )}

              <span className="hidden shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums text-bone-subtle lg:inline-flex">
                <Clock size={10} aria-hidden />
                {leadElapsed}
              </span>
            </button>

            <div className="flex shrink-0 items-center gap-1.5">
              {isPausableJob(leadFgRunning) && (
                <button
                  type="button"
                  disabled={leadFgRunning.cancelling}
                  onClick={(e) => {
                    e.stopPropagation();
                    void pauseJob(leadFgRunning.id);
                  }}
                  className="inline-flex items-center gap-1 rounded-[2px] border border-ochre-rule/80 bg-ochre-wash/70 px-2 py-0.5 font-mono text-[11px] font-medium text-ochre transition-colors hover:bg-ochre-wash disabled:opacity-50"
                >
                  <Pause size={10} aria-hidden />
                  {leadFgRunning.pausing ? t("ingest.actions.pausing") : t("ingest.actions.pause")}
                </button>
              )}

              <button
                type="button"
                disabled={leadFgRunning.cancelling}
                onClick={(e) => {
                  e.stopPropagation();
                  void cancelJob(leadFgRunning.id);
                }}
                className="inline-flex items-center gap-1 rounded-[2px] border border-cinnabar-rule/80 bg-cinnabar-wash/70 px-2 py-0.5 font-mono text-[11px] font-medium text-cinnabar transition-colors hover:bg-cinnabar-wash disabled:opacity-50"
              >
                {leadFgRunning.cancelling && !leadFgRunning.pausing ? (
                  <>
                    <Loader2 size={10} className="animate-spin" aria-hidden />
                    {t("ingest.actions.stopping")}
                  </>
                ) : (
                  <>
                    <X size={11} aria-hidden />
                    {t("common.cancel")}
                  </>
                )}
              </button>

              <GlobalIndexingPauseButton
                paused={indexingPaused}
                disabled={savingSettings}
                onToggle={handleToggleGlobalPause}
              />

              <button
                type="button"
                onClick={toggleExpanded}
                aria-expanded={expanded}
                title={expanded ? t("ingest.actions.hideDetails") : t("ingest.actions.showDetails")}
                className="inline-flex h-6 w-6 items-center justify-center rounded-[2px] border border-rule bg-surface-2 text-bone-muted hover:border-rule-strong hover:text-bone"
              >
                {expanded ? (
                  <ChevronUp size={13} aria-hidden />
                ) : (
                  <ChevronDown size={13} aria-hidden />
                )}
              </button>
            </div>
          </>
        ) : leadBgRunning ? (
          <>
            <button
              type="button"
              onClick={toggleExpanded}
              aria-expanded={expanded}
              className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none"
            >
              <Loader2 size={12} className="shrink-0 animate-spin text-cobalt-ink" aria-hidden />
              {leadBgRunning.projectColor && (
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: leadBgRunning.projectColor }}
                />
              )}
              <span className="truncate font-mono text-xs text-bone">
                {formatBgRowText(leadBgRunning)}
              </span>
              {leadChunkLabel && (
                <span
                  className="min-w-0 truncate font-mono text-[11px] tabular-nums text-bone-muted"
                  title={leadChunkJob?.currentPath ?? undefined}
                >
                  · {leadChunkLabel}
                </span>
              )}
              {runningBgGroups.length > 1 && (
                <span className="shrink-0 rounded-[2px] border border-rule bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-bone-subtle">
                  +{runningBgGroups.length - 1}
                </span>
              )}
              {leadEta && (
                <span className="shrink-0 font-mono text-[10px] tabular-nums text-cobalt-ink">
                  · {leadEta}
                </span>
              )}
            </button>

            <div className="flex shrink-0 items-center gap-1.5">
              <GlobalIndexingPauseButton
                paused={indexingPaused}
                disabled={savingSettings}
                onToggle={handleToggleGlobalPause}
              />
              <button
                type="button"
                onClick={toggleExpanded}
                aria-expanded={expanded}
                title={expanded ? t("ingest.actions.hideDetails") : t("ingest.actions.showDetails")}
                className="inline-flex h-6 w-6 items-center justify-center rounded-[2px] border border-rule bg-surface-2 text-bone-muted hover:border-rule-strong hover:text-bone"
              >
                {expanded ? (
                  <ChevronUp size={13} aria-hidden />
                ) : (
                  <ChevronDown size={13} aria-hidden />
                )}
              </button>
            </div>
          </>
        ) : leadFgPaused ? (
          <>
            <button
              type="button"
              onClick={toggleExpanded}
              aria-expanded={expanded}
              className="flex min-w-0 flex-1 items-center gap-2.5 text-left focus-visible:outline-none"
            >
              <JobStatusBadge status="paused" />
              <span className="truncate text-xs font-medium text-bone" title={leadFgPaused.label}>
                {leadFgPaused.label}
              </span>
              <CompactSummaryLine job={leadFgPaused} />
              {fgPaused.length > 1 && (
                <span className="shrink-0 rounded-[2px] border border-rule bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-bone-subtle">
                  +{fgPaused.length - 1}
                </span>
              )}
            </button>

            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void resumeJob(leadFgPaused.id);
                }}
                className="inline-flex items-center gap-1 rounded-[2px] border border-verdigris-rule bg-verdigris-wash px-2 py-0.5 font-mono text-[11px] font-medium text-verdigris transition-colors hover:bg-verdigris hover:text-void"
              >
                <Play size={10} aria-hidden />
                {t("ingest.actions.resume")}
              </button>

              <GlobalIndexingPauseButton
                paused={indexingPaused}
                disabled={savingSettings}
                onToggle={handleToggleGlobalPause}
              />

              <button
                type="button"
                onClick={toggleExpanded}
                aria-expanded={expanded}
                title={expanded ? t("ingest.actions.hideDetails") : t("ingest.actions.showDetails")}
                className="inline-flex h-6 w-6 items-center justify-center rounded-[2px] border border-rule bg-surface-2 text-bone-muted hover:border-rule-strong hover:text-bone"
              >
                {expanded ? (
                  <ChevronUp size={13} aria-hidden />
                ) : (
                  <ChevronDown size={13} aria-hidden />
                )}
              </button>

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  dismissJob(leadFgPaused.id);
                }}
                title={t("ingest.actions.dismiss")}
                aria-label={t("ingest.actions.dismiss")}
                className="inline-flex h-6 w-6 items-center justify-center rounded-[2px] border border-transparent text-bone-subtle hover:border-rule hover:bg-surface-2 hover:text-bone"
              >
                <X size={12} aria-hidden />
              </button>
            </div>
          </>
        ) : leadFgFinished ? (
          <>
            <button
              type="button"
              onClick={toggleExpanded}
              aria-expanded={expanded}
              className="flex min-w-0 flex-1 items-center gap-2.5 text-left focus-visible:outline-none"
            >
              <JobStatusBadge status={leadFgFinished.status} />
              <CompactSummaryLine job={leadFgFinished} />
              {fgFinished.length > 1 && (
                <span className="shrink-0 rounded-[2px] border border-rule bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-bone-subtle">
                  +{fgFinished.length - 1}
                </span>
              )}
            </button>

            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  openReport(leadFgFinished.id);
                }}
                className="inline-flex items-center gap-1 rounded-[2px] border border-cobalt-rule bg-cobalt-wash px-2 py-0.5 font-mono text-[11px] font-medium text-cobalt-ink transition-colors hover:bg-cobalt hover:text-bone"
              >
                <FileText size={11} aria-hidden />
                {t("ingest.actions.viewReport")}
              </button>

              <GlobalIndexingPauseButton
                paused={indexingPaused}
                disabled={savingSettings}
                onToggle={handleToggleGlobalPause}
              />

              <button
                type="button"
                onClick={toggleExpanded}
                aria-expanded={expanded}
                title={expanded ? t("ingest.actions.hideDetails") : t("ingest.actions.showDetails")}
                className="inline-flex h-6 w-6 items-center justify-center rounded-[2px] border border-rule bg-surface-2 text-bone-muted hover:border-rule-strong hover:text-bone"
              >
                {expanded ? (
                  <ChevronUp size={13} aria-hidden />
                ) : (
                  <ChevronDown size={13} aria-hidden />
                )}
              </button>

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  dismissJob(leadFgFinished.id);
                }}
                title={t("ingest.actions.dismiss")}
                aria-label={t("ingest.actions.dismiss")}
                className="inline-flex h-6 w-6 items-center justify-center rounded-[2px] border border-transparent text-bone-subtle hover:border-rule hover:bg-surface-2 hover:text-bone"
              >
                <X size={12} aria-hidden />
              </button>
            </div>
          </>
        ) : leadBgFinished ? (
          <>
            <button
              type="button"
              onClick={toggleExpanded}
              aria-expanded={expanded}
              className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none"
            >
              <CheckCircle2 size={12} className="shrink-0 text-verdigris" aria-hidden />
              {leadBgFinished.projectColor && (
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: leadBgFinished.projectColor }}
                />
              )}
              <span className="truncate font-mono text-xs text-bone-muted">
                {formatBgRowText(leadBgFinished)}
              </span>
              {backgroundGroups.length > 1 && (
                <span className="shrink-0 rounded-[2px] border border-rule bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-bone-subtle">
                  +{backgroundGroups.length - 1}
                </span>
              )}
            </button>

            <div className="flex shrink-0 items-center gap-1.5">
              <GlobalIndexingPauseButton
                paused={indexingPaused}
                disabled={savingSettings}
                onToggle={handleToggleGlobalPause}
              />
              <button
                type="button"
                onClick={toggleExpanded}
                aria-expanded={expanded}
                title={expanded ? t("ingest.actions.hideDetails") : t("ingest.actions.showDetails")}
                className="inline-flex h-6 w-6 items-center justify-center rounded-[2px] border border-rule bg-surface-2 text-bone-muted hover:border-rule-strong hover:text-bone"
              >
                {expanded ? (
                  <ChevronUp size={13} aria-hidden />
                ) : (
                  <ChevronDown size={13} aria-hidden />
                )}
              </button>
            </div>
          </>
        ) : (
          /* Global indexing paused banner (when no jobs are currently listed) */
          <>
            <div className="flex min-w-0 flex-1 items-center gap-2 text-ochre">
              <Pause size={12} className="shrink-0" aria-hidden />
              <span className="truncate font-mono text-xs font-medium">
                {t("ingest.indexingPausedBanner")}
              </span>
            </div>
            <GlobalIndexingPauseButton
              paused={indexingPaused}
              disabled={savingSettings}
              onToggle={handleToggleGlobalPause}
            />
          </>
        )}
      </div>

      {/* Subtle bottom hairline progress track while running */}
      {leadFgRunning && (
        <div className="h-[2px] w-full overflow-hidden bg-void">
          <div
            className={`h-full bg-cobalt transition-all duration-200 ${
              leadFgRunning.total === 0 ? "w-1/4 animate-pulse" : ""
            }`}
            style={leadFgRunning.total > 0 ? { width: `${leadPct}%` } : undefined}
          />
        </div>
      )}
      {leadChunkPct !== null && (
        <div className="h-[2px] w-full overflow-hidden bg-void/90">
          <div
            className="h-full bg-cobalt-ink/85 transition-all duration-150"
            style={{ width: `${leadChunkPct}%` }}
          />
        </div>
      )}

      {/* Non-blocking expanded panel */}
      {expanded && (
        <div className="pointer-events-auto absolute top-full right-3 z-40 mt-1.5 w-[min(38rem,calc(100%-1.5rem))] max-h-[min(72vh,34rem)] overflow-y-auto rounded-[2px] border border-rule-strong bg-surface/98 shadow-[0_18px_44px_rgba(0,0,0,0.72)] backdrop-blur-sm">
          {activeReportJob ? (
            <IngestReportDetail
              job={activeReportJob}
              now={now}
              canGoBack={jobs.length > 1}
              onBack={closeReport}
              onDismiss={() => dismissJob(activeReportJob.id)}
              onOpenImporter={() => {
                setExpanded(false);
                openToolsTab("importer");
              }}
            />
          ) : (
            <div className="space-y-3 p-4">
              {/* Panel header */}
              <div className="flex items-center justify-between gap-2 border-b border-rule pb-2.5">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-cobalt-ink">
                    {t("ingest.panelTitle")}
                  </span>
                  {totalActiveCount > 0 && (
                    <span className="rounded-[2px] border border-cobalt-rule bg-cobalt-wash px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-cobalt-ink">
                      {t("ingest.concurrentActive", { count: totalActiveCount })}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1.5">
                  <GlobalIndexingPauseButton
                    paused={indexingPaused}
                    disabled={savingSettings}
                    onToggle={handleToggleGlobalPause}
                  />
                  {hasAnyFinished && (
                    <button
                      type="button"
                      onClick={clearFinished}
                      className="rounded-[2px] border border-rule bg-surface-2 px-2 py-0.5 font-mono text-[10px] text-bone-muted hover:border-rule-strong hover:text-bone"
                    >
                      {t("ingest.actions.clearFinished")}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setExpanded(false)}
                    aria-label={t("common.close")}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-[2px] border border-rule bg-surface-2 text-bone-muted hover:border-rule-strong hover:text-bone"
                  >
                    <X size={12} aria-hidden />
                  </button>
                </div>
              </div>

              {indexingPaused && (
                <div className="flex items-center gap-2 rounded-[2px] border border-ochre-rule/80 bg-ochre-wash/60 px-3 py-2 text-xs text-ochre">
                  <Pause size={12} className="shrink-0" aria-hidden />
                  <span>{t("ingest.indexingPausedBanner")}</span>
                </div>
              )}

              {/* Active foreground jobs */}
              {fgRunning.length > 0 && (
                <div className="space-y-2">
                  {fgRunning.map((job) => {
                    const pct = jobPercent(job);
                    const fileName = extractFileName(job.currentPath);
                    const showChunkProgress = hasFileChunkProgress(job);
                    const stageLabel = formatIngestStage(job.stage, t);
                    const elapsed = formatElapsed(jobElapsedMs(job, now));
                    const etaLabel = formatIngestEta(job.etaSeconds, t);

                    return (
                      <div
                        key={job.id}
                        className="space-y-2 rounded-[2px] border border-cobalt-rule/70 bg-cobalt-wash/35 p-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 space-y-0.5">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="truncate text-xs font-medium text-bone" title={job.label}>
                                {job.label}
                              </span>
                              <span className="font-mono text-[10px] text-cobalt-ink">
                                {stageLabel}
                              </span>
                            </div>
                            {fileName && !showChunkProgress && (
                              <div
                                className="truncate font-mono text-[10px] text-bone-muted"
                                title={job.currentPath ?? undefined}
                              >
                                {fileName}
                              </div>
                            )}
                          </div>

                          <div className="flex shrink-0 items-center gap-1.5">
                            {isPausableJob(job) && (
                              <button
                                type="button"
                                disabled={job.cancelling}
                                onClick={() => void pauseJob(job.id)}
                                className="inline-flex items-center gap-1 rounded-[2px] border border-ochre-rule/80 bg-ochre-wash/70 px-2 py-0.5 font-mono text-[10px] font-medium text-ochre hover:bg-ochre-wash disabled:opacity-50"
                              >
                                <Pause size={10} aria-hidden />
                                {job.pausing ? t("ingest.actions.pausing") : t("ingest.actions.pause")}
                              </button>
                            )}
                            <button
                              type="button"
                              disabled={job.cancelling}
                              onClick={() => void cancelJob(job.id)}
                              className="inline-flex items-center gap-1 rounded-[2px] border border-cinnabar-rule/80 bg-cinnabar-wash/70 px-2 py-0.5 font-mono text-[10px] font-medium text-cinnabar hover:bg-cinnabar-wash disabled:opacity-50"
                            >
                              {job.cancelling && !job.pausing ? (
                                <>
                                  <Loader2 size={10} className="animate-spin" aria-hidden />
                                  {t("ingest.actions.stopping")}
                                </>
                              ) : (
                                <>
                                  <X size={10} aria-hidden />
                                  {t("common.cancel")}
                                </>
                              )}
                            </button>
                          </div>
                        </div>

                        <div className="space-y-1">
                          <div className="h-1.5 w-full overflow-hidden rounded-[1px] bg-void">
                            <div
                              className={`h-full bg-cobalt transition-all duration-200 ${
                                job.total === 0 ? "w-1/3 animate-pulse" : ""
                              }`}
                              style={job.total > 0 ? { width: `${pct}%` } : undefined}
                            />
                          </div>
                          <div className="flex items-center justify-between gap-2 font-mono text-[10px] tabular-nums text-bone-subtle">
                            <span>
                              {job.total > 0
                                ? `${job.processed} / ${job.total} (${pct}%)`
                                : t("ingest.calculatingTotal")}
                            </span>
                            <span className="inline-flex items-center gap-2">
                              {etaLabel && <span className="text-cobalt-ink">{etaLabel}</span>}
                              <span className="inline-flex items-center gap-1">
                                <Clock size={10} aria-hidden />
                                {elapsed}
                              </span>
                            </span>
                          </div>
                        </div>

                        {showChunkProgress && (
                          <FileChunkProgress
                            currentPath={job.currentPath}
                            chunksDone={job.fileChunksDone}
                            chunksTotal={job.fileChunksTotal}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Paused foreground jobs (keep request for Resume) */}
              {fgPaused.length > 0 && (
                <div className="space-y-2">
                  {fgPaused.map((job) => (
                    <div
                      key={job.id}
                      className="space-y-1.5 rounded-[2px] border border-ochre-rule/70 bg-ochre-wash/35 p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <JobStatusBadge status="paused" />
                          <span className="truncate text-xs font-medium text-bone" title={job.label}>
                            {job.label}
                          </span>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => void resumeJob(job.id)}
                            className="inline-flex items-center gap-1 rounded-[2px] border border-verdigris-rule bg-verdigris-wash px-2 py-0.5 font-mono text-[10px] font-medium text-verdigris hover:bg-verdigris hover:text-void"
                          >
                            <Play size={10} aria-hidden />
                            {t("ingest.actions.resume")}
                          </button>
                          <button
                            type="button"
                            onClick={() => dismissJob(job.id)}
                            title={t("ingest.actions.dismiss")}
                            aria-label={t("ingest.actions.dismiss")}
                            className="inline-flex h-5 w-5 items-center justify-center rounded-[2px] text-bone-subtle hover:bg-surface-2 hover:text-bone"
                          >
                            <X size={11} aria-hidden />
                          </button>
                        </div>
                      </div>
                      <div className="text-[11px] text-bone-muted">
                        <CompactSummaryLine job={job} />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Grouped background jobs: ONE compact row per project */}
              {backgroundGroups.length > 0 && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
                    <FolderSync size={11} aria-hidden />
                    <span>{t("ingest.background.sectionTitle")}</span>
                  </div>
                  <div className="divide-y divide-rule rounded-[2px] border border-rule bg-void/80">
                    {backgroundGroups.map((group) => {
                      const etaLabel = group.isRunning
                        ? formatIngestEta(group.etaSeconds, t)
                        : null;
                      return (
                        <div
                          key={group.key}
                          className="space-y-1.5 px-3 py-2 font-mono text-[11px]"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex min-w-0 items-center gap-2">
                              {group.isRunning ? (
                                <Loader2
                                  size={11}
                                  className="shrink-0 animate-spin text-cobalt-ink"
                                  aria-hidden
                                />
                              ) : (
                                <CheckCircle2
                                  size={11}
                                  className="shrink-0 text-verdigris"
                                  aria-hidden
                                />
                              )}
                              {group.projectColor && (
                                <span
                                  className="h-2 w-2 shrink-0 rounded-full"
                                  style={{ backgroundColor: group.projectColor }}
                                />
                              )}
                              <span className="truncate text-bone">
                                {formatBgRowText(group)}
                              </span>
                            </div>
                            {etaLabel && (
                              <span className="shrink-0 text-[10px] tabular-nums text-cobalt-ink">
                                {etaLabel}
                              </span>
                            )}
                          </div>
                          {group.isRunning && group.activeChunkJob && (
                            <FileChunkProgress
                              currentPath={group.activeChunkJob.currentPath}
                              chunksDone={group.activeChunkJob.fileChunksDone}
                              chunksTotal={group.activeChunkJob.fileChunksTotal}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Recently finished foreground jobs (auto-removed after ~5 s) */}
              {fgFinished.length > 0 && (
                <div className="space-y-2">
                  {(fgRunning.length > 0 || fgPaused.length > 0 || backgroundGroups.length > 0) && (
                    <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
                      {t("ingest.recentFinishedTitle")}
                    </div>
                  )}
                  {fgFinished.map((job) => {
                    const elapsed = formatElapsed(jobElapsedMs(job, now));
                    return (
                      <div
                        key={job.id}
                        className="space-y-1.5 rounded-[2px] border border-rule bg-void/80 p-3"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <JobStatusBadge status={job.status} />
                            <span className="truncate text-xs font-medium text-bone" title={job.label}>
                              {job.label}
                            </span>
                            <span className="shrink-0 font-mono text-[10px] tabular-nums text-bone-subtle">
                              {elapsed}
                            </span>
                          </div>

                          <div className="flex shrink-0 items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => openReport(job.id)}
                              className="inline-flex items-center gap-1 rounded-[2px] border border-cobalt-rule bg-cobalt-wash px-2 py-0.5 font-mono text-[10px] font-medium text-cobalt-ink hover:bg-cobalt hover:text-bone"
                            >
                              <FileText size={10} aria-hidden />
                              {t("ingest.actions.viewReport")}
                            </button>
                            <button
                              type="button"
                              onClick={() => dismissJob(job.id)}
                              title={t("ingest.actions.dismiss")}
                              aria-label={t("ingest.actions.dismiss")}
                              className="inline-flex h-5 w-5 items-center justify-center rounded-[2px] text-bone-subtle hover:bg-surface-2 hover:text-bone"
                            >
                              <X size={11} aria-hidden />
                            </button>
                          </div>
                        </div>
                        <div className="text-[11px] text-bone-muted">
                          <CompactSummaryLine job={job} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
