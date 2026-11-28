import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  GitMerge,
  Loader2,
  RefreshCw,
  Scale,
  Sparkles,
  X,
} from "lucide-react";
import { backendCall } from "@/lib/backend";
import { isUnsupportedError } from "@/lib/ipc";
import { staggerStyle } from "@/lib/motion";
import { resolveProjectColor } from "@/lib/projects";
import { conflictReasonI18nKey } from "@/lib/savings";
import { useMemoryStore, useSettingsStore } from "@/stores";
import { Skeleton } from "@/components/ui";
import type { ConflictPair, DuplicateCluster, Memory, Project, Uuid } from "@/types/contracts";

type CleanTab = "duplicates" | "contradictions";

const DISMISSED_CONFLICTS_STORAGE_KEY = "cobalt.dismissedConflictPairs";
/** Cap passive 3D highlights so large scan results never cause GPU sprite overdraw lag. */
const MAX_PASSIVE_HIGHLIGHT_NODES = 18;
const CONFLICTS_YIELD_MS = 80;

function conflictPairKey(aId: Uuid, bId: Uuid): string {
  return aId < bId ? `${aId}:${bId}` : `${bId}:${aId}`;
}

function loadDismissedConflictKeys(): ReadonlySet<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(DISMISSED_CONFLICTS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return new Set();
  }
}

function saveDismissedConflictKeys(keys: ReadonlySet<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DISMISSED_CONFLICTS_STORAGE_KEY, JSON.stringify([...keys]));
  } catch {
    // Ignore storage quota / restricted storage errors.
  }
}

function formatMemoryDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}

interface CleanBrainPanelProps {
  onClose: () => void;
  onInspectMemory: (id: Uuid) => void;
}

export function CleanBrainPanel({ onClose, onInspectMemory }: CleanBrainPanelProps) {
  const { t } = useTranslation();

  const graph = useMemoryStore((s) => s.graph);
  const loadGraph = useMemoryStore((s) => s.loadGraph);
  const setHighlightedNodeIds = useMemoryStore((s) => s.setHighlightedNodeIds);
  const readOnly = useSettingsStore((s) => s.settings.read_only);

  const [activeTab, setActiveTab] = useState<CleanTab>("duplicates");
  const [clusters, setClusters] = useState<DuplicateCluster[]>([]);
  const [conflicts, setConflicts] = useState<ConflictPair[]>([]);
  const [dismissedConflictKeys, setDismissedConflictKeys] = useState<ReadonlySet<string>>(() =>
    loadDismissedConflictKeys(),
  );
  const [keepChoices, setKeepChoices] = useState<Record<number, Uuid>>({});
  const [extraProjects, setExtraProjects] = useState<Project[]>([]);
  const [loadingDuplicates, setLoadingDuplicates] = useState(true);
  const [loadingConflicts, setLoadingConflicts] = useState(true);
  const [hoveredHighlightIds, setHoveredHighlightIds] = useState<readonly Uuid[] | null>(null);
  const [mergingIdx, setMergingIdx] = useState<number | null>(null);
  const [resolvingPairKey, setResolvingPairKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mergedCount, setMergedCount] = useState(0);
  const [resolvedConflictsCount, setResolvedConflictsCount] = useState(0);

  const scanSeqRef = useRef(0);
  const mountedRef = useRef(true);
  const conflictYieldTimerRef = useRef<number | null>(null);
  const loading = loadingDuplicates || loadingConflicts;
  const activeTabLoading =
    activeTab === "duplicates" ? loadingDuplicates : loadingConflicts;

  const nodeMap = useMemo(() => {
    return new Map(graph?.nodes.map((n) => [n.id, n]) ?? []);
  }, [graph?.nodes]);

  const projectMap = useMemo(() => {
    const map = new Map<Uuid, Project>();
    for (const p of extraProjects) {
      map.set(p.id, p);
    }
    for (const stat of graph?.projects ?? []) {
      map.set(stat.project.id, stat.project);
    }
    return map;
  }, [extraProjects, graph?.projects]);

  const visibleConflicts = useMemo(
    () =>
      conflicts.filter(
        (pair) => !dismissedConflictKeys.has(conflictPairKey(pair.a.id, pair.b.id)),
      ),
    [conflicts, dismissedConflictKeys],
  );

  const hiddenDismissedCount = conflicts.length - visibleConflicts.length;

  const scan = useCallback(async () => {
    const seq = ++scanSeqRef.current;
    if (conflictYieldTimerRef.current !== null) {
      window.clearTimeout(conflictYieldTimerRef.current);
      conflictYieldTimerRef.current = null;
    }

    setLoadingDuplicates(true);
    setLoadingConflicts(true);
    setHoveredHighlightIds(null);
    setError(null);

    // Stage 1: run duplicate scan first so we never run two heavy O(N^2) backend scans in parallel
    try {
      const dupClusters = await backendCall("find_duplicates");
      if (!mountedRef.current || scanSeqRef.current !== seq) return;
      setClusters(dupClusters);
      const defaults: Record<number, Uuid> = {};
      dupClusters.forEach((c, idx) => {
        defaults[idx] = c.suggested_keep_id;
      });
      setKeepChoices(defaults);
    } catch (err: unknown) {
      if (!mountedRef.current || scanSeqRef.current !== seq) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current && scanSeqRef.current === seq) {
        setLoadingDuplicates(false);
      }
    }

    if (!mountedRef.current || scanSeqRef.current !== seq) return;

    // Brief yield so UI & 3D frame loop stay responsive between the two heavy backend scans
    await new Promise<void>((resolve) => {
      conflictYieldTimerRef.current = window.setTimeout(() => {
        conflictYieldTimerRef.current = null;
        resolve();
      }, CONFLICTS_YIELD_MS);
    });
    if (!mountedRef.current || scanSeqRef.current !== seq) return;

    // Stage 2: run contradiction scan sequentially after duplicates finish
    try {
      const conflictPairs = await backendCall("find_conflicts");
      if (!mountedRef.current || scanSeqRef.current !== seq) return;
      setConflicts(conflictPairs);
    } catch (err: unknown) {
      if (!mountedRef.current || scanSeqRef.current !== seq) return;
      if (isUnsupportedError(err)) {
        setConflicts([]);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (mountedRef.current && scanSeqRef.current === seq) {
        setLoadingConflicts(false);
      }
    }

    if (!mountedRef.current || scanSeqRef.current !== seq) return;

    // Only load archived projects if we don't already have them populated
    void backendCall("list_projects", { include_archived: true })
      .then((list) => {
        if (!mountedRef.current || scanSeqRef.current !== seq) return;
        setExtraProjects(list.map((s) => s.project));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    // Defer heavy IPC by one animation frame so the drawer and loading skeleton paint smoothly first
    const rafId = window.requestAnimationFrame(() => {
      void scan();
    });
    return () => {
      mountedRef.current = false;
      window.cancelAnimationFrame(rafId);
      if (conflictYieldTimerRef.current !== null) {
        window.clearTimeout(conflictYieldTimerRef.current);
        conflictYieldTimerRef.current = null;
      }
      setHighlightedNodeIds([]);
    };
  }, [scan, setHighlightedNodeIds]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        mergingIdx === null &&
        resolvingPairKey === null
      ) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mergingIdx, onClose, resolvingPairKey]);

  useEffect(() => {
    if (activeTabLoading) {
      setHighlightedNodeIds([]);
      return;
    }
    if (hoveredHighlightIds && hoveredHighlightIds.length > 0) {
      setHighlightedNodeIds(hoveredHighlightIds);
      return;
    }
    const passive: Uuid[] = [];
    if (activeTab === "duplicates") {
      for (const c of clusters) {
        for (const id of c.memory_ids) {
          passive.push(id);
          if (passive.length >= MAX_PASSIVE_HIGHLIGHT_NODES) break;
        }
        if (passive.length >= MAX_PASSIVE_HIGHLIGHT_NODES) break;
      }
    } else {
      for (const p of visibleConflicts) {
        passive.push(p.a.id, p.b.id);
        if (passive.length >= MAX_PASSIVE_HIGHLIGHT_NODES) break;
      }
    }
    setHighlightedNodeIds(passive);
  }, [
    activeTab,
    activeTabLoading,
    clusters,
    hoveredHighlightIds,
    setHighlightedNodeIds,
    visibleConflicts,
  ]);

  const handleMergeCluster = async (clusterIdx: number) => {
    if (readOnly) return;
    const cluster = clusters[clusterIdx];
    if (!cluster) return;

    const keepId = keepChoices[clusterIdx] ?? cluster.suggested_keep_id;
    const mergeIds = cluster.memory_ids.filter((id) => id !== keepId);
    if (mergeIds.length === 0) return;

    setMergingIdx(clusterIdx);
    setError(null);
    try {
      await backendCall("merge_duplicates", { keep_id: keepId, merge_ids: mergeIds });
      setMergedCount((c) => c + 1);
      await loadGraph();
      await scan();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMergingIdx(null);
    }
  };

  const handleKeepOne = async (pair: ConflictPair, keep: "a" | "b") => {
    if (readOnly) return;
    const key = conflictPairKey(pair.a.id, pair.b.id);
    const archiveId = keep === "a" ? pair.b.id : pair.a.id;

    setResolvingPairKey(key);
    setError(null);
    try {
      await backendCall("archive_memories", { ids: [archiveId] });
      setResolvedConflictsCount((c) => c + 1);
      setConflicts((prev) =>
        prev.filter((item) => item.a.id !== archiveId && item.b.id !== archiveId),
      );
      await loadGraph();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResolvingPairKey(null);
    }
  };

  const handleMarkBothCorrect = (pair: ConflictPair) => {
    const key = conflictPairKey(pair.a.id, pair.b.id);
    setDismissedConflictKeys((prev) => {
      const next = new Set(prev);
      next.add(key);
      saveDismissedConflictKeys(next);
      return next;
    });
  };

  const handleRestoreDismissed = () => {
    const empty = new Set<string>();
    setDismissedConflictKeys(empty);
    saveDismissedConflictKeys(empty);
  };

  const renderConflictSide = (mem: Memory, sideLabel: "A" | "B") => {
    const project = mem.project_id ? (projectMap.get(mem.project_id) ?? null) : null;
    return (
      <button
        type="button"
        onClick={() => onInspectMemory(mem.id)}
        className="flex h-full flex-col justify-between gap-2 rounded-[2px] border border-rule bg-surface p-2.5 text-left transition-colors hover:border-cobalt-ink/60 hover:bg-surface-2 focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none"
      >
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-1.5 font-mono text-[10px]">
            <span className="rounded-[2px] border border-cobalt-rule bg-cobalt-wash px-1.5 py-0.5 font-semibold text-cobalt-ink">
              {sideLabel}
            </span>
            <span className="inline-flex max-w-[10rem] items-center gap-1 rounded-[2px] border border-rule bg-void px-1.5 py-0.5 text-bone-muted">
              {project ? (
                <>
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-[1px]"
                    style={{ backgroundColor: resolveProjectColor(project) }}
                    aria-hidden
                  />
                  <span className="truncate text-bone" title={project.name}>
                    {project.name}
                  </span>
                </>
              ) : (
                <span className="truncate">{t("brain.globalScope")}</span>
              )}
            </span>
          </div>

          <p className="line-clamp-5 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-bone">
            {mem.content}
          </p>
        </div>

        <div className="border-t border-rule pt-1.5 font-mono text-[10px] tabular-nums text-bone-subtle">
          {formatMemoryDate(mem.updated_at || mem.created_at)}
        </div>
      </button>
    );
  };

  return (
    <aside
      className={`cobalt-drawer-enter-right flex h-full w-full flex-col border-l border-rule-strong bg-surface text-bone shadow-[-12px_0_32px_rgba(0,0,0,0.65)] ${
        activeTab === "contradictions" ? "max-w-[600px]" : "max-w-[440px]"
      }`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-rule px-4 py-3">
        <div>
          <div className="inline-flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-cobalt-ink">
            <Sparkles size={11} aria-hidden />
            {t("cleanBrain.title")}
          </div>
          <p className="mt-0.5 text-[11px] text-bone-muted">{t("cleanBrain.subtitle")}</p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={loading}
            onClick={() => void scan()}
            title={t("cleanBrain.rescan")}
            className="rounded-[2px] p-1.5 text-bone-muted hover:bg-surface-2 hover:text-bone disabled:opacity-45"
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} aria-hidden />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="rounded-[2px] p-1.5 text-bone-muted hover:bg-surface-2 hover:text-bone"
          >
            <X size={14} aria-hidden />
          </button>
        </div>
      </div>

      {/* Tabs: Duplicates / Contradictions */}
      <div
        role="tablist"
        aria-label={t("cleanBrain.tabsAria")}
        className="grid grid-cols-2 border-b border-rule bg-surface-2/60 p-1"
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "duplicates"}
          onClick={() => setActiveTab("duplicates")}
          className={`inline-flex items-center justify-center gap-1.5 rounded-[2px] px-2 py-1.5 text-xs font-medium transition-colors focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none ${
            activeTab === "duplicates"
              ? "bg-surface text-bone shadow-[inset_0_0_0_1px_var(--color-rule-strong)]"
              : "text-bone-muted hover:text-bone"
          }`}
        >
          <span>{t("cleanBrain.tabs.duplicates")}</span>
          {clusters.length > 0 && (
            <span className="rounded-[2px] bg-cobalt-wash px-1.5 py-0.5 font-mono text-[9px] leading-none font-semibold tabular-nums text-cobalt-ink">
              {clusters.length}
            </span>
          )}
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "contradictions"}
          onClick={() => setActiveTab("contradictions")}
          className={`inline-flex items-center justify-center gap-1.5 rounded-[2px] px-2 py-1.5 text-xs font-medium transition-colors focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none ${
            activeTab === "contradictions"
              ? "bg-surface text-bone shadow-[inset_0_0_0_1px_var(--color-rule-strong)]"
              : "text-bone-muted hover:text-bone"
          }`}
        >
          <span>{t("cleanBrain.tabs.contradictions")}</span>
          {visibleConflicts.length > 0 && (
            <span className="rounded-[2px] bg-ochre-wash px-1.5 py-0.5 font-mono text-[9px] leading-none font-semibold tabular-nums text-ochre">
              {visibleConflicts.length}
            </span>
          )}
        </button>
      </div>

      {error && (
        <div className="border-b border-cinnabar-rule bg-cinnabar-wash px-4 py-2 text-xs text-cinnabar">
          {error}
        </div>
      )}

      {activeTab === "duplicates" && mergedCount > 0 && (
        <div className="flex items-center gap-1.5 border-b border-verdigris-rule bg-verdigris-wash px-4 py-2 font-mono text-[11px] text-verdigris">
          <Check size={12} aria-hidden />
          <span>{t("cleanBrain.mergedNotice", { count: mergedCount })}</span>
        </div>
      )}

      {activeTab === "contradictions" && resolvedConflictsCount > 0 && (
        <div className="flex items-center gap-1.5 border-b border-verdigris-rule bg-verdigris-wash px-4 py-2 font-mono text-[11px] text-verdigris">
          <Check size={12} aria-hidden />
          <span>{t("cleanBrain.contradictionsResolvedNotice", { count: resolvedConflictsCount })}</span>
        </div>
      )}

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {activeTabLoading ? (
          <div className="space-y-3" aria-busy="true" aria-label={t("cleanBrain.scanning")}>
            {[0, 1, 2].map((idx) => (
              <div
                key={idx}
                className="space-y-2.5 rounded-[2px] border border-rule bg-void p-3"
              >
                <div className="flex items-center justify-between">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-3.5 w-16" />
                </div>
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ))}
          </div>
        ) : activeTab === "duplicates" ? (
          clusters.length === 0 ? (
            <div className="rounded-[2px] border border-rule bg-void p-6 text-center">
              <p className="font-mono text-xs font-medium text-verdigris">
                {t("cleanBrain.cleanTitle")}
              </p>
              <p className="mt-1 text-xs text-bone-muted">{t("cleanBrain.cleanDesc")}</p>
            </div>
          ) : (
            clusters.map((cluster, idx) => {
              const keepId = keepChoices[idx] ?? cluster.suggested_keep_id;
              const isConflict = cluster.kind === "conflict";
              return (
                <div
                  key={`${cluster.suggested_keep_id}-${idx}`}
                  style={idx < 8 ? staggerStyle(idx, 24, 8) : undefined}
                  onMouseEnter={() => setHoveredHighlightIds(cluster.memory_ids)}
                  onMouseLeave={() => setHoveredHighlightIds(null)}
                  className={`${idx < 8 ? "cobalt-stagger-item " : ""}space-y-2.5 rounded-[2px] border border-rule bg-void p-3`}
                >
                  <div className="flex items-center justify-between gap-2 font-mono text-[10px]">
                    <span
                      className={`inline-flex items-center gap-1 rounded-[2px] border px-1.5 py-0.5 uppercase ${
                        isConflict
                          ? "border-ochre-rule bg-ochre-wash text-ochre"
                          : "border-cobalt-rule bg-cobalt-wash text-cobalt-ink"
                      }`}
                    >
                      {isConflict && <AlertTriangle size={10} aria-hidden />}
                      {t(`cleanBrain.kind.${cluster.kind}`)}
                    </span>
                    <span className="tabular-nums text-bone-muted">
                      {t("cleanBrain.similarity", {
                        value: Math.round(cluster.max_similarity * 100),
                      })}
                    </span>
                  </div>

                  <div className="space-y-1.5">
                    {cluster.memory_ids.map((id) => {
                      const node = nodeMap.get(id);
                      const isKeep = keepId === id;
                      return (
                        <div
                          key={id}
                          className={`flex items-start gap-2 rounded-[2px] border p-2 transition-colors ${
                            isKeep
                              ? "border-cobalt-rule bg-cobalt-wash/60"
                              : "border-rule bg-surface"
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() =>
                              setKeepChoices((prev) => ({
                                ...prev,
                                [idx]: id,
                              }))
                            }
                            aria-pressed={isKeep}
                            className={`mt-0.5 shrink-0 rounded-[2px] border px-1.5 py-0.5 font-mono text-[9px] uppercase ${
                              isKeep
                                ? "border-cobalt bg-cobalt text-bone"
                                : "border-rule-strong bg-surface-2 text-bone-subtle hover:text-bone"
                            }`}
                          >
                            {isKeep ? t("cleanBrain.keepBadge") : t("cleanBrain.selectKeep")}
                          </button>
                          <button
                            type="button"
                            onClick={() => onInspectMemory(id)}
                            className="min-w-0 flex-1 text-left"
                          >
                            <p className="line-clamp-2 text-[11px] leading-relaxed text-bone">
                              {node ? node.preview : id}
                            </p>
                            {node && (
                              <div className="mt-1 font-mono text-[10px] tabular-nums text-bone-subtle">
                                {t("brain.hits", { count: node.hit_count })} ·{" "}
                                {t("brain.tokens", { count: node.chunk_tokens })}
                              </div>
                            )}
                          </button>
                        </div>
                      );
                    })}
                  </div>

                  <div className="flex items-center justify-end">
                    <button
                      type="button"
                      disabled={readOnly || mergingIdx === idx}
                      onClick={() => void handleMergeCluster(idx)}
                      className="inline-flex items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-3 py-1 font-mono text-[10px] font-semibold text-bone hover:bg-cobalt-bright disabled:opacity-45"
                    >
                      {mergingIdx === idx ? (
                        <Loader2 size={11} className="animate-spin" aria-hidden />
                      ) : (
                        <GitMerge size={11} aria-hidden />
                      )}
                      {t("cleanBrain.mergeCluster", { count: cluster.memory_ids.length - 1 })}
                    </button>
                  </div>
                </div>
              );
            })
          )
        ) : visibleConflicts.length === 0 ? (
          <div className="rounded-[2px] border border-rule bg-void p-6 text-center">
            <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-[2px] border border-verdigris-rule bg-verdigris-wash text-verdigris">
              <CheckCircle2 size={18} aria-hidden />
            </div>
            <p className="mt-3 font-mono text-xs font-medium text-verdigris">
              {t("cleanBrain.contradictionsEmptyTitle")}
            </p>
            <p className="mt-1 text-xs text-bone-muted">
              {t("cleanBrain.contradictionsEmptyDesc")}
            </p>
            {hiddenDismissedCount > 0 && (
              <button
                type="button"
                onClick={handleRestoreDismissed}
                className="mt-3 font-mono text-[11px] text-cobalt-ink hover:underline"
              >
                {t("cleanBrain.showDismissedConflicts", { count: hiddenDismissedCount })}
              </button>
            )}
          </div>
        ) : (
          visibleConflicts.map((pair, idx) => {
            const pairKey = conflictPairKey(pair.a.id, pair.b.id);
            const isBusy = resolvingPairKey === pairKey;
            const reasonKey = conflictReasonI18nKey(pair.reason);
            const reasonLabel = reasonKey ? t(reasonKey) : pair.reason;

            return (
              <div
                key={pairKey}
                style={idx < 8 ? staggerStyle(idx, 24, 8) : undefined}
                onMouseEnter={() => setHoveredHighlightIds([pair.a.id, pair.b.id])}
                onMouseLeave={() => setHoveredHighlightIds(null)}
                className={`${idx < 8 ? "cobalt-stagger-item " : ""}space-y-2.5 rounded-[2px] border border-ochre-rule/70 bg-void p-3`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[10px]">
                  <span className="inline-flex items-center gap-1.5 rounded-[2px] border border-ochre-rule bg-ochre-wash px-2 py-0.5 font-medium text-ochre">
                    <Scale size={11} className="shrink-0" aria-hidden />
                    <span>{reasonLabel}</span>
                  </span>
                  <span className="tabular-nums text-bone-subtle">
                    {t("cleanBrain.similarity", {
                      value: Math.round(pair.similarity * 100),
                    })}
                  </span>
                </div>

                {/* Side by side A and B */}
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {renderConflictSide(pair.a, "A")}
                  {renderConflictSide(pair.b, "B")}
                </div>

                {/* Resolution actions */}
                <div className="flex flex-wrap items-center justify-end gap-1.5 border-t border-rule pt-2.5">
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => handleMarkBothCorrect(pair)}
                    className="inline-flex items-center gap-1 rounded-[2px] border border-rule-strong bg-surface px-2.5 py-1 font-mono text-[10px] text-bone-muted transition-colors hover:border-cobalt-ink/60 hover:text-bone disabled:opacity-45"
                  >
                    {t("cleanBrain.bothCorrect")}
                  </button>
                  <button
                    type="button"
                    disabled={readOnly || isBusy}
                    onClick={() => void handleKeepOne(pair, "a")}
                    className="inline-flex items-center gap-1 rounded-[2px] border border-cobalt-rule bg-cobalt-wash px-2.5 py-1 font-mono text-[10px] font-semibold text-cobalt-ink transition-colors hover:bg-cobalt hover:text-on-accent disabled:opacity-45"
                  >
                    {isBusy && <Loader2 size={10} className="animate-spin" aria-hidden />}
                    {t("cleanBrain.keepA")}
                  </button>
                  <button
                    type="button"
                    disabled={readOnly || isBusy}
                    onClick={() => void handleKeepOne(pair, "b")}
                    className="inline-flex items-center gap-1 rounded-[2px] border border-cobalt-rule bg-cobalt-wash px-2.5 py-1 font-mono text-[10px] font-semibold text-cobalt-ink transition-colors hover:bg-cobalt hover:text-on-accent disabled:opacity-45"
                  >
                    {isBusy && <Loader2 size={10} className="animate-spin" aria-hidden />}
                    {t("cleanBrain.keepB")}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
