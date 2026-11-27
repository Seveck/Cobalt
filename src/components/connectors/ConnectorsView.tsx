import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  FileWarning,
  Loader2,
  Plug,
  RefreshCw,
  ShieldCheck,
  Stethoscope,
  Terminal,
  Wrench,
  XCircle,
} from "lucide-react";
import { backendCall } from "@/lib/backend";
import { copyToClipboard } from "@/lib/dialogs";
import { AI_CLIENT_LABELS, formatAiClientName } from "@/lib/format";
import { useSettingsStore } from "@/stores";
import { Select, Toggle, type SelectOption } from "@/components/ui";
import {
  AI_CLIENTS,
  type AiClient,
  type CheckStatus,
  type ConnectorStatus,
  type DoctorReport,
} from "@/types/contracts";
import { AutoCaptureSection } from "./AutoCaptureSection";
import { ProModePanel } from "./ProModePanel";

const CLIENT_LABELS = AI_CLIENT_LABELS;

type CopyFeedback = "idle" | "copied" | "failed";

function checkStatusIcon(status: CheckStatus) {
  switch (status) {
    case "ok":
      return <CheckCircle2 size={14} className="shrink-0 text-verdigris" aria-hidden />;
    case "warning":
      return <AlertTriangle size={14} className="shrink-0 text-ochre" aria-hidden />;
    case "error":
      return <XCircle size={14} className="shrink-0 text-cinnabar" aria-hidden />;
    default:
      return <FileWarning size={14} className="shrink-0 text-bone-subtle" aria-hidden />;
  }
}

export function ConnectorsView() {
  const { t } = useTranslation();
  const settings = useSettingsStore((s) => s.settings);

  const [connectors, setConnectors] = useState<ConnectorStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [togglingClient, setTogglingClient] = useState<AiClient | null>(null);
  const [manualClient, setManualClient] = useState<AiClient>("claude_desktop");
  const [snippetCopyState, setSnippetCopyState] = useState<CopyFeedback>("idle");
  const [pathCopyState, setPathCopyState] = useState<CopyFeedback>("idle");
  const [highlightManual, setHighlightManual] = useState(false);

  const manualSectionRef = useRef<HTMLElement | null>(null);
  const snippetCopyTimerRef = useRef<number | null>(null);
  const pathCopyTimerRef = useRef<number | null>(null);
  const highlightTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (snippetCopyTimerRef.current !== null) window.clearTimeout(snippetCopyTimerRef.current);
      if (pathCopyTimerRef.current !== null) window.clearTimeout(pathCopyTimerRef.current);
      if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current);
    };
  }, []);

  // MCP Doctor state
  const [doctorReport, setDoctorReport] = useState<DoctorReport | null>(null);
  const [runningDoctor, setRunningDoctor] = useState(false);
  const [fixingCheckId, setFixingCheckId] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [captureRefreshSignal, setCaptureRefreshSignal] = useState(0);

  const flashNotice = useCallback((msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 3400);
  }, []);

  const loadConnectors = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await backendCall("list_connectors");
      setConnectors(list);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConnectors();
  }, [loadConnectors]);

  // Always show all 7 clients in canonical order
  const orderedConnectors = useMemo<ConnectorStatus[]>(() => {
    const byClient = new Map(connectors.map((c) => [c.client, c]));
    return AI_CLIENTS.map(
      (client) =>
        byClient.get(client) ?? {
          client,
          detected: false,
          config_path: null,
          config_format: client === "codex_cli" ? "toml" : "json",
          connected: false,
          broken: false,
          last_backup_path: null,
          error: null,
          manual_snippet: "",
        },
    );
  }, [connectors]);

  const handleToggleConnector = async (client: AiClient, enable: boolean) => {
    setTogglingClient(client);
    setError(null);
    try {
      const result = await backendCall("toggle_connector", { client, enable });
      setConnectors((prev) => {
        const exists = prev.some((c) => c.client === client);
        if (!exists) return [...prev, result.status];
        return prev.map((c) => (c.client === client ? result.status : c));
      });
      if (result.backup_path) {
        flashNotice(
          t("connectors.toggledWithBackup", {
            client: CLIENT_LABELS[client],
            backup: result.backup_path,
          }),
        );
      } else {
        flashNotice(
          enable
            ? t("connectors.connectedNotice", { client: CLIENT_LABELS[client] })
            : t("connectors.disconnectedNotice", { client: CLIENT_LABELS[client] }),
        );
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTogglingClient(null);
    }
  };

  const handleRunDoctor = async () => {
    setRunningDoctor(true);
    setError(null);
    try {
      const report = await backendCall("run_doctor");
      setDoctorReport(report);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunningDoctor(false);
    }
  };

  const handleDoctorFix = async (checkId: string) => {
    setFixingCheckId(checkId);
    setError(null);
    try {
      const report = await backendCall("doctor_fix", { check_id: checkId });
      setDoctorReport(report);
      await loadConnectors();
      flashNotice(t("doctor.fixApplied"));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFixingCheckId(null);
    }
  };

  const manualClientOptions = useMemo<SelectOption<AiClient>[]>(
    () =>
      AI_CLIENTS.map((client) => ({
        value: client,
        label: CLIENT_LABELS[client],
        detail: client === "codex_cli" ? "TOML" : "JSON",
      })),
    [],
  );

  const selectedManualConnector = useMemo<ConnectorStatus | undefined>(
    () => orderedConnectors.find((c) => c.client === manualClient),
    [orderedConnectors, manualClient],
  );

  const manualSnippet = selectedManualConnector?.manual_snippet ?? "";
  const hasManualSnippet = manualSnippet.trim().length > 0;
  const manualConfigPath = selectedManualConnector?.config_path ?? null;
  const isManualToml = selectedManualConnector?.config_format === "toml";

  const resetCopyStates = useCallback(() => {
    if (snippetCopyTimerRef.current !== null) {
      window.clearTimeout(snippetCopyTimerRef.current);
      snippetCopyTimerRef.current = null;
    }
    if (pathCopyTimerRef.current !== null) {
      window.clearTimeout(pathCopyTimerRef.current);
      pathCopyTimerRef.current = null;
    }
    setSnippetCopyState("idle");
    setPathCopyState("idle");
  }, []);

  const handleSelectManualClient = useCallback(
    (client: AiClient) => {
      setManualClient(client);
      resetCopyStates();
    },
    [resetCopyStates],
  );

  const handleOpenManualForClient = useCallback(
    (client: AiClient) => {
      setManualClient(client);
      resetCopyStates();
      manualSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      setHighlightManual(true);
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current);
      }
      highlightTimerRef.current = window.setTimeout(() => {
        setHighlightManual(false);
        highlightTimerRef.current = null;
      }, 1600);
    },
    [resetCopyStates],
  );

  const handleCopyManual = async () => {
    if (!hasManualSnippet) return;
    const ok = await copyToClipboard(manualSnippet);
    if (snippetCopyTimerRef.current !== null) {
      window.clearTimeout(snippetCopyTimerRef.current);
    }
    setSnippetCopyState(ok ? "copied" : "failed");
    snippetCopyTimerRef.current = window.setTimeout(
      () => {
        setSnippetCopyState("idle");
        snippetCopyTimerRef.current = null;
      },
      ok ? 2000 : 2600,
    );
  };

  const handleCopyConfigPath = async () => {
    if (!manualConfigPath) return;
    const ok = await copyToClipboard(manualConfigPath);
    if (pathCopyTimerRef.current !== null) {
      window.clearTimeout(pathCopyTimerRef.current);
    }
    setPathCopyState(ok ? "copied" : "failed");
    pathCopyTimerRef.current = window.setTimeout(
      () => {
        setPathCopyState("idle");
        pathCopyTimerRef.current = null;
      },
      ok ? 2000 : 2600,
    );
  };

  return (
    <div className="h-full overflow-y-auto bg-void p-6 lg:p-8">
      <div className="mx-auto max-w-5xl space-y-6">
        {/* Header */}
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-rule pb-5">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="font-display text-2xl font-medium tracking-tight text-bone sm:text-3xl">
                {t("connectors.title")}
              </h1>
            </div>
            <p className="mt-1.5 text-sm text-bone-muted">{t("connectors.subtitle")}</p>
          </div>
          <button
            type="button"
            disabled={loading}
            onClick={() => {
              void loadConnectors();
              setCaptureRefreshSignal((n) => n + 1);
            }}
            className="inline-flex items-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface px-3 py-1.5 font-mono text-xs text-bone-muted hover:border-cobalt-ink/60 hover:text-bone disabled:opacity-45"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} aria-hidden />
            {t("common.refresh")}
          </button>
        </header>

        {error && (
          <div className="rounded-[2px] border border-cinnabar-rule bg-cinnabar-wash px-4 py-2.5 text-xs text-cinnabar">
            {error}
          </div>
        )}
        {notice && (
          <div className="flex items-center gap-2 rounded-[2px] border border-verdigris-rule bg-verdigris-wash px-4 py-2.5 font-mono text-xs text-verdigris">
            <Check size={13} aria-hidden />
            <span>{notice}</span>
          </div>
        )}

        {/* 01 — 1-Click Connectors for all 7 AI clients */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-bone-subtle">
              01 — {t("connectors.clientsTitle")}
            </h2>
            <span className="font-mono text-[10px] text-bone-subtle">
              {t("connectors.backupSafetyNote")}
            </span>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {orderedConnectors.map((connector) => {
              const busy = togglingClient === connector.client;
              const label = CLIENT_LABELS[connector.client];
              return (
                <div
                  key={connector.client}
                  className={`flex flex-col justify-between gap-3 rounded-[2px] border p-4 transition-colors ${
                    connector.broken
                      ? "border-cinnabar-rule bg-surface"
                      : connector.connected
                        ? "border-cobalt-rule/70 bg-surface"
                        : "border-rule bg-surface"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Plug size={14} className="shrink-0 text-cobalt-ink" aria-hidden />
                        <span className="text-sm font-semibold text-bone">{label}</span>
                        <span className="rounded-[2px] border border-rule bg-surface-2 px-1.5 py-0.5 font-mono text-[9px] uppercase text-bone-muted">
                          {connector.config_format}
                        </span>
                      </div>
                      <div className="mt-1 truncate font-mono text-[11px] text-bone-subtle">
                        {connector.config_path ?? t("connectors.notDetected")}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-2.5">
                      {busy && (
                        <Loader2 size={13} className="animate-spin text-cobalt-ink" aria-hidden />
                      )}
                      <Toggle
                        checked={connector.connected}
                        disabled={busy}
                        ariaLabel={label}
                        onChange={(enable) => void handleToggleConnector(connector.client, enable)}
                      />
                    </div>
                  </div>

                  {/* Status + Backup path + Errors */}
                  <div className="space-y-1.5 border-t border-rule pt-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span
                        className={`rounded-[2px] border px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em] ${
                          connector.broken
                            ? "border-cinnabar-rule bg-cinnabar-wash text-cinnabar"
                            : connector.connected
                              ? "border-verdigris-rule bg-verdigris-wash text-verdigris"
                              : connector.detected
                                ? "border-rule-strong bg-surface-2 text-bone-muted"
                                : "border-rule bg-void text-bone-subtle"
                        }`}
                      >
                        {connector.broken
                          ? t("connectors.broken")
                          : connector.connected
                            ? t("connectors.connected")
                            : connector.detected
                              ? t("connectors.detected")
                              : t("connectors.notDetected")}
                      </span>

                      <button
                        type="button"
                        onClick={() => handleOpenManualForClient(connector.client)}
                        className="font-mono text-[10px] text-cobalt-ink hover:underline"
                      >
                        {t("connectors.viewManualSnippet")}
                      </button>
                    </div>

                    {connector.last_backup_path && (
                      <div className="truncate font-mono text-[10px] text-bone-muted">
                        <span className="text-bone-subtle">{t("connectors.backupLabel")}:</span>{" "}
                        {connector.last_backup_path}
                      </div>
                    )}

                    {connector.error && (
                      <div className="rounded-[2px] border border-cinnabar-rule/70 bg-cinnabar-wash/70 px-2 py-1 text-[11px] text-cinnabar">
                        {connector.error}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* 02 — Automatic capture */}
        <AutoCaptureSection
          refreshSignal={captureRefreshSignal}
          onNotice={flashNotice}
          onError={setError}
        />

        {/* 03 — Manual setup (NEVER "Copy Config") */}
        <section
          ref={manualSectionRef}
          className={`scroll-mt-6 rounded-[2px] border p-5 transition-all duration-300 ${
            highlightManual
              ? "border-cobalt-ink bg-cobalt-wash/40 ring-2 ring-cobalt-ink/45"
              : "border-rule bg-surface"
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule pb-4">
            <div>
              <h2 className="flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-bone">
                <Terminal size={13} className="text-cobalt-ink" aria-hidden />
                03 — {t("connectors.manualSetupTitle")}
              </h2>
              <p className="mt-1 text-xs text-bone-muted">{t("connectors.manualSetupDesc")}</p>
            </div>

            <div className="flex items-center gap-2">
              <Select<AiClient>
                value={manualClient}
                options={manualClientOptions}
                size="sm"
                align="right"
                className="w-44"
                onChange={handleSelectManualClient}
              />
              <button
                type="button"
                disabled={!hasManualSnippet}
                onClick={() => void handleCopyManual()}
                className={`inline-flex h-7 items-center gap-1.5 rounded-[2px] border px-3 font-mono text-[11px] font-medium transition-colors disabled:opacity-45 ${
                  snippetCopyState === "copied"
                    ? "border-verdigris-rule bg-verdigris-wash text-verdigris"
                    : snippetCopyState === "failed"
                      ? "border-cinnabar-rule bg-cinnabar-wash text-cinnabar"
                      : "border-cobalt-rule bg-cobalt-wash text-cobalt-ink hover:bg-cobalt hover:text-bone"
                }`}
              >
                {snippetCopyState === "copied" ? (
                  <Check size={12} aria-hidden />
                ) : snippetCopyState === "failed" ? (
                  <XCircle size={12} aria-hidden />
                ) : (
                  <Copy size={12} aria-hidden />
                )}
                {snippetCopyState === "copied"
                  ? t("common.copied")
                  : snippetCopyState === "failed"
                    ? t("common.copyFailed")
                    : t("connectors.copySnippet")}
              </button>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-[2px] border border-rule bg-void/70 px-3.5 py-2.5">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 font-mono text-xs">
              <span className="shrink-0 text-[11px] font-medium text-bone-muted">
                {t("connectors.pasteInLabel")}
              </span>
              {manualConfigPath ? (
                <code className="break-all text-bone select-all">{manualConfigPath}</code>
              ) : (
                <span className="text-bone-subtle">{t("connectors.manualPathUnavailable")}</span>
              )}
            </div>

            {manualConfigPath && (
              <button
                type="button"
                onClick={() => void handleCopyConfigPath()}
                className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[2px] border px-2.5 font-mono text-[11px] font-medium transition-colors ${
                  pathCopyState === "copied"
                    ? "border-verdigris-rule bg-verdigris-wash text-verdigris"
                    : pathCopyState === "failed"
                      ? "border-cinnabar-rule bg-cinnabar-wash text-cinnabar"
                      : "border-rule-strong bg-surface text-bone-muted hover:border-cobalt-ink/60 hover:text-bone"
                }`}
              >
                {pathCopyState === "copied" ? (
                  <Check size={12} aria-hidden />
                ) : pathCopyState === "failed" ? (
                  <XCircle size={12} aria-hidden />
                ) : (
                  <Copy size={12} aria-hidden />
                )}
                {pathCopyState === "copied"
                  ? t("common.copied")
                  : pathCopyState === "failed"
                    ? t("common.copyFailed")
                    : t("connectors.copyPath")}
              </button>
            )}
          </div>

          {hasManualSnippet ? (
            <pre className="mt-3 overflow-x-auto rounded-[2px] border border-rule bg-void p-4 font-mono text-xs leading-relaxed text-bone select-all">
              {manualSnippet}
            </pre>
          ) : (
            <div className="mt-3 rounded-[2px] border border-rule bg-void px-4 py-3 font-mono text-xs text-bone-subtle">
              {t("connectors.manualSnippetUnavailable")}
            </div>
          )}

          <p className="mt-2.5 text-xs text-bone-muted">
            {isManualToml ? t("connectors.manualHintToml") : t("connectors.manualHintJson")}
          </p>

          {settings.mcp.http_enabled && (
            <p className="mt-2 font-mono text-[11px] text-bone-subtle">
              {t("connectors.httpEndpointHint", {
                url: `http://127.0.0.1:${settings.mcp.http_port}/mcp`,
              })}
            </p>
          )}
        </section>

        {/* 04 — MCP Doctor */}
        <section className="rounded-[2px] border border-rule bg-surface p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule pb-4">
            <div>
              <h2 className="flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-bone">
                <Stethoscope size={13} className="text-cobalt-ink" aria-hidden />
                04 — {t("doctor.title")}
              </h2>
              <p className="mt-1 text-xs text-bone-muted">{t("doctor.subtitle")}</p>
            </div>

            <button
              type="button"
              disabled={runningDoctor}
              onClick={() => void handleRunDoctor()}
              className="inline-flex items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-3.5 py-1.5 font-mono text-xs font-semibold text-bone hover:bg-cobalt-bright disabled:opacity-45"
            >
              {runningDoctor ? (
                <Loader2 size={12} className="animate-spin" aria-hidden />
              ) : (
                <ShieldCheck size={13} aria-hidden />
              )}
              {runningDoctor ? t("doctor.running") : t("doctor.runButton")}
            </button>
          </div>

          {!doctorReport ? (
            <p className="mt-4 text-xs text-bone-subtle">{t("doctor.emptyHint")}</p>
          ) : (
            <div className="mt-4 space-y-3">
              <div
                className={`flex flex-wrap items-center justify-between gap-2 rounded-[2px] border px-3.5 py-2 font-mono text-xs ${
                  doctorReport.healthy
                    ? "border-verdigris-rule bg-verdigris-wash text-verdigris"
                    : "border-ochre-rule bg-ochre-wash text-ochre"
                }`}
              >
                <span>
                  {doctorReport.healthy ? t("doctor.healthy") : t("doctor.issuesFound")}
                </span>
                <span className="text-[10px] opacity-80">
                  {new Date(doctorReport.generated_at).toLocaleTimeString()}
                </span>
              </div>

              <div className="divide-y divide-rule rounded-[2px] border border-rule bg-void">
                {doctorReport.checks.map((check) => {
                  const fixing = fixingCheckId === check.id;
                  const translatedLabel =
                    check.label_key === "doctor.client"
                      ? (() => {
                          const rawClient = check.id.startsWith("client.")
                            ? check.id.slice("client.".length)
                            : check.id;
                          const clientName = formatAiClientName(rawClient);
                          return t("doctor.client", {
                            client: clientName,
                            defaultValue: clientName,
                          });
                        })()
                      : t(check.label_key, { defaultValue: check.id });
                  return (
                    <div
                      key={check.id}
                      className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5"
                    >
                      <div className="flex min-w-0 items-start gap-2.5">
                        <div className="mt-0.5">{checkStatusIcon(check.status)}</div>
                        <div className="min-w-0">
                          <div className="text-xs font-medium text-bone">{translatedLabel}</div>
                          {check.detail && (
                            <div className="mt-0.5 font-mono text-[11px] text-bone-muted">
                              {check.detail}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        <span className="font-mono text-[10px] uppercase text-bone-subtle">
                          {t(`doctor.status.${check.status}`)}
                        </span>
                        {check.fixable && (
                          <button
                            type="button"
                            disabled={fixing}
                            onClick={() => void handleDoctorFix(check.id)}
                            className="inline-flex items-center gap-1 rounded-[2px] border border-ochre-rule bg-ochre-wash px-2.5 py-1 font-mono text-[10px] font-semibold text-ochre hover:bg-ochre hover:text-void disabled:opacity-45"
                          >
                            {fixing ? (
                              <Loader2 size={10} className="animate-spin" aria-hidden />
                            ) : (
                              <Wrench size={10} aria-hidden />
                            )}
                            {t("doctor.fixButton")}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>

        {/* 04 — Pro Mode */}
        <ProModePanel />
      </div>
    </div>
  );
}
