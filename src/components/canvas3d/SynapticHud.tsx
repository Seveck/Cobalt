import { useTranslation } from "react-i18next";
import { Activity, ChevronDown, ChevronUp, X } from "lucide-react";
import { useSynapticStore } from "@/stores";
import { OPERATION_COLORS } from "@/types/contracts";

export function SynapticHud() {
  const { t } = useTranslation();

  const latestActivity = useSynapticStore((s) => s.latestActivity);
  const recentFeed = useSynapticStore((s) => s.recentFeed);
  const hudVisible = useSynapticStore((s) => s.hudVisible);
  const hudExpanded = useSynapticStore((s) => s.hudExpanded);
  const dismissHud = useSynapticStore((s) => s.dismissHud);
  const toggleHudExpanded = useSynapticStore((s) => s.toggleHudExpanded);

  if (!hudVisible || !latestActivity) {
    return null;
  }

  const opColor = OPERATION_COLORS[latestActivity.operation];

  return (
    <div className="pointer-events-auto w-80 max-w-[90vw] rounded-[2px] border border-rule-strong bg-surface shadow-[0_12px_32px_rgba(0,0,0,0.72)]">
      {/* Compact live pill header */}
      <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="h-2 w-2 shrink-0 animate-pulse rounded-full"
            style={{ backgroundColor: opColor }}
          />
          <Activity size={12} className="shrink-0 text-bone-muted" aria-hidden />
          <span
            className="rounded-[2px] px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase"
            style={{
              backgroundColor: `${opColor}26`,
              color: opColor,
              border: `1px solid ${opColor}66`,
            }}
          >
            {t(`synaptic.ops.${latestActivity.operation}`)}
          </span>
          <span className="truncate font-mono text-[11px] font-medium text-bone">
            {latestActivity.client_name}
          </span>
          {latestActivity.is_replay && (
            <span className="rounded-[2px] border border-ochre-rule bg-ochre-wash px-1 py-0.5 font-mono text-[9px] uppercase text-ochre">
              {t("synaptic.replay")}
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={toggleHudExpanded}
            aria-label={t("synaptic.toggleFeed")}
            className="rounded-[2px] p-1 text-bone-subtle hover:bg-surface-2 hover:text-bone"
          >
            {hudExpanded ? <ChevronDown size={11} aria-hidden /> : <ChevronUp size={11} aria-hidden />}
          </button>
          <button
            type="button"
            onClick={dismissHud}
            aria-label={t("common.close")}
            className="rounded-[2px] p-1 text-bone-subtle hover:bg-surface-2 hover:text-bone"
          >
            <X size={11} aria-hidden />
          </button>
        </div>
      </div>

      {/* Latest query & metrics */}
      <div className="border-t border-rule px-2.5 py-1.5">
        {latestActivity.query_text && (
          <p className="truncate text-[11px] text-bone-muted">{latestActivity.query_text}</p>
        )}
        <div className="mt-1 flex items-center justify-between gap-2 font-mono text-[10px] tabular-nums text-bone-subtle">
          <span>
            {t("synaptic.matchedNodes", { count: latestActivity.matched_nodes.length })}
          </span>
          <span className="text-verdigris">
            {t("synaptic.savedTokens", { count: latestActivity.saved_tokens })}
          </span>
          <span>{latestActivity.latency_ms} ms</span>
        </div>
      </div>

      {/* Expanded discreet feed */}
      {hudExpanded && recentFeed.length > 1 && (
        <div className="max-h-40 divide-y divide-rule overflow-y-auto border-t border-rule bg-void/70">
          {recentFeed.slice(1, 8).map((item) => {
            const c = OPERATION_COLORS[item.operation];
            return (
              <div
                key={`${item.log_id}-${item.timestamp}`}
                className="flex items-center justify-between gap-2 px-2.5 py-1 font-mono text-[10px]"
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: c }}
                  />
                  <span className="uppercase" style={{ color: c }}>
                    {t(`synaptic.ops.${item.operation}`)}
                  </span>
                  <span className="truncate text-bone-muted">{item.client_name}</span>
                </div>
                <span className="shrink-0 tabular-nums text-bone-subtle">
                  {item.matched_nodes.length} · {item.latency_ms}ms
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
