import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, GitMerge, Loader2, RefreshCw, Sparkles, X } from "lucide-react";
import { backendCall } from "@/lib/backend";
import { useMemoryStore, useSettingsStore } from "@/stores";
import type { DuplicateCluster, Uuid } from "@/types/contracts";

interface CleanBrainPanelProps {
  onClose: () => void;
  onInspectMemory: (id: Uuid) => void;
}

export function CleanBrainPanel({ onClose, onInspectMemory }: CleanBrainPanelProps) {
  const { t } = useTranslation();

  const graph = useMemoryStore((s) => s.graph);
  const loadGraph = useMemoryStore((s) => s.loadGraph);
  const setHighlightedNodeIds = useMemoryStore((s) => s.setHighlightedNodeIds);
  const readOnly = useSettingsStore((s) => s.settings.read_only);

  const [clusters, setClusters] = useState<DuplicateCluster[]>([]);
  const [keepChoices, setKeepChoices] = useState<Record<number, Uuid>>({});
  const [loading, setLoading] = useState(true);
  const [mergingIdx, setMergingIdx] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mergedCount, setMergedCount] = useState(0);

  const nodeMap = useMemo(() => {
    const map = new Map(graph?.nodes.map((n) => [n.id, n]) ?? []);
    return map;
  }, [graph?.nodes]);

  const scan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const found = await backendCall("find_duplicates");
      setClusters(found);
      const defaults: Record<number, Uuid> = {};
      found.forEach((c, idx) => {
        defaults[idx] = c.suggested_keep_id;
      });
      setKeepChoices(defaults);
      setHighlightedNodeIds(found.flatMap((c) => c.memory_ids));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [setHighlightedNodeIds]);

  useEffect(() => {
    void scan();
    return () => {
      setHighlightedNodeIds([]);
    };
  }, [scan, setHighlightedNodeIds]);

  const handleMergeCluster = async (clusterIdx: number) => {
    if (readOnly) return;
    const cluster = clusters[clusterIdx];
    if (!cluster) return;

    const keepId = keepChoices[clusterIdx] ?? cluster.suggested_keep_id;
    const mergeIds = cluster.memory_ids.filter((id) => id !== keepId);
    if (mergeIds.length === 0) return;

    setMergingIdx(clusterIdx);
    setError(null);
    try {
      await backendCall("merge_duplicates", { keep_id: keepId, merge_ids: mergeIds });
      setMergedCount((c) => c + 1);
      await loadGraph();
      await scan();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMergingIdx(null);
    }
  };

  return (
    <aside className="flex h-full w-full max-w-[440px] flex-col border-l border-rule-strong bg-surface text-bone shadow-[-12px_0_32px_rgba(0,0,0,0.65)]">
      <div className="flex items-center justify-between gap-2 border-b border-rule px-4 py-3">
        <div>
          <div className="inline-flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-cobalt-ink">
            <Sparkles size={11} aria-hidden />
            {t("cleanBrain.title")}
          </div>
          <p className="mt-0.5 text-[11px] text-bone-muted">{t("cleanBrain.subtitle")}</p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={loading}
            onClick={() => void scan()}
            title={t("cleanBrain.rescan")}
            className="rounded-[2px] p-1.5 text-bone-muted hover:bg-surface-2 hover:text-bone disabled:opacity-45"
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} aria-hidden />
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

      {error && (
        <div className="border-b border-cinnabar-rule bg-cinnabar-wash px-4 py-2 text-xs text-cinnabar">
          {error}
        </div>
      )}

      {mergedCount > 0 && (
        <div className="flex items-center gap-1.5 border-b border-verdigris-rule bg-verdigris-wash px-4 py-2 font-mono text-[11px] text-verdigris">
          <Check size={12} aria-hidden />
          <span>{t("cleanBrain.mergedNotice", { count: mergedCount })}</span>
        </div>
      )}

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 font-mono text-xs text-bone-muted">
            <Loader2 size={14} className="animate-spin text-cobalt-ink" aria-hidden />
            <span>{t("cleanBrain.scanning")}</span>
          </div>
        ) : clusters.length === 0 ? (
          <div className="rounded-[2px] border border-rule bg-void p-6 text-center">
            <p className="font-mono text-xs font-medium text-verdigris">{t("cleanBrain.cleanTitle")}</p>
            <p className="mt-1 text-xs text-bone-muted">{t("cleanBrain.cleanDesc")}</p>
          </div>
        ) : (
          clusters.map((cluster, idx) => {
            const keepId = keepChoices[idx] ?? cluster.suggested_keep_id;
            const isConflict = cluster.kind === "conflict";
            return (
              <div
                key={`${cluster.suggested_keep_id}-${idx}`}
                className="space-y-2.5 rounded-[2px] border border-rule bg-void p-3"
              >
                <div className="flex items-center justify-between gap-2 font-mono text-[10px]">
                  <span
                    className={`inline-flex items-center gap-1 rounded-[2px] border px-1.5 py-0.5 uppercase ${
                      isConflict
                        ? "border-ochre-rule bg-ochre-wash text-ochre"
                        : "border-cobalt-rule bg-cobalt-wash text-cobalt-ink"
                    }`}
                  >
                    {isConflict && <AlertTriangle size={10} aria-hidden />}
                    {t(`cleanBrain.kind.${cluster.kind}`)}
                  </span>
                  <span className="tabular-nums text-bone-muted">
                    {t("cleanBrain.similarity", {
                      value: Math.round(cluster.max_similarity * 100),
                    })}
                  </span>
                </div>

                <div className="space-y-1.5">
                  {cluster.memory_ids.map((id) => {
                    const node = nodeMap.get(id);
                    const isKeep = keepId === id;
                    return (
                      <div
                        key={id}
                        className={`flex items-start gap-2 rounded-[2px] border p-2 transition-colors ${
                          isKeep
                            ? "border-cobalt-rule bg-cobalt-wash/60"
                            : "border-rule bg-surface"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() =>
                            setKeepChoices((prev) => ({
                              ...prev,
                              [idx]: id,
                            }))
                          }
                          aria-pressed={isKeep}
                          className={`mt-0.5 shrink-0 rounded-[2px] border px-1.5 py-0.5 font-mono text-[9px] uppercase ${
                            isKeep
                              ? "border-cobalt bg-cobalt text-bone"
                              : "border-rule-strong bg-surface-2 text-bone-subtle hover:text-bone"
                          }`}
                        >
                          {isKeep ? t("cleanBrain.keepBadge") : t("cleanBrain.selectKeep")}
                        </button>
                        <button
                          type="button"
                          onClick={() => onInspectMemory(id)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <p className="line-clamp-2 text-[11px] leading-relaxed text-bone">
                            {node ? node.preview : id}
                          </p>
                          {node && (
                            <div className="mt-1 font-mono text-[10px] tabular-nums text-bone-subtle">
                              {t("brain.hits", { count: node.hit_count })} ·{" "}
                              {t("brain.tokens", { count: node.chunk_tokens })}
                            </div>
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>

                <div className="flex items-center justify-end">
                  <button
                    type="button"
                    disabled={readOnly || mergingIdx === idx}
                    onClick={() => void handleMergeCluster(idx)}
                    className="inline-flex items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-3 py-1 font-mono text-[10px] font-semibold text-bone hover:bg-cobalt-bright disabled:opacity-45"
                  >
                    {mergingIdx === idx ? (
                      <Loader2 size={11} className="animate-spin" aria-hidden />
                    ) : (
                      <GitMerge size={11} aria-hidden />
                    )}
                    {t("cleanBrain.mergeCluster", { count: cluster.memory_ids.length - 1 })}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
