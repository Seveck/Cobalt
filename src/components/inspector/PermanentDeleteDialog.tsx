import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertOctagon,
  AlertTriangle,
  Archive,
  Camera,
  History,
  Loader2,
  Lock,
  Pin,
  RefreshCw,
  Repeat,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { backendCall } from "@/lib/backend";
import { formatAiClientName } from "@/lib/format";
import { toDisplayError, type DisplayError } from "@/lib/friendlyError";
import { ErrorAlert, Skeleton } from "@/components/ui";
import type { DeletionImpact, Memory } from "@/types/contracts";

interface PermanentDeleteDialogProps {
  memory: Memory;
  busy: boolean;
  readOnly: boolean;
  onCancel: () => void;
  onArchiveInstead: () => Promise<void>;
  onConfirmDelete: () => Promise<void>;
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

function consequenceIcon(key: string) {
  switch (key) {
    case "delete.consequence.irreversible":
      return <AlertOctagon size={14} className="mt-0.5 shrink-0 text-cinnabar" aria-hidden />;
    case "delete.consequence.core_law":
      return <Pin size={14} className="mt-0.5 shrink-0 text-ochre" aria-hidden />;
    case "delete.consequence.reusable":
      return <Repeat size={14} className="mt-0.5 shrink-0 text-pulse-reuse" aria-hidden />;
    case "delete.consequence.used_by_agents":
      return <Users size={14} className="mt-0.5 shrink-0 text-ochre" aria-hidden />;
    case "delete.consequence.history":
      return <History size={14} className="mt-0.5 shrink-0 text-bone-muted" aria-hidden />;
    case "delete.consequence.snapshots":
      return <Camera size={14} className="mt-0.5 shrink-0 text-bone-muted" aria-hidden />;
    case "delete.consequence.encrypted":
      return <Lock size={14} className="mt-0.5 shrink-0 text-cinnabar" aria-hidden />;
    default:
      return <AlertTriangle size={14} className="mt-0.5 shrink-0 text-ochre" aria-hidden />;
  }
}

export function PermanentDeleteDialog({
  memory,
  busy,
  readOnly,
  onCancel,
  onArchiveInstead,
  onConfirmDelete,
}: PermanentDeleteDialogProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);

  const [impact, setImpact] = useState<DeletionImpact | null>(null);
  const [loadingImpact, setLoadingImpact] = useState(true);
  const [impactError, setImpactError] = useState<DisplayError | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [archiving, setArchiving] = useState(false);

  const confirmWord = t("delete.confirmWord");
  const isWordMatched = confirmText.trim() === confirmWord;
  const canConfirm = !loadingImpact && impact !== null && !busy && !archiving && !readOnly && isWordMatched;
  const canArchiveInstead = !memory.is_core_pin && memory.status !== "archived" && !readOnly;

  const loadImpact = useCallback(async () => {
    setLoadingImpact(true);
    setImpactError(null);
    try {
      const data = await backendCall("get_deletion_impact", { id: memory.id });
      setImpact(data);
    } catch (err: unknown) {
      setImpact(null);
      setImpactError(toDisplayError(err, t, "get_deletion_impact"));
    } finally {
      setLoadingImpact(false);
    }
  }, [memory.id, t]);

  useEffect(() => {
    setConfirmText("");
    void loadImpact();
  }, [loadImpact]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy && !archiving) {
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [archiving, busy, onCancel]);

  const handleArchiveClick = async () => {
    if (!canArchiveInstead || busy || archiving) return;
    setArchiving(true);
    try {
      await onArchiveInstead();
    } finally {
      setArchiving(false);
    }
  };

  return (
    <div
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !busy && !archiving) {
          onCancel();
        }
      }}
      className="fixed inset-0 z-50 flex items-end justify-end bg-void/50 p-5 backdrop-blur-[1px]"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="permanent-delete-dialog-title"
        className="cobalt-modal-enter flex max-h-[calc(100vh-2.5rem)] w-[min(468px,calc(100vw-2rem))] flex-col rounded-[2px] border-2 border-cinnabar-rule bg-surface text-bone shadow-[0_20px_56px_rgba(0,0,0,0.85)]"
      >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-cinnabar-rule/70 bg-cinnabar-wash/60 px-4 py-3">
        <div className="flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-cinnabar">
          <Trash2 size={14} aria-hidden />
          <span id="permanent-delete-dialog-title">{t("delete.dialogTitle")}</span>
        </div>
        <button
          type="button"
          disabled={busy || archiving}
          onClick={onCancel}
          aria-label={t("common.close")}
          className="rounded-[2px] p-1 text-bone-muted hover:bg-surface-2 hover:text-bone disabled:opacity-45"
        >
          <X size={14} aria-hidden />
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {/* Large, unmistakable irreversibility warning */}
        <div className="rounded-[2px] border border-cinnabar bg-cinnabar-wash p-3.5">
          <div className="flex items-start gap-2.5">
            <AlertOctagon size={22} className="mt-0.5 shrink-0 text-cinnabar" aria-hidden />
            <div className="space-y-1">
              <h2 className="font-display text-lg font-semibold leading-snug text-bone">
                {t("delete.irreversibleHeadline")}
              </h2>
              <p className="text-xs leading-relaxed text-cinnabar">
                {t("delete.irreversibleSubtext")}
              </p>
            </div>
          </div>
        </div>

        {/* Memory preview */}
        <div className="rounded-[2px] border border-rule bg-void px-3 py-2">
          <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
            {t("delete.previewLabel")}
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-bone-muted">
            {memory.is_encrypted
              ? t("inspector.encryptedHidden")
              : impact?.preview || memory.content}
          </p>
        </div>

        {/* Impact details */}
        {loadingImpact ? (
          <div className="space-y-2.5" aria-busy="true" aria-label={t("delete.loadingImpact")}>
            <Skeleton className="h-3 w-28" />
            <div className="space-y-2 rounded-[2px] border border-rule bg-void p-3">
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-5/6" />
              <Skeleton className="h-3.5 w-2/3" />
            </div>
          </div>
        ) : impactError || !impact ? (
          <div className="space-y-2">
            <ErrorAlert
              error={impactError ?? t("delete.loadError")}
              compact
              actions={
                <button
                  type="button"
                  onClick={() => void loadImpact()}
                  className="inline-flex items-center gap-1.5 rounded-[2px] border border-cinnabar-rule bg-surface px-2.5 py-1 font-mono text-[11px] text-bone hover:bg-surface-2"
                >
                  <RefreshCw size={11} aria-hidden />
                  {t("delete.retryImpact")}
                </button>
              }
            />
          </div>
        ) : (
          <>
            {/* Consequences list from get_deletion_impact */}
            {impact.consequences.length > 0 && (
              <div className="space-y-2">
                <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-bone-subtle">
                  {t("delete.consequencesTitle")}
                </h3>
                <ul className="space-y-1.5 rounded-[2px] border border-rule bg-void p-3">
                  {impact.consequences.map((key) => (
                    <li key={key} className="flex items-start gap-2 text-xs leading-relaxed text-bone">
                      {consequenceIcon(key)}
                      <span>
                        {t(key, {
                          reuses: impact.reuse_count,
                          agents: impact.used_by.length,
                          versions: impact.history_versions,
                          snapshots: impact.snapshots_possibly_containing,
                          defaultValue: key,
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Agents relying on this memory */}
            {impact.used_by.length > 0 && (
              <div className="space-y-2 rounded-[2px] border border-ochre-rule bg-ochre-wash/70 p-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="inline-flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-ochre">
                    <Users size={12} aria-hidden />
                    {t("delete.agentsSectionTitle")}
                  </h3>
                  <span className="font-mono text-[10px] tabular-nums text-ochre">
                    {impact.used_by.length}
                  </span>
                </div>
                <div className="divide-y divide-ochre-rule/40">
                  {impact.used_by.map((agent) => (
                    <div key={agent.client_name} className="py-1.5 first:pt-0 last:pb-0">
                      <div className="flex items-center justify-between gap-2 font-mono text-xs">
                        <span className="font-semibold text-bone">
                          {formatAiClientName(agent.client_name)}
                        </span>
                        <span className="tabular-nums text-[11px] text-bone-muted">
                          {t("inspector.agentUsesCount", { count: agent.uses })} ·{" "}
                          {t("delete.agentLastUsed", { date: formatDate(agent.last_used_at) })}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[11px] text-ochre">{t("delete.agentWarning")}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Explicit version & snapshot counts when present */}
            {(impact.history_versions > 0 || impact.snapshots_possibly_containing > 0) && (
              <div className="grid grid-cols-1 gap-1.5 rounded-[2px] border border-rule bg-surface-2 px-3 py-2 font-mono text-[11px] text-bone-muted">
                {impact.history_versions > 0 && (
                  <div className="flex items-center gap-2">
                    <History size={12} className="shrink-0 text-bone-subtle" aria-hidden />
                    <span>
                      {t("delete.historyVersionsCount", { count: impact.history_versions })}
                    </span>
                  </div>
                )}
                {impact.snapshots_possibly_containing > 0 && (
                  <div className="flex items-center gap-2">
                    <Camera size={12} className="shrink-0 text-bone-subtle" aria-hidden />
                    <span>
                      {t("delete.snapshotsCount", {
                        count: impact.snapshots_possibly_containing,
                      })}
                    </span>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* Reversible Archive alternative */}
        <div className="space-y-2 rounded-[2px] border border-cobalt-rule bg-cobalt-wash/80 p-3">
          <div className="flex items-start gap-2">
            <Archive size={14} className="mt-0.5 shrink-0 text-cobalt-ink" aria-hidden />
            <div className="space-y-1 text-xs">
              <div className="font-semibold text-bone">{t("delete.archiveAlternativeTitle")}</div>
              <p className="leading-relaxed text-bone-muted">
                {memory.status === "archived"
                  ? t("delete.archiveAlternativeAlreadyArchived")
                  : t("delete.archiveAlternativeBody")}
              </p>
              {memory.is_core_pin && (
                <p className="text-[11px] text-ochre">
                  {t("delete.archiveAlternativeCorePinNote")}
                </p>
              )}
            </div>
          </div>

          {canArchiveInstead && (
            <button
              type="button"
              disabled={busy || archiving}
              onClick={() => void handleArchiveClick()}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-3 py-1.5 font-mono text-[11px] font-semibold text-bone transition-colors hover:bg-cobalt-bright disabled:opacity-45"
            >
              {archiving ? (
                <Loader2 size={12} className="animate-spin" aria-hidden />
              ) : (
                <Archive size={12} aria-hidden />
              )}
              {t("delete.archiveInsteadButton")}
            </button>
          )}
        </div>

        {/* Typed confirmation input */}
        <div className="space-y-1.5 border-t border-rule pt-3">
          <label
            htmlFor="permanent-delete-confirm-input"
            className="block text-xs text-bone-muted"
          >
            {t("delete.confirmPrompt", { word: confirmWord })}
          </label>
          <div className="flex items-center gap-2">
            <span className="shrink-0 rounded-[2px] border border-cinnabar-rule bg-cinnabar-wash px-2 py-1 font-mono text-xs font-bold tracking-[0.08em] text-cinnabar select-all">
              {confirmWord}
            </span>
            <input
              ref={inputRef}
              id="permanent-delete-confirm-input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              disabled={loadingImpact || !impact || busy || archiving || readOnly}
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canConfirm) {
                  void onConfirmDelete();
                }
              }}
              placeholder={t("delete.confirmPlaceholder")}
              className="h-8 flex-1 rounded-[2px] border border-rule-strong bg-void px-2.5 font-mono text-xs text-bone placeholder:text-bone-subtle focus:border-cinnabar focus:outline-none disabled:opacity-50"
            />
          </div>
        </div>
      </div>

      {/* Footer actions */}
      <div className="flex items-center justify-end gap-2 border-t border-rule bg-surface-2 px-4 py-3">
        <button
          type="button"
          disabled={busy || archiving}
          onClick={onCancel}
          className="rounded-[2px] border border-rule-strong bg-surface px-3 py-1.5 font-mono text-[11px] text-bone-muted hover:text-bone disabled:opacity-45"
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          disabled={!canConfirm}
          onClick={() => void onConfirmDelete()}
          className="inline-flex items-center gap-1.5 rounded-[2px] border border-cinnabar bg-cinnabar px-3.5 py-1.5 font-mono text-[11px] font-semibold text-bone transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? (
            <Loader2 size={12} className="animate-spin" aria-hidden />
          ) : (
            <Trash2 size={12} aria-hidden />
          )}
          {busy ? t("delete.deleting") : t("delete.confirmButton")}
        </button>
      </div>
    </section>
    </div>
  );
}
