import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  Cpu,
  Download,
  HardDrive,
  Layers,
  Monitor,
  SlidersHorizontal,
} from "lucide-react";
import { SUPPORTED_LANGUAGES } from "@/i18n";
import { isCommandMocked } from "@/lib/backend";
import { estimateDownloadBytes, formatBytes, formatRamGb } from "@/lib/format";
import { useHardwareStore, useSettingsStore, useUiStore } from "@/stores";
import { CobaltMark } from "@/components/shell/CobaltMark";
import { MockBadge } from "@/components/shell/MockBadge";
import { Select, type SelectOption } from "@/components/ui";
import {
  DEFAULT_ENGINE_BY_TIER,
  DEFAULT_MODEL_BY_TIER,
  type EngineKind,
  type HardwareTier,
  type Language,
} from "@/types/contracts";
import { DownloadProgressBar } from "./DownloadProgressBar";
import { HardwareConfigForm } from "./HardwareConfigForm";

export function OnboardingScreen() {
  const { t, i18n } = useTranslation();
  const langLabelId = useId();
  const profile = useHardwareStore((s) => s.profile);
  const models = useHardwareStore((s) => s.models);
  const downloadProgress = useHardwareStore((s) => s.downloadProgress);
  const isInstalling = useHardwareStore((s) => s.isInstalling);
  const isCancelling = useHardwareStore((s) => s.isCancelling);
  const error = useHardwareStore((s) => s.error);
  const installEngine = useHardwareStore((s) => s.installEngine);
  const cancelDownload = useHardwareStore((s) => s.cancelDownload);
  const clearError = useHardwareStore((s) => s.clearError);

  const settings = useSettingsStore((s) => s.settings);
  const patchSettings = useSettingsStore((s) => s.patchSettings);
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  const setShowOnboardingOverride = useUiStore((s) => s.setShowOnboardingOverride);

  const [customizing, setCustomizing] = useState(false);
  const [selectedTier, setSelectedTier] = useState<HardwareTier>("eco");
  const [selectedEngine, setSelectedEngine] = useState<EngineKind>(DEFAULT_ENGINE_BY_TIER.eco);
  const [selectedModelId, setSelectedModelId] = useState<string>(DEFAULT_MODEL_BY_TIER.eco);
  const [proMode, setProMode] = useState(settings.pro_mode);

  useEffect(() => {
    if (!profile) return;
    setSelectedTier(profile.recommendation.tier);
    setSelectedEngine(profile.recommendation.engine);
    setSelectedModelId(profile.recommendation.model_id);
  }, [profile]);

  const languageOptions = useMemo<SelectOption<Language>[]>(
    () =>
      SUPPORTED_LANGUAGES.map((lng) => ({
        value: lng,
        label: t(`languages.${lng}`),
      })),
    [t],
  );

  const currentLanguage = (i18n.resolvedLanguage as Language | undefined) ?? settings.language;
  const isMocked = isCommandMocked("get_hardware_profile") || isCommandMocked("install_engine");

  const recommendedTier = profile?.recommendation.tier ?? "eco";
  const recommendedEngine =
    profile?.recommendation.engine ?? DEFAULT_ENGINE_BY_TIER[recommendedTier];
  const recommendedModel =
    profile?.recommendation.model_id ?? DEFAULT_MODEL_BY_TIER[recommendedTier];

  const activeTier = customizing ? selectedTier : recommendedTier;
  const activeEngine = customizing ? selectedEngine : recommendedEngine;
  const activeModel = customizing ? selectedModelId : recommendedModel;
  const exactDownloadBytes = estimateDownloadBytes(activeEngine, activeModel, models, profile);

  const reasonKey = profile?.recommendation.reason_key ?? "onboarding.reason.default";
  const translatedReason = t(reasonKey, {
    defaultValue: t("onboarding.reason.default"),
  });

  const handleInstall = async (
    tierToInstall: HardwareTier,
    engineToInstall: EngineKind,
    modelToInstall: string,
  ) => {
    clearError();
    const result = await installEngine({
      engine: engineToInstall,
      model_id: modelToInstall,
    });
    if (result) {
      await patchSettings({
        onboarding_completed: true,
        hardware_tier: tierToInstall,
        vector_engine: engineToInstall,
        embedding_model_id: modelToInstall,
        pro_mode: proMode,
      });
      setShowOnboardingOverride(false);
    }
  };

  const primaryGpu = profile?.gpus[0] ?? null;

  return (
    <div className="cobalt-grid-bg flex min-h-full w-full items-center justify-center overflow-y-auto px-4 py-8 sm:px-8">
      <div className="w-full max-w-4xl border border-rule-strong bg-surface">
        {/* Top signature cobalt rule */}
        <div className="h-[2px] w-full bg-cobalt" aria-hidden />

        {/* Masthead */}
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-rule px-6 py-4">
          <div className="flex items-center gap-3">
            <CobaltMark size={22} />
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-display text-base font-semibold tracking-tight text-bone">
                {t("app.name")}
              </span>
              <span className="font-mono text-[10px] text-bone-subtle">/</span>
              <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-cobalt-ink">
                {t("onboarding.badge")}
              </span>
              {isMocked && <MockBadge />}
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <span
              id={langLabelId}
              className="font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle"
            >
              {t("shell.language")}
            </span>
            <Select<Language>
              value={currentLanguage}
              options={languageOptions}
              disabled={isInstalling}
              size="sm"
              align="right"
              ariaLabelledBy={langLabelId}
              className="w-36"
              onChange={(nextLang) => void setLanguage(nextLang)}
            />
          </div>
        </header>

        {/* Editorial title & detected hardware spec sheet */}
        <section className="border-b border-rule px-6 py-6">
          <h1 className="font-display text-2xl font-medium tracking-tight text-bone sm:text-3xl">
            {t("onboarding.title")}
          </h1>

          {profile && (
            <>
              <p className="mt-3 max-w-2xl text-sm leading-relaxed text-bone sm:text-base">
                {t("onboarding.headline", {
                  ram: formatRamGb(profile.total_ram_bytes),
                  cores: profile.logical_cores,
                  tier: t(`tiers.${recommendedTier}`),
                })}
              </p>
              <p className="mt-1.5 max-w-2xl text-xs leading-relaxed text-bone-muted sm:text-sm">
                {translatedReason}
              </p>

              {/* Hairline-divided hardware spec strip */}
              <div className="mt-6">
                <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-bone-subtle">
                  01 — {t("onboarding.detectedHardware")}
                </div>
                <div className="grid grid-cols-1 divide-y divide-rule border border-rule bg-void sm:grid-cols-3 sm:divide-x sm:divide-y-0">
                  <div className="p-3.5">
                    <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
                      <Cpu size={12} className="text-cobalt-ink" aria-hidden />
                      {t("onboarding.cpu")}
                    </div>
                    <div className="mt-1.5 truncate text-xs font-medium text-bone">
                      {profile.cpu_brand}
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] tabular-nums text-bone-muted">
                      {profile.physical_cores !== null
                        ? t("onboarding.coresWithPhysical", {
                            physical: profile.physical_cores,
                            logical: profile.logical_cores,
                          })
                        : t("onboarding.cores", { count: profile.logical_cores })}
                    </div>
                  </div>

                  <div className="p-3.5">
                    <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
                      <HardDrive size={12} className="text-cobalt-ink" aria-hidden />
                      {t("onboarding.ram")}
                    </div>
                    <div className="mt-1.5 font-mono text-xs font-medium tabular-nums text-bone">
                      {formatRamGb(profile.total_ram_bytes)} GB
                    </div>
                    <div className="mt-0.5 text-[11px] tabular-nums text-bone-muted">
                      {t("onboarding.ramAvailable", {
                        available: formatRamGb(profile.available_ram_bytes),
                        total: formatRamGb(profile.total_ram_bytes),
                      })}
                    </div>
                  </div>

                  <div className="p-3.5">
                    <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
                      <Monitor size={12} className="text-cobalt-ink" aria-hidden />
                      {t("onboarding.gpu")}
                    </div>
                    <div className="mt-1.5 truncate text-xs font-medium text-bone">
                      {primaryGpu ? primaryGpu.name : t("onboarding.noGpu")}
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-bone-muted">
                      {profile.os} / {profile.arch}
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </section>

        {/* Recommended stack ledger OR custom configuration */}
        <section className="border-b border-rule px-6 py-5">
          {!customizing ? (
            <div>
              <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-bone-subtle">
                02 — {t("onboarding.recommendedStack")}
              </div>
              <div className="grid grid-cols-1 divide-y divide-rule border border-rule bg-void sm:grid-cols-4 sm:divide-x sm:divide-y-0">
                <div className="p-3.5">
                  <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
                    {t("onboarding.tier")}
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5 text-sm font-semibold text-cobalt-ink">
                    <Layers size={14} aria-hidden />
                    {t(`tiers.${recommendedTier}`)}
                  </div>
                </div>
                <div className="p-3.5">
                  <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
                    {t("onboarding.engine")}
                  </div>
                  <div className="mt-1.5 text-sm font-medium text-bone">
                    {t(`engines.${recommendedEngine}`)}
                  </div>
                </div>
                <div className="p-3.5">
                  <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
                    {t("onboarding.model")}
                  </div>
                  <div className="mt-1.5 truncate font-mono text-xs font-medium text-bone">
                    {recommendedModel}
                  </div>
                </div>
                <div className="p-3.5">
                  <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
                    {t("onboarding.downloadSize")}
                  </div>
                  <div className="mt-1.5 font-mono text-sm font-semibold tabular-nums text-verdigris">
                    {formatBytes(exactDownloadBytes)}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <HardwareConfigForm
              tier={selectedTier}
              engine={selectedEngine}
              modelId={selectedModelId}
              proMode={proMode}
              models={models}
              profile={profile}
              disabled={isInstalling}
              onTierChange={setSelectedTier}
              onEngineChange={setSelectedEngine}
              onModelChange={setSelectedModelId}
              onProModeChange={setProMode}
            />
          )}
        </section>

        {/* Live download progress */}
        {(downloadProgress || isInstalling || error) && (
          <div className="border-b border-rule bg-void px-6 py-4">
            <DownloadProgressBar
              progress={downloadProgress}
              isInstalling={isInstalling}
              isCancelling={isCancelling}
              error={error}
              onCancel={() => void cancelDownload()}
            />
          </div>
        )}

        {/* Primary action footer */}
        <footer className="flex flex-wrap items-center justify-between gap-3 bg-surface-2 px-6 py-4">
          <button
            type="button"
            disabled={isInstalling}
            onClick={() => setCustomizing((v) => !v)}
            className="inline-flex items-center gap-2 rounded-[2px] border border-rule-strong bg-surface px-4 py-2 text-xs font-medium text-bone transition-colors hover:border-cobalt-ink/60 hover:bg-surface-3 focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none disabled:opacity-45"
          >
            <SlidersHorizontal size={14} aria-hidden />
            {customizing ? t("onboarding.hideCustomize") : t("onboarding.customize")}
          </button>

          <button
            type="button"
            disabled={isInstalling || !profile}
            onClick={() => void handleInstall(activeTier, activeEngine, activeModel)}
            className="inline-flex items-center gap-2 rounded-[2px] border border-cobalt-rule bg-cobalt px-5 py-2 text-xs font-semibold tracking-wide text-bone transition-colors hover:bg-cobalt-bright focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none disabled:opacity-45"
          >
            {isInstalling ? (
              <>
                <Download size={14} aria-hidden />
                {t("onboarding.installing")}
              </>
            ) : error ? (
              <>
                <Download size={14} aria-hidden />
                {t("onboarding.retry")}
              </>
            ) : customizing ? (
              <>
                <Check size={14} aria-hidden />
                <span>{t("onboarding.installCustom")}</span>
                <span className="font-mono tabular-nums opacity-85">
                  ({formatBytes(exactDownloadBytes)})
                </span>
              </>
            ) : (
              <>
                <Download size={14} aria-hidden />
                <span>{t("onboarding.acceptAndInstall")}</span>
                <span className="font-mono tabular-nums opacity-85">
                  ({formatBytes(exactDownloadBytes)})
                </span>
              </>
            )}
          </button>
        </footer>
      </div>
    </div>
  );
}
