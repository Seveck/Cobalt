import { useMemo, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Activity, ChevronDown, ChevronUp, Crosshair, Search, X } from "lucide-react";
import { formatAiClientName, formatTokenCount } from "@/lib/format";
import { hexToRgba, resolveOperationPulseColor, toLuminousPulseHex } from "@/lib/pulseColors";
import {
  DEFAULT_PULSE_DURATION_MS,
  MAX_RECENT_ACTIVITIES,
  matchesVisualFilters,
  useFiltersStore,
  useMemoryStore,
  useSynapticStore,
  useThemeStore,
} from "@/stores";
import type { GraphNode, McpActivity, Uuid } from "@/types/contracts";

const MAX_PREVIEW_MATCHES = 3;

function extractMemoryHeadline(preview: string): string {
  const lines = preview.split(/\r?\n/);
  for (const rawLine of lines) {
    const cleaned = rawLine
      .trim()
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*•]\s+/, "")
      .trim();
    if (cleaned.length > 0) {
      return cleaned;
    }
  }
  return preview.trim();
}

export function SynapticHud() {
  const { t, i18n } = useTranslation();

  const latestActivity = useSynapticStore((s) => s.latestActivity);
  const recentFeed = useSynapticStore((s) => s.recentFeed);
  const activityEpoch = useSynapticStore((s) => s.activityEpoch);
  const hudVisible = useSynapticStore((s) => s.hudVisible);
  const hudExpanded = useSynapticStore((s) => s.hudExpanded);
  const dismissHud = useSynapticStore((s) => s.dismissHud);
  const toggleHudExpanded = useSynapticStore((s) => s.toggleHudExpanded);
  const pulseNodes = useSynapticStore((s) => s.pulseNodes);

  const palette = useThemeStore((s) => s.manifest.palette);
  const graph = useMemoryStore((s) => s.graph);
  const selectedNodeId = useMemoryStore((s) => s.selectedNodeId);
  const setSelectedNodeId = useMemoryStore((s) => s.setSelectedNodeId);
  const requestFocusNodes = useMemoryStore((s) => s.requestFocusNodes);

  const filters = useFiltersStore((s) => s.filters);
  const searchQuery = useFiltersStore((s) => s.searchQuery);
  const resetFilters = useFiltersStore((s) => s.resetFilters);

  const nodeById = useMemo(() => {
    const map = new Map<Uuid, GraphNode>();
    for (const node of graph?.nodes ?? []) {
      map.set(node.id, node);
    }
    return map;
  }, [graph?.nodes]);

  if (!hudVisible || !latestActivity) {
    return null;
  }

  const opColor = resolveOperationPulseColor(latestActivity.operation, palette);
  const luminousColor = toLuminousPulseHex(opColor, 0.42);
  const matchedNodes = latestActivity.matched_nodes;
  const previewMatches = matchedNodes.slice(0, MAX_PREVIEW_MATCHES);
  const remainingMatchedCount = Math.max(0, matchedNodes.length - MAX_PREVIEW_MATCHES);

  const handleSelectAndFocusNode = (memoryId: Uuid, colorHex: string) => {
    const node = nodeById.get(memoryId);
    if (node && !matchesVisualFilters(node, filters, searchQuery)) {
      resetFilters();
    }
    setSelectedNodeId(memoryId);
    requestFocusNodes([memoryId]);
    pulseNodes([memoryId], colorHex, DEFAULT_PULSE_DURATION_MS, 0.95);
  };

  const handleFocusActivityNodes = (activity: McpActivity) => {
    const ids = activity.matched_nodes.map((m) => m.memory_id);
    if (ids.length === 0) return;
    const anyFiltered = ids.some((id) => {
      const node = nodeById.get(id);
      return node ? !matchesVisualFilters(node, filters, searchQuery) : false;
    });
    if (anyFiltered) {
      resetFilters();
    }
    const color = resolveOperationPulseColor(activity.operation, palette);
    requestFocusNodes(ids);
    pulseNodes(ids, color, DEFAULT_PULSE_DURATION_MS, 0.95);
  };

  const cardGlowVars = {
    "--synaptic-glow": luminousColor,
    "--synaptic-glow-soft": hexToRgba(luminousColor, 0.48),
  } as CSSProperties;

  return (
    <div
      key={activityEpoch}
      style={cardGlowVars}
      className="cobalt-synaptic-card-enter pointer-events-auto w-[26rem] max-w-[min(92vw,28rem)] overflow-hidden rounded-[2px] border border-rule-strong bg-surface/98 shadow-[0_14px_36px_rgba(0,0,0,0.78)]"
      role="status"
      aria-live="polite"
    >
      {/* Luminous top accent strip */}
      <div
        className="h-[2.5px] w-full"
        style={{
          background: `linear-gradient(90deg, ${luminousColor}, ${hexToRgba(luminousColor, 0.25)})`,
        }}
        aria-hidden
      />

      {/* Header: operation pill + client + history toggle + close */}
      <div className="flex items-center justify-between gap-2 px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full"
            style={{
              backgroundColor: luminousColor,
              boxShadow: `0 0 10px ${luminousColor}`,
            }}
            aria-hidden
          />
          <Activity size={14} className="shrink-0 text-bone-muted" aria-hidden />
          <span
            className="shrink-0 rounded-[2px] px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-[0.06em]"
            style={{
              backgroundColor: hexToRgba(luminousColor, 0.18),
              color: luminousColor,
              border: `1px solid ${hexToRgba(luminousColor, 0.55)}`,
            }}
          >
            {t(`synaptic.ops.${latestActivity.operation}`)}
          </span>
          <span className="truncate font-mono text-[13px] font-semibold text-bone">
            {formatAiClientName(latestActivity.client_name)}
          </span>
          {latestActivity.is_replay && (
            <span className="shrink-0 rounded-[2px] border border-ochre-rule bg-ochre-wash px-1.5 py-0.5 font-mono text-[10px] uppercase text-ochre">
              {t("synaptic.replay")}
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {recentFeed.length > 1 && (
            <button
              type="button"
              onClick={toggleHudExpanded}
              aria-expanded={hudExpanded}
              aria-label={t("synaptic.toggleFeed")}
              title={t("synaptic.toggleFeed")}
              className="inline-flex items-center gap-1 rounded-[2px] border border-rule bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-bone-muted transition-colors hover:border-rule-strong hover:text-bone"
            >
              <span>{Math.min(recentFeed.length, MAX_RECENT_ACTIVITIES)}</span>
              {hudExpanded ? (
                <ChevronDown size={12} aria-hidden />
              ) : (
                <ChevronUp size={12} aria-hidden />
              )}
            </button>
          )}
          <button
            type="button"
            onClick={dismissHud}
            aria-label={t("common.close")}
            className="rounded-[2px] p-1 text-bone-subtle transition-colors hover:bg-surface-2 hover:text-bone"
          >
            <X size={13} aria-hidden />
          </button>
        </div>
      </div>

      {/* Query & first 3 matched memories */}
      <div className="border-t border-rule px-3.5 py-2.5">
        {latestActivity.query_text && (
          <div
            className="flex items-start gap-2 text-[13px] font-medium leading-snug text-bone"
            title={latestActivity.query_text}
          >
            <Search size={13} className="mt-0.5 shrink-0 text-bone-subtle" aria-hidden />
            <p className="line-clamp-2 min-w-0 flex-1">{latestActivity.query_text}</p>
          </div>
        )}

        {previewMatches.length > 0 && (
          <div className={latestActivity.query_text ? "mt-2.5" : ""}>
            <div className="mb-1 flex items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.08em] text-bone-subtle">
              <span>{t("synaptic.matchedMemoriesLabel")}</span>
              {remainingMatchedCount > 0 && (
                <button
                  type="button"
                  onClick={() => handleFocusActivityNodes(latestActivity)}
                  title={t("synaptic.focusAllHint")}
                  className="text-cobalt-ink hover:underline"
                >
                  {t("synaptic.moreMatched", { count: remainingMatchedCount })}
                </button>
              )}
            </div>

            <div className="flex flex-col gap-1">
              {previewMatches.map((matched) => {
                const node = nodeById.get(matched.memory_id);
                const headline = node
                  ? extractMemoryHeadline(node.preview)
                  : t("synaptic.loadingMemory", { id: matched.memory_id.slice(0, 8) });
                const isSelected = selectedNodeId === matched.memory_id;
                const similarityPct =
                  Number.isFinite(matched.similarity_score) && matched.similarity_score > 0
                    ? Math.round(matched.similarity_score * 100)
                    : null;

                return (
                  <button
                    key={matched.memory_id}
                    type="button"
                    onClick={() => handleSelectAndFocusNode(matched.memory_id, opColor)}
                    title={`${headline}\n${t("synaptic.focusNodeHint")}`}
                    className={`group flex w-full items-center justify-between gap-2 rounded-[2px] border px-2 py-1.5 text-left transition-colors ${
                      isSelected
                        ? "border-cobalt-rule bg-cobalt-wash/80 text-bone"
                        : "border-rule bg-void/60 text-bone-muted hover:border-rule-strong hover:bg-surface-2 hover:text-bone"
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{
                          backgroundColor: luminousColor,
                          boxShadow: `0 0 6px ${hexToRgba(luminousColor, 0.7)}`,
                        }}
                        aria-hidden
                      />
                      <span className="truncate text-xs leading-snug text-bone">
                        {headline}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] tabular-nums text-bone-subtle">
                      {similarityPct !== null && <span>{similarityPct}%</span>}
                      <Crosshair
                        size={11}
                        className="text-bone-subtle transition-colors group-hover:text-cobalt-ink"
                        aria-hidden
                      />
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Metrics row */}
        <div className="mt-2.5 flex items-center justify-between gap-2 font-mono text-[11px] tabular-nums text-bone-subtle">
          <button
            type="button"
            disabled={matchedNodes.length === 0}
            onClick={() => handleFocusActivityNodes(latestActivity)}
            title={matchedNodes.length > 0 ? t("synaptic.focusAllHint") : undefined}
            className={
              matchedNodes.length > 0
                ? "text-bone-muted transition-colors hover:text-bone"
                : "cursor-default text-bone-subtle"
            }
          >
            {t("synaptic.matchedNodes", { count: matchedNodes.length })}
          </button>
          <span className="font-medium text-verdigris">
            {t("synaptic.savedTokens", {
              count: formatTokenCount(latestActivity.saved_tokens, i18n.language),
            })}
          </span>
          <span>{latestActivity.latency_ms} ms</span>
        </div>
      </div>

      {/* Expandable 12-item history feed */}
      {hudExpanded && recentFeed.length > 1 && (
        <div className="max-h-52 divide-y divide-rule overflow-y-auto border-t border-rule bg-void/75">
          {recentFeed.slice(1, MAX_RECENT_ACTIVITIES).map((item) => {
            const c = toLuminousPulseHex(resolveOperationPulseColor(item.operation, palette), 0.4);
            const hasMatches = item.matched_nodes.length > 0;
            return (
              <button
                key={`${item.log_id}-${item.timestamp}`}
                type="button"
                disabled={!hasMatches}
                onClick={() => handleFocusActivityNodes(item)}
                title={item.query_text ?? undefined}
                className="flex w-full items-center justify-between gap-2 px-3.5 py-1.5 text-left font-mono text-[11px] transition-colors hover:bg-surface-2/80 disabled:cursor-default disabled:hover:bg-transparent"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: c }}
                    aria-hidden
                  />
                  <span className="shrink-0 font-semibold uppercase" style={{ color: c }}>
                    {t(`synaptic.ops.${item.operation}`)}
                  </span>
                  <span className="truncate text-bone-muted">
                    {item.query_text
                      ? `${formatAiClientName(item.client_name)} · ${item.query_text}`
                      : formatAiClientName(item.client_name)}
                  </span>
                </div>
                <span className="shrink-0 tabular-nums text-bone-subtle">
                  {item.matched_nodes.length} · {item.latency_ms}ms
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
