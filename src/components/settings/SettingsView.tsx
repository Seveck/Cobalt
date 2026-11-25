import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Cpu, Download, RotateCcw, Save, Shield } from "lucide-react";
import { SUPPORTED_LANGUAGES } from "@/i18n";
import { isCommandMocked } from "@/lib/backend";
import { estimateDownloadBytes, formatBytes, formatRamGb } from "@/lib/format";
import { useHardwareStore, useSettingsStore, useUiStore } from "@/stores";
import { DownloadProgressBar, HardwareConfigForm } from "@/components/onboarding";
import { MockBadge } from "@/components/shell/MockBadge";
import type { EngineKind, HardwareTier, Language } from "@/types/contracts";

export function SettingsView() {
  const { t } = useTranslation();
  const settings = useSettingsStore((s) => s.settings);
  const saving = useSettingsStore((s) => s.saving);
  const patchSettings = useSettingsStore((s) => s.patchSettings);
  const setLanguage = useSettingsStore((s) => s.setLanguage);

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

  const handleApplyAndInstall = async () => {
    clearError();
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

  const isMocked = isCommandMocked("get_settings") || isCommandMocked("install_engine");
  const downloadBytes = estimateDownloadBytes(engine, modelId, models, profile);

  return (
    <div className="h-full overflow-y-auto p-6 lg:p-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold text-slate-100">{t("settings.title")}</h1>
              {isMocked && <MockBadge />}
            </div>
            <p className="mt-1 text-sm text-slate-400">{t("settings.subtitle")}</p>
          </div>
          {savedNotice && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/35 bg-emerald-500/15 px-3 py-1 text-xs font-medium text-emerald-300">
              <Check size={13} aria-hidden />
              {t("settings.saved")}
            </span>
          )}
        </div>

        {/* General section */}
        <section className="space-y-4 rounded-2xl border border-white/10 bg-cobalt-900/25 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-300">
            {t("settings.generalTitle")}
          </h2>

          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-white/5 pt-4">
            <div>
              <div className="text-sm font-medium text-slate-100">
                {t("settings.languageLabel")}
              </div>
              <div className="text-xs text-slate-400">{t("settings.languageHint")}</div>
            </div>
            <select
              value={settings.language}
              disabled={saving}
              onChange={(e) => {
                void setLanguage(e.target.value as Language).then(showSavedFlash);
              }}
              className="rounded-lg border border-white/10 bg-void px-3 py-2 text-sm text-slate-100 outline-none focus:border-cobalt-500"
            >
              {SUPPORTED_LANGUAGES.map((lng) => (
                <option key={lng} value={lng}>
                  {lng === "es" ? "Español (ES)" : "English (EN)"}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-white/5 pt-4">
            <div>
              <div className="flex items-center gap-1.5 text-sm font-medium text-slate-100">
                <Shield size={14} className="text-amber-300" aria-hidden />
                {t("settings.readOnlyTitle")}
              </div>
              <div className="text-xs text-slate-400">{t("settings.readOnlyDesc")}</div>
            </div>
            <input
              type="checkbox"
              checked={settings.read_only}
              disabled={saving}
              onChange={(e) => {
                void patchSettings({ read_only: e.target.checked }).then(showSavedFlash);
              }}
              className="h-4 w-4 cursor-pointer accent-cobalt-500"
            />
          </div>
        </section>

        {/* Hardware & Engine section (editable post-onboarding) */}
        <section className="space-y-5 rounded-2xl border border-white/10 bg-cobalt-900/25 p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-300">
                {t("settings.engineTitle")}
              </h2>
              <p className="mt-1 text-xs text-slate-400">{t("settings.engineSubtitle")}</p>
            </div>

            {engineStatus && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-slate-300">
                  {t("settings.currentStatus")}:{" "}
                  <strong className="text-cobalt-300">
                    {t(`engineState.${engineStatus.engine_state}`)}
                  </strong>
                </span>
                <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 font-mono text-slate-300">
                  {engineStatus.dimensions}d · {formatBytes(engineStatus.installed_bytes)}
                </span>
              </div>
            )}
          </div>

          <HardwareConfigForm
            tier={tier}
            engine={engine}
            modelId={modelId}
            proMode={proMode}
            models={models}
            profile={profile}
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

          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-white/5 pt-4">
            <button
              type="button"
              disabled={isInstalling || saving}
              onClick={() => void handleSavePreferences()}
              className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/10 disabled:opacity-50"
            >
              <Save size={14} aria-hidden />
              {t("settings.saveConfigOnly")}
            </button>
            <button
              type="button"
              disabled={isInstalling || saving}
              onClick={() => void handleApplyAndInstall()}
              className="inline-flex items-center gap-2 rounded-xl bg-cobalt-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-cobalt-500 disabled:opacity-50"
            >
              <Download size={14} aria-hidden />
              {t("settings.applyAndInstall")} ({formatBytes(downloadBytes)})
            </button>
          </div>
        </section>

        {/* Detected hardware & re-open onboarding */}
        <section className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-white/10 bg-cobalt-900/25 p-5">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
              <Cpu size={15} className="text-cobalt-300" aria-hidden />
              {t("settings.hardwareTitle")}
            </h2>
            {profile && (
              <p className="mt-1 text-xs text-slate-400">
                {profile.cpu_brand} · {formatRamGb(profile.total_ram_bytes)} GB RAM ·{" "}
                {t("onboarding.cores", { count: profile.logical_cores })}
              </p>
            )}
            <p className="mt-1 text-xs text-slate-500">{t("settings.rerunOnboardingDesc")}</p>
          </div>

          <button
            type="button"
            onClick={() => setShowOnboardingOverride(true)}
            className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/10"
          >
            <RotateCcw size={14} aria-hidden />
            {t("settings.rerunButton")}
          </button>
        </section>
      </div>
    </div>
  );
}
