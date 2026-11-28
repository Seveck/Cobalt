import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Link2, Loader2, Pin, Search, SlidersHorizontal, X } from "lucide-react";
import { backendCall } from "@/lib/backend";
import { staggerStyle } from "@/lib/motion";
import {
  splitProjects,
  truncateMemoryPreview,
  UNSORTED_PROJECT_NAME,
} from "@/lib/projects";
import { formatSavingsEstimate } from "@/lib/savings";
import {
  useBranchesStore,
  useMemoryStore,
  useSettingsStore,
} from "@/stores";
import { OutdatedHitBanner, Select, Skeleton, Toggle, type SelectOption } from "@/components/ui";
import type { FileAvailability, ProjectScope, SearchResponse, Uuid } from "@/types/contracts";

interface RagDebuggerProps {
  onClose: () => void;
  onInspectMemory: (id: string) => void;
}

export function RagDebugger({ onClose, onInspectMemory }: RagDebuggerProps) {
  const { t } = useTranslation();

  const graph = useMemoryStore((s) => s.graph);
  const setHighlightedNodeIds = useMemoryStore((s) => s.setHighlightedNodeIds);
  const activeBranchId = useBranchesStore((s) => s.activeBranchId);
  const defaultSearch = useSettingsStore((s) => s.settings.search);
  const savingsSettings = useSettingsStore((s) => s.settings.savings);

  const [query, setQuery] = useState("");
  const [scopeKey, setScopeKey] = useState<string>("all");
  const [topK, setTopK] = useState<number>(defaultSearch.top_k);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [onlyReusable, setOnlyReusable] = useState(false);
  const [expandGraph, setExpandGraph] = useState(true);

  const [useRrfOverride, setUseRrfOverride] = useState(true);
  const [rrfK, setRrfK] = useState<number>(defaultSearch.rrf.k);
  const [vectorWeight, setVectorWeight] = useState<number>(defaultSearch.rrf.vector_weight);
  const [ftsWeight, setFtsWeight] = useState<number>(defaultSearch.rrf.fts_weight);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [docAvailability, setDocAvailability] = useState<Record<Uuid, FileAvailability>>({});
  const searchSeqRef = useRef(0);

  // Clear 3D highlights when closing debugger
  useEffect(() => {
    return () => {
      setHighlightedNodeIds([]);
    };
  }, [setHighlightedNodeIds]);

  const scopeOptions = useMemo<SelectOption<string>[]>(() => {
    const { regular, unsorted } = splitProjects(graph?.projects ?? []);
    const base: SelectOption<string>[] = [
      { value: "all", label: t("rag.scopeAll") },
      { value: "global", label: t("brain.globalScope") },
    ];
    for (const stat of regular) {
      base.push({
        value: `project:${stat.project.id}`,
        label: stat.project.name,
        detail: t("rag.scopeProjectOnly"),
      });
      base.push({
        value: `project_and_global:${stat.project.id}`,
        label: `${stat.project.name} + ${t("brain.globalScope")}`,
      });
    }
    if (unsorted) {
      base.push({
        value: `project:${unsorted.project.id}`,
        label:
          unsorted.vector_count > 0
            ? `${UNSORTED_PROJECT_NAME} (${unsorted.vector_count})`
            : UNSORTED_PROJECT_NAME,
        detail: t("unsorted.shortDetail"),
      });
    }
    return base;
  }, [graph?.projects, t]);

  const resolveScope = (): ProjectScope => {
    if (scopeKey === "all") return { kind: "all" };
    if (scopeKey === "global") return { kind: "global" };
    if (scopeKey.startsWith("project_and_global:")) {
      return { kind: "project_and_global", project_id: scopeKey.slice("project_and_global:".length) };
    }
    if (scopeKey.startsWith("project:")) {
      return { kind: "project", project_id: scopeKey.slice("project:".length) };
    }
    return { kind: "all" };
  };

  const runSearch = async () => {
    const trimmed = query.trim();
    if (!trimmed) return;

    const seq = searchSeqRef.current + 1;
    searchSeqRef.current = seq;
    setLoading(true);
    setError(null);
    setDocAvailability({});
    try {
      const response = await backendCall("search_memories", {
        query: trimmed,
        scope: resolveScope(),
        branch_id: activeBranchId,
        top_k: Math.max(1, Math.min(50, topK)),
        include_archived: includeArchived,
        filter: {
          source_types: [],
          categories: [],
          only_reusable: onlyReusable,
          min_confidence: null,
        },
        rrf_override: useRrfOverride
          ? {
              k: Math.max(1, rrfK),
              vector_weight: Math.max(0, vectorWeight),
              fts_weight: Math.max(0, ftsWeight),
            }
          : null,
        record_hits: false,
        expand_graph: expandGraph,
      });
      if (searchSeqRef.current !== seq) return;
      setResult(response);
      setHighlightedNodeIds(response.hits.map((h) => h.memory.id));

      // Verify linked source documents on disk so modified files show a clear badge.
      const docIds = Array.from(
        new Set(
          [...response.hits.map((h) => h.memory.source_doc_id), ...response.core_rules.map((r) => r.source_doc_id)].filter(
            (id): id is Uuid => Boolean(id),
          ),
        ),
      );
      if (docIds.length > 0) {
        void Promise.allSettled(
          docIds.map(async (id) => ({
            id,
            status: await backendCall("verify_source_document", { id }),
          })),
        ).then((settled) => {
          if (searchSeqRef.current !== seq) return;
          const nextMap: Record<Uuid, FileAvailability> = {};
          for (const entry of settled) {
            if (entry.status === "fulfilled") {
              nextMap[entry.value.id] = entry.value.status;
            }
          }
          setDocAvailability(nextMap);
        });
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <aside className="cobalt-drawer-enter-right flex h-full w-full max-w-[440px] flex-col border-l border-rule-strong bg-surface text-bone shadow-[-12px_0_32px_rgba(0,0,0,0.65)]">
      <div className="flex items-center justify-between gap-2 border-b border-rule px-4 py-3">
        <div>
          <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-cobalt-ink">
            {t("rag.title")}
          </div>
          <p className="mt-0.5 text-[11px] text-bone-muted">{t("rag.subtitle")}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          className="rounded-[2px] p-1.5 text-bone-muted hover:bg-surface-2 hover:text-bone"
        >
          <X size={14} aria-hidden />
        </button>
      </div>

      {/* Query controls */}
      <div className="space-y-3 border-b border-rule bg-void/60 p-4">
        <div className="flex gap-1.5">
          <div className="relative flex-1">
            <Search
              size={13}
              className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-bone-subtle"
              aria-hidden
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void runSearch();
              }}
              placeholder={t("rag.queryPlaceholder")}
              className="h-9 w-full rounded-[2px] border border-rule-strong bg-surface pr-3 pl-8 text-xs text-bone placeholder:text-bone-subtle focus:border-cobalt-ink focus:outline-none"
            />
          </div>
          <button
            type="button"
            disabled={loading || !query.trim()}
            onClick={() => void runSearch()}
            className="inline-flex items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-3 font-mono text-[11px] font-semibold text-bone hover:bg-cobalt-bright disabled:opacity-45"
          >
            {loading ? (
              <Loader2 size={12} className="animate-spin" aria-hidden />
            ) : (
              <Search size={12} aria-hidden />
            )}
            {t("rag.run")}
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.1em] text-bone-subtle">
              {t("rag.scopeLabel")}
            </span>
            <Select<string>
              value={scopeKey}
              options={scopeOptions}
              size="sm"
              className="w-full"
              onChange={setScopeKey}
            />
          </div>
          <div>
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.1em] text-bone-subtle">
              {t("rag.topKLabel")}
            </span>
            <input
              type="number"
              min={1}
              max={50}
              value={topK}
              onChange={(e) => setTopK(Number(e.target.value) || 8)}
              className="h-7 w-full rounded-[2px] border border-rule-strong bg-surface-2 px-2.5 font-mono text-xs tabular-nums text-bone focus:border-cobalt-ink focus:outline-none"
            />
          </div>
        </div>

        {/* RRF Override block */}
        <div className="space-y-2 rounded-[2px] border border-rule bg-surface p-2.5">
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-bone-muted">
              <SlidersHorizontal size={11} className="text-cobalt-ink" aria-hidden />
              {t("rag.rrfOverride")}
            </span>
            <Toggle
              checked={useRrfOverride}
              ariaLabel={t("rag.rrfOverride")}
              onChange={setUseRrfOverride}
            />
          </div>

          {useRrfOverride && (
            <div className="grid grid-cols-3 gap-2 pt-1 font-mono text-[10px]">
              <label className="space-y-1">
                <span className="block text-bone-subtle">RRF k</span>
                <input
                  type="number"
                  min={1}
                  max={200}
                  step={5}
                  value={rrfK}
                  onChange={(e) => setRrfK(Number(e.target.value) || 60)}
                  className="h-7 w-full rounded-[2px] border border-rule-strong bg-void px-2 tabular-nums text-bone focus:border-cobalt-ink focus:outline-none"
                />
              </label>
              <label className="space-y-1">
                <span className="block text-bone-subtle">{t("rag.vectorWeight")}</span>
                <input
                  type="number"
                  min={0}
                  max={5}
                  step={0.1}
                  value={vectorWeight}
                  onChange={(e) => setVectorWeight(Number(e.target.value))}
                  className="h-7 w-full rounded-[2px] border border-rule-strong bg-void px-2 tabular-nums text-bone focus:border-cobalt-ink focus:outline-none"
                />
              </label>
              <label className="space-y-1">
                <span className="block text-bone-subtle">{t("rag.ftsWeight")}</span>
                <input
                  type="number"
                  min={0}
                  max={5}
                  step={0.1}
                  value={ftsWeight}
                  onChange={(e) => setFtsWeight(Number(e.target.value))}
                  className="h-7 w-full rounded-[2px] border border-rule-strong bg-void px-2 tabular-nums text-bone focus:border-cobalt-ink focus:outline-none"
                />
              </label>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2.5 text-[11px] text-bone-muted">
          <label className="inline-flex items-center gap-2">
            <Toggle
              checked={expandGraph}
              ariaLabel={t("rag.expandGraph")}
              onChange={setExpandGraph}
            />
            <span>{t("rag.expandGraph")}</span>
          </label>
          <label className="inline-flex items-center gap-2">
            <Toggle
              checked={onlyReusable}
              ariaLabel={t("filterDock.onlyReusable")}
              onChange={setOnlyReusable}
            />
            <span>{t("filterDock.onlyReusable")}</span>
          </label>
          <label className="inline-flex items-center gap-2">
            <Toggle
              checked={includeArchived}
              ariaLabel={t("rag.includeArchived")}
              onChange={setIncludeArchived}
            />
            <span>{t("rag.includeArchived")}</span>
          </label>
        </div>
      </div>

      {/* Results list */}
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {error && (
          <div className="rounded-[2px] border border-cinnabar-rule bg-cinnabar-wash p-2.5 text-xs text-cinnabar">
            {error}
          </div>
        )}

        {loading && !result ? (
          <div className="space-y-3" aria-busy="true" aria-label={t("shell.loading")}>
            <div className="grid grid-cols-2 gap-2 rounded-[2px] border border-rule bg-void p-2.5">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
            {[0, 1, 2].map((idx) => (
              <div
                key={idx}
                className="space-y-2 rounded-[2px] border border-rule bg-surface-2 p-3"
              >
                <Skeleton className="h-3 w-36" />
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3.5 w-4/5" />
              </div>
            ))}
          </div>
        ) : !result ? (
          <p className="py-8 text-center text-xs text-bone-subtle">{t("rag.emptyHint")}</p>
        ) : (
          <>
            {/* Token Cost & Savings summary */}
            <div className="grid grid-cols-2 gap-1.5 rounded-[2px] border border-rule bg-void p-2.5 font-mono text-[10px] tabular-nums">
              <div>
                <div className="text-bone-subtle">{t("rag.injectedTokens")}</div>
                <div className="mt-0.5 text-sm font-semibold text-bone">
                  {result.savings.injected_tokens.toLocaleString()}
                </div>
              </div>
              <div>
                <div className="text-bone-subtle">{t("rag.savedTokens")}</div>
                <div className="mt-0.5 text-sm font-semibold text-verdigris">
                  {result.savings.saved_tokens.toLocaleString()}
                </div>
                {result.savings.saved_tokens > 0 && (
                  <div className="mt-0.5 text-[10px] text-verdigris/85">
                    {formatSavingsEstimate(result.savings.saved_tokens, savingsSettings).combined}
                  </div>
                )}
              </div>
              <div>
                <div className="text-bone-subtle">{t("rag.avoidedTokens")}</div>
                <div className="mt-0.5 text-bone-muted">
                  {result.savings.avoided_full_tokens.toLocaleString()}
                </div>
              </div>
              <div>
                <div className="text-bone-subtle">{t("rag.latency")}</div>
                <div className="mt-0.5 text-cobalt-ink">{result.latency_ms} ms</div>
              </div>
            </div>

            {/* Core Rules injected */}
            {result.core_rules.length > 0 && (
              <div className="space-y-1.5">
                <div className="inline-flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-ochre">
                  <Pin size={11} aria-hidden />
                  {t("rag.coreRulesCount", { count: result.core_rules.length })}
                </div>
                <div className="space-y-1">
                  {result.core_rules.map((rule) => {
                    const ruleModified =
                      rule.source_doc_id !== null &&
                      docAvailability[rule.source_doc_id] === "modified";
                    return (
                      <button
                        key={rule.id}
                        type="button"
                        onClick={() => onInspectMemory(rule.id)}
                        className="w-full space-y-1 rounded-[2px] border border-ochre-rule/60 bg-ochre-wash/60 px-2.5 py-1.5 text-left text-[11px] text-bone hover:border-ochre"
                      >
                        <span className="line-clamp-2">{rule.content}</span>
                        {ruleModified && (
                          <span className="inline-flex items-center gap-1 rounded-[2px] border border-ochre-rule bg-ochre-wash px-1.5 py-0.5 font-mono text-[10px] font-medium text-ochre">
                            <AlertTriangle size={10} aria-hidden />
                            {t("inspector.fileChangedSinceSaved")}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Ranked search hits */}
            <div className="space-y-2">
              <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-bone-subtle">
                {t("rag.hitsCount", { count: result.hits.length })}
              </div>

              {result.hits.length === 0 ? (
                <p className="text-xs text-bone-subtle">{t("rag.noHits")}</p>
              ) : (() => {
                const hitsById = new Map(result.hits.map((h) => [h.memory.id, h.memory.content]));
                const graphNodesById = new Map(graph?.nodes.map((n) => [n.id, n.preview]) ?? []);
                return result.hits.map((hit, idx) => {
                  const fileModified =
                    hit.memory.source_doc_id !== null &&
                    docAvailability[hit.memory.source_doc_id] === "modified";
                  const relatedId = hit.related_to ?? null;
                  const relatedTarget = relatedId
                    ? truncateMemoryPreview(
                        hitsById.get(relatedId) ??
                          graphNodesById.get(relatedId) ??
                          relatedId.slice(0, 8),
                      )
                    : null;
                  const outrankedById = hit.outranked_by ?? null;
                  const outrankedWinnerPreview = outrankedById
                    ? (hitsById.get(outrankedById) ?? graphNodesById.get(outrankedById) ?? null)
                    : null;
                  return (
                    <div
                      key={hit.memory.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => onInspectMemory(hit.memory.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onInspectMemory(hit.memory.id);
                        }
                      }}
                      style={staggerStyle(idx, 22, 8)}
                      className={`cobalt-stagger-item w-full cursor-pointer space-y-2 rounded-[2px] border p-3 text-left transition-colors hover:border-cobalt-ink/60 hover:bg-surface-3 focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none ${
                        outrankedById
                          ? "border-ochre-rule/75 bg-surface-2/60"
                          : relatedId
                            ? "border-cobalt-rule/55 bg-surface-2/65"
                            : "border-rule bg-surface-2"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 font-mono text-[10px] tabular-nums">
                        <span className="font-semibold text-cobalt-ink">
                          #{idx + 1} · {t("rag.finalScore")} {hit.score.toFixed(4)}
                        </span>
                        <span className="text-bone-muted">
                          {t("brain.tokens", { count: hit.memory.chunk_tokens })}
                        </span>
                      </div>

                      {outrankedById && (
                        <OutdatedHitBanner
                          outrankedById={outrankedById}
                          winnerPreview={outrankedWinnerPreview}
                          onOpenWinner={onInspectMemory}
                        />
                      )}

                      {relatedTarget && (
                        <div className="inline-flex max-w-full items-center gap-1.5 rounded-[2px] border border-cobalt-rule/70 bg-cobalt-wash/70 px-2 py-0.5 font-mono text-[10px] text-cobalt-ink">
                          <Link2 size={10} className="shrink-0" aria-hidden />
                          <span className="truncate">
                            {t("rag.relatedTo", { target: relatedTarget })}
                          </span>
                        </div>
                      )}

                      {fileModified && (
                        <div className="inline-flex items-center gap-1.5 rounded-[2px] border border-ochre-rule bg-ochre-wash px-2 py-0.5 font-mono text-[10px] font-medium text-ochre">
                          <AlertTriangle size={11} className="shrink-0" aria-hidden />
                          <span>{t("inspector.fileChangedSinceSaved")}</span>
                        </div>
                      )}

                      <p className="line-clamp-3 text-xs leading-relaxed text-bone">
                        {hit.memory.content}
                      </p>

                      <div className="grid grid-cols-2 gap-x-3 gap-y-1 border-t border-rule pt-1.5 font-mono text-[10px] tabular-nums text-bone-subtle">
                        <span>
                          cos: <strong className="text-bone">{hit.similarity_score.toFixed(3)}</strong>
                        </span>
                        <span>
                          rrf: <strong className="text-bone">{hit.rrf_score.toFixed(4)}</strong>
                        </span>
                        <span>
                          vec:{" "}
                          <strong className="text-bone">
                            {hit.vector_rank !== null ? `#${hit.vector_rank}` : "—"}
                          </strong>
                        </span>
                        <span>
                          fts:{" "}
                          <strong className="text-bone">
                            {hit.fts_rank !== null ? `#${hit.fts_rank}` : "—"}
                          </strong>
                          {hit.bm25 !== null ? ` (${hit.bm25.toFixed(2)})` : ""}
                        </span>
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
