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
    <div className="h-full overflow-y-auto p-6 lg:p-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold text-slate-100">{t("connectors.title")}</h1>
              {isMocked && <MockBadge />}
            </div>
            <p className="mt-1 text-sm text-slate-400">{t("connectors.subtitle")}</p>
          </div>
          <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-400">
            {t("shell.phasePreviewBadge")}
          </span>
        </div>

        <p className="rounded-xl border border-cobalt-500/20 bg-cobalt-900/25 px-4 py-3 text-xs text-slate-300">
          {t("connectors.comingSoon")}
        </p>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {connectors.map((connector) => (
            <div
              key={connector.client}
              className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-cobalt-900/20 p-4"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium text-slate-100">
                  <Plug size={14} className="text-cobalt-300" aria-hidden />
                  <span className="font-mono">{connector.client}</span>
                </div>
                <div className="mt-1 truncate font-mono text-[11px] text-slate-400">
                  {connector.config_path ?? t("connectors.notDetected")}
                </div>
              </div>
              <span
                className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
                  connector.connected
                    ? "bg-emerald-500/15 text-emerald-300"
                    : connector.detected
                      ? "bg-white/10 text-slate-300"
                      : "bg-white/5 text-slate-500"
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
