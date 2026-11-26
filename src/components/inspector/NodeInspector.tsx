import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Archive,
  Check,
  Edit3,
  Eye,
  EyeOff,
  FileCheck2,
  GitBranch,
  History,
  KeyRound,
  Loader2,
  Lock,
  LockOpen,
  Pin,
  RefreshCw,
  Repeat,
  RotateCcw,
  Save,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import { backendCall, isCommandMocked } from "@/lib/backend";
import { IpcError } from "@/lib/ipc";
import {
  useBranchesStore,
  useMemoryStore,
  useSettingsStore,
} from "@/stores";
import { MockBadge } from "@/components/shell/MockBadge";
import { Select, Toggle, type SelectOption } from "@/components/ui";
import {
  MEMORY_CATEGORIES,
  type FileAvailability,
  type Memory,
  type MemoryCategory,
  type Uuid,
} from "@/types/contracts";

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

export function NodeInspector({ memoryId, onClose }: NodeInspectorProps) {
  const { t } = useTranslation();

  const graphRevision = useMemoryStore((s) => s.graphRevision);
  const loadGraph = useMemoryStore((s) => s.loadGraph);
  const setSelectedNodeId = useMemoryStore((s) => s.setSelectedNodeId);
  const branches = useBranchesStore((s) => s.branches);
  const readOnly = useSettingsStore((s) => s.settings.read_only);
  const vaultStatus = useSettingsStore((s) => s.vaultStatus);
  const loadVaultStatus = useSettingsStore((s) => s.loadVaultStatus);
  const setVaultStatus = useSettingsStore((s) => s.setVaultStatus);

  const [memory, setMemory] = useState<Memory | null>(null);
  const [history, setHistory] = useState<Memory[]>([]);
  const [diskStatus, setDiskStatus] = useState<FileAvailability | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Content editing (`update_memory`)
  const [editingContent, setEditingContent] = useState(false);
  const [draftContent, setDraftContent] = useState("");
  const [versionReason, setVersionReason] = useState("");

  // Governance metadata (`patch_memory`)
  const [confidenceDraft, setConfidenceDraft] = useState(1);
  const [snippetDraft, setSnippetDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Vault / Encryption state
  const [revealedPlaintext, setRevealedPlaintext] = useState<string | null>(null);
  const [vaultPromptOpen, setVaultPromptOpen] = useState(false);
  const [vaultPassword, setVaultPassword] = useState("");
  const [pendingVaultAction, setPendingVaultAction] = useState<
    "reveal" | "encrypt" | "decrypt" | null
  >(null);

  const flashNotice = useCallback((msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 2600);
  }, []);

  const loadDetails = useCallback(async () => {
    setLoading(true);
    setError(null);
    setRevealedPlaintext(null);
    setEditingContent(false);
    setConfirmDelete(false);

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

      if (!mem.source_doc_id) {
        setDiskStatus("snippet_only");
      } else {
        try {
          const status = await backendCall("verify_source_document", {
            id: mem.source_doc_id,
          });
          setDiskStatus(status);
        } catch {
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
      setSelectedNodeId(null);
      await loadGraph();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
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

  const verifyIsMocked = Boolean(memory?.source_doc_id) && isCommandMocked("verify_source_document");

  return (
    <aside className="flex h-full w-full max-w-[420px] flex-col border-l border-rule-strong bg-surface/98 text-bone shadow-[-12px_0_32px_rgba(0,0,0,0.65)] backdrop-blur-sm">
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
          <div className="flex items-center justify-center gap-2 py-12 font-mono text-xs text-bone-muted">
            <Loader2 size={14} className="animate-spin text-cobalt-ink" aria-hidden />
            <span>{t("inspector.loading")}</span>
          </div>
        ) : !memory ? (
          <p className="py-8 text-center text-xs text-bone-muted">{t("inspector.notFound")}</p>
        ) : (
          <>
            {/* Quick badges & telemetry strip */}
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px]">
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
                  <div className="flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-cobalt-ink">
                    <KeyRound size={11} aria-hidden />
                    <span>
                      {vaultStatus && !vaultStatus.initialized
                        ? t("inspector.vaultSetupTitle")
                        : t("inspector.vaultUnlockTitle")}
                    </span>
                  </div>
                  <div className="flex gap-1.5">
                    <input
                      type="password"
                      value={vaultPassword}
                      onChange={(e) => setVaultPassword(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void handleSubmitVaultPassword();
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
            </section>

            {/* Governance Controls (`patch_memory`) */}
            <section className="space-y-3 border-t border-rule pt-4">
              <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-bone-subtle">
                {t("inspector.governanceSection")}
              </h3>

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

              {/* Mark Reusable + Disk Status */}
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

                {/* Disk availability status */}
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-rule pt-2">
                  <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-bone-subtle">
                    <FileCheck2 size={11} aria-hidden />
                    {t("inspector.diskStatus")}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {diskStatus && (
                      <span
                        className={`rounded-[2px] border px-1.5 py-0.5 font-mono text-[10px] uppercase ${diskStatusBadgeClass}`}
                      >
                        {t(`availability.${diskStatus}`)}
                      </span>
                    )}
                    {verifyIsMocked && <MockBadge />}
                  </div>
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

                {!confirmDelete ? (
                  <button
                    type="button"
                    disabled={readOnly || busy}
                    onClick={() => setConfirmDelete(true)}
                    className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-[2px] border border-cinnabar-rule bg-cinnabar-wash px-3 py-1.5 font-mono text-[11px] text-cinnabar hover:bg-cinnabar hover:text-bone disabled:opacity-45"
                  >
                    <Trash2 size={12} aria-hidden />
                    {t("inspector.delete")}
                  </button>
                ) : (
                  <div className="flex flex-1 items-center gap-1.5">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleDelete()}
                      className="flex-1 rounded-[2px] border border-cinnabar bg-cinnabar px-2.5 py-1.5 font-mono text-[11px] font-semibold text-bone"
                    >
                      {t("inspector.confirmDelete")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(false)}
                      className="rounded-[2px] border border-rule-strong bg-surface-2 px-2 py-1.5 font-mono text-[11px] text-bone-muted"
                    >
                      {t("common.cancel")}
                    </button>
                  </div>
                )}
              </div>

              <div className="font-mono text-[10px] text-bone-subtle">
                {t("inspector.updatedAt", { date: formatDate(memory.updated_at) })}
                {memory.source_client ? ` · ${memory.source_client}` : ""}
              </div>
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
