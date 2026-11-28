import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Archive,
  Check,
  Copy,
  Edit3,
  Eye,
  EyeOff,
  FileCheck2,
  FolderInput,
  FolderSync,
  GitBranch,
  History,
  Inbox,
  KeyRound,
  Lock,
  LockOpen,
  Pin,
  Radio,
  RefreshCw,
  Repeat,
  RotateCcw,
  Save,
  ScanText,
  ShieldAlert,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { backendCall } from "@/lib/backend";
import { copyToClipboard, pickSinglePath } from "@/lib/dialogs";
import { formatAiClientName } from "@/lib/format";
import { IpcError } from "@/lib/ipc";
import {
  fromMemoryProjectId,
  GLOBAL_PROJECT_SENTINEL,
  isUnsortedProject,
  resolveProjectColor,
  splitProjects,
  toPatchProjectId,
  UNSORTED_PROJECT_COLOR,
  UNSORTED_PROJECT_NAME,
} from "@/lib/projects";
import { cacheSourceDocPath } from "@/lib/sourceDocCache";
import {
  useBranchesStore,
  useMemoryStore,
  useSettingsStore,
  useThemeStore,
} from "@/stores";
import { Select, Skeleton, Toggle, type SelectOption } from "@/components/ui";
import {
  MEMORY_CATEGORIES,
  type ArchiveImpact,
  type FileAvailability,
  type Memory,
  type MemoryCategory,
  type ProjectStats,
  type SourceDocument,
  type Uuid,
} from "@/types/contracts";
import { PermanentDeleteDialog } from "./PermanentDeleteDialog";

interface NodeInspectorProps {
  memoryId: Uuid;
  onClose: () => void;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/**
 * Parse `version_reason` written by MCP tool #8 `archive_memory` (MCP_SPEC §2.8):
 * `"archived by <client>: <reason>"`.
 */
function parseArchivedByReason(
  versionReason: string | null,
  fallbackClient: string | null,
): { agent: string | null; reason: string | null } {
  if (versionReason) {
    const match = /^archived by ([^:]+):\s*(.*)$/i.exec(versionReason.trim());
    if (match) {
      return {
        agent: match[1]?.trim() || fallbackClient,
        reason: match[2]?.trim() || null,
      };
    }
    return {
      agent: fallbackClient,
      reason: versionReason.trim() || null,
    };
  }
  return { agent: fallbackClient, reason: null };
}

export function NodeInspector({ memoryId, onClose }: NodeInspectorProps) {
  const { t } = useTranslation();

  const graph = useMemoryStore((s) => s.graph);
  const graphRevision = useMemoryStore((s) => s.graphRevision);
  const loadGraph = useMemoryStore((s) => s.loadGraph);
  const setSelectedNodeId = useMemoryStore((s) => s.setSelectedNodeId);
  const branches = useBranchesStore((s) => s.branches);
  const readOnly = useSettingsStore((s) => s.settings.read_only);
  const vaultStatus = useSettingsStore((s) => s.vaultStatus);
  const loadVaultStatus = useSettingsStore((s) => s.loadVaultStatus);
  const setVaultStatus = useSettingsStore((s) => s.setVaultStatus);
  const pushThemeToast = useThemeStore((s) => s.pushThemeToast);

  const [memory, setMemory] = useState<Memory | null>(null);
  const [history, setHistory] = useState<Memory[]>([]);
  const [extraProjects, setExtraProjects] = useState<ProjectStats[]>([]);
  const [sourceDoc, setSourceDoc] = useState<SourceDocument | null>(null);
  const [diskStatus, setDiskStatus] = useState<FileAvailability | null>(null);
  const [archiveImpact, setArchiveImpact] = useState<ArchiveImpact | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState(false);

  // Content editing (`update_memory`)
  const [editingContent, setEditingContent] = useState(false);
  const [draftContent, setDraftContent] = useState("");
  const [versionReason, setVersionReason] = useState("");

  // Governance metadata (`patch_memory`)
  const [confidenceDraft, setConfidenceDraft] = useState(1);
  const [snippetDraft, setSnippetDraft] = useState("");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Vault / Encryption state
  const [revealedPlaintext, setRevealedPlaintext] = useState<string | null>(null);
  const [vaultPromptOpen, setVaultPromptOpen] = useState(false);
  const [vaultPassword, setVaultPassword] = useState("");
  const [pendingVaultAction, setPendingVaultAction] = useState<
    "reveal" | "encrypt" | "decrypt" | null
  >(null);

  const flashNotice = useCallback((msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 2600);
  }, []);

  const loadDetails = useCallback(async () => {
    setLoading(true);
    setError(null);
    setRevealedPlaintext(null);
    setEditingContent(false);
    setDeleteDialogOpen(false);
    setSourceDoc(null);
    setArchiveImpact(null);

    try {
      const [mem, hist] = await Promise.all([
        backendCall("get_memory", { id: memoryId }),
        backendCall("get_memory_history", { id: memoryId }),
      ]);
      setMemory(mem);
      setHistory(hist);
      setDraftContent(mem.content);
      setConfidenceDraft(mem.confidence);
      setSnippetDraft(mem.reusable_snippet ?? "");

      // Load archive impact (which AI agents depend on this memory)
      void backendCall("get_archive_impact", { id: mem.id })
        .then(setArchiveImpact)
        .catch(() => setArchiveImpact(null));

      // Load real source document & disk availability
      if (!mem.source_doc_id) {
        setDiskStatus("snippet_only");
      } else {
        const [docRes, statusRes] = await Promise.allSettled([
          backendCall("get_source_document", { id: mem.source_doc_id }),
          backendCall("verify_source_document", { id: mem.source_doc_id }),
        ]);
        if (docRes.status === "fulfilled") {
          setSourceDoc(docRes.value);
          cacheSourceDocPath(docRes.value.id, docRes.value.file_path);
        }
        if (statusRes.status === "fulfilled") {
          setDiskStatus(statusRes.value);
        } else {
          setDiskStatus("snippet_only");
        }
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setMemory(null);
      setHistory([]);
    } finally {
      setLoading(false);
    }
  }, [memoryId]);

  useEffect(() => {
    void loadDetails();
  }, [loadDetails, graphRevision]);

  useEffect(() => {
    void backendCall("list_projects", { include_archived: false })
      .then(setExtraProjects)
      .catch(() => {});
  }, [graphRevision]);

  const allProjects = useMemo(() => {
    const byId = new Map<Uuid, ProjectStats>();
    for (const stat of extraProjects) byId.set(stat.project.id, stat);
    for (const stat of graph?.projects ?? []) byId.set(stat.project.id, stat);
    return [...byId.values()];
  }, [extraProjects, graph?.projects]);

  const { regular: regularProjects } = useMemo(() => splitProjects(allProjects), [allProjects]);

  const currentProject = useMemo(() => {
    if (!memory?.project_id) return null;
    return allProjects.find((s) => s.project.id === memory.project_id)?.project ?? null;
  }, [allProjects, memory?.project_id]);

  const isInUnsorted = isUnsortedProject(currentProject);

  const projectOptions = useMemo<SelectOption<string>[]>(() => {
    const opts: SelectOption<string>[] = [];
    if (isInUnsorted && currentProject) {
      opts.push({
        value: currentProject.id,
        label: UNSORTED_PROJECT_NAME,
        detail: t("unsorted.shortDetail"),
        disabled: true,
      });
    }
    opts.push({ value: GLOBAL_PROJECT_SENTINEL, label: t("brain.globalScope") });
    for (const stat of regularProjects) {
      if (stat.project.is_archived && stat.project.id !== memory?.project_id) continue;
      opts.push({
        value: stat.project.id,
        label: stat.project.name,
      });
    }
    return opts;
  }, [currentProject, isInUnsorted, memory?.project_id, regularProjects, t]);

  const handleMoveToProject = async (targetValue: string) => {
    if (!memory || readOnly) return;
    const nextProjectId = toPatchProjectId(targetValue);
    if (nextProjectId === memory.project_id) return;
    const targetName =
      nextProjectId === null
        ? t("brain.globalScope")
        : (regularProjects.find((p) => p.project.id === nextProjectId)?.project.name ??
          t("brain.globalScope"));
    setBusy(true);
    setError(null);
    try {
      const updated = await backendCall("patch_memory", {
        id: memory.id,
        patch: { project_id: nextProjectId },
      });
      setMemory(updated);
      await loadGraph();
      flashNotice(t("unsorted.movedOneNotice", { project: targetName }));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const categoryOptions = useMemo<SelectOption<MemoryCategory>[]>(
    () =>
      MEMORY_CATEGORIES.map((cat) => ({
        value: cat,
        label: t(`categories.${cat}`),
      })),
    [t],
  );

  const branchOptions = useMemo<SelectOption<Uuid>[]>(
    () =>
      branches.map((b) => ({
        value: b.id,
        label: b.name,
        detail: b.is_active ? t("branches.active") : undefined,
      })),
    [branches, t],
  );

  const handlePatch = async (patch: Parameters<typeof backendCall<"patch_memory">>[1]["patch"]) => {
    if (!memory || readOnly) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await backendCall("patch_memory", { id: memory.id, patch });
      setMemory(updated);
      setConfidenceDraft(updated.confidence);
      setSnippetDraft(updated.reusable_snippet ?? "");
      await loadGraph();
      flashNotice(t("inspector.saved"));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleUpdateContent = async () => {
    if (!memory || readOnly) return;
    const trimmedContent = draftContent.trim();
    const trimmedReason = versionReason.trim();
    if (!trimmedContent) return;

    setBusy(true);
    setError(null);
    try {
      const outcome = await backendCall("update_memory", {
        memory_id: memory.id,
        new_content: trimmedContent,
        reason: trimmedReason || t("inspector.defaultReason"),
        confidence: confidenceDraft,
        source_client: "cobalt_ui",
      });
      setEditingContent(false);
      setVersionReason("");
      await loadGraph();
      if (outcome.memory.id !== memory.id) {
        setSelectedNodeId(outcome.memory.id);
      } else {
        setMemory(outcome.memory);
        await loadDetails();
      }
      flashNotice(t(`inspector.writeAction.${outcome.action}`));
      if (outcome.possible_conflicts && outcome.possible_conflicts.length > 0) {
        pushThemeToast({
          kind: "warning",
          message: t("conflicts.possibleToast", {
            count: outcome.possible_conflicts.length,
          }),
          conflicts: outcome.possible_conflicts,
        });
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleArchiveToggle = async () => {
    if (!memory || readOnly) return;
    setBusy(true);
    setError(null);
    try {
      if (memory.status === "archived") {
        await backendCall("restore_memories", { ids: [memory.id] });
        flashNotice(t("inspector.restoredNotice"));
      } else {
        await backendCall("archive_memories", { ids: [memory.id] });
      }
      await loadGraph();
      await loadDetails();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!memory || readOnly) return;
    setBusy(true);
    setError(null);
    try {
      await backendCall("delete_memory", { id: memory.id });
      setDeleteDialogOpen(false);
      setSelectedNodeId(null);
      await loadGraph();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const handleToggleWatch = async (watched: boolean) => {
    if (!sourceDoc || readOnly) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await backendCall("set_watched", {
        source_doc_id: sourceDoc.id,
        watched,
      });
      setSourceDoc(updated);
      flashNotice(t("inspector.saved"));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRelinkSource = async () => {
    if (!sourceDoc || readOnly) return;
    const newPath = await pickSinglePath({
      title: t("library.relinkDialogTitle"),
      defaultPath: sourceDoc.file_path,
    });
    if (!newPath) return;

    setBusy(true);
    setError(null);
    try {
      const updated = await backendCall("relink_source_document", {
        source_doc_id: sourceDoc.id,
        new_path: newPath,
      });
      setSourceDoc(updated);
      cacheSourceDocPath(updated.id, updated.file_path);
      const status = await backendCall("verify_source_document", { id: updated.id });
      setDiskStatus(status);
      flashNotice(t("library.relinkedNotice"));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCopyPath = async () => {
    if (!sourceDoc) return;
    const ok = await copyToClipboard(sourceDoc.file_path);
    if (ok) {
      setCopiedPath(true);
      window.setTimeout(() => setCopiedPath(false), 1800);
    }
  };

  const openVaultUnlockPrompt = async (action: "reveal" | "encrypt" | "decrypt") => {
    await loadVaultStatus();
    setPendingVaultAction(action);
    setVaultPromptOpen(true);
  };

  const handleReveal = async () => {
    if (!memory) return;
    setBusy(true);
    setError(null);
    try {
      const plaintext = await backendCall("reveal_memory", { id: memory.id });
      setRevealedPlaintext(plaintext);
      setVaultPromptOpen(false);
    } catch (err: unknown) {
      if (err instanceof IpcError && err.kind === "vault_locked") {
        await openVaultUnlockPrompt("reveal");
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const handleSetEncrypted = async (encrypted: boolean) => {
    if (!memory || readOnly) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await backendCall("set_memory_encrypted", {
        id: memory.id,
        encrypted,
      });
      setMemory(updated);
      setRevealedPlaintext(null);
      setVaultPromptOpen(false);
      await loadGraph();
      flashNotice(encrypted ? t("inspector.encryptedNotice") : t("inspector.decryptedNotice"));
    } catch (err: unknown) {
      if (err instanceof IpcError && err.kind === "vault_locked") {
        await openVaultUnlockPrompt(encrypted ? "encrypt" : "decrypt");
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const handleSubmitVaultPassword = async () => {
    if (!vaultPassword) return;
    setBusy(true);
    setError(null);
    try {
      const status =
        vaultStatus && !vaultStatus.initialized
          ? await backendCall("vault_setup", { password: vaultPassword })
          : await backendCall("vault_unlock", { password: vaultPassword });
      setVaultStatus(status);
      setVaultPassword("");
      setVaultPromptOpen(false);

      const action = pendingVaultAction;
      setPendingVaultAction(null);
      setBusy(false);
      if (action === "reveal") {
        await handleReveal();
      } else if (action === "encrypt") {
        await handleSetEncrypted(true);
      } else if (action === "decrypt") {
        await handleSetEncrypted(false);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const diskStatusBadgeClass =
    diskStatus === "available"
      ? "border-verdigris-rule bg-verdigris-wash text-verdigris"
      : diskStatus === "modified"
        ? "border-ochre-rule bg-ochre-wash text-ochre"
        : diskStatus === "missing"
          ? "border-cinnabar-rule bg-cinnabar-wash text-cinnabar"
          : "border-cobalt-rule bg-cobalt-wash text-cobalt-ink";

  const archivedMeta = memory
    ? parseArchivedByReason(memory.version_reason, memory.source_client)
    : null;

  return (
    <aside className="cobalt-drawer-enter-right flex h-full w-full max-w-[420px] flex-col border-l border-rule-strong bg-surface text-bone shadow-[-12px_0_32px_rgba(0,0,0,0.65)]">
      {/* Drawer Header */}
      <div className="flex items-center justify-between gap-2 border-b border-rule px-4 py-3">
        <div className="min-w-0">
          <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-cobalt-ink">
            {t("inspector.title")}
          </div>
          {memory && (
            <div className="mt-0.5 truncate font-mono text-[10px] text-bone-subtle">
              {memory.id}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void loadDetails()}
            title={t("common.refresh")}
            className="rounded-[2px] p-1.5 text-bone-muted hover:bg-surface-2 hover:text-bone"
          >
            <RefreshCw size={13} aria-hidden />
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

      {/* Feedback banners */}
      {readOnly && (
        <div className="flex items-center gap-2 border-b border-ochre-rule bg-ochre-wash px-4 py-2 font-mono text-[11px] text-ochre">
          <ShieldAlert size={13} className="shrink-0" aria-hidden />
          <span>{t("inspector.readOnlyNotice")}</span>
        </div>
      )}
      {error && (
        <div className="border-b border-cinnabar-rule bg-cinnabar-wash px-4 py-2 text-xs text-cinnabar">
          {error}
        </div>
      )}
      {notice && (
        <div className="flex items-center gap-1.5 border-b border-verdigris-rule bg-verdigris-wash px-4 py-2 font-mono text-[11px] text-verdigris">
          <Check size={12} aria-hidden />
          <span>{notice}</span>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        {loading ? (
          <div className="space-y-4" aria-busy="true" aria-label={t("inspector.loading")}>
            <div className="flex items-center gap-2">
              <Skeleton className="h-5 w-20" />
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-5 w-16" />
            </div>
            <div className="space-y-2 rounded-[2px] border border-rule bg-void p-3">
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-11/12" />
              <Skeleton className="h-3.5 w-4/5" />
              <Skeleton className="h-3.5 w-2/3" />
            </div>
            <div className="space-y-2.5 rounded-[2px] border border-rule bg-void p-3">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-7 w-full" />
              <Skeleton className="h-7 w-full" />
            </div>
            <div className="space-y-2 rounded-[2px] border border-rule bg-void p-3">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-10 w-full" />
            </div>
          </div>
        ) : !memory ? (
          <p className="py-8 text-center text-xs text-bone-muted">{t("inspector.notFound")}</p>
        ) : (
          <>
            {/* Archived-by-agent banner (MCP_SPEC §2.8) with direct Restore */}
            {memory.status === "archived" && (
              <div className="space-y-2.5 rounded-[2px] border border-ochre-rule bg-ochre-wash p-3">
                <div className="flex items-start gap-2 text-xs text-ochre">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
                  <div className="min-w-0">
                    <div className="font-semibold">
                      {archivedMeta?.agent
                        ? archivedMeta.reason
                          ? t("inspector.archivedByAgentReason", {
                              agent: archivedMeta.agent,
                              reason: archivedMeta.reason,
                            })
                          : t("inspector.archivedByAgent", { agent: archivedMeta.agent })
                        : archivedMeta?.reason
                          ? t("inspector.archivedWithReason", { reason: archivedMeta.reason })
                          : t("inspector.archivedBanner")}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={readOnly || busy}
                  onClick={() => void handleArchiveToggle()}
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-[2px] border border-ochre bg-ochre px-3 py-1.5 font-mono text-[11px] font-semibold text-void transition-colors hover:opacity-90 disabled:opacity-45"
                >
                  <RotateCcw size={12} aria-hidden />
                  {t("inspector.restoreMemoryButton")}
                </button>
              </div>
            )}

            {/* Modified-on-disk warning banner (`verify_source_document === "modified"`) */}
            {diskStatus === "modified" && (
              <div className="flex items-start gap-2 rounded-[2px] border border-ochre-rule bg-ochre-wash px-3 py-2.5 text-xs text-ochre">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
                <div className="min-w-0">
                  <div className="font-semibold">{t("inspector.fileChangedSinceSaved")}</div>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-bone-muted">
                    {t("inspector.fileChangedHint")}
                  </p>
                </div>
              </div>
            )}

            {/* Distinct grey callout when memory is in "Sin clasificar" */}
            {isInUnsorted && (
              <div className="space-y-2.5 rounded-[2px] border border-dashed border-rule-strong bg-surface-2/70 p-3">
                <div className="flex items-start gap-2 text-xs text-bone-muted">
                  <Inbox
                    size={14}
                    className="mt-0.5 shrink-0"
                    style={{ color: UNSORTED_PROJECT_COLOR }}
                    aria-hidden
                  />
                  <div className="min-w-0">
                    <div className="font-semibold text-bone-muted">{UNSORTED_PROJECT_NAME}</div>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-bone-subtle">
                      {t("unsorted.explanation")}
                    </p>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2 border-t border-rule pt-2">
                  <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-bone-subtle">
                    <FolderInput size={11} aria-hidden />
                    {t("unsorted.moveAction")}
                  </span>
                  <Select<string>
                    value={fromMemoryProjectId(memory.project_id)}
                    options={projectOptions}
                    disabled={readOnly || busy}
                    size="sm"
                    align="right"
                    className="w-44"
                    ariaLabel={t("unsorted.moveAction")}
                    onChange={(val) => void handleMoveToProject(val)}
                  />
                </div>
              </div>
            )}

            {/* Quick badges & telemetry strip */}
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px]">
                <span
                  title={isInUnsorted ? t("unsorted.explanation") : undefined}
                  className={`inline-flex items-center gap-1.5 rounded-[2px] border px-1.5 py-0.5 ${
                    isInUnsorted
                      ? "border-dashed border-rule-strong bg-void text-bone-subtle"
                      : "border-rule bg-void text-bone-muted"
                  }`}
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-[1px]"
                    style={{ backgroundColor: resolveProjectColor(currentProject) }}
                    aria-hidden
                  />
                  <span className="max-w-[140px] truncate">
                    {currentProject ? currentProject.name : t("brain.globalScope")}
                  </span>
                </span>
                <span className="rounded-[2px] border border-rule-strong bg-surface-2 px-1.5 py-0.5 uppercase text-bone-muted">
                  {memory.source_type}
                </span>
                <span
                  className={`rounded-[2px] border px-1.5 py-0.5 uppercase ${
                    memory.status === "active"
                      ? "border-verdigris-rule bg-verdigris-wash text-verdigris"
                      : memory.status === "superseded"
                        ? "border-ochre-rule bg-ochre-wash text-ochre"
                        : "border-rule bg-surface-2 text-bone-subtle"
                  }`}
                >
                  {t(`statuses.${memory.status}`)}
                </span>
                {memory.category === "ocr" && (
                  <span
                    title={t("ocr.badgeTooltip")}
                    className="inline-flex items-center gap-1 rounded-[2px] border border-cobalt-rule bg-cobalt-wash px-1.5 py-0.5 uppercase text-cobalt-ink"
                  >
                    <ScanText size={10} aria-hidden />
                    {t("ocr.badge")}
                  </span>
                )}
                {memory.is_core_pin && (
                  <span className="inline-flex items-center gap-1 rounded-[2px] border border-ochre-rule bg-ochre-wash px-1.5 py-0.5 text-ochre">
                    <Pin size={10} aria-hidden />
                    {t("brain.corePin")}
                  </span>
                )}
                {memory.is_reusable && (
                  <span className="inline-flex items-center gap-1 rounded-[2px] border border-pulse-reuse/50 bg-pulse-reuse/15 px-1.5 py-0.5 text-pulse-reuse">
                    <Repeat size={10} aria-hidden />
                    {t("brain.reusable")}
                  </span>
                )}
                {memory.is_encrypted && (
                  <span className="inline-flex items-center gap-1 rounded-[2px] border border-cinnabar-rule bg-cinnabar-wash px-1.5 py-0.5 text-cinnabar">
                    <Lock size={10} aria-hidden />
                    {t("inspector.encrypted")}
                  </span>
                )}
              </div>

              <div className="grid grid-cols-3 divide-x divide-rule rounded-[2px] border border-rule bg-void font-mono text-[10px] tabular-nums">
                <div className="px-2.5 py-1.5">
                  <div className="text-bone-subtle">{t("inspector.tokensLabel")}</div>
                  <div className="mt-0.5 font-semibold text-bone">{memory.chunk_tokens}</div>
                </div>
                <div className="px-2.5 py-1.5">
                  <div className="text-bone-subtle">{t("inspector.hitsLabel")}</div>
                  <div className="mt-0.5 font-semibold text-bone">{memory.hit_count}</div>
                </div>
                <div className="px-2.5 py-1.5">
                  <div className="text-bone-subtle">{t("inspector.reusesLabel")}</div>
                  <div className="mt-0.5 font-semibold text-bone">{memory.reuse_count}</div>
                </div>
              </div>
            </div>

            {/* Agents using this memory (`get_archive_impact`) */}
            {archiveImpact && (
              <section className="space-y-2 rounded-[2px] border border-rule bg-void p-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="inline-flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-bone-subtle">
                    <Users size={11} className="text-cobalt-ink" aria-hidden />
                    {t("inspector.agentsUsingTitle")}
                  </h3>
                  <span className="font-mono text-[10px] tabular-nums text-bone-subtle">
                    {archiveImpact.other_clients.length}
                  </span>
                </div>

                {archiveImpact.other_clients.length === 0 ? (
                  <p className="text-[11px] text-bone-subtle">{t("inspector.noAgentsUsing")}</p>
                ) : (
                  <div className="divide-y divide-rule">
                    {archiveImpact.other_clients.map((client) => (
                      <div
                        key={client.client_name}
                        className="flex items-center justify-between gap-2 py-1.5 font-mono text-[11px]"
                      >
                        <span className="font-medium text-bone">
                          {formatAiClientName(client.client_name)}
                        </span>
                        <span className="tabular-nums text-bone-muted">
                          {t("inspector.agentUsesCount", { count: client.uses })} ·{" "}
                          {formatDate(client.last_used_at)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            {/* Content / Encryption section */}
            <section className="space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-bone-subtle">
                  {t("inspector.contentSection")}
                </h3>
                <div className="flex items-center gap-1.5">
                  {!memory.is_encrypted && !editingContent && (
                    <button
                      type="button"
                      disabled={readOnly || busy}
                      onClick={() => {
                        setDraftContent(memory.content);
                        setEditingContent(true);
                      }}
                      className="inline-flex items-center gap-1 rounded-[2px] border border-rule-strong bg-surface-2 px-2 py-1 font-mono text-[10px] text-bone hover:border-cobalt-ink/60 disabled:opacity-45"
                    >
                      <Edit3 size={10} aria-hidden />
                      {t("inspector.editContent")}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={readOnly || busy}
                    onClick={() => void handleSetEncrypted(!memory.is_encrypted)}
                    className="inline-flex items-center gap-1 rounded-[2px] border border-rule-strong bg-surface-2 px-2 py-1 font-mono text-[10px] text-bone-muted hover:border-cobalt-ink/60 hover:text-bone disabled:opacity-45"
                  >
                    {memory.is_encrypted ? (
                      <>
                        <LockOpen size={10} aria-hidden />
                        {t("inspector.decrypt")}
                      </>
                    ) : (
                      <>
                        <Lock size={10} aria-hidden />
                        {t("inspector.encrypt")}
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Inline Vault Unlock / Setup prompt */}
              {vaultPromptOpen && (
                <div className="space-y-2 rounded-[2px] border border-cobalt-rule bg-cobalt-wash p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-cobalt-ink">
                      <KeyRound size={11} aria-hidden />
                      <span>
                        {vaultStatus && !vaultStatus.initialized
                          ? t("inspector.vaultSetupTitle")
                          : t("inspector.vaultUnlockTitle")}
                      </span>
                    </div>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setVaultPromptOpen(false);
                        setVaultPassword("");
                        setPendingVaultAction(null);
                      }}
                      aria-label={t("common.close")}
                      className="rounded-[2px] p-0.5 text-bone-muted hover:bg-surface-2 hover:text-bone disabled:opacity-45"
                    >
                      <X size={12} aria-hidden />
                    </button>
                  </div>
                  <div className="flex gap-1.5">
                    <input
                      type="password"
                      value={vaultPassword}
                      onChange={(e) => setVaultPassword(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          void handleSubmitVaultPassword();
                        } else if (e.key === "Escape" && !busy) {
                          e.preventDefault();
                          setVaultPromptOpen(false);
                          setVaultPassword("");
                          setPendingVaultAction(null);
                        }
                      }}
                      placeholder={t("inspector.vaultPasswordPlaceholder")}
                      className="h-8 flex-1 rounded-[2px] border border-rule-strong bg-void px-2.5 font-mono text-xs text-bone focus:border-cobalt-ink focus:outline-none"
                    />
                    <button
                      type="button"
                      disabled={busy || !vaultPassword}
                      onClick={() => void handleSubmitVaultPassword()}
                      className="rounded-[2px] border border-cobalt-rule bg-cobalt px-3 font-mono text-[11px] font-semibold text-bone hover:bg-cobalt-bright disabled:opacity-45"
                    >
                      {t("inspector.vaultConfirm")}
                    </button>
                  </div>
                </div>
              )}

              {memory.is_encrypted ? (
                <div className="space-y-2 rounded-[2px] border border-rule bg-void p-3">
                  {revealedPlaintext !== null ? (
                    <>
                      <p className="whitespace-pre-wrap text-xs leading-relaxed text-bone">
                        {revealedPlaintext}
                      </p>
                      <button
                        type="button"
                        onClick={() => setRevealedPlaintext(null)}
                        className="inline-flex items-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface-2 px-2.5 py-1 font-mono text-[10px] text-bone-muted hover:text-bone"
                      >
                        <EyeOff size={11} aria-hidden />
                        {t("inspector.hidePlaintext")}
                      </button>
                    </>
                  ) : (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-[11px] text-bone-muted">
                        {t("inspector.encryptedHidden")}
                      </span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleReveal()}
                        className="inline-flex items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt-wash px-2.5 py-1 font-mono text-[10px] font-medium text-cobalt-ink hover:bg-cobalt hover:text-bone"
                      >
                        <Eye size={11} aria-hidden />
                        {t("inspector.revealPlaintext")}
                      </button>
                    </div>
                  )}
                </div>
              ) : editingContent ? (
                <div className="space-y-2.5 rounded-[2px] border border-cobalt-rule bg-void p-3">
                  <textarea
                    rows={5}
                    value={draftContent}
                    onChange={(e) => setDraftContent(e.target.value)}
                    className="w-full rounded-[2px] border border-rule-strong bg-surface p-2 text-xs leading-relaxed text-bone focus:border-cobalt-ink focus:outline-none"
                  />
                  <div>
                    <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
                      {t("inspector.versionReasonLabel")}
                    </label>
                    <input
                      type="text"
                      value={versionReason}
                      onChange={(e) => setVersionReason(e.target.value)}
                      placeholder={t("inspector.versionReasonPlaceholder")}
                      className="h-8 w-full rounded-[2px] border border-rule-strong bg-surface px-2.5 text-xs text-bone placeholder:text-bone-subtle focus:border-cobalt-ink focus:outline-none"
                    />
                  </div>
                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingContent(false);
                        setDraftContent(memory.content);
                      }}
                      className="rounded-[2px] border border-rule-strong bg-surface-2 px-3 py-1 font-mono text-[11px] text-bone-muted hover:text-bone"
                    >
                      {t("common.cancel")}
                    </button>
                    <button
                      type="button"
                      disabled={busy || !draftContent.trim()}
                      onClick={() => void handleUpdateContent()}
                      className="inline-flex items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-3 py-1 font-mono text-[11px] font-semibold text-bone hover:bg-cobalt-bright disabled:opacity-45"
                    >
                      <Save size={11} aria-hidden />
                      {t("inspector.saveNewVersion")}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="rounded-[2px] border border-rule bg-void p-3 text-xs leading-relaxed whitespace-pre-wrap text-bone">
                  {memory.content}
                </div>
              )}

              {memory.category === "ocr" && (
                <p className="text-[11px] leading-snug text-bone-muted">
                  {t("inspector.ocrVerifyHint")}
                </p>
              )}
            </section>

            {/* Real Source Document (`get_source_document` + `verify_source_document`) */}
            <section className="space-y-2 rounded-[2px] border border-rule bg-surface-2 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-bone-subtle">
                  <FileCheck2 size={11} aria-hidden />
                  {t("inspector.sourceDocSection")}
                </span>
                {diskStatus && (
                  <span
                    className={`inline-flex items-center gap-1 rounded-[2px] border px-1.5 py-0.5 font-mono text-[10px] ${
                      diskStatus === "modified" ? "font-medium" : "uppercase"
                    } ${diskStatusBadgeClass}`}
                  >
                    {diskStatus === "modified" && <AlertTriangle size={10} aria-hidden />}
                    {diskStatus === "modified"
                      ? t("inspector.fileChangedSinceSaved")
                      : t(`availability.${diskStatus}`)}
                  </span>
                )}
              </div>

              {sourceDoc ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5 rounded-[2px] border border-rule bg-void px-2.5 py-1.5">
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-bone">
                      {sourceDoc.file_path}
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleCopyPath()}
                      title={t("library.copyPath")}
                      className="shrink-0 p-0.5 text-bone-subtle hover:text-bone"
                    >
                      {copiedPath ? (
                        <Check size={11} className="text-verdigris" aria-hidden />
                      ) : (
                        <Copy size={11} aria-hidden />
                      )}
                    </button>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                    <label className="inline-flex items-center gap-2 text-bone-muted">
                      <Radio
                        size={11}
                        className={sourceDoc.is_watched ? "text-verdigris" : "text-bone-subtle"}
                        aria-hidden
                      />
                      <span>{t("inspector.watchFile")}</span>
                      <Toggle
                        checked={sourceDoc.is_watched}
                        disabled={readOnly || busy}
                        ariaLabel={t("inspector.watchFile")}
                        onChange={(checked) => void handleToggleWatch(checked)}
                      />
                    </label>

                    <button
                      type="button"
                      disabled={readOnly || busy}
                      onClick={() => void handleRelinkSource()}
                      className="inline-flex items-center gap-1 rounded-[2px] border border-rule-strong bg-surface px-2 py-1 font-mono text-[10px] text-bone-muted hover:border-ochre-rule hover:text-ochre disabled:opacity-45"
                    >
                      <FolderSync size={10} aria-hidden />
                      {t("library.relink")}
                    </button>
                  </div>
                </div>
              ) : (
                <p className="text-[11px] text-bone-subtle">{t("inspector.noSourceDoc")}</p>
              )}
            </section>

            {/* Governance Controls (`patch_memory`) */}
            <section className="space-y-3 border-t border-rule pt-4">
              <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-bone-subtle">
                {t("inspector.governanceSection")}
              </h3>

              {/* Move to project (`patch_memory` project_id) */}
              <div className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-1.5 text-xs text-bone-muted">
                  <FolderInput size={12} className="text-cobalt-ink" aria-hidden />
                  {t("unsorted.moveAction")}
                </span>
                <Select<string>
                  value={fromMemoryProjectId(memory.project_id)}
                  options={projectOptions}
                  disabled={readOnly || busy}
                  size="sm"
                  align="right"
                  className="w-40"
                  ariaLabel={t("unsorted.moveAction")}
                  onChange={(val) => void handleMoveToProject(val)}
                />
              </div>

              {/* Category */}
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-bone-muted">{t("inspector.categoryLabel")}</span>
                <Select<MemoryCategory>
                  value={memory.category}
                  options={categoryOptions}
                  disabled={readOnly || busy}
                  size="sm"
                  align="right"
                  className="w-40"
                  onChange={(category) => void handlePatch({ category })}
                />
              </div>

              {/* Confidence slider */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-bone-muted">{t("inspector.confidenceLabel")}</span>
                  <span className="font-mono text-[11px] tabular-nums text-cobalt-ink">
                    {Math.round(confidenceDraft * 100)}%
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    disabled={readOnly || busy}
                    value={confidenceDraft}
                    onChange={(e) => setConfidenceDraft(Number(e.target.value))}
                    className="h-1.5 flex-1 cursor-pointer accent-cobalt"
                  />
                  {Math.abs(confidenceDraft - memory.confidence) > 0.001 && (
                    <button
                      type="button"
                      disabled={readOnly || busy}
                      onClick={() => void handlePatch({ confidence: confidenceDraft })}
                      className="rounded-[2px] border border-cobalt-rule bg-cobalt-wash px-2 py-0.5 font-mono text-[10px] text-cobalt-ink hover:bg-cobalt hover:text-bone"
                    >
                      {t("common.apply")}
                    </button>
                  )}
                </div>
              </div>

              {/* Nuclear Law (`is_core_pin`) */}
              <div className="flex items-center justify-between gap-3 rounded-[2px] border border-rule bg-surface-2 px-3 py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-bone">
                    <Pin size={12} className="text-ochre" aria-hidden />
                    <span>{t("brain.corePin")}</span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-bone-subtle">
                    {t("inspector.corePinHint")}
                  </p>
                </div>
                <Toggle
                  checked={memory.is_core_pin}
                  disabled={readOnly || busy}
                  ariaLabel={t("brain.corePin")}
                  onChange={(is_core_pin) => void handlePatch({ is_core_pin })}
                />
              </div>

              {/* Mark Reusable */}
              <div className="space-y-2.5 rounded-[2px] border border-rule bg-surface-2 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-bone">
                      <Repeat size={12} className="text-pulse-reuse" aria-hidden />
                      <span>{t("inspector.markReusable")}</span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-bone-subtle">
                      {t("inspector.reusableHint")}
                    </p>
                  </div>
                  <Toggle
                    checked={memory.is_reusable}
                    disabled={readOnly || busy}
                    ariaLabel={t("inspector.markReusable")}
                    onChange={(is_reusable) => void handlePatch({ is_reusable })}
                  />
                </div>

                {memory.is_reusable && (
                  <div className="space-y-1.5 border-t border-rule pt-2">
                    <label className="block font-mono text-[10px] uppercase tracking-[0.1em] text-bone-subtle">
                      {t("inspector.reusableSnippetLabel")}
                    </label>
                    <textarea
                      rows={3}
                      disabled={readOnly || busy}
                      value={snippetDraft}
                      onChange={(e) => setSnippetDraft(e.target.value)}
                      placeholder={t("inspector.reusableSnippetPlaceholder")}
                      className="w-full rounded-[2px] border border-rule bg-void p-2 font-mono text-[11px] text-bone focus:border-cobalt-ink focus:outline-none"
                    />
                    {snippetDraft !== (memory.reusable_snippet ?? "") && (
                      <button
                        type="button"
                        disabled={readOnly || busy}
                        onClick={() =>
                          void handlePatch({
                            reusable_snippet: snippetDraft.trim() ? snippetDraft : null,
                          })
                        }
                        className="rounded-[2px] border border-cobalt-rule bg-cobalt-wash px-2.5 py-1 font-mono text-[10px] text-cobalt-ink hover:bg-cobalt hover:text-bone"
                      >
                        {t("inspector.saveSnippet")}
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Branch assignment */}
              {branchOptions.length > 0 && (
                <div className="flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-1.5 text-xs text-bone-muted">
                    <GitBranch size={12} className="text-cobalt-ink" aria-hidden />
                    {t("shell.branch")}
                  </span>
                  <Select<Uuid>
                    value={memory.branch_id}
                    options={branchOptions}
                    disabled={readOnly || busy || branchOptions.length <= 1}
                    size="sm"
                    align="right"
                    className="w-40"
                    onChange={(branch_id) => void handlePatch({ branch_id })}
                  />
                </div>
              )}
            </section>

            {/* Version History (`get_memory_history` with `version_reason`) */}
            <section className="space-y-2 border-t border-rule pt-4">
              <div className="flex items-center justify-between">
                <h3 className="inline-flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-bone-subtle">
                  <History size={11} aria-hidden />
                  {t("inspector.historySection")}
                </h3>
                <span className="font-mono text-[10px] tabular-nums text-bone-subtle">
                  {history.length}
                </span>
              </div>

              {history.length === 0 ? (
                <p className="text-xs text-bone-subtle">{t("inspector.noHistory")}</p>
              ) : (
                <div className="space-y-1.5">
                  {history.map((ver, idx) => {
                    const isCurrent = ver.id === memory.id;
                    return (
                      <button
                        key={ver.id}
                        type="button"
                        onClick={() => {
                          if (!isCurrent) setSelectedNodeId(ver.id);
                        }}
                        className={`w-full rounded-[2px] border p-2.5 text-left transition-colors ${
                          isCurrent
                            ? "border-cobalt-rule bg-cobalt-wash/70"
                            : "border-rule bg-void hover:border-rule-strong hover:bg-surface-2"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2 font-mono text-[10px]">
                          <span className="font-semibold text-bone">
                            v{idx + 1} · {t(`statuses.${ver.status}`)}
                          </span>
                          <span className="text-bone-subtle">{formatDate(ver.updated_at)}</span>
                        </div>
                        {ver.version_reason && (
                          <div className="mt-1 font-mono text-[10px] text-ochre">
                            {t("inspector.reasonPrefix")}: {ver.version_reason}
                          </div>
                        )}
                        <p className="mt-1 line-clamp-2 text-[11px] text-bone-muted">
                          {ver.is_encrypted ? t("inspector.encryptedHidden") : ver.content}
                        </p>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Archive & Delete Actions */}
            <section className="space-y-2 border-t border-rule pt-4">
              {memory.status !== "archived" &&
                archiveImpact &&
                archiveImpact.other_clients.length > 0 && (
                  <p className="flex items-center gap-1.5 rounded-[2px] border border-ochre-rule/60 bg-ochre-wash/50 px-2.5 py-1.5 text-[11px] text-ochre">
                    <AlertTriangle size={12} className="shrink-0" aria-hidden />
                    <span>
                      {t("inspector.archiveImpactWarning", {
                        count: archiveImpact.other_clients.length,
                      })}
                    </span>
                  </p>
                )}

              <div className="flex items-center gap-2">
                {!memory.is_core_pin && (
                  <button
                    type="button"
                    disabled={readOnly || busy}
                    onClick={() => void handleArchiveToggle()}
                    className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface-2 px-3 py-1.5 font-mono text-[11px] text-bone-muted hover:border-cobalt-ink/60 hover:text-bone disabled:opacity-45"
                  >
                    {memory.status === "archived" ? (
                      <>
                        <RotateCcw size={12} aria-hidden />
                        {t("inspector.restore")}
                      </>
                    ) : (
                      <>
                        <Archive size={12} aria-hidden />
                        {t("inspector.archive")}
                      </>
                    )}
                  </button>
                )}

                <button
                  type="button"
                  disabled={readOnly || busy}
                  onClick={() => setDeleteDialogOpen(true)}
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-[2px] border border-cinnabar-rule bg-cinnabar-wash px-3 py-1.5 font-mono text-[11px] text-cinnabar hover:bg-cinnabar hover:text-bone disabled:opacity-45"
                >
                  <Trash2 size={12} aria-hidden />
                  {t("inspector.delete")}
                </button>
              </div>

              <div className="font-mono text-[10px] text-bone-subtle">
                {t("inspector.updatedAt", { date: formatDate(memory.updated_at) })}
                {memory.source_client ? ` · ${formatAiClientName(memory.source_client)}` : ""}
              </div>
            </section>
          </>
        )}
      </div>

      {deleteDialogOpen && memory && (
        <PermanentDeleteDialog
          memory={memory}
          busy={busy}
          readOnly={readOnly}
          onCancel={() => setDeleteDialogOpen(false)}
          onArchiveInstead={async () => {
            setDeleteDialogOpen(false);
            await handleArchiveToggle();
          }}
          onConfirmDelete={handleDelete}
        />
      )}
    </aside>
  );
}
