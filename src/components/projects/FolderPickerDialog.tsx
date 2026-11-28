import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  FileText,
  Folder,
  FolderCode,
  FolderInput,
  FolderPlus,
  Globe,
  Info,
  Loader2,
  Plus,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { backendCall } from "@/lib/backend";
import { toDisplayError, type DisplayError } from "@/lib/friendlyError";
import { extractFileName } from "@/lib/ingest";
import {
  detectProjectForPaths,
  findProjectByName,
  GENERAL_FOLDER_COLOR,
  GLOBAL_PROJECT_SENTINEL,
  isCodeProject,
  pickNextFolderColor,
  PROJECT_COLORS,
  readLastDropFolder,
  splitProjects,
  toPatchProjectId,
  writeLastDropFolder,
} from "@/lib/projects";
import { useMemoryStore, useSettingsStore } from "@/stores";
import { ErrorAlert } from "@/components/ui";
import type { Project, ProjectStats, Uuid } from "@/types/contracts";
import { DeleteFolderDialog } from "./DeleteFolderDialog";
import { FolderRowMenu } from "./FolderRowMenu";

export interface FolderPickerDialogProps {
  mode: "drop" | "move";
  /** Custom dialog title (falls back to mode default). */
  title?: string;
  /** Short subtitle or item description. */
  subtitle?: string;
  /** Paths being dropped in `"drop"` mode (used for summary & code-project auto-detection). */
  droppedPaths?: readonly string[];
  /** Whole-document or selection info callout shown in `"move"` mode. */
  infoBanner?: string | null;
  /** Optional filename badge shown alongside `infoBanner`. */
  infoFileName?: string | null;
  /** Currently assigned project_id (`undefined` if mixed / unknown, `null` if General). */
  currentProjectId?: Uuid | null;
  /** Optional preloaded project list; fresh projects are still fetched via `list_projects`. */
  initialProjects?: readonly ProjectStats[];
  /** Primary confirm button label override. */
  confirmLabel?: string;
  /** Called when the user confirms a destination (`null` = General). */
  onConfirm: (projectId: Uuid | null, targetName: string) => Promise<void> | void;
  /** Called on Cancel, Esc, or clicking outside. */
  onCancel: () => void;
  /** Optional callback whenever a new folder is created inline. */
  onFolderCreated?: (project: Project) => void;
}

export function FolderPickerDialog({
  mode,
  title,
  subtitle,
  droppedPaths,
  infoBanner,
  infoFileName,
  currentProjectId,
  initialProjects,
  confirmLabel,
  onConfirm,
  onCancel,
  onFolderCreated,
}: FolderPickerDialogProps) {
  const { t } = useTranslation();
  const loadGraph = useMemoryStore((s) => s.loadGraph);
  const graphProjects = useMemoryStore((s) => s.graph?.projects);
  const readOnly = useSettingsStore((s) => s.settings.read_only);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const newNameInputRef = useRef<HTMLInputElement>(null);
  const selectionInitializedRef = useRef(false);
  const submittingRef = useRef(false);
  const creatingFolderRef = useRef(false);

  const [projects, setProjects] = useState<ProjectStats[]>(() => {
    const seed = initialProjects ?? graphProjects ?? [];
    return [...seed];
  });
  const [loadingProjects, setLoadingProjects] = useState(projects.length === 0);
  const [search, setSearch] = useState("");
  const [selectedValue, setSelectedValue] = useState<string>(() => {
    if (mode === "drop") {
      return readLastDropFolder();
    }
    return currentProjectId === undefined
      ? GLOBAL_PROJECT_SENTINEL
      : (currentProjectId ?? GLOBAL_PROJECT_SENTINEL);
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<DisplayError | null>(null);
  const [hintNotice, setHintNotice] = useState<string | null>(null);

  // Inline "+ Nueva carpeta" state
  const [creatingOpen, setCreatingOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderColor, setNewFolderColor] = useState<string>(PROJECT_COLORS[0]);
  const [creatingFolder, setCreatingFolder] = useState(false);

  // Delete folder modal state
  const [deleteTarget, setDeleteTarget] = useState<ProjectStats | null>(null);

  const fetchProjects = useCallback(async () => {
    try {
      const list = await backendCall("list_projects", { include_archived: false });
      setProjects(list);
    } catch {
      // Keep seeded list from graph if backend call fails transiently
    } finally {
      setLoadingProjects(false);
    }
  }, []);

  useEffect(() => {
    void fetchProjects();
  }, [fetchProjects]);

  const activeRegularProjects = useMemo(() => {
    const { regular } = splitProjects(projects);
    return regular
      .filter((s) => !s.project.is_archived)
      .sort((a, b) => a.project.name.localeCompare(b.project.name));
  }, [projects]);

  const autoDetectedProject = useMemo(() => {
    if (mode !== "drop" || !droppedPaths || droppedPaths.length === 0) return null;
    return detectProjectForPaths(
      droppedPaths,
      activeRegularProjects.map((s) => s.project),
    );
  }, [activeRegularProjects, droppedPaths, mode]);

  // Initialize selection once projects are ready (auto-detect > remembered choice > General)
  useEffect(() => {
    if (mode !== "drop") return;
    if (autoDetectedProject) {
      setSelectedValue(autoDetectedProject.id);
      selectionInitializedRef.current = true;
      return;
    }
    if (loadingProjects) return;
    if (!selectionInitializedRef.current) {
      selectionInitializedRef.current = true;
      const remembered = readLastDropFolder();
      if (
        remembered !== GLOBAL_PROJECT_SENTINEL &&
        !activeRegularProjects.some((p) => p.project.id === remembered)
      ) {
        setSelectedValue(GLOBAL_PROJECT_SENTINEL);
      } else {
        setSelectedValue(remembered);
      }
    }
  }, [activeRegularProjects, autoDetectedProject, loadingProjects, mode]);

  // Autofocus search field when dialog opens
  useEffect(() => {
    const raf = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(raf);
  }, []);

  // Autofocus name field when inline "+ Nueva carpeta" opens
  useEffect(() => {
    if (!creatingOpen) return;
    setNewFolderColor(pickNextFolderColor(activeRegularProjects.map((s) => s.project)));
    const raf = window.requestAnimationFrame(() => {
      newNameInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [activeRegularProjects, creatingOpen]);

  // Escape cancels inline form first, then closes modal (when DeleteFolderDialog isn't open)
  useEffect(() => {
    if (deleteTarget) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (submitting || creatingFolder) return;
      e.preventDefault();
      e.stopPropagation();
      if (creatingOpen) {
        setCreatingOpen(false);
        setNewFolderName("");
        setError(null);
      } else {
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [creatingFolder, creatingOpen, deleteTarget, onCancel, submitting]);

  const normalizedSearch = search.trim().toLowerCase();

  const generalLabel = t("folders.generalOption");
  const generalMatchesSearch =
    normalizedSearch.length === 0 ||
    generalLabel.toLowerCase().includes(normalizedSearch) ||
    t("brain.globalScope").toLowerCase().includes(normalizedSearch);

  const filteredProjects = useMemo(() => {
    if (!normalizedSearch) return activeRegularProjects;
    return activeRegularProjects.filter(
      ({ project }) =>
        project.name.toLowerCase().includes(normalizedSearch) ||
        (project.root_path?.toLowerCase().includes(normalizedSearch) ?? false),
    );
  }, [activeRegularProjects, normalizedSearch]);

  const existingFolderMatch = useMemo(
    () => findProjectByName(activeRegularProjects, newFolderName),
    [activeRegularProjects, newFolderName],
  );

  const resolveTargetName = useCallback(
    (value: string): string => {
      if (value === GLOBAL_PROJECT_SENTINEL) return t("brain.globalScope");
      return (
        activeRegularProjects.find((p) => p.project.id === value)?.project.name ??
        t("brain.globalScope")
      );
    },
    [activeRegularProjects, t],
  );

  const handleConfirmValue = useCallback(
    async (value: string) => {
      if (submittingRef.current || submitting || creatingFolder) return;
      submittingRef.current = true;
      const projectId = toPatchProjectId(value);
      const targetName = resolveTargetName(value);
      setSubmitting(true);
      setError(null);
      try {
        if (mode === "drop") {
          writeLastDropFolder(projectId);
        }
        await onConfirm(projectId, targetName);
      } catch (err: unknown) {
        setError(toDisplayError(err, t, mode === "move" ? "move_to_project" : "ingest_paths"));
        setSubmitting(false);
        submittingRef.current = false;
      }
    },
    [creatingFolder, mode, onConfirm, resolveTargetName, submitting, t],
  );

  const handleCreateFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newFolderName.trim();
    if (!trimmed || creatingFolder || creatingFolderRef.current) return;

    // If the typed name matches an existing folder (case-insensitive), select it directly
    if (existingFolderMatch) {
      setSelectedValue(existingFolderMatch.project.id);
      setNewFolderName("");
      setCreatingOpen(false);
      setSearch("");
      setError(null);
      setHintNotice(
        t("folders.existingSelectedHint", { name: existingFolderMatch.project.name }),
      );
      return;
    }

    creatingFolderRef.current = true;
    setCreatingFolder(true);
    setError(null);
    setHintNotice(null);
    try {
      const created = await backendCall("create_project", {
        name: trimmed,
        root_path: null,
        color_hex: newFolderColor,
      });
      setProjects((prev) => [
        ...prev,
        {
          project: created,
          vector_count: 0,
          total_tokens: 0,
          reusable_count: 0,
        },
      ]);
      setSelectedValue(created.id);
      setNewFolderName("");
      setCreatingOpen(false);
      setSearch("");
      onFolderCreated?.(created);
      void loadGraph();
    } catch (err: unknown) {
      setError(toDisplayError(err, t, "create_project"));
    } finally {
      setCreatingFolder(false);
      creatingFolderRef.current = false;
    }
  };

  const droppedSummary = useMemo(() => {
    if (!droppedPaths || droppedPaths.length === 0) return null;
    const first = extractFileName(droppedPaths[0]) ?? droppedPaths[0] ?? "";
    if (droppedPaths.length === 1) return first;
    return t("folders.dropDialog.multipleItems", {
      first,
      more: droppedPaths.length - 1,
    });
  }, [droppedPaths, t]);

  const resolvedTitle =
    title ??
    (mode === "drop" ? t("folders.dropDialog.title") : t("folders.moveDialog.title"));

  const resolvedConfirmLabel =
    confirmLabel ??
    (mode === "drop" ? t("folders.dropDialog.confirm") : t("folders.moveDialog.confirm"));

  const isSameAsCurrent =
    mode === "move" &&
    currentProjectId !== undefined &&
    toPatchProjectId(selectedValue) === currentProjectId;

  return (
    <div
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !submitting && !creatingFolder && !deleteTarget) {
          onCancel();
        }
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-void/65 p-4 backdrop-blur-[2px]"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="folder-picker-dialog-title"
        style={{ boxShadow: "var(--cobalt-shadow-elevated)" }}
        className="cobalt-modal-enter flex max-h-[min(560px,calc(100vh-2rem))] w-[min(440px,calc(100vw-2rem))] flex-col rounded-[2px] border border-rule-strong bg-surface text-bone"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-rule px-4 py-3.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <FolderInput size={15} className="shrink-0 text-cobalt-ink" aria-hidden />
              <h2
                id="folder-picker-dialog-title"
                className="text-sm font-semibold tracking-tight text-bone"
              >
                {resolvedTitle}
              </h2>
            </div>
            {(subtitle || droppedSummary) && (
              <p className="mt-1 truncate font-mono text-[11px] text-bone-muted">
                {subtitle ?? droppedSummary}
              </p>
            )}
          </div>
          <button
            type="button"
            disabled={submitting || creatingFolder}
            onClick={onCancel}
            aria-label={t("common.close")}
            className="rounded-[2px] p-1 text-bone-muted hover:bg-surface-2 hover:text-bone disabled:opacity-45"
          >
            <X size={14} aria-hidden />
          </button>
        </div>

        {/* Info callout: whole document notice or auto-detected project */}
        {infoBanner && (
          <div className="flex items-start gap-2 border-b border-cobalt-rule/60 bg-cobalt-wash/55 px-4 py-2.5 text-xs text-bone">
            <FileText size={14} className="mt-0.5 shrink-0 text-cobalt-ink" aria-hidden />
            <div className="min-w-0">
              <p className="leading-snug">{infoBanner}</p>
              {infoFileName && (
                <p className="mt-0.5 truncate font-mono text-[10px] text-bone-muted">
                  {infoFileName}
                </p>
              )}
            </div>
          </div>
        )}

        {autoDetectedProject && (
          <div className="flex items-center gap-2 border-b border-verdigris-rule/60 bg-verdigris-wash/45 px-4 py-2 text-[11px] text-verdigris">
            <Sparkles size={12} className="shrink-0" aria-hidden />
            <span className="truncate">
              {t("folders.dropDialog.autoDetectedBanner", {
                project: autoDetectedProject.name,
              })}
            </span>
          </div>
        )}

        {hintNotice && (
          <div
            role="status"
            className="flex items-center justify-between gap-2 border-b border-cobalt-rule/60 bg-cobalt-wash/45 px-4 py-2 text-[11px] text-bone"
          >
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Info size={12} className="shrink-0 text-cobalt-ink" aria-hidden />
              <span className="leading-snug">{hintNotice}</span>
            </span>
            <button
              type="button"
              onClick={() => setHintNotice(null)}
              aria-label={t("common.close")}
              className="shrink-0 rounded-[2px] p-0.5 text-bone-subtle hover:text-bone"
            >
              <X size={11} aria-hidden />
            </button>
          </div>
        )}

        {error && (
          <div className="border-b border-cinnabar-rule">
            <ErrorAlert error={error} compact className="rounded-none border-0" />
          </div>
        )}

        {/* Search bar */}
        <div className="border-b border-rule px-4 py-2.5">
          <div className="relative flex items-center">
            <Search
              size={13}
              className="pointer-events-none absolute left-2.5 text-bone-subtle"
              aria-hidden
            />
            <input
              ref={searchInputRef}
              type="text"
              value={search}
              disabled={submitting}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !creatingOpen) {
                  e.preventDefault();
                  if (filteredProjects.length === 1 && !generalMatchesSearch && filteredProjects[0]) {
                    void handleConfirmValue(filteredProjects[0].project.id);
                  } else if (!isSameAsCurrent) {
                    void handleConfirmValue(selectedValue);
                  }
                }
              }}
              placeholder={t("folders.searchPlaceholder")}
              className="h-8 w-full rounded-[2px] border border-rule-strong bg-void pr-7 pl-8 text-xs text-bone placeholder:text-bone-subtle focus:border-cobalt-ink focus:outline-none"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                aria-label={t("filterDock.clearSearch")}
                className="absolute right-2 text-bone-subtle hover:text-bone"
              >
                <X size={12} aria-hidden />
              </button>
            )}
          </div>
        </div>

        {/* Scrollable list of folders/projects */}
        <div className="flex-1 space-y-1 overflow-y-auto p-2.5">
          {/* General (all folders) option */}
          {generalMatchesSearch && (
            <button
              type="button"
              disabled={submitting}
              onClick={() => setSelectedValue(GLOBAL_PROJECT_SENTINEL)}
              onDoubleClick={() => {
                if (!(mode === "move" && currentProjectId === null)) {
                  void handleConfirmValue(GLOBAL_PROJECT_SENTINEL);
                }
              }}
              className={`flex w-full items-center justify-between gap-2.5 rounded-[2px] border px-3 py-2 text-left transition-colors ${
                selectedValue === GLOBAL_PROJECT_SENTINEL
                  ? "border-cobalt-rule bg-cobalt-wash text-bone"
                  : "border-transparent bg-void/60 text-bone-muted hover:border-rule hover:bg-surface-2 hover:text-bone"
              }`}
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-[1px]"
                  style={{ backgroundColor: GENERAL_FOLDER_COLOR }}
                  aria-hidden
                />
                <Globe size={14} className="shrink-0 text-bone-muted" aria-hidden />
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-bone">
                    <span className="truncate">{generalLabel}</span>
                    {mode === "move" && currentProjectId === null && (
                      <span className="rounded-[2px] border border-rule bg-surface px-1 py-0.25 font-mono text-[9px] uppercase text-bone-subtle">
                        {t("folders.currentBadge")}
                      </span>
                    )}
                  </div>
                  <div className="truncate text-[10px] text-bone-subtle">
                    {t("folders.generalHint")}
                  </div>
                </div>
              </div>
              {selectedValue === GLOBAL_PROJECT_SENTINEL && (
                <Check size={14} className="shrink-0 text-cobalt-ink" aria-hidden />
              )}
            </button>
          )}

          {/* Existing folders & code projects */}
          {filteredProjects.map((stat) => {
            const { project, vector_count } = stat;
            const isSelected = selectedValue === project.id;
            const isCurrent = mode === "move" && currentProjectId === project.id;
            const isDetected = autoDetectedProject?.id === project.id;
            const isCode = isCodeProject(project);

            return (
              <div
                key={project.id}
                className={`group flex w-full items-center gap-1 rounded-[2px] border pr-1.5 transition-colors ${
                  isSelected
                    ? "border-cobalt-rule bg-cobalt-wash text-bone"
                    : "border-transparent bg-void/60 text-bone-muted hover:border-rule hover:bg-surface-2 hover:text-bone"
                }`}
              >
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => setSelectedValue(project.id)}
                  onDoubleClick={() => {
                    if (!isCurrent) {
                      void handleConfirmValue(project.id);
                    }
                  }}
                  className="flex min-w-0 flex-1 items-center justify-between gap-2.5 px-3 py-2 text-left"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-[1px]"
                      style={{ backgroundColor: project.color_hex }}
                      aria-hidden
                    />
                    {isCode ? (
                      <FolderCode
                        size={14}
                        className="shrink-0"
                        style={{ color: project.color_hex }}
                        aria-hidden
                      />
                    ) : (
                      <Folder
                        size={14}
                        className="shrink-0"
                        style={{ color: project.color_hex }}
                        aria-hidden
                      />
                    )}
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 text-xs font-medium text-bone">
                        <span className="truncate">{project.name}</span>
                        {isDetected && (
                          <span className="rounded-[2px] border border-verdigris-rule bg-verdigris-wash px-1 py-0.25 font-mono text-[9px] uppercase text-verdigris">
                            {t("folders.detectedBadge")}
                          </span>
                        )}
                        {isCurrent && (
                          <span className="rounded-[2px] border border-rule bg-surface px-1 py-0.25 font-mono text-[9px] uppercase text-bone-subtle">
                            {t("folders.currentBadge")}
                          </span>
                        )}
                      </div>
                      <div className="truncate font-mono text-[10px] text-bone-subtle">
                        {isCode
                          ? project.root_path
                          : t("folders.plainFolderCount", { count: vector_count })}
                      </div>
                    </div>
                  </div>

                  {isSelected && (
                    <Check size={14} className="shrink-0 text-cobalt-ink" aria-hidden />
                  )}
                </button>

                <FolderRowMenu
                  folderName={project.name}
                  disabled={readOnly || submitting}
                  triggerClassName="opacity-65 group-hover:opacity-100 focus-visible:opacity-100"
                  onDelete={() => setDeleteTarget(stat)}
                />
              </div>
            );
          })}

          {!loadingProjects && !generalMatchesSearch && filteredProjects.length === 0 && (
            <p className="px-3 py-4 text-center text-xs text-bone-subtle">
              {t("folders.noMatches")}
            </p>
          )}

          {/* Inline "+ Nueva carpeta" creator */}
          <div className="pt-1">
            {creatingOpen ? (
              <form
                onSubmit={(e) => void handleCreateFolder(e)}
                className="space-y-2.5 rounded-[2px] border border-cobalt-rule bg-void p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-cobalt-ink">
                    <FolderPlus size={11} aria-hidden />
                    {t("folders.newFolder")}
                  </span>
                  <button
                    type="button"
                    disabled={creatingFolder}
                    onClick={() => {
                      setCreatingOpen(false);
                      setNewFolderName("");
                    }}
                    aria-label={t("common.cancel")}
                    className="p-0.5 text-bone-subtle hover:text-bone"
                  >
                    <X size={12} aria-hidden />
                  </button>
                </div>

                <input
                  ref={newNameInputRef}
                  type="text"
                  value={newFolderName}
                  disabled={creatingFolder}
                  onChange={(e) => {
                    setNewFolderName(e.target.value);
                    if (error) setError(null);
                  }}
                  placeholder={t("folders.namePlaceholder")}
                  className="h-8 w-full rounded-[2px] border border-rule-strong bg-surface px-2.5 text-xs text-bone placeholder:text-bone-subtle focus:border-cobalt-ink focus:outline-none"
                />

                {existingFolderMatch && (
                  <div
                    role="status"
                    className="flex items-start gap-1.5 rounded-[2px] border border-cobalt-rule/70 bg-cobalt-wash/50 px-2 py-1.5 text-[11px] leading-snug text-bone"
                  >
                    <Info size={12} className="mt-0.5 shrink-0 text-cobalt-ink" aria-hidden />
                    <span>
                      {t("folders.alreadyExistsSelectHint", {
                        name: existingFolderMatch.project.name,
                      })}
                    </span>
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2">
                  {!existingFolderMatch ? (
                    <div className="flex items-center gap-1">
                      {PROJECT_COLORS.map((hex) => (
                        <button
                          key={hex}
                          type="button"
                          onClick={() => setNewFolderColor(hex)}
                          aria-label={hex}
                          className={`h-4 w-4 rounded-[2px] border transition-transform ${
                            newFolderColor === hex
                              ? "scale-110 border-bone ring-1 ring-bone"
                              : "border-rule-strong"
                          }`}
                          style={{ backgroundColor: hex }}
                        />
                      ))}
                    </div>
                  ) : (
                    <span />
                  )}
                  <button
                    type="submit"
                    disabled={creatingFolder || !newFolderName.trim()}
                    className="inline-flex h-7 items-center gap-1 rounded-[2px] border border-cobalt-rule bg-cobalt px-2.5 font-mono text-[11px] font-semibold text-on-accent hover:bg-cobalt-bright disabled:opacity-45"
                  >
                    {creatingFolder ? (
                      <Loader2 size={11} className="animate-spin" aria-hidden />
                    ) : existingFolderMatch ? (
                      <Check size={11} aria-hidden />
                    ) : (
                      <Plus size={11} aria-hidden />
                    )}
                    {existingFolderMatch
                      ? t("folders.selectExistingShort")
                      : t("folders.createShort")}
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                disabled={submitting || readOnly}
                onClick={() => setCreatingOpen(true)}
                className="flex w-full items-center gap-2 rounded-[2px] border border-dashed border-rule-strong bg-void/40 px-3 py-2 text-left text-xs font-medium text-cobalt-ink transition-colors hover:border-cobalt-rule hover:bg-cobalt-wash/50 disabled:opacity-45"
              >
                <FolderPlus size={14} className="shrink-0" aria-hidden />
                <span>{t("folders.newFolderPlus")}</span>
              </button>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-rule px-4 py-3">
          <button
            type="button"
            disabled={submitting || creatingFolder}
            onClick={onCancel}
            className="rounded-[2px] border border-rule-strong bg-surface-2 px-3 py-1.5 font-mono text-xs text-bone-muted hover:text-bone disabled:opacity-45"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            disabled={submitting || creatingFolder || isSameAsCurrent}
            onClick={() => void handleConfirmValue(selectedValue)}
            className="inline-flex items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-3.5 py-1.5 font-mono text-xs font-semibold text-on-accent hover:bg-cobalt-bright disabled:opacity-45"
          >
            {submitting && <Loader2 size={12} className="animate-spin" aria-hidden />}
            <span>{resolvedConfirmLabel}</span>
          </button>
        </div>
      </section>

      {deleteTarget && (
        <DeleteFolderDialog
          target={deleteTarget}
          availableProjects={projects}
          onClose={() => setDeleteTarget(null)}
          onDeleted={async (deletedId) => {
            setProjects((prev) => prev.filter((p) => p.project.id !== deletedId));
            if (selectedValue === deletedId) {
              setSelectedValue(GLOBAL_PROJECT_SENTINEL);
            }
            await fetchProjects();
          }}
        />
      )}
    </div>
  );
}
