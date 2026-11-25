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
    <div className="h-full overflow-y-auto bg-void p-6 lg:p-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-rule pb-5">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="font-display text-2xl font-medium tracking-tight text-bone sm:text-3xl">
                {t("telemetry.title")}
              </h1>
              {isMockData && <MockBadge />}
            </div>
            <p className="mt-1.5 text-sm text-bone-muted">{t("telemetry.subtitle")}</p>
          </div>
          <span className="rounded-[2px] border border-rule bg-surface px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
            {t("shell.phasePreviewBadge")}
          </span>
        </header>

        <p className="rounded-[2px] border border-rule border-l-2 border-l-cobalt bg-surface px-4 py-3 text-xs text-bone-muted">
          {t("telemetry.comingSoon")}
        </p>

        {summary && (
          <>
            <div className="grid grid-cols-1 divide-y divide-rule rounded-[2px] border border-rule bg-surface sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              <div className="p-5">
                <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-bone-subtle">
                  {t("telemetry.totalSaved")}
                </div>
                <div className="mt-2 font-mono text-2xl font-semibold tabular-nums text-verdigris">
                  {summary.total_saved_tokens.toLocaleString()}
                </div>
              </div>
              <div className="p-5">
                <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-bone-subtle">
                  {t("telemetry.sessionSaved")}
                </div>
                <div className="mt-2 font-mono text-2xl font-semibold tabular-nums text-cobalt-ink">
                  {summary.session_saved_tokens.toLocaleString()}
                </div>
              </div>
              <div className="p-5">
                <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-bone-subtle">
                  {t("telemetry.compressionRatio")}
                </div>
                <div className="mt-2 font-mono text-2xl font-semibold tabular-nums text-ochre">
                  {Math.round(summary.compression_ratio * 100)}%
                </div>
              </div>
            </div>

            <section className="rounded-[2px] border border-rule bg-surface">
              <div className="border-b border-rule px-5 py-3">
                <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-bone-subtle">
                  {t("telemetry.byClient")}
                </h2>
              </div>
              <div className="divide-y divide-rule">
                {summary.by_client.map((client) => (
                  <div
                    key={client.client_name}
                    className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-xs"
                  >
                    <span className="font-mono font-medium text-bone">{client.client_name}</span>
                    <span className="font-mono tabular-nums text-verdigris">
                      {t("library.tokensSaved", { count: client.saved_tokens })}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
