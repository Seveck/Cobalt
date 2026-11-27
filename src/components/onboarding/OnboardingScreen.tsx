import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  ArrowRight,
  ArrowRightLeft,
  Check,
  Cpu,
  Download,
  HardDrive,
  Layers,
  Loader2,
  Monitor,
  SlidersHorizontal,
  User,
} from "lucide-react";
import { SUPPORTED_LANGUAGES } from "@/i18n";
import { backendCall } from "@/lib/backend";
import {
  estimateDownloadBytes,
  extractFirstName,
  formatBytes,
  formatRamGb,
  isEngineModelInstalled,
} from "@/lib/format";
import { useHardwareStore, useMemoryStore, useSettingsStore, useUiStore } from "@/stores";
import { CobaltMark } from "@/components/shell/CobaltMark";
import { Select, type SelectOption } from "@/components/ui";
import {
  DEFAULT_ENGINE_BY_TIER,
  DEFAULT_MODEL_BY_TIER,
  type AppSettings,
  type EngineKind,
  type HardwareTier,
  type Language,
} from "@/types/contracts";
import { DownloadProgressBar } from "./DownloadProgressBar";
import { HardwareConfigForm } from "./HardwareConfigForm";

type OnboardingStep = "name" | "hardware";

export function OnboardingScreen() {
  const { t, i18n } = useTranslation();
  const langLabelId = useId();
  const nameInputId = useId();
  const profile = useHardwareStore((s) => s.profile);
  const models = useHardwareStore((s) => s.models);
  const engineStatus = useHardwareStore((s) => s.engineStatus);
  const downloadProgress = useHardwareStore((s) => s.downloadProgress);
  const isInstalling = useHardwareStore((s) => s.isInstalling);
  const isCancelling = useHardwareStore((s) => s.isCancelling);
  const swapProgress = useHardwareStore((s) => s.swapProgress);
  const isSwapping = useHardwareStore((s) => s.isSwapping);
  const error = useHardwareStore((s) => s.error);
  const loadProfile = useHardwareStore((s) => s.loadProfile);
  const loadEngineStatus = useHardwareStore((s) => s.loadEngineStatus);
  const installEngine = useHardwareStore((s) => s.installEngine);
  const cancelDownload = useHardwareStore((s) => s.cancelDownload);
  const swapEngine = useHardwareStore((s) => s.swapEngine);
  const setDownloadProgress = useHardwareStore((s) => s.setDownloadProgress);
  const setSwapProgress = useHardwareStore((s) => s.setSwapProgress);
  const clearError = useHardwareStore((s) => s.clearError);

  const settings = useSettingsStore((s) => s.settings);
  const saving = useSettingsStore((s) => s.saving);
  const settingsError = useSettingsStore((s) => s.error);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const patchSettings = useSettingsStore((s) => s.patchSettings);
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  const clearSettingsError = useSettingsStore((s) => s.clearError);
  const loadGraph = useMemoryStore((s) => s.loadGraph);

  const showOnboardingOverride = useUiStore((s) => s.showOnboardingOverride);
  const setActiveNav = useUiStore((s) => s.setActiveNav);
  const setShowOnboardingOverride = useUiStore((s) => s.setShowOnboardingOverride);

  const canGoBack = settings.onboarding_completed && showOnboardingOverride;

  const [step, setStep] = useState<OnboardingStep>("name");
  const [displayName, setDisplayName] = useState<string>(settings.user_display_name ?? "");
  const nameEditedRef = useRef(false);

  const [customizing, setCustomizing] = useState(false);
  const [selectedTier, setSelectedTier] = useState<HardwareTier>(
    () => profile?.recommendation.tier ?? settings.hardware_tier,
  );
  const [selectedEngine, setSelectedEngine] = useState<EngineKind>(
    () => profile?.recommendation.engine ?? settings.vector_engine,
  );
  const [selectedModelId, setSelectedModelId] = useState<string>(
    () => profile?.recommendation.model_id ?? settings.embedding_model_id,
  );
  const [proMode, setProMode] = useState(settings.pro_mode);
  const selectionSyncedRef = useRef(profile !== null);

  useEffect(() => {
    const savedName = settings.user_display_name?.trim() ?? "";
    if (savedName.length > 0) {
      if (!nameEditedRef.current) {
        setDisplayName(savedName);
      }
      return;
    }
    let cancelled = false;
    void backendCall("get_system_user_name")
      .then((sysName) => {
        if (cancelled || nameEditedRef.current) return;
        const trimmed = sysName?.trim() ?? "";
        if (trimmed.length > 0) {
          setDisplayName(trimmed);
        }
      })
      .catch(() => {
        // Optional OS account lookup; silently ignore failures.
      });
    return () => {
      cancelled = true;
    };
  }, [settings.user_display_name]);

  useEffect(() => {
    if (!profile || selectionSyncedRef.current) return;
    selectionSyncedRef.current = true;
    setSelectedTier(profile.recommendation.tier);
    setSelectedEngine(profile.recommendation.engine);
    setSelectedModelId(profile.recommendation.model_id);
  }, [profile]);

  const busy = isInstalling || isSwapping || saving;
  const displayError = error ?? settingsError;

  useEffect(() => {
    if (!canGoBack) return;
    const hwState = useHardwareStore.getState();
    if (hwState.isInstalling || hwState.isSwapping) return;
    clearError();
    clearSettingsError();
    if (
      hwState.downloadProgress?.phase === "completed" ||
      hwState.downloadProgress?.phase === "cancelled"
    ) {
      setDownloadProgress(null);
    }
    if (
      hwState.swapProgress?.phase === "completed" ||
      hwState.swapProgress?.phase === "rolled_back" ||
      hwState.swapProgress?.phase === "failed"
    ) {
      setSwapProgress(null);
    }
    void loadEngineStatus();
    void loadProfile();
  }, [
    canGoBack,
    clearError,
    clearSettingsError,
    loadEngineStatus,
    loadProfile,
    setDownloadProgress,
    setSwapProgress,
  ]);

  const handleBack = useCallback(() => {
    if (!canGoBack || busy) return;
    clearError();
    clearSettingsError();
    setActiveNav("settings");
    setShowOnboardingOverride(false);
  }, [busy, canGoBack, clearError, clearSettingsError, setActiveNav, setShowOnboardingOverride]);

  useEffect(() => {
    if (!canGoBack) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (busy) return;
      event.preventDefault();
      handleBack();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, canGoBack, handleBack]);

  const languageOptions = useMemo<SelectOption<Language>[]>(
    () =>
      SUPPORTED_LANGUAGES.map((lng) => ({
        value: lng,
        label: t(`languages.${lng}`),
      })),
    [t],
  );

  const currentLanguage = (i18n.resolvedLanguage as Language | undefined) ?? settings.language;

  const recommendedTier = profile?.recommendation.tier ?? "eco";
  const recommendedEngine =
    profile?.recommendation.engine ?? DEFAULT_ENGINE_BY_TIER[recommendedTier];
  const recommendedModel =
    profile?.recommendation.model_id ?? DEFAULT_MODEL_BY_TIER[recommendedTier];

  const activeTier = customizing ? selectedTier : recommendedTier;
  const activeEngine = customizing ? selectedEngine : recommendedEngine;
  const activeModel = customizing ? selectedModelId : recommendedModel;
  const isAlreadyInstalled = isEngineModelInstalled(
    activeEngine,
    activeModel,
    engineStatus,
    profile,
  );
  const exactDownloadBytes = estimateDownloadBytes(
    activeEngine,
    activeModel,
    models,
    profile,
    engineStatus,
  );
  const needsLiveSwap =
    Boolean(engineStatus && engineStatus.vector_count > 0) &&
    (activeEngine !== settings.vector_engine || activeModel !== settings.embedding_model_id);
  const swapPercent =
    swapProgress && swapProgress.total > 0
      ? Math.min(100, Math.round((swapProgress.processed / swapProgress.total) * 100))
      : 0;

  const reasonKey = profile?.recommendation.reason_key ?? "onboarding.reason.default";
  const translatedReason = t(reasonKey, {
    defaultValue: t("onboarding.reason.default"),
  });

  const normalizedDisplayName = displayName.trim() || null;
  const firstNamePreview = extractFirstName(normalizedDisplayName);

  const handleNameStepSubmit = (e: FormEvent) => {
    e.preventDefault();
    setStep("hardware");
  };

  const handleSkipName = () => {
    nameEditedRef.current = true;
    setDisplayName("");
    setStep("hardware");
  };

  const handlePrimaryAction = async (
    tierToApply: HardwareTier,
    engineToApply: EngineKind,
    modelToApply: string,
  ) => {
    clearError();
    clearSettingsError();

    const engineOrModelChanged =
      engineToApply !== settings.vector_engine || modelToApply !== settings.embedding_model_id;
    const needsSwap =
      Boolean(engineStatus && engineStatus.vector_count > 0) && engineOrModelChanged;
    const targetInstalled = isEngineModelInstalled(
      engineToApply,
      modelToApply,
      engineStatus,
      profile,
    );

    if (needsSwap) {
      if (!targetInstalled) {
        const installed = await installEngine({
          engine: engineToApply,
          model_id: modelToApply,
        });
        if (!installed) {
          return;
        }
      }

      const report = await swapEngine({
        target_engine: engineToApply,
        target_model_id: modelToApply,
        external_endpoint: null,
      });
      if (!report || report.rolled_back) {
        return;
      }

      await loadSettings();
      await patchSettings({
        onboarding_completed: true,
        user_display_name: normalizedDisplayName,
        hardware_tier: tierToApply,
        pro_mode: proMode,
      });
      if (useSettingsStore.getState().error) {
        return;
      }
      await loadGraph();
      setShowOnboardingOverride(false);
      return;
    }

    if (!targetInstalled) {
      const result = await installEngine({
        engine: engineToApply,
        model_id: modelToApply,
      });
      if (!result) {
        return;
      }
    }

    const patch: Partial<AppSettings> = {
      onboarding_completed: true,
      user_display_name: normalizedDisplayName,
      hardware_tier: tierToApply,
      pro_mode: proMode,
    };
    if (engineOrModelChanged) {
      patch.vector_engine = engineToApply;
      patch.embedding_model_id = modelToApply;
    }

    await patchSettings(patch);
    if (useSettingsStore.getState().error) {
      return;
    }
    setShowOnboardingOverride(false);
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
            {canGoBack && (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleBack}
                  className="inline-flex items-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-bone transition-colors hover:border-cobalt-ink/60 hover:bg-surface-3 focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none disabled:opacity-45"
                >
                  <ArrowLeft size={13} aria-hidden />
                  <span>{t("onboarding.back")}</span>
                  <kbd className="hidden rounded-[2px] border border-rule bg-void px-1 py-0.5 font-mono text-[9px] uppercase tracking-wider text-bone-subtle sm:inline">
                    Esc
                  </kbd>
                </button>
                <span className="h-4 w-px bg-rule" aria-hidden />
              </>
            )}
            <CobaltMark size={22} />
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-display text-base font-semibold tracking-tight text-bone">
                {t("app.name")}
              </span>
              <span className="font-mono text-[10px] text-bone-subtle">/</span>
              <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-cobalt-ink">
                {t("onboarding.badge")}
              </span>
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
              disabled={isInstalling || isSwapping}
              size="sm"
              align="right"
              ariaLabelledBy={langLabelId}
              className="w-36"
              onChange={(nextLang) => void setLanguage(nextLang)}
            />
          </div>
        </header>

        {/* Step progress strip */}
        <nav
          aria-label={t("onboarding.stepsLabel")}
          className="flex items-center gap-2 border-b border-rule bg-surface-2/60 px-6 py-2.5 font-mono text-[10px] uppercase tracking-[0.14em]"
        >
          <button
            type="button"
            disabled={busy}
            onClick={() => setStep("name")}
            className={`inline-flex items-center gap-1.5 transition-colors disabled:opacity-60 ${
              step === "name" ? "font-semibold text-cobalt-ink" : "text-bone-muted hover:text-bone"
            }`}
          >
            <span
              className={`inline-flex h-4 w-4 items-center justify-center rounded-[2px] border text-[9px] ${
                step === "name"
                  ? "border-cobalt-rule bg-cobalt-wash text-cobalt-ink"
                  : "border-verdigris-rule bg-verdigris-wash text-verdigris"
              }`}
            >
              {step === "hardware" ? <Check size={9} aria-hidden /> : "1"}
            </span>
            <span>{t("onboarding.nameStep.stepLabel")}</span>
          </button>

          <span className="h-px w-6 bg-rule-strong" aria-hidden />

          <button
            type="button"
            disabled={busy}
            onClick={() => setStep("hardware")}
            className={`inline-flex items-center gap-1.5 transition-colors disabled:opacity-60 ${
              step === "hardware"
                ? "font-semibold text-cobalt-ink"
                : "text-bone-subtle hover:text-bone"
            }`}
          >
            <span
              className={`inline-flex h-4 w-4 items-center justify-center rounded-[2px] border text-[9px] ${
                step === "hardware"
                  ? "border-cobalt-rule bg-cobalt-wash text-cobalt-ink"
                  : "border-rule bg-void text-bone-subtle"
              }`}
            >
              2
            </span>
            <span>{t("onboarding.hardwareStepLabel")}</span>
          </button>
        </nav>

        {step === "name" ? (
          <form onSubmit={handleNameStepSubmit}>
            <section className="border-b border-rule px-6 py-8 sm:py-10">
              <div className="max-w-xl">
                <div className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-cobalt-ink">
                  <User size={12} aria-hidden />
                  <span>01 — {t("onboarding.nameStep.stepLabel")}</span>
                </div>

                <h1 className="mt-2 font-display text-2xl font-medium tracking-tight text-bone sm:text-3xl">
                  {t("onboarding.nameStep.title")}
                </h1>
                <p className="mt-2.5 text-sm leading-relaxed text-bone-muted">
                  {t("onboarding.nameStep.subtitle")}
                </p>

                <div className="mt-6">
                  <label
                    htmlFor={nameInputId}
                    className="block font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle"
                  >
                    {t("onboarding.nameStep.inputLabel")}
                  </label>
                  <input
                    id={nameInputId}
                    type="text"
                    autoFocus
                    maxLength={80}
                    value={displayName}
                    onChange={(e) => {
                      nameEditedRef.current = true;
                      setDisplayName(e.target.value);
                    }}
                    placeholder={t("onboarding.nameStep.placeholder")}
                    className="mt-2 h-11 w-full rounded-[2px] border border-rule-strong bg-void px-3.5 text-base text-bone placeholder:text-bone-subtle focus:border-cobalt-ink focus:outline-none"
                  />
                  <p className="mt-2 text-xs text-bone-subtle">
                    {firstNamePreview
                      ? t("onboarding.nameStep.previewWithName", { name: firstNamePreview })
                      : t("onboarding.nameStep.optionalHint")}
                  </p>
                </div>
              </div>
            </section>

            <footer className="flex flex-wrap items-center justify-between gap-3 bg-surface-2 px-6 py-4">
              <button
                type="button"
                onClick={handleSkipName}
                className="inline-flex items-center gap-2 rounded-[2px] border border-rule-strong bg-surface px-4 py-2 text-xs font-medium text-bone-muted transition-colors hover:border-cobalt-ink/60 hover:bg-surface-3 hover:text-bone focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none"
              >
                {t("onboarding.nameStep.skip")}
              </button>

              <button
                type="submit"
                className="inline-flex items-center gap-2 rounded-[2px] border border-cobalt-rule bg-cobalt px-5 py-2 text-xs font-semibold tracking-wide text-bone transition-colors hover:bg-cobalt-bright focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none"
              >
                <span>{t("onboarding.nameStep.continue")}</span>
                <ArrowRight size={14} aria-hidden />
              </button>
            </footer>
          </form>
        ) : (
          <>
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
                      <div className="mt-1.5 flex items-center gap-1.5 font-mono text-sm font-semibold tabular-nums text-verdigris">
                        {isAlreadyInstalled ? (
                          <>
                            <Check size={14} className="shrink-0" aria-hidden />
                            <span>{t("onboarding.alreadyInstalled")}</span>
                          </>
                        ) : (
                          formatBytes(exactDownloadBytes)
                        )}
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
                  engineStatus={engineStatus}
                  disabled={busy}
                  onTierChange={setSelectedTier}
                  onEngineChange={setSelectedEngine}
                  onModelChange={setSelectedModelId}
                  onProModeChange={setProMode}
                />
              )}
            </section>

            {/* Live download progress & error banner */}
            {(downloadProgress || isInstalling || displayError) && (
              <div className="border-b border-rule bg-void px-6 py-4">
                <DownloadProgressBar
                  progress={downloadProgress}
                  isInstalling={isInstalling}
                  isCancelling={isCancelling}
                  error={displayError}
                  onCancel={() => void cancelDownload()}
                />
              </div>
            )}

            {/* Live engine swap progress */}
            {(isSwapping || swapProgress) && (
              <div className="border-b border-rule bg-void px-6 py-4">
                <div className="space-y-2 rounded-[2px] border border-cobalt-rule bg-cobalt-wash/50 p-3">
                  <div className="flex items-center justify-between font-mono text-[11px]">
                    <span className="inline-flex items-center gap-1.5 text-cobalt-ink">
                      {isSwapping && <Loader2 size={12} className="animate-spin" aria-hidden />}
                      {t(`pro.swapPhase.${swapProgress?.phase ?? "staging"}`)}
                    </span>
                    <span className="tabular-nums text-bone">
                      {swapProgress ? `${swapProgress.processed} / ${swapProgress.total}` : "…"} (
                      {swapPercent}%)
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-[1px] bg-void">
                    <div
                      className="h-full bg-cobalt transition-all duration-200"
                      style={{ width: `${swapPercent}%` }}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Primary action footer */}
            <footer className="flex flex-wrap items-center justify-between gap-3 bg-surface-2 px-6 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setStep("name")}
                  className="inline-flex items-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface px-3 py-2 text-xs font-medium text-bone-muted transition-colors hover:border-cobalt-ink/60 hover:bg-surface-3 hover:text-bone focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none disabled:opacity-45"
                >
                  <ArrowLeft size={13} aria-hidden />
                  <span>{t("onboarding.back")}</span>
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setCustomizing((v) => !v)}
                  className="inline-flex items-center gap-2 rounded-[2px] border border-rule-strong bg-surface px-4 py-2 text-xs font-medium text-bone transition-colors hover:border-cobalt-ink/60 hover:bg-surface-3 focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none disabled:opacity-45"
                >
                  <SlidersHorizontal size={14} aria-hidden />
                  {customizing ? t("onboarding.hideCustomize") : t("onboarding.customize")}
                </button>
              </div>

              <button
                type="button"
                disabled={busy || !profile}
                onClick={() => void handlePrimaryAction(activeTier, activeEngine, activeModel)}
                className="inline-flex items-center gap-2 rounded-[2px] border border-cobalt-rule bg-cobalt px-5 py-2 text-xs font-semibold tracking-wide text-bone transition-colors hover:bg-cobalt-bright focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none disabled:opacity-45"
              >
                {isInstalling ? (
                  <>
                    <Download size={14} aria-hidden />
                    {t("onboarding.installing")}
                  </>
                ) : isSwapping ? (
                  <>
                    <Loader2 size={14} className="animate-spin" aria-hidden />
                    <span>{t("pro.swapping")}</span>
                  </>
                ) : needsLiveSwap ? (
                  <>
                    <ArrowRightLeft size={14} aria-hidden />
                    <span>{t("pro.swapButton")}</span>
                    {!isAlreadyInstalled && exactDownloadBytes > 0 && (
                      <span className="font-mono tabular-nums opacity-85">
                        ({formatBytes(exactDownloadBytes)})
                      </span>
                    )}
                  </>
                ) : isAlreadyInstalled ? (
                  <>
                    <Check size={14} aria-hidden />
                    <span>{t("onboarding.apply")}</span>
                  </>
                ) : displayError ? (
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
          </>
        )}
      </div>
    </div>
  );
}
