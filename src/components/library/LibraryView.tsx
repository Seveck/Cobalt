import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Check,
  Code2,
  Compass,
  Copy,
  FileCheck2,
  FilePlus2,
  FolderSync,
  Loader2,
  RefreshCw,
  Repeat,
  RotateCcw,
  ScanText,
  Search,
  ShieldAlert,
  Trash2,
  Upload,
} from "lucide-react";
import { backendCall } from "@/lib/backend";
import { copyToClipboard, pickSinglePath, useFileDrop } from "@/lib/dialogs";
import { isOcrNotInstalledMessage } from "@/lib/ingest";
import {
  useFiltersStore,
  useLibraryStore,
  useMemoryStore,
  useSettingsStore,
  useUiStore,
} from "@/stores";
import { Select, type SelectOption } from "@/components/ui";
import {
  SOURCE_TYPES,
  type FileAvailability,
  type MemoryCategory,
  type ProjectStats,
  type ReusableAsset,
  type SourceType,
  type Uuid,
} from "@/types/contracts";

const AVAILABILITY_OPTIONS: readonly FileAvailability[] = [
  "available",
  "modified",
  "snippet_only",
  "missing",
];

function availabilityClass(status: FileAvailability): string {
  switch (status) {
    case "available":
      return "border-verdigris-rule bg-verdigris-wash text-verdigris";
    case "modified":
      return "border-ochre-rule bg-ochre-wash text-ochre";
    case "missing":
      return "border-cinnabar-rule bg-cinnabar-wash text-cinnabar";
    default:
      return "border-cobalt-rule bg-cobalt-wash text-cobalt-ink";
  }
}

export function LibraryView() {
  const { t } = useTranslation();

  const assets = useLibraryStore((s) => s.assets);
  const filter = useLibraryStore((s) => s.filter);
  const loading = useLibraryStore((s) => s.loading);
  const storeError = useLibraryStore((s) => s.error);
  const loadLibrary = useLibraryStore((s) => s.loadLibrary);

  const readOnly = useSettingsStore((s) => s.settings.read_only);
  const graphNodes = useMemoryStore((s) => s.graph?.nodes);
  const setSelectedNodeId = useMemoryStore((s) => s.setSelectedNodeId);
  const loadGraph = useMemoryStore((s) => s.loadGraph);
  const resetVisualFilters = useFiltersStore((s) => s.resetFilters);
  const setActiveNav = useUiStore((s) => s.setActiveNav);
  const openSettingsSection = useUiStore((s) => s.openSettingsSection);

  const [projects, setProjects] = useState<ProjectStats[]>([]);
  const [searchInput, setSearchInput] = useState(filter.query ?? "");
  const [verifiedMap, setVerifiedMap] = useState<Record<string, FileAvailability>>({});
  const [fetchedCategories, setFetchedCategories] = useState<Record<string, MemoryCategory>>({});
  const [verifyingIds, setVerifyingIds] = useState<ReadonlySet<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Promote file to reusable state
  const [promoteProjectId, setPromoteProjectId] = useState<string>("__global__");
  const [promoteSummary, setPromoteSummary] = useState("");
  const [promoting, setPromoting] = useState(false);

  const flashNotice = useCallback((msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 3000);
  }, []);

  const flashCopied = useCallback((key: string) => {
    setCopiedKey(key);
    window.setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev));
    }, 1800);
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      const list = await backendCall("list_projects", { include_archived: false });
      setProjects(list);
    } catch {
      // Optional filter list
    }
  }, []);

  useEffect(() => {
    void loadProjects();
    void loadLibrary();
  }, [loadLibrary, loadProjects]);

  const verifyAssetOnDisk = useCallback(async (asset: ReusableAsset) => {
    if (!asset.source_doc_id) {
      setVerifiedMap((prev) => ({ ...prev, [asset.memory_id]: "snippet_only" }));
      return;
    }
    setVerifyingIds((prev) => new Set(prev).add(asset.memory_id));
    try {
      const status = await backendCall("verify_source_document", { id: asset.source_doc_id });
      setVerifiedMap((prev) => ({ ...prev, [asset.memory_id]: status }));
    } catch {
      // Keep backend-reported availability on error
    } finally {
      setVerifyingIds((prev) => {
        const next = new Set(prev);
        next.delete(asset.memory_id);
        return next;
      });
    }
  }, []);

  // Automatically verify disk status via `verify_source_document` for loaded assets
  useEffect(() => {
    const withDocs = assets.filter((a) => a.source_doc_id !== null);
    if (withDocs.length === 0) return;

    let cancelled = false;
    void Promise.all(
      withDocs.map(async (asset) => {
        if (!asset.source_doc_id) return null;
        try {
          const status = await backendCall("verify_source_document", { id: asset.source_doc_id });
          return [asset.memory_id, status] as const;
        } catch {
          return null;
        }
      }),
    ).then((pairs) => {
      if (cancelled) return;
      const updates: Record<string, FileAvailability> = {};
      for (const pair of pairs) {
        if (pair) {
          updates[pair[0]] = pair[1];
        }
      }
      if (Object.keys(updates).length > 0) {
        setVerifiedMap((prev) => ({ ...prev, ...updates }));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [assets]);

  const graphCategoryById = useMemo(() => {
    const map = new Map<Uuid, MemoryCategory>();
    for (const node of graphNodes ?? []) {
      map.set(node.id, node.category);
    }
    return map;
  }, [graphNodes]);

  // Fallback category lookup for any reusable asset not present in the current graph snapshot
  useEffect(() => {
    const missingIds = assets
      .map((a) => a.memory_id)
      .filter((id) => !graphCategoryById.has(id) && !(id in fetchedCategories));
    if (missingIds.length === 0) return;

    let cancelled = false;
    void Promise.all(
      missingIds.map(async (id) => {
        try {
          const mem = await backendCall("get_memory", { id });
          return [id, mem.category] as const;
        } catch {
          return null;
        }
      }),
    ).then((pairs) => {
      if (cancelled) return;
      const updates: Record<string, MemoryCategory> = {};
      for (const pair of pairs) {
        if (pair) {
          updates[pair[0]] = pair[1];
        }
      }
      if (Object.keys(updates).length > 0) {
        setFetchedCategories((prev) => ({ ...prev, ...updates }));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [assets, fetchedCategories, graphCategoryById]);

  const handlePromotePaths = useCallback(
    async (paths: string[]) => {
      if (readOnly || paths.length === 0) return;
      setPromoting(true);
      setError(null);
      try {
        const projectId = promoteProjectId === "__global__" ? null : promoteProjectId;
        const summary = promoteSummary.trim() || null;
        for (const path of paths) {
          await backendCall("promote_file_to_reusable", {
            path,
            project_id: projectId,
            summary: paths.length === 1 ? summary : null,
          });
        }
        setPromoteSummary("");
        await Promise.all([loadLibrary(), loadGraph()]);
        flashNotice(t("library.promotedNotice", { count: paths.length }));
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setPromoting(false);
      }
    },
    [flashNotice, loadGraph, loadLibrary, promoteProjectId, promoteSummary, readOnly, t],
  );

  const { isDragging } = useFileDrop((paths) => {
    void handlePromotePaths(paths);
  }, !readOnly);

  const handlePickAndPromote = async () => {
    if (readOnly) return;
    const selected = await pickSinglePath({
      title: t("library.promoteDialogTitle"),
    });
    if (selected) {
      await handlePromotePaths([selected]);
    }
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void loadLibrary({ query: searchInput.trim() || null, offset: 0 });
  };

  const toggleSourceType = (st: SourceType) => {
    const exists = filter.source_types.includes(st);
    const next = exists
      ? filter.source_types.filter((x) => x !== st)
      : [...filter.source_types, st];
    void loadLibrary({ source_types: next, offset: 0 });
  };

  const toggleProject = (projectId: Uuid) => {
    const exists = filter.project_ids.includes(projectId);
    const next = exists
      ? filter.project_ids.filter((x) => x !== projectId)
      : [...filter.project_ids, projectId];
    void loadLibrary({ project_ids: next, offset: 0 });
  };

  const toggleAvailability = (avail: FileAvailability) => {
    const exists = filter.availability.includes(avail);
    const next = exists
      ? filter.availability.filter((x) => x !== avail)
      : [...filter.availability, avail];
    void loadLibrary({ availability: next, offset: 0 });
  };

  const handleResetFilters = () => {
    setSearchInput("");
    void loadLibrary({
      query: null,
      source_types: [],
      project_ids: [],
      availability: [],
      offset: 0,
    });
  };

  const handleCopy = async (key: string, text: string) => {
    const ok = await copyToClipboard(text);
    if (ok) {
      flashCopied(key);
    }
  };

  const handleLocateIn3D = (memoryId: Uuid) => {
    resetVisualFilters();
    setSelectedNodeId(memoryId);
    setActiveNav("brain");
  };

  const handleRelink = async (asset: ReusableAsset) => {
    if (readOnly || !asset.source_doc_id) return;
    const newPath = await pickSinglePath({
      title: t("library.relinkDialogTitle"),
      defaultPath: asset.file_path ?? undefined,
    });
    if (!newPath) return;

    setBusyId(asset.memory_id);
    setError(null);
    try {
      await backendCall("relink_source_document", {
        source_doc_id: asset.source_doc_id,
        new_path: newPath,
      });
      await loadLibrary();
      const status = await backendCall("verify_source_document", { id: asset.source_doc_id });
      setVerifiedMap((prev) => ({ ...prev, [asset.memory_id]: status }));
      flashNotice(t("library.relinkedNotice"));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleRetire = async (asset: ReusableAsset) => {
    if (readOnly) return;
    setBusyId(asset.memory_id);
    setError(null);
    try {
      await backendCall("patch_memory", {
        id: asset.memory_id,
        patch: { is_reusable: false },
      });
      await Promise.all([loadLibrary(), loadGraph()]);
      flashNotice(t("library.retiredNotice"));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const projectOptions = useMemo<SelectOption<string>[]>(() => {
    return [
      { value: "__global__", label: t("brain.globalScope") },
      ...projects.map((p) => ({
        value: p.project.id,
        label: p.project.name,
      })),
    ];
  }, [projects, t]);

  const availableSourceTypes = useMemo(() => {
    const present = new Set<SourceType>(assets.map((a) => a.source_type));
    for (const s of filter.source_types) present.add(s);
    return SOURCE_TYPES.filter((st) => present.has(st));
  }, [assets, filter.source_types]);

  const hasActiveFilters =
    Boolean(filter.query) ||
    filter.source_types.length > 0 ||
    filter.project_ids.length > 0 ||
    filter.availability.length > 0;

  const displayedAssets = useMemo(() => {
    if (filter.availability.length === 0) return assets;
    return assets.filter((a) => {
      const status = verifiedMap[a.memory_id] ?? a.availability;
      return filter.availability.includes(status);
    });
  }, [assets, filter.availability, verifiedMap]);

  return (
    <div className="relative h-full overflow-y-auto bg-void p-6 lg:p-8">
      {/* Full-pane drop overlay */}
      {isDragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-void/80 backdrop-blur-xs">
          <div className="flex flex-col items-center gap-3 rounded-[2px] border-2 border-dashed border-cobalt bg-cobalt-wash/90 px-10 py-8 text-center">
            <Upload size={28} className="text-cobalt-ink" aria-hidden />
            <div className="text-lg font-semibold tracking-tight text-bone">
              {t("library.dropOverlayTitle")}
            </div>
            <p className="text-xs text-bone-muted">{t("library.dropOverlayHint")}</p>
          </div>
        </div>
      )}

      <div className="mx-auto max-w-6xl space-y-6">
        {/* Header */}
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-rule pb-5">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-2xl font-semibold tracking-tight text-bone sm:text-3xl">
                {t("library.title")}
              </h1>
            </div>
            <p className="mt-1.5 text-sm text-bone-muted">{t("library.subtitle")}</p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={loading}
              onClick={() => void loadLibrary()}
              className="inline-flex items-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface px-3 py-1.5 font-mono text-xs text-bone-muted transition-colors hover:border-cobalt-ink/60 hover:text-bone disabled:opacity-45"
            >
              <RefreshCw size={12} className={loading ? "animate-spin" : ""} aria-hidden />
              {t("common.refresh")}
            </button>
          </div>
        </header>

        {/* Feedback banners */}
        {readOnly && (
          <div className="flex items-center gap-2 rounded-[2px] border border-ochre-rule bg-ochre-wash px-4 py-2.5 text-xs text-ochre">
            <ShieldAlert size={14} className="shrink-0" aria-hidden />
            <span>{t("inspector.readOnlyNotice")}</span>
          </div>
        )}
        {(error || storeError) && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-[2px] border border-cinnabar-rule bg-cinnabar-wash px-4 py-2.5 text-xs text-cinnabar">
            <span>{error ?? storeError}</span>
            {isOcrNotInstalledMessage(error ?? storeError) && (
              <button
                type="button"
                onClick={() => openSettingsSection("ocr", { autoInstall: true })}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-2.5 py-1 font-mono text-[11px] font-semibold text-bone transition-colors hover:bg-cobalt-bright"
              >
                <ScanText size={11} aria-hidden />
                {t("ocr.installAction")}
              </button>
            )}
          </div>
        )}
        {notice && (
          <div className="flex items-center gap-2 rounded-[2px] border border-verdigris-rule bg-verdigris-wash px-4 py-2.5 font-mono text-xs text-verdigris">
            <Check size={13} aria-hidden />
            <span>{notice}</span>
          </div>
        )}

        {/* Promote file / Drag & Drop zone */}
        <section className="rounded-[2px] border border-dashed border-rule-strong bg-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[2px] border border-cobalt-rule bg-cobalt-wash text-cobalt-ink">
                <FilePlus2 size={16} aria-hidden />
              </div>
              <div>
                <div className="text-sm font-medium text-bone">{t("library.promoteTitle")}</div>
                <p className="text-xs text-bone-muted">{t("library.promoteDesc")}</p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Select<string>
                value={promoteProjectId}
                options={projectOptions}
                size="sm"
                className="w-40"
                disabled={readOnly || promoting}
                ariaLabel={t("library.originProject")}
                onChange={setPromoteProjectId}
              />
              <input
                type="text"
                value={promoteSummary}
                onChange={(e) => setPromoteSummary(e.target.value)}
                disabled={readOnly || promoting}
                placeholder={t("library.promoteSummaryPlaceholder")}
                className="h-7 w-52 rounded-[2px] border border-rule-strong bg-void px-2.5 text-xs text-bone placeholder:text-bone-subtle focus:border-cobalt-ink focus:outline-none disabled:opacity-45"
              />
              <button
                type="button"
                disabled={readOnly || promoting}
                onClick={() => void handlePickAndPromote()}
                className="inline-flex h-7 items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-3 font-mono text-[11px] font-semibold text-bone transition-colors hover:bg-cobalt-bright disabled:opacity-45"
              >
                {promoting ? (
                  <Loader2 size={12} className="animate-spin" aria-hidden />
                ) : (
                  <Upload size={12} aria-hidden />
                )}
                {t("library.promoteButton")}
              </button>
            </div>
          </div>
        </section>

        {/* Hybrid Search & Filter Controls */}
        <section className="space-y-3 rounded-[2px] border border-rule bg-surface p-4">
          <form onSubmit={handleSearchSubmit} className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[220px]">
              <Search
                size={14}
                className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-bone-subtle"
                aria-hidden
              />
              <input
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder={t("library.searchPlaceholder")}
                className="h-9 w-full rounded-[2px] border border-rule-strong bg-void pr-3 pl-9 text-xs text-bone placeholder:text-bone-subtle focus:border-cobalt-ink focus:outline-none"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="inline-flex h-9 items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-4 font-mono text-xs font-semibold text-bone transition-colors hover:bg-cobalt-bright disabled:opacity-45"
            >
              <Search size={12} aria-hidden />
              {t("library.searchButton")}
            </button>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={handleResetFilters}
                className="inline-flex h-9 items-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface-2 px-3 font-mono text-xs text-bone-muted hover:text-bone"
              >
                <RotateCcw size={12} aria-hidden />
                {t("filterDock.reset")}
              </button>
            )}
          </form>

          {/* Filter chips */}
          <div className="space-y-2.5 border-t border-rule pt-3 text-xs">
            {/* Projects */}
            {projects.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="w-24 shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
                  {t("filterDock.projects")}
                </span>
                {projects.map(({ project }) => {
                  const active = filter.project_ids.includes(project.id);
                  return (
                    <button
                      key={project.id}
                      type="button"
                      onClick={() => toggleProject(project.id)}
                      aria-pressed={active}
                      className={`inline-flex items-center gap-1.5 rounded-[2px] border px-2 py-0.5 font-mono text-[11px] transition-colors ${
                        active
                          ? "border-cobalt-rule bg-cobalt-wash text-bone"
                          : "border-rule bg-void text-bone-muted hover:border-rule-strong hover:text-bone"
                      }`}
                    >
                      <span
                        className="h-2 w-2 rounded-[1px]"
                        style={{ backgroundColor: project.color_hex }}
                      />
                      <span>{project.name}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Availability */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="w-24 shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
                {t("library.availabilityLabel")}
              </span>
              {AVAILABILITY_OPTIONS.map((avail) => {
                const active = filter.availability.includes(avail);
                return (
                  <button
                    key={avail}
                    type="button"
                    onClick={() => toggleAvailability(avail)}
                    aria-pressed={active}
                    className={`rounded-[2px] border px-2 py-0.5 font-mono text-[11px] transition-colors ${
                      active
                        ? availabilityClass(avail)
                        : "border-rule bg-void text-bone-muted hover:border-rule-strong hover:text-bone"
                    }`}
                  >
                    {t(`availability.${avail}`)}
                  </button>
                );
              })}
            </div>

            {/* Source types */}
            {availableSourceTypes.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="w-24 shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
                  {t("filterDock.sourceTypes")}
                </span>
                {availableSourceTypes.map((st) => {
                  const active = filter.source_types.includes(st);
                  return (
                    <button
                      key={st}
                      type="button"
                      onClick={() => toggleSourceType(st)}
                      aria-pressed={active}
                      className={`rounded-[2px] border px-2 py-0.5 font-mono text-[10px] uppercase transition-colors ${
                        active
                          ? "border-cobalt-rule bg-cobalt-wash text-cobalt-ink"
                          : "border-rule bg-void text-bone-muted hover:border-rule-strong hover:text-bone"
                      }`}
                    >
                      {st}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        {/* Results Grid */}
        {loading && displayedAssets.length === 0 ? (
          <div className="flex items-center justify-center gap-2 rounded-[2px] border border-rule bg-surface py-12 font-mono text-xs text-bone-muted">
            <Loader2 size={14} className="animate-spin text-cobalt-ink" aria-hidden />
            <span>{t("library.loading")}</span>
          </div>
        ) : displayedAssets.length === 0 ? (
          <div className="rounded-[2px] border border-rule bg-surface p-10 text-center">
            <p className="text-sm font-medium text-bone">
              {hasActiveFilters ? t("library.empty") : t("library.emptyBrandNew")}
            </p>
            <p className="mx-auto mt-1.5 max-w-md text-xs text-bone-muted">
              {hasActiveFilters ? t("library.emptyFilteredHint") : t("library.emptyHint")}
            </p>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={handleResetFilters}
                className="mt-4 inline-flex items-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface-2 px-3 py-1.5 font-mono text-xs text-bone-muted hover:border-cobalt-ink/60 hover:text-bone"
              >
                <RotateCcw size={12} aria-hidden />
                {t("filterDock.reset")}
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
            {displayedAssets.map((asset) => {
              const diskStatus = verifiedMap[asset.memory_id] ?? asset.availability;
              const category =
                graphCategoryById.get(asset.memory_id) ?? fetchedCategories[asset.memory_id];
              const isOcr = category === "ocr";
              const isVerifying = verifyingIds.has(asset.memory_id);
              const isBusy = busyId === asset.memory_id;
              const pathCopyKey = `${asset.memory_id}:path`;
              const snippetCopyKey = `${asset.memory_id}:snippet`;

              return (
                <article
                  key={asset.memory_id}
                  className="flex flex-col justify-between rounded-[2px] border border-rule bg-surface p-4 transition-colors hover:border-rule-strong"
                >
                  <div className="space-y-3">
                    {/* Top meta row */}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2 font-mono text-[11px] text-bone-muted">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-[1px]"
                          style={{ backgroundColor: asset.origin_project_color ?? "#A4A096" }}
                        />
                        <span className="truncate font-medium text-bone">
                          {asset.origin_project_name ?? t("brain.globalScope")}
                        </span>
                        <span className="rounded-[2px] border border-rule bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase text-bone-muted">
                          {asset.source_type}
                        </span>
                        {isOcr && (
                          <span
                            title={t("ocr.badgeTooltip")}
                            className="inline-flex shrink-0 items-center gap-1 rounded-[2px] border border-cobalt-rule bg-cobalt-wash px-1.5 py-0.5 text-[10px] uppercase text-cobalt-ink"
                          >
                            <ScanText size={10} aria-hidden />
                            {t("ocr.badge")}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5">
                        <span
                          className={`inline-flex items-center gap-1 rounded-[2px] border px-1.5 py-0.5 font-mono text-[10px] ${
                            diskStatus === "modified" ? "font-medium" : "uppercase"
                          } ${availabilityClass(diskStatus)}`}
                        >
                          {diskStatus === "modified" ? (
                            <AlertTriangle size={10} aria-hidden />
                          ) : (
                            <FileCheck2 size={10} aria-hidden />
                          )}
                          {diskStatus === "modified"
                            ? t("inspector.fileChangedSinceSaved")
                            : t(`availability.${diskStatus}`)}
                        </span>
                        {asset.source_doc_id && (
                          <button
                            type="button"
                            disabled={isVerifying}
                            onClick={() => void verifyAssetOnDisk(asset)}
                            title={t("library.verifyNow")}
                            className="rounded-[2px] border border-rule bg-void p-1 text-bone-subtle hover:border-rule-strong hover:text-bone disabled:opacity-45"
                          >
                            <RefreshCw
                              size={10}
                              className={isVerifying ? "animate-spin" : ""}
                              aria-hidden
                            />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Summary */}
                    <p className="text-sm leading-relaxed text-bone">{asset.summary}</p>

                    {/* File path if linked */}
                    {asset.file_path && (
                      <div className="truncate rounded-[2px] border border-rule bg-void px-2.5 py-1.5 font-mono text-[11px] text-bone-muted">
                        {asset.file_path}
                      </div>
                    )}

                    {/* Snippet preview */}
                    {asset.snippet && (
                      <pre className="max-h-24 overflow-x-auto overflow-y-auto rounded-[2px] border border-rule bg-void p-2.5 font-mono text-[11px] leading-relaxed text-bone-muted">
                        {asset.snippet}
                      </pre>
                    )}
                  </div>

                  {/* Stats & Actions footer */}
                  <div className="mt-4 space-y-2.5 border-t border-rule pt-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] tabular-nums">
                      <span className="inline-flex items-center gap-1 text-pulse-reuse">
                        <Repeat size={12} aria-hidden />
                        {t("library.reuses", { count: asset.reuse_count })}
                      </span>
                      <span className="text-verdigris">
                        {t("library.tokensSaved", {
                          count: asset.output_tokens_saved,
                        })}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      {asset.file_path && (
                        <button
                          type="button"
                          onClick={() => void handleCopy(pathCopyKey, asset.file_path ?? "")}
                          className="inline-flex items-center gap-1 rounded-[2px] border border-rule-strong bg-surface-2 px-2 py-1 font-mono text-[10px] text-bone-muted hover:border-cobalt-ink/60 hover:text-bone"
                        >
                          {copiedKey === pathCopyKey ? (
                            <Check size={11} className="text-verdigris" aria-hidden />
                          ) : (
                            <Copy size={11} aria-hidden />
                          )}
                          {copiedKey === pathCopyKey
                            ? t("common.copied")
                            : t("library.copyPath")}
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() =>
                          void handleCopy(snippetCopyKey, asset.snippet ?? asset.summary)
                        }
                        className="inline-flex items-center gap-1 rounded-[2px] border border-rule-strong bg-surface-2 px-2 py-1 font-mono text-[10px] text-bone-muted hover:border-cobalt-ink/60 hover:text-bone"
                      >
                        {copiedKey === snippetCopyKey ? (
                          <Check size={11} className="text-verdigris" aria-hidden />
                        ) : (
                          <Code2 size={11} aria-hidden />
                        )}
                        {copiedKey === snippetCopyKey
                          ? t("common.copied")
                          : t("library.copySnippet")}
                      </button>

                      <button
                        type="button"
                        onClick={() => handleLocateIn3D(asset.memory_id)}
                        className="inline-flex items-center gap-1 rounded-[2px] border border-cobalt-rule bg-cobalt-wash px-2 py-1 font-mono text-[10px] text-cobalt-ink hover:bg-cobalt hover:text-bone"
                      >
                        <Compass size={11} aria-hidden />
                        {t("library.locate3D")}
                      </button>

                      {asset.source_doc_id && (
                        <button
                          type="button"
                          disabled={readOnly || isBusy}
                          onClick={() => void handleRelink(asset)}
                          className="inline-flex items-center gap-1 rounded-[2px] border border-rule-strong bg-surface-2 px-2 py-1 font-mono text-[10px] text-bone-muted hover:border-ochre-rule hover:text-ochre disabled:opacity-45"
                        >
                          <FolderSync size={11} aria-hidden />
                          {t("library.relink")}
                        </button>
                      )}

                      <button
                        type="button"
                        disabled={readOnly || isBusy}
                        onClick={() => void handleRetire(asset)}
                        className="ml-auto inline-flex items-center gap-1 rounded-[2px] border border-cinnabar-rule/70 bg-cinnabar-wash/60 px-2 py-1 font-mono text-[10px] text-cinnabar hover:bg-cinnabar hover:text-bone disabled:opacity-45"
                      >
                        {isBusy ? (
                          <Loader2 size={11} className="animate-spin" aria-hidden />
                        ) : (
                          <Trash2 size={11} aria-hidden />
                        )}
                        {t("library.retire")}
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
