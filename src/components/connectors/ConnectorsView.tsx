import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plug } from "lucide-react";
import { backendCall, isCommandMocked } from "@/lib/backend";
import { MockBadge } from "@/components/shell/MockBadge";
import type { ConnectorStatus } from "@/types/contracts";

export function ConnectorsView() {
  const { t } = useTranslation();
  const [connectors, setConnectors] = useState<ConnectorStatus[]>([]);
  const isMocked = isCommandMocked("list_connectors");

  useEffect(() => {
    void backendCall("list_connectors")
      .then(setConnectors)
      .catch((err: unknown) => console.error("list_connectors failed", err));
  }, []);

  return (
    <div className="h-full overflow-y-auto bg-void p-6 lg:p-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-rule pb-5">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="font-display text-2xl font-medium tracking-tight text-bone sm:text-3xl">
                {t("connectors.title")}
              </h1>
              {isMocked && <MockBadge />}
            </div>
            <p className="mt-1.5 text-sm text-bone-muted">{t("connectors.subtitle")}</p>
          </div>
          <span className="rounded-[2px] border border-rule bg-surface px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
            {t("shell.phasePreviewBadge")}
          </span>
        </header>

        <p className="rounded-[2px] border border-rule border-l-2 border-l-cobalt bg-surface px-4 py-3 text-xs text-bone-muted">
          {t("connectors.comingSoon")}
        </p>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {connectors.map((connector) => (
            <div
              key={connector.client}
              className="flex items-center justify-between gap-3 rounded-[2px] border border-rule bg-surface p-4"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium text-bone">
                  <Plug size={14} className="shrink-0 text-cobalt-ink" aria-hidden />
                  <span className="truncate font-mono">{connector.client}</span>
                </div>
                <div className="mt-1 truncate font-mono text-[11px] text-bone-subtle">
                  {connector.config_path ?? t("connectors.notDetected")}
                </div>
              </div>
              <span
                className={`shrink-0 rounded-[2px] border px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em] ${
                  connector.connected
                    ? "border-verdigris-rule bg-verdigris-wash text-verdigris"
                    : connector.detected
                      ? "border-rule-strong bg-surface-2 text-bone-muted"
                      : "border-rule bg-void text-bone-subtle"
                }`}
              >
                {connector.connected
                  ? t("connectors.connected")
                  : connector.detected
                    ? t("connectors.detected")
                    : t("connectors.notDetected")}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
