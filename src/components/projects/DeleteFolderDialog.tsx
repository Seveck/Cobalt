import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  AlertOctagon,
  Clock,
  Folder,
  FolderCode,
  FolderInput,
  Info,
  Loader2,
  Trash2,
  X,
} from "lucide-react";
import { backendCall } from "@/lib/backend";
import { formatCount } from "@/lib/format";
import { toDisplayError, type DisplayError } from "@/lib/friendlyError";
import {
  countActiveMemoriesByFolder,
  countProjectDocuments,
  formatDeleteProjectReportToast,
  GLOBAL_PROJECT_SENTINEL,
  isCodeProject,
  readLastDropFolder,
  splitProjects,
  toPatchProjectId,
  writeLastDropFolder,
} from "@/lib/projects";
import {
  useFiltersStore,
  useLibraryStore,
  useMemoryStore,
  useSettingsStore,
  useThemeStore,
} from "@/stores";
import { ErrorAlert, Select, type SelectOption } from "@/components/ui";
import type {
  DeleteProjectContents,
  DeleteProjectReport,
  ProjectStats,
  Uuid,
} from "@/types/contracts";

export interface DeleteFolderDialogProps {
  target: ProjectStats;
  /** Other known projects available as move targets (excluding `target`). */
  availableProjects?: readonly ProjectStats[];
  onClose: () => void;
  /** Invoked after deletion succeeds and stores/filters have been updated. */
  onDeleted?: (deletedId: Uuid, report: DeleteProjectReport) => Promise<void> | void;
}

export function DeleteFolderDialog({
  target,
  availableProjects,
  onClose,
  onDeleted,
}: DeleteFolderDialogProps) {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.resolvedLanguage ?? i18n.language;

  const graph = useMemoryStore((s) => s.graph);
  const loadGraph = useMemoryStore((s) => s.loadGraph);
  const clearProjectReferences = useFiltersStore((s) => s.clearProjectReferences);
  const clearLibraryProjectFilter = useLibraryStore((s) => s.clearProjectFilter);
  const pushThemeToast = useThemeStore((s) => s.pushThemeToast);
  const readOnly = useSettingsStore((s) => s.settings.read_only);

  const confirmInputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);

  const [fetchedProjects, setFetchedProjects] = useState<ProjectStats[] | null>(null);
  const [contentsMode, setContentsMode] = useState<DeleteProjectContents>("move");
  const [moveTarget, setMoveTarget] = useState<string>(GLOBAL_PROJECT_SENTINEL);
  const [confirmName, setConfirmName] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<DisplayError | null>(null);

  useEffect(() => {
    let active = true;
    void backendCall("list_projects", { include_archived: false })
      .then((list) => {
        if (active) setFetchedProjects(list);
      })
      .catch(() => {
        // Fall back to availableProjects / graph projects
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !deleting) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [deleting, onClose]);

  useEffect(() => {
    if (contentsMode === "delete") {
      const raf = window.requestAnimationFrame(() => {
        confirmInputRef.current?.focus();
      });
      return () => window.cancelAnimationFrame(raf);
    }
  }, [contentsMode]);

  const otherFolders = useMemo(() => {
    const source = fetchedProjects ?? availableProjects ?? graph?.projects ?? [];
    const { regular } = splitProjects(source);
    return regular
      .filter((s) => !s.project.is_archived && s.project.id !== target.project.id)
      .sort((a, b) => a.project.name.localeCompare(b.project.name));
  }, [availableProjects, fetchedProjects, graph?.projects, target.project.id]);

  const activeFolderCounts = useMemo(
    () => (graph?.nodes ? countActiveMemoriesByFolder(graph.nodes) : null),
    [graph?.nodes],
  );

  const destinationOptions = useMemo<SelectOption<string>[]>(
    () => [
      {
        value: GLOBAL_PROJECT_SENTINEL,
        label: t("folders.generalOption"),
        detail: t("folders.generalHint"),
      },
      ...otherFolders.map((stat) => {
        const activeCount = activeFolderCounts
          ? (activeFolderCounts.byProjectId.get(stat.project.id) ?? 0)
          : stat.vector_count;
        return {
          value: stat.project.id,
          label: stat.project.name,
          detail:
            stat.project.root_path ??
            t("folders.plainFolderCount", {
              count: activeCount,
              formattedCount: formatCount(activeCount, currentLanguage),
            }),
        };
      }),
    ],
    [activeFolderCounts, currentLanguage, otherFolders, t],
  );

  // Ensure live counts stay fresh even if graph has newer data than the prop
  const { memoriesCount, documentsCount } = useMemo(() => {
    const graphCount = (graph?.nodes ?? []).filter(
      (n) => n.project_id === target.project.id && n.status !== "superseded",
    ).length;
    return {
      memoriesCount: Math.max(target.vector_count, graphCount),
      documentsCount: countProjectDocuments(graph?.nodes, target.project.id),
    };
  }, [graph?.nodes, target.project.id, target.vector_count]);

  const isCode = isCodeProject(target.project);
  const nameMatched = confirmName.trim() === target.project.name.trim();
  const canConfirm =
    !readOnly &&
    !deleting &&
    (contentsMode === "move" || nameMatched);

  const resolveDestinationName = (value: string): string => {
    if (value === GLOBAL_PROJECT_SENTINEL) return t("brain.globalScope");
    return (
      otherFolders.find((s) => s.project.id === value)?.project.name ??
      t("brain.globalScope")
    );
  };

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canConfirm || submittingRef.current) return;
    submittingRef.current = true;
    setDeleting(true);
    setError(null);

    try {
      const targetProjectId = contentsMode === "move" ? toPatchProjectId(moveTarget) : null;
      const targetName = resolveDestinationName(moveTarget);

      const report = await backendCall("delete_project", {
        id: target.project.id,
        contents: contentsMode,
        move_to: contentsMode === "move" ? targetProjectId : null,
      });

      // Clear filters & persisted drop target pointing to the deleted folder
      clearProjectReferences(target.project.id);
      clearLibraryProjectFilter(target.project.id);
      if (readLastDropFolder() === target.project.id) {
        writeLastDropFolder(null);
      }

      await loadGraph();
      await onDeleted?.(target.project.id, report);

      pushThemeToast({
        kind: "saved",
        message: formatDeleteProjectReportToast(
          target.project.name,
          contentsMode,
          targetName,
          report,
          t,
        ),
      });

      onClose();
    } catch (err: unknown) {
      setError(toDisplayError(err, t, "delete_project"));
      setDeleting(false);
      submittingRef.current = false;
    }
  };

  const dialog = (
    <div
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget && !deleting) {
          onClose();
        }
      }}
      onClick={(e) => e.stopPropagation()}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-void/70 p-4 backdrop-blur-[2px]"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-folder-dialog-title"
        style={{ boxShadow: "var(--cobalt-shadow-elevated)" }}
        className={`cobalt-modal-enter flex max-h-[min(640px,calc(100vh-2rem))] w-[min(480px,calc(100vw-2rem))] flex-col rounded-[2px] border bg-surface text-bone ${
          contentsMode === "delete" ? "border-cinnabar-rule" : "border-rule-strong"
        }`}
      >
        {/* Header */}
        <div
          className={`flex items-center justify-between gap-2 border-b px-4 py-3 ${
            contentsMode === "delete"
              ? "border-cinnabar-rule/70 bg-cinnabar-wash/45"
              : "border-rule"
          }`}
        >
          <div className="flex items-center gap-2">
            <Trash2 size={15} className="shrink-0 text-cinnabar" aria-hidden />
            <h2
              id="delete-folder-dialog-title"
              className="text-sm font-semibold tracking-tight text-bone"
            >
              {t("folders.deleteDialog.title")}
            </h2>
          </div>
          <button
            type="button"
            disabled={deleting}
            onClick={onClose}
            aria-label={t("common.close")}
            className="rounded-[2px] p-1 text-bone-muted hover:bg-surface-2 hover:text-bone disabled:opacity-45"
          >
            <X size={14} aria-hidden />
          </button>
        </div>

        <form onSubmit={(e) => void handleConfirm(e)} className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 space-y-4 overflow-y-auto p-4">
            <ErrorAlert error={error} compact />

            {/* Folder summary card */}
            <div className="rounded-[2px] border border-rule bg-void/75 p-3">
              <div className="flex items-center gap-2">
                <span
                  className="h-3 w-3 shrink-0 rounded-[2px]"
                  style={{ backgroundColor: target.project.color_hex }}
                  aria-hidden
                />
                {isCode ? (
                  <FolderCode
                    size={15}
                    className="shrink-0"
                    style={{ color: target.project.color_hex }}
                    aria-hidden
                  />
                ) : (
                  <Folder
                    size={15}
                    className="shrink-0"
                    style={{ color: target.project.color_hex }}
                    aria-hidden
                  />
                )}
                <span className="truncate text-sm font-semibold text-bone">
                  {target.project.name}
                </span>
              </div>

              {target.project.root_path && (
                <p className="mt-1 truncate font-mono text-[11px] text-bone-subtle">
                  {target.project.root_path}
                </p>
              )}

              <div className="mt-2 flex flex-wrap gap-3 font-mono text-[11px] tabular-nums text-bone-muted">
                <span>{t("brain.nodesCount", { count: memoriesCount })}</span>
                {documentsCount > 0 && (
                  <span>{t("folders.deleteDialog.documentsCount", { count: documentsCount })}</span>
                )}
                <span>{t("brain.tokens", { count: target.total_tokens })}</span>
                {target.reusable_count > 0 && (
                  <span className="text-pulse-reuse">
                    {t("folders.deleteDialog.reusableCount", { count: target.reusable_count })}
                  </span>
                )}
              </div>
            </div>

            {/* Code project auto-recreate notice */}
            {isCode && (
              <div className="flex items-start gap-2 rounded-[2px] border border-cobalt-rule/60 bg-cobalt-wash/45 px-3 py-2.5 text-xs leading-relaxed text-bone-muted">
                <Info size={14} className="mt-0.5 shrink-0 text-cobalt-ink" aria-hidden />
                <span>{t("folders.deleteDialog.codeProjectNote")}</span>
              </div>
            )}

            {/* Contents handling choice */}
            <div className="space-y-2.5">
              <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-bone-subtle">
                {t("folders.deleteDialog.whatToDoLabel")}
              </p>

              {/* Option 1: Move contents (default) */}
              <div
                onClick={() => {
                  if (!deleting) setContentsMode("move");
                }}
                className={`cursor-pointer rounded-[2px] border p-3 transition-colors ${
                  contentsMode === "move"
                    ? "border-cobalt-rule bg-cobalt-wash/35"
                    : "border-rule bg-void/50 hover:border-rule-strong"
                }`}
              >
                <label className="flex cursor-pointer items-start gap-2.5">
                  <input
                    type="radio"
                    name="delete-folder-contents"
                    value="move"
                    checked={contentsMode === "move"}
                    disabled={deleting}
                    onChange={() => setContentsMode("move")}
                    className="mt-0.5 accent-[var(--cobalt-accent)]"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-bone">
                      <FolderInput size={13} className="shrink-0 text-cobalt-ink" aria-hidden />
                      <span>{t("folders.deleteDialog.moveOptionTitle")}</span>
                    </div>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-bone-muted">
                      {t("folders.deleteDialog.moveOptionDesc")}
                    </p>
                  </div>
                </label>

                {contentsMode === "move" && (
                  <div
                    className="mt-3 pl-6"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Select<string>
                      value={moveTarget}
                      options={destinationOptions}
                      size="sm"
                      disabled={deleting}
                      ariaLabel={t("folders.deleteDialog.moveTargetAria")}
                      onChange={setMoveTarget}
                    />
                  </div>
                )}
              </div>

              {/* Option 2: Delete contents too (red, requires typing folder name) */}
              <div
                onClick={() => {
                  if (!deleting) setContentsMode("delete");
                }}
                className={`cursor-pointer rounded-[2px] border p-3 transition-colors ${
                  contentsMode === "delete"
                    ? "border-cinnabar bg-cinnabar-wash/55"
                    : "border-rule bg-void/50 hover:border-cinnabar-rule/70"
                }`}
              >
                <label className="flex cursor-pointer items-start gap-2.5">
                  <input
                    type="radio"
                    name="delete-folder-contents"
                    value="delete"
                    checked={contentsMode === "delete"}
                    disabled={deleting}
                    onChange={() => setContentsMode("delete")}
                    className="mt-0.5 accent-[var(--cobalt-cinnabar,#ef4444)]"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-cinnabar">
                      <AlertOctagon size={13} className="shrink-0" aria-hidden />
                      <span>{t("folders.deleteDialog.deleteOptionTitle")}</span>
                    </div>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-bone-muted">
                      {t("folders.deleteDialog.deleteOptionDesc")}
                    </p>
                  </div>
                </label>

                {contentsMode === "delete" && (
                  <div
                    className="mt-3 space-y-3 pl-6"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="flex items-start gap-2 rounded-[2px] border border-rule-strong bg-surface/80 px-2.5 py-2 text-[11px] leading-relaxed text-bone-muted">
                      <Clock size={13} className="mt-0.5 shrink-0 text-cobalt-ink" aria-hidden />
                      <span>{t("folders.deleteDialog.restorePointNote")}</span>
                    </div>

                    <div className="space-y-1.5">
                      <label
                        htmlFor="delete-folder-confirm-input"
                        className="block text-[11px] text-bone-muted"
                      >
                        {t("folders.deleteDialog.typeNamePrompt")}
                      </label>
                      <div className="flex items-center gap-2">
                        <span className="max-w-[160px] shrink-0 truncate rounded-[2px] border border-cinnabar-rule bg-cinnabar-wash px-2 py-1 font-mono text-[11px] font-semibold text-cinnabar select-all">
                          {target.project.name}
                        </span>
                        <input
                          ref={confirmInputRef}
                          id="delete-folder-confirm-input"
                          type="text"
                          autoComplete="off"
                          spellCheck={false}
                          disabled={deleting || readOnly}
                          value={confirmName}
                          onChange={(e) => setConfirmName(e.target.value)}
                          placeholder={target.project.name}
                          className="h-8 min-w-0 flex-1 rounded-[2px] border border-rule-strong bg-void px-2.5 text-xs text-bone placeholder:text-bone-subtle focus:border-cinnabar focus:outline-none disabled:opacity-50"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 border-t border-rule bg-surface-2 px-4 py-3">
            <button
              type="button"
              disabled={deleting}
              onClick={onClose}
              className="rounded-[2px] border border-rule-strong bg-surface px-3 py-1.5 font-mono text-xs text-bone-muted hover:text-bone disabled:opacity-45"
            >
              {t("common.cancel")}
            </button>
            <button
              type="submit"
              disabled={!canConfirm}
              className={`inline-flex items-center gap-1.5 rounded-[2px] border px-3.5 py-1.5 font-mono text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                contentsMode === "delete"
                  ? "border-cinnabar bg-cinnabar text-bone hover:opacity-90"
                  : "border-cinnabar-rule bg-cinnabar-wash text-cinnabar hover:bg-cinnabar hover:text-bone"
              }`}
            >
              {deleting ? (
                <Loader2 size={12} className="animate-spin" aria-hidden />
              ) : (
                <Trash2 size={12} aria-hidden />
              )}
              <span>
                {deleting
                  ? t("folders.deleteDialog.deleting")
                  : contentsMode === "delete"
                    ? t("folders.deleteDialog.confirmDeleteContents")
                    : t("folders.deleteDialog.confirmMoveContents")}
              </span>
            </button>
          </div>
        </form>
      </section>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(dialog, document.body) : dialog;
}
