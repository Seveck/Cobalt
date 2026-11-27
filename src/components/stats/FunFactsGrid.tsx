import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Bot,
  Calendar,
  CalendarDays,
  Clock,
  Flame,
  FolderKanban,
  Layers,
  Sparkles,
  Zap,
} from "lucide-react";
import { formatAiClientName, formatCompactNumber, formatTokenCount } from "@/lib/format";
import { OPERATION_COLORS, type UsageStats } from "@/types/contracts";
import {
  daysSinceCalendarDate,
  filterAiClients,
  formatFullCalendarDate,
  formatHourRange,
  formatHourShort,
} from "./statsHelpers";

interface FunFactsGridProps {
  stats: UsageStats;
  currentYear: number;
}

const HOUR_TICKS = [0, 6, 12, 18, 23] as const;

export function FunFactsGrid({ stats, currentYear }: FunFactsGridProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language ?? "en";

  const [hoveredHour, setHoveredHour] = useState<number | null>(null);
  const [hoveredWeekday, setHoveredWeekday] = useState<number | null>(null);

  const monthNames = useMemo(
    () => [
      t("stats.months.0"),
      t("stats.months.1"),
      t("stats.months.2"),
      t("stats.months.3"),
      t("stats.months.4"),
      t("stats.months.5"),
      t("stats.months.6"),
      t("stats.months.7"),
      t("stats.months.8"),
      t("stats.months.9"),
      t("stats.months.10"),
      t("stats.months.11"),
    ],
    [t],
  );

  const weekdayNames = useMemo(
    () => [
      t("stats.weekdaysFull.0"),
      t("stats.weekdaysFull.1"),
      t("stats.weekdaysFull.2"),
      t("stats.weekdaysFull.3"),
      t("stats.weekdaysFull.4"),
      t("stats.weekdaysFull.5"),
      t("stats.weekdaysFull.6"),
    ],
    [t],
  );

  const weekdayInitials = useMemo(
    () => [
      t("stats.weekdaysInitial.0"),
      t("stats.weekdaysInitial.1"),
      t("stats.weekdaysInitial.2"),
      t("stats.weekdaysInitial.3"),
      t("stats.weekdaysInitial.4"),
      t("stats.weekdaysInitial.5"),
      t("stats.weekdaysInitial.6"),
    ],
    [t],
  );

  // 1. Top AI client (explicitly excluding `git`, which is commits rather than an AI)
  const aiClients = useMemo(() => filterAiClients(stats.by_client), [stats.by_client]);
  const topAiClient = aiClients[0] ?? null;
  const totalAiRequests = useMemo(
    () => aiClients.reduce((sum, c) => sum + c.requests, 0),
    [aiClients],
  );

  // 2. Peak hour of day (24 buckets)
  const hours = useMemo(
    () => Array.from({ length: 24 }, (_, idx) => stats.by_hour[idx] ?? 0),
    [stats.by_hour],
  );
  const peakHour = useMemo(() => {
    let maxIdx = -1;
    let maxVal = 0;
    for (let i = 0; i < hours.length; i += 1) {
      const v = hours[i] ?? 0;
      if (v > maxVal) {
        maxVal = v;
        maxIdx = i;
      }
    }
    return maxIdx >= 0 ? { hour: maxIdx, requests: maxVal } : null;
  }, [hours]);

  // 3. Favorite weekday (7 buckets, Monday = 0)
  const weekdays = useMemo(
    () => Array.from({ length: 7 }, (_, idx) => stats.by_weekday[idx] ?? 0),
    [stats.by_weekday],
  );
  const peakWeekday = useMemo(() => {
    let maxIdx = -1;
    let maxVal = 0;
    for (let i = 0; i < weekdays.length; i += 1) {
      const v = weekdays[i] ?? 0;
      if (v > maxVal) {
        maxVal = v;
        maxIdx = i;
      }
    }
    return maxIdx >= 0 ? { dayIndex: maxIdx, requests: maxVal } : null;
  }, [weekdays]);

  // 4. Breakdown by operation
  const operations = useMemo(
    () =>
      [...stats.by_operation]
        .filter((o) => o.requests > 0)
        .sort((a, b) => b.requests - a.requests),
    [stats.by_operation],
  );
  const totalOpRequests = useMemo(
    () => operations.reduce((sum, o) => sum + o.requests, 0),
    [operations],
  );

  // 5. Since when
  const firstActivityDate = useMemo(
    () =>
      stats.first_activity
        ? formatFullCalendarDate(stats.first_activity, monthNames, language)
        : null,
    [language, monthNames, stats.first_activity],
  );
  const daysSinceStart = useMemo(
    () => daysSinceCalendarDate(stats.first_activity),
    [stats.first_activity],
  );
  const elapsedLabel = useMemo(() => {
    if (daysSinceStart === null) return null;
    if (daysSinceStart === 0) return t("stats.facts.sinceToday");
    if (daysSinceStart < 60) {
      return t("stats.facts.sinceDays", { count: daysSinceStart });
    }
    const months = Math.floor(daysSinceStart / 30);
    if (months < 24) {
      return t("stats.facts.sinceMonths", { count: months });
    }
    const years = Math.floor(daysSinceStart / 365);
    return t("stats.facts.sinceYears", { count: years });
  }, [daysSinceStart, t]);

  const yearLabel =
    stats.year === currentYear
      ? t("stats.facts.thisYearLabel")
      : t("stats.facts.specificYearLabel", { year: stats.year });

  const busiestDate =
    stats.busiest_day && stats.busiest_day.requests > 0
      ? formatFullCalendarDate(stats.busiest_day.date, monthNames, language)
      : null;

  return (
    <section aria-label={t("stats.facts.sectionAria")} className="space-y-3">
      <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-bone-subtle">
        {t("stats.facts.sectionTitle")}
      </h2>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {/* 1. Tokens saved (year & all-time) */}
        <article className="flex flex-col justify-between rounded-[2px] border border-rule bg-surface p-5">
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-bone-subtle">
                {t("stats.facts.tokensSavedTitle")}
              </span>
              <Sparkles size={14} className="shrink-0 text-verdigris" aria-hidden />
            </div>

            <div className="mt-3 font-mono text-2xl font-semibold tabular-nums text-verdigris">
              {formatTokenCount(stats.this_year.saved_tokens, language)}
            </div>
            <p className="mt-0.5 text-xs text-bone-muted">{yearLabel}</p>
          </div>

          <div className="mt-4 flex items-baseline justify-between gap-2 border-t border-rule pt-3 text-xs">
            <span className="text-bone-subtle">{t("stats.facts.allTimeLabel")}</span>
            <span className="font-mono font-semibold tabular-nums text-bone">
              {formatTokenCount(stats.all_time.saved_tokens, language)}
            </span>
          </div>
        </article>

        {/* 2. Top AI client (hides `git`) */}
        <article className="flex flex-col justify-between rounded-[2px] border border-rule bg-surface p-5">
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-bone-subtle">
                {t("stats.facts.topAiTitle")}
              </span>
              <Bot size={14} className="shrink-0 text-cobalt-ink" aria-hidden />
            </div>

            {topAiClient ? (
              <>
                <div className="mt-3 truncate font-display text-2xl font-medium tracking-tight text-bone">
                  {formatAiClientName(topAiClient.client_name)}
                </div>
                <p className="mt-0.5 font-mono text-xs tabular-nums text-bone-muted">
                  {t("stats.facts.requestsCount", { count: topAiClient.requests })}
                  {totalAiRequests > 0
                    ? ` · ${Math.round((topAiClient.requests / totalAiRequests) * 100)}%`
                    : ""}
                </p>

                {aiClients.length > 1 && (
                  <div className="mt-3 space-y-1.5">
                    {aiClients.slice(0, 3).map((client) => {
                      const pct =
                        totalAiRequests > 0
                          ? Math.max(4, Math.round((client.requests / totalAiRequests) * 100))
                          : 0;
                      return (
                        <div key={client.client_name} className="space-y-0.5">
                          <div className="flex items-center justify-between gap-2 text-[11px]">
                            <span className="truncate text-bone-muted">
                              {formatAiClientName(client.client_name)}
                            </span>
                            <span className="shrink-0 font-mono text-[10px] tabular-nums text-bone-subtle">
                              {formatTokenCount(client.requests, language)}
                            </span>
                          </div>
                          <div className="h-1 w-full overflow-hidden rounded-[1px] bg-void">
                            <div
                              className="h-full bg-cobalt-bright"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            ) : (
              <div className="mt-3">
                <div className="font-mono text-2xl font-semibold text-bone-subtle">—</div>
                <p className="mt-1 text-xs text-bone-subtle">{t("stats.facts.noDataYet")}</p>
              </div>
            )}
          </div>

          <p className="mt-4 border-t border-rule pt-3 text-[11px] leading-relaxed text-bone-subtle">
            {t("stats.facts.topAiNote")}
          </p>
        </article>

        {/* 3. Peak hour of day (by_hour mini bar chart) */}
        <article className="flex flex-col justify-between rounded-[2px] border border-rule bg-surface p-5">
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-bone-subtle">
                {t("stats.facts.peakHourTitle")}
              </span>
              <Clock size={14} className="shrink-0 text-cobalt-ink" aria-hidden />
            </div>

            {peakHour ? (
              <>
                <div className="mt-3 font-mono text-2xl font-semibold tabular-nums text-bone">
                  {formatHourRange(peakHour.hour)}
                </div>
                <p className="mt-0.5 font-mono text-xs tabular-nums text-bone-muted">
                  {hoveredHour !== null
                    ? `${formatHourShort(hoveredHour)} · ${t("stats.facts.requestsCount", {
                        count: hours[hoveredHour] ?? 0,
                      })}`
                    : t("stats.facts.requestsCount", { count: peakHour.requests })}
                </p>
              </>
            ) : (
              <div className="mt-3">
                <div className="font-mono text-2xl font-semibold text-bone-subtle">—</div>
                <p className="mt-1 text-xs text-bone-subtle">{t("stats.facts.noDataYet")}</p>
              </div>
            )}
          </div>

          <div className="mt-4 border-t border-rule pt-3">
            <div
              className="flex h-12 items-end gap-[2px]"
              role="img"
              aria-label={t("stats.facts.peakHourChartAria")}
            >
              {hours.map((count, hour) => {
                const maxCount = peakHour?.requests ?? 0;
                const heightPct =
                  maxCount > 0 && count > 0 ? Math.max(12, Math.round((count / maxCount) * 100)) : 6;
                const isPeak = peakHour !== null && peakHour.hour === hour && count > 0;
                const isHovered = hoveredHour === hour;
                return (
                  <div
                    key={hour}
                    title={`${formatHourShort(hour)} · ${t("stats.facts.requestsCount", { count })}`}
                    onMouseEnter={() => setHoveredHour(hour)}
                    onMouseLeave={() => setHoveredHour(null)}
                    className="flex h-full flex-1 cursor-default items-end"
                  >
                    <div
                      className={`w-full rounded-t-[1px] transition-colors ${
                        count === 0
                          ? "bg-surface-3"
                          : isPeak || isHovered
                            ? "bg-cobalt-ink"
                            : "bg-cobalt-bright/80"
                      }`}
                      style={{ height: `${heightPct}%` }}
                    />
                  </div>
                );
              })}
            </div>
            <div className="mt-1 flex items-center justify-between font-mono text-[9px] tabular-nums text-bone-subtle">
              {HOUR_TICKS.map((tick) => (
                <span key={tick}>{`${tick}h`}</span>
              ))}
            </div>
          </div>
        </article>

        {/* 4. Favorite day of the week (by_weekday, Monday = 0) */}
        <article className="flex flex-col justify-between rounded-[2px] border border-rule bg-surface p-5">
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-bone-subtle">
                {t("stats.facts.favoriteWeekdayTitle")}
              </span>
              <CalendarDays size={14} className="shrink-0 text-cobalt-ink" aria-hidden />
            </div>

            {peakWeekday ? (
              <>
                <div className="mt-3 font-display text-2xl font-medium tracking-tight text-bone">
                  {weekdayNames[peakWeekday.dayIndex]}
                </div>
                <p className="mt-0.5 font-mono text-xs tabular-nums text-bone-muted">
                  {hoveredWeekday !== null
                    ? `${weekdayNames[hoveredWeekday]} · ${t("stats.facts.requestsCount", {
                        count: weekdays[hoveredWeekday] ?? 0,
                      })}`
                    : t("stats.facts.requestsCount", { count: peakWeekday.requests })}
                </p>
              </>
            ) : (
              <div className="mt-3">
                <div className="font-mono text-2xl font-semibold text-bone-subtle">—</div>
                <p className="mt-1 text-xs text-bone-subtle">{t("stats.facts.noDataYet")}</p>
              </div>
            )}
          </div>

          <div className="mt-4 border-t border-rule pt-3">
            <div
              className="grid h-12 grid-cols-7 items-end gap-1.5"
              role="img"
              aria-label={t("stats.facts.favoriteWeekdayChartAria")}
            >
              {weekdays.map((count, dayIdx) => {
                const maxCount = peakWeekday?.requests ?? 0;
                const heightPct =
                  maxCount > 0 && count > 0 ? Math.max(14, Math.round((count / maxCount) * 100)) : 8;
                const isPeak = peakWeekday !== null && peakWeekday.dayIndex === dayIdx && count > 0;
                const isHovered = hoveredWeekday === dayIdx;
                return (
                  <div
                    key={dayIdx}
                    title={`${weekdayNames[dayIdx]} · ${t("stats.facts.requestsCount", { count })}`}
                    onMouseEnter={() => setHoveredWeekday(dayIdx)}
                    onMouseLeave={() => setHoveredWeekday(null)}
                    className="flex h-full cursor-default items-end"
                  >
                    <div
                      className={`w-full rounded-t-[2px] transition-colors ${
                        count === 0
                          ? "bg-surface-3"
                          : isPeak || isHovered
                            ? "bg-cobalt-ink"
                            : "bg-cobalt-bright/80"
                      }`}
                      style={{ height: `${heightPct}%` }}
                    />
                  </div>
                );
              })}
            </div>
            <div className="mt-1 grid grid-cols-7 gap-1.5 text-center font-mono text-[9px] text-bone-subtle">
              {weekdayInitials.map((initial, idx) => (
                <span
                  key={idx}
                  className={
                    peakWeekday && peakWeekday.dayIndex === idx ? "font-semibold text-cobalt-ink" : ""
                  }
                >
                  {initial}
                </span>
              ))}
            </div>
          </div>
        </article>

        {/* 5. Current streak / Best streak */}
        <article className="flex flex-col justify-between rounded-[2px] border border-rule bg-surface p-5">
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-bone-subtle">
                {t("stats.facts.streakTitle")}
              </span>
              <Flame
                size={14}
                className={
                  stats.current_streak_days > 0
                    ? "shrink-0 text-ochre"
                    : "shrink-0 text-bone-subtle"
                }
                aria-hidden
              />
            </div>

            <div className="mt-3 font-mono text-2xl font-semibold tabular-nums text-bone">
              {t("stats.facts.daysCount", { count: stats.current_streak_days })}
            </div>
            <p className="mt-0.5 text-xs text-bone-muted">
              {stats.current_streak_days > 0
                ? t("stats.facts.streakActiveHint")
                : t("stats.facts.streakIdleHint")}
            </p>
          </div>

          <div className="mt-4 flex items-baseline justify-between gap-2 border-t border-rule pt-3 text-xs">
            <span className="text-bone-subtle">{t("stats.facts.bestStreakLabel")}</span>
            <span className="font-mono font-semibold tabular-nums text-ochre">
              {t("stats.facts.daysCount", { count: stats.best_streak_days })}
            </span>
          </div>
        </article>

        {/* 6. Busiest day */}
        <article className="flex flex-col justify-between rounded-[2px] border border-rule bg-surface p-5">
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-bone-subtle">
                {t("stats.facts.busiestDayTitle")}
              </span>
              <Zap size={14} className="shrink-0 text-cobalt-ink" aria-hidden />
            </div>

            {busiestDate && stats.busiest_day ? (
              <>
                <div className="mt-3 font-display text-2xl font-medium tracking-tight text-bone">
                  {busiestDate}
                </div>
                <p className="mt-0.5 font-mono text-xs tabular-nums text-cobalt-ink">
                  {t("stats.facts.requestsCount", { count: stats.busiest_day.requests })}
                </p>
              </>
            ) : (
              <div className="mt-3">
                <div className="font-mono text-2xl font-semibold text-bone-subtle">—</div>
                <p className="mt-1 text-xs text-bone-subtle">{t("stats.facts.noDataYet")}</p>
              </div>
            )}
          </div>

          <div className="mt-4 border-t border-rule pt-3 font-mono text-[11px] tabular-nums text-bone-subtle">
            {stats.busiest_day && stats.busiest_day.requests > 0
              ? `${t("stats.heatmap.tokensPart", {
                  tokens: formatCompactNumber(stats.busiest_day.saved_tokens),
                })} · ${t("stats.heatmap.memoriesPart", {
                  count: stats.busiest_day.memories_created,
                })}`
              : yearLabel}
          </div>
        </article>

        {/* 7. Most used project */}
        <article className="flex flex-col justify-between rounded-[2px] border border-rule bg-surface p-5">
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-bone-subtle">
                {t("stats.facts.topProjectTitle")}
              </span>
              <FolderKanban size={14} className="shrink-0 text-cobalt-ink" aria-hidden />
            </div>

            {stats.top_project ? (
              <>
                <div
                  title={stats.top_project.name}
                  className="mt-3 truncate font-display text-2xl font-medium tracking-tight text-bone"
                >
                  {stats.top_project.name}
                </div>
                <p className="mt-0.5 font-mono text-xs tabular-nums text-bone-muted">
                  {t("stats.facts.requestsCount", { count: stats.top_project.requests })}
                </p>
              </>
            ) : (
              <div className="mt-3">
                <div className="font-mono text-2xl font-semibold text-bone-subtle">—</div>
                <p className="mt-1 text-xs text-bone-subtle">
                  {t("stats.facts.noProjectYet")}
                </p>
              </div>
            )}
          </div>

          <div className="mt-4 border-t border-rule pt-3 text-[11px] text-bone-subtle">
            {stats.top_project && stats.this_year.requests > 0
              ? t("stats.facts.topProjectShare", {
                  pct: Math.min(
                    100,
                    Math.round((stats.top_project.requests / stats.this_year.requests) * 100),
                  ),
                  year: stats.year,
                })
              : t("stats.facts.topProjectHint")}
          </div>
        </article>

        {/* 8. Using Cobalt since */}
        <article className="flex flex-col justify-between rounded-[2px] border border-rule bg-surface p-5">
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-bone-subtle">
                {t("stats.facts.usingSinceTitle")}
              </span>
              <Calendar size={14} className="shrink-0 text-cobalt-ink" aria-hidden />
            </div>

            {firstActivityDate ? (
              <>
                <div className="mt-3 font-display text-2xl font-medium tracking-tight text-bone">
                  {firstActivityDate}
                </div>
                {elapsedLabel && (
                  <p className="mt-0.5 text-xs text-bone-muted">{elapsedLabel}</p>
                )}
              </>
            ) : (
              <div className="mt-3">
                <div className="font-mono text-2xl font-semibold text-bone-subtle">—</div>
                <p className="mt-1 text-xs text-bone-subtle">{t("stats.facts.noDataYet")}</p>
              </div>
            )}
          </div>

          <div className="mt-4 flex items-baseline justify-between gap-2 border-t border-rule pt-3 text-xs">
            <span className="text-bone-subtle">{t("stats.facts.allTimeRequestsLabel")}</span>
            <span className="font-mono font-semibold tabular-nums text-bone">
              {formatTokenCount(stats.all_time.requests, language)}
            </span>
          </div>
        </article>

        {/* 9. Breakdown by operation type */}
        <article className="flex flex-col justify-between rounded-[2px] border border-rule bg-surface p-5">
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-bone-subtle">
                {t("stats.facts.byOperationTitle")}
              </span>
              <Layers size={14} className="shrink-0 text-cobalt-ink" aria-hidden />
            </div>

            {operations.length > 0 ? (
              <div className="mt-3 space-y-3">
                {/* Proportional stacked bar */}
                <div className="flex h-2 w-full overflow-hidden rounded-[2px] bg-void">
                  {operations.map((op) => {
                    const pct = totalOpRequests > 0 ? (op.requests / totalOpRequests) * 100 : 0;
                    return (
                      <div
                        key={op.operation}
                        title={`${t(`stats.ops.${op.operation}`)}: ${formatTokenCount(op.requests, language)}`}
                        style={{
                          width: `${pct}%`,
                          backgroundColor: OPERATION_COLORS[op.operation],
                        }}
                      />
                    );
                  })}
                </div>

                {/* Operation rows */}
                <div className="space-y-1.5">
                  {operations.map((op) => {
                    const pct =
                      totalOpRequests > 0 ? Math.round((op.requests / totalOpRequests) * 100) : 0;
                    return (
                      <div
                        key={op.operation}
                        className="flex items-center justify-between gap-2 text-xs"
                      >
                        <span className="flex min-w-0 items-center gap-2 text-bone-muted">
                          <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ backgroundColor: OPERATION_COLORS[op.operation] }}
                            aria-hidden
                          />
                          <span className="truncate">{t(`stats.ops.${op.operation}`)}</span>
                        </span>
                        <span className="shrink-0 font-mono text-[11px] tabular-nums text-bone">
                          {formatTokenCount(op.requests, language)}{" "}
                          <span className="text-bone-subtle">({pct}%)</span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="mt-3">
                <div className="font-mono text-2xl font-semibold text-bone-subtle">—</div>
                <p className="mt-1 text-xs text-bone-subtle">{t("stats.facts.noDataYet")}</p>
              </div>
            )}
          </div>

          <p className="mt-4 border-t border-rule pt-3 text-[11px] text-bone-subtle">
            {t("stats.facts.byOperationHint")}
          </p>
        </article>
      </div>
    </section>
  );
}
