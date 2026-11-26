import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  ArrowUpRight,
  BarChart3,
  Brain,
  Clock,
  Moon,
  Radio,
  Sun,
  Sunset,
  TrendingDown,
  X,
} from "lucide-react";
import { backendCall } from "@/lib/backend";
import {
  extractFirstName,
  formatAiClientName,
  formatTokenCount,
  getDayPeriod,
} from "@/lib/format";
import { useMemoryStore, useSettingsStore, useUiStore } from "@/stores";
import type {
  DaemonStatus,
  ProjectStats,
  TelemetryLog,
  TelemetryOperation,
} from "@/types/contracts";

const AUTO_HIDE_MS = 8200;
const FADE_OUT_MS = 220;

interface WelcomeSnapshot {
  loaded: boolean;
  totalSavedTokens: number;
  todaySavedTokens: number;
  lastActivity: TelemetryLog | null;
  projectsFallback: ProjectStats[];
  daemonFallback: DaemonStatus | null;
}

function getLocalStartOfDayIso(): string {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  return start.toISOString();
}

function formatRelativeAgo(iso: string, t: TFunction): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return t("welcome.timeAgo.justNow");
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return t("welcome.timeAgo.justNow");
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return t("welcome.timeAgo.minutes", { count: diffMin });
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return t("welcome.timeAgo.hours", { count: diffHours });
  const diffDays = Math.floor(diffHours / 24);
  return t("welcome.timeAgo.days", { count: diffDays });
}

function formatLastActivityLine(
  log: TelemetryLog,
  projectNames: ReadonlyMap<string, string>,
  t: TFunction,
): string {
  const client = formatAiClientName(log.client_name);
  const project = log.project_id ? (projectNames.get(log.project_id) ?? null) : null;
  const ago = formatRelativeAgo(log.timestamp, t);
  const op: TelemetryOperation = log.operation;

  if (project) {
    return t(`welcome.activity.${op}InProject`, { client, project, ago });
  }
  return t(`welcome.activity.${op}`, { client, ago });
}

/**
 * Calm, non-blocking welcome card shown once per main-window launch.
 * Never mounted in Quick Note. Auto-hides after ~8 s (pauses on hover),
 * closable, and includes a direct link to Telemetry.
 */
export function WelcomeGreeting() {
  const { t, i18n } = useTranslation();

  const welcomeDismissed = useUiStore((s) => s.welcomeDismissed);
  const dismissWelcome = useUiStore((s) => s.dismissWelcome);
  const setActiveNav = useUiStore((s) => s.setActiveNav);

  const userDisplayName = useSettingsStore((s) => s.settings.user_display_name);
  const daemonStatus = useSettingsStore((s) => s.daemonStatus);
  const graph = useMemoryStore((s) => s.graph);

  const [snapshot, setSnapshot] = useState<WelcomeSnapshot>({
    loaded: false,
    totalSavedTokens: 0,
    todaySavedTokens: 0,
    lastActivity: null,
    projectsFallback: [],
    daemonFallback: null,
  });
  const [closing, setClosing] = useState(false);
  const [paused, setPaused] = useState(false);

  const remainingMsRef = useRef<number>(AUTO_HIDE_MS);
  const timerStartRef = useRef<number>(0);
  const closeTimeoutRef = useRef<number | null>(null);

  const finishClose = useCallback(() => {
    setClosing(true);
    if (closeTimeoutRef.current !== null) {
      window.clearTimeout(closeTimeoutRef.current);
    }
    closeTimeoutRef.current = window.setTimeout(() => {
      closeTimeoutRef.current = null;
      dismissWelcome();
    }, FADE_OUT_MS);
  }, [dismissWelcome]);

  useEffect(() => {
    return () => {
      if (closeTimeoutRef.current !== null) {
        window.clearTimeout(closeTimeoutRef.current);
      }
    };
  }, []);

  // Load welcome summary once per main-window launch
  useEffect(() => {
    if (welcomeDismissed) return;

    let cancelled = false;
    const todayStart = getLocalStartOfDayIso();

    void Promise.allSettled([
      backendCall("get_telemetry_summary", { from: null, to: null, session_only: false }),
      backendCall("get_telemetry_summary", { from: todayStart, to: null, session_only: false }),
      backendCall("query_telemetry", {
        client_name: null,
        project_id: null,
        operations: [],
        from: null,
        to: null,
        text: null,
        limit: 1,
        offset: 0,
      }),
      backendCall("list_projects", { include_archived: false }),
      backendCall("get_daemon_status"),
    ]).then(([totalRes, todayRes, lastRes, projectsRes, daemonRes]) => {
      if (cancelled) return;
      setSnapshot({
        loaded: true,
        totalSavedTokens:
          totalRes.status === "fulfilled" ? totalRes.value.total_saved_tokens : 0,
        todaySavedTokens:
          todayRes.status === "fulfilled" ? todayRes.value.total_saved_tokens : 0,
        lastActivity:
          lastRes.status === "fulfilled" ? (lastRes.value.items[0] ?? null) : null,
        projectsFallback: projectsRes.status === "fulfilled" ? projectsRes.value : [],
        daemonFallback: daemonRes.status === "fulfilled" ? daemonRes.value : null,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [welcomeDismissed]);

  // Auto-hide countdown once data is ready (pauses cleanly while hovered/focused)
  useEffect(() => {
    if (welcomeDismissed || closing || !snapshot.loaded || paused) return;

    timerStartRef.current = performance.now();
    const id = window.setTimeout(() => {
      finishClose();
    }, Math.max(120, remainingMsRef.current));

    return () => {
      window.clearTimeout(id);
      const elapsed = performance.now() - timerStartRef.current;
      remainingMsRef.current = Math.max(0, remainingMsRef.current - elapsed);
    };
  }, [welcomeDismissed, closing, snapshot.loaded, paused, finishClose]);

  const projectNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const stat of snapshot.projectsFallback) {
      map.set(stat.project.id, stat.project.name);
    }
    if (graph) {
      for (const stat of graph.projects) {
        map.set(stat.project.id, stat.project.name);
      }
    }
    return map;
  }, [graph, snapshot.projectsFallback]);

  const period = useMemo(() => getDayPeriod(), []);
  const firstName = extractFirstName(userDisplayName);
  const lang = i18n.resolvedLanguage ?? "en";

  const activeDaemon = daemonStatus ?? snapshot.daemonFallback;
  const connectedClients = useMemo(() => {
    const clients = activeDaemon?.clients ?? [];
    const seen = new Set<string>();
    const names: string[] = [];
    for (const c of clients) {
      const label = formatAiClientName(c.client_name);
      if (!seen.has(label)) {
        seen.add(label);
        names.push(label);
      }
    }
    return { count: clients.length, names };
  }, [activeDaemon]);

  if (welcomeDismissed || !snapshot.loaded) {
    return null;
  }

  const memoriesCount = graph
    ? graph.nodes.length
    : snapshot.projectsFallback.reduce((sum, p) => sum + p.vector_count, 0);
  const projectsCount = graph ? graph.projects.length : snapshot.projectsFallback.length;

  const PeriodIcon = period === "morning" ? Sun : period === "afternoon" ? Sunset : Moon;
  const greetingText = firstName
    ? t("welcome.greetingWithName", { name: firstName })
    : t("welcome.greetingNoName");

  const connectedClientsSummary =
    connectedClients.count === 0
      ? t("welcome.noAisConnected")
      : connectedClients.count === 1
        ? t("welcome.oneAiConnected", { name: connectedClients.names[0] ?? "AI" })
        : t("welcome.manyAisConnected", {
            count: connectedClients.count,
            names:
              connectedClients.names.length > 2
                ? `${connectedClients.names.slice(0, 2).join(", ")} +${connectedClients.names.length - 2}`
                : connectedClients.names.join(", "),
          });

  const lastActivityText = snapshot.lastActivity
    ? formatLastActivityLine(snapshot.lastActivity, projectNames, t)
    : t("welcome.noRecentActivity");

  const handleOpenTelemetry = () => {
    setActiveNav("telemetry");
    finishClose();
  };

  return (
    <aside
      role="status"
      aria-live="polite"
      aria-label={t("welcome.ariaLabel")}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setPaused(false);
        }
      }}
      className={`pointer-events-auto absolute top-16 right-4 z-30 w-[min(23.5rem,calc(100%-2rem))] overflow-hidden rounded-[2px] border border-rule-strong bg-surface/96 shadow-[0_18px_44px_rgba(0,0,0,0.68)] backdrop-blur-sm transition-all duration-200 ${
        closing ? "translate-y-1 opacity-0" : "translate-y-0 opacity-100"
      }`}
    >
      {/* Top mineral cobalt accent rule */}
      <div className="h-[2px] w-full bg-cobalt" aria-hidden />

      <div className="p-4">
        {/* Header: time-of-day kicker + calm greeting + close */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-cobalt-ink">
              <PeriodIcon size={11} aria-hidden />
              <span>{t(`welcome.period.${period}`)}</span>
            </div>
            <h2 className="mt-0.5 truncate font-display text-lg font-medium tracking-tight text-bone">
              {greetingText}
            </h2>
          </div>

          <button
            type="button"
            onClick={finishClose}
            aria-label={t("common.close")}
            title={t("common.close")}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[2px] text-bone-subtle transition-colors hover:bg-surface-2 hover:text-bone focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none"
          >
            <X size={13} aria-hidden />
          </button>
        </div>

        {/* Plain-language summary facts */}
        <ul className="mt-3 space-y-2 border-t border-rule pt-3 text-xs text-bone-muted">
          <li className="flex items-start gap-2">
            <Brain size={13} className="mt-0.5 shrink-0 text-cobalt-ink" aria-hidden />
            <span className="leading-snug text-bone">
              {t("welcome.brainFact", {
                memories: formatTokenCount(memoriesCount, lang),
                projects: formatTokenCount(projectsCount, lang),
              })}
            </span>
          </li>

          <li className="flex items-start gap-2">
            <TrendingDown size={13} className="mt-0.5 shrink-0 text-verdigris" aria-hidden />
            <span className="leading-snug">
              {t("welcome.tokensFact", {
                total: formatTokenCount(snapshot.totalSavedTokens, lang),
                today: formatTokenCount(snapshot.todaySavedTokens, lang),
              })}
            </span>
          </li>

          <li className="flex items-start gap-2">
            <Radio
              size={13}
              className={`mt-0.5 shrink-0 ${
                connectedClients.count > 0 ? "text-verdigris" : "text-bone-subtle"
              }`}
              aria-hidden
            />
            <span className="leading-snug">{connectedClientsSummary}</span>
          </li>

          <li className="flex items-start gap-2">
            <Clock size={13} className="mt-0.5 shrink-0 text-bone-subtle" aria-hidden />
            <span className="line-clamp-2 leading-snug text-bone-muted">{lastActivityText}</span>
          </li>
        </ul>

        {/* Footer link to Telemetry */}
        <div className="mt-3 flex items-center justify-between border-t border-rule pt-2.5">
          <button
            type="button"
            onClick={handleOpenTelemetry}
            className="inline-flex items-center gap-1.5 rounded-[2px] font-mono text-[11px] font-medium text-cobalt-ink transition-colors hover:text-bone focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none"
          >
            <BarChart3 size={12} aria-hidden />
            <span>{t("welcome.openTelemetry")}</span>
            <ArrowUpRight size={11} aria-hidden />
          </button>
        </div>
      </div>

      {/* Subtle auto-hide progress bar */}
      <div className="h-[2px] w-full bg-void/80" aria-hidden>
        <div
          className="h-full origin-left bg-cobalt-ink/60"
          style={{
            animation: `cobalt-welcome-countdown ${AUTO_HIDE_MS}ms linear forwards`,
            animationPlayState: paused ? "paused" : "running",
          }}
        />
      </div>
    </aside>
  );
}
