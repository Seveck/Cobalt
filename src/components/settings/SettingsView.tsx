import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowRightLeft,
  Check,
  Cpu,
  Download,
  FolderSync,
  GitCommitHorizontal,
  History,
  Info,
  Loader2,
  PauseCircle,
  RotateCcw,
  Save,
  Shield,
  Sparkles,
  Trash2,
  User,
} from "lucide-react";
import { SUPPORTED_LANGUAGES } from "@/i18n";
import {
  estimateDownloadBytes,
  formatBytes,
  formatRamGb,
  isEngineModelInstalled,
} from "@/lib/format";
import { useHardwareStore, useMemoryStore, useSettingsStore, useUiStore } from "@/stores";
import { DownloadProgressBar, HardwareConfigForm } from "@/components/onboarding";
import { MockBadge } from "@/components/shell/MockBadge";
import { Select, Toggle, type SelectOption } from "@/components/ui";
import {
  CONTRACT_VERSION,
  type CaptureSettings,
  type EngineKind,
  type HardwareTier,
  type Language,
} from "@/types/contracts";

export function SettingsView() {
  const { t } = useTranslation();
  const langLabelId = useId();
  const displayNameInputId = useId();
  const readOnlyLabelId = useId();
  const indexingPausedLabelId = useId();
  const autoWatchLabelId = useId();
  const sessionHandoffsLabelId = useId();
  const gitCommitsLabelId = useId();

  const settings = useSettingsStore((s) => s.settings);
  const saving = useSettingsStore((s) => s.saving);
  const settingsError = useSettingsStore((s) => s.error);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const patchSettings = useSettingsStore((s) => s.patchSettings);
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  const setReadOnly = useSettingsStore((s) => s.setReadOnly);
  const clearSettingsError = useSettingsStore((s) => s.clearError);

  const profile = useHardwareStore((s) => s.profile);
  const models = useHardwareStore((s) => s.models);
  const engineStatus = useHardwareStore((s) => s.engineStatus);
  const downloadProgress = useHardwareStore((s) => s.downloadProgress);
  const isInstalling = useHardwareStore((s) => s.isInstalling);
  const isCancelling = useHardwareStore((s) => s.isCancelling);
  const swapProgress = useHardwareStore((s) => s.swapProgress);
  const swapReport = useHardwareStore((s) => s.swapReport);
  const isSwapping = useHardwareStore((s) => s.isSwapping);
  const error = useHardwareStore((s) => s.error);
  const installEngine = useHardwareStore((s) => s.installEngine);
  const cancelDownload = useHardwareStore((s) => s.cancelDownload);
  const swapEngine = useHardwareStore((s) => s.swapEngine);
  const removeEngineArtifacts = useHardwareStore((s) => s.removeEngineArtifacts);
  const clearError = useHardwareStore((s) => s.clearError);
  const loadGraph = useMemoryStore((s) => s.loadGraph);

  const appInfo = useUiStore((s) => s.appInfo);
  const setShowOnboardingOverride = useUiStore((s) => s.setShowOnboardingOverride);

  const [displayName, setDisplayName] = useState<string>(settings.user_display_name ?? "");
  const [tier, setTier] = useState<HardwareTier>(settings.hardware_tier);
  const [engine, setEngine] = useState<EngineKind>(settings.vector_engine);
  const [modelId, setModelId] = useState<string>(settings.embedding_model_id);
  const [proMode, setProMode] = useState<boolean>(settings.pro_mode);
  const [savedNotice, setSavedNotice] = useState(false);
  const [removingOld, setRemovingOld] = useState(false);

  useEffect(() => {
    setDisplayName(settings.user_display_name ?? "");
    setTier(settings.hardware_tier);
    setEngine(settings.vector_engine);
    setModelId(settings.embedding_model_id);
    setProMode(settings.pro_mode);
  }, [
    settings.user_display_name,
    settings.hardware_tier,
    settings.vector_engine,
    settings.embedding_model_id,
    settings.pro_mode,
  ]);

  const languageOptions = useMemo<SelectOption<Language>[]>(
    () =>
      SUPPORTED_LANGUAGES.map((lng) => ({
        value: lng,
        label: t(`languages.${lng}`),
      })),
    [t],
  );

  const showSavedFlash = () => {
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 2000);
  };

  const normalizedDisplayName = displayName.trim() || null;
  const savedDisplayName = settings.user_display_name?.trim() || null;
  const displayNameDirty = normalizedDisplayName !== savedDisplayName;

  const handleSaveDisplayName = async () => {
    if (!displayNameDirty) return;
    clearSettingsError();
    await patchSettings({ user_display_name: normalizedDisplayName });
    if (!useSettingsStore.getState().error) {
      showSavedFlash();
    }
  };

  const isAlreadyInstalled = isEngineModelInstalled(engine, modelId, engineStatus, profile);
  const downloadBytes = estimateDownloadBytes(engine, modelId, models, profile, engineStatus);
  const needsLiveSwap =
    Boolean(engineStatus && engineStatus.vector_count > 0) &&
    (engine !== settings.vector_engine || modelId !== settings.embedding_model_id);
  const displayError = error ?? settingsError;

  const handleSavePreferences = async () => {
    clearError();
    clearSettingsError();
    if (needsLiveSwap) {
      await patchSettings({
        hardware_tier: tier,
        pro_mode: proMode,
      });
    } else {
      await patchSettings({
        hardware_tier: tier,
        vector_engine: engine,
        embedding_model_id: modelId,
        pro_mode: proMode,
      });
    }
    if (!useSettingsStore.getState().error) {
      showSavedFlash();
    }
  };

  const swapPercent =
    swapProgress && swapProgress.total > 0
      ? Math.min(100, Math.round((swapProgress.processed / swapProgress.total) * 100))
      : 0;

  const handleApplyAndInstall = async () => {
    clearError();
    clearSettingsError();
    if (needsLiveSwap) {
      if (!isAlreadyInstalled) {
        const installed = await installEngine({ engine, model_id: modelId });
        if (!installed) {
          return;
        }
      }
      const report = await swapEngine({
        target_engine: engine,
        target_model_id: modelId,
        external_endpoint: null,
      });
      if (report && !report.rolled_back) {
        await loadSettings();
        await patchSettings({
          hardware_tier: tier,
          pro_mode: proMode,
          onboarding_completed: true,
        });
        if (useSettingsStore.getState().error) {
          return;
        }
        await loadGraph();
        showSavedFlash();
      }
      return;
    }
    if (isAlreadyInstalled) {
      await patchSettings({
        hardware_tier: tier,
        vector_engine: engine,
        embedding_model_id: modelId,
        pro_mode: proMode,
        onboarding_completed: true,
      });
      if (!useSettingsStore.getState().error) {
        showSavedFlash();
      }
      return;
    }
    const status = await installEngine({ engine, model_id: modelId });
    if (status) {
      await patchSettings({
        hardware_tier: tier,
        vector_engine: engine,
        embedding_model_id: modelId,
        pro_mode: proMode,
        onboarding_completed: true,
      });
      if (!useSettingsStore.getState().error) {
        showSavedFlash();
      }
    }
  };

  const handleRemoveOldEngine = async () => {
    if (!swapReport) return;
    setRemovingOld(true);
    try {
      await removeEngineArtifacts(swapReport.from_engine, swapReport.from_model_id);
      showSavedFlash();
    } finally {
      setRemovingOld(false);
    }
  };

  const handleToggleCaptureSetting = (key: keyof CaptureSettings, value: boolean) => {
    clearSettingsError();
    void patchSettings({
      capture: {
        ...settings.capture,
        [key]: value,
      },
    }).then(() => {
      if (!useSettingsStore.getState().error) {
        showSavedFlash();
      }
    });
  };

  return (
    <div className="h-full overflow-y-auto bg-void p-6 lg:p-8">
      <div className="mx-auto max-w-4xl space-y-6">
        {/* Page header */}
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-rule pb-5">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="font-display text-2xl font-medium tracking-tight text-bone sm:text-3xl">
                {t("settings.title")}
              </h1>
              <MockBadge />
            </div>
            <p className="mt-1.5 text-sm text-bone-muted">{t("settings.subtitle")}</p>
          </div>
          {savedNotice && (
            <span className="inline-flex items-center gap-1.5 rounded-[2px] border border-verdigris-rule bg-verdigris-wash px-3 py-1 font-mono text-xs font-medium text-verdigris">
              <Check size={13} aria-hidden />
              {t("settings.saved")}
            </span>
          )}
        </header>

        {/* 01 — General section */}
        <section className="rounded-[2px] border border-rule bg-surface">
          <div className="border-b border-rule px-5 py-3">
            <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-bone-subtle">
              01 — {t("settings.generalTitle")}
            </h2>
          </div>

          <div className="divide-y divide-rule px-5">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleSaveDisplayName();
              }}
              className="flex flex-wrap items-center justify-between gap-4 py-4"
            >
              <div className="min-w-0 flex-1">
                <label
                  htmlFor={displayNameInputId}
                  className="flex items-center gap-1.5 text-sm font-medium text-bone"
                >
                  <User size={14} className="text-cobalt-ink" aria-hidden />
                  {t("settings.displayNameLabel")}
                </label>
                <div className="mt-0.5 text-xs text-bone-muted">
                  {t("settings.displayNameHint")}
                </div>
              </div>
              <div className="flex w-full items-center gap-2 sm:w-auto">
                <input
                  id={displayNameInputId}
                  type="text"
                  maxLength={80}
                  value={displayName}
                  disabled={saving}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder={t("settings.displayNamePlaceholder")}
                  className="h-8 w-full rounded-[2px] border border-rule-strong bg-void px-2.5 text-xs text-bone placeholder:text-bone-subtle focus:border-cobalt-ink focus:outline-none disabled:opacity-45 sm:w-52"
                />
                <button
                  type="submit"
                  disabled={saving || !displayNameDirty}
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface-2 px-3 text-xs font-medium text-bone transition-colors hover:border-cobalt-ink/60 hover:bg-surface-3 focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none disabled:opacity-45"
                >
                  <Save size={12} aria-hidden />
                  {t("settings.saveName")}
                </button>
              </div>
            </form>

            <div className="flex flex-wrap items-center justify-between gap-4 py-4">
              <div>
                <div id={langLabelId} className="text-sm font-medium text-bone">
                  {t("settings.languageLabel")}
                </div>
                <div className="mt-0.5 text-xs text-bone-muted">{t("settings.languageHint")}</div>
              </div>
              <Select<Language>
                value={settings.language}
                options={languageOptions}
                disabled={saving}
                ariaLabelledBy={langLabelId}
                align="right"
                className="w-44"
                onChange={(nextLang) => {
                  void setLanguage(nextLang).then(showSavedFlash);
                }}
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4 py-4">
              <div>
                <div
                  id={readOnlyLabelId}
                  className="flex items-center gap-1.5 text-sm font-medium text-bone"
                >
                  <Shield size={14} className="text-ochre" aria-hidden />
                  {t("settings.readOnlyTitle")}
                </div>
                <div className="mt-0.5 text-xs text-bone-muted">{t("settings.readOnlyDesc")}</div>
              </div>
              <Toggle
                checked={settings.read_only}
                disabled={saving}
                ariaLabelledBy={readOnlyLabelId}
                onChange={(checked) => {
                  void setReadOnly(checked).then(showSavedFlash);
                }}
              />
            </div>
          </div>
        </section>

        {/* 02 — Automatic capture section */}
        <section className="rounded-[2px] border border-rule bg-surface">
          <div className="border-b border-rule px-5 py-3">
            <h2 className="flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-bone-subtle">
              <Sparkles size={13} className="text-cobalt-ink" aria-hidden />
              02 — {t("settings.captureTitle")}
            </h2>
            <p className="mt-1 text-xs text-bone-muted">{t("settings.captureSubtitle")}</p>
          </div>

          <div className="divide-y divide-rule px-5">
            <div className="flex flex-wrap items-center justify-between gap-4 py-4">
              <div className="min-w-0 flex-1">
                <div
                  id={indexingPausedLabelId}
                  className="flex items-center gap-1.5 text-sm font-medium text-bone"
                >
                  <PauseCircle size={14} className="text-ochre" aria-hidden />
                  {t("settings.captureIndexingPausedTitle")}
                </div>
                <div className="mt-0.5 text-xs text-bone-muted">
                  {t("settings.captureIndexingPausedDesc")}
                </div>
              </div>
              <Toggle
                checked={settings.capture.indexing_paused}
                disabled={saving}
                ariaLabelledBy={indexingPausedLabelId}
                onChange={(checked) => handleToggleCaptureSetting("indexing_paused", checked)}
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4 py-4">
              <div className="min-w-0 flex-1">
                <div
                  id={autoWatchLabelId}
                  className="flex items-center gap-1.5 text-sm font-medium text-bone"
                >
                  <FolderSync size={14} className="text-cobalt-ink" aria-hidden />
                  {t("settings.captureAutoWatchTitle")}
                </div>
                <div className="mt-0.5 text-xs text-bone-muted">
                  {t("settings.captureAutoWatchDesc")}
                </div>
              </div>
              <Toggle
                checked={settings.capture.auto_watch_projects}
                disabled={saving}
                ariaLabelledBy={autoWatchLabelId}
                onChange={(checked) => handleToggleCaptureSetting("auto_watch_projects", checked)}
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4 py-4">
              <div className="min-w-0 flex-1">
                <div
                  id={sessionHandoffsLabelId}
                  className="flex items-center gap-1.5 text-sm font-medium text-bone"
                >
                  <History size={14} className="text-cobalt-ink" aria-hidden />
                  {t("settings.captureSessionHandoffsTitle")}
                </div>
                <div className="mt-0.5 text-xs text-bone-muted">
                  {t("settings.captureSessionHandoffsDesc")}
                </div>
              </div>
              <Toggle
                checked={settings.capture.session_handoffs}
                disabled={saving}
                ariaLabelledBy={sessionHandoffsLabelId}
                onChange={(checked) => handleToggleCaptureSetting("session_handoffs", checked)}
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4 py-4">
              <div className="min-w-0 flex-1">
                <div
                  id={gitCommitsLabelId}
                  className="flex items-center gap-1.5 text-sm font-medium text-bone"
                >
                  <GitCommitHorizontal size={14} className="text-cobalt-ink" aria-hidden />
                  {t("settings.captureGitCommitsTitle")}
                </div>
                <div className="mt-0.5 text-xs text-bone-muted">
                  {t("settings.captureGitCommitsDesc")}
                </div>
              </div>
              <Toggle
                checked={settings.capture.git_commits}
                disabled={saving}
                ariaLabelledBy={gitCommitsLabelId}
                onChange={(checked) => handleToggleCaptureSetting("git_commits", checked)}
              />
            </div>
          </div>
        </section>

        {/* 03 — Hardware & Engine section */}
        <section className="rounded-[2px] border border-rule bg-surface">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule px-5 py-3">
            <div>
              <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-bone-subtle">
                03 — {t("settings.engineTitle")}
              </h2>
              <p className="mt-1 text-xs text-bone-muted">{t("settings.engineSubtitle")}</p>
            </div>

            {engineStatus && (
              <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
                <span className="rounded-[2px] border border-rule bg-void px-2.5 py-1 text-bone-muted">
                  {t("settings.currentStatus")}:{" "}
                  <strong className="font-semibold text-cobalt-ink">
                    {t(`engineState.${engineStatus.engine_state}`)}
                  </strong>
                </span>
                <span className="rounded-[2px] border border-rule bg-void px-2.5 py-1 tabular-nums text-bone-muted">
                  {engineStatus.dimensions}d · {formatBytes(engineStatus.installed_bytes)}
                </span>
              </div>
            )}
          </div>

          <div className="space-y-5 p-5">
            <HardwareConfigForm
              tier={tier}
              engine={engine}
              modelId={modelId}
              proMode={proMode}
              models={models}
              profile={profile}
              engineStatus={engineStatus}
              disabled={isInstalling || isSwapping || saving}
              onTierChange={setTier}
              onEngineChange={setEngine}
              onModelChange={setModelId}
              onProModeChange={setProMode}
            />

            <DownloadProgressBar
              progress={downloadProgress}
              isInstalling={isInstalling}
              isCancelling={isCancelling}
              error={displayError}
              onCancel={() => void cancelDownload()}
            />

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
              </div>
            )}

            {swapReport && swapReport.reclaimable_bytes > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-[2px] border border-verdigris-rule bg-verdigris-wash/60 p-3 text-xs">
                <span className="font-mono text-[11px] text-bone">
                  {t("pro.swapSummary", {
                    reembedded: swapReport.reembedded,
                    verified: swapReport.verified_count,
                  })}
                </span>
                <button
                  type="button"
                  disabled={removingOld}
                  onClick={() => void handleRemoveOldEngine()}
                  className="inline-flex items-center gap-1.5 rounded-[2px] border border-ochre-rule bg-ochre-wash px-3 py-1 font-mono text-[11px] font-semibold text-ochre hover:bg-ochre hover:text-void disabled:opacity-45"
                >
                  {removingOld ? (
                    <Loader2 size={11} className="animate-spin" aria-hidden />
                  ) : (
                    <Trash2 size={11} aria-hidden />
                  )}
                  {t("pro.removeOldEngine", { size: formatBytes(swapReport.reclaimable_bytes) })}
                </button>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-rule bg-surface-2 px-5 py-3.5">
            <button
              type="button"
              disabled={isInstalling || isSwapping || saving}
              onClick={() => void handleSavePreferences()}
              className="inline-flex items-center gap-2 rounded-[2px] border border-rule-strong bg-surface px-4 py-2 text-xs font-medium text-bone transition-colors hover:border-cobalt-ink/60 hover:bg-surface-3 focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none disabled:opacity-45"
            >
              <Save size={13} aria-hidden />
              {t("settings.saveConfigOnly")}
            </button>
            <button
              type="button"
              disabled={isInstalling || isSwapping || saving}
              onClick={() => void handleApplyAndInstall()}
              className="inline-flex items-center gap-2 rounded-[2px] border border-cobalt-rule bg-cobalt px-4 py-2 text-xs font-semibold text-bone transition-colors hover:bg-cobalt-bright focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none disabled:opacity-45"
            >
              {needsLiveSwap ? (
                <>
                  <ArrowRightLeft size={13} aria-hidden />
                  <span>{isSwapping ? t("pro.swapping") : t("pro.swapButton")}</span>
                </>
              ) : isAlreadyInstalled ? (
                <>
                  <Check size={13} aria-hidden />
                  <span>{t("onboarding.apply")}</span>
                </>
              ) : (
                <>
                  <Download size={13} aria-hidden />
                  <span>{t("settings.applyAndInstall")}</span>
                  <span className="font-mono tabular-nums opacity-85">
                    ({formatBytes(downloadBytes)})
                  </span>
                </>
              )}
            </button>
          </div>
        </section>

        {/* 04 — Detected hardware & re-open onboarding */}
        <section className="rounded-[2px] border border-rule bg-surface">
          <div className="border-b border-rule px-5 py-3">
            <h2 className="flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-bone-subtle">
              <Cpu size={13} className="text-cobalt-ink" aria-hidden />
              04 — {t("settings.hardwareTitle")}
            </h2>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4 p-5">
            <div>
              {profile && (
                <p className="font-mono text-xs text-bone">
                  {profile.cpu_brand} · {formatRamGb(profile.total_ram_bytes)} GB RAM ·{" "}
                  {t("onboarding.cores", { count: profile.logical_cores })}
                </p>
              )}
              <p className="mt-1 text-xs text-bone-muted">{t("settings.rerunOnboardingDesc")}</p>
            </div>

            <button
              type="button"
              onClick={() => setShowOnboardingOverride(true)}
              className="inline-flex items-center gap-2 rounded-[2px] border border-rule-strong bg-surface-2 px-4 py-2 text-xs font-medium text-bone transition-colors hover:border-cobalt-ink/60 hover:bg-surface-3 focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none"
            >
              <RotateCcw size={13} aria-hidden />
              {t("settings.rerunButton")}
            </button>
          </div>
        </section>

        {/* 05 — About section (app version + contract version) */}
        <section className="rounded-[2px] border border-rule bg-surface">
          <div className="border-b border-rule px-5 py-3">
            <h2 className="flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-bone-subtle">
              <Info size={13} className="text-cobalt-ink" aria-hidden />
              05 — {t("settings.aboutTitle")}
            </h2>
          </div>

          <div className="divide-y divide-rule px-5 font-mono text-xs">
            <div className="flex flex-wrap items-center justify-between gap-3 py-3.5">
              <span className="text-bone-muted">{t("settings.aboutAppVersion")}</span>
              <span className="text-bone">
                {appInfo ? `v${appInfo.version}` : "—"}
              </span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 py-3.5">
              <span className="text-bone-muted">{t("settings.aboutContractVersion")}</span>
              <span className="text-bone">
                v{appInfo?.contract_version ?? CONTRACT_VERSION}
              </span>
            </div>
            {appInfo && (
              <div className="flex flex-wrap items-center justify-between gap-3 py-3.5">
                <span className="text-bone-muted">{t("onboarding.os")}</span>
                <span className="text-bone-subtle">
                  {appInfo.os} · {appInfo.arch}
                </span>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
