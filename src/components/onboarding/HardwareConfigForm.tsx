import { useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Check, Cpu, Database, HardDrive, Layers } from "lucide-react";
import { estimateDownloadBytes, formatBytes } from "@/lib/format";
import { Select, Toggle, type SelectOption } from "@/components/ui";
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
  const engineLabelId = useId();
  const proModeLabelId = useId();

  const availableEngines: readonly EngineKind[] = proMode
    ? [...STANDARD_ENGINES, ...PRO_ENGINES]
    : STANDARD_ENGINES;

  const engineOptions = useMemo<SelectOption<EngineKind>[]>(
    () =>
      availableEngines.map((eng) => ({
        value: eng,
        label: t(`engines.${eng}`),
      })),
    [availableEngines, t],
  );

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
    <div className="space-y-6">
      {/* Tier selector */}
      <div>
        <div className="mb-2.5 flex items-center gap-2 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-bone-subtle">
          <Cpu size={13} className="text-cobalt-ink" aria-hidden />
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
                aria-pressed={active}
                onClick={() => handleSelectTier(option)}
                className={`relative flex flex-col items-start rounded-[2px] border p-3.5 text-left transition-colors focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none disabled:opacity-45 ${
                  active
                    ? "border-cobalt-rule border-t-2 border-t-cobalt bg-cobalt-wash text-bone"
                    : "border-rule bg-void text-bone hover:border-rule-strong hover:bg-surface-2"
                }`}
              >
                <div className="flex w-full items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-bone">
                    {t(`tiers.${option}`)}
                  </span>
                  {isRecommended && (
                    <span className="rounded-[2px] border border-ochre-rule bg-ochre-wash px-1.5 py-0.5 font-mono text-[9px] font-medium uppercase tracking-[0.1em] text-ochre">
                      {t("onboarding.recommendedBadge")}
                    </span>
                  )}
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-bone-muted">
                  {t(`tiers.${option}Desc`)}
                </p>
                <div className="mt-2.5 border-t border-rule/80 pt-2 font-mono text-[10px] text-bone-subtle">
                  {DEFAULT_ENGINE_BY_TIER[option]} · {DEFAULT_MODEL_BY_TIER[option]}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Vector engine & Download size */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <span
            id={engineLabelId}
            className="flex items-center gap-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-bone-subtle"
          >
            <Database size={13} className="text-cobalt-ink" aria-hidden />
            {t("onboarding.engine")}
          </span>
          <Select<EngineKind>
            value={engine}
            options={engineOptions}
            disabled={disabled}
            ariaLabelledBy={engineLabelId}
            className="w-full"
            onChange={(nextEngine) => onEngineChange(nextEngine)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="flex items-center gap-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-bone-subtle">
            <HardDrive size={13} className="text-cobalt-ink" aria-hidden />
            {t("onboarding.downloadSize")}
          </span>
          <div className="flex h-10 items-center justify-between gap-2 rounded-[2px] border border-rule bg-void px-3">
            <span className="font-mono text-sm font-semibold tabular-nums text-verdigris">
              {formatBytes(downloadBytes)}
            </span>
            <span className="truncate font-mono text-[11px] text-bone-subtle">{modelId}</span>
          </div>
        </div>
      </div>

      {/* Embedding model catalog */}
      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-bone-subtle">
            <Layers size={13} className="text-cobalt-ink" aria-hidden />
            {t("onboarding.model")}
          </span>
          <div className="inline-flex items-center gap-2.5 text-xs text-bone-muted">
            <span id={proModeLabelId}>{t("onboarding.proModeLabel")}</span>
            <Toggle
              checked={proMode}
              disabled={disabled}
              ariaLabelledBy={proModeLabelId}
              onChange={handleToggleProMode}
            />
          </div>
        </div>

        <p className="mb-3 text-xs text-bone-subtle">{t("onboarding.proModeHint")}</p>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {availableModels.map((model) => {
            const selected = model.id === modelId;
            return (
              <button
                key={model.id}
                type="button"
                disabled={disabled}
                aria-pressed={selected}
                onClick={() => onModelChange(model.id)}
                className={`flex items-start justify-between gap-3 rounded-[2px] border p-3 text-left transition-colors focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none disabled:opacity-45 ${
                  selected
                    ? "border-cobalt-rule border-l-2 border-l-cobalt bg-cobalt-wash text-bone"
                    : "border-rule bg-void text-bone hover:border-rule-strong hover:bg-surface-2"
                }`}
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-bone">
                    {model.display_name}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 font-mono text-[10px]">
                    <span className="rounded-[2px] border border-rule bg-surface-2 px-1.5 py-0.5 text-bone-muted">
                      {t("onboarding.dims", { dims: model.dimensions })}
                    </span>
                    <span className="rounded-[2px] border border-rule bg-surface-2 px-1.5 py-0.5 uppercase text-bone-muted">
                      {model.quantization}
                    </span>
                    <span
                      className={`rounded-[2px] border px-1.5 py-0.5 font-medium ${
                        model.multilingual
                          ? "border-verdigris-rule bg-verdigris-wash text-verdigris"
                          : "border-ochre-rule bg-ochre-wash text-ochre"
                      }`}
                    >
                      {model.multilingual
                        ? t("onboarding.multilingualBadge")
                        : t("onboarding.englishOnlyBadge")}
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className="font-mono text-xs tabular-nums text-bone-muted">
                    {formatBytes(model.size_bytes)}
                  </span>
                  {selected && <Check size={14} className="text-cobalt-ink" aria-hidden />}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
