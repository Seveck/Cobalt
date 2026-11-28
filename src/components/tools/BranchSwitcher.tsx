import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, GitBranch, GitMerge, Plus, Trash2 } from "lucide-react";
import { useBranchesStore, useMemoryStore, useSettingsStore } from "@/stores";
import { ErrorAlert } from "@/components/ui";
import { MAIN_BRANCH_ID } from "@/types/contracts";

export function BranchSwitcher() {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);

  const branches = useBranchesStore((s) => s.branches);
  const activeBranchId = useBranchesStore((s) => s.activeBranchId);
  const mutating = useBranchesStore((s) => s.mutating);
  const error = useBranchesStore((s) => s.error);
  const lastMergeReport = useBranchesStore((s) => s.lastMergeReport);
  const createBranch = useBranchesStore((s) => s.createBranch);
  const switchBranch = useBranchesStore((s) => s.switchBranch);
  const mergeBranch = useBranchesStore((s) => s.mergeBranch);
  const discardBranch = useBranchesStore((s) => s.discardBranch);
  const clearMergeReport = useBranchesStore((s) => s.clearMergeReport);
  const clearError = useBranchesStore((s) => s.clearError);

  const loadGraph = useMemoryStore((s) => s.loadGraph);
  const setSelectedNodeId = useMemoryStore((s) => s.setSelectedNodeId);
  const readOnly = useSettingsStore((s) => s.settings.read_only);

  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [confirmDiscardId, setConfirmDiscardId] = useState<string | null>(null);

  const activeBranch = branches.find((b) => b.id === activeBranchId) ?? branches[0];

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const handleSwitch = async (id: string) => {
    if (id === activeBranchId) {
      setOpen(false);
      return;
    }
    const switched = await switchBranch(id);
    if (switched) {
      setSelectedNodeId(null);
      await loadGraph({ branch_id: switched.id });
      setOpen(false);
    }
  };

  const handleCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed || readOnly) return;
    const created = await createBranch(trimmed, activeBranchId);
    if (created) {
      setNewName("");
      const switched = await switchBranch(created.id);
      if (switched) {
        setSelectedNodeId(null);
        await loadGraph({ branch_id: switched.id });
      }
    }
  };

  const handleMerge = async (id: string) => {
    if (readOnly) return;
    const report = await mergeBranch(id);
    if (report) {
      await loadGraph();
    }
  };

  const handleDiscard = async (id: string) => {
    if (readOnly) return;
    const ok = await discardBranch(id);
    setConfirmDiscardId(null);
    if (ok) {
      setSelectedNodeId(null);
      await loadGraph();
    }
  };

  return (
    <div ref={containerRef} className="pointer-events-auto relative">
      <button
        type="button"
        onClick={() => {
          clearError();
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface/95 px-2.5 py-1 font-mono text-[11px] text-bone transition-colors hover:border-cobalt-ink/60 hover:bg-surface-2 focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none"
      >
        <GitBranch size={12} className="text-cobalt-ink" aria-hidden />
        <span className="max-w-[120px] truncate font-medium">
          {activeBranch?.name ?? "main"}
        </span>
        {branches.length > 1 && (
          <span className="rounded-[2px] bg-cobalt-wash px-1 text-[9px] tabular-nums text-cobalt-ink">
            {branches.length}
          </span>
        )}
        <ChevronDown
          size={11}
          className={`text-bone-subtle transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>

      {open && (
        <div className="cobalt-panel-enter-down absolute top-full left-0 z-30 mt-1.5 w-80 rounded-[2px] border border-rule-strong bg-surface p-3 shadow-[0_16px_40px_rgba(0,0,0,0.78)]">
          <div className="mb-2 flex items-center justify-between border-b border-rule pb-2">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-bone-muted">
              {t("branches.title")}
            </span>
            <span className="font-mono text-[10px] tabular-nums text-bone-subtle">
              {branches.length}
            </span>
          </div>

          <ErrorAlert error={error} compact className="mb-2" />

          {lastMergeReport && (
            <div className="mb-2 flex items-center justify-between gap-2 rounded-[2px] border border-verdigris-rule bg-verdigris-wash px-2 py-1.5 font-mono text-[10px] text-verdigris">
              <span>
                {t("branches.mergeReport", {
                  merged: lastMergeReport.merged,
                  superseded: lastMergeReport.superseded,
                  skipped: lastMergeReport.skipped_duplicates,
                })}
              </span>
              <button
                type="button"
                onClick={clearMergeReport}
                className="text-verdigris/80 hover:text-verdigris"
              >
                ×
              </button>
            </div>
          )}

          {/* Branch list */}
          <div className="max-h-52 space-y-1 overflow-y-auto">
            {branches.map((branch) => {
              const isActive = branch.id === activeBranchId;
              const isMain = branch.id === MAIN_BRANCH_ID;
              return (
                <div
                  key={branch.id}
                  className={`flex items-center justify-between gap-2 rounded-[2px] border px-2 py-1.5 font-mono text-[11px] ${
                    isActive
                      ? "border-cobalt-rule bg-cobalt-wash text-bone"
                      : "border-rule bg-void text-bone-muted hover:border-rule-strong hover:text-bone"
                  }`}
                >
                  <button
                    type="button"
                    disabled={mutating}
                    onClick={() => void handleSwitch(branch.id)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  >
                    {isActive && <Check size={11} className="shrink-0 text-cobalt-ink" aria-hidden />}
                    <span className="truncate font-medium">{branch.name}</span>
                  </button>

                  {!isMain && (
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        disabled={readOnly || mutating}
                        onClick={() => void handleMerge(branch.id)}
                        title={t("branches.mergeIntoParent")}
                        className="rounded-[2px] border border-rule bg-surface-2 p-1 text-bone-muted hover:border-cobalt-ink hover:text-cobalt-ink disabled:opacity-45"
                      >
                        <GitMerge size={11} aria-hidden />
                      </button>

                      {confirmDiscardId === branch.id ? (
                        <button
                          type="button"
                          disabled={mutating}
                          onClick={() => void handleDiscard(branch.id)}
                          className="rounded-[2px] bg-cinnabar px-1.5 py-0.5 text-[10px] font-semibold text-bone"
                        >
                          {t("branches.confirmDiscard")}
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={readOnly || mutating}
                          onClick={() => setConfirmDiscardId(branch.id)}
                          title={t("branches.discard")}
                          className="rounded-[2px] border border-rule bg-surface-2 p-1 text-bone-subtle hover:border-cinnabar-rule hover:text-cinnabar disabled:opacity-45"
                        >
                          <Trash2 size={11} aria-hidden />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Create new branch */}
          <div className="mt-3 flex gap-1.5 border-t border-rule pt-2.5">
            <input
              type="text"
              value={newName}
              disabled={readOnly || mutating}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreate();
              }}
              placeholder={t("branches.newPlaceholder")}
              className="h-7 flex-1 rounded-[2px] border border-rule-strong bg-void px-2 font-mono text-[11px] text-bone placeholder:text-bone-subtle focus:border-cobalt-ink focus:outline-none disabled:opacity-45"
            />
            <button
              type="button"
              disabled={readOnly || mutating || !newName.trim()}
              onClick={() => void handleCreate()}
              className="inline-flex h-7 items-center gap-1 rounded-[2px] border border-cobalt-rule bg-cobalt px-2.5 font-mono text-[10px] font-semibold text-bone hover:bg-cobalt-bright disabled:opacity-45"
            >
              <Plus size={11} aria-hidden />
              <span>{t("branches.create")}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
