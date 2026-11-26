import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Archive,
  Check,
  Copy,
  Download,
  Edit3,
  FileUp,
  FolderKanban,
  FolderOpen,
  Globe,
  HardDriveDownload,
  History,
  Loader2,
  Lock,
  Package,
  Plus,
  RotateCcw,
  Save,
  ShieldAlert,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { backendCall, backendOn } from "@/lib/backend";
import { copyToClipboard, pickPaths, pickSavePath, pickSinglePath, useFileDrop } from "@/lib/dialogs";
import { useMemoryStore, useSettingsStore } from "@/stores";
import { MockBadge } from "@/components/shell/MockBadge";
import { Select, Toggle, type SelectOption } from "@/components/ui";
import type {
  BackupManifest,
  CapsuleManifest,
  ImportReport,
  IngestProgress,
  IngestReport,
  PastLifeSource,
  ProjectStats,
  Uuid,
  WebContext,
} from "@/types/contracts";

type ToolsTab = "projects" | "web_bridge" | "importer" | "capsules" | "backup";

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
  const loadGraph = useMemoryStore((s) => s.loadGraph);

  const [activeTab, setActiveTab] = useState<ToolsTab>("projects");
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
  const [ingestOcr, setIngestOcr] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [ingestProgress, setIngestProgress] = useState<IngestProgress | null>(null);
  const [ingestReport, setIngestReport] = useState<IngestReport | null>(null);

  const [pastLifeSource, setPastLifeSource] = useState<PastLifeSource>("chatgpt_export");
  const [pastLifePath, setPastLifePath] = useState("");
  const [pastLifeProjectId, setPastLifeProjectId] = useState<string>("__global__");
  const [importingPastLife, setImportingPastLife] = useState(false);

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

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;
    void backendOn("cobalt://ingest-progress", (payload) => {
      if (active) setIngestProgress(payload);
    }).then((fn) => {
      if (active) unlisten = fn;
      else fn();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const { isDragging } = useFileDrop((paths) => {
    setIngestPathsList((prev) => [...new Set([...prev, ...paths])]);
  }, activeTab === "importer" && !readOnly);

  const projectOptionsGlobal = useMemo<SelectOption<string>[]>(
    () => [
      { value: "__global__", label: t("brain.globalScope") },
      ...projects
        .filter((p) => !p.project.is_archived)
        .map((p) => ({ value: p.project.id, label: p.project.name })),
    ],
    [projects, t],
  );

  const projectOptionsAll = useMemo<SelectOption<string>[]>(
    () => [
      { value: "__all__", label: t("tools.allProjects") },
      ...projects
        .filter((p) => !p.project.is_archived)
        .map((p) => ({ value: p.project.id, label: p.project.name })),
    ],
    [projects, t],
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
      fallbackPlaceholder: directory ? "/workspace/notes" : "/workspace/notes/guide.md",
    });
    if (picked.length > 0) {
      setIngestPathsList((prev) => [...new Set([...prev, ...picked])]);
    }
  };

  const handleRunIngest = async () => {
    if (readOnly || ingestPathsList.length === 0) return;
    setIngesting(true);
    setError(null);
    setIngestProgress(null);
    setIngestReport(null);
    try {
      const report = await backendCall("ingest_paths", {
        paths: ingestPathsList,
        project_id: ingestProjectId === "__global__" ? null : ingestProjectId,
        watch: ingestWatch,
        mark_reusable: ingestReusable,
        ocr: ingestOcr,
      });
      setIngestReport(report);
      setIngestPathsList([]);
      await loadGraph();
      flashNotice(
        t("tools.importer.doneNotice", { memories: report.memories_created }),
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIngesting(false);
    }
  };

  const handlePickPastLife = async () => {
    const isDir = pastLifeSource === "markdown_folder";
    const picked = await pickSinglePath({
      title: t("tools.pastLife.pickTitle"),
      directory: isDir,
      fallbackPlaceholder: isDir
        ? "/home/user/notes"
        : pastLifeSource === "chatgpt_export"
          ? "/downloads/conversations.json"
          : "/workspace/CLAUDE.md",
    });
    if (picked) setPastLifePath(picked);
  };

  const handleRunPastLife = async () => {
    if (readOnly || !pastLifePath.trim()) return;
    setImportingPastLife(true);
    setError(null);
    setIngestProgress(null);
    setIngestReport(null);
    try {
      const report = await backendCall("import_past_life", {
        source: pastLifeSource,
        path: pastLifePath.trim(),
        project_id: pastLifeProjectId === "__global__" ? null : pastLifeProjectId,
      });
      setIngestReport(report);
      await loadGraph();
      flashNotice(
        t("tools.importer.doneNotice", { memories: report.memories_created }),
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImportingPastLife(false);
    }
  };

  // ---- Capsules handlers ----
  const handleExportCapsule = async () => {
    const destPath = await pickSavePath({
      title: t("tools.capsules.exportDialogTitle"),
      defaultPath: "cobalt-capsule.cbrain",
      filters: [{ name: "Cobalt Capsule", extensions: ["cbrain"] }],
      fallbackPlaceholder: "/exports/cobalt-capsule.cbrain",
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
      fallbackPlaceholder: "/exports/cobalt-capsule.cbrain",
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
      fallbackPlaceholder: "/backups/cobalt-brain.cobalt-backup",
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
      fallbackPlaceholder: "/backups/cobalt-brain.cobalt-backup",
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

  const ingestPct =
    ingestProgress && ingestProgress.total > 0
      ? Math.min(100, Math.round((ingestProgress.processed / ingestProgress.total) * 100))
      : 0;

  return (
    <div className="relative h-full overflow-y-auto bg-void p-6 lg:p-8">
      {isDragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-void/80 backdrop-blur-xs">
          <div className="flex flex-col items-center gap-3 rounded-[2px] border-2 border-dashed border-cobalt bg-cobalt-wash/90 px-10 py-8 text-center">
            <Upload size={28} className="text-cobalt-ink" aria-hidden />
            <div className="font-display text-lg font-medium text-bone">
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
            <h1 className="font-display text-2xl font-medium tracking-tight text-bone sm:text-3xl">
              {t("tools.title")}
            </h1>
            <MockBadge />
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
          <div className="rounded-[2px] border border-cinnabar-rule bg-cinnabar-wash px-4 py-2.5 text-xs text-cinnabar">
            {error}
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
          <div className="space-y-5">
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
                          fallbackPlaceholder: "/workspace/my-project",
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

            {/* Project list */}
            <section className="rounded-[2px] border border-rule bg-surface p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-rule pb-3">
                <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-bone-subtle">
                  {t("tools.projects.listTitle")} ({projects.length})
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

              {loadingProjects && projects.length === 0 ? (
                <div className="flex items-center justify-center gap-2 py-8 font-mono text-xs text-bone-muted">
                  <Loader2 size={14} className="animate-spin text-cobalt-ink" aria-hidden />
                  <span>{t("shell.loading")}</span>
                </div>
              ) : projects.length === 0 ? (
                <p className="py-6 text-center text-xs text-bone-subtle">
                  {t("tools.projects.empty")}
                </p>
              ) : (
                <div className="divide-y divide-rule">
                  {projects.map(({ project, vector_count, total_tokens, reusable_count }) => {
                    const isEditing = editingProjId === project.id;
                    return (
                      <div key={project.id} className="py-3.5">
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

                            <div className="flex items-center gap-1.5">
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
          <section className="space-y-4 rounded-[2px] border border-rule bg-surface p-5">
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
          <div className="space-y-5">
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
                  disabled={readOnly || ingesting}
                  onClick={() => void handleAddFiles(false)}
                  className="inline-flex items-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface-2 px-3 py-1.5 font-mono text-xs text-bone hover:border-cobalt-ink/60 disabled:opacity-45"
                >
                  <FileUp size={13} aria-hidden />
                  {t("tools.importer.addFiles")}
                </button>
                <button
                  type="button"
                  disabled={readOnly || ingesting}
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
                    disabled={readOnly || ingesting}
                    ariaLabel={t("tools.importer.watchOption")}
                    onChange={setIngestWatch}
                  />
                  <span>{t("tools.importer.watchOption")}</span>
                </label>
                <label className="flex items-center gap-2 text-bone-muted">
                  <Toggle
                    checked={ingestReusable}
                    disabled={readOnly || ingesting}
                    ariaLabel={t("tools.importer.reusableOption")}
                    onChange={setIngestReusable}
                  />
                  <span>{t("tools.importer.reusableOption")}</span>
                </label>
                <label className="flex items-center gap-2 text-bone-muted">
                  <Toggle
                    checked={ingestOcr}
                    disabled={readOnly || ingesting}
                    ariaLabel={t("tools.importer.ocrOption")}
                    onChange={setIngestOcr}
                  />
                  <span>{t("tools.importer.ocrOption")}</span>
                </label>

                <button
                  type="button"
                  disabled={readOnly || ingesting || ingestPathsList.length === 0}
                  onClick={() => void handleRunIngest()}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-4 py-1.5 font-mono text-xs font-semibold text-bone hover:bg-cobalt-bright disabled:opacity-45"
                >
                  {ingesting ? (
                    <Loader2 size={12} className="animate-spin" aria-hidden />
                  ) : (
                    <Upload size={12} aria-hidden />
                  )}
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
                    disabled={readOnly || importingPastLife}
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
                    disabled={readOnly || importingPastLife}
                    className="w-full"
                    onChange={setPastLifeProjectId}
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={pastLifePath}
                  disabled={readOnly || importingPastLife}
                  onChange={(e) => setPastLifePath(e.target.value)}
                  placeholder={t("tools.pastLife.pathPlaceholder")}
                  className="h-9 flex-1 rounded-[2px] border border-rule-strong bg-void px-3 font-mono text-xs text-bone placeholder:text-bone-subtle focus:border-cobalt-ink focus:outline-none"
                />
                <button
                  type="button"
                  disabled={readOnly || importingPastLife}
                  onClick={() => void handlePickPastLife()}
                  className="inline-flex h-9 items-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface-2 px-3 font-mono text-xs text-bone-muted hover:text-bone"
                >
                  <FolderOpen size={13} aria-hidden />
                  {t("tools.importer.browse")}
                </button>
                <button
                  type="button"
                  disabled={readOnly || importingPastLife || !pastLifePath.trim()}
                  onClick={() => void handleRunPastLife()}
                  className="inline-flex h-9 items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-4 font-mono text-xs font-semibold text-bone hover:bg-cobalt-bright disabled:opacity-45"
                >
                  {importingPastLife ? (
                    <Loader2 size={12} className="animate-spin" aria-hidden />
                  ) : (
                    <Upload size={12} aria-hidden />
                  )}
                  {t("tools.pastLife.importButton")}
                </button>
              </div>
            </section>

            {/* Live ingest progress */}
            {(ingesting || importingPastLife || ingestProgress) && (
              <div className="space-y-2 rounded-[2px] border border-cobalt-rule bg-cobalt-wash/50 p-4">
                <div className="flex items-center justify-between font-mono text-xs">
                  <span className="inline-flex items-center gap-2 text-cobalt-ink">
                    {(ingesting || importingPastLife) && (
                      <Loader2 size={12} className="animate-spin" aria-hidden />
                    )}
                    {ingestProgress?.stage ?? t("tools.importer.processing")}
                  </span>
                  <span className="tabular-nums text-bone">
                    {ingestProgress
                      ? `${ingestProgress.processed} / ${ingestProgress.total} (${ingestPct}%)`
                      : "…"}
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-[1px] bg-void">
                  <div
                    className="h-full bg-cobalt transition-all duration-200"
                    style={{ width: `${ingestPct}%` }}
                  />
                </div>
                {ingestProgress?.current_path && (
                  <p className="truncate font-mono text-[10px] text-bone-muted">
                    {ingestProgress.current_path}
                  </p>
                )}
              </div>
            )}

            {/* Ingest report */}
            {ingestReport && (
              <div className="space-y-2 rounded-[2px] border border-verdigris-rule bg-verdigris-wash/60 p-4 text-xs">
                <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-verdigris">
                  {t("tools.importer.reportTitle")}
                </div>
                <div className="grid grid-cols-2 gap-2 font-mono text-[11px] tabular-nums sm:grid-cols-4">
                  <div>
                    <span className="text-bone-subtle">{t("tools.importer.docsCreated")}: </span>
                    <strong className="text-bone">{ingestReport.documents_created}</strong>
                  </div>
                  <div>
                    <span className="text-bone-subtle">{t("tools.importer.docsUpdated")}: </span>
                    <strong className="text-bone">{ingestReport.documents_updated}</strong>
                  </div>
                  <div>
                    <span className="text-bone-subtle">{t("tools.importer.memsCreated")}: </span>
                    <strong className="text-bone">{ingestReport.memories_created}</strong>
                  </div>
                  <div>
                    <span className="text-bone-subtle">{t("tools.importer.tokensIndexed")}: </span>
                    <strong className="text-bone">
                      {ingestReport.total_tokens.toLocaleString()}
                    </strong>
                  </div>
                  <div>
                    <span className="text-bone-subtle">{t("tools.importer.redactedSecrets")}: </span>
                    <strong className="text-ochre">{ingestReport.redacted_secrets}</strong>
                  </div>
                  <div>
                    <span className="text-bone-subtle">{t("tools.importer.skippedIgnored")}: </span>
                    <strong className="text-bone">{ingestReport.skipped_ignored}</strong>
                  </div>
                </div>
                {ingestReport.errors.length > 0 && (
                  <div className="space-y-1 border-t border-verdigris-rule/40 pt-2 text-[11px] text-cinnabar">
                    {ingestReport.errors.map((issue, idx) => (
                      <div key={idx} className="font-mono">
                        {issue.path}: {issue.message}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* TAB 4: CAPSULES (.cbrain) */}
        {activeTab === "capsules" && (
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            {/* Export */}
            <section className="flex flex-col justify-between space-y-4 rounded-[2px] border border-rule bg-surface p-5">
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
            <section className="flex flex-col justify-between space-y-4 rounded-[2px] border border-rule bg-surface p-5">
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
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            {/* Export backup */}
            <section className="flex flex-col justify-between space-y-4 rounded-[2px] border border-rule bg-surface p-5">
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
            <section className="flex flex-col justify-between space-y-4 rounded-[2px] border border-rule bg-surface p-5">
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
