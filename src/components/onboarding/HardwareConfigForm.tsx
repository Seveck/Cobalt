import { useTranslation } from "react-i18next";
import { Check, Cpu, Database, HardDrive, Sparkles } from "lucide-react";
import { estimateDownloadBytes, formatBytes } from "@/lib/format";
import {
  DEFAULT_ENGINE_BY_TIER,
  DEFAULT_MODEL_BY_TIER,
  HARDWARE_TIERS,
  PRO_ENGLISH_MODELS,
  type EmbeddingModelSpec,
  type EngineKind,
  type HardwareProfile,
  type HardwareTier,
} from "@/types/contracts";

const STANDARD_ENGINES: readonly EngineKind[] = ["sqlite_vec", "usearch", "qdrant_sidecar"];
const PRO_ENGINES: readonly EngineKind[] = ["lance_db", "qdrant_remote", "chroma_db"];

interface HardwareConfigFormProps {
  tier: HardwareTier;
  engine: EngineKind;
  modelId: string;
  proMode: boolean;
  models: readonly EmbeddingModelSpec[];
  profile: HardwareProfile | null;
  disabled?: boolean;
  onTierChange: (tier: HardwareTier) => void;
  onEngineChange: (engine: EngineKind) => void;
  onModelChange: (modelId: string) => void;
  onProModeChange: (proMode: boolean) => void;
}

export function HardwareConfigForm({
  tier,
  engine,
  modelId,
  proMode,
  models,
  profile,
  disabled = false,
  onTierChange,
  onEngineChange,
  onModelChange,
  onProModeChange,
}: HardwareConfigFormProps) {
  const { t } = useTranslation();

  const availableEngines: readonly EngineKind[] = proMode
    ? [...STANDARD_ENGINES, ...PRO_ENGINES]
    : STANDARD_ENGINES;

  const proEnglishSet = new Set<string>(PRO_ENGLISH_MODELS);
  const availableModels = models.filter((model) => {
    if (proMode) return true;
    return model.multilingual && !proEnglishSet.has(model.id);
  });

  const downloadBytes = estimateDownloadBytes(engine, modelId, models, profile);
  const recommendedTier = profile?.recommendation.tier ?? null;

  const handleSelectTier = (nextTier: HardwareTier) => {
    onTierChange(nextTier);
    onEngineChange(DEFAULT_ENGINE_BY_TIER[nextTier]);
    onModelChange(DEFAULT_MODEL_BY_TIER[nextTier]);
  };

  const handleToggleProMode = (checked: boolean) => {
    onProModeChange(checked);
    if (!checked) {
      if (PRO_ENGINES.includes(engine)) {
        onEngineChange(DEFAULT_ENGINE_BY_TIER[tier]);
      }
      if (proEnglishSet.has(modelId)) {
        onModelChange(DEFAULT_MODEL_BY_TIER[tier]);
      }
    }
  };

  return (
    <div className="space-y-5">
      {/* Tier selector */}
      <div>
        <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-slate-400">
          <Cpu size={14} aria-hidden />
          {t("onboarding.tier")}
        </div>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          {HARDWARE_TIERS.map((option) => {
            const active = tier === option;
            const isRecommended = recommendedTier === option;
            return (
              <button
                key={option}
                type="button"
                disabled={disabled}
                onClick={() => handleSelectTier(option)}
                className={`flex flex-col items-start rounded-xl border p-3.5 text-left transition ${
                  active
                    ? "border-cobalt-500 bg-cobalt-600/20 shadow-[0_0_0_1px_rgba(47,107,255,0.35)]"
                    : "border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04]"
                } disabled:cursor-not-allowed disabled:opacity-50`}
              >
                <div className="flex w-full items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-100">
                    {t(`tiers.${option}`)}
                  </span>
                  {isRecommended && (
                    <span className="rounded-full bg-cobalt-500/25 px-2 py-0.5 text-[10px] font-medium text-cobalt-300">
                      {t("onboarding.recommendedBadge")}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-slate-400">
                  {t(`tiers.${option}Desc`)}
                </p>
                <div className="mt-2 font-mono text-[11px] text-slate-500">
                  {DEFAULT_ENGINE_BY_TIER[option]} · {DEFAULT_MODEL_BY_TIER[option]}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Vector engine & Embedding model */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-slate-400">
            <Database size={14} aria-hidden />
            {t("onboarding.engine")}
          </span>
          <select
            disabled={disabled}
            value={engine}
            onChange={(e) => onEngineChange(e.target.value as EngineKind)}
            className="rounded-lg border border-white/10 bg-void px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-cobalt-500 disabled:opacity-50"
          >
            {availableEngines.map((eng) => (
              <option key={eng} value={eng}>
                {t(`engines.${eng}`)}
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-col gap-1.5">
          <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-slate-400">
            <HardDrive size={14} aria-hidden />
            {t("onboarding.downloadSize")}
          </span>
          <div className="flex h-[42px] items-center justify-between rounded-lg border border-white/10 bg-white/[0.03] px-3">
            <span className="font-mono text-sm font-semibold text-cobalt-300">
              {formatBytes(downloadBytes)}
            </span>
            <span className="text-xs text-slate-500">{modelId}</span>
          </div>
        </div>
      </div>

      {/* Model list */}
      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-slate-400">
            <Sparkles size={14} aria-hidden />
            {t("onboarding.model")}
          </span>
          <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-slate-300">
            <input
              type="checkbox"
              disabled={disabled}
              checked={proMode}
              onChange={(e) => handleToggleProMode(e.target.checked)}
              className="h-3.5 w-3.5 accent-cobalt-500"
            />
            {t("onboarding.proModeLabel")}
          </label>
        </div>

        <p className="mb-2.5 text-xs text-slate-500">{t("onboarding.proModeHint")}</p>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {availableModels.map((model) => {
            const selected = model.id === modelId;
            return (
              <button
                key={model.id}
                type="button"
                disabled={disabled}
                onClick={() => onModelChange(model.id)}
                className={`flex items-start justify-between gap-3 rounded-xl border p-3 text-left transition ${
                  selected
                    ? "border-cobalt-500 bg-cobalt-600/20"
                    : "border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04]"
                } disabled:cursor-not-allowed disabled:opacity-50`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-slate-100">
                      {model.display_name}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                    <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono">
                      {t("onboarding.dims", { dims: model.dimensions })}
                    </span>
                    <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono uppercase">
                      {model.quantization}
                    </span>
                    <span
                      className={`rounded px-1.5 py-0.5 font-medium ${
                        model.multilingual
                          ? "bg-emerald-500/15 text-emerald-300"
                          : "bg-amber-500/15 text-amber-300"
                      }`}
                    >
                      {model.multilingual
                        ? t("onboarding.multilingualBadge")
                        : t("onboarding.englishOnlyBadge")}
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className="font-mono text-xs text-slate-300">
                    {formatBytes(model.size_bytes)}
                  </span>
                  {selected && <Check size={14} className="text-cobalt-300" aria-hidden />}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
