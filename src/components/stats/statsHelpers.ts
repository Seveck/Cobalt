import { IpcError } from "@/lib/ipc";
import type { ClientUsageStats, UsageDay } from "@/types/contracts";

export type HeatmapLevel = 0 | 1 | 2 | 3 | 4;

/**
 * 5-step Cobalt intensity scale tuned for the obsidian dark theme (`#111317` surface).
 * Level 0 is an empty cell; levels 1–4 progress from deep mineral cobalt to luminous cobalt ink.
 */
export const HEATMAP_LEVEL_STYLES: Record<
  HeatmapLevel,
  { fill: string; border: string }
> = {
  0: { fill: "#171a21", border: "#23262f" },
  1: { fill: "#132a54", border: "#1d3d78" },
  2: { fill: "#0d47a1", border: "#1d5ec4" },
  3: { fill: "#2563eb", border: "#447ef5" },
  4: { fill: "#79a8ff", border: "#9ec0ff" },
};

export interface HeatmapCell {
  /** `YYYY-MM-DD` for in-year dates, or `null` for leading/trailing padding slots. */
  date: string | null;
  /** 0-based month index (0 = Jan, 11 = Dec), or `null` when out of year. */
  month: number | null;
  /** Day of month (1..31), or `null` when out of year. */
  dayOfMonth: number | null;
  requests: number;
  savedTokens: number;
  memoriesCreated: number;
  level: HeatmapLevel;
  isToday: boolean;
}

export interface MonthColumnLabel {
  month: number;
  weekIndex: number;
}

export interface YearHeatmapGrid {
  year: number;
  /** Each column is a Monday-to-Sunday week (7 cells). */
  weeks: HeatmapCell[][];
  monthLabels: MonthColumnLabel[];
  activeDays: number;
  totalDays: number;
}

/** Detect an IPC `"unsupported"` error (e.g. while backend support is landing). */
export function isUnsupportedError(err: unknown): boolean {
  if (err instanceof IpcError && err.kind === "unsupported") {
    return true;
  }
  if (err instanceof Error && /\bunsupported\b/i.test(err.message)) {
    return true;
  }
  return false;
}

/** Format a local `Date` as `YYYY-MM-DD`. */
export function formatLocalDateKey(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export interface CalendarDateParts {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
}

/**
 * Safely parse a `YYYY-MM-DD` date string or RFC 3339 timestamp into local calendar parts
 * without UTC-to-local off-by-one shifts on date-only strings.
 */
export function parseCalendarDate(raw: string | null | undefined): CalendarDateParts | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnlyMatch) {
    const year = Number(dateOnlyMatch[1]);
    const month = Number(dateOnlyMatch[2]);
    const day = Number(dateOnlyMatch[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { year, month, day };
    }
    return null;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return {
    year: parsed.getFullYear(),
    month: parsed.getMonth() + 1,
    day: parsed.getDate(),
  };
}

/** Format a date as short day + month (e.g. `"12 mar"` in ES, `"Mar 12"` in EN). */
export function formatShortCalendarDate(
  raw: string,
  monthNames: readonly string[],
  language: string,
): string {
  const parts = parseCalendarDate(raw);
  if (!parts) return raw;
  const monthLabel = monthNames[parts.month - 1] ?? String(parts.month);
  if (language.startsWith("es")) {
    return `${parts.day} ${monthLabel.toLowerCase()}`;
  }
  return `${monthLabel} ${parts.day}`;
}

/** Format a date with year (e.g. `"12 mar 2026"` in ES, `"Mar 12, 2026"` in EN). */
export function formatFullCalendarDate(
  raw: string,
  monthNames: readonly string[],
  language: string,
): string {
  const parts = parseCalendarDate(raw);
  if (!parts) return raw;
  const monthLabel = monthNames[parts.month - 1] ?? String(parts.month);
  if (language.startsWith("es")) {
    return `${parts.day} ${monthLabel.toLowerCase()} ${parts.year}`;
  }
  return `${monthLabel} ${parts.day}, ${parts.year}`;
}

/** Compute whole calendar days elapsed from `raw` until today (clamped >= 0). */
export function daysSinceCalendarDate(raw: string | null | undefined): number | null {
  const parts = parseCalendarDate(raw);
  if (!parts) return null;
  const startUtc = Date.UTC(parts.year, parts.month - 1, parts.day);
  const now = new Date();
  const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.floor((todayUtc - startUtc) / 86_400_000);
  return Math.max(0, diffDays);
}

/** Linear-interpolated quantile over a sorted ascending numeric array (`p` in `[0, 1]`). */
function sortedQuantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] ?? 0;
  const pos = (sorted.length - 1) * p;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  const weight = pos - lower;
  const loVal = sorted[lower] ?? 0;
  const hiVal = sorted[upper] ?? loVal;
  return loVal + (hiVal - loVal) * weight;
}

/** Map a day's request count to intensity level `0..4` using the year's non-zero quantiles. */
export function computeQuantileThresholds(days: readonly UsageDay[]): {
  q25: number;
  q50: number;
  q75: number;
  uniformPositive: boolean;
} {
  const nonZero = days
    .map((d) => d.requests)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);

  if (nonZero.length === 0) {
    return { q25: 0, q50: 0, q75: 0, uniformPositive: false };
  }

  const min = nonZero[0] ?? 0;
  const max = nonZero[nonZero.length - 1] ?? 0;
  return {
    q25: sortedQuantile(nonZero, 0.25),
    q50: sortedQuantile(nonZero, 0.5),
    q75: sortedQuantile(nonZero, 0.75),
    uniformPositive: min === max,
  };
}

function requestLevel(
  requests: number,
  thresholds: ReturnType<typeof computeQuantileThresholds>,
): HeatmapLevel {
  if (requests <= 0) return 0;
  if (thresholds.uniformPositive) return 2;
  if (requests <= thresholds.q25) return 1;
  if (requests <= thresholds.q50) return 2;
  if (requests <= thresholds.q75) return 3;
  return 4;
}

/**
 * Build a GitHub-style Monday-to-Sunday weekly grid covering Jan 1 through Dec 31 of `year`.
 * Uses UTC date arithmetic internally so daylight saving transitions never skip or duplicate days.
 */
export function buildYearHeatmapGrid(
  year: number,
  days: readonly UsageDay[],
  todayKey: string = formatLocalDateKey(),
): YearHeatmapGrid {
  const dayMap = new Map<string, UsageDay>();
  for (const entry of days) {
    dayMap.set(entry.date, entry);
  }

  const thresholds = computeQuantileThresholds(days);

  const jan1 = new Date(Date.UTC(year, 0, 1));
  const dec31 = new Date(Date.UTC(year, 11, 31));

  // Monday = 0, Tuesday = 1, ..., Sunday = 6
  const startWeekday = (jan1.getUTCDay() + 6) % 7;
  const totalDays = Math.round((dec31.getTime() - jan1.getTime()) / 86_400_000) + 1;
  const totalSlots = startWeekday + totalDays;
  const weekCount = Math.ceil(totalSlots / 7);

  const weeks: HeatmapCell[][] = Array.from({ length: weekCount }, () =>
    Array.from({ length: 7 }, () => ({
      date: null,
      month: null,
      dayOfMonth: null,
      requests: 0,
      savedTokens: 0,
      memoriesCreated: 0,
      level: 0 as HeatmapLevel,
      isToday: false,
    })),
  );

  const monthFirstWeek = new Map<number, number>();
  let activeDays = 0;

  for (let offset = 0; offset < totalDays; offset += 1) {
    const slot = startWeekday + offset;
    const weekIndex = Math.floor(slot / 7);
    const weekdayIndex = slot % 7;

    const current = new Date(Date.UTC(year, 0, 1 + offset));
    const m = current.getUTCMonth();
    const d = current.getUTCDate();
    const dateKey = `${year}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

    if (d === 1 && !monthFirstWeek.has(m)) {
      monthFirstWeek.set(m, weekIndex);
    }

    const usage = dayMap.get(dateKey);
    const requests = usage?.requests ?? 0;
    const savedTokens = usage?.saved_tokens ?? 0;
    const memoriesCreated = usage?.memories_created ?? 0;

    if (requests > 0) {
      activeDays += 1;
    }

    const weekCol = weeks[weekIndex];
    if (weekCol) {
      weekCol[weekdayIndex] = {
        date: dateKey,
        month: m,
        dayOfMonth: d,
        requests,
        savedTokens,
        memoriesCreated,
        level: requestLevel(requests, thresholds),
        isToday: dateKey === todayKey,
      };
    }
  }

  const monthLabels: MonthColumnLabel[] = [];
  let lastPlacedWeek = -10;
  for (let month = 0; month < 12; month += 1) {
    const weekIndex = monthFirstWeek.get(month);
    if (weekIndex === undefined) continue;
    // Prevent adjacent month labels from overlapping when Jan 1 starts late in week 0.
    const adjustedWeek = weekIndex - lastPlacedWeek < 2 ? lastPlacedWeek + 2 : weekIndex;
    if (adjustedWeek < weekCount) {
      monthLabels.push({ month, weekIndex: adjustedWeek });
      lastPlacedWeek = adjustedWeek;
    }
  }

  return {
    year,
    weeks,
    monthLabels,
    activeDays,
    totalDays,
  };
}

/**
 * Filter non-AI sources (specifically `git`, which represents commit hooks rather than an AI app)
 * and sort descending by request count.
 */
export function filterAiClients(
  clients: readonly ClientUsageStats[],
): ClientUsageStats[] {
  return clients
    .filter((entry) => {
      const normalized = entry.client_name.trim().toLowerCase();
      return normalized.length > 0 && normalized !== "git" && entry.requests > 0;
    })
    .sort((a, b) => b.requests - a.requests || b.saved_tokens - a.saved_tokens);
}

/** Format an hour bucket (`0..23`) into a readable range like `"16:00 – 17:00"`. */
export function formatHourRange(hour: number): string {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  const next = (h + 1) % 24;
  return `${String(h).padStart(2, "0")}:00 – ${String(next).padStart(2, "0")}:00`;
}

/** Format a single hour label like `"16:00"`. */
export function formatHourShort(hour: number): string {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  return `${String(h).padStart(2, "0")}:00`;
}
