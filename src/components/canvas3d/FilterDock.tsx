import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronUp,
  Crosshair,
  Filter,
  Folder,
  FolderCode,
  FolderInput,
  Globe,
  Inbox,
  Repeat,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import {
  GENERAL_FOLDER_COLOR,
  isCodeProject,
  splitProjects,
  UNSORTED_PROJECT_COLOR,
  UNSORTED_PROJECT_NAME,
} from "@/lib/projects";
import { matchesVisualFilters, useFiltersStore, useUiStore } from "@/stores";
import {
  MEMORY_CATEGORIES,
  MEMORY_STATUSES,
  type GraphNode,
  type MemoryCategory,
  type MemoryStatus,
  type ProjectStats,
  type SourceType,
} from "@/types/contracts";

interface FilterDockProps {
  nodes: readonly GraphNode[];
  projects: readonly ProjectStats[];
}

export function FilterDock({ nodes, projects }: FilterDockProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setExpanded(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        setExpanded(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [expanded]);

  const filters = useFiltersStore((s) => s.filters);
  const searchQuery = useFiltersStore((s) => s.searchQuery);
  const toggleSourceType = useFiltersStore((s) => s.toggleSourceType);
  const toggleProjectId = useFiltersStore((s) => s.toggleProjectId);
  const toggleCategory = useFiltersStore((s) => s.toggleCategory);
  const toggleStatus = useFiltersStore((s) => s.toggleStatus);
  const setOnlyReusable = useFiltersStore((s) => s.setOnlyReusable);
  const setSolo = useFiltersStore((s) => s.setSolo);
  const setSearchQuery = useFiltersStore((s) => s.setSearchQuery);
  const resetFilters = useFiltersStore((s) => s.resetFilters);
  const openUnsortedView = useUiStore((s) => s.openUnsortedView);

  const { regular: regularProjects, unsorted: unsortedProject } = useMemo(
    () => splitProjects(projects),
    [projects],
  );

  const stats = useMemo(() => {
    const sourceTypeCounts = new Map<SourceType, number>();
    const projectCounts = new Map<string, number>();
    const categoryCounts = new Map<MemoryCategory, number>();
    const statusCounts = new Map<MemoryStatus, number>();
    let reusableCount = 0;
    let visibleCount = 0;

    for (const node of nodes) {
      sourceTypeCounts.set(node.source_type, (sourceTypeCounts.get(node.source_type) ?? 0) + 1);
      const pKey = node.project_id ?? "global";
      projectCounts.set(pKey, (projectCounts.get(pKey) ?? 0) + 1);
      categoryCounts.set(node.category, (categoryCounts.get(node.category) ?? 0) + 1);
      statusCounts.set(node.status, (statusCounts.get(node.status) ?? 0) + 1);
      if (node.is_reusable) reusableCount += 1;
      if (matchesVisualFilters(node, filters, searchQuery)) visibleCount += 1;
    }

    const sortedSourceTypes = [...sourceTypeCounts.entries()].sort((a, b) => b[1] - a[1]);

    return {
      sourceTypeCounts,
      sortedSourceTypes,
      projectCounts,
      categoryCounts,
      statusCounts,
      reusableCount,
      visibleCount,
    };
  }, [filters, nodes, searchQuery]);

  const hasActiveFilters =
    filters.sourceTypes.length > 0 ||
    filters.projectIds.length > 0 ||
    filters.categories.length > 0 ||
    filters.statuses.length > 0 ||
    filters.onlyReusable ||
    filters.solo !== null ||
    searchQuery.trim().length > 0;

  const isSolo = (
    dimension: "source_type" | "project" | "category" | "status",
    value: string,
  ): boolean => filters.solo?.dimension === dimension && filters.solo.value === value;

  const toggleSoloChip = (
    dimension: "source_type" | "project" | "category" | "status",
    value: string,
  ) => {
    if (isSolo(dimension, value)) {
      setSolo(null);
    } else {
      setSolo({ dimension, value });
    }
  };

  return (
    <div ref={containerRef} className="pointer-events-auto flex flex-col gap-1.5">
      {expanded && (
        <div className="cobalt-panel-enter-up w-full max-w-4xl rounded-[2px] border border-rule-strong bg-surface p-3 shadow-[0_14px_36px_rgba(0,0,0,0.72)]">
          <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2 border-b border-rule pb-2">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-bone-muted">
                {t("filterDock.title")}
              </span>
              <span className="rounded-[2px] border border-rule bg-void px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-bone-subtle">
                {t("filterDock.visualOnlyBadge")}
              </span>
            </div>
            <span className="font-mono text-[10px] text-bone-subtle">
              {t("filterDock.soloHint")}
            </span>
          </div>

          <div className="space-y-2.5 text-[11px]">
            {/* Projects row */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="w-24 shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
                {t("filterDock.projects")}
              </span>
              <div className="flex flex-wrap items-center gap-1">
                {regularProjects.map((stat) => {
                  const { project } = stat;
                  const count = stats.projectCounts.get(project.id) ?? 0;
                  const active = filters.projectIds.includes(project.id);
                  const soloed = isSolo("project", project.id);
                  return (
                    <div
                      key={project.id}
                      className={`inline-flex items-center rounded-[2px] border font-mono text-[10px] transition-colors ${
                        soloed
                          ? "border-ochre bg-ochre-wash text-ochre"
                          : active
                            ? "border-cobalt-rule bg-cobalt-wash text-bone"
                            : "border-rule bg-surface-2 text-bone-muted hover:border-rule-strong hover:text-bone"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={(e) => {
                          if (e.shiftKey) {
                            toggleSoloChip("project", project.id);
                          } else {
                            toggleProjectId(project.id);
                          }
                        }}
                        className="inline-flex items-center gap-1.5 px-2 py-0.5"
                      >
                        <span
                          className="h-2 w-2 rounded-[1px]"
                          style={{ backgroundColor: project.color_hex }}
                        />
                        {isCodeProject(project) ? (
                          <FolderCode size={10} className="shrink-0 opacity-80" aria-hidden />
                        ) : (
                          <Folder size={10} className="shrink-0 opacity-80" aria-hidden />
                        )}
                        <span>{project.name}</span>
                        <span className="tabular-nums opacity-70">{count}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleSoloChip("project", project.id)}
                        title={t("filterDock.soloAction")}
                        className={`border-l px-1 py-0.5 transition-colors ${
                          soloed
                            ? "border-ochre-rule text-ochre"
                            : "border-rule text-bone-subtle hover:text-bone"
                        }`}
                      >
                        <Crosshair size={10} aria-hidden />
                      </button>
                    </div>
                  );
                })}
                {/* General (project_id === null) chip */}
                {(() => {
                  const globalCount = stats.projectCounts.get("global") ?? 0;
                  const active = filters.projectIds.includes(null);
                  const soloed = isSolo("project", "global");
                  return (
                    <div
                      className={`inline-flex items-center rounded-[2px] border font-mono text-[10px] transition-colors ${
                        soloed
                          ? "border-ochre bg-ochre-wash text-ochre"
                          : active
                            ? "border-cobalt-rule bg-cobalt-wash text-bone"
                            : "border-rule bg-surface-2 text-bone-muted hover:border-rule-strong hover:text-bone"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={(e) => {
                          if (e.shiftKey) {
                            toggleSoloChip("project", "global");
                          } else {
                            toggleProjectId(null);
                          }
                        }}
                        className="inline-flex items-center gap-1.5 px-2 py-0.5"
                      >
                        <span
                          className="h-2 w-2 rounded-[1px]"
                          style={{ backgroundColor: GENERAL_FOLDER_COLOR }}
                        />
                        <Globe size={10} className="shrink-0 opacity-80" aria-hidden />
                        <span>{t("brain.globalScope")}</span>
                        <span className="tabular-nums opacity-70">{globalCount}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleSoloChip("project", "global")}
                        title={t("filterDock.soloAction")}
                        className={`border-l px-1 py-0.5 transition-colors ${
                          soloed
                            ? "border-ochre-rule text-ochre"
                            : "border-rule text-bone-subtle hover:text-bone"
                        }`}
                      >
                        <Crosshair size={10} aria-hidden />
                      </button>
                    </div>
                  );
                })()}
                {/* Distinct grey "Sin clasificar" chip */}
                {unsortedProject &&
                  (() => {
                    const unsortedId = unsortedProject.project.id;
                    const count = stats.projectCounts.get(unsortedId) ?? unsortedProject.vector_count;
                    const active = filters.projectIds.includes(unsortedId);
                    const soloed = isSolo("project", unsortedId);
                    return (
                      <div
                        title={t("unsorted.explanation")}
                        className={`inline-flex items-center rounded-[2px] border border-dashed font-mono text-[10px] transition-colors ${
                          soloed
                            ? "border-ochre bg-ochre-wash text-ochre"
                            : active
                              ? "border-rule-strong bg-surface-3 text-bone"
                              : "border-rule-strong bg-void/70 text-bone-subtle hover:border-bone-subtle hover:text-bone-muted"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={(e) => {
                            if (e.shiftKey) {
                              toggleSoloChip("project", unsortedId);
                            } else {
                              toggleProjectId(unsortedId);
                            }
                          }}
                          className="inline-flex items-center gap-1.5 px-2 py-0.5"
                        >
                          <Inbox
                            size={10}
                            style={{ color: UNSORTED_PROJECT_COLOR }}
                            aria-hidden
                          />
                          <span>{UNSORTED_PROJECT_NAME}</span>
                          {count > 0 && (
                            <span className="rounded-[2px] border border-rule-strong bg-surface-2 px-1 py-0.25 text-[9px] font-semibold tabular-nums text-bone-muted">
                              {count}
                            </span>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleSoloChip("project", unsortedId)}
                          title={t("filterDock.soloAction")}
                          className={`border-l px-1 py-0.5 transition-colors ${
                            soloed
                              ? "border-ochre-rule text-ochre"
                              : "border-rule text-bone-subtle hover:text-bone"
                          }`}
                        >
                          <Crosshair size={10} aria-hidden />
                        </button>
                        {count > 0 && (
                          <button
                            type="button"
                            onClick={openUnsortedView}
                            title={t("unsorted.reviewAndMove")}
                            className="border-l border-rule px-1.5 py-0.5 text-bone-subtle transition-colors hover:text-cobalt-ink"
                          >
                            <FolderInput size={10} aria-hidden />
                          </button>
                        )}
                      </div>
                    );
                  })()}
              </div>
            </div>

            {/* Categories row */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="w-24 shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
                {t("filterDock.categories")}
              </span>
              <div className="flex flex-wrap items-center gap-1">
                {MEMORY_CATEGORIES.map((cat) => {
                  const count = stats.categoryCounts.get(cat) ?? 0;
                  const active = filters.categories.includes(cat);
                  const soloed = isSolo("category", cat);
                  return (
                    <div
                      key={cat}
                      className={`inline-flex items-center rounded-[2px] border font-mono text-[10px] transition-colors ${
                        soloed
                          ? "border-ochre bg-ochre-wash text-ochre"
                          : active
                            ? "border-cobalt-rule bg-cobalt-wash text-bone"
                            : "border-rule bg-surface-2 text-bone-muted hover:border-rule-strong hover:text-bone"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={(e) => {
                          if (e.shiftKey) {
                            toggleSoloChip("category", cat);
                          } else {
                            toggleCategory(cat);
                          }
                        }}
                        className="inline-flex items-center gap-1.5 px-2 py-0.5"
                      >
                        <span>{t(`categories.${cat}`)}</span>
                        <span className="tabular-nums opacity-70">{count}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleSoloChip("category", cat)}
                        title={t("filterDock.soloAction")}
                        className={`border-l px-1 py-0.5 transition-colors ${
                          soloed
                            ? "border-ochre-rule text-ochre"
                            : "border-rule text-bone-subtle hover:text-bone"
                        }`}
                      >
                        <Crosshair size={10} aria-hidden />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Status row */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="w-24 shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
                {t("filterDock.status")}
              </span>
              <div className="flex flex-wrap items-center gap-1">
                {MEMORY_STATUSES.map((status) => {
                  const count = stats.statusCounts.get(status) ?? 0;
                  const active = filters.statuses.includes(status);
                  const soloed = isSolo("status", status);
                  return (
                    <div
                      key={status}
                      className={`inline-flex items-center rounded-[2px] border font-mono text-[10px] transition-colors ${
                        soloed
                          ? "border-ochre bg-ochre-wash text-ochre"
                          : active
                            ? "border-cobalt-rule bg-cobalt-wash text-bone"
                            : "border-rule bg-surface-2 text-bone-muted hover:border-rule-strong hover:text-bone"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={(e) => {
                          if (e.shiftKey) {
                            toggleSoloChip("status", status);
                          } else {
                            toggleStatus(status);
                          }
                        }}
                        className="inline-flex items-center gap-1.5 px-2 py-0.5"
                      >
                        <span>{t(`statuses.${status}`)}</span>
                        <span className="tabular-nums opacity-70">{count}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleSoloChip("status", status)}
                        title={t("filterDock.soloAction")}
                        className={`border-l px-1 py-0.5 transition-colors ${
                          soloed
                            ? "border-ochre-rule text-ochre"
                            : "border-rule text-bone-subtle hover:text-bone"
                        }`}
                      >
                        <Crosshair size={10} aria-hidden />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* All source_type chips with live counts */}
            {stats.sortedSourceTypes.length > 0 && (
              <div className="flex flex-wrap items-start gap-1.5">
                <span className="mt-1 w-24 shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
                  {t("filterDock.sourceTypes")}
                </span>
                <div className="flex flex-1 flex-wrap items-center gap-1">
                  {stats.sortedSourceTypes.map(([sourceType, count]) => {
                    const active = filters.sourceTypes.includes(sourceType);
                    const soloed = isSolo("source_type", sourceType);
                    return (
                      <div
                        key={sourceType}
                        className={`inline-flex items-center rounded-[2px] border font-mono text-[10px] uppercase transition-colors ${
                          soloed
                            ? "border-ochre bg-ochre-wash text-ochre"
                            : active
                              ? "border-cobalt-rule bg-cobalt-wash text-bone"
                              : "border-rule bg-surface-2 text-bone-muted hover:border-rule-strong hover:text-bone"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={(e) => {
                            if (e.shiftKey) {
                              toggleSoloChip("source_type", sourceType);
                            } else {
                              toggleSourceType(sourceType);
                            }
                          }}
                          className="inline-flex items-center gap-1.5 px-2 py-0.5"
                        >
                          <span>{sourceType}</span>
                          <span className="tabular-nums opacity-70">{count}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleSoloChip("source_type", sourceType)}
                          title={t("filterDock.soloAction")}
                          className={`border-l px-1 py-0.5 transition-colors ${
                            soloed
                              ? "border-ochre-rule text-ochre"
                              : "border-rule text-bone-subtle hover:text-bone"
                          }`}
                        >
                          <Crosshair size={10} aria-hidden />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Always-visible compact Filter Dock strip */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface px-2.5 py-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.6)]">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={`inline-flex items-center gap-1.5 rounded-[2px] border px-2 py-1 font-mono text-[11px] font-medium transition-colors ${
            expanded || hasActiveFilters
              ? "border-cobalt-rule bg-cobalt-wash text-cobalt-ink"
              : "border-rule bg-surface-2 text-bone-muted hover:border-rule-strong hover:text-bone"
          }`}
        >
          <Filter size={11} aria-hidden />
          <span>{t("filterDock.filtersButton")}</span>
          {expanded ? <ChevronDown size={11} aria-hidden /> : <ChevronUp size={11} aria-hidden />}
        </button>

        {/* Quick text filter */}
        <div className="relative flex items-center">
          <Search
            size={11}
            className="pointer-events-none absolute left-2 text-bone-subtle"
            aria-hidden
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("filterDock.searchPlaceholder")}
            className="h-6 w-36 rounded-[2px] border border-rule bg-void pr-6 pl-6 font-mono text-[11px] text-bone placeholder:text-bone-subtle focus:border-cobalt-ink focus:outline-none sm:w-44"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              aria-label={t("filterDock.clearSearch")}
              className="absolute right-1.5 text-bone-subtle hover:text-bone"
            >
              <X size={11} aria-hidden />
            </button>
          )}
        </div>

        {/* "Solo Reutilizables" quick toggle */}
        <button
          type="button"
          onClick={() => setOnlyReusable(!filters.onlyReusable)}
          aria-pressed={filters.onlyReusable}
          className={`inline-flex items-center gap-1 rounded-[2px] border px-2 py-1 font-mono text-[10px] font-medium transition-colors ${
            filters.onlyReusable
              ? "border-pulse-reuse/70 bg-pulse-reuse/20 text-pulse-reuse"
              : "border-rule bg-surface-2 text-bone-muted hover:border-rule-strong hover:text-bone"
          }`}
        >
          <Repeat size={11} aria-hidden />
          <span>{t("filterDock.onlyReusable")}</span>
          <span className="tabular-nums opacity-75">{stats.reusableCount}</span>
        </button>

        {/* Quick top source_type chips with live counts on the dock bar */}
        <div className="hidden items-center gap-1 md:flex">
          {stats.sortedSourceTypes.slice(0, 6).map(([sourceType, count]) => {
            const active = filters.sourceTypes.includes(sourceType);
            const soloed = isSolo("source_type", sourceType);
            return (
              <button
                key={sourceType}
                type="button"
                onClick={(e) => {
                  if (e.shiftKey) {
                    toggleSoloChip("source_type", sourceType);
                  } else {
                    toggleSourceType(sourceType);
                  }
                }}
                title={t("filterDock.chipTooltip")}
                className={`inline-flex items-center gap-1 rounded-[2px] border px-1.5 py-0.5 font-mono text-[10px] uppercase transition-colors ${
                  soloed
                    ? "border-ochre bg-ochre-wash text-ochre"
                    : active
                      ? "border-cobalt-rule bg-cobalt-wash text-bone"
                      : "border-rule bg-surface-2 text-bone-muted hover:border-rule-strong hover:text-bone"
                }`}
              >
                <span>{sourceType}</span>
                <span className="tabular-nums opacity-70">{count}</span>
              </button>
            );
          })}
        </div>

        {/* Active Solo indicator */}
        {filters.solo && (
          <button
            type="button"
            onClick={() => setSolo(null)}
            className="inline-flex items-center gap-1 rounded-[2px] border border-ochre-rule bg-ochre-wash px-2 py-0.5 font-mono text-[10px] font-medium text-ochre hover:border-ochre"
          >
            <Crosshair size={10} aria-hidden />
            <span>
              {t("filterDock.soloBadge")}:{" "}
              {filters.solo.dimension === "project"
                ? filters.solo.value === "global"
                  ? t("brain.globalScope")
                  : (projects.find((p) => p.project.id === filters.solo?.value)?.project.name ??
                    filters.solo.value)
                : filters.solo.value}
            </span>
            <X size={10} aria-hidden />
          </button>
        )}

        {/* Visible / Total live counter */}
        <span className="ml-auto font-mono text-[10px] tabular-nums text-bone-subtle">
          {t("filterDock.visibleCount", {
            visible: stats.visibleCount,
            total: nodes.length,
          })}
        </span>

        {hasActiveFilters && (
          <button
            type="button"
            onClick={resetFilters}
            className="inline-flex items-center gap-1 rounded-[2px] border border-rule-strong bg-surface-2 px-2 py-0.5 font-mono text-[10px] text-bone-muted transition-colors hover:border-cobalt-ink/60 hover:text-bone"
          >
            <RotateCcw size={10} aria-hidden />
            <span>{t("filterDock.reset")}</span>
          </button>
        )}
      </div>
    </div>
  );
}
