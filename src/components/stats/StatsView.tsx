import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BarChart3, Clock, Info, Plug, RefreshCw } from "lucide-react";
import { backendCall } from "@/lib/backend";
import { formatCompactNumber, formatTokenCount } from "@/lib/format";
import { toDisplayError, type DisplayError } from "@/lib/friendlyError";
import { staggerStyle } from "@/lib/motion";
import { formatSavingsEstimate } from "@/lib/savings";
import { useSettingsStore, useUiStore } from "@/stores";
import { AnimatedNumber, ErrorAlert, Skeleton } from "@/components/ui";
import type { SavingsSettings, UsageStats, UsageTotals } from "@/types/contracts";
import { FunFactsGrid } from "./FunFactsGrid";
import { isUnsupportedError, parseCalendarDate } from "./statsHelpers";
import { YearlyHeatmap } from "./YearlyHeatmap";

interface SummaryCardProps {
  label: string;
  totals: UsageTotals;
  savingsSettings: SavingsSettings;
  accentClassName: string;
  language: string;
  staggerIndex: number;
}

function SummaryCard({
  label,
  totals,
  savingsSettings,
  accentClassName,
  language,
  staggerIndex,
}: SummaryCardProps) {
  const { t } = useTranslation();
  const estimate = formatSavingsEstimate(totals.saved_tokens, savingsSettings);

  return (
    <div
      className="cobalt-stagger-item rounded-[2px] border border-rule bg-surface p-5"
      style={staggerStyle(staggerIndex, 28)}
    >
      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-bone-subtle">
        {label}
      </div>
      <div className={`mt-2 font-mono text-3xl font-semibold tabular-nums ${accentClassName}`}>
        <AnimatedNumber
          value={totals.requests}
          format={(n) => formatTokenCount(n, language)}
        />
      </div>
      <div className="mt-1 text-xs text-bone-muted">
        {t("stats.cards.requestsCaption", { count: totals.requests })}
      </div>
      <div className="mt-3 space-y-1 border-t border-rule pt-2.5 font-mono text-[10px] tabular-nums text-bone-subtle">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span>
            {t("stats.cards.tokensSaved", {
              tokens: formatCompactNumber(totals.saved_tokens),
            })}
          </span>
          <span aria-hidden>·</span>
          <span>
            {t("stats.cards.memoriesCreated", { count: totals.memories_created })}
          </span>
        </div>
        {totals.saved_tokens > 0 && (
          <div className="text-verdigris/90">{estimate.combined}</div>
        )}
      </div>
    </div>
  );
}

export function StatsView() {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language ?? "en";
  const setActiveNav = useUiStore((s) => s.setActiveNav);
  const openSettingsSection = useUiStore((s) => s.openSettingsSection);
  const savingsSettings = useSettingsStore((s) => s.settings.savings);

  const currentYear = useMemo(() => new Date().getFullYear(), []);
  const [selectedYear, setSelectedYear] = useState<number>(currentYear);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [unsupported, setUnsupported] = useState<boolean>(false);
  const [error, setError] = useState<DisplayError | null>(null);
  const requestIdRef = useRef<number>(0);

  const loadStats = useCallback(async (year: number) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setError(null);
    setUnsupported(false);
    try {
      const utcOffsetMinutes = -new Date().getTimezoneOffset();
      const result = await backendCall("get_usage_stats", {
        year,
        utc_offset_minutes: utcOffsetMinutes,
      });
      if (requestIdRef.current !== requestId) return;
      setStats(result);
    } catch (err: unknown) {
      if (requestIdRef.current !== requestId) return;
      if (isUnsupportedError(err)) {
        setUnsupported(true);
        setStats(null);
      } else {
        setError(toDisplayError(err, t, "get_usage_stats"));
      }
    } finally {
      if (requestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [t]);

  useEffect(() => {
    void loadStats(selectedYear);
  }, [loadStats, selectedYear]);

  const minYear = useMemo(() => {
    const firstParts = parseCalendarDate(stats?.first_activity);
    if (firstParts) {
      return Math.min(firstParts.year, currentYear - 5);
    }
    return currentYear - 5;
  }, [currentYear, stats?.first_activity]);

  const yearCardLabel =
    selectedYear === currentYear
      ? t("stats.cards.thisYear")
      : t("stats.cards.selectedYear", { year: selectedYear });

  const isBrandNew =
    stats !== null && stats.all_time.requests === 0 && stats.days.length === 0;

  return (
    <div className="h-full overflow-y-auto bg-void p-6 lg:p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        {/* Page Header */}
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-rule pb-5">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-bone sm:text-3xl">
              {t("stats.title")}
            </h1>
            <p className="mt-1.5 text-sm text-bone-muted">{t("stats.subtitle")}</p>
          </div>

          <button
            type="button"
            disabled={loading}
            onClick={() => void loadStats(selectedYear)}
            className="inline-flex items-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface px-3 py-1.5 font-mono text-xs text-bone-muted transition-colors hover:text-bone focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none disabled:opacity-45"
          >
            <RefreshCw
              size={12}
              className={loading ? "animate-spin" : ""}
              aria-hidden
            />
            {t("common.refresh")}
          </button>
        </header>

        {/* Backend not ready yet ("Unsupported") -> clean Coming Soon state, never fake numbers */}
        {unsupported ? (
          <section className="rounded-[2px] border border-rule bg-surface px-6 py-14 text-center">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-[2px] border border-cobalt-rule bg-cobalt-wash text-cobalt-ink">
              <Clock size={20} aria-hidden />
            </div>
            <h2 className="mt-4 text-xl font-semibold tracking-tight text-bone">
              {t("stats.comingSoonTitle")}
            </h2>
            <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-bone-muted">
              {t("stats.comingSoonDesc")}
            </p>
            <div className="mt-5 flex items-center justify-center">
              <button
                type="button"
                disabled={loading}
                onClick={() => void loadStats(selectedYear)}
                className="inline-flex items-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface-2 px-4 py-2 font-mono text-xs font-medium text-bone transition-colors hover:border-cobalt-rule hover:bg-cobalt-wash hover:text-cobalt-ink disabled:opacity-45"
              >
                <RefreshCw size={12} aria-hidden />
                <span>{t("stats.retryAction")}</span>
              </button>
            </div>
          </section>
        ) : error && !stats ? (
          <section className="space-y-3">
            <ErrorAlert
              error={error}
              actions={
                <button
                  type="button"
                  onClick={() => void loadStats(selectedYear)}
                  className="inline-flex items-center gap-1.5 rounded-[2px] border border-cinnabar-rule bg-void px-3 py-1 font-mono text-xs text-bone hover:bg-surface"
                >
                  <RefreshCw size={12} aria-hidden />
                  <span>{t("stats.retryAction")}</span>
                </button>
              }
            />
          </section>
        ) : loading && !stats ? (
          <div className="space-y-6" aria-busy="true" aria-label={t("stats.loading")}>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {[0, 1, 2].map((idx) => (
                <div
                  key={idx}
                  className="space-y-3 rounded-[2px] border border-rule bg-surface p-5"
                >
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-8 w-24" />
                  <Skeleton className="h-3 w-32" />
                  <div className="border-t border-rule pt-2.5">
                    <Skeleton className="h-3 w-40" />
                  </div>
                </div>
              ))}
            </div>
            <div className="space-y-3 rounded-[2px] border border-rule bg-surface p-5">
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-2">
                  <Skeleton className="h-3 w-36" />
                  <Skeleton className="h-3 w-52" />
                </div>
                <Skeleton className="h-7 w-28" />
              </div>
              <Skeleton className="h-28 w-full" />
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {[0, 1, 2, 3, 4, 5].map((idx) => (
                <div
                  key={idx}
                  className="space-y-3 rounded-[2px] border border-rule bg-surface p-5"
                >
                  <Skeleton className="h-3 w-28" />
                  <Skeleton className="h-7 w-32" />
                  <Skeleton className="h-3 w-24" />
                  <div className="border-t border-rule pt-3">
                    <Skeleton className="h-3 w-44" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : stats ? (
          <>
            <ErrorAlert error={error} />

            {/* Top 3 summary cards: Today / This week / This year */}
            <section
              aria-label={t("stats.cards.sectionAria")}
              className="grid grid-cols-1 gap-4 sm:grid-cols-3"
            >
              <SummaryCard
                label={t("stats.cards.today")}
                totals={stats.today}
                savingsSettings={savingsSettings}
                accentClassName="text-cobalt-ink"
                language={language}
                staggerIndex={0}
              />
              <SummaryCard
                label={t("stats.cards.thisWeek")}
                totals={stats.this_week}
                savingsSettings={savingsSettings}
                accentClassName="text-bone"
                language={language}
                staggerIndex={1}
              />
              <SummaryCard
                label={yearCardLabel}
                totals={stats.this_year}
                savingsSettings={savingsSettings}
                accentClassName="text-bone"
                language={language}
                staggerIndex={2}
              />
            </section>

            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-bone-subtle">
              <p className="flex items-center gap-1.5">
                <Info size={12} className="shrink-0 text-bone-subtle" aria-hidden />
                <span>{t("telemetry.conservativeSavingsNote")}</span>
              </p>
              <button
                type="button"
                onClick={() => openSettingsSection("savings")}
                className="shrink-0 font-mono text-[10px] text-cobalt-ink hover:underline"
              >
                {t("telemetry.adjustPricingLink")}
              </button>
            </div>

            {/* Helpful prompt on brand-new installs with zero recorded activity */}
            {isBrandNew && (
              <section className="flex flex-wrap items-center justify-between gap-4 rounded-[2px] border border-cobalt-rule/60 bg-cobalt-wash/50 px-5 py-4">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[2px] border border-cobalt-rule bg-cobalt-wash text-cobalt-ink">
                    <BarChart3 size={15} aria-hidden />
                  </div>
                  <div>
                    <h2 className="text-sm font-medium text-bone">
                      {t("stats.emptyTitle")}
                    </h2>
                    <p className="mt-0.5 text-xs text-bone-muted">
                      {t("stats.emptyDesc")}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveNav("connectors")}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-3.5 py-2 font-mono text-xs font-semibold text-bone transition-colors hover:bg-cobalt-bright"
                >
                  <Plug size={13} aria-hidden />
                  <span>{t("stats.emptyConnectAction")}</span>
                </button>
              </section>
            )}

            {/* GitHub-style yearly heatmap */}
            <YearlyHeatmap
              year={selectedYear}
              currentYear={currentYear}
              minYear={minYear}
              days={stats.days}
              yearRequests={stats.this_year.requests}
              loading={loading}
              onChangeYear={setSelectedYear}
            />

            {/* Fun facts grid */}
            <FunFactsGrid stats={stats} currentYear={currentYear} />
          </>
        ) : null}
      </div>
    </div>
  );
}
