import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowRightLeft,
  Check,
  Copy,
  ExternalLink,
  FileCode2,
  Loader2,
  RotateCcw,
  Save,
  SlidersHorizontal,
  Trash2,
  Wrench,
} from "lucide-react";
import { backendCall } from "@/lib/backend";
import { copyToClipboard } from "@/lib/dialogs";
import { createDefaultSettings, formatBytes, formatTokenCount } from "@/lib/format";
import { toDisplayError, type DisplayError } from "@/lib/friendlyError";
import { useHardwareStore, useMemoryStore, useSettingsStore } from "@/stores";
import { ErrorAlert, Select, Skeleton, Toggle, type SelectOption } from "@/components/ui";
import {
  ENGINE_KINDS,
  type EngineKind,
  type McpToolDoc,
  type SearchSettings,
} from "@/types/contracts";

const EXTERNAL_ENDPOINT_ENGINES: ReadonlySet<EngineKind> = new Set([
  "qdrant_remote",
  "chroma_db",
]);

interface SliderRowProps {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  formatValue?: (v: number) => string;
  disabled?: boolean;
  onChange: (value: number) => void;
}

function SliderRow({
  label,
  hint,
  value,
  min,
  max,
  step,
  formatValue,
  disabled = false,
  onChange,
}: SliderRowProps) {
  return (
    <div className="space-y-1.5 rounded-[2px] border border-rule bg-void p-3">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium text-bone">{label}</span>
        <span className="font-mono text-[11px] font-semibold tabular-nums text-cobalt-ink">
          {formatValue ? formatValue(value) : value}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-full cursor-pointer accent-cobalt disabled:opacity-45"
      />
      <p className="text-[11px] text-bone-subtle">{hint}</p>
    </div>
  );
}

export function ProModePanel() {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language ?? "en";

  const settings = useSettingsStore((s) => s.settings);
  const saving = useSettingsStore((s) => s.saving);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const loadGraph = useMemoryStore((s) => s.loadGraph);

  const models = useHardwareStore((s) => s.models);
  const engineStatus = useHardwareStore((s) => s.engineStatus);
  const swapProgress = useHardwareStore((s) => s.swapProgress);
  const swapReport = useHardwareStore((s) => s.swapReport);
  const isSwapping = useHardwareStore((s) => s.isSwapping);
  const hardwareError = useHardwareStore((s) => s.error);
  const swapEngine = useHardwareStore((s) => s.swapEngine);
  const removeEngineArtifacts = useHardwareStore((s) => s.removeEngineArtifacts);

  // MCP tool docs editor
  const [toolDocs, setToolDocs] = useState<McpToolDoc[]>([]);
  const [docDrafts, setDocDrafts] = useState<Record<string, string>>({});
  const [loadingDocs, setLoadingDocs] = useState(false);

  // Search sliders draft
  const [searchDraft, setSearchDraft] = useState<SearchSettings>(settings.search);

  // HTTP / REST settings draft
  const [httpEnabled, setHttpEnabled] = useState(settings.mcp.http_enabled);
  const [restEnabled, setRestEnabled] = useState(settings.mcp.rest_enabled);
  const [httpPort, setHttpPort] = useState(settings.mcp.http_port);

  // Engine / Model swap state
  const [targetEngine, setTargetEngine] = useState<EngineKind>(settings.vector_engine);
  const [targetModelId, setTargetModelId] = useState<string>(settings.embedding_model_id);
  const [externalEndpoint, setExternalEndpoint] = useState<string>(
    engineStatus?.sidecar_endpoint ?? "",
  );
  const [removingOld, setRemovingOld] = useState(false);

  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<DisplayError | null>(null);
  const [copiedSwagger, setCopiedSwagger] = useState(false);

  const flashNotice = useCallback((msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 3200);
  }, []);

  const loadToolDocs = useCallback(async () => {
    setLoadingDocs(true);
    try {
      const docs = await backendCall("get_mcp_tool_docs");
      setToolDocs(docs);
      const next: Record<string, string> = {};
      for (const doc of docs) {
        next[doc.name] = doc.override_description ?? doc.default_description;
      }
      setDocDrafts(next);
    } catch (err: unknown) {
      setError(toDisplayError(err, t, "get_mcp_tool_docs"));
    } finally {
      setLoadingDocs(false);
    }
  }, [t]);

  useEffect(() => {
    if (settings.pro_mode) {
      void loadToolDocs();
    }
  }, [settings.pro_mode, loadToolDocs]);

  useEffect(() => {
    setSearchDraft(settings.search);
    setHttpEnabled(settings.mcp.http_enabled);
    setRestEnabled(settings.mcp.rest_enabled);
    setHttpPort(settings.mcp.http_port);
    setTargetEngine(settings.vector_engine);
    setTargetModelId(settings.embedding_model_id);
  }, [settings]);

  const engineOptions = useMemo<SelectOption<EngineKind>[]>(
    () =>
      ENGINE_KINDS.map((eng) => ({
        value: eng,
        label: t(`engines.${eng}`),
      })),
    [t],
  );

  const modelOptions = useMemo<SelectOption<string>[]>(
    () =>
      models.map((m) => ({
        value: m.id,
        label: m.display_name,
        detail: `${m.dimensions}d · ${formatBytes(m.size_bytes)}`,
      })),
    [models],
  );

  const swaggerUrl = `http://127.0.0.1:${settings.mcp.http_port}/api/v1/docs`;

  const handleSaveDocstrings = async () => {
    setError(null);
    const overrides: Record<string, string> = {};
    for (const doc of toolDocs) {
      const draft = (docDrafts[doc.name] ?? "").trim();
      if (draft && draft !== doc.default_description.trim()) {
        overrides[doc.name] = draft;
      }
    }
    await updateSettings({
      ...settings,
      mcp: {
        ...settings.mcp,
        tool_docstring_overrides: overrides,
      },
    });
    await loadToolDocs();
    flashNotice(t("pro.docstringsSaved"));
  };

  const handleSaveApiSettings = async () => {
    setError(null);
    const clampedPort = Math.max(1024, Math.min(65535, Math.round(httpPort) || 7437));
    await updateSettings({
      ...settings,
      mcp: {
        ...settings.mcp,
        http_enabled: httpEnabled,
        rest_enabled: restEnabled,
        http_port: clampedPort,
      },
    });
    flashNotice(t("settings.saved"));
  };

  const handleSaveSearchSettings = async () => {
    setError(null);
    await updateSettings({
      ...settings,
      search: searchDraft,
    });
    flashNotice(t("pro.searchSaved"));
  };

  const handleResetSearchDefaults = () => {
    setSearchDraft(createDefaultSettings().search);
  };

  const handleSwapEngine = async () => {
    setError(null);
    const needsEndpoint = EXTERNAL_ENDPOINT_ENGINES.has(targetEngine);
    const endpoint = needsEndpoint ? externalEndpoint.trim() || null : null;
    const report = await swapEngine({
      target_engine: targetEngine,
      target_model_id: targetModelId,
      external_endpoint: endpoint,
    });
    if (report) {
      await Promise.all([loadSettings(), loadGraph()]);
      flashNotice(
        report.rolled_back ? t("pro.swapRolledBack") : t("pro.swapCompleted"),
      );
    }
  };

  const handleRemoveOldEngine = async () => {
    if (!swapReport) return;
    setRemovingOld(true);
    setError(null);
    try {
      const reclaimed = await removeEngineArtifacts(
        swapReport.from_engine,
        swapReport.from_model_id,
      );
      if (reclaimed !== null) {
        flashNotice(t("pro.artifactsRemoved", { size: formatBytes(reclaimed) }));
      }
    } finally {
      setRemovingOld(false);
    }
  };

  const handleCopySwagger = async () => {
    const ok = await copyToClipboard(swaggerUrl);
    if (ok) {
      setCopiedSwagger(true);
      window.setTimeout(() => setCopiedSwagger(false), 1800);
    }
  };

  const swapPercent =
    swapProgress && swapProgress.total > 0
      ? Math.min(100, Math.round((swapProgress.processed / swapProgress.total) * 100))
      : 0;

  return (
    <section className="space-y-6 rounded-[2px] border border-rule bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule pb-4">
        <div>
          <div className="flex items-center gap-2">
            <Wrench size={14} className="text-ochre" aria-hidden />
            <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-bone">
              {t("pro.title")}
            </h2>
          </div>
          <p className="mt-1 text-xs text-bone-muted">{t("pro.subtitle")}</p>
        </div>

        <div className="flex items-center gap-2.5 text-xs text-bone-muted">
          <span>{t("settings.proModeTitle")}</span>
          <Toggle
            checked={settings.pro_mode}
            disabled={saving}
            ariaLabel={t("settings.proModeTitle")}
            onChange={(checked) => {
              void updateSettings({ ...settings, pro_mode: checked });
            }}
          />
        </div>
      </div>

      {notice && (
        <div className="flex items-center gap-2 rounded-[2px] border border-verdigris-rule bg-verdigris-wash px-3.5 py-2 font-mono text-xs text-verdigris">
          <Check size={13} aria-hidden />
          <span>{notice}</span>
        </div>
      )}
      <ErrorAlert error={error ?? hardwareError} />

      {!settings.pro_mode ? (
        <p className="text-xs text-bone-subtle">{t("pro.disabledHint")}</p>
      ) : (
        <div className="cobalt-view-enter space-y-6">
          {/* 1. REST / Swagger API */}
          <div className="space-y-3 rounded-[2px] border border-rule bg-surface-2 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-cobalt-ink">
                  {t("pro.restTitle")}
                </h3>
                <p className="mt-0.5 text-xs text-bone-muted">{t("pro.restDesc")}</p>
              </div>
              <div className="flex items-center gap-1.5">
                <a
                  href={swaggerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt-wash px-2.5 py-1 font-mono text-[11px] text-cobalt-ink hover:bg-cobalt hover:text-bone"
                >
                  <ExternalLink size={11} aria-hidden />
                  {t("pro.openSwagger")}
                </a>
                <button
                  type="button"
                  onClick={() => void handleCopySwagger()}
                  className="inline-flex items-center gap-1 rounded-[2px] border border-rule-strong bg-surface px-2.5 py-1 font-mono text-[11px] text-bone-muted hover:text-bone"
                >
                  {copiedSwagger ? (
                    <Check size={11} className="text-verdigris" aria-hidden />
                  ) : (
                    <Copy size={11} aria-hidden />
                  )}
                  {copiedSwagger ? t("common.copied") : swaggerUrl}
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-4 border-t border-rule pt-3 text-xs">
              <label className="flex items-center gap-2 text-bone-muted">
                <Toggle
                  checked={httpEnabled}
                  disabled={saving}
                  ariaLabel={t("pro.httpEnabled")}
                  onChange={setHttpEnabled}
                />
                <span>{t("pro.httpEnabled")}</span>
              </label>
              <label className="flex items-center gap-2 text-bone-muted">
                <Toggle
                  checked={restEnabled}
                  disabled={saving}
                  ariaLabel={t("pro.restEnabled")}
                  onChange={setRestEnabled}
                />
                <span>{t("pro.restEnabled")}</span>
              </label>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] text-bone-subtle">{t("pro.portLabel")}</span>
                <input
                  type="number"
                  min={1024}
                  max={65535}
                  value={httpPort}
                  onChange={(e) => setHttpPort(Number(e.target.value))}
                  className="h-7 w-24 rounded-[2px] border border-rule-strong bg-void px-2 font-mono text-xs text-bone focus:border-cobalt-ink focus:outline-none"
                />
              </div>
              <button
                type="button"
                disabled={saving}
                onClick={() => void handleSaveApiSettings()}
                className="ml-auto inline-flex items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-3 py-1 font-mono text-[11px] font-semibold text-bone hover:bg-cobalt-bright disabled:opacity-45"
              >
                <Save size={11} aria-hidden />
                {t("common.apply")}
              </button>
            </div>
          </div>

          {/* 2. Engine & Model Live Swap */}
          <div className="space-y-3 rounded-[2px] border border-rule bg-surface-2 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-cobalt-ink">
                  <ArrowRightLeft size={12} aria-hidden />
                  {t("pro.engineSwapTitle")}
                </h3>
                <p className="mt-0.5 text-xs text-bone-muted">{t("pro.engineSwapDesc")}</p>
              </div>
              {engineStatus && (
                <span className="rounded-[2px] border border-rule bg-void px-2.5 py-1 font-mono text-[10px] text-bone-muted">
                  {engineStatus.engine} · {engineStatus.model_id} ({engineStatus.vector_count}v)
                </span>
              )}
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
                  {t("onboarding.engine")}
                </span>
                <Select<EngineKind>
                  value={targetEngine}
                  options={engineOptions}
                  disabled={isSwapping}
                  className="w-full"
                  onChange={setTargetEngine}
                />
              </div>

              <div className="space-y-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
                  {t("onboarding.model")}
                </span>
                <Select<string>
                  value={targetModelId}
                  options={modelOptions}
                  disabled={isSwapping || modelOptions.length === 0}
                  className="w-full"
                  onChange={setTargetModelId}
                />
              </div>
            </div>

            {EXTERNAL_ENDPOINT_ENGINES.has(targetEngine) && (
              <div className="space-y-1">
                <label className="font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
                  {t("pro.externalEndpointLabel")}
                </label>
                <input
                  type="text"
                  value={externalEndpoint}
                  disabled={isSwapping}
                  onChange={(e) => setExternalEndpoint(e.target.value)}
                  placeholder="http://127.0.0.1:6333"
                  className="h-9 w-full rounded-[2px] border border-rule-strong bg-void px-3 font-mono text-xs text-bone placeholder:text-bone-subtle focus:border-cobalt-ink focus:outline-none"
                />
              </div>
            )}

            {/* Live swap progress */}
            {(isSwapping || swapProgress) && (
              <div className="space-y-2 rounded-[2px] border border-cobalt-rule bg-cobalt-wash/50 p-3">
                <div className="flex items-center justify-between font-mono text-[11px]">
                  <span className="inline-flex items-center gap-1.5 text-cobalt-ink">
                    {isSwapping && <Loader2 size={12} className="animate-spin" aria-hidden />}
                    {t(`pro.swapPhase.${swapProgress?.phase ?? "staging"}`)}
                  </span>
                  <span className="tabular-nums text-bone">
                    {swapProgress ? `${swapProgress.processed} / ${swapProgress.total}` : "…"} ({swapPercent}%)
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-[1px] bg-void">
                  <div
                    className="h-full bg-cobalt transition-all duration-200"
                    style={{ width: `${swapPercent}%` }}
                  />
                </div>
                {swapProgress && swapProgress.queued_writes > 0 && (
                  <p className="font-mono text-[10px] text-ochre">
                    {t("pro.queuedWrites", { count: swapProgress.queued_writes })}
                  </p>
                )}
                {swapProgress?.message && (
                  <p className="text-[11px] text-bone-muted">{swapProgress.message}</p>
                )}
              </div>
            )}

            {/* Swap Report & Remove Old Engine */}
            {swapReport && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-[2px] border border-verdigris-rule bg-verdigris-wash/60 p-3 text-xs">
                <div className="space-y-0.5 font-mono text-[11px]">
                  <div className="text-bone">
                    {swapReport.from_engine}/{swapReport.from_model_id} → {swapReport.to_engine}/
                    {swapReport.to_model_id}
                  </div>
                  <div className="text-bone-muted">
                    {t("pro.swapSummary", {
                      reembedded: swapReport.reembedded,
                      verified: swapReport.verified_count,
                    })}
                  </div>
                </div>
                {swapReport.reclaimable_bytes > 0 && (
                  <button
                    type="button"
                    disabled={removingOld}
                    onClick={() => void handleRemoveOldEngine()}
                    className="inline-flex items-center gap-1.5 rounded-[2px] border border-ochre-rule bg-ochre-wash px-3 py-1.5 font-mono text-[11px] font-semibold text-ochre hover:bg-ochre hover:text-void disabled:opacity-45"
                  >
                    {removingOld ? (
                      <Loader2 size={12} className="animate-spin" aria-hidden />
                    ) : (
                      <Trash2 size={12} aria-hidden />
                    )}
                    {t("pro.removeOldEngine", {
                      size: formatBytes(swapReport.reclaimable_bytes),
                    })}
                  </button>
                )}
              </div>
            )}

            <div className="flex items-center justify-end">
              <button
                type="button"
                disabled={isSwapping}
                onClick={() => void handleSwapEngine()}
                className="inline-flex items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-4 py-1.5 font-mono text-xs font-semibold text-bone hover:bg-cobalt-bright disabled:opacity-45"
              >
                {isSwapping ? (
                  <Loader2 size={12} className="animate-spin" aria-hidden />
                ) : (
                  <ArrowRightLeft size={12} aria-hidden />
                )}
                {isSwapping ? t("pro.swapping") : t("pro.swapButton")}
              </button>
            </div>
          </div>

          {/* 3. Search & RRF Sliders */}
          <div className="space-y-3 rounded-[2px] border border-rule bg-surface-2 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-cobalt-ink">
                  <SlidersHorizontal size={12} aria-hidden />
                  {t("pro.searchSlidersTitle")}
                </h3>
                <p className="mt-0.5 text-xs text-bone-muted">{t("pro.searchSlidersDesc")}</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleResetSearchDefaults}
                  className="inline-flex items-center gap-1 rounded-[2px] border border-rule-strong bg-surface px-2.5 py-1 font-mono text-[11px] text-bone-muted hover:text-bone"
                >
                  <RotateCcw size={11} aria-hidden />
                  {t("filterDock.reset")}
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void handleSaveSearchSettings()}
                  className="inline-flex items-center gap-1 rounded-[2px] border border-cobalt-rule bg-cobalt px-3 py-1 font-mono text-[11px] font-semibold text-bone hover:bg-cobalt-bright disabled:opacity-45"
                >
                  <Save size={11} aria-hidden />
                  {t("pro.saveSliders")}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <SliderRow
                label={t("pro.sliders.topK")}
                hint={t("pro.sliders.topKHint")}
                value={searchDraft.top_k}
                min={1}
                max={30}
                step={1}
                onChange={(v) => setSearchDraft((s) => ({ ...s, top_k: v }))}
              />
              <SliderRow
                label={t("pro.sliders.minSimilarity")}
                hint={t("pro.sliders.minSimilarityHint")}
                value={searchDraft.min_similarity}
                min={0}
                max={0.95}
                step={0.05}
                formatValue={(v) => v.toFixed(2)}
                onChange={(v) => setSearchDraft((s) => ({ ...s, min_similarity: v }))}
              />
              <SliderRow
                label={t("pro.sliders.dedupThreshold")}
                hint={t("pro.sliders.dedupThresholdHint")}
                value={searchDraft.dedup_threshold}
                min={0.5}
                max={0.99}
                step={0.01}
                formatValue={(v) => v.toFixed(2)}
                onChange={(v) => setSearchDraft((s) => ({ ...s, dedup_threshold: v }))}
              />
              <SliderRow
                label={t("pro.sliders.duplicateThreshold")}
                hint={t("pro.sliders.duplicateThresholdHint")}
                value={searchDraft.duplicate_threshold}
                min={0.5}
                max={0.99}
                step={0.01}
                formatValue={(v) => v.toFixed(2)}
                onChange={(v) => setSearchDraft((s) => ({ ...s, duplicate_threshold: v }))}
              />
              <SliderRow
                label={t("pro.sliders.rrfK")}
                hint={t("pro.sliders.rrfKHint")}
                value={searchDraft.rrf.k}
                min={1}
                max={120}
                step={1}
                onChange={(v) =>
                  setSearchDraft((s) => ({ ...s, rrf: { ...s.rrf, k: v } }))
                }
              />
              <SliderRow
                label={t("pro.sliders.vectorWeight")}
                hint={t("pro.sliders.vectorWeightHint")}
                value={searchDraft.rrf.vector_weight}
                min={0}
                max={2}
                step={0.1}
                formatValue={(v) => v.toFixed(1)}
                onChange={(v) =>
                  setSearchDraft((s) => ({ ...s, rrf: { ...s.rrf, vector_weight: v } }))
                }
              />
              <SliderRow
                label={t("pro.sliders.ftsWeight")}
                hint={t("pro.sliders.ftsWeightHint")}
                value={searchDraft.rrf.fts_weight}
                min={0}
                max={2}
                step={0.1}
                formatValue={(v) => v.toFixed(1)}
                onChange={(v) =>
                  setSearchDraft((s) => ({ ...s, rrf: { ...s.rrf, fts_weight: v } }))
                }
              />
              <SliderRow
                label={t("pro.sliders.confidenceWeight")}
                hint={t("pro.sliders.confidenceWeightHint")}
                value={searchDraft.confidence_weight}
                min={0}
                max={1}
                step={0.05}
                formatValue={(v) => v.toFixed(2)}
                onChange={(v) => setSearchDraft((s) => ({ ...s, confidence_weight: v }))}
              />
              <SliderRow
                label={t("pro.sliders.corePinBoost")}
                hint={t("pro.sliders.corePinBoostHint")}
                value={searchDraft.core_pin_boost}
                min={0}
                max={2}
                step={0.1}
                formatValue={(v) => v.toFixed(1)}
                onChange={(v) => setSearchDraft((s) => ({ ...s, core_pin_boost: v }))}
              />
              <SliderRow
                label={t("pro.sliders.responseTokenBudget")}
                hint={t("pro.sliders.responseTokenBudgetHint")}
                value={searchDraft.response_token_budget}
                min={200}
                max={8000}
                step={100}
                formatValue={(v) =>
                  t("pro.sliders.responseTokenBudgetValue", {
                    tokens: formatTokenCount(v, language),
                  })
                }
                onChange={(v) =>
                  setSearchDraft((s) => ({ ...s, response_token_budget: v }))
                }
              />
            </div>
          </div>

          {/* 4. MCP Tool Docstring Editor */}
          <div className="space-y-3 rounded-[2px] border border-rule bg-surface-2 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-cobalt-ink">
                  <FileCode2 size={12} aria-hidden />
                  {t("pro.docstringsTitle")}
                </h3>
                <p className="mt-0.5 text-xs text-bone-muted">{t("pro.docstringsDesc")}</p>
              </div>
              <button
                type="button"
                disabled={saving || loadingDocs}
                onClick={() => void handleSaveDocstrings()}
                className="inline-flex items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-3 py-1 font-mono text-[11px] font-semibold text-bone hover:bg-cobalt-bright disabled:opacity-45"
              >
                <Save size={11} aria-hidden />
                {t("pro.saveDocstrings")}
              </button>
            </div>

            {loadingDocs ? (
              <div className="space-y-3" aria-busy="true" aria-label={t("pro.loadingDocs")}>
                {[0, 1, 2].map((idx) => (
                  <div
                    key={idx}
                    className="space-y-2 rounded-[2px] border border-rule bg-void p-3"
                  >
                    <Skeleton className="h-3.5 w-36" />
                    <Skeleton className="h-14 w-full" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-3">
                {toolDocs.map((doc) => {
                  const currentVal = docDrafts[doc.name] ?? doc.default_description;
                  const isOverridden = currentVal.trim() !== doc.default_description.trim();
                  return (
                    <div
                      key={doc.name}
                      className="space-y-1.5 rounded-[2px] border border-rule bg-void p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs font-semibold text-bone">
                            {doc.name}
                          </span>
                          {isOverridden && (
                            <span className="rounded-[2px] border border-ochre-rule bg-ochre-wash px-1.5 py-0.5 font-mono text-[9px] uppercase text-ochre">
                              {t("pro.customOverride")}
                            </span>
                          )}
                        </div>
                        {isOverridden && (
                          <button
                            type="button"
                            onClick={() =>
                              setDocDrafts((prev) => ({
                                ...prev,
                                [doc.name]: doc.default_description,
                              }))
                            }
                            className="inline-flex items-center gap-1 font-mono text-[10px] text-bone-muted hover:text-bone"
                          >
                            <RotateCcw size={10} aria-hidden />
                            {t("pro.resetDefault")}
                          </button>
                        )}
                      </div>
                      <textarea
                        rows={3}
                        value={currentVal}
                        onChange={(e) =>
                          setDocDrafts((prev) => ({ ...prev, [doc.name]: e.target.value }))
                        }
                        className="w-full rounded-[2px] border border-rule-strong bg-surface p-2 text-xs leading-relaxed text-bone focus:border-cobalt-ink focus:outline-none"
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
