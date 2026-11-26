import { useEffect, useMemo } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Sparkles, Terminal, Trash2, X } from "lucide-react";
import {
  formatAiClientName,
  formatShortFilePath,
  pathBasename,
} from "@/lib/format";
import {
  CLI_ACTIVITY_COLORS,
  useCliActivityStore,
  useMemoryStore,
  useSynapticStore,
  useUiStore,
  type CliActivityEntry,
} from "@/stores";
import type { CliActivity, Project } from "@/types/contracts";

function formatEventTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

function formatActivityAction(
  activity: CliActivity,
  projectRoot: string | null,
  t: TFunction,
): string {
  const firstFile = activity.files[0];
  const shortFile = firstFile
    ? formatShortFilePath(firstFile, activity.cwd, projectRoot)
    : null;
  const extraCount = Math.max(0, activity.files.length - 1);

  switch (activity.kind) {
    case "file_edit":
      if (shortFile && extraCount > 0) {
        return t("cliActivity.action.fileEditMany", { file: shortFile, count: extraCount });
      }
      if (shortFile) {
        return t("cliActivity.action.fileEditOne", { file: shortFile });
      }
      return t("cliActivity.action.fileEditGeneric");
    case "git_commit":
      if (activity.detail) {
        return t("cliActivity.action.gitCommitDetail", { detail: activity.detail });
      }
      if (shortFile) {
        return t("cliActivity.action.gitCommitFile", { file: shortFile });
      }
      return t("cliActivity.action.gitCommitGeneric");
    case "command":
      if (activity.detail) {
        return t("cliActivity.action.commandDetail", { detail: activity.detail });
      }
      return t("cliActivity.action.commandGeneric");
    case "session_start":
      return t("cliActivity.action.sessionStart");
    case "turn_end":
      return t("cliActivity.action.turnEnd");
    case "session_end":
      return t("cliActivity.action.sessionEnd");
  }
}

function buildCompactLine(
  activity: CliActivity,
  projectMap: ReadonlyMap<string, Project>,
  t: TFunction,
): { summary: string; tooltip: string } {
  const client = formatAiClientName(activity.client_name);
  const project = activity.project_id ? projectMap.get(activity.project_id) : undefined;
  const projectLabel =
    activity.project_name ?? project?.name ?? pathBasename(activity.cwd);
  const action = formatActivityAction(activity, project?.root_path ?? null, t);

  const parts = [client, projectLabel, action].filter((p): p is string => Boolean(p));
  const summary = parts.join(" · ");
  const tooltipParts = [summary];
  if (activity.files.length > 0) {
    tooltipParts.push(activity.files.join(", "));
  }
  return { summary, tooltip: tooltipParts.join("\n") };
}

/**
 * Compact live shell bar showing real-time `cobalt://cli-activity` events
 * (e.g. "Claude Code · CucutaCome · editó src/api.ts") across every view.
 */
export function CliActivityShellBar() {
  const { t } = useTranslation();

  const entries = useCliActivityStore((s) => s.entries);
  const visible = useCliActivityStore((s) => s.visible);
  const expanded = useCliActivityStore((s) => s.expanded);
  const dismissBar = useCliActivityStore((s) => s.dismissBar);
  const toggleExpanded = useCliActivityStore((s) => s.toggleExpanded);
  const setExpanded = useCliActivityStore((s) => s.setExpanded);
  const clearFeed = useCliActivityStore((s) => s.clearFeed);

  const graph = useMemoryStore((s) => s.graph);
  const setSelectedNodeId = useMemoryStore((s) => s.setSelectedNodeId);
  const setActiveNav = useUiStore((s) => s.setActiveNav);
  const pulseNodes = useSynapticStore((s) => s.pulseNodes);

  const projectMap = useMemo(
    () => new Map(graph?.projects.map((p) => [p.project.id, p.project]) ?? []),
    [graph?.projects],
  );

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setExpanded(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded, setExpanded]);

  if (!visible || entries.length === 0) {
    return null;
  }

  const latest = entries[0]!;
  const latestColor = CLI_ACTIVITY_COLORS[latest.activity.kind];
  const latestLine = buildCompactLine(latest.activity, projectMap, t);

  const handleFocusNodes = (entry: CliActivityEntry) => {
    if (entry.matchedNodeIds.length === 0) return;
    const color = CLI_ACTIVITY_COLORS[entry.activity.kind];
    setActiveNav("brain");
    setSelectedNodeId(entry.matchedNodeIds[0] ?? null);
    pulseNodes(entry.matchedNodeIds, color, 3200, 1.0);
    setExpanded(false);
  };

  return (
    <div
      className="relative z-25 shrink-0 border-b border-rule bg-surface/95"
      role="region"
      aria-label={t("cliActivity.regionLabel")}
      aria-live="polite"
    >
      {/* Compact single-line live feed bar */}
      <div className="flex min-h-8 items-center justify-between gap-2.5 px-4 py-1">
        <button
          type="button"
          onClick={toggleExpanded}
          aria-expanded={expanded}
          title={latestLine.tooltip}
          className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none"
        >
          <span
            className="h-2 w-2 shrink-0 animate-pulse rounded-full"
            style={{ backgroundColor: latestColor }}
            aria-hidden
          />
          <Terminal size={12} className="shrink-0 text-cobalt-ink" aria-hidden />
          <span className="shrink-0 rounded-[2px] border border-rule bg-void px-1.5 py-0.5 font-mono text-[9px] font-medium uppercase tracking-[0.1em] text-bone-muted">
            {t("cliActivity.liveBadge")}
          </span>
          <span className="min-w-0 truncate font-mono text-[11px] text-bone">
            {latestLine.summary}
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-1.5">
          {latest.matchedNodeIds.length > 0 && (
            <button
              type="button"
              onClick={() => handleFocusNodes(latest)}
              title={t("cliActivity.pulseNodesHint")}
              className="inline-flex items-center gap-1 rounded-[2px] border border-cobalt-rule bg-cobalt-wash px-1.5 py-0.5 font-mono text-[10px] text-cobalt-ink transition-colors hover:bg-cobalt hover:text-bone"
            >
              <Sparkles size={10} aria-hidden />
              <span>{t("cliActivity.nodesPulsed", { count: latest.matchedNodeIds.length })}</span>
            </button>
          )}

          <span className="hidden font-mono text-[10px] tabular-nums text-bone-subtle sm:inline">
            {formatEventTime(latest.activity.timestamp)}
          </span>

          {entries.length > 1 && (
            <button
              type="button"
              onClick={toggleExpanded}
              aria-expanded={expanded}
              title={expanded ? t("cliActivity.hideFeed") : t("cliActivity.showFeed")}
              className="inline-flex h-5 items-center gap-1 rounded-[2px] border border-rule bg-surface-2 px-1.5 font-mono text-[10px] tabular-nums text-bone-muted hover:border-rule-strong hover:text-bone"
            >
              <span>{entries.length}</span>
              {expanded ? (
                <ChevronUp size={11} aria-hidden />
              ) : (
                <ChevronDown size={11} aria-hidden />
              )}
            </button>
          )}

          <button
            type="button"
            onClick={dismissBar}
            title={t("common.close")}
            aria-label={t("common.close")}
            className="inline-flex h-5 w-5 items-center justify-center rounded-[2px] text-bone-subtle hover:bg-surface-2 hover:text-bone"
          >
            <X size={11} aria-hidden />
          </button>
        </div>
      </div>

      {/* Expandable compact recent CLI activity feed */}
      {expanded && (
        <div className="pointer-events-auto absolute top-full right-3 z-40 mt-1.5 w-[min(36rem,calc(100%-1.5rem))] max-h-[min(60vh,24rem)] overflow-y-auto rounded-[2px] border border-rule-strong bg-surface/98 shadow-[0_18px_44px_rgba(0,0,0,0.72)] backdrop-blur-sm">
          <div className="flex items-center justify-between gap-2 border-b border-rule px-3.5 py-2">
            <span className="inline-flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-cobalt-ink">
              <Terminal size={11} aria-hidden />
              {t("cliActivity.feedTitle")}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={clearFeed}
                className="inline-flex items-center gap-1 rounded-[2px] border border-rule bg-surface-2 px-2 py-0.5 font-mono text-[10px] text-bone-muted hover:border-rule-strong hover:text-bone"
              >
                <Trash2 size={10} aria-hidden />
                {t("cliActivity.clearFeed")}
              </button>
              <button
                type="button"
                onClick={() => setExpanded(false)}
                aria-label={t("common.close")}
                className="inline-flex h-5 w-5 items-center justify-center rounded-[2px] border border-rule bg-surface-2 text-bone-muted hover:text-bone"
              >
                <X size={11} aria-hidden />
              </button>
            </div>
          </div>

          <div className="divide-y divide-rule bg-void/70">
            {entries.map((entry) => {
              const color = CLI_ACTIVITY_COLORS[entry.activity.kind];
              const line = buildCompactLine(entry.activity, projectMap, t);
              return (
                <div
                  key={entry.id}
                  title={line.tooltip}
                  className="flex items-center justify-between gap-2.5 px-3.5 py-2 font-mono text-[11px]"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: color }}
                      aria-hidden
                    />
                    <span className="truncate text-bone">{line.summary}</span>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {entry.matchedNodeIds.length > 0 && (
                      <button
                        type="button"
                        onClick={() => handleFocusNodes(entry)}
                        className="inline-flex items-center gap-1 rounded-[2px] border border-cobalt-rule bg-cobalt-wash px-1.5 py-0.5 text-[9px] text-cobalt-ink hover:bg-cobalt hover:text-bone"
                      >
                        <Sparkles size={9} aria-hidden />
                        {entry.matchedNodeIds.length}
                      </button>
                    )}
                    <span className="text-[10px] tabular-nums text-bone-subtle">
                      {formatEventTime(entry.activity.timestamp)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
