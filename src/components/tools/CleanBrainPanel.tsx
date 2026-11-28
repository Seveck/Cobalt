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
import { toDisplayError, type DisplayError } from "@/lib/friendlyError";
import { isUnsupportedError } from "@/lib/ipc";
import { staggerStyle } from "@/lib/motion";
import { resolveProjectColor } from "@/lib/projects";
import { conflictReasonI18nKey } from "@/lib/savings";
import { useBranchesStore, useMemoryStore, useSettingsStore } from "@/stores";
import { ErrorAlert, Skeleton } from "@/components/ui";
import type { ConflictPair, DuplicateCluster, Memory, Project, Uuid } from "@/types/contracts";

type CleanTab = "duplicates" | "contradictions";

const DISMISSED_CONFLICTS_STORAGE_KEY = "cobalt.dismissedConflictPairs";
/** Cap passive 3D highlights so large scan results never cause GPU sprite overdraw lag. */
const MAX_PASSIVE_HIGHLIGHT_NODES = 18;
const CACHE_TTL_MS = 5 * 60 * 1000;
const SKELETON_DELAY_MS = 250;
const EXTERNAL_CHANGE_DEBOUNCE_MS = 220;

interface CachedTabData<T> {
  data: T;
  fetchedAt: number;
  branchId: Uuid;
  memoryVersion: number;
}

interface CleanBrainCache {
  duplicates: CachedTabData<DuplicateCluster[]> | null;
  conflicts: CachedTabData<ConflictPair[]> | null;
  extraProjects: Project[] | null;
}

const cleanBrainCache: CleanBrainCache = {
  duplicates: null,
  conflicts: null,
  extraProjects: null,
};

function isCacheEntryValid<T>(
  entry: CachedTabData<T> | null,
  branchId: Uuid,
  memoryVersion: number,
  now = Date.now(),
): entry is CachedTabData<T> {
  if (!entry) return false;
  if (entry.branchId !== branchId) return false;
  if (entry.memoryVersion !== memoryVersion) return false;
  return now - entry.fetchedAt < CACHE_TTL_MS;
}

function buildKeepChoices(clusters: readonly DuplicateCluster[]): Record<number, Uuid> {
  const defaults: Record<number, Uuid> = {};
  clusters.forEach((c, idx) => {
    defaults[idx] = c.suggested_keep_id;
  });
  return defaults;
}

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
  const memoryChangeVersion = useMemoryStore((s) => s.memoryChangeVersion);
  const lastMemoryChange = useMemoryStore((s) => s.lastMemoryChange);
  const activeBranchId = useBranchesStore((s) => s.activeBranchId);
  const readOnly = useSettingsStore((s) => s.settings.read_only);

  const currentBranchId = graph?.branch.id ?? activeBranchId;

  const initialCacheSnapshot = useMemo(() => {
    const initialVersion = useMemoryStore.getState().memoryChangeVersion;
    const duplicatesEntry = isCacheEntryValid(
      cleanBrainCache.duplicates,
      currentBranchId,
      initialVersion,
    )
      ? cleanBrainCache.duplicates
      : null;
    const conflictsEntry = isCacheEntryValid(
      cleanBrainCache.conflicts,
      currentBranchId,
      initialVersion,
    )
      ? cleanBrainCache.conflicts
      : null;
    return { duplicatesEntry, conflictsEntry };
    // Intentionally evaluated once on mount to hydrate synchronously from cache.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [activeTab, setActiveTab] = useState<CleanTab>("duplicates");
  const [clusters, setClusters] = useState<DuplicateCluster[]>(
    () => initialCacheSnapshot.duplicatesEntry?.data ?? [],
  );
  const [conflicts, setConflicts] = useState<ConflictPair[]>(
    () => initialCacheSnapshot.conflictsEntry?.data ?? [],
  );
  const [duplicatesLoaded, setDuplicatesLoaded] = useState<boolean>(
    () => initialCacheSnapshot.duplicatesEntry !== null,
  );
  const [conflictsLoaded, setConflictsLoaded] = useState<boolean>(
    () => initialCacheSnapshot.conflictsEntry !== null,
  );
  const [dismissedConflictKeys, setDismissedConflictKeys] = useState<ReadonlySet<string>>(() =>
    loadDismissedConflictKeys(),
  );
  const [keepChoices, setKeepChoices] = useState<Record<number, Uuid>>(() =>
    initialCacheSnapshot.duplicatesEntry
      ? buildKeepChoices(initialCacheSnapshot.duplicatesEntry.data)
      : {},
  );
  const [extraProjects, setExtraProjects] = useState<Project[]>(
    () => cleanBrainCache.extraProjects ?? [],
  );
  const [loadingDuplicates, setLoadingDuplicates] = useState<boolean>(
    () => initialCacheSnapshot.duplicatesEntry === null,
  );
  const [loadingConflicts, setLoadingConflicts] = useState<boolean>(false);
  const [showSkeleton, setShowSkeleton] = useState<boolean>(false);
  const [hoveredHighlightIds, setHoveredHighlightIds] = useState<readonly Uuid[] | null>(null);
  const [mergingIdx, setMergingIdx] = useState<number | null>(null);
  const [resolvingPairKey, setResolvingPairKey] = useState<string | null>(null);
  const [errorByTab, setErrorByTab] = useState<Record<CleanTab, DisplayError | null>>({
    duplicates: null,
    contradictions: null,
  });
  const [mergedCount, setMergedCount] = useState(0);
  const [resolvedConflictsCount, setResolvedConflictsCount] = useState(0);

  const duplicatesSeqRef = useRef(0);
  const conflictsSeqRef = useRef(0);
  const mountedRef = useRef(true);
  const activeTabRef = useRef<CleanTab>(activeTab);
  activeTabRef.current = activeTab;
  const loadingStartedAtRef = useRef<Record<CleanTab, number | null>>({
    duplicates: initialCacheSnapshot.duplicatesEntry === null ? Date.now() : null,
    contradictions: null,
  });
  const seenMemoryVersionRef = useRef(memoryChangeVersion);
  const externalReloadTimerRef = useRef<number | null>(null);
  const selfArchivedIdsRef = useRef<Set<Uuid>>(new Set());
  const selfMergedIdsRef = useRef<Set<Uuid>>(new Set());
  const selfMutatingRef = useRef(false);

  const activeTabLoading =
    activeTab === "duplicates" ? loadingDuplicates : loadingConflicts;
  const activeTabLoaded =
    activeTab === "duplicates" ? duplicatesLoaded : conflictsLoaded;
  const activeError = errorByTab[activeTab];

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

  const loadTab = useCallback(
    async (tab: CleanTab, options?: { force?: boolean }) => {
      const latestVersion = useMemoryStore.getState().memoryChangeVersion;

      if (tab === "duplicates") {
        if (
          !options?.force &&
          isCacheEntryValid(cleanBrainCache.duplicates, currentBranchId, latestVersion)
        ) {
          const cached = cleanBrainCache.duplicates.data;
          setClusters(cached);
          setKeepChoices(buildKeepChoices(cached));
          setDuplicatesLoaded(true);
          setLoadingDuplicates(false);
          loadingStartedAtRef.current.duplicates = null;
          setErrorByTab((prev) => (prev.duplicates ? { ...prev, duplicates: null } : prev));
          return;
        }

        const seq = ++duplicatesSeqRef.current;
        if (loadingStartedAtRef.current.duplicates === null || options?.force) {
          loadingStartedAtRef.current.duplicates = Date.now();
        }
        setLoadingDuplicates(true);
        setHoveredHighlightIds(null);
        setErrorByTab((prev) => (prev.duplicates ? { ...prev, duplicates: null } : prev));

        try {
          const dupClusters = await backendCall("find_duplicates");
          if (duplicatesSeqRef.current !== seq) return;
          cleanBrainCache.duplicates = {
            data: dupClusters,
            fetchedAt: Date.now(),
            branchId: currentBranchId,
            memoryVersion: latestVersion,
          };
          if (!mountedRef.current) return;
          setClusters(dupClusters);
          setKeepChoices(buildKeepChoices(dupClusters));
          setDuplicatesLoaded(true);
        } catch (err: unknown) {
          if (!mountedRef.current || duplicatesSeqRef.current !== seq) return;
          setErrorByTab((prev) => ({
            ...prev,
            duplicates: toDisplayError(err, t, "find_duplicates"),
          }));
        } finally {
          if (mountedRef.current && duplicatesSeqRef.current === seq) {
            loadingStartedAtRef.current.duplicates = null;
            setLoadingDuplicates(false);
          }
        }
        return;
      }

      if (
        !options?.force &&
        isCacheEntryValid(cleanBrainCache.conflicts, currentBranchId, latestVersion)
      ) {
        const cached = cleanBrainCache.conflicts.data;
        setConflicts(cached);
        setConflictsLoaded(true);
        setLoadingConflicts(false);
        loadingStartedAtRef.current.contradictions = null;
        setErrorByTab((prev) => (prev.contradictions ? { ...prev, contradictions: null } : prev));
        return;
      }

      const seq = ++conflictsSeqRef.current;
      if (loadingStartedAtRef.current.contradictions === null || options?.force) {
        loadingStartedAtRef.current.contradictions = Date.now();
      }
      setLoadingConflicts(true);
      setHoveredHighlightIds(null);
      setErrorByTab((prev) => (prev.contradictions ? { ...prev, contradictions: null } : prev));

      try {
        const conflictPairs = await backendCall("find_conflicts");
        if (conflictsSeqRef.current !== seq) return;
        cleanBrainCache.conflicts = {
          data: conflictPairs,
          fetchedAt: Date.now(),
          branchId: currentBranchId,
          memoryVersion: latestVersion,
        };
        if (!mountedRef.current) return;
        setConflicts(conflictPairs);
        setConflictsLoaded(true);
      } catch (err: unknown) {
        if (!mountedRef.current || conflictsSeqRef.current !== seq) return;
        if (isUnsupportedError(err)) {
          cleanBrainCache.conflicts = {
            data: [],
            fetchedAt: Date.now(),
            branchId: currentBranchId,
            memoryVersion: latestVersion,
          };
          setConflicts([]);
          setConflictsLoaded(true);
        } else {
          setErrorByTab((prev) => ({
            ...prev,
            contradictions: toDisplayError(err, t, "find_conflicts"),
          }));
        }
      } finally {
        if (mountedRef.current && conflictsSeqRef.current === seq) {
          loadingStartedAtRef.current.contradictions = null;
          setLoadingConflicts(false);
        }
      }

      if (!mountedRef.current || conflictsSeqRef.current !== seq) return;

      if (!cleanBrainCache.extraProjects || options?.force) {
        void backendCall("list_projects", { include_archived: true })
          .then((list) => {
            const projects = list.map((s) => s.project);
            cleanBrainCache.extraProjects = projects;
            if (!mountedRef.current) return;
            setExtraProjects(projects);
          })
          .catch(() => {});
      }
    },
    [currentBranchId, t],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (externalReloadTimerRef.current !== null) {
        window.clearTimeout(externalReloadTimerRef.current);
        externalReloadTimerRef.current = null;
      }
      setHighlightedNodeIds([]);
    };
  }, [setHighlightedNodeIds]);

  // Load ONLY the active tab when opened, switched, or when the active branch changes.
  useEffect(() => {
    if (externalReloadTimerRef.current !== null) {
      window.clearTimeout(externalReloadTimerRef.current);
      externalReloadTimerRef.current = null;
    }

    const latestVersion = useMemoryStore.getState().memoryChangeVersion;

    if (activeTab === "duplicates") {
      if (isCacheEntryValid(cleanBrainCache.duplicates, currentBranchId, latestVersion)) {
        const cached = cleanBrainCache.duplicates.data;
        setClusters(cached);
        setKeepChoices(buildKeepChoices(cached));
        setDuplicatesLoaded(true);
        setLoadingDuplicates(false);
        loadingStartedAtRef.current.duplicates = null;
        return;
      }
      if (loadingStartedAtRef.current.duplicates === null) {
        loadingStartedAtRef.current.duplicates = Date.now();
      }
      setLoadingDuplicates(true);
    } else {
      if (isCacheEntryValid(cleanBrainCache.conflicts, currentBranchId, latestVersion)) {
        setConflicts(cleanBrainCache.conflicts.data);
        setConflictsLoaded(true);
        setLoadingConflicts(false);
        loadingStartedAtRef.current.contradictions = null;
        return;
      }
      if (loadingStartedAtRef.current.contradictions === null) {
        loadingStartedAtRef.current.contradictions = Date.now();
      }
      setLoadingConflicts(true);
    }

    // Defer heavy IPC by one animation frame so the drawer/tab switch paints smoothly first.
    const rafId = window.requestAnimationFrame(() => {
      if (!mountedRef.current) return;
      void loadTab(activeTab);
    });
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [activeTab, currentBranchId, loadTab]);

  // Invalidate cache when `cobalt://memory-changed` arrives while the panel is open.
  useEffect(() => {
    if (memoryChangeVersion === seenMemoryVersionRef.current) return;
    seenMemoryVersionRef.current = memoryChangeVersion;

    if (
      lastMemoryChange &&
      lastMemoryChange.kind === "archived" &&
      lastMemoryChange.memory_ids.length > 0 &&
      lastMemoryChange.memory_ids.every((id) => selfArchivedIdsRef.current.has(id))
    ) {
      for (const id of lastMemoryChange.memory_ids) {
        selfArchivedIdsRef.current.delete(id);
      }
      cleanBrainCache.duplicates = null;
      setClusters([]);
      setDuplicatesLoaded(false);
      if (cleanBrainCache.conflicts) {
        cleanBrainCache.conflicts = {
          ...cleanBrainCache.conflicts,
          memoryVersion: memoryChangeVersion,
        };
      }
      return;
    }

    if (
      selfMutatingRef.current ||
      (lastMemoryChange &&
        lastMemoryChange.memory_ids.length > 0 &&
        lastMemoryChange.memory_ids.every((id) => selfMergedIdsRef.current.has(id)))
    ) {
      if (lastMemoryChange) {
        for (const id of lastMemoryChange.memory_ids) {
          selfMergedIdsRef.current.delete(id);
        }
      }
      if (!selfMutatingRef.current && cleanBrainCache.duplicates) {
        cleanBrainCache.duplicates = {
          ...cleanBrainCache.duplicates,
          memoryVersion: memoryChangeVersion,
        };
      }
      return;
    }

    cleanBrainCache.duplicates = null;
    cleanBrainCache.conflicts = null;
    if (activeTabRef.current === "duplicates") {
      setConflicts([]);
      setConflictsLoaded(false);
    } else {
      setClusters([]);
      setDuplicatesLoaded(false);
    }

    if (externalReloadTimerRef.current !== null) {
      window.clearTimeout(externalReloadTimerRef.current);
    }
    externalReloadTimerRef.current = window.setTimeout(() => {
      externalReloadTimerRef.current = null;
      if (!mountedRef.current) return;
      void loadTab(activeTabRef.current, { force: true });
    }, EXTERNAL_CHANGE_DEBOUNCE_MS);
  }, [lastMemoryChange, loadTab, memoryChangeVersion]);

  // Show the loading skeleton only if the active tab takes > 250 ms.
  useEffect(() => {
    if (!activeTabLoading) {
      setShowSkeleton(false);
      return;
    }
    const startedAt = loadingStartedAtRef.current[activeTab] ?? Date.now();
    const remaining = SKELETON_DELAY_MS - (Date.now() - startedAt);
    if (remaining <= 0) {
      setShowSkeleton(true);
      return;
    }
    setShowSkeleton(false);
    const timer = window.setTimeout(() => {
      setShowSkeleton(true);
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [activeTab, activeTabLoading]);

  const handleRefresh = () => {
    if (externalReloadTimerRef.current !== null) {
      window.clearTimeout(externalReloadTimerRef.current);
      externalReloadTimerRef.current = null;
    }
    cleanBrainCache.duplicates = null;
    cleanBrainCache.conflicts = null;
    if (activeTab === "duplicates") {
      setConflicts([]);
      setConflictsLoaded(false);
    } else {
      setClusters([]);
      setDuplicatesLoaded(false);
    }
    void loadTab(activeTab, { force: true });
  };

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
    if (activeTabLoading || !activeTabLoaded) {
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
    activeTabLoaded,
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

    const involvedIds = [keepId, ...mergeIds];
    for (const id of involvedIds) {
      selfMergedIdsRef.current.add(id);
    }
    selfMutatingRef.current = true;
    setMergingIdx(clusterIdx);
    setErrorByTab((prev) => ({ ...prev, duplicates: null }));
    try {
      await backendCall("merge_duplicates", { keep_id: keepId, merge_ids: mergeIds });
      setMergedCount((c) => c + 1);
      cleanBrainCache.duplicates = null;
      cleanBrainCache.conflicts = null;
      setConflicts([]);
      setConflictsLoaded(false);
      await loadGraph();
      selfMutatingRef.current = false;
      await loadTab("duplicates", { force: true });
    } catch (err: unknown) {
      for (const id of involvedIds) {
        selfMergedIdsRef.current.delete(id);
      }
      setErrorByTab((prev) => ({
        ...prev,
        duplicates: toDisplayError(err, t, "merge_duplicates"),
      }));
    } finally {
      selfMutatingRef.current = false;
      setMergingIdx(null);
      window.setTimeout(() => {
        for (const id of involvedIds) {
          selfMergedIdsRef.current.delete(id);
        }
      }, 4000);
    }
  };

  const handleKeepOne = async (pair: ConflictPair, keep: "a" | "b") => {
    if (readOnly) return;
    const key = conflictPairKey(pair.a.id, pair.b.id);
    const archiveId = keep === "a" ? pair.b.id : pair.a.id;

    selfArchivedIdsRef.current.add(archiveId);
    setResolvingPairKey(key);
    setErrorByTab((prev) => ({ ...prev, contradictions: null }));
    try {
      await backendCall("archive_memories", { ids: [archiveId] });
      setResolvedConflictsCount((c) => c + 1);
      setConflicts((prev) => {
        const next = prev.filter((item) => item.a.id !== archiveId && item.b.id !== archiveId);
        cleanBrainCache.conflicts = {
          data: next,
          fetchedAt: cleanBrainCache.conflicts?.fetchedAt ?? Date.now(),
          branchId: currentBranchId,
          memoryVersion: useMemoryStore.getState().memoryChangeVersion,
        };
        return next;
      });
      cleanBrainCache.duplicates = null;
      setClusters([]);
      setDuplicatesLoaded(false);
      await loadGraph();
    } catch (err: unknown) {
      selfArchivedIdsRef.current.delete(archiveId);
      setErrorByTab((prev) => ({
        ...prev,
        contradictions: toDisplayError(err, t, "archive_memories"),
      }));
    } finally {
      setResolvingPairKey(null);
      window.setTimeout(() => {
        selfArchivedIdsRef.current.delete(archiveId);
      }, 4000);
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
            disabled={activeTabLoading}
            onClick={handleRefresh}
            title={t("cleanBrain.rescan")}
            className="rounded-[2px] p-1.5 text-bone-muted hover:bg-surface-2 hover:text-bone disabled:opacity-45"
          >
            <RefreshCw size={13} className={activeTabLoading ? "animate-spin" : ""} aria-hidden />
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

      {activeError && (
        <div className="border-b border-cinnabar-rule">
          <ErrorAlert error={activeError} compact className="rounded-none border-0" />
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
        {activeTabLoading && showSkeleton ? (
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
        ) : !activeTabLoaded ? null : activeTab === "duplicates" ? (
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
