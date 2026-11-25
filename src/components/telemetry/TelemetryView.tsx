import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useTelemetryStore } from "@/stores";
import { MockBadge } from "@/components/shell/MockBadge";

export function TelemetryView() {
  const { t } = useTranslation();
  const summary = useTelemetryStore((s) => s.summary);
  const loading = useTelemetryStore((s) => s.loading);
  const isMockData = useTelemetryStore((s) => s.isMockData);
  const loadSummary = useTelemetryStore((s) => s.loadSummary);

  useEffect(() => {
    if (!summary && !loading) {
      void loadSummary();
    }
  }, [summary, loading, loadSummary]);

  return (
    <div className="h-full overflow-y-auto p-6 lg:p-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold text-slate-100">{t("telemetry.title")}</h1>
              {isMockData && <MockBadge />}
            </div>
            <p className="mt-1 text-sm text-slate-400">{t("telemetry.subtitle")}</p>
          </div>
          <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-400">
            {t("shell.phasePreviewBadge")}
          </span>
        </div>

        <p className="rounded-xl border border-cobalt-500/20 bg-cobalt-900/25 px-4 py-3 text-xs text-slate-300">
          {t("telemetry.comingSoon")}
        </p>

        {summary && (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="rounded-xl border border-white/10 bg-cobalt-900/25 p-4">
                <div className="text-xs text-slate-400">{t("telemetry.totalSaved")}</div>
                <div className="mt-1 font-mono text-2xl font-semibold text-emerald-300">
                  {summary.total_saved_tokens.toLocaleString()}
                </div>
              </div>
              <div className="rounded-xl border border-white/10 bg-cobalt-900/25 p-4">
                <div className="text-xs text-slate-400">{t("telemetry.sessionSaved")}</div>
                <div className="mt-1 font-mono text-2xl font-semibold text-cobalt-300">
                  {summary.session_saved_tokens.toLocaleString()}
                </div>
              </div>
              <div className="rounded-xl border border-white/10 bg-cobalt-900/25 p-4">
                <div className="text-xs text-slate-400">{t("telemetry.compressionRatio")}</div>
                <div className="mt-1 font-mono text-2xl font-semibold text-violet-300">
                  {Math.round(summary.compression_ratio * 100)}%
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-white/10 bg-cobalt-900/20 p-5">
              <h2 className="text-sm font-semibold text-slate-200">{t("telemetry.byClient")}</h2>
              <div className="mt-3 space-y-2">
                {summary.by_client.map((client) => (
                  <div
                    key={client.client_name}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/5 bg-void/50 px-3 py-2 text-xs"
                  >
                    <span className="font-mono font-medium text-slate-100">
                      {client.client_name}
                    </span>
                    <span className="font-mono text-emerald-300">
                      {t("library.tokensSaved", { count: client.saved_tokens })}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
