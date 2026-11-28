import { useCallback, useEffect, useId, useMemo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { formatCompactNumber, formatTokenCount } from "@/lib/format";
import { usePrefersReducedMotion } from "@/lib/usePrefersReducedMotion";
import type { UsageDay } from "@/types/contracts";
import {
  buildYearHeatmapGrid,
  formatShortCalendarDate,
  HEATMAP_LEVEL_STYLES,
  type HeatmapCell,
  type HeatmapLevel,
} from "./statsHelpers";
import {
  readAnchorRect,
  StatsTooltip,
  type TooltipAnchorRect,
} from "./StatsTooltip";

interface YearlyHeatmapProps {
  year: number;
  currentYear: number;
  minYear: number;
  days: readonly UsageDay[];
  yearRequests: number;
  loading: boolean;
  onChangeYear: (nextYear: number) => void;
}

interface ActiveHeatmapTooltip {
  cell: HeatmapCell;
  anchorRect: TooltipAnchorRect;
}

const CELL_SIZE = 12;
const CELL_GAP = 3;
const CELL_STEP = CELL_SIZE + CELL_GAP;
const DAY_LABEL_WIDTH = 34;
const MONTH_HEADER_HEIGHT = 18;
const HEATMAP_REVEAL_SPAN_MS = 1450;
const LEGEND_LEVELS: readonly HeatmapLevel[] = [0, 1, 2, 3, 4];

export function YearlyHeatmap({
  year,
  currentYear,
  minYear,
  days,
  yearRequests,
  loading,
  onChangeYear,
}: YearlyHeatmapProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language ?? "en";
  const prefersReducedMotion = usePrefersReducedMotion();

  const [activeTooltip, setActiveTooltip] = useState<ActiveHeatmapTooltip | null>(null);
  const tooltipId = useId();

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

  const weekdayShortLabels = useMemo(
    () => [
      t("stats.weekdaysShort.0"),
      t("stats.weekdaysShort.1"),
      t("stats.weekdaysShort.2"),
      t("stats.weekdaysShort.3"),
      t("stats.weekdaysShort.4"),
      t("stats.weekdaysShort.5"),
      t("stats.weekdaysShort.6"),
    ],
    [t],
  );

  const grid = useMemo(() => buildYearHeatmapGrid(year, days), [year, days]);

  const buildTooltipText = useCallback(
    (cell: HeatmapCell): string => {
      if (!cell.date) return "";
      const dateLabel = formatShortCalendarDate(cell.date, monthNames, language);
      if (cell.requests === 0 && cell.savedTokens === 0 && cell.memoriesCreated === 0) {
        return t("stats.heatmap.tooltipEmpty", { date: dateLabel });
      }
      const reqPart = t("stats.heatmap.requestsPart", { count: cell.requests });
      const tokensPart = t("stats.heatmap.tokensPart", {
        tokens: formatCompactNumber(cell.savedTokens),
      });
      const memPart = t("stats.heatmap.memoriesPart", { count: cell.memoriesCreated });
      return `${dateLabel} · ${reqPart} · ${tokensPart} · ${memPart}`;
    },
    [language, monthNames, t],
  );

  const showTooltipForElement = useCallback((cell: HeatmapCell, target: Element) => {
    if (!cell.date) return;
    setActiveTooltip({
      cell,
      anchorRect: readAnchorRect(target),
    });
  }, []);

  const clearTooltip = useCallback(() => {
    setActiveTooltip(null);
  }, []);

  useEffect(() => {
    setActiveTooltip(null);
  }, [year]);

  const gridWidth = grid.weeks.length * CELL_STEP - CELL_GAP;
  const gridHeight = 7 * CELL_STEP - CELL_GAP;
  const svgWidth = DAY_LABEL_WIDTH + gridWidth + 2;
  const svgHeight = MONTH_HEADER_HEIGHT + gridHeight + 2;

  const canGoPrev = year > minYear;
  const canGoNext = year < currentYear;

  return (
    <section className="rounded-[2px] border border-rule bg-surface p-5">
      {/* Header + Year selector */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-bone-subtle">
            {t("stats.heatmap.title")}
          </h2>
          <p className="mt-1 text-xs text-bone-muted">
            {t("stats.heatmap.yearSummary", {
              count: yearRequests,
              requests: formatTokenCount(yearRequests, language),
              year,
            })}
          </p>
        </div>

        <div
          className="inline-flex items-center gap-1 rounded-[2px] border border-rule bg-void p-0.5 font-mono text-xs"
          role="group"
          aria-label={t("stats.heatmap.yearSelectorAria")}
        >
          <button
            type="button"
            disabled={!canGoPrev || loading}
            onClick={() => onChangeYear(year - 1)}
            aria-label={t("stats.heatmap.prevYear", { year: year - 1 })}
            className="inline-flex h-7 w-7 items-center justify-center rounded-[1px] text-bone-muted transition-colors hover:bg-surface-2 hover:text-bone focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none disabled:opacity-35"
          >
            <ChevronLeft size={14} aria-hidden />
          </button>
          <span className="min-w-[4.25rem] px-2 text-center font-mono text-xs font-semibold tabular-nums text-bone">
            {year}
          </span>
          <button
            type="button"
            disabled={!canGoNext || loading}
            onClick={() => onChangeYear(year + 1)}
            aria-label={t("stats.heatmap.nextYear", { year: year + 1 })}
            className="inline-flex h-7 w-7 items-center justify-center rounded-[1px] text-bone-muted transition-colors hover:bg-surface-2 hover:text-bone focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none disabled:opacity-35"
          >
            <ChevronRight size={14} aria-hidden />
          </button>
        </div>
      </div>

      {/* Scrollable SVG heatmap (plain SVG, zero WebGL, Eco-friendly) */}
      <div
        className="mt-4 w-full overflow-x-auto pb-2"
        onScroll={clearTooltip}
      >
        <div className="inline-block min-w-max">
          <svg
            width={svgWidth}
            height={svgHeight}
            viewBox={`0 0 ${svgWidth} ${svgHeight}`}
            role="group"
            aria-label={t("stats.heatmap.ariaLabel", { year })}
            className="block select-none"
            onMouseLeave={clearTooltip}
          >
            {/* Month labels along top */}
            {grid.monthLabels.map(({ month, weekIndex }) => (
              <text
                key={month}
                x={DAY_LABEL_WIDTH + weekIndex * CELL_STEP}
                y={11}
                fill="var(--color-bone-muted, #a4a096)"
                fontSize={10}
                fontFamily="var(--font-mono)"
              >
                {monthNames[month]}
              </text>
            ))}

            {/* Weekday labels along left (Lun … Dom) */}
            {weekdayShortLabels.map((label, rowIdx) => (
              <text
                key={rowIdx}
                x={0}
                y={MONTH_HEADER_HEIGHT + rowIdx * CELL_STEP + CELL_SIZE - 2}
                fill="var(--color-bone-subtle, #6f6c65)"
                fontSize={9.5}
                fontFamily="var(--font-mono)"
              >
                {label}
              </text>
            ))}

            {/* Day squares grouped by week column for left->right reveal */}
            {grid.weeks.map((week, weekIdx) => {
              const colDelayMs = prefersReducedMotion
                ? 0
                : Math.round(
                    (weekIdx / Math.max(1, grid.weeks.length - 1)) * HEATMAP_REVEAL_SPAN_MS,
                  );
              const colStyle: CSSProperties | undefined = prefersReducedMotion
                ? undefined
                : ({ "--cobalt-col-delay": `${colDelayMs}ms` } as CSSProperties);

              return (
                <g
                  key={`${year}-week-${weekIdx}`}
                  className={prefersReducedMotion ? undefined : "cobalt-heatmap-col"}
                  style={colStyle}
                >
                  {week.map((cell, dayIdx) => {
                    if (!cell.date) return null;
                    const style = HEATMAP_LEVEL_STYLES[cell.level];
                    const x = DAY_LABEL_WIDTH + weekIdx * CELL_STEP;
                    const y = MONTH_HEADER_HEIGHT + dayIdx * CELL_STEP;
                    const isFocused = activeTooltip?.cell.date === cell.date;
                    const tooltipText = buildTooltipText(cell);

                    return (
                      <rect
                        key={cell.date}
                        x={x}
                        y={y}
                        width={CELL_SIZE}
                        height={CELL_SIZE}
                        rx={2.5}
                        ry={2.5}
                        fill={style.fill}
                        stroke={
                          isFocused
                            ? "var(--color-bone, #ece9e1)"
                            : cell.isToday
                              ? "var(--color-cobalt-ink, #79a8ff)"
                              : style.border
                        }
                        strokeWidth={isFocused || cell.isToday ? 1.25 : 0.75}
                        tabIndex={0}
                        role="button"
                        aria-label={tooltipText}
                        aria-describedby={isFocused ? tooltipId : undefined}
                        className="cursor-pointer outline-none transition-[stroke] duration-75"
                        onMouseEnter={(e) => showTooltipForElement(cell, e.currentTarget)}
                        onMouseLeave={clearTooltip}
                        onFocus={(e) => showTooltipForElement(cell, e.currentTarget)}
                        onBlur={clearTooltip}
                      />
                    );
                  })}
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      {/* Footer: active days count + intensity legend */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-rule pt-3 text-[11px] text-bone-subtle">
        <span className="font-mono tabular-nums">
          {t("stats.heatmap.activeDays", {
            active: grid.activeDays,
            total: grid.totalDays,
          })}
        </span>

        <div className="flex items-center gap-1.5 font-mono text-[10px] text-bone-muted">
          <span>{t("stats.heatmap.less")}</span>
          <div className="flex items-center gap-[3px]" aria-hidden>
            {LEGEND_LEVELS.map((level) => {
              const style = HEATMAP_LEVEL_STYLES[level];
              return (
                <span
                  key={level}
                  className="inline-block h-[11px] w-[11px] rounded-[2.5px] border"
                  style={{
                    backgroundColor: style.fill,
                    borderColor: style.border,
                  }}
                />
              );
            })}
          </div>
          <span>{t("stats.heatmap.more")}</span>
        </div>
      </div>

      {/* Portal floating tooltip (never clipped by scroll containers or viewport edges) */}
      <StatsTooltip
        id={tooltipId}
        anchorRect={activeTooltip?.anchorRect ?? null}
        content={activeTooltip ? buildTooltipText(activeTooltip.cell) : null}
        onDismiss={clearTooltip}
      />
    </section>
  );
}
