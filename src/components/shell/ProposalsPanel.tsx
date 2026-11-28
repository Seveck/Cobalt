import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Clock,
  Compass,
  Inbox,
  Loader2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Shield,
  Trash2,
  X,
} from "lucide-react";
import { backendCall } from "@/lib/backend";
import { formatAiClientName } from "@/lib/format";
import { staggerStyle } from "@/lib/motion";
import { usePrefersReducedMotion } from "@/lib/usePrefersReducedMotion";
import {
  useFiltersStore,
  useMemoryStore,
  useProposalsStore,
  useSettingsStore,
  useThemeStore,
  useUiStore,
} from "@/stores";
import { Skeleton } from "@/components/ui";
import type {
  MemoryProposal,
  Project,
  ProposalKind,
  ProposalStatus,
  Uuid,
} from "@/types/contracts";

const PROPOSAL_TABS: readonly ProposalStatus[] = ["pending", "accepted", "rejected"] as const;

const KIND_CHIP_STYLES: Record<ProposalKind, string> = {
  decision: "border-cobalt-rule bg-cobalt-wash text-cobalt-ink",
  fix: "border-verdigris-rule bg-verdigris-wash text-verdigris",
  preference: "border-ochre-rule bg-ochre-wash text-ochre",
  suspicious: "border-cinnabar-rule bg-cinnabar-wash text-cinnabar",
};

function formatProposalRelativeTime(iso: string, t: TFunction): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) {
    return iso;
  }
  const diffMs = Math.max(0, Date.now() - parsed);
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) {
    return t("welcome.timeAgo.justNow");
  }
  if (diffMin < 60) {
    return t("welcome.timeAgo.minutes", { count: diffMin });
  }
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) {
    return t("welcome.timeAgo.hours", { count: diffHours });
  }
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) {
    return t("welcome.timeAgo.days", { count: diffDays });
  }
  try {
    return new Date(parsed).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}

function formatFullTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

interface ProposalCardProps {
  proposal: MemoryProposal;
  index: number;
  project: Project | null;
  draftText: string | undefined;
  isEditing: boolean;
  isEvidenceExpanded: boolean;
  isBusy: boolean;
  isBulkBusy: boolean;
  readOnly: boolean;
  prefersReducedMotion: boolean;
  onStartEdit: (proposal: MemoryProposal) => void;
  onChangeDraft: (id: Uuid, value: string) => void;
  onFinishEdit: () => void;
  onResetDraft: (id: Uuid) => void;
  onToggleEvidence: (id: Uuid) => void;
  onAccept: (proposal: MemoryProposal) => void;
  onReject: (proposal: MemoryProposal) => void;
  onLocateIn3D: (memoryId: Uuid) => void;
}

function ProposalCard({
  proposal,
  index,
  project,
  draftText,
  isEditing,
  isEvidenceExpanded,
  isBusy,
  isBulkBusy,
  readOnly,
  prefersReducedMotion,
  onStartEdit,
  onChangeDraft,
  onFinishEdit,
  onResetDraft,
  onToggleEvidence,
  onAccept,
  onReject,
  onLocateIn3D,
}: ProposalCardProps) {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const evidenceRef = useRef<HTMLDivElement>(null);
  const [evidenceClamped, setEvidenceClamped] = useState(false);

  useEffect(() => {
    if (isEditing) {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }
  }, [isEditing]);

  const isPending = proposal.status === "pending";
  const isSuspicious = proposal.kind === "suspicious";
  const currentContent = draftText ?? proposal.content;
  const isModified =
    draftText !== undefined && draftText.trim() !== proposal.content.trim();
  const trimmedEvidence = proposal.evidence?.trim() ?? "";
  const hasEvidence = trimmedEvidence.length > 0;
  const actionsDisabled = readOnly || isBusy || isBulkBusy;
  const acceptDisabled = actionsDisabled || currentContent.trim().length === 0;

  useEffect(() => {
    if (!hasEvidence || isEvidenceExpanded) return;
    const el = evidenceRef.current;
    if (!el) return;
    const measure = () => {
      setEvidenceClamped(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasEvidence, isEvidenceExpanded, trimmedEvidence]);

  return (
    <article
      style={prefersReducedMotion ? undefined : staggerStyle(index, 22, 8)}
      className={`${
        prefersReducedMotion ? "" : "cobalt-stagger-item"
      } space-y-2.5 rounded-[2px] border p-3.5 ${
        isSuspicious
          ? "border-ochre-rule bg-ochre-wash/20"
          : "border-rule bg-surface-2/85"
      }`}
    >
      {/* Top metadata row: kind chip + project + timestamp */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span
            className={`inline-flex items-center gap-1 rounded-[2px] border px-1.5 py-0.5 font-mono text-[10px] font-medium ${KIND_CHIP_STYLES[proposal.kind]}`}
          >
            {isSuspicious && <AlertTriangle size={10} className="shrink-0" aria-hidden />}
            {t(`proposals.kind.${proposal.kind}`)}
          </span>

          <span className="inline-flex max-w-[11rem] items-center gap-1.5 rounded-[2px] border border-rule bg-void px-1.5 py-0.5 font-mono text-[10px] text-bone-muted">
            {project ? (
              <>
                <span
                  className="h-2 w-2 shrink-0 rounded-[1px]"
                  style={{ backgroundColor: project.color_hex }}
                  aria-hidden
                />
                <span className="truncate text-bone" title={project.name}>
                  {project.name}
                </span>
              </>
            ) : (
              <span className="truncate">{t("brain.globalScope")}</span>
            )}
          </span>

          {isModified && isPending && (
            <span className="rounded-[2px] border border-ochre-rule bg-ochre-wash px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-ochre">
              {t("proposals.editedBadge")}
            </span>
          )}
        </div>

        <span
          title={formatFullTimestamp(proposal.created_at)}
          className="shrink-0 font-mono text-[10px] tabular-nums text-bone-subtle"
        >
          {formatProposalRelativeTime(proposal.created_at, t)}
        </span>
      </div>

      {/* Suspicious prompt-injection warning banner */}
      {isSuspicious && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-[2px] border border-ochre-rule bg-ochre-wash/75 px-2.5 py-2 text-[11px] leading-snug text-ochre"
        >
          <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden />
          <span>{t("proposals.suspiciousWarning")}</span>
        </div>
      )}

      {/* Source AI line */}
      <div className="flex items-center justify-between gap-2 text-[11px] text-bone-subtle">
        <span className="truncate">
          {t("proposals.fromAi", { client: formatAiClientName(proposal.client_name) })}
        </span>

        {isPending && !isEditing && !actionsDisabled && (
          <button
            type="button"
            onClick={() => onStartEdit(proposal)}
            className="inline-flex shrink-0 items-center gap-1 rounded-[2px] border border-transparent px-1.5 py-0.5 font-mono text-[10px] text-bone-muted hover:border-rule hover:bg-surface-3 hover:text-bone focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none"
          >
            <Pencil size={10} aria-hidden />
            {t("proposals.editAction")}
          </button>
        )}
      </div>

      {/* Proposal text (inline editable before accepting on pending tab) */}
      {isPending && isEditing ? (
        <div className="space-y-2">
          <textarea
            ref={textareaRef}
            rows={4}
            value={currentContent}
            disabled={actionsDisabled}
            aria-label={t("proposals.editContentAria")}
            onChange={(e) => onChangeDraft(proposal.id, e.target.value)}
            className="w-full resize-y rounded-[2px] border border-cobalt-rule bg-void p-2.5 text-xs leading-relaxed text-bone placeholder:text-bone-subtle focus:border-cobalt-ink focus:outline-none disabled:opacity-50"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            {isModified ? (
              <button
                type="button"
                onClick={() => onResetDraft(proposal.id)}
                className="inline-flex items-center gap-1 font-mono text-[10px] text-bone-muted hover:text-bone"
              >
                <RotateCcw size={10} aria-hidden />
                {t("proposals.resetText")}
              </button>
            ) : (
              <span />
            )}
            <button
              type="button"
              onClick={onFinishEdit}
              className="inline-flex items-center gap-1 rounded-[2px] border border-rule-strong bg-surface px-2 py-0.5 font-mono text-[10px] text-bone hover:border-cobalt-ink/60 hover:bg-surface-3"
            >
              <Check size={10} aria-hidden />
              {t("proposals.doneEditing")}
            </button>
          </div>
        </div>
      ) : (
        <p
          onDoubleClick={() => {
            if (isPending && !actionsDisabled) {
              onStartEdit(proposal);
            }
          }}
          className="text-xs leading-relaxed whitespace-pre-wrap break-words text-bone"
        >
          {currentContent}
        </p>
      )}

      {/* Evidence / context with expandable "Ver más" / "Ver menos" */}
      {hasEvidence && (
        <div className="space-y-1.5 border-t border-rule/80 pt-2">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-bone-subtle">
              {t("proposals.contextLabel")}
            </span>
            {(evidenceClamped || isEvidenceExpanded) && (
              <button
                type="button"
                aria-expanded={isEvidenceExpanded}
                onClick={() => onToggleEvidence(proposal.id)}
                className="inline-flex items-center gap-1 rounded-[2px] font-mono text-[10px] font-medium text-cobalt-ink hover:underline focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none"
              >
                <span>{isEvidenceExpanded ? t("proposals.showLess") : t("proposals.showMore")}</span>
                {isEvidenceExpanded ? (
                  <ChevronUp size={11} aria-hidden />
                ) : (
                  <ChevronDown size={11} aria-hidden />
                )}
              </button>
            )}
          </div>

          <div
            ref={evidenceRef}
            className={`rounded-[2px] border border-rule bg-void p-2.5 text-[11px] leading-relaxed whitespace-pre-wrap break-words text-bone-muted ${
              isEvidenceExpanded ? "" : "line-clamp-3"
            }`}
          >
            {trimmedEvidence}
          </div>
        </div>
      )}

      {/* Footer actions */}
      {isPending ? (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-rule pt-2.5">
          <button
            type="button"
            disabled={actionsDisabled}
            onClick={() => onReject(proposal)}
            className="inline-flex items-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface px-2.5 py-1 text-xs font-medium text-bone-muted hover:border-cinnabar-rule hover:bg-cinnabar-wash hover:text-cinnabar focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none disabled:opacity-45"
          >
            <X size={12} aria-hidden />
            {t("proposals.discard")}
          </button>

          <button
            type="button"
            disabled={acceptDisabled}
            onClick={() => onAccept(proposal)}
            className="inline-flex items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-3 py-1 text-xs font-semibold text-on-accent hover:bg-cobalt-bright focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none disabled:opacity-45"
          >
            {isBusy ? (
              <Loader2
                size={12}
                className={prefersReducedMotion ? "" : "animate-spin"}
                aria-hidden
              />
            ) : (
              <Check size={12} aria-hidden />
            )}
            {t("proposals.accept")}
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-rule pt-2 text-[11px]">
          <span
            className={`inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.08em] ${
              proposal.status === "accepted" ? "text-verdigris" : "text-bone-subtle"
            }`}
          >
            {proposal.status === "accepted" ? (
              <>
                <Check size={10} aria-hidden />
                {t("proposals.status.accepted")}
              </>
            ) : (
              <>
                <X size={10} aria-hidden />
                {t("proposals.status.rejected")}
              </>
            )}
          </span>

          {proposal.status === "accepted" && proposal.memory_id && (
            <button
              type="button"
              onClick={() => onLocateIn3D(proposal.memory_id!)}
              className="inline-flex items-center gap-1 rounded-[2px] border border-cobalt-rule bg-cobalt-wash px-2 py-0.5 font-mono text-[10px] text-cobalt-ink hover:bg-cobalt hover:text-on-accent focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none"
            >
              <Compass size={10} aria-hidden />
              {t("library.locate3D")}
            </button>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * Side panel ("Propuestas") displaying pending memory proposals for user review
 * alongside accepted/rejected history tabs.
 */
export function ProposalsPanel() {
  const { t } = useTranslation();
  const prefersReducedMotion = usePrefersReducedMotion();

  const open = useProposalsStore((s) => s.open);
  const activeTab = useProposalsStore((s) => s.activeTab);
  const pendingCount = useProposalsStore((s) => s.pendingCount);
  const itemsByStatus = useProposalsStore((s) => s.itemsByStatus);
  const loadingTab = useProposalsStore((s) => s.loadingTab);
  const unsupported = useProposalsStore((s) => s.unsupported);
  const error = useProposalsStore((s) => s.error);
  const busyIds = useProposalsStore((s) => s.busyIds);
  const bulkBusy = useProposalsStore((s) => s.bulkBusy);
  const closePanel = useProposalsStore((s) => s.closePanel);
  const setActiveTab = useProposalsStore((s) => s.setActiveTab);
  const loadProposals = useProposalsStore((s) => s.loadProposals);
  const acceptProposal = useProposalsStore((s) => s.acceptProposal);
  const rejectProposal = useProposalsStore((s) => s.rejectProposal);
  const acceptAllPending = useProposalsStore((s) => s.acceptAllPending);
  const rejectAllPending = useProposalsStore((s) => s.rejectAllPending);
  const clearError = useProposalsStore((s) => s.clearError);

  const readOnly = useSettingsStore((s) => s.settings.read_only);
  const graphProjects = useMemoryStore((s) => s.graph?.projects);
  const setSelectedNodeId = useMemoryStore((s) => s.setSelectedNodeId);
  const resetVisualFilters = useFiltersStore((s) => s.resetFilters);
  const setActiveNav = useUiStore((s) => s.setActiveNav);
  const pushThemeToast = useThemeStore((s) => s.pushThemeToast);

  const [extraProjects, setExtraProjects] = useState<Project[]>([]);
  const [editingId, setEditingId] = useState<Uuid | null>(null);
  const [draftEdits, setDraftEdits] = useState<Record<string, string>>({});
  const [expandedEvidenceIds, setExpandedEvidenceIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [confirmBulk, setConfirmBulk] = useState<"accept" | "reject" | null>(null);

  useEffect(() => {
    if (!open) {
      setConfirmBulk(null);
      setEditingId(null);
      return;
    }
    void backendCall("list_projects", { include_archived: true })
      .then((stats) => setExtraProjects(stats.map((s) => s.project)))
      .catch(() => {
        // Fall back silently to projects already present in graph state.
      });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || bulkBusy !== null) return;
      event.preventDefault();
      if (confirmBulk !== null) {
        setConfirmBulk(null);
      } else if (editingId !== null) {
        setEditingId(null);
      } else {
        closePanel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [bulkBusy, closePanel, confirmBulk, editingId, open]);

  const projectMap = useMemo(() => {
    const map = new Map<Uuid, Project>();
    for (const p of extraProjects) {
      map.set(p.id, p);
    }
    for (const stat of graphProjects ?? []) {
      map.set(stat.project.id, stat.project);
    }
    return map;
  }, [extraProjects, graphProjects]);

  const items = itemsByStatus[activeTab];
  const isLoading = loadingTab === activeTab;

  const handleStartEdit = useCallback((proposal: MemoryProposal) => {
    setDraftEdits((prev) =>
      proposal.id in prev ? prev : { ...prev, [proposal.id]: proposal.content },
    );
    setEditingId(proposal.id);
  }, []);

  const handleChangeDraft = useCallback((id: Uuid, value: string) => {
    setDraftEdits((prev) => ({ ...prev, [id]: value }));
  }, []);

  const handleResetDraft = useCallback((id: Uuid) => {
    setDraftEdits((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const handleToggleEvidence = useCallback((id: Uuid) => {
    setExpandedEvidenceIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleAccept = useCallback(
    async (proposal: MemoryProposal) => {
      const draft = draftEdits[proposal.id];
      const trimmedDraft = typeof draft === "string" ? draft.trim() : null;
      const contentArg =
        trimmedDraft !== null &&
        trimmedDraft.length > 0 &&
        trimmedDraft !== proposal.content.trim()
          ? trimmedDraft
          : undefined;

      const saved = await acceptProposal(proposal.id, contentArg);
      if (saved) {
        setEditingId((curr) => (curr === proposal.id ? null : curr));
        setDraftEdits((prev) => {
          if (!(proposal.id in prev)) return prev;
          const next = { ...prev };
          delete next[proposal.id];
          return next;
        });
        pushThemeToast({
          kind: "saved",
          message: t("proposals.savedToast"),
        });
      }
    },
    [acceptProposal, draftEdits, pushThemeToast, t],
  );

  const handleReject = useCallback(
    async (proposal: MemoryProposal) => {
      const rejected = await rejectProposal(proposal.id);
      if (rejected) {
        setEditingId((curr) => (curr === proposal.id ? null : curr));
        setDraftEdits((prev) => {
          if (!(proposal.id in prev)) return prev;
          const next = { ...prev };
          delete next[proposal.id];
          return next;
        });
      }
    },
    [rejectProposal],
  );

  const handleConfirmBulk = useCallback(async () => {
    const action = confirmBulk;
    if (!action) return;
    setConfirmBulk(null);
    setEditingId(null);

    if (action === "accept") {
      const result = await acceptAllPending(draftEdits);
      if (result.succeeded > 0) {
        setDraftEdits({});
        pushThemeToast({
          kind: "saved",
          message:
            result.succeeded === 1
              ? t("proposals.savedToast")
              : t("proposals.savedAllToast", { count: result.succeeded }),
        });
      }
    } else {
      const result = await rejectAllPending();
      if (result.succeeded > 0) {
        setDraftEdits({});
      }
    }
  }, [acceptAllPending, confirmBulk, draftEdits, pushThemeToast, rejectAllPending, t]);

  const handleLocateIn3D = useCallback(
    (memoryId: Uuid) => {
      resetVisualFilters();
      setSelectedNodeId(memoryId);
      setActiveNav("brain");
    },
    [resetVisualFilters, setActiveNav, setSelectedNodeId],
  );

  if (!open) {
    return null;
  }

  return (
    <aside
      id="cobalt-proposals-panel"
      aria-label={t("proposals.title")}
      className={`${
        prefersReducedMotion ? "" : "cobalt-drawer-enter-right"
      } flex h-full w-96 max-w-[calc(100vw-3rem)] shrink-0 flex-col border-l border-rule-strong bg-surface text-bone sm:w-[420px]`}
    >
      {/* Header */}
      <header className="flex items-start justify-between gap-2 border-b border-rule px-4 py-3.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Inbox size={15} className="shrink-0 text-cobalt-ink" aria-hidden />
            <h2 className="truncate text-sm font-semibold tracking-tight text-bone">
              {t("proposals.title")}
            </h2>
            {pendingCount > 0 && !unsupported && (
              <span className="inline-flex items-center rounded-[2px] border border-cobalt-rule bg-cobalt-wash px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums text-cobalt-ink">
                {pendingCount}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[11px] text-bone-muted">{t("proposals.subtitle")}</p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            disabled={isLoading || bulkBusy !== null}
            onClick={() => void loadProposals(activeTab)}
            aria-label={t("common.refresh")}
            title={t("common.refresh")}
            className="inline-flex h-7 w-7 items-center justify-center rounded-[2px] border border-transparent text-bone-muted hover:border-rule hover:bg-surface-2 hover:text-bone focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none disabled:opacity-45"
          >
            <RefreshCw
              size={13}
              className={isLoading && !prefersReducedMotion ? "animate-spin" : ""}
              aria-hidden
            />
          </button>
          <button
            type="button"
            disabled={bulkBusy !== null}
            onClick={closePanel}
            aria-label={t("common.close")}
            title={t("common.close")}
            className="inline-flex h-7 w-7 items-center justify-center rounded-[2px] border border-transparent text-bone-muted hover:border-rule hover:bg-surface-2 hover:text-bone focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none disabled:opacity-45"
          >
            <X size={14} aria-hidden />
          </button>
        </div>
      </header>

      {/* Tabs: Pending / Accepted / Rejected */}
      {!unsupported && (
        <div
          role="tablist"
          aria-label={t("proposals.tabsAria")}
          className="grid grid-cols-3 border-b border-rule bg-surface-2/60 p-1"
        >
          {PROPOSAL_TABS.map((tab) => {
            const selected = activeTab === tab;
            return (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => {
                  setConfirmBulk(null);
                  setEditingId(null);
                  setActiveTab(tab);
                }}
                className={`inline-flex items-center justify-center gap-1.5 rounded-[2px] px-2 py-1.5 text-xs font-medium ${
                  prefersReducedMotion ? "" : "transition-colors"
                } focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none ${
                  selected
                    ? "bg-surface text-bone shadow-[inset_0_0_0_1px_var(--color-rule-strong)]"
                    : "text-bone-muted hover:text-bone"
                }`}
              >
                <span className="truncate">{t(`proposals.tabs.${tab}`)}</span>
                {tab === "pending" && pendingCount > 0 && (
                  <span className="rounded-[2px] bg-cobalt-wash px-1 py-0.5 font-mono text-[9px] leading-none font-semibold tabular-nums text-cobalt-ink">
                    {pendingCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Main scrollable content */}
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {unsupported ? (
          <div className="rounded-[2px] border border-rule bg-surface-2/60 px-5 py-10 text-center">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-[2px] border border-cobalt-rule bg-cobalt-wash text-cobalt-ink">
              <Clock size={18} aria-hidden />
            </div>
            <h3 className="mt-3.5 text-sm font-semibold text-bone">
              {t("proposals.comingSoonTitle")}
            </h3>
            <p className="mx-auto mt-1.5 max-w-xs text-xs leading-relaxed text-bone-muted">
              {t("proposals.comingSoonDesc")}
            </p>
            <button
              type="button"
              disabled={isLoading}
              onClick={() => void loadProposals("pending")}
              className="mt-4 inline-flex items-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface px-3 py-1.5 font-mono text-[11px] text-bone-muted hover:border-cobalt-rule hover:text-bone disabled:opacity-45"
            >
              <RefreshCw
                size={11}
                className={isLoading && !prefersReducedMotion ? "animate-spin" : ""}
                aria-hidden
              />
              {t("proposals.retryAction")}
            </button>
          </div>
        ) : (
          <>
            {readOnly && activeTab === "pending" && (
              <div className="flex items-start gap-2 rounded-[2px] border border-ochre-rule bg-ochre-wash/70 px-3 py-2 text-[11px] text-ochre">
                <Shield size={13} className="mt-0.5 shrink-0" aria-hidden />
                <span>{t("proposals.readOnlyNotice")}</span>
              </div>
            )}

            {error && (
              <div className="flex items-start justify-between gap-2 rounded-[2px] border border-cinnabar-rule bg-cinnabar-wash px-3 py-2 text-xs text-cinnabar">
                <span className="min-w-0 break-words">{error}</span>
                <button
                  type="button"
                  onClick={clearError}
                  aria-label={t("common.close")}
                  className="shrink-0 rounded-[2px] p-0.5 text-cinnabar hover:bg-cinnabar/15"
                >
                  <X size={12} aria-hidden />
                </button>
              </div>
            )}

            {/* Bulk actions bar on pending tab */}
            {activeTab === "pending" && items.length > 0 && (
              <div className="space-y-2 rounded-[2px] border border-rule bg-void/75 p-2.5">
                {confirmBulk === null ? (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-bone-subtle">
                      {t("proposals.pendingSummary", { count: items.length })}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={readOnly || bulkBusy !== null}
                        onClick={() => setConfirmBulk("reject")}
                        className="inline-flex items-center gap-1 rounded-[2px] border border-rule-strong bg-surface px-2 py-1 font-mono text-[10px] text-bone-muted hover:border-cinnabar-rule hover:bg-cinnabar-wash hover:text-cinnabar disabled:opacity-45"
                      >
                        <Trash2 size={10} aria-hidden />
                        {t("proposals.discardAll")}
                      </button>
                      <button
                        type="button"
                        disabled={readOnly || bulkBusy !== null}
                        onClick={() => setConfirmBulk("accept")}
                        className="inline-flex items-center gap-1 rounded-[2px] border border-cobalt-rule bg-cobalt-wash px-2 py-1 font-mono text-[10px] font-semibold text-cobalt-ink hover:bg-cobalt hover:text-on-accent disabled:opacity-45"
                      >
                        <CheckCheck size={11} aria-hidden />
                        {t("proposals.acceptAll")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs leading-snug text-bone">
                      {confirmBulk === "accept"
                        ? t("proposals.confirmAcceptAll", { count: items.length })
                        : t("proposals.confirmRejectAll", { count: items.length })}
                    </p>
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        disabled={bulkBusy !== null}
                        onClick={() => setConfirmBulk(null)}
                        className="rounded-[2px] border border-rule-strong bg-surface px-2.5 py-1 font-mono text-[10px] text-bone-muted hover:text-bone disabled:opacity-45"
                      >
                        {t("common.cancel")}
                      </button>
                      <button
                        type="button"
                        disabled={readOnly || bulkBusy !== null}
                        onClick={() => void handleConfirmBulk()}
                        className={`inline-flex items-center gap-1 rounded-[2px] border px-2.5 py-1 font-mono text-[10px] font-semibold disabled:opacity-45 ${
                          confirmBulk === "accept"
                            ? "border-cobalt-rule bg-cobalt text-on-accent hover:bg-cobalt-bright"
                            : "border-cinnabar-rule bg-cinnabar text-on-accent hover:opacity-90"
                        }`}
                      >
                        {bulkBusy !== null ? (
                          <Loader2
                            size={10}
                            className={prefersReducedMotion ? "" : "animate-spin"}
                            aria-hidden
                          />
                        ) : confirmBulk === "accept" ? (
                          <CheckCheck size={10} aria-hidden />
                        ) : (
                          <Trash2 size={10} aria-hidden />
                        )}
                        {confirmBulk === "accept"
                          ? t("proposals.confirmAcceptAllAction")
                          : t("proposals.confirmRejectAllAction")}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Loading skeletons */}
            {isLoading && items.length === 0 ? (
              <div className="space-y-3" aria-busy="true" aria-label={t("proposals.loading")}>
                {[0, 1, 2].map((idx) => (
                  <div
                    key={idx}
                    className="space-y-2.5 rounded-[2px] border border-rule bg-surface-2/60 p-3.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <Skeleton className="h-4 w-24" />
                      <Skeleton className="h-3 w-14" />
                    </div>
                    <Skeleton className="h-3 w-28" />
                    <Skeleton className="h-12 w-full" />
                  </div>
                ))}
              </div>
            ) : items.length === 0 ? (
              <div className="rounded-[2px] border border-rule bg-surface-2/50 px-5 py-10 text-center">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-[2px] border border-rule bg-void text-bone-subtle">
                  <Inbox size={18} aria-hidden />
                </div>
                <p className="mx-auto mt-3 max-w-xs text-xs leading-relaxed text-bone-muted">
                  {t(`proposals.empty.${activeTab}`)}
                </p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {items.map((proposal, index) => (
                  <ProposalCard
                    key={proposal.id}
                    proposal={proposal}
                    index={index}
                    project={
                      proposal.project_id ? (projectMap.get(proposal.project_id) ?? null) : null
                    }
                    draftText={draftEdits[proposal.id]}
                    isEditing={editingId === proposal.id}
                    isEvidenceExpanded={expandedEvidenceIds.has(proposal.id)}
                    isBusy={Boolean(busyIds[proposal.id])}
                    isBulkBusy={bulkBusy !== null}
                    readOnly={readOnly}
                    prefersReducedMotion={prefersReducedMotion}
                    onStartEdit={handleStartEdit}
                    onChangeDraft={handleChangeDraft}
                    onFinishEdit={() => setEditingId(null)}
                    onResetDraft={handleResetDraft}
                    onToggleEvidence={handleToggleEvidence}
                    onAccept={(p) => void handleAccept(p)}
                    onReject={(p) => void handleReject(p)}
                    onLocateIn3D={handleLocateIn3D}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
