import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  CheckSquare,
  Compass,
  FolderInput,
  Inbox,
  Loader2,
  Square,
  X,
} from "lucide-react";
import { backendCall } from "@/lib/backend";
import {
  GLOBAL_PROJECT_SENTINEL,
  toPatchProjectId,
  UNSORTED_PROJECT_COLOR,
  UNSORTED_PROJECT_NAME,
} from "@/lib/projects";
import { useMemoryStore } from "@/stores";
import { Select, Skeleton, type SelectOption } from "@/components/ui";
import type { GraphNode, ProjectStats, Uuid } from "@/types/contracts";

export interface UnsortedMemoriesPanelProps {
  unsortedProject: ProjectStats;
  regularProjects: readonly ProjectStats[];
  readOnly: boolean;
  onMoved: () => Promise<void> | void;
  onInspectMemory: (memoryId: Uuid) => void;
  onClose?: () => void;
}

const CHOOSE_DESTINATION_SENTINEL = "__choose__";

function formatShortDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}

/**
 * Dedicated review & bulk-move view for the "Sin clasificar" (`UNSORTED_PROJECT_NAME`) bucket.
 * Lists memories saved by AIs without a known project and lets the user move one or many
 * to Global or any real project via `patch_memory`.
 */
export function UnsortedMemoriesPanel({
  unsortedProject,
  regularProjects,
  readOnly,
  onMoved,
  onInspectMemory,
  onClose,
}: UnsortedMemoriesPanelProps) {
  const { t } = useTranslation();

  const graph = useMemoryStore((s) => s.graph);
  const graphLoading = useMemoryStore((s) => s.loading);
  const loadGraph = useMemoryStore((s) => s.loadGraph);

  const [selectedIds, setSelectedIds] = useState<ReadonlySet<Uuid>>(() => new Set());
  const [bulkTarget, setBulkTarget] = useState<string>(GLOBAL_PROJECT_SENTINEL);
  const [movingBulk, setMovingBulk] = useState(false);
  const [movingSingleId, setMovingSingleId] = useState<Uuid | null>(null);
  const [openRowMoveId, setOpenRowMoveId] = useState<Uuid | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!graph && !graphLoading) {
      void loadGraph();
    }
  }, [graph, graphLoading, loadGraph]);

  const unsortedNodes = useMemo<GraphNode[]>(() => {
    if (!graph) return [];
    return graph.nodes
      .filter(
        (node) =>
          node.project_id === unsortedProject.project.id && node.status !== "superseded",
      )
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
  }, [graph, unsortedProject.project.id]);

  // Prune selection when nodes are moved away
  useEffect(() => {
    const valid = new Set(unsortedNodes.map((n) => n.id));
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set<Uuid>();
      for (const id of prev) {
        if (valid.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [unsortedNodes]);

  const activeRegularProjects = useMemo(
    () => regularProjects.filter((p) => !p.project.is_archived),
    [regularProjects],
  );

  const destinationOptions = useMemo<SelectOption<string>[]>(
    () => [
      { value: GLOBAL_PROJECT_SENTINEL, label: t("brain.globalScope") },
      ...activeRegularProjects.map((stat) => ({
        value: stat.project.id,
        label: stat.project.name,
      })),
    ],
    [activeRegularProjects, t],
  );

  const rowDestinationOptions = useMemo<SelectOption<string>[]>(
    () => [
      {
        value: CHOOSE_DESTINATION_SENTINEL,
        label: t("unsorted.chooseDestination"),
        disabled: true,
      },
      ...destinationOptions,
    ],
    [destinationOptions, t],
  );

  // Default bulk destination to the first active regular project if one exists
  useEffect(() => {
    if (
      bulkTarget === GLOBAL_PROJECT_SENTINEL &&
      activeRegularProjects.length > 0 &&
      activeRegularProjects[0]
    ) {
      setBulkTarget(activeRegularProjects[0].project.id);
    }
  }, [activeRegularProjects, bulkTarget]);

  const resolveDestinationName = (targetValue: string): string => {
    if (targetValue === GLOBAL_PROJECT_SENTINEL) return t("brain.globalScope");
    return (
      activeRegularProjects.find((p) => p.project.id === targetValue)?.project.name ??
      t("brain.globalScope")
    );
  };

  const allSelected = unsortedNodes.length > 0 && selectedIds.size === unsortedNodes.length;

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(unsortedNodes.map((n) => n.id)));
    }
  };

  const toggleRow = (id: Uuid) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBulkMove = async () => {
    if (readOnly || movingBulk || selectedIds.size === 0) return;
    const ids = [...selectedIds];
    const projectId = toPatchProjectId(bulkTarget);
    const targetName = resolveDestinationName(bulkTarget);

    setMovingBulk(true);
    setError(null);
    setNotice(null);
    let moved = 0;
    try {
      for (const id of ids) {
        await backendCall("patch_memory", {
          id,
          patch: { project_id: projectId },
        });
        moved += 1;
      }
      setSelectedIds(new Set());
      await loadGraph();
      await onMoved();
      setNotice(
        moved === 1
          ? t("unsorted.movedOneNotice", { project: targetName })
          : t("unsorted.movedManyNotice", { count: moved, project: targetName }),
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      if (moved > 0) {
        await loadGraph();
        await onMoved();
      }
    } finally {
      setMovingBulk(false);
    }
  };

  const handleMoveSingle = async (memoryId: Uuid, targetValue: string) => {
    if (readOnly || movingSingleId !== null) return;
    const projectId = toPatchProjectId(targetValue);
    const targetName = resolveDestinationName(targetValue);

    setMovingSingleId(memoryId);
    setError(null);
    setNotice(null);
    try {
      await backendCall("patch_memory", {
        id: memoryId,
        patch: { project_id: projectId },
      });
      setOpenRowMoveId(null);
      await loadGraph();
      await onMoved();
      setNotice(t("unsorted.movedOneNotice", { project: targetName }));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMovingSingleId(null);
    }
  };

  const badgeCount = Math.max(unsortedProject.vector_count, unsortedNodes.length);

  return (
    <section className="space-y-3 rounded-[2px] border border-rule-strong bg-surface-2/65 p-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-rule pb-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <div
            className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[2px] border border-rule-strong bg-void text-bone-muted"
            aria-hidden
          >
            <Inbox size={14} style={{ color: UNSORTED_PROJECT_COLOR }} />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-[1px]"
                style={{ backgroundColor: UNSORTED_PROJECT_COLOR }}
                aria-hidden
              />
              <h3 className="text-sm font-semibold text-bone-muted">{UNSORTED_PROJECT_NAME}</h3>
              {badgeCount > 0 && (
                <span className="inline-flex min-w-[1.35rem] items-center justify-center rounded-[2px] border border-rule-strong bg-void px-1.5 py-0.5 font-mono text-[10px] leading-none font-semibold tabular-nums text-bone-muted">
                  {badgeCount}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-bone-subtle">
              {t("unsorted.explanation")}
            </p>
          </div>
        </div>

        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="rounded-[2px] p-1 text-bone-subtle transition-colors hover:bg-surface hover:text-bone"
          >
            <X size={14} aria-hidden />
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-[2px] border border-cinnabar-rule bg-cinnabar-wash px-3 py-2 text-xs text-cinnabar">
          {error}
        </div>
      )}
      {notice && (
        <div className="flex items-center gap-1.5 rounded-[2px] border border-verdigris-rule bg-verdigris-wash px-3 py-2 font-mono text-xs text-verdigris">
          <Check size={12} aria-hidden />
          <span>{notice}</span>
        </div>
      )}

      {/* Bulk move toolbar */}
      {unsortedNodes.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-[2px] border border-rule bg-void/80 p-2.5">
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={movingBulk}
              onClick={toggleSelectAll}
              className="inline-flex items-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface px-2 py-1 font-mono text-[11px] text-bone-muted transition-colors hover:border-cobalt-ink/60 hover:text-bone disabled:opacity-45"
            >
              {allSelected ? (
                <CheckSquare size={12} className="text-cobalt-ink" aria-hidden />
              ) : (
                <Square size={12} aria-hidden />
              )}
              <span>{allSelected ? t("unsorted.deselectAll") : t("unsorted.selectAll")}</span>
            </button>
            <span className="font-mono text-[11px] tabular-nums text-bone-subtle">
              {t("unsorted.selectedCount", {
                selected: selectedIds.size,
                total: unsortedNodes.length,
              })}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-bone-subtle">
              {t("unsorted.moveDestination")}
            </span>
            <Select<string>
              value={bulkTarget}
              options={destinationOptions}
              size="sm"
              className="w-44"
              disabled={readOnly || movingBulk}
              ariaLabel={t("unsorted.moveDestination")}
              onChange={setBulkTarget}
            />
            <button
              type="button"
              disabled={readOnly || movingBulk || selectedIds.size === 0}
              onClick={() => void handleBulkMove()}
              className="inline-flex h-7 items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-3 font-mono text-[11px] font-semibold text-on-accent transition-colors hover:bg-cobalt-bright disabled:opacity-45"
            >
              {movingBulk ? (
                <Loader2 size={11} className="animate-spin" aria-hidden />
              ) : (
                <FolderInput size={11} aria-hidden />
              )}
              <span>
                {movingBulk
                  ? t("unsorted.moving")
                  : t("unsorted.moveSelected", { count: selectedIds.size })}
              </span>
            </button>
          </div>
        </div>
      )}

      {/* Memories list */}
      {graphLoading && !graph ? (
        <div className="space-y-2" aria-busy="true" aria-label={t("shell.loading")}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-[2px] border border-rule bg-surface p-3">
              <Skeleton className="h-3.5 w-3/4" />
              <Skeleton className="mt-2 h-3 w-1/3" />
            </div>
          ))}
        </div>
      ) : unsortedNodes.length === 0 ? (
        <p className="rounded-[2px] border border-rule bg-void/60 px-4 py-5 text-center text-xs text-bone-subtle">
          {t("unsorted.empty")}
        </p>
      ) : (
        <div className="max-h-96 divide-y divide-rule overflow-y-auto rounded-[2px] border border-rule bg-surface">
          {unsortedNodes.map((node) => {
            const checked = selectedIds.has(node.id);
            const isRowMoving = movingSingleId === node.id;
            const moveOpen = openRowMoveId === node.id;

            return (
              <div
                key={node.id}
                className={`flex flex-col gap-2 p-3 transition-colors ${
                  checked ? "bg-cobalt-wash/35" : "hover:bg-surface-2/60"
                }`}
              >
                <div className="flex items-start gap-2.5">
                  <button
                    type="button"
                    disabled={movingBulk || isRowMoving}
                    onClick={() => toggleRow(node.id)}
                    aria-pressed={checked}
                    aria-label={t("unsorted.selectMemoryAria")}
                    className="mt-0.5 shrink-0 text-bone-muted hover:text-bone disabled:opacity-45"
                  >
                    {checked ? (
                      <CheckSquare size={14} className="text-cobalt-ink" aria-hidden />
                    ) : (
                      <Square size={14} aria-hidden />
                    )}
                  </button>

                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 text-xs leading-relaxed text-bone">{node.preview}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[10px] text-bone-subtle">
                      <span className="rounded-[2px] border border-rule bg-void px-1.5 py-0.5 text-bone-muted">
                        {t(`categories.${node.category}`)}
                      </span>
                      <span className="uppercase">{node.source_type}</span>
                      {node.status === "archived" && (
                        <span className="rounded-[2px] border border-rule bg-void px-1 py-0.5 uppercase">
                          {t("statuses.archived")}
                        </span>
                      )}
                      <span className="tabular-nums">
                        {t("brain.tokens", { count: node.chunk_tokens })}
                      </span>
                      <span>{formatShortDate(node.updated_at)}</span>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      disabled={readOnly || movingBulk || isRowMoving}
                      onClick={() => setOpenRowMoveId((curr) => (curr === node.id ? null : node.id))}
                      className="inline-flex items-center gap-1 rounded-[2px] border border-rule-strong bg-surface-2 px-2 py-1 font-mono text-[10px] text-bone-muted transition-colors hover:border-cobalt-ink/60 hover:text-bone disabled:opacity-45"
                    >
                      {isRowMoving ? (
                        <Loader2 size={10} className="animate-spin" aria-hidden />
                      ) : (
                        <FolderInput size={10} aria-hidden />
                      )}
                      <span>{t("unsorted.moveAction")}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onInspectMemory(node.id)}
                      title={t("library.locate3D")}
                      aria-label={t("library.locate3D")}
                      className="inline-flex items-center gap-1 rounded-[2px] border border-rule bg-void px-1.5 py-1 font-mono text-[10px] text-bone-subtle hover:border-cobalt-rule hover:text-cobalt-ink"
                    >
                      <Compass size={11} aria-hidden />
                    </button>
                  </div>
                </div>

                {moveOpen && (
                  <div className="flex flex-wrap items-center justify-end gap-2 border-t border-rule pt-2 pl-6">
                    <span className="font-mono text-[10px] text-bone-subtle">
                      {t("unsorted.moveDestination")}
                    </span>
                    <Select<string>
                      value={CHOOSE_DESTINATION_SENTINEL}
                      options={rowDestinationOptions}
                      size="sm"
                      align="right"
                      className="w-44"
                      disabled={readOnly || isRowMoving}
                      ariaLabel={t("unsorted.moveAction")}
                      onChange={(targetVal) => {
                        if (targetVal !== CHOOSE_DESTINATION_SENTINEL) {
                          void handleMoveSingle(node.id, targetVal);
                        }
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => setOpenRowMoveId(null)}
                      className="rounded-[2px] border border-rule px-2 py-1 font-mono text-[10px] text-bone-subtle hover:text-bone"
                    >
                      {t("common.cancel")}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
