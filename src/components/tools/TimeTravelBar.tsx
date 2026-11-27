import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Camera, Clock, RotateCcw, Trash2, X } from "lucide-react";
import { backendCall } from "@/lib/backend";
import { useBranchesStore, useMemoryStore, useSettingsStore } from "@/stores";
import { Skeleton } from "@/components/ui";
import type { Snapshot } from "@/types/contracts";

interface TimeTravelBarProps {
  onClose: () => void;
}

function formatStamp(iso: string): string {
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

export function TimeTravelBar({ onClose }: TimeTravelBarProps) {
  const { t } = useTranslation();

  const loadGraph = useMemoryStore((s) => s.loadGraph);
  const loadBranches = useBranchesStore((s) => s.loadBranches);
  const readOnly = useSettingsStore((s) => s.settings.read_only);

  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [label, setLabel] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSnapshots = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await backendCall("list_snapshots");
      const sorted = [...list].sort((a, b) => a.created_at.localeCompare(b.created_at));
      setSnapshots(sorted);
      setSelectedIdx(Math.max(0, sorted.length - 1));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSnapshots();
  }, [fetchSnapshots]);

  const activeSnap = snapshots[selectedIdx] ?? null;

  const handleCreate = async () => {
    if (readOnly) return;
    setBusy(true);
    setError(null);
    try {
      const created = await backendCall("create_snapshot", {
        label: label.trim() || t("timeTravel.defaultLabel"),
      });
      setLabel("");
      await fetchSnapshots();
      setSelectedIdx(snapshots.length);
      if (created) setConfirmRestore(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRestore = async () => {
    if (!activeSnap || readOnly) return;
    setBusy(true);
    setError(null);
    try {
      await backendCall("restore_snapshot", { id: activeSnap.id });
      setConfirmRestore(false);
      await Promise.all([loadBranches(), loadGraph()]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!activeSnap || readOnly) return;
    setBusy(true);
    setError(null);
    try {
      await backendCall("delete_snapshot", { id: activeSnap.id });
      setConfirmRestore(false);
      await fetchSnapshots();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cobalt-panel-enter-up pointer-events-auto w-full max-w-4xl rounded-[2px] border border-rule-strong bg-surface p-3 shadow-[0_14px_36px_rgba(0,0,0,0.72)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rule pb-2">
        <div className="flex items-center gap-2">
          <Clock size={13} className="text-cobalt-ink" aria-hidden />
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-bone">
            {t("timeTravel.title")}
          </span>
          <span className="font-mono text-[10px] tabular-nums text-bone-subtle">
            ({snapshots.length})
          </span>
        </div>

        {/* Inline create snapshot form */}
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={label}
            disabled={readOnly || busy}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreate();
            }}
            placeholder={t("timeTravel.labelPlaceholder")}
            className="h-7 w-44 rounded-[2px] border border-rule-strong bg-void px-2 font-mono text-[11px] text-bone placeholder:text-bone-subtle focus:border-cobalt-ink focus:outline-none disabled:opacity-45"
          />
          <button
            type="button"
            disabled={readOnly || busy}
            onClick={() => void handleCreate()}
            className="inline-flex h-7 items-center gap-1 rounded-[2px] border border-cobalt-rule bg-cobalt px-2.5 font-mono text-[10px] font-semibold text-bone hover:bg-cobalt-bright disabled:opacity-45"
          >
            <Camera size={11} aria-hidden />
            <span>{t("timeTravel.create")}</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="rounded-[2px] p-1 text-bone-subtle hover:bg-surface-2 hover:text-bone"
          >
            <X size={13} aria-hidden />
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-2 rounded-[2px] border border-cinnabar-rule bg-cinnabar-wash px-2.5 py-1.5 text-[11px] text-cinnabar">
          {error}
        </div>
      )}

      {loading ? (
        <div className="mt-2.5 space-y-2" aria-busy="true" aria-label={t("timeTravel.loading")}>
          <Skeleton className="h-2.5 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      ) : snapshots.length === 0 ? (
        <p className="py-3 text-xs text-bone-subtle">{t("timeTravel.empty")}</p>
      ) : (
        <div className="mt-2.5 space-y-2">
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10px] tabular-nums text-bone-subtle">
              {formatStamp(snapshots[0]!.created_at)}
            </span>
            <input
              type="range"
              min={0}
              max={Math.max(0, snapshots.length - 1)}
              step={1}
              value={Math.min(selectedIdx, Math.max(0, snapshots.length - 1))}
              onChange={(e) => {
                setSelectedIdx(Number(e.target.value));
                setConfirmRestore(false);
              }}
              aria-label={t("timeTravel.sliderAria")}
              className="h-1.5 flex-1 cursor-pointer accent-cobalt"
            />
            <span className="font-mono text-[10px] tabular-nums text-bone-subtle">
              {formatStamp(snapshots[snapshots.length - 1]!.created_at)}
            </span>
          </div>

          {activeSnap && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-[2px] border border-rule bg-void px-3 py-2">
              <div className="min-w-0">
                <div className="truncate font-mono text-xs font-medium text-bone">
                  {activeSnap.label}
                </div>
                <div className="mt-0.5 font-mono text-[10px] tabular-nums text-bone-subtle">
                  {formatStamp(activeSnap.created_at)} ·{" "}
                  {t("timeTravel.memoryCount", { count: activeSnap.memory_count })}
                </div>
              </div>

              <div className="flex items-center gap-1.5">
                {!confirmRestore ? (
                  <button
                    type="button"
                    disabled={readOnly || busy}
                    onClick={() => setConfirmRestore(true)}
                    className="inline-flex items-center gap-1 rounded-[2px] border border-ochre-rule bg-ochre-wash px-2.5 py-1 font-mono text-[10px] font-medium text-ochre hover:border-ochre disabled:opacity-45"
                  >
                    <RotateCcw size={11} aria-hidden />
                    {t("timeTravel.restore")}
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleRestore()}
                      className="rounded-[2px] border border-ochre bg-ochre px-2.5 py-1 font-mono text-[10px] font-semibold text-void"
                    >
                      {t("timeTravel.confirmRestore")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmRestore(false)}
                      className="rounded-[2px] border border-rule bg-surface-2 px-2 py-1 font-mono text-[10px] text-bone-muted"
                    >
                      {t("common.cancel")}
                    </button>
                  </>
                )}

                <button
                  type="button"
                  disabled={readOnly || busy}
                  onClick={() => void handleDelete()}
                  title={t("timeTravel.delete")}
                  className="rounded-[2px] border border-rule bg-surface-2 p-1 text-bone-subtle hover:border-cinnabar-rule hover:text-cinnabar disabled:opacity-45"
                >
                  <Trash2 size={12} aria-hidden />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
