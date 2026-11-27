import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  BarChart3,
  ChevronDown,
  ChevronRight,
  Compass,
  Loader2,
  Play,
  Plug,
  RefreshCw,
  Search,
} from "lucide-react";
import { backendCall } from "@/lib/backend";
import { staggerStyle } from "@/lib/motion";
import {
  useFiltersStore,
  useMemoryStore,
  useSynapticStore,
  useTelemetryStore,
  useUiStore,
} from "@/stores";
import { AnimatedNumber, Select, Skeleton, type SelectOption } from "@/components/ui";
import {
  OPERATION_COLORS,
  TELEMETRY_OPERATIONS,
  type Page,
  type ProjectStats,
  type TelemetryLog,
  type TelemetryOperation,
  type TelemetryRange,
  type Uuid,
} from "@/types/contracts";

type RangePreset = "all" | "session" | "7d" | "30d";
const HISTORY_PAGE_SIZE = 15;

function buildRange(preset: RangePreset): TelemetryRange {
  if (preset === "session") {
    return { from: null, to: null, session_only: true };
  }
  if (preset === "7d" || preset === "30d") {
    const days = preset === "7d" ? 7 : 30;
    const from = new Date(Date.now() - days * 86_400_000).toISOString();
    return { from, to: null, session_only: false };
  }
  return { from: null, to: null, session_only: false };
}

function formatShortDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso.slice(5, 10);
  }
}

function formatTimestamp(iso: string): string {
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

export function TelemetryView() {
  const { t } = useTranslation();

  const summary = useTelemetryStore((s) => s.summary);
  const loading = useTelemetryStore((s) => s.loading);
  const loadSummary = useTelemetryStore((s) => s.loadSummary);

  const ingestActivity = useSynapticStore((s) => s.ingestActivity);
  const setSelectedNodeId = useMemoryStore((s) => s.setSelectedNodeId);
  const resetVisualFilters = useFiltersStore((s) => s.resetFilters);
  const setActiveNav = useUiStore((s) => s.setActiveNav);

  const [rangePreset, setRangePreset] = useState<RangePreset>("all");
  const [projects, setProjects] = useState<ProjectStats[]>([]);

  // Request History state (`query_telemetry`)
  const [historyPage, setHistoryPage] = useState<Page<TelemetryLog>>({ items: [], total: 0 });
  const [historyLoading, setHistoryLoading] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [clientFilter, setClientFilter] = useState<string>("__all__");
  const [projectFilter, setProjectFilter] = useState<string>("__all__");
  const [selectedOps, setSelectedOps] = useState<TelemetryOperation[]>([]);
  const [offset, setOffset] = useState(0);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());
  const [replayingId, setReplayingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadHistory = useCallback(
    async (overrideOffset?: number) => {
      setHistoryLoading(true);
      setError(null);
      try {
        const range = buildRange(rangePreset);
        const page = await backendCall("query_telemetry", {
          client_name: clientFilter === "__all__" ? null : clientFilter,
          project_id: projectFilter === "__all__" ? null : projectFilter,
          operations: selectedOps,
          from: range.from,
          to: range.to,
          text: searchText.trim() || null,
          limit: HISTORY_PAGE_SIZE,
          offset: overrideOffset ?? offset,
        });
        setHistoryPage(page);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setHistoryLoading(false);
      }
    },
    [clientFilter, offset, projectFilter, rangePreset, searchText, selectedOps],
  );

  useEffect(() => {
    void backendCall("list_projects", { include_archived: false })
      .then(setProjects)
      .catch(() => {});
  }, []);

  useEffect(() => {
    void loadSummary(buildRange(rangePreset));
  }, [loadSummary, rangePreset]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const handleRefreshAll = () => {
    void loadSummary(buildRange(rangePreset));
    void loadHistory();
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setOffset(0);
    void loadHistory(0);
  };

  const toggleOperation = (op: TelemetryOperation) => {
    setOffset(0);
    setSelectedOps((prev) =>
      prev.includes(op) ? prev.filter((item) => item !== op) : [...prev, op],
    );
  };

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleInspectNode = (memoryId: Uuid) => {
    resetVisualFilters();
    setSelectedNodeId(memoryId);
    setActiveNav("brain");
  };

  const handleReplayIn3D = async (logId: Uuid) => {
    setReplayingId(logId);
    setError(null);
    try {
      const activity = await backendCall("replay_activity", { id: logId });
      ingestActivity(activity);
      resetVisualFilters();
      setActiveNav("brain");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReplayingId(null);
    }
  };

  const timelineData = useMemo(
    () =>
      (summary?.timeline ?? []).map((b) => ({
        label: formatShortDate(b.bucket_start),
        saved: b.saved_tokens,
        injected: b.injected_tokens,
        avoided: b.avoided_full_tokens,
      })),
    [summary?.timeline],
  );

  const breakdownData = useMemo(
    () => [
      {
        name: t("telemetry.savedFromReads"),
        tokens: summary?.saved_from_reads ?? 0,
        color: "#0047AB",
      },
      {
        name: t("telemetry.savedFromReuse"),
        tokens: summary?.saved_from_reuse ?? 0,
        color: "#9B87F5",
      },
    ],
    [summary?.saved_from_reads, summary?.saved_from_reuse, t],
  );

  const clientRankingData = useMemo(
    () =>
      [...(summary?.by_client ?? [])]
        .sort((a, b) => b.saved_tokens - a.saved_tokens)
        .map((c) => ({
          name: c.client_name,
          saved: c.saved_tokens,
          reads: c.reads,
          reuses: c.reuses,
        })),
    [summary?.by_client],
  );

  const clientFilterOptions = useMemo<SelectOption<string>[]>(() => {
    const names = new Set<string>(summary?.by_client.map((c) => c.client_name) ?? []);
    for (const log of historyPage.items) names.add(log.client_name);
    return [
      { value: "__all__", label: t("telemetry.allClients") },
      ...[...names].sort().map((name) => ({ value: name, label: name })),
    ];
  }, [historyPage.items, summary?.by_client, t]);

  const projectFilterOptions = useMemo<SelectOption<string>[]>(
    () => [
      { value: "__all__", label: t("telemetry.allProjects") },
      ...projects.map((p) => ({ value: p.project.id, label: p.project.name })),
    ],
    [projects, t],
  );

  const totalPages = Math.max(1, Math.ceil(historyPage.total / HISTORY_PAGE_SIZE));
  const currentPage = Math.floor(offset / HISTORY_PAGE_SIZE) + 1;

  const hasAvoidedData = Boolean(summary && summary.total_avoided_tokens > 0);
  const compressionPct = Math.round((summary?.compression_ratio ?? 0) * 100);
  const injectedPct =
    summary && summary.total_avoided_tokens > 0
      ? Math.min(100, Math.round((summary.total_injected_tokens / summary.total_avoided_tokens) * 100))
      : 0;
  const hasReadsOrReuse = Boolean(
    summary && (summary.saved_from_reads > 0 || summary.saved_from_reuse > 0),
  );
  const hasSummaryActivity = Boolean(
    summary &&
      (summary.total_saved_tokens > 0 ||
        summary.total_injected_tokens > 0 ||
        summary.total_avoided_tokens > 0 ||
        summary.by_client.length > 0 ||
        summary.timeline.length > 0 ||
        summary.top_nodes.length > 0),
  );
  const hasHistoryFilters =
    Boolean(searchText.trim()) ||
    clientFilter !== "__all__" ||
    projectFilter !== "__all__" ||
    selectedOps.length > 0;
  const isCompletelyEmpty =
    !loading &&
    !historyLoading &&
    rangePreset === "all" &&
    !hasHistoryFilters &&
    !hasSummaryActivity &&
    historyPage.total === 0;

  return (
    <div className="h-full overflow-y-auto bg-void p-6 lg:p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        {/* Header */}
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-rule pb-5">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-2xl font-semibold tracking-tight text-bone sm:text-3xl">
                {t("telemetry.title")}
              </h1>
            </div>
            <p className="mt-1.5 text-sm text-bone-muted">{t("telemetry.subtitle")}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-[2px] border border-rule bg-surface p-0.5 font-mono text-[11px]">
              {(["all", "session", "7d", "30d"] as const).map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => {
                    setRangePreset(preset);
                    setOffset(0);
                  }}
                  className={`rounded-[1px] px-2.5 py-1 transition-colors ${
                    rangePreset === preset
                      ? "bg-cobalt-wash font-semibold text-cobalt-ink"
                      : "text-bone-muted hover:text-bone"
                  }`}
                >
                  {t(`telemetry.range.${preset}`)}
                </button>
              ))}
            </div>

            <button
              type="button"
              disabled={loading || historyLoading}
              onClick={handleRefreshAll}
              className="inline-flex items-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface px-3 py-1.5 font-mono text-xs text-bone-muted hover:text-bone disabled:opacity-45"
            >
              <RefreshCw
                size={12}
                className={loading || historyLoading ? "animate-spin" : ""}
                aria-hidden
              />
              {t("common.refresh")}
            </button>
          </div>
        </header>

        {error && (
          <div className="rounded-[2px] border border-cinnabar-rule bg-cinnabar-wash px-4 py-2.5 text-xs text-cinnabar">
            {error}
          </div>
        )}

        {/* Brand-new install empty state (no telemetry recorded yet) */}
        {isCompletelyEmpty ? (
          <section className="rounded-[2px] border border-rule bg-surface px-6 py-14 text-center">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-[2px] border border-cobalt-rule bg-cobalt-wash text-cobalt-ink">
              <BarChart3 size={20} aria-hidden />
            </div>
            <h2 className="mt-4 text-xl font-semibold tracking-tight text-bone">
              {t("telemetry.emptyTitle")}
            </h2>
            <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-bone-muted">
              {t("telemetry.emptyDesc")}
            </p>
            <div className="mt-5 flex items-center justify-center">
              <button
                type="button"
                onClick={() => setActiveNav("connectors")}
                className="inline-flex items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-4 py-2 font-mono text-xs font-semibold text-bone transition-colors hover:bg-cobalt-bright"
              >
                <Plug size={13} aria-hidden />
                <span>{t("telemetry.emptyConnectAction")}</span>
              </button>
            </div>
          </section>
        ) : (
          <>
            {/* KPI strip & charts skeleton while initial summary loads */}
            {loading && !summary && (
              <div className="space-y-6" aria-busy="true" aria-label={t("shell.loading")}>
                <section className="grid grid-cols-1 divide-y divide-rule rounded-[2px] border border-rule bg-surface sm:grid-cols-2 lg:grid-cols-4 lg:divide-x lg:divide-y-0">
                  {[0, 1, 2, 3].map((idx) => (
                    <div key={idx} className="space-y-3 p-5">
                      <Skeleton className="h-3 w-24" />
                      <Skeleton className="h-7 w-28" />
                      <Skeleton className="h-3 w-36" />
                    </div>
                  ))}
                </section>
                <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                  <div className="space-y-4 rounded-[2px] border border-rule bg-surface p-5 lg:col-span-2">
                    <Skeleton className="h-3 w-36" />
                    <Skeleton className="h-60 w-full" />
                  </div>
                  <div className="space-y-4 rounded-[2px] border border-rule bg-surface p-5">
                    <Skeleton className="h-3 w-32" />
                    <Skeleton className="h-60 w-full" />
                  </div>
                </section>
              </div>
            )}

            {/* KPI strip */}
            {summary && (
              <>
                <section className="grid grid-cols-1 divide-y divide-rule rounded-[2px] border border-rule bg-surface sm:grid-cols-2 lg:grid-cols-4 lg:divide-x lg:divide-y-0">
                  <div className="cobalt-stagger-item p-5" style={staggerStyle(0, 26)}>
                    <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-bone-subtle">
                      {t("telemetry.totalSaved")}
                    </div>
                    <div className="mt-2 font-mono text-2xl font-semibold tabular-nums text-verdigris">
                      <AnimatedNumber value={summary.total_saved_tokens} />
                    </div>
                    <div className="mt-1 font-mono text-[10px] text-bone-subtle">
                      {t("telemetry.avoidedVsInjected", {
                        avoided: summary.total_avoided_tokens.toLocaleString(),
                        injected: summary.total_injected_tokens.toLocaleString(),
                      })}
                    </div>
                  </div>

                  <div className="cobalt-stagger-item p-5" style={staggerStyle(1, 26)}>
                    <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-bone-subtle">
                      {t("telemetry.sessionSaved")}
                    </div>
                    <div className="mt-2 font-mono text-2xl font-semibold tabular-nums text-cobalt-ink">
                      <AnimatedNumber value={summary.session_saved_tokens} />
                    </div>
                    <div className="mt-1 text-[11px] text-bone-subtle">
                      {t("telemetry.sessionHint")}
                    </div>
                  </div>

                  <div className="cobalt-stagger-item p-5" style={staggerStyle(2, 26)}>
                    <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-bone-subtle">
                      {t("telemetry.compressionRatio")}
                    </div>
                    <div className="mt-2 font-mono text-2xl font-semibold tabular-nums text-ochre">
                      {hasAvoidedData ? (
                        <AnimatedNumber value={compressionPct} format={(n) => `${n}%`} />
                      ) : (
                        "—"
                      )}
                    </div>
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-[1px] bg-void">
                      <div
                        className="h-full w-full origin-left bg-ochre transition-transform duration-300 ease-out"
                        style={{
                          transform: `scaleX(${
                            hasAvoidedData
                              ? Math.max(0, Math.min(100, compressionPct)) / 100
                              : 0
                          })`,
                        }}
                      />
                    </div>
                    <div className="mt-1 font-mono text-[10px] text-bone-subtle">
                      {hasAvoidedData
                        ? t("telemetry.injectedShare", { pct: injectedPct })
                        : t("telemetry.noChartData")}
                    </div>
                  </div>

                  <div className="cobalt-stagger-item p-5" style={staggerStyle(3, 26)}>
                    <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-bone-subtle">
                      {t("telemetry.readsVsReuseTitle")}
                    </div>
                    <div className="mt-2 flex items-baseline gap-2 font-mono text-lg font-semibold tabular-nums">
                      <span className="text-cobalt-ink">
                        <AnimatedNumber value={summary.saved_from_reads} />
                      </span>
                      <span className="text-xs text-bone-subtle">/</span>
                      <span className="text-pulse-reuse">
                        <AnimatedNumber value={summary.saved_from_reuse} />
                      </span>
                    </div>
                    <div className="mt-1 font-mono text-[10px] text-bone-subtle">
                      {t("telemetry.readsVsReuseLegend")}
                    </div>
                  </div>
                </section>

                {/* Charts Row 1: Timeline + Reads vs Reuse */}
                <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                  <div className="rounded-[2px] border border-rule bg-surface p-5 lg:col-span-2">
                    <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-bone-subtle">
                      {t("telemetry.savedOverTime")}
                    </h2>
                    <div className="mt-4 h-60 w-full">
                      {timelineData.length === 0 ? (
                        <div className="flex h-full items-center justify-center text-xs text-bone-subtle">
                          {t("telemetry.noChartData")}
                        </div>
                      ) : (
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={timelineData}>
                            <defs>
                              <linearGradient id="cobaltSavedGrad" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#34B37E" stopOpacity={0.38} />
                                <stop offset="95%" stopColor="#34B37E" stopOpacity={0.02} />
                              </linearGradient>
                              <linearGradient id="cobaltInjectedGrad" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#79A8FF" stopOpacity={0.28} />
                                <stop offset="95%" stopColor="#79A8FF" stopOpacity={0.02} />
                              </linearGradient>
                            </defs>
                            <CartesianGrid stroke="var(--color-rule, #23262F)" strokeDasharray="3 3" />
                            <XAxis
                              dataKey="label"
                              stroke="var(--color-bone-subtle, #6F6C65)"
                              tick={{ fill: "var(--color-bone-muted, #A4A096)", fontSize: 11 }}
                            />
                            <YAxis
                              stroke="var(--color-bone-subtle, #6F6C65)"
                              tick={{ fill: "var(--color-bone-muted, #A4A096)", fontSize: 11 }}
                              width={56}
                            />
                            <Tooltip
                              contentStyle={{
                                backgroundColor: "var(--color-surface, #111317)",
                                borderColor: "var(--color-rule-strong, #363C4A)",
                                borderRadius: "var(--cobalt-radius, 2px)",
                                fontSize: 12,
                                color: "var(--color-bone, #ECE9E1)",
                              }}
                            />
                            <Area
                              type="monotone"
                              dataKey="saved"
                              name={t("telemetry.chartSaved")}
                              stroke="#34B37E"
                              strokeWidth={2}
                              fill="url(#cobaltSavedGrad)"
                            />
                            <Area
                              type="monotone"
                              dataKey="injected"
                              name={t("telemetry.chartInjected")}
                              stroke="#79A8FF"
                              strokeWidth={1.5}
                              fill="url(#cobaltInjectedGrad)"
                            />
                          </AreaChart>
                        </ResponsiveContainer>
                      )}
                    </div>
                  </div>

                  <div className="rounded-[2px] border border-rule bg-surface p-5">
                    <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-bone-subtle">
                      {t("telemetry.readsVsReuseTitle")}
                    </h2>
                    <div className="mt-4 h-60 w-full">
                      {!hasReadsOrReuse ? (
                        <div className="flex h-full items-center justify-center text-xs text-bone-subtle">
                          {t("telemetry.noChartData")}
                        </div>
                      ) : (
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={breakdownData}>
                            <CartesianGrid stroke="var(--color-rule, #23262F)" strokeDasharray="3 3" />
                            <XAxis
                              dataKey="name"
                              stroke="var(--color-bone-subtle, #6F6C65)"
                              tick={{ fill: "var(--color-bone-muted, #A4A096)", fontSize: 11 }}
                            />
                            <YAxis
                              stroke="var(--color-bone-subtle, #6F6C65)"
                              tick={{ fill: "var(--color-bone-muted, #A4A096)", fontSize: 11 }}
                              width={54}
                            />
                            <Tooltip
                              contentStyle={{
                                backgroundColor: "var(--color-surface, #111317)",
                                borderColor: "var(--color-rule-strong, #363C4A)",
                                borderRadius: "var(--cobalt-radius, 2px)",
                                fontSize: 12,
                                color: "var(--color-bone, #ECE9E1)",
                              }}
                            />
                            <Bar dataKey="tokens" radius={[2, 2, 0, 0]}>
                              {breakdownData.map((entry) => (
                                <Cell key={entry.name} fill={entry.color} />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      )}
                    </div>
                  </div>
                </section>

            {/* Charts Row 2: Client Ranking + Top Nodes */}
            <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {/* Per-client ranking */}
              <div className="rounded-[2px] border border-rule bg-surface p-5">
                <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-bone-subtle">
                  {t("telemetry.byClient")}
                </h2>

                {clientRankingData.length === 0 ? (
                  <p className="py-10 text-center text-xs text-bone-subtle">
                    {t("telemetry.noClientData")}
                  </p>
                ) : (
                  <div className="mt-4 space-y-4">
                    <div className="h-44 w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={clientRankingData} layout="vertical">
                          <CartesianGrid stroke="var(--color-rule, #23262F)" strokeDasharray="3 3" />
                          <XAxis
                            type="number"
                            stroke="var(--color-bone-subtle, #6F6C65)"
                            tick={{ fill: "var(--color-bone-muted, #A4A096)", fontSize: 10 }}
                          />
                          <YAxis
                            type="category"
                            dataKey="name"
                            stroke="var(--color-bone-subtle, #6F6C65)"
                            tick={{ fill: "var(--color-bone, #ECE9E1)", fontSize: 11 }}
                            width={96}
                          />
                          <Tooltip
                            contentStyle={{
                              backgroundColor: "var(--color-surface, #111317)",
                              borderColor: "var(--color-rule-strong, #363C4A)",
                              borderRadius: "var(--cobalt-radius, 2px)",
                              fontSize: 12,
                              color: "var(--color-bone, #ECE9E1)",
                            }}
                          />
                          <Bar
                            dataKey="saved"
                            name={t("telemetry.chartSaved")}
                            fill="var(--color-cobalt, #0047AB)"
                            radius={[0, 2, 2, 0]}
                          />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>

                    <div className="divide-y divide-rule border-t border-rule text-xs">
                      {summary.by_client.map((client) => (
                        <div
                          key={client.client_name}
                          className="flex flex-wrap items-center justify-between gap-2 py-2 font-mono text-[11px]"
                        >
                          <span className="font-medium text-bone">{client.client_name}</span>
                          <div className="flex flex-wrap items-center gap-3 tabular-nums text-bone-subtle">
                            <span>R:{client.reads}</span>
                            <span>W:{client.writes}</span>
                            <span className="text-pulse-reuse">↺:{client.reuses}</span>
                            {client.blocked > 0 && (
                              <span className="text-cinnabar">✕:{client.blocked}</span>
                            )}
                            <span className="font-semibold text-verdigris">
                              {client.saved_tokens.toLocaleString()}t
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Top nodes */}
              <div className="rounded-[2px] border border-rule bg-surface p-5">
                <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-bone-subtle">
                  {t("telemetry.topNodes")}
                </h2>

                {summary.top_nodes.length === 0 ? (
                  <p className="py-10 text-center text-xs text-bone-subtle">
                    {t("telemetry.noTopNodes")}
                  </p>
                ) : (
                  <div className="mt-4 divide-y divide-rule border-t border-rule">
                    {summary.top_nodes.map((node, idx) => (
                      <div
                        key={node.memory_id}
                        className="cobalt-stagger-item flex items-start justify-between gap-3 py-2.5"
                        style={staggerStyle(idx, 20, 8)}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[10px] text-bone-subtle">
                              #{idx + 1}
                            </span>
                            <p className="line-clamp-2 text-xs text-bone">{node.preview}</p>
                          </div>
                          <div className="mt-1 flex items-center gap-3 font-mono text-[10px] tabular-nums text-bone-subtle">
                            <span>{t("brain.hits", { count: node.hit_count })}</span>
                            <span className="text-pulse-reuse">
                              {t("library.reuses", { count: node.reuse_count })}
                            </span>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleInspectNode(node.memory_id)}
                          className="inline-flex shrink-0 items-center gap-1 rounded-[2px] border border-cobalt-rule bg-cobalt-wash px-2 py-1 font-mono text-[10px] text-cobalt-ink hover:bg-cobalt hover:text-bone"
                        >
                          <Compass size={10} aria-hidden />
                          {t("library.locate3D")}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </>
        )}

        {/* Request History (`query_telemetry`) with expandable items & Replay in 3D */}
        <section className="space-y-4 rounded-[2px] border border-rule bg-surface p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule pb-4">
            <div>
              <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-bone">
                {t("telemetry.historyTitle")}
              </h2>
              <p className="mt-0.5 text-xs text-bone-muted">{t("telemetry.historySubtitle")}</p>
            </div>
            <span className="font-mono text-[11px] tabular-nums text-bone-subtle">
              {t("telemetry.totalRequests", { count: historyPage.total })}
            </span>
          </div>

          {/* Search & filter controls */}
          <div className="space-y-3">
            <form onSubmit={handleSearchSubmit} className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[200px] flex-1">
                <Search
                  size={13}
                  className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-bone-subtle"
                  aria-hidden
                />
                <input
                  type="text"
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  placeholder={t("telemetry.searchHistoryPlaceholder")}
                  className="h-8 w-full rounded-[2px] border border-rule-strong bg-void pr-3 pl-8 text-xs text-bone placeholder:text-bone-subtle focus:border-cobalt-ink focus:outline-none"
                />
              </div>

              <Select<string>
                value={clientFilter}
                options={clientFilterOptions}
                size="sm"
                className="w-40"
                onChange={(v) => {
                  setClientFilter(v);
                  setOffset(0);
                }}
              />

              <Select<string>
                value={projectFilter}
                options={projectFilterOptions}
                size="sm"
                className="w-44"
                onChange={(v) => {
                  setProjectFilter(v);
                  setOffset(0);
                }}
              />

              <button
                type="submit"
                disabled={historyLoading}
                className="h-8 rounded-[2px] border border-cobalt-rule bg-cobalt px-3.5 font-mono text-xs font-semibold text-bone hover:bg-cobalt-bright disabled:opacity-45"
              >
                {t("rag.run")}
              </button>
            </form>

            {/* Operation filter chips */}
            <div className="flex flex-wrap items-center gap-1.5">
              {TELEMETRY_OPERATIONS.map((op) => {
                const active = selectedOps.includes(op);
                const color = OPERATION_COLORS[op];
                return (
                  <button
                    key={op}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleOperation(op)}
                    className={`inline-flex items-center gap-1.5 rounded-[2px] border px-2 py-0.5 font-mono text-[10px] uppercase transition-colors ${
                      active
                        ? "border-cobalt-rule bg-cobalt-wash text-bone"
                        : "border-rule bg-void text-bone-muted hover:border-rule-strong hover:text-bone"
                    }`}
                  >
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                    {t(`synaptic.ops.${op}`)}
                  </button>
                );
              })}
            </div>
          </div>

          {/* History list */}
          {historyLoading && historyPage.items.length === 0 ? (
            <div
              className="divide-y divide-rule rounded-[2px] border border-rule bg-void"
              aria-busy="true"
              aria-label={t("telemetry.loadingHistory")}
            >
              {[0, 1, 2, 3, 4].map((idx) => (
                <div key={idx} className="flex items-center justify-between gap-3 p-3">
                  <div className="flex min-w-0 flex-1 items-center gap-2.5">
                    <Skeleton className="h-4 w-14 shrink-0" />
                    <Skeleton className="h-4 w-24 shrink-0" />
                    <Skeleton className="h-3.5 w-1/2" />
                  </div>
                  <Skeleton className="h-4 w-20 shrink-0" />
                </div>
              ))}
            </div>
          ) : historyPage.items.length === 0 ? (
            <p className="py-8 text-center text-xs text-bone-subtle">
              {hasHistoryFilters
                ? t("telemetry.emptyHistory")
                : t("telemetry.emptyHistoryBrandNew")}
            </p>
          ) : (
            <div className="divide-y divide-rule rounded-[2px] border border-rule bg-void">
              {historyPage.items.map((log, idx) => {
                const expanded = expandedIds.has(log.id);
                const opColor = OPERATION_COLORS[log.operation];
                const replaying = replayingId === log.id;
                return (
                  <div
                    key={log.id}
                    className="cobalt-stagger-item p-3"
                    style={staggerStyle(idx, 20, 10)}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => toggleExpanded(log.id)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        {expanded ? (
                          <ChevronDown size={13} className="shrink-0 text-bone-subtle" aria-hidden />
                        ) : (
                          <ChevronRight size={13} className="shrink-0 text-bone-subtle" aria-hidden />
                        )}
                        <span
                          className="shrink-0 rounded-[2px] px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase"
                          style={{
                            backgroundColor: `${opColor}24`,
                            color: opColor,
                            border: `1px solid ${opColor}55`,
                          }}
                        >
                          {t(`synaptic.ops.${log.operation}`)}
                        </span>
                        <span className="shrink-0 font-mono text-xs font-medium text-bone">
                          {log.client_name}
                        </span>
                        <span className="truncate text-xs text-bone-muted">
                          {log.query_text ?? t("telemetry.noQueryText")}
                        </span>
                      </button>

                      <div className="flex shrink-0 items-center gap-3 font-mono text-[10px] tabular-nums">
                        <span className="text-bone-subtle">
                          {t("telemetry.itemsCount", { count: log.returned_items.length })}
                        </span>
                        <span className="text-verdigris">+{log.saved_tokens}t</span>
                        <span className="text-bone-subtle">{log.latency_ms}ms</span>
                        <span className="hidden text-bone-subtle sm:inline">
                          {formatTimestamp(log.timestamp)}
                        </span>
                        <button
                          type="button"
                          disabled={replaying}
                          onClick={() => void handleReplayIn3D(log.id)}
                          className="inline-flex items-center gap-1 rounded-[2px] border border-cobalt-rule bg-cobalt-wash px-2 py-1 font-mono text-[10px] font-semibold text-cobalt-ink hover:bg-cobalt hover:text-bone disabled:opacity-45"
                        >
                          {replaying ? (
                            <Loader2 size={10} className="animate-spin" aria-hidden />
                          ) : (
                            <Play size={10} aria-hidden />
                          )}
                          {t("telemetry.replayIn3D")}
                        </button>
                      </div>
                    </div>

                    {/* Expandable returned items */}
                    {expanded && (
                      <div className="mt-3 space-y-2 border-t border-rule pt-2.5 pl-5">
                        <div className="flex flex-wrap gap-4 font-mono text-[10px] text-bone-subtle">
                          <span>
                            {t("rag.injectedTokens")}: {log.injected_tokens}
                          </span>
                          <span>
                            {t("rag.avoidedTokens")}: {log.avoided_full_tokens}
                          </span>
                          <span>
                            {t("rag.savedTokens")}: {log.saved_tokens}
                          </span>
                        </div>

                        {log.returned_items.length === 0 ? (
                          <p className="text-[11px] text-bone-subtle">
                            {t("telemetry.noReturnedItems")}
                          </p>
                        ) : (
                          <div className="space-y-1.5">
                            {log.returned_items.map((item) => (
                              <div
                                key={`${log.id}-${item.memory_id}`}
                                className="flex items-start justify-between gap-3 rounded-[2px] border border-rule bg-surface p-2.5"
                              >
                                <div className="min-w-0 flex-1">
                                  <p className="text-xs leading-relaxed text-bone">
                                    {item.content_snapshot ?? t("telemetry.purgedSnapshot")}
                                  </p>
                                  <div className="mt-1 flex flex-wrap items-center gap-3 font-mono text-[10px] tabular-nums text-bone-subtle">
                                    <span>
                                      {t("telemetry.similarityLabel", {
                                        value: Math.round(item.similarity_score * 100),
                                      })}
                                    </span>
                                    <span>{t("brain.tokens", { count: item.chunk_tokens })}</span>
                                    <span className="truncate opacity-70">{item.memory_id}</span>
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => handleInspectNode(item.memory_id)}
                                  className="inline-flex shrink-0 items-center gap-1 rounded-[2px] border border-rule-strong bg-surface-2 px-2 py-1 font-mono text-[10px] text-bone-muted hover:border-cobalt-ink/60 hover:text-bone"
                                >
                                  <Compass size={10} aria-hidden />
                                  {t("library.locate3D")}
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Pagination */}
          {historyPage.total > HISTORY_PAGE_SIZE && (
            <div className="flex items-center justify-between pt-2 font-mono text-xs text-bone-muted">
              <span>
                {t("telemetry.pageOf", { page: currentPage, total: totalPages })}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={offset === 0 || historyLoading}
                  onClick={() => setOffset(Math.max(0, offset - HISTORY_PAGE_SIZE))}
                  className="rounded-[2px] border border-rule-strong bg-surface-2 px-3 py-1 hover:text-bone disabled:opacity-45"
                >
                  {t("telemetry.prevPage")}
                </button>
                <button
                  type="button"
                  disabled={offset + HISTORY_PAGE_SIZE >= historyPage.total || historyLoading}
                  onClick={() => setOffset(offset + HISTORY_PAGE_SIZE)}
                  className="rounded-[2px] border border-rule-strong bg-surface-2 px-3 py-1 hover:text-bone disabled:opacity-45"
                >
                  {t("telemetry.nextPage")}
                </button>
              </div>
            </div>
          )}
        </section>
          </>
        )}
      </div>
    </div>
  );
}
