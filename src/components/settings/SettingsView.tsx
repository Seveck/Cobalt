import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Cpu, Download, RotateCcw, Save, Shield } from "lucide-react";
import { SUPPORTED_LANGUAGES } from "@/i18n";
import { isCommandMocked } from "@/lib/backend";
import {
  estimateDownloadBytes,
  formatBytes,
  formatRamGb,
  isEngineModelInstalled,
} from "@/lib/format";
import { useHardwareStore, useSettingsStore, useUiStore } from "@/stores";
import { DownloadProgressBar, HardwareConfigForm } from "@/components/onboarding";
import { MockBadge } from "@/components/shell/MockBadge";
import { Select, Toggle, type SelectOption } from "@/components/ui";
import type { EngineKind, HardwareTier, Language } from "@/types/contracts";

export function SettingsView() {
  const { t } = useTranslation();
  const langLabelId = useId();
  const readOnlyLabelId = useId();

  const settings = useSettingsStore((s) => s.settings);
  const saving = useSettingsStore((s) => s.saving);
  const patchSettings = useSettingsStore((s) => s.patchSettings);
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  const setReadOnly = useSettingsStore((s) => s.setReadOnly);

  const profile = useHardwareStore((s) => s.profile);
  const models = useHardwareStore((s) => s.models);
  const engineStatus = useHardwareStore((s) => s.engineStatus);
  const downloadProgress = useHardwareStore((s) => s.downloadProgress);
  const isInstalling = useHardwareStore((s) => s.isInstalling);
  const isCancelling = useHardwareStore((s) => s.isCancelling);
  const error = useHardwareStore((s) => s.error);
  const installEngine = useHardwareStore((s) => s.installEngine);
  const cancelDownload = useHardwareStore((s) => s.cancelDownload);
  const clearError = useHardwareStore((s) => s.clearError);

  const setShowOnboardingOverride = useUiStore((s) => s.setShowOnboardingOverride);

  const [tier, setTier] = useState<HardwareTier>(settings.hardware_tier);
  const [engine, setEngine] = useState<EngineKind>(settings.vector_engine);
  const [modelId, setModelId] = useState<string>(settings.embedding_model_id);
  const [proMode, setProMode] = useState<boolean>(settings.pro_mode);
  const [savedNotice, setSavedNotice] = useState(false);

  useEffect(() => {
    setTier(settings.hardware_tier);
    setEngine(settings.vector_engine);
    setModelId(settings.embedding_model_id);
    setProMode(settings.pro_mode);
  }, [
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

  const handleSavePreferences = async () => {
    await patchSettings({
      hardware_tier: tier,
      vector_engine: engine,
      embedding_model_id: modelId,
      pro_mode: proMode,
    });
    showSavedFlash();
  };

  const isMocked = isCommandMocked("get_settings") || isCommandMocked("install_engine");
  const isAlreadyInstalled = isEngineModelInstalled(engine, modelId, engineStatus, profile);
  const downloadBytes = estimateDownloadBytes(engine, modelId, models, profile, engineStatus);

  const handleApplyAndInstall = async () => {
    clearError();
    if (isAlreadyInstalled) {
      await patchSettings({
        hardware_tier: tier,
        vector_engine: engine,
        embedding_model_id: modelId,
        pro_mode: proMode,
        onboarding_completed: true,
      });
      showSavedFlash();
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
      showSavedFlash();
    }
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
              {isMocked && <MockBadge />}
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

        {/* 02 — Hardware & Engine section */}
        <section className="rounded-[2px] border border-rule bg-surface">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule px-5 py-3">
            <div>
              <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-bone-subtle">
                02 — {t("settings.engineTitle")}
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
              disabled={isInstalling || saving}
              onTierChange={setTier}
              onEngineChange={setEngine}
              onModelChange={setModelId}
              onProModeChange={setProMode}
            />

            <DownloadProgressBar
              progress={downloadProgress}
              isInstalling={isInstalling}
              isCancelling={isCancelling}
              error={error}
              onCancel={() => void cancelDownload()}
            />
          </div>

          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-rule bg-surface-2 px-5 py-3.5">
            <button
              type="button"
              disabled={isInstalling || saving}
              onClick={() => void handleSavePreferences()}
              className="inline-flex items-center gap-2 rounded-[2px] border border-rule-strong bg-surface px-4 py-2 text-xs font-medium text-bone transition-colors hover:border-cobalt-ink/60 hover:bg-surface-3 focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none disabled:opacity-45"
            >
              <Save size={13} aria-hidden />
              {t("settings.saveConfigOnly")}
            </button>
            <button
              type="button"
              disabled={isInstalling || saving}
              onClick={() => void handleApplyAndInstall()}
              className="inline-flex items-center gap-2 rounded-[2px] border border-cobalt-rule bg-cobalt px-4 py-2 text-xs font-semibold text-bone transition-colors hover:bg-cobalt-bright focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none disabled:opacity-45"
            >
              {isAlreadyInstalled ? (
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

        {/* 03 — Detected hardware & re-open onboarding */}
        <section className="rounded-[2px] border border-rule bg-surface">
          <div className="border-b border-rule px-5 py-3">
            <h2 className="flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-bone-subtle">
              <Cpu size={13} className="text-cobalt-ink" aria-hidden />
              03 — {t("settings.hardwareTitle")}
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
      </div>
    </div>
  );
}
