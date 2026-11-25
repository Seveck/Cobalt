import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Brain,
  Check,
  Cpu,
  Download,
  HardDrive,
  Monitor,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import { SUPPORTED_LANGUAGES } from "@/i18n";
import { isCommandMocked } from "@/lib/backend";
import { estimateDownloadBytes, formatBytes, formatRamGb } from "@/lib/format";
import { useHardwareStore, useSettingsStore, useUiStore } from "@/stores";
import { MockBadge } from "@/components/shell/MockBadge";
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
    <div className="flex min-h-full w-full items-center justify-center overflow-y-auto bg-void px-4 py-8">
      <div className="w-full max-w-3xl space-y-6 rounded-2xl border border-white/10 bg-cobalt-900/35 p-6 shadow-2xl backdrop-blur-md sm:p-8">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-cobalt-500/40 bg-cobalt-600/25 text-cobalt-300">
              <Brain size={22} aria-hidden />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-cobalt-300">
                  {t("onboarding.badge")}
                </span>
                {isMocked && <MockBadge />}
              </div>
              <h1 className="text-xl font-semibold text-slate-100">{t("onboarding.title")}</h1>
            </div>
          </div>

          <label className="flex items-center gap-2 text-xs text-slate-400">
            <span>{t("shell.language")}</span>
            <select
              disabled={isInstalling}
              value={(i18n.resolvedLanguage as Language | undefined) ?? settings.language}
              onChange={(e) => void setLanguage(e.target.value as Language)}
              className="rounded-md border border-white/10 bg-void px-2 py-1 text-xs font-medium text-slate-200 outline-none focus:border-cobalt-500"
            >
              {SUPPORTED_LANGUAGES.map((lng) => (
                <option key={lng} value={lng}>
                  {lng.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* Detected hardware headline */}
        {profile && (
          <div className="rounded-xl border border-cobalt-500/30 bg-gradient-to-br from-cobalt-600/20 via-cobalt-900/40 to-transparent p-5">
            <p className="text-base font-medium leading-relaxed text-slate-100 sm:text-lg">
              {t("onboarding.headline", {
                ram: formatRamGb(profile.total_ram_bytes),
                cores: profile.logical_cores,
                tier: t(`tiers.${recommendedTier}`),
              })}
            </p>
            <p className="mt-1.5 text-sm text-slate-300">{translatedReason}</p>

            {/* Hardware summary chips */}
            <div className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
              <div className="rounded-lg border border-white/10 bg-void/60 p-3">
                <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-slate-400">
                  <Cpu size={13} aria-hidden />
                  {t("onboarding.cpu")}
                </div>
                <div className="mt-1 truncate text-xs font-medium text-slate-100">
                  {profile.cpu_brand}
                </div>
                <div className="mt-0.5 text-[11px] text-slate-400">
                  {profile.physical_cores !== null
                    ? t("onboarding.coresWithPhysical", {
                        physical: profile.physical_cores,
                        logical: profile.logical_cores,
                      })
                    : t("onboarding.cores", { count: profile.logical_cores })}
                </div>
              </div>

              <div className="rounded-lg border border-white/10 bg-void/60 p-3">
                <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-slate-400">
                  <HardDrive size={13} aria-hidden />
                  {t("onboarding.ram")}
                </div>
                <div className="mt-1 font-mono text-xs font-medium text-slate-100">
                  {formatRamGb(profile.total_ram_bytes)} GB
                </div>
                <div className="mt-0.5 text-[11px] text-slate-400">
                  {t("onboarding.ramAvailable", {
                    available: formatRamGb(profile.available_ram_bytes),
                    total: formatRamGb(profile.total_ram_bytes),
                  })}
                </div>
              </div>

              <div className="rounded-lg border border-white/10 bg-void/60 p-3">
                <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-slate-400">
                  <Monitor size={13} aria-hidden />
                  {t("onboarding.gpu")}
                </div>
                <div className="mt-1 truncate text-xs font-medium text-slate-100">
                  {primaryGpu ? primaryGpu.name : t("onboarding.noGpu")}
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-slate-400">
                  {profile.os} / {profile.arch}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Recommended stack summary */}
        {!customizing && (
          <div className="grid grid-cols-1 gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:grid-cols-4">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-slate-400">
                {t("onboarding.tier")}
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-sm font-semibold text-cobalt-300">
                <Sparkles size={14} aria-hidden />
                {t(`tiers.${recommendedTier}`)}
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-slate-400">
                {t("onboarding.engine")}
              </div>
              <div className="mt-1 text-sm font-medium text-slate-100">
                {t(`engines.${recommendedEngine}`)}
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-slate-400">
                {t("onboarding.model")}
              </div>
              <div className="mt-1 truncate font-mono text-xs font-medium text-slate-100">
                {recommendedModel}
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-slate-400">
                {t("onboarding.downloadSize")}
              </div>
              <div className="mt-1 font-mono text-sm font-semibold text-emerald-300">
                {formatBytes(exactDownloadBytes)}
              </div>
            </div>
          </div>
        )}

        {/* Optional customization form */}
        {customizing && (
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:p-5">
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
          </div>
        )}

        {/* Live download progress bar */}
        <DownloadProgressBar
          progress={downloadProgress}
          isInstalling={isInstalling}
          isCancelling={isCancelling}
          error={error}
          onCancel={() => void cancelDownload()}
        />

        {/* Primary actions */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <button
            type="button"
            disabled={isInstalling}
            onClick={() => setCustomizing((v) => !v)}
            className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-medium text-slate-200 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <SlidersHorizontal size={15} aria-hidden />
            {customizing ? t("onboarding.hideCustomize") : t("onboarding.customize")}
          </button>

          <button
            type="button"
            disabled={isInstalling || !profile}
            onClick={() => void handleInstall(activeTier, activeEngine, activeModel)}
            className="inline-flex items-center gap-2 rounded-xl bg-cobalt-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-cobalt-600/25 transition hover:bg-cobalt-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isInstalling ? (
              <>
                <Download size={15} className="animate-bounce" aria-hidden />
                {t("onboarding.installing")}
              </>
            ) : error ? (
              <>
                <Download size={15} aria-hidden />
                {t("onboarding.retry")}
              </>
            ) : customizing ? (
              <>
                <Check size={15} aria-hidden />
                {t("onboarding.installCustom")} ({formatBytes(exactDownloadBytes)})
              </>
            ) : (
              <>
                <Download size={15} aria-hidden />
                {t("onboarding.acceptAndInstall")} ({formatBytes(exactDownloadBytes)})
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
