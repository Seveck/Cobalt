import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Archive,
  CheckCircle2,
  Cpu,
  Library,
  Loader2,
  Lock,
  Palette,
  SlidersHorizontal,
} from "lucide-react";
import { useSettingsStore, useUiStore } from "@/stores";
import { Toggle } from "@/components/ui";
import { OPTIONAL_MCP_TOOLS } from "@/types/contracts";

type OptionalMcpTool = (typeof OPTIONAL_MCP_TOOLS)[number];

const CORE_MCP_TOOLS = [
  "search_memory",
  "save_memory",
  "update_memory",
  "create_handoff",
  "resume_handoff",
  "list_project_rules",
] as const;

const OPTIONAL_TOOL_ICONS: Record<OptionalMcpTool, typeof Library> = {
  search_reusable_assets: Library,
  archive_memory: Archive,
  create_theme: Palette,
};

interface AiToolsSectionProps {
  onNotice: (message: string) => void;
  onError: (message: string | null) => void;
}

export function AiToolsSection({ onNotice, onError }: AiToolsSectionProps) {
  const { t } = useTranslation();
  const sectionRef = useRef<HTMLElement | null>(null);

  const settings = useSettingsStore((s) => s.settings);
  const savingSettings = useSettingsStore((s) => s.saving);
  const patchSettings = useSettingsStore((s) => s.patchSettings);

  const connectorsFocusSection = useUiStore((s) => s.connectorsFocusSection);
  const clearConnectorsFocusSection = useUiStore((s) => s.clearConnectorsFocusSection);

  const [savingTool, setSavingTool] = useState<OptionalMcpTool | null>(null);
  const [highlight, setHighlight] = useState(false);

  useEffect(() => {
    if (connectorsFocusSection !== "ai_tools") return;
    sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    setHighlight(true);
    clearConnectorsFocusSection();
    const timer = window.setTimeout(() => setHighlight(false), 2200);
    return () => window.clearTimeout(timer);
  }, [clearConnectorsFocusSection, connectorsFocusSection]);

  const enabledOptionalSet = useMemo(
    () => new Set<string>(settings.mcp.optional_tools ?? []),
    [settings.mcp.optional_tools],
  );

  const enabledOptionalCount = useMemo(
    () => OPTIONAL_MCP_TOOLS.filter((tool) => enabledOptionalSet.has(tool)).length,
    [enabledOptionalSet],
  );

  const handleToggleOptionalTool = useCallback(
    async (tool: OptionalMcpTool, enable: boolean) => {
      setSavingTool(tool);
      onError(null);
      try {
        const latestMcp = useSettingsStore.getState().settings.mcp;
        const nextSet = new Set<string>(latestMcp.optional_tools ?? []);
        if (enable) {
          nextSet.add(tool);
        } else {
          nextSet.delete(tool);
        }

        const knownSet = new Set<string>(OPTIONAL_MCP_TOOLS);
        const nextList: string[] = [
          ...OPTIONAL_MCP_TOOLS.filter((item) => nextSet.has(item)),
          ...[...nextSet].filter((item) => !knownSet.has(item)),
        ];

        await patchSettings({
          mcp: {
            ...latestMcp,
            optional_tools: nextList,
          },
        });

        const storeErr = useSettingsStore.getState().error;
        if (storeErr) {
          onError(storeErr);
        } else {
          const label = t(`connectors.aiTools.optional.${tool}.label`);
          onNotice(
            enable
              ? t("connectors.aiTools.enabledNotice", { tool: label })
              : t("connectors.aiTools.disabledNotice", { tool: label }),
          );
        }
      } catch (err: unknown) {
        onError(err instanceof Error ? err.message : String(err));
      } finally {
        setSavingTool(null);
      }
    },
    [onError, onNotice, patchSettings, t],
  );

  return (
    <section
      ref={sectionRef}
      className={`scroll-mt-6 rounded-[2px] border p-5 transition-all duration-300 ${
        highlight
          ? "border-cobalt-ink bg-cobalt-wash/35 ring-2 ring-cobalt-ink/45"
          : "border-rule bg-surface"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-rule pb-4">
        <div className="max-w-3xl">
          <h2 className="flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-bone">
            <SlidersHorizontal size={13} className="text-cobalt-ink" aria-hidden />
            02 — {t("connectors.aiTools.title")}
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-bone-muted">
            {t("connectors.aiTools.subtitle")}
          </p>
        </div>

        <span className="inline-flex items-center gap-1.5 rounded-[2px] border border-rule-strong bg-void px-2.5 py-1 font-mono text-[10px] tabular-nums text-bone-muted">
          <Cpu size={11} className="text-cobalt-ink" aria-hidden />
          {t("connectors.aiTools.activeSummary", {
            active: CORE_MCP_TOOLS.length + enabledOptionalCount,
            total: CORE_MCP_TOOLS.length + OPTIONAL_MCP_TOOLS.length,
          })}
        </span>
      </div>

      <div className="mt-4 space-y-5">
        {/* Core tools — always on */}
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold text-bone">
              <Lock size={12} className="text-verdigris" aria-hidden />
              <span>{t("connectors.aiTools.coreTitle")}</span>
            </h3>
            <span className="rounded-[2px] border border-verdigris-rule/70 bg-verdigris-wash/60 px-2 py-0.5 font-mono text-[9px] font-medium uppercase tracking-[0.08em] text-verdigris">
              {t("connectors.aiTools.alwaysOnBadge")}
            </span>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {CORE_MCP_TOOLS.map((toolName) => (
              <div
                key={toolName}
                className="flex items-start gap-2 rounded-[2px] border border-rule bg-void/75 px-3 py-2.5"
              >
                <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-verdigris" aria-hidden />
                <div className="min-w-0">
                  <div className="text-xs font-medium text-bone">
                    {t(`connectors.aiTools.core.${toolName}`)}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[10px] text-bone-subtle">
                    {toolName}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Optional tools — user toggles */}
        <div className="space-y-2.5 border-t border-rule pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-bone">
              {t("connectors.aiTools.optionalTitle")}
            </h3>
            <span className="font-mono text-[10px] tabular-nums text-bone-subtle">
              {t("connectors.aiTools.optionalCount", {
                enabled: enabledOptionalCount,
                total: OPTIONAL_MCP_TOOLS.length,
              })}
            </span>
          </div>

          <div className="divide-y divide-rule rounded-[2px] border border-rule bg-void/75">
            {OPTIONAL_MCP_TOOLS.map((tool) => {
              const Icon = OPTIONAL_TOOL_ICONS[tool];
              const enabled = enabledOptionalSet.has(tool);
              const busy = savingTool === tool;
              const label = t(`connectors.aiTools.optional.${tool}.label`);
              const desc = t(`connectors.aiTools.optional.${tool}.desc`);

              return (
                <div
                  key={tool}
                  className="flex items-start justify-between gap-4 px-4 py-3.5 transition-colors"
                >
                  <div className="flex min-w-0 items-start gap-2.5">
                    <Icon
                      size={14}
                      className={`mt-0.5 shrink-0 ${enabled ? "text-cobalt-ink" : "text-bone-subtle"}`}
                      aria-hidden
                    />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-semibold text-bone">{label}</span>
                        <code className="rounded-[2px] border border-rule bg-surface px-1.5 py-0.5 font-mono text-[10px] text-bone-subtle">
                          {tool}
                        </code>
                      </div>
                      <p className="mt-1 text-[11px] leading-relaxed text-bone-muted">{desc}</p>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2 pt-0.5">
                    {busy && (
                      <Loader2 size={12} className="animate-spin text-cobalt-ink" aria-hidden />
                    )}
                    <Toggle
                      checked={enabled}
                      disabled={savingSettings || savingTool !== null}
                      ariaLabel={label}
                      onChange={(next) => void handleToggleOptionalTool(tool, next)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
