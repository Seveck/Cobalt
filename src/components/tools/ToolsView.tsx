import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Archive,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  Edit3,
  FileText,
  FileUp,
  FolderInput,
  FolderKanban,
  FolderOpen,
  FolderSync,
  Globe,
  HardDriveDownload,
  History,
  Inbox,
  Loader2,
  Lock,
  Package,
  Plus,
  RotateCcw,
  Save,
  ScanText,
  ShieldAlert,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { backendCall } from "@/lib/backend";
import { copyToClipboard, pickPaths, pickSavePath, pickSinglePath, useFileDrop } from "@/lib/dialogs";
import { isEngineStateInstalled } from "@/lib/format";
import {
  analyzeIngestReport,
  isOcrNotInstalledMessage,
  reportHasOcrNotInstalledError,
} from "@/lib/ingest";
import { staggerStyle } from "@/lib/motion";
import {
  splitProjects,
  UNSORTED_PROJECT_COLOR,
  UNSORTED_PROJECT_NAME,
} from "@/lib/projects";
import {
  useFiltersStore,
  useHardwareStore,
  useIngestStore,
  useMemoryStore,
  useSettingsStore,
  useUiStore,
  type ToolsTab,
} from "@/stores";
import { UnsortedMemoriesPanel } from "@/components/projects/UnsortedMemoriesPanel";
import { Select, Skeleton, Toggle, type SelectOption } from "@/components/ui";
import type {
  BackupManifest,
  CapsuleManifest,
  ImportReport,
  PastLifeSource,
  ProjectStats,
  Uuid,
  WebContext,
} from "@/types/contracts";

const PROJECT_COLORS = [
  "#3B82F6",
  "#10B981",
  "#A855F7",
  "#F59E0B",
  "#EC4899",
  "#06B6D4",
  "#EF4444",
  "#84CC16",
] as const;

const PAST_LIFE_SOURCES: readonly PastLifeSource[] = [
  "chatgpt_export",
  "claude_export",
  "markdown_folder",
  "cursor_rules",
  "claude_md",
];

const PROJECT_WATCHED_STORAGE_KEY = "cobalt.projectWatched";

function loadProjectWatchedMap(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(PROJECT_WATCHED_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const result: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "boolean") {
        result[k] = v;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function saveProjectWatchedMap(map: Record<string, boolean>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PROJECT_WATCHED_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage quota / privacy mode errors
  }
}

function ImportReportCard({ report }: { report: ImportReport }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2 rounded-[2px] border border-verdigris-rule bg-verdigris-wash/60 p-3.5 text-xs">
      <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-verdigris">
        {t("tools.importReportTitle")}
      </div>
      <div className="grid grid-cols-2 gap-2 font-mono text-[11px] tabular-nums sm:grid-cols-4">
        <div>
          <span className="text-bone-subtle">{t("tools.report.inserted")}: </span>
          <strong className="text-bone">{report.inserted}</strong>
        </div>
        <div>
          <span className="text-bone-subtle">{t("tools.report.skipped")}: </span>
          <strong className="text-bone">{report.skipped_identical}</strong>
        </div>
        <div>
          <span className="text-bone-subtle">{t("tools.report.superseded")}: </span>
          <strong className="text-bone">{report.superseded}</strong>
        </div>
        <div>
          <span className="text-bone-subtle">{t("tools.report.isolated")}: </span>
          <strong className="text-bone">{report.isolated}</strong>
        </div>
        <div>
          <span className="text-bone-subtle">{t("tools.report.reembedded")}: </span>
          <strong className="text-bone">{report.reembedded}</strong>
        </div>
        <div>
          <span className="text-bone-subtle">{t("tools.report.projectsCreated")}: </span>
          <strong className="text-bone">{report.projects_created}</strong>
        </div>
        {report.review_branch && (
          <div className="col-span-2">
            <span className="text-bone-subtle">{t("tools.report.reviewBranch")}: </span>
            <strong className="text-ochre">{report.review_branch}</strong>
          </div>
        )}
      </div>
      {report.warnings.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-ochre">
          {report.warnings.map((w, idx) => (
            <li key={idx}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ToolsView() {
  const { t } = useTranslation();

  const readOnly = useSettingsStore((s) => s.settings.read_only);
  const autoWatchProjects = useSettingsStore((s) => s.settings.capture.auto_watch_projects);
  const loadGraph = useMemoryStore((s) => s.loadGraph);
  const setSelectedNodeId = useMemoryStore((s) => s.setSelectedNodeId);
  const resetVisualFilters = useFiltersStore((s) => s.resetFilters);
  const activeTab = useUiStore((s) => s.toolsTab);
  const setActiveTab = useUiStore((s) => s.setToolsTab);
  const setActiveNav = useUiStore((s) => s.setActiveNav);
  const unsortedViewOpen = useUiStore((s) => s.unsortedViewOpen);
  const setUnsortedViewOpen = useUiStore((s) => s.setUnsortedViewOpen);
  const openSettingsSection = useUiStore((s) => s.openSettingsSection);
  const ocrStatus = useHardwareStore((s) => s.ocrStatus);

  const ingestJobs = useIngestStore((s) => s.jobs);
  const startIngestPaths = useIngestStore((s) => s.startIngestPaths);
  const startImportPastLife = useIngestStore((s) => s.startImportPastLife);
  const openIngestReport = useIngestStore((s) => s.openReport);

  const [projects, setProjects] = useState<ProjectStats[]>([]);
  const [includeArchivedProjects, setIncludeArchivedProjects] = useState(false);
  const [loadingProjects, setLoadingProjects] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // ---- Projects management state ----
  const [newProjName, setNewProjName] = useState("");
  const [newProjPath, setNewProjPath] = useState("");
  const [newProjColor, setNewProjColor] = useState<string>(PROJECT_COLORS[0]);
  const [creatingProject, setCreatingProject] = useState(false);

  const [editingProjId, setEditingProjId] = useState<Uuid | null>(null);
  const [editProjName, setEditProjName] = useState("");
  const [editProjPath, setEditProjPath] = useState("");
  const [editProjColor, setEditProjColor] = useState("#3B82F6");
  const [projectWatchedMap, setProjectWatchedMap] = useState<Record<string, boolean>>(() =>
    loadProjectWatchedMap(),
  );
  const [togglingWatchId, setTogglingWatchId] = useState<Uuid | null>(null);

  // ---- Web AI Bridge state ----
  const [webTask, setWebTask] = useState("");
  const [webProjectId, setWebProjectId] = useState<string>("__all__");
  const [webMaxTokens, setWebMaxTokens] = useState(1500);
  const [buildingContext, setBuildingContext] = useState(false);
  const [webContext, setWebContext] = useState<WebContext | null>(null);
  const [copiedContext, setCopiedContext] = useState(false);

  // ---- Importer state ----
  const [ingestPathsList, setIngestPathsList] = useState<string[]>([]);
  const [ingestProjectId, setIngestProjectId] = useState<string>("__global__");
  const [ingestWatch, setIngestWatch] = useState(false);
  const [ingestReusable, setIngestReusable] = useState(false);
  const [ingestOcr, setIngestOcr] = useState(true);

  const [pastLifeSource, setPastLifeSource] = useState<PastLifeSource>("chatgpt_export");
  const [pastLifePath, setPastLifePath] = useState("");
  const [pastLifeProjectId, setPastLifeProjectId] = useState<string>("__global__");

  // ---- Capsules state ----
  const [capsuleProjectId, setCapsuleProjectId] = useState<string>("__all__");
  const [capsuleExporting, setCapsuleExporting] = useState(false);
  const [capsuleImporting, setCapsuleImporting] = useState(false);
  const [capsuleManifest, setCapsuleManifest] = useState<CapsuleManifest | null>(null);
  const [capsuleImportReport, setCapsuleImportReport] = useState<ImportReport | null>(null);

  // ---- Backup state ----
  const [backupPassword, setBackupPassword] = useState("");
  const [backupIncludeHistory, setBackupIncludeHistory] = useState(true);
  const [backupExporting, setBackupExporting] = useState(false);
  const [backupManifest, setBackupManifest] = useState<BackupManifest | null>(null);

  const [restorePassword, setRestorePassword] = useState("");
  const [backupImporting, setBackupImporting] = useState(false);
  const [backupImportReport, setBackupImportReport] = useState<ImportReport | null>(null);

  const flashNotice = useCallback((msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 3200);
  }, []);

  const loadProjects = useCallback(async () => {
    setLoadingProjects(true);
    try {
      const list = await backendCall("list_projects", {
        include_archived: includeArchivedProjects,
      });
      setProjects(list);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingProjects(false);
    }
  }, [includeArchivedProjects]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const { isDragging } = useFileDrop((paths) => {
    setIngestPathsList((prev) => [...new Set([...prev, ...paths])]);
  }, activeTab === "importer" && !readOnly);

  const { regular: regularProjects, unsorted: unsortedProject } = useMemo(
    () => splitProjects(projects),
    [projects],
  );

  const projectOptionsGlobal = useMemo<SelectOption<string>[]>(
    () => [
      { value: "__global__", label: t("brain.globalScope") },
      ...regularProjects
        .filter((p) => !p.project.is_archived)
        .map((p) => ({ value: p.project.id, label: p.project.name })),
    ],
    [regularProjects, t],
  );

  const projectOptionsAll = useMemo<SelectOption<string>[]>(
    () => [
      { value: "__all__", label: t("tools.allProjects") },
      ...regularProjects
        .filter((p) => !p.project.is_archived)
        .map((p) => ({ value: p.project.id, label: p.project.name })),
      ...(unsortedProject && !unsortedProject.project.is_archived
        ? [
            {
              value: unsortedProject.project.id,
              label:
                unsortedProject.vector_count > 0
                  ? `${UNSORTED_PROJECT_NAME} (${unsortedProject.vector_count})`
                  : UNSORTED_PROJECT_NAME,
              detail: t("unsorted.shortDetail"),
            },
          ]
        : []),
    ],
    [regularProjects, t, unsortedProject],
  );

  const handleLocateUnsortedMemory = useCallback(
    (memoryId: Uuid) => {
      resetVisualFilters();
      setSelectedNodeId(memoryId);
      setActiveNav("brain");
    },
    [resetVisualFilters, setActiveNav, setSelectedNodeId],
  );

  const pastLifeOptions = useMemo<SelectOption<PastLifeSource>[]>(
    () =>
      PAST_LIFE_SOURCES.map((src) => ({
        value: src,
        label: t(`tools.pastLife.sources.${src}`),
        detail: t(`tools.pastLife.hints.${src}`),
      })),
    [t],
  );

  // ---- Project handlers ----
  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (readOnly || !newProjName.trim()) return;
    setCreatingProject(true);
    setError(null);
    try {
      await backendCall("create_project", {
        name: newProjName.trim(),
        root_path: newProjPath.trim() || null,
        color_hex: newProjColor,
      });
      setNewProjName("");
      setNewProjPath("");
      await Promise.all([loadProjects(), loadGraph()]);
      flashNotice(t("tools.projects.createdNotice"));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingProject(false);
    }
  };

  const handleSaveProjectEdit = async (id: Uuid) => {
    if (readOnly || !editProjName.trim()) return;
    setError(null);
    try {
      await backendCall("update_project", {
        id,
        patch: {
          name: editProjName.trim(),
          root_path: editProjPath.trim() ? editProjPath.trim() : null,
          color_hex: editProjColor,
        },
      });
      setEditingProjId(null);
      await Promise.all([loadProjects(), loadGraph()]);
      flashNotice(t("tools.projects.updatedNotice"));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleToggleProjectArchive = async (id: Uuid, archived: boolean) => {
    if (readOnly) return;
    setError(null);
    try {
      await backendCall("update_project", {
        id,
        patch: { is_archived: archived },
      });
      await Promise.all([loadProjects(), loadGraph()]);
      flashNotice(
        archived ? t("tools.projects.archivedNotice") : t("tools.projects.restoredNotice"),
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleToggleProjectWatched = async (
    projectId: Uuid,
    projectName: string,
    watched: boolean,
  ) => {
    if (readOnly) return;
    setTogglingWatchId(projectId);
    setError(null);
    try {
      const applied = await backendCall("set_project_watched", {
        project_id: projectId,
        watched,
      });
      setProjectWatchedMap((prev) => {
        const next = { ...prev, [projectId]: applied };
        saveProjectWatchedMap(next);
        return next;
      });
      flashNotice(
        applied
          ? t("tools.projects.watchEnabledNotice", { name: projectName })
          : t("tools.projects.watchDisabledNotice", { name: projectName }),
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTogglingWatchId(null);
    }
  };

  // ---- Web AI Bridge handlers ----
  const handleBuildWebContext = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!webTask.trim()) return;
    setBuildingContext(true);
    setError(null);
    try {
      const ctx = await backendCall("build_web_context", {
        task: webTask.trim(),
        project_id: webProjectId === "__all__" ? null : webProjectId,
        max_tokens: Math.max(200, Math.min(16000, webMaxTokens)),
      });
      setWebContext(ctx);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBuildingContext(false);
    }
  };

  const handleCopyWebContext = async () => {
    if (!webContext) return;
    const ok = await copyToClipboard(webContext.text);
    if (ok) {
      setCopiedContext(true);
      window.setTimeout(() => setCopiedContext(false), 1800);
    }
  };

  // ---- Importer handlers ----
  const handleAddFiles = async (directory: boolean) => {
    const picked = await pickPaths({
      title: directory ? t("tools.importer.pickFolder") : t("tools.importer.pickFiles"),
      directory,
      multiple: true,
    });
    if (picked.length > 0) {
      setIngestPathsList((prev) => [...new Set([...prev, ...picked])]);
    }
  };

  const handleRunIngest = () => {
    if (readOnly || ingestPathsList.length === 0) return;
    const pathsToIngest = [...ingestPathsList];
    setError(null);
    setIngestPathsList([]);
    void startIngestPaths({
      paths: pathsToIngest,
      project_id: ingestProjectId === "__global__" ? null : ingestProjectId,
      watch: ingestWatch,
      mark_reusable: ingestReusable,
      ocr: ingestOcr,
    });
  };

  const handlePickPastLife = async () => {
    const isDir = pastLifeSource === "markdown_folder";
    const picked = await pickSinglePath({
      title: t("tools.pastLife.pickTitle"),
      directory: isDir,
    });
    if (picked) setPastLifePath(picked);
  };

  const handleRunPastLife = () => {
    const trimmed = pastLifePath.trim();
    if (readOnly || !trimmed) return;
    setError(null);
    setPastLifePath("");
    void startImportPastLife(
      {
        source: pastLifeSource,
        path: trimmed,
        project_id: pastLifeProjectId === "__global__" ? null : pastLifeProjectId,
      },
      {
        label: t(`tools.pastLife.sources.${pastLifeSource}`),
      },
    );
  };

  // ---- Capsules handlers ----
  const handleExportCapsule = async () => {
    const destPath = await pickSavePath({
      title: t("tools.capsules.exportDialogTitle"),
      defaultPath: "cobalt-capsule.cbrain",
      filters: [{ name: "Cobalt Capsule", extensions: ["cbrain"] }],
    });
    if (!destPath) return;

    setCapsuleExporting(true);
    setError(null);
    setCapsuleManifest(null);
    try {
      const manifest = await backendCall("export_capsule", {
        project_id: capsuleProjectId === "__all__" ? null : capsuleProjectId,
        memory_ids: [],
        dest_path: destPath,
      });
      setCapsuleManifest(manifest);
      flashNotice(t("tools.capsules.exportedNotice"));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCapsuleExporting(false);
    }
  };

  const handleImportCapsule = async () => {
    if (readOnly) return;
    const path = await pickSinglePath({
      title: t("tools.capsules.importDialogTitle"),
      filters: [{ name: "Cobalt Capsule", extensions: ["cbrain"] }],
    });
    if (!path) return;

    setCapsuleImporting(true);
    setError(null);
    setCapsuleImportReport(null);
    try {
      const report = await backendCall("import_capsule", { path });
      setCapsuleImportReport(report);
      await Promise.all([loadProjects(), loadGraph()]);
      flashNotice(t("tools.capsules.importedNotice"));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCapsuleImporting(false);
    }
  };

  // ---- Backup handlers ----
  const handleExportBackup = async () => {
    const destPath = await pickSavePath({
      title: t("tools.backup.exportDialogTitle"),
      defaultPath: "cobalt-brain.cobalt-backup",
      filters: [{ name: "Cobalt Backup", extensions: ["cobalt-backup"] }],
    });
    if (!destPath) return;

    setBackupExporting(true);
    setError(null);
    setBackupManifest(null);
    try {
      const manifest = await backendCall("export_backup", {
        dest_path: destPath,
        password: backupPassword.trim() || null,
        include_history: backupIncludeHistory,
      });
      setBackupManifest(manifest);
      setBackupPassword("");
      flashNotice(t("tools.backup.exportedNotice"));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBackupExporting(false);
    }
  };

  const handleImportBackup = async () => {
    if (readOnly) return;
    const path = await pickSinglePath({
      title: t("tools.backup.importDialogTitle"),
      filters: [{ name: "Cobalt Backup", extensions: ["cobalt-backup"] }],
    });
    if (!path) return;

    setBackupImporting(true);
    setError(null);
    setBackupImportReport(null);
    try {
      const report = await backendCall("import_backup", {
        path,
        password: restorePassword.trim() || null,
      });
      setBackupImportReport(report);
      setRestorePassword("");
      await Promise.all([loadProjects(), loadGraph()]);
      flashNotice(t("tools.backup.importedNotice"));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBackupImporting(false);
    }
  };

  const tabs: Array<{ id: ToolsTab; icon: typeof FolderKanban }> = [
    { id: "projects", icon: FolderKanban },
    { id: "web_bridge", icon: Globe },
    { id: "importer", icon: FileUp },
    { id: "capsules", icon: Package },
    { id: "backup", icon: HardDriveDownload },
  ];

  const latestFinishedIngestJob = useMemo(
    () =>
      ingestJobs.find((j) => j.status !== "running" && (j.report !== null || j.error !== null)) ??
      null,
    [ingestJobs],
  );
  const latestAnalyzedReport = useMemo(
    () =>
      latestFinishedIngestJob?.report
        ? analyzeIngestReport(latestFinishedIngestJob.report)
        : null,
    [latestFinishedIngestJob],
  );
  const latestJobHasOcrError = Boolean(
    latestFinishedIngestJob &&
      (isOcrNotInstalledMessage(latestFinishedIngestJob.error) ||
        reportHasOcrNotInstalledError(latestFinishedIngestJob.report)),
  );
  const ocrInstalled = Boolean(ocrStatus && isEngineStateInstalled(ocrStatus.state));

  return (
    <div className="relative h-full overflow-y-auto bg-void p-6 lg:p-8">
      {isDragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-void/80 backdrop-blur-xs">
          <div className="flex flex-col items-center gap-3 rounded-[2px] border-2 border-dashed border-cobalt bg-cobalt-wash/90 px-10 py-8 text-center">
            <Upload size={28} className="text-cobalt-ink" aria-hidden />
            <div className="text-lg font-semibold tracking-tight text-bone">
              {t("tools.importer.dropOverlayTitle")}
            </div>
            <p className="text-xs text-bone-muted">{t("tools.importer.dropOverlayHint")}</p>
          </div>
        </div>
      )}

      <div className="mx-auto max-w-5xl space-y-6">
        {/* Header */}
        <header className="border-b border-rule pb-5">
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight text-bone sm:text-3xl">
              {t("tools.title")}
            </h1>
          </div>
          <p className="mt-1.5 text-sm text-bone-muted">{t("tools.subtitle")}</p>

          {/* Sub-navigation tabs */}
          <div className="mt-4 flex flex-wrap gap-1.5">
            {tabs.map(({ id, icon: Icon }) => {
              const active = activeTab === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setActiveTab(id);
                    setError(null);
                  }}
                  className={`inline-flex items-center gap-2 rounded-[2px] border px-3 py-1.5 font-mono text-xs transition-colors ${
                    active
                      ? "border-cobalt-rule bg-cobalt-wash font-semibold text-bone"
                      : "border-rule bg-surface text-bone-muted hover:border-rule-strong hover:text-bone"
                  }`}
                >
                  <Icon
                    size={13}
                    className={active ? "text-cobalt-ink" : "text-bone-subtle"}
                    aria-hidden
                  />
                  {t(`tools.tabs.${id}`)}
                </button>
              );
            })}
          </div>
        </header>

        {readOnly && (
          <div className="flex items-center gap-2 rounded-[2px] border border-ochre-rule bg-ochre-wash px-4 py-2.5 text-xs text-ochre">
            <ShieldAlert size={14} className="shrink-0" aria-hidden />
            <span>{t("inspector.readOnlyNotice")}</span>
          </div>
        )}
        {error && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-[2px] border border-cinnabar-rule bg-cinnabar-wash px-4 py-2.5 text-xs text-cinnabar">
            <span>{error}</span>
            {isOcrNotInstalledMessage(error) && (
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

        {/* TAB 1: PROJECTS */}
        {activeTab === "projects" && (
          <div className="cobalt-view-enter space-y-5">
            <form
              onSubmit={(e) => void handleCreateProject(e)}
              className="space-y-4 rounded-[2px] border border-rule bg-surface p-5"
            >
              <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-cobalt-ink">
                {t("tools.projects.newTitle")}
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="space-y-1">
                  <label className="font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
                    {t("tools.projects.nameLabel")}
                  </label>
                  <input
                    type="text"
                    value={newProjName}
                    disabled={readOnly || creatingProject}
                    onChange={(e) => setNewProjName(e.target.value)}
                    placeholder={t("tools.projects.namePlaceholder")}
                    className="h-9 w-full rounded-[2px] border border-rule-strong bg-void px-3 text-xs text-bone placeholder:text-bone-subtle focus:border-cobalt-ink focus:outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
                    {t("tools.projects.folderLabel")}
                  </label>
                  <div className="flex gap-1.5">
                    <input
                      type="text"
                      value={newProjPath}
                      disabled={readOnly || creatingProject}
                      onChange={(e) => setNewProjPath(e.target.value)}
                      placeholder={t("tools.projects.folderPlaceholder")}
                      className="h-9 flex-1 rounded-[2px] border border-rule-strong bg-void px-3 font-mono text-xs text-bone placeholder:text-bone-subtle focus:border-cobalt-ink focus:outline-none"
                    />
                    <button
                      type="button"
                      disabled={readOnly || creatingProject}
                      onClick={() =>
                        void pickSinglePath({
                          title: t("tools.projects.pickFolder"),
                          directory: true,
                        }).then((p) => {
                          if (p) setNewProjPath(p);
                        })
                      }
                      className="inline-flex h-9 items-center gap-1 rounded-[2px] border border-rule-strong bg-surface-2 px-2.5 font-mono text-[11px] text-bone-muted hover:text-bone"
                    >
                      <FolderOpen size={12} aria-hidden />
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
                    {t("tools.projects.colorLabel")}
                  </span>
                  {PROJECT_COLORS.map((hex) => (
                    <button
                      key={hex}
                      type="button"
                      onClick={() => setNewProjColor(hex)}
                      aria-label={hex}
                      className={`h-6 w-6 rounded-[2px] border transition-transform ${
                        newProjColor === hex
                          ? "scale-110 border-bone ring-1 ring-bone"
                          : "border-rule-strong"
                      }`}
                      style={{ backgroundColor: hex }}
                    />
                  ))}
                  <input
                    type="color"
                    value={newProjColor}
                    onChange={(e) => setNewProjColor(e.target.value)}
                    aria-label={t("tools.projects.customColor")}
                    className="h-6 w-8 cursor-pointer rounded-[2px] border border-rule-strong bg-void p-0.5"
                  />
                </div>

                <button
                  type="submit"
                  disabled={readOnly || creatingProject || !newProjName.trim()}
                  className="inline-flex items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-4 py-1.5 font-mono text-xs font-semibold text-bone hover:bg-cobalt-bright disabled:opacity-45"
                >
                  {creatingProject ? (
                    <Loader2 size={12} className="animate-spin" aria-hidden />
                  ) : (
                    <Plus size={12} aria-hidden />
                  )}
                  {t("tools.projects.createButton")}
                </button>
              </div>
            </form>

            {/* Distinct "Sin clasificar" isolation bucket */}
            {unsortedProject && (
              <div className="space-y-3">
                <section className="rounded-[2px] border border-dashed border-rule-strong bg-surface-2/55 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <div
                        className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[2px] border border-rule-strong bg-void"
                        aria-hidden
                      >
                        <Inbox size={15} style={{ color: UNSORTED_PROJECT_COLOR }} />
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-[1px]"
                            style={{ backgroundColor: UNSORTED_PROJECT_COLOR }}
                            aria-hidden
                          />
                          <span className="text-sm font-semibold text-bone-muted">
                            {UNSORTED_PROJECT_NAME}
                          </span>
                          {unsortedProject.vector_count > 0 && (
                            <span className="inline-flex min-w-[1.35rem] items-center justify-center rounded-[2px] border border-rule-strong bg-void px-1.5 py-0.5 font-mono text-[10px] leading-none font-semibold tabular-nums text-bone-muted">
                              {unsortedProject.vector_count}
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-bone-subtle">
                          {t("unsorted.explanation")}
                        </p>
                        <div className="mt-1.5 flex flex-wrap gap-3 font-mono text-[10px] tabular-nums text-bone-subtle">
                          <span>
                            {t("brain.nodesCount", { count: unsortedProject.vector_count })}
                          </span>
                          <span>
                            {t("brain.tokens", { count: unsortedProject.total_tokens })}
                          </span>
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => setUnsortedViewOpen(!unsortedViewOpen)}
                      aria-expanded={unsortedViewOpen}
                      className="inline-flex items-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface px-3 py-1.5 font-mono text-[11px] font-medium text-bone-muted transition-colors hover:border-cobalt-ink/60 hover:text-bone"
                    >
                      <FolderInput size={12} aria-hidden />
                      <span>
                        {unsortedViewOpen ? t("unsorted.hideList") : t("unsorted.reviewAndMove")}
                      </span>
                      {unsortedViewOpen ? (
                        <ChevronUp size={12} aria-hidden />
                      ) : (
                        <ChevronDown size={12} aria-hidden />
                      )}
                    </button>
                  </div>
                </section>

                {unsortedViewOpen && (
                  <UnsortedMemoriesPanel
                    unsortedProject={unsortedProject}
                    regularProjects={regularProjects}
                    readOnly={readOnly}
                    onMoved={loadProjects}
                    onInspectMemory={handleLocateUnsortedMemory}
                    onClose={() => setUnsortedViewOpen(false)}
                  />
                )}
              </div>
            )}

            {/* Project list */}
            <section className="rounded-[2px] border border-rule bg-surface p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-rule pb-3">
                <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-bone-subtle">
                  {t("tools.projects.listTitle")} ({regularProjects.length})
                </h2>
                <label className="flex items-center gap-2 text-xs text-bone-muted">
                  <Toggle
                    checked={includeArchivedProjects}
                    ariaLabel={t("tools.projects.showArchived")}
                    onChange={setIncludeArchivedProjects}
                  />
                  <span>{t("tools.projects.showArchived")}</span>
                </label>
              </div>

              {loadingProjects && regularProjects.length === 0 ? (
                <div className="divide-y divide-rule" aria-busy="true" aria-label={t("shell.loading")}>
                  {[0, 1, 2].map((idx) => (
                    <div key={idx} className="flex items-center justify-between gap-4 py-3.5">
                      <div className="min-w-0 flex-1 space-y-2">
                        <Skeleton className="h-4 w-40" />
                        <Skeleton className="h-3 w-64" />
                      </div>
                      <Skeleton className="h-6 w-24 shrink-0" />
                    </div>
                  ))}
                </div>
              ) : regularProjects.length === 0 ? (
                <p className="py-6 text-center text-xs text-bone-subtle">
                  {t("tools.projects.empty")}
                </p>
              ) : (
                <div className="divide-y divide-rule">
                  {regularProjects.map(({ project, vector_count, total_tokens, reusable_count }, idx) => {
                    const isEditing = editingProjId === project.id;
                    return (
                      <div
                        key={project.id}
                        style={staggerStyle(idx, 22, 10)}
                        className="cobalt-stagger-item py-3.5"
                      >
                        {isEditing ? (
                          <div className="space-y-3 rounded-[2px] border border-cobalt-rule bg-void p-3">
                            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                              <input
                                type="text"
                                value={editProjName}
                                onChange={(e) => setEditProjName(e.target.value)}
                                className="h-8 rounded-[2px] border border-rule-strong bg-surface px-2.5 text-xs text-bone focus:border-cobalt-ink focus:outline-none"
                              />
                              <input
                                type="text"
                                value={editProjPath}
                                onChange={(e) => setEditProjPath(e.target.value)}
                                placeholder={t("tools.projects.folderPlaceholder")}
                                className="h-8 rounded-[2px] border border-rule-strong bg-surface px-2.5 font-mono text-xs text-bone focus:border-cobalt-ink focus:outline-none"
                              />
                            </div>
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="flex items-center gap-1.5">
                                {PROJECT_COLORS.map((hex) => (
                                  <button
                                    key={hex}
                                    type="button"
                                    onClick={() => setEditProjColor(hex)}
                                    className={`h-5 w-5 rounded-[2px] border ${
                                      editProjColor === hex
                                        ? "border-bone ring-1 ring-bone"
                                        : "border-rule-strong"
                                    }`}
                                    style={{ backgroundColor: hex }}
                                  />
                                ))}
                                <input
                                  type="color"
                                  value={editProjColor}
                                  onChange={(e) => setEditProjColor(e.target.value)}
                                  className="h-5 w-7 cursor-pointer rounded-[2px] border border-rule-strong bg-surface"
                                />
                              </div>
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => setEditingProjId(null)}
                                  className="rounded-[2px] border border-rule-strong bg-surface-2 px-2.5 py-1 font-mono text-[11px] text-bone-muted hover:text-bone"
                                >
                                  {t("common.cancel")}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void handleSaveProjectEdit(project.id)}
                                  className="inline-flex items-center gap-1 rounded-[2px] border border-cobalt-rule bg-cobalt px-3 py-1 font-mono text-[11px] font-semibold text-bone hover:bg-cobalt-bright"
                                >
                                  <Save size={11} aria-hidden />
                                  {t("common.apply")}
                                </button>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="flex min-w-0 items-start gap-3">
                              <span
                                className="mt-1 h-3.5 w-3.5 shrink-0 rounded-[2px] border border-rule-strong"
                                style={{ backgroundColor: project.color_hex }}
                              />
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-medium text-bone">
                                    {project.name}
                                  </span>
                                  {project.is_archived && (
                                    <span className="rounded-[2px] border border-rule bg-surface-2 px-1.5 py-0.5 font-mono text-[9px] uppercase text-bone-subtle">
                                      {t("statuses.archived")}
                                    </span>
                                  )}
                                </div>
                                {project.root_path && (
                                  <div className="mt-0.5 truncate font-mono text-[11px] text-bone-subtle">
                                    {project.root_path}
                                  </div>
                                )}
                                <div className="mt-1 flex flex-wrap gap-3 font-mono text-[10px] tabular-nums text-bone-muted">
                                  <span>{t("brain.nodesCount", { count: vector_count })}</span>
                                  <span>{t("brain.tokens", { count: total_tokens })}</span>
                                  <span className="text-pulse-reuse">
                                    {reusable_count} {t("brain.reusable").toLowerCase()}
                                  </span>
                                </div>
                              </div>
                            </div>

                            <div className="flex flex-wrap items-center gap-2">
                              <label
                                title={
                                  project.root_path
                                    ? t("tools.projects.watchProjectHint")
                                    : t("tools.projects.watchNeedsFolder")
                                }
                                className={`inline-flex items-center gap-1.5 rounded-[2px] border border-rule bg-void px-2 py-1 font-mono text-[10px] ${
                                  project.root_path && !project.is_archived
                                    ? "text-bone-muted"
                                    : "text-bone-subtle opacity-60"
                                }`}
                              >
                                <FolderSync
                                  size={10}
                                  className={
                                    Boolean(project.root_path) &&
                                    !project.is_archived &&
                                    (projectWatchedMap[project.id] ?? autoWatchProjects)
                                      ? "text-verdigris"
                                      : "text-bone-subtle"
                                  }
                                  aria-hidden
                                />
                                <span>{t("tools.projects.watchProject")}</span>
                                <Toggle
                                  checked={
                                    Boolean(project.root_path) &&
                                    !project.is_archived &&
                                    (projectWatchedMap[project.id] ?? autoWatchProjects)
                                  }
                                  disabled={
                                    readOnly ||
                                    project.is_archived ||
                                    !project.root_path ||
                                    togglingWatchId === project.id
                                  }
                                  ariaLabel={`${t("tools.projects.watchProject")}: ${project.name}`}
                                  onChange={(checked) =>
                                    void handleToggleProjectWatched(project.id, project.name, checked)
                                  }
                                />
                              </label>
                              <button
                                type="button"
                                disabled={readOnly}
                                onClick={() => {
                                  setEditingProjId(project.id);
                                  setEditProjName(project.name);
                                  setEditProjPath(project.root_path ?? "");
                                  setEditProjColor(project.color_hex);
                                }}
                                className="inline-flex items-center gap-1 rounded-[2px] border border-rule-strong bg-surface-2 px-2.5 py-1 font-mono text-[10px] text-bone-muted hover:text-bone disabled:opacity-45"
                              >
                                <Edit3 size={10} aria-hidden />
                                {t("inspector.editContent")}
                              </button>
                              <button
                                type="button"
                                disabled={readOnly}
                                onClick={() =>
                                  void handleToggleProjectArchive(project.id, !project.is_archived)
                                }
                                className="inline-flex items-center gap-1 rounded-[2px] border border-rule-strong bg-surface-2 px-2.5 py-1 font-mono text-[10px] text-bone-muted hover:text-bone disabled:opacity-45"
                              >
                                {project.is_archived ? (
                                  <>
                                    <RotateCcw size={10} aria-hidden />
                                    {t("inspector.restore")}
                                  </>
                                ) : (
                                  <>
                                    <Archive size={10} aria-hidden />
                                    {t("inspector.archive")}
                                  </>
                                )}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        )}

        {/* TAB 2: WEB AI BRIDGE */}
        {activeTab === "web_bridge" && (
          <section className="cobalt-view-enter space-y-4 rounded-[2px] border border-rule bg-surface p-5">
            <div>
              <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-cobalt-ink">
                {t("tools.webBridge.title")}
              </h2>
              <p className="mt-1 text-xs text-bone-muted">{t("tools.webBridge.subtitle")}</p>
            </div>

            <form onSubmit={(e) => void handleBuildWebContext(e)} className="space-y-3">
              <textarea
                rows={4}
                value={webTask}
                onChange={(e) => setWebTask(e.target.value)}
                placeholder={t("tools.webBridge.taskPlaceholder")}
                className="w-full rounded-[2px] border border-rule-strong bg-void p-3 text-xs leading-relaxed text-bone placeholder:text-bone-subtle focus:border-cobalt-ink focus:outline-none"
              />

              <div className="flex flex-wrap items-center gap-3">
                <Select<string>
                  value={webProjectId}
                  options={projectOptionsAll}
                  size="sm"
                  className="w-48"
                  onChange={setWebProjectId}
                />
                <div className="flex items-center gap-2 font-mono text-xs text-bone-muted">
                  <span>{t("tools.webBridge.maxTokens")}</span>
                  <input
                    type="number"
                    min={200}
                    max={16000}
                    step={100}
                    value={webMaxTokens}
                    onChange={(e) => setWebMaxTokens(Number(e.target.value))}
                    className="h-7 w-24 rounded-[2px] border border-rule-strong bg-void px-2 font-mono text-xs text-bone focus:border-cobalt-ink focus:outline-none"
                  />
                </div>
                <button
                  type="submit"
                  disabled={buildingContext || !webTask.trim()}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-4 py-1.5 font-mono text-xs font-semibold text-bone hover:bg-cobalt-bright disabled:opacity-45"
                >
                  {buildingContext ? (
                    <Loader2 size={12} className="animate-spin" aria-hidden />
                  ) : (
                    <Sparkles size={12} aria-hidden />
                  )}
                  {t("tools.webBridge.buildButton")}
                </button>
              </div>
            </form>

            {webContext && (
              <div className="space-y-2.5 border-t border-rule pt-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-3 font-mono text-[11px] tabular-nums text-bone-muted">
                    <span className="text-verdigris">
                      {t("brain.tokens", { count: webContext.tokens })}
                    </span>
                    <span>
                      {t("tools.webBridge.memoriesIncluded", {
                        count: webContext.memory_ids.length,
                      })}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleCopyWebContext()}
                    className="inline-flex items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-3 py-1 font-mono text-xs font-semibold text-bone hover:bg-cobalt-bright"
                  >
                    {copiedContext ? (
                      <Check size={12} aria-hidden />
                    ) : (
                      <Copy size={12} aria-hidden />
                    )}
                    {copiedContext
                      ? t("common.copied")
                      : t("tools.webBridge.copyButton")}
                  </button>
                </div>
                <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-[2px] border border-rule bg-void p-3.5 font-mono text-xs leading-relaxed text-bone">
                  {webContext.text}
                </pre>
              </div>
            )}
          </section>
        )}

        {/* TAB 3: IMPORTER */}
        {activeTab === "importer" && (
          <div className="cobalt-view-enter space-y-5">
            {/* Direct files/folders (`ingest_paths`) */}
            <section className="space-y-4 rounded-[2px] border border-rule bg-surface p-5">
              <div>
                <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-cobalt-ink">
                  01 — {t("tools.importer.filesTitle")}
                </h2>
                <p className="mt-1 text-xs text-bone-muted">{t("tools.importer.filesSubtitle")}</p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={readOnly}
                  onClick={() => void handleAddFiles(false)}
                  className="inline-flex items-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface-2 px-3 py-1.5 font-mono text-xs text-bone hover:border-cobalt-ink/60 disabled:opacity-45"
                >
                  <FileUp size={13} aria-hidden />
                  {t("tools.importer.addFiles")}
                </button>
                <button
                  type="button"
                  disabled={readOnly}
                  onClick={() => void handleAddFiles(true)}
                  className="inline-flex items-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface-2 px-3 py-1.5 font-mono text-xs text-bone hover:border-cobalt-ink/60 disabled:opacity-45"
                >
                  <FolderOpen size={13} aria-hidden />
                  {t("tools.importer.addFolder")}
                </button>
                <span className="text-xs text-bone-subtle">{t("tools.importer.dropInlineHint")}</span>
              </div>

              {ingestPathsList.length > 0 && (
                <div className="space-y-1 rounded-[2px] border border-rule bg-void p-2.5">
                  {ingestPathsList.map((p) => (
                    <div
                      key={p}
                      className="flex items-center justify-between gap-2 font-mono text-[11px] text-bone-muted"
                    >
                      <span className="truncate">{p}</span>
                      <button
                        type="button"
                        onClick={() =>
                          setIngestPathsList((prev) => prev.filter((item) => item !== p))
                        }
                        className="p-0.5 text-bone-subtle hover:text-cinnabar"
                      >
                        <X size={12} aria-hidden />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-4 border-t border-rule pt-3 text-xs">
                <Select<string>
                  value={ingestProjectId}
                  options={projectOptionsGlobal}
                  size="sm"
                  className="w-44"
                  onChange={setIngestProjectId}
                />
                <label className="flex items-center gap-2 text-bone-muted">
                  <Toggle
                    checked={ingestWatch}
                    disabled={readOnly}
                    ariaLabel={t("tools.importer.watchOption")}
                    onChange={setIngestWatch}
                  />
                  <span>{t("tools.importer.watchOption")}</span>
                </label>
                <label className="flex items-center gap-2 text-bone-muted">
                  <Toggle
                    checked={ingestReusable}
                    disabled={readOnly}
                    ariaLabel={t("tools.importer.reusableOption")}
                    onChange={setIngestReusable}
                  />
                  <span>{t("tools.importer.reusableOption")}</span>
                </label>
                <div className="flex items-center gap-2 text-bone-muted">
                  <label className="flex items-center gap-2">
                    <Toggle
                      checked={ingestOcr}
                      disabled={readOnly}
                      ariaLabel={t("tools.importer.ocrOption")}
                      onChange={setIngestOcr}
                    />
                    <span>{t("tools.importer.ocrOption")}</span>
                  </label>
                  {ocrStatus && !ocrInstalled && (
                    <button
                      type="button"
                      onClick={() => openSettingsSection("ocr")}
                      className="rounded-[2px] border border-cobalt-rule bg-cobalt-wash px-1.5 py-0.5 font-mono text-[10px] font-medium text-cobalt-ink transition-colors hover:bg-cobalt hover:text-bone"
                    >
                      {t("ocr.installAction")}
                    </button>
                  )}
                </div>

                <button
                  type="button"
                  disabled={readOnly || ingestPathsList.length === 0}
                  onClick={handleRunIngest}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-4 py-1.5 font-mono text-xs font-semibold text-bone hover:bg-cobalt-bright disabled:opacity-45"
                >
                  <Upload size={12} aria-hidden />
                  {t("tools.importer.runButton")}
                </button>
              </div>
            </section>

            {/* Past life importer (`import_past_life`) */}
            <section className="space-y-4 rounded-[2px] border border-rule bg-surface p-5">
              <div>
                <h2 className="flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-cobalt-ink">
                  <History size={12} aria-hidden />
                  02 — {t("tools.pastLife.title")}
                </h2>
                <p className="mt-1 text-xs text-bone-muted">{t("tools.pastLife.subtitle")}</p>
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="space-y-1">
                  <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
                    {t("tools.pastLife.sourceLabel")}
                  </span>
                  <Select<PastLifeSource>
                    value={pastLifeSource}
                    options={pastLifeOptions}
                    disabled={readOnly}
                    className="w-full"
                    onChange={(v) => {
                      setPastLifeSource(v);
                      setPastLifePath("");
                    }}
                  />
                </div>

                <div className="space-y-1">
                  <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
                    {t("tools.pastLife.targetProject")}
                  </span>
                  <Select<string>
                    value={pastLifeProjectId}
                    options={projectOptionsGlobal}
                    disabled={readOnly}
                    className="w-full"
                    onChange={setPastLifeProjectId}
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={pastLifePath}
                  disabled={readOnly}
                  onChange={(e) => setPastLifePath(e.target.value)}
                  placeholder={t("tools.pastLife.pathPlaceholder")}
                  className="h-9 flex-1 rounded-[2px] border border-rule-strong bg-void px-3 font-mono text-xs text-bone placeholder:text-bone-subtle focus:border-cobalt-ink focus:outline-none"
                />
                <button
                  type="button"
                  disabled={readOnly}
                  onClick={() => void handlePickPastLife()}
                  className="inline-flex h-9 items-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface-2 px-3 font-mono text-xs text-bone-muted hover:text-bone"
                >
                  <FolderOpen size={13} aria-hidden />
                  {t("tools.importer.browse")}
                </button>
                <button
                  type="button"
                  disabled={readOnly || !pastLifePath.trim()}
                  onClick={handleRunPastLife}
                  className="inline-flex h-9 items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-4 font-mono text-xs font-semibold text-bone hover:bg-cobalt-bright disabled:opacity-45"
                >
                  <Upload size={12} aria-hidden />
                  {t("tools.pastLife.importButton")}
                </button>
              </div>
            </section>

            {/* Latest ingest report (synced with global ingest store) */}
            {latestFinishedIngestJob && (latestAnalyzedReport || latestFinishedIngestJob.error) && (
              <div
                className={`space-y-2.5 rounded-[2px] border p-4 text-xs ${
                  latestFinishedIngestJob.status === "failed" || latestJobHasOcrError
                    ? "border-cinnabar-rule bg-cinnabar-wash/45"
                    : latestFinishedIngestJob.status === "cancelled"
                      ? "border-ochre-rule bg-ochre-wash/50"
                      : "border-verdigris-rule bg-verdigris-wash/60"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div
                    className={`font-mono text-[11px] font-semibold uppercase tracking-[0.1em] ${
                      latestFinishedIngestJob.status === "failed" || latestJobHasOcrError
                        ? "text-cinnabar"
                        : latestFinishedIngestJob.status === "cancelled"
                          ? "text-ochre"
                          : "text-verdigris"
                    }`}
                  >
                    {t("tools.importer.reportTitle")} · {latestFinishedIngestJob.label}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {latestJobHasOcrError && (
                      <button
                        type="button"
                        onClick={() => openSettingsSection("ocr", { autoInstall: true })}
                        className="inline-flex items-center gap-1 rounded-[2px] border border-cobalt-rule bg-cobalt px-2 py-0.5 font-mono text-[10px] font-semibold text-bone hover:bg-cobalt-bright"
                      >
                        <ScanText size={10} aria-hidden />
                        {t("ocr.installAction")}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => openIngestReport(latestFinishedIngestJob.id)}
                      className="inline-flex items-center gap-1 rounded-[2px] border border-cobalt-rule bg-cobalt-wash px-2 py-0.5 font-mono text-[10px] font-medium text-cobalt-ink hover:bg-cobalt hover:text-bone"
                    >
                      <FileText size={10} aria-hidden />
                      {t("ingest.actions.viewReport")}
                    </button>
                  </div>
                </div>
                {latestFinishedIngestJob.error && (
                  <p className="text-xs text-cinnabar">{latestFinishedIngestJob.error}</p>
                )}
                {latestAnalyzedReport && (
                  <>
                    <div className="grid grid-cols-2 gap-2 font-mono text-[11px] tabular-nums sm:grid-cols-4">
                      <div>
                        <span className="text-bone-subtle">{t("tools.importer.docsCreated")}: </span>
                        <strong className="text-bone">{latestAnalyzedReport.documentsCreated}</strong>
                      </div>
                      <div>
                        <span className="text-bone-subtle">{t("tools.importer.docsUpdated")}: </span>
                        <strong className="text-bone">{latestAnalyzedReport.documentsUpdated}</strong>
                      </div>
                      <div>
                        <span className="text-bone-subtle">{t("ingest.report.filesUnchanged")}: </span>
                        <strong className="text-bone">{latestAnalyzedReport.documentsUnchanged}</strong>
                      </div>
                      <div>
                        <span className="text-bone-subtle">{t("tools.importer.memsCreated")}: </span>
                        <strong className="text-bone">{latestAnalyzedReport.memoriesCreated}</strong>
                      </div>
                      <div>
                        <span className="text-bone-subtle">{t("tools.importer.tokensIndexed")}: </span>
                        <strong className="text-bone">
                          {latestAnalyzedReport.totalTokens.toLocaleString()}
                        </strong>
                      </div>
                      <div>
                        <span className="text-bone-subtle">{t("tools.importer.redactedSecrets")}: </span>
                        <strong className="text-ochre">{latestAnalyzedReport.redactedSecrets}</strong>
                      </div>
                      <div>
                        <span className="text-bone-subtle">{t("ingest.report.skipped")}: </span>
                        <strong className="text-ochre">{latestAnalyzedReport.skippedCount}</strong>
                      </div>
                      <div>
                        <span className="text-bone-subtle">{t("ingest.report.errors")}: </span>
                        <strong
                          className={
                            latestAnalyzedReport.errorIssues.length > 0 ? "text-cinnabar" : "text-bone"
                          }
                        >
                          {latestAnalyzedReport.errorIssues.length}
                        </strong>
                      </div>
                    </div>
                    {latestAnalyzedReport.hasOcrNotInstalledError && (
                      <div className="flex flex-wrap items-center justify-between gap-2 rounded-[2px] border border-cinnabar-rule/80 bg-void/70 px-3 py-2 text-[11px] text-cinnabar">
                        <span>{t("ingest.ocrNotInstalledBanner")}</span>
                        <button
                          type="button"
                          onClick={() => openSettingsSection("ocr", { autoInstall: true })}
                          className="inline-flex shrink-0 items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-2.5 py-1 font-mono text-[10px] font-semibold text-bone hover:bg-cobalt-bright"
                        >
                          <ScanText size={10} aria-hidden />
                          {t("ocr.installAction")}
                        </button>
                      </div>
                    )}
                    {latestAnalyzedReport.skippedCount > 0 && (
                      <p className="text-[11px] text-bone-muted">
                        {t("ingest.report.skippedRulesHint")}
                      </p>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* TAB 4: CAPSULES (.cbrain) */}
        {activeTab === "capsules" && (
          <div className="cobalt-view-enter grid grid-cols-1 gap-5 md:grid-cols-2">
            {/* Export */}
            <section
              style={staggerStyle(0, 28)}
              className="cobalt-stagger-item flex flex-col justify-between space-y-4 rounded-[2px] border border-rule bg-surface p-5"
            >
              <div className="space-y-3">
                <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-cobalt-ink">
                  {t("tools.capsules.exportTitle")}
                </h2>
                <p className="text-xs text-bone-muted">{t("tools.capsules.exportSubtitle")}</p>
                <div className="space-y-1">
                  <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
                    {t("tools.capsules.scopeLabel")}
                  </span>
                  <Select<string>
                    value={capsuleProjectId}
                    options={projectOptionsAll}
                    className="w-full"
                    onChange={setCapsuleProjectId}
                  />
                </div>
              </div>

              <div className="space-y-3">
                <button
                  type="button"
                  disabled={capsuleExporting}
                  onClick={() => void handleExportCapsule()}
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-4 py-2 font-mono text-xs font-semibold text-bone hover:bg-cobalt-bright disabled:opacity-45"
                >
                  {capsuleExporting ? (
                    <Loader2 size={13} className="animate-spin" aria-hidden />
                  ) : (
                    <Download size={13} aria-hidden />
                  )}
                  {t("tools.capsules.exportButton")}
                </button>

                {capsuleManifest && (
                  <div className="rounded-[2px] border border-verdigris-rule bg-verdigris-wash/60 p-3 font-mono text-[11px] text-bone-muted">
                    <div className="font-semibold text-verdigris">
                      {t("tools.capsules.exportedNotice")}
                    </div>
                    <div className="mt-1">
                      {capsuleManifest.memory_count} memories · {capsuleManifest.embedding_model_id} (
                      {capsuleManifest.dimensions}d)
                    </div>
                  </div>
                )}
              </div>
            </section>

            {/* Import */}
            <section
              style={staggerStyle(1, 28)}
              className="cobalt-stagger-item flex flex-col justify-between space-y-4 rounded-[2px] border border-rule bg-surface p-5"
            >
              <div className="space-y-3">
                <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-cobalt-ink">
                  {t("tools.capsules.importTitle")}
                </h2>
                <p className="text-xs text-bone-muted">{t("tools.capsules.importSubtitle")}</p>
              </div>

              <div className="space-y-3">
                <button
                  type="button"
                  disabled={readOnly || capsuleImporting}
                  onClick={() => void handleImportCapsule()}
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface-2 px-4 py-2 font-mono text-xs font-semibold text-bone hover:border-cobalt-ink/60 disabled:opacity-45"
                >
                  {capsuleImporting ? (
                    <Loader2 size={13} className="animate-spin" aria-hidden />
                  ) : (
                    <Upload size={13} aria-hidden />
                  )}
                  {t("tools.capsules.importButton")}
                </button>

                {capsuleImportReport && <ImportReportCard report={capsuleImportReport} />}
              </div>
            </section>
          </div>
        )}

        {/* TAB 5: BACKUP (.cobalt-backup) */}
        {activeTab === "backup" && (
          <div className="cobalt-view-enter grid grid-cols-1 gap-5 md:grid-cols-2">
            {/* Export backup */}
            <section
              style={staggerStyle(0, 28)}
              className="cobalt-stagger-item flex flex-col justify-between space-y-4 rounded-[2px] border border-rule bg-surface p-5"
            >
              <div className="space-y-3">
                <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-cobalt-ink">
                  {t("tools.backup.exportTitle")}
                </h2>
                <p className="text-xs text-bone-muted">{t("tools.backup.exportSubtitle")}</p>

                <div className="space-y-1">
                  <label className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
                    <Lock size={10} aria-hidden />
                    {t("tools.backup.passwordLabel")}
                  </label>
                  <input
                    type="password"
                    value={backupPassword}
                    onChange={(e) => setBackupPassword(e.target.value)}
                    placeholder={t("tools.backup.passwordPlaceholder")}
                    className="h-9 w-full rounded-[2px] border border-rule-strong bg-void px-3 text-xs text-bone placeholder:text-bone-subtle focus:border-cobalt-ink focus:outline-none"
                  />
                </div>

                <label className="flex items-center gap-2 text-xs text-bone-muted">
                  <Toggle
                    checked={backupIncludeHistory}
                    ariaLabel={t("tools.backup.includeHistory")}
                    onChange={setBackupIncludeHistory}
                  />
                  <span>{t("tools.backup.includeHistory")}</span>
                </label>
              </div>

              <div className="space-y-3">
                <button
                  type="button"
                  disabled={backupExporting}
                  onClick={() => void handleExportBackup()}
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-4 py-2 font-mono text-xs font-semibold text-bone hover:bg-cobalt-bright disabled:opacity-45"
                >
                  {backupExporting ? (
                    <Loader2 size={13} className="animate-spin" aria-hidden />
                  ) : (
                    <Download size={13} aria-hidden />
                  )}
                  {t("tools.backup.exportButton")}
                </button>

                {backupManifest && (
                  <div className="space-y-1 rounded-[2px] border border-verdigris-rule bg-verdigris-wash/60 p-3 font-mono text-[11px] text-bone-muted">
                    <div className="font-semibold text-verdigris">
                      {t("tools.backup.exportedNotice")}{" "}
                      {backupManifest.encrypted ? `· ${t("inspector.encrypted")}` : ""}
                    </div>
                    <div>
                      {backupManifest.counts.memories} memories · {backupManifest.counts.projects}{" "}
                      projects · {backupManifest.counts.branches} branches
                    </div>
                  </div>
                )}
              </div>
            </section>

            {/* Import backup */}
            <section
              style={staggerStyle(1, 28)}
              className="cobalt-stagger-item flex flex-col justify-between space-y-4 rounded-[2px] border border-rule bg-surface p-5"
            >
              <div className="space-y-3">
                <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-cobalt-ink">
                  {t("tools.backup.importTitle")}
                </h2>
                <p className="text-xs text-bone-muted">{t("tools.backup.importSubtitle")}</p>

                <div className="space-y-1">
                  <label className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
                    <Lock size={10} aria-hidden />
                    {t("tools.backup.decryptPasswordLabel")}
                  </label>
                  <input
                    type="password"
                    value={restorePassword}
                    disabled={readOnly || backupImporting}
                    onChange={(e) => setRestorePassword(e.target.value)}
                    placeholder={t("tools.backup.decryptPasswordPlaceholder")}
                    className="h-9 w-full rounded-[2px] border border-rule-strong bg-void px-3 text-xs text-bone placeholder:text-bone-subtle focus:border-cobalt-ink focus:outline-none"
                  />
                </div>
              </div>

              <div className="space-y-3">
                <button
                  type="button"
                  disabled={readOnly || backupImporting}
                  onClick={() => void handleImportBackup()}
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface-2 px-4 py-2 font-mono text-xs font-semibold text-bone hover:border-cobalt-ink/60 disabled:opacity-45"
                >
                  {backupImporting ? (
                    <Loader2 size={13} className="animate-spin" aria-hidden />
                  ) : (
                    <Upload size={13} aria-hidden />
                  )}
                  {t("tools.backup.importButton")}
                </button>

                {backupImportReport && <ImportReportCard report={backupImportReport} />}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
