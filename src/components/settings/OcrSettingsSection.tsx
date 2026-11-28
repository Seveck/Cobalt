import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Check,
  Download,
  Loader2,
  ScanText,
  Sparkles,
  Trash2,
} from "lucide-react";
import { DownloadProgressBar } from "@/components/onboarding";
import { formatBytes, formatPercent, isEngineStateInstalled } from "@/lib/format";
import { useHardwareStore, useSettingsStore, useUiStore } from "@/stores";
import type { OcrArtifactBytes } from "@/stores/hardware";
import {
  DEFAULT_OCR_MODEL,
  type DownloadProgress,
  type OcrStatus,
} from "@/types/contracts";

interface OcrSettingsSectionProps {
  onSaved: () => void;
}

interface RemovedNotice {
  modelId: string;
  modelName: string;
  freedBytes: number;
}

const FALLBACK_OCR_MODELS: readonly OcrStatus[] = [
  {
    model_id: DEFAULT_OCR_MODEL,
    engine: "paddle_ocr",
    display_name: "PaddleOCR (PP-OCRv5 latin)",
    languages: ["latin"],
    state: "not_installed",
    size_bytes: 12_875_358,
    installed_bytes: 0,
    active: true,
  },
  {
    model_id: "ocrs-latin",
    engine: "ocrs",
    display_name: "ocrs",
    languages: ["latin_basic"],
    state: "not_installed",
    size_bytes: 12_212_656,
    installed_bytes: 0,
    active: false,
  },
];

function isPaddleModel(model: OcrStatus): boolean {
  return model.engine === "paddle_ocr" || model.model_id === DEFAULT_OCR_MODEL;
}

function sortOcrModels(models: readonly OcrStatus[]): OcrStatus[] {
  return [...models].sort((a, b) => {
    const aRank = isPaddleModel(a) ? 0 : a.engine === "ocrs" ? 1 : 2;
    const bRank = isPaddleModel(b) ? 0 : b.engine === "ocrs" ? 1 : 2;
    if (aRank !== bRank) return aRank - bRank;
    return a.model_id.localeCompare(b.model_id);
  });
}

function buildModelDownloadView(
  model: OcrStatus,
  rawProgress: DownloadProgress | undefined,
  artifacts: Record<string, OcrArtifactBytes> | undefined,
  isInstalling: boolean,
): { displayProgress: DownloadProgress | null; percent: number } {
  if (!rawProgress) {
    return { displayProgress: null, percent: 0 };
  }

  const entries = artifacts ? Object.values(artifacts) : [];
  const summedDownloaded = entries.reduce((acc, item) => acc + item.downloaded, 0);
  const summedTotals = entries.reduce((acc, item) => acc + (item.total ?? 0), 0);

  const totalBytes =
    model.size_bytes > 0
      ? Math.max(model.size_bytes, summedTotals)
      : rawProgress.total_bytes;

  const downloadedBytes =
    entries.length > 0
      ? totalBytes !== null
        ? Math.min(totalBytes, summedDownloaded)
        : summedDownloaded
      : rawProgress.downloaded_bytes;

  const isIntermediateFileComplete = isInstalling && rawProgress.phase === "completed";
  const phase = isIntermediateFileComplete ? "downloading" : rawProgress.phase;

  const percent =
    phase === "completed"
      ? 100
      : totalBytes !== null && totalBytes > 0
        ? formatPercent(downloadedBytes, totalBytes)
        : formatPercent(rawProgress.downloaded_bytes, rawProgress.total_bytes);

  const displayProgress: DownloadProgress = {
    ...rawProgress,
    phase,
    downloaded_bytes: downloadedBytes,
    total_bytes: totalBytes,
  };

  return { displayProgress, percent };
}

export function OcrSettingsSection({ onSaved }: OcrSettingsSectionProps) {
  const { t } = useTranslation();

  const settings = useSettingsStore((s) => s.settings);
  const savingSettings = useSettingsStore((s) => s.saving);
  const patchSettings = useSettingsStore((s) => s.patchSettings);
  const clearSettingsError = useSettingsStore((s) => s.clearError);

  const ocrModels = useHardwareStore((s) => s.ocrModels);
  const ocrDownloadProgressByModel = useHardwareStore((s) => s.ocrDownloadProgressByModel);
  const ocrArtifactBytesByModel = useHardwareStore((s) => s.ocrArtifactBytesByModel);
  const ocrInstallingByModel = useHardwareStore((s) => s.ocrInstallingByModel);
  const ocrCancellingByModel = useHardwareStore((s) => s.ocrCancellingByModel);
  const ocrRemovingByModel = useHardwareStore((s) => s.ocrRemovingByModel);
  const ocrErrorByModel = useHardwareStore((s) => s.ocrErrorByModel);
  const loadOcrModels = useHardwareStore((s) => s.loadOcrModels);
  const installOcr = useHardwareStore((s) => s.installOcr);
  const cancelOcrDownload = useHardwareStore((s) => s.cancelOcrDownload);
  const removeOcr = useHardwareStore((s) => s.removeOcr);
  const clearOcrError = useHardwareStore((s) => s.clearOcrError);

  const settingsFocusSection = useUiStore((s) => s.settingsFocusSection);
  const settingsFocusAutoInstall = useUiStore((s) => s.settingsFocusAutoInstall);
  const clearSettingsFocusSection = useUiStore((s) => s.clearSettingsFocusSection);

  const sectionRef = useRef<HTMLElement | null>(null);
  const [highlight, setHighlight] = useState(false);
  const [switchingModelId, setSwitchingModelId] = useState<string | null>(null);
  const [selectError, setSelectError] = useState<string | null>(null);
  const [removedNotice, setRemovedNotice] = useState<RemovedNotice | null>(null);

  useEffect(() => {
    void loadOcrModels();
  }, [loadOcrModels]);

  const selectedModelId = settings.capture.ocr_model_id || DEFAULT_OCR_MODEL;

  const sortedModels = useMemo(() => {
    const base =
      ocrModels.length > 0
        ? ocrModels
        : FALLBACK_OCR_MODELS.map((item) => ({
            ...item,
            active: item.model_id === selectedModelId,
          }));
    return sortOcrModels(base);
  }, [ocrModels, selectedModelId]);

  const activeModelId =
    switchingModelId ??
    ocrModels.find((m) => m.active)?.model_id ??
    selectedModelId;

  const activeModel = useMemo(
    () =>
      sortedModels.find((m) => m.model_id === activeModelId) ??
      sortedModels[0] ??
      FALLBACK_OCR_MODELS[0]!,
    [sortedModels, activeModelId],
  );

  // Land on section when opened from ingest error shortcuts; optionally auto-install the active model.
  useEffect(() => {
    if (settingsFocusSection !== "ocr") return;
    const shouldAutoInstall = settingsFocusAutoInstall;
    sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    setHighlight(true);
    clearSettingsFocusSection();
    const timer = window.setTimeout(() => setHighlight(false), 2400);

    if (shouldAutoInstall) {
      void (async () => {
        const hwState = useHardwareStore.getState();
        const models =
          hwState.ocrModels.length > 0 ? hwState.ocrModels : await hwState.loadOcrModels();
        const configuredId =
          useSettingsStore.getState().settings.capture.ocr_model_id || DEFAULT_OCR_MODEL;
        const target =
          models.find((m) => m.active) ??
          models.find((m) => m.model_id === configuredId) ??
          models.find((m) => m.model_id === DEFAULT_OCR_MODEL) ??
          models[0];
        const targetId = target?.model_id ?? configuredId;
        const latestHw = useHardwareStore.getState();
        const alreadyInstalled = Boolean(target && isEngineStateInstalled(target.state));
        const alreadyDownloading =
          Boolean(latestHw.ocrInstallingByModel[targetId]) ||
          target?.state === "downloading";
        if (!alreadyInstalled && !alreadyDownloading) {
          latestHw.clearOcrError(targetId);
          setRemovedNotice((prev) => (prev?.modelId === targetId ? null : prev));
          const status = await latestHw.installOcr(targetId);
          if (status && isEngineStateInstalled(status.state)) {
            onSaved();
          }
        }
      })();
    }

    return () => window.clearTimeout(timer);
  }, [settingsFocusSection, settingsFocusAutoInstall, clearSettingsFocusSection, onSaved]);

  const handleInstallModel = async (modelId: string) => {
    clearOcrError(modelId);
    setRemovedNotice((prev) => (prev?.modelId === modelId ? null : prev));
    const status = await installOcr(modelId);
    if (status && isEngineStateInstalled(status.state)) {
      onSaved();
    }
  };

  const handleSelectModel = async (modelId: string) => {
    clearSettingsError();
    clearOcrError(modelId);
    setSelectError(null);
    setSwitchingModelId(modelId);
    try {
      await patchSettings({
        capture: {
          ...settings.capture,
          ocr_model_id: modelId,
        },
      });
      await loadOcrModels();
      const err = useSettingsStore.getState().error;
      if (err) {
        setSelectError(err);
      } else {
        onSaved();
      }
    } finally {
      setSwitchingModelId(null);
    }
  };

  const handleRemoveModel = async (model: OcrStatus) => {
    clearOcrError(model.model_id);
    setRemovedNotice(null);
    const freedBytes = await removeOcr(model.model_id);
    if (freedBytes !== null) {
      setRemovedNotice({
        modelId: model.model_id,
        modelName: model.display_name,
        freedBytes,
      });
    }
  };

  const activeIsDownloading =
    Boolean(ocrInstallingByModel[activeModel.model_id]) ||
    activeModel.state === "downloading";
  const activeIsInstalled =
    !activeIsDownloading && isEngineStateInstalled(activeModel.state);
  const activeDownloadView = buildModelDownloadView(
    activeModel,
    ocrDownloadProgressByModel[activeModel.model_id],
    ocrArtifactBytesByModel[activeModel.model_id],
    Boolean(ocrInstallingByModel[activeModel.model_id]),
  );

  const comparisonRows = useMemo(
    () => [
      {
        key: "spanishErrors",
        label: t("settings.ocr.comparison.rows.spanishErrors.label"),
        paddle: t("settings.ocr.comparison.rows.spanishErrors.paddle"),
        ocrs: t("settings.ocr.comparison.rows.spanishErrors.ocrs"),
      },
      {
        key: "smallPrint",
        label: t("settings.ocr.comparison.rows.smallPrint.label"),
        paddle: t("settings.ocr.comparison.rows.smallPrint.paddle"),
        ocrs: t("settings.ocr.comparison.rows.smallPrint.ocrs"),
      },
      {
        key: "codeScreenshots",
        label: t("settings.ocr.comparison.rows.codeScreenshots.label"),
        paddle: t("settings.ocr.comparison.rows.codeScreenshots.paddle"),
        ocrs: t("settings.ocr.comparison.rows.codeScreenshots.ocrs"),
      },
      {
        key: "timePerImage",
        label: t("settings.ocr.comparison.rows.timePerImage.label"),
        paddle: t("settings.ocr.comparison.rows.timePerImage.paddle"),
        ocrs: t("settings.ocr.comparison.rows.timePerImage.ocrs"),
      },
      {
        key: "memoryUsage",
        label: t("settings.ocr.comparison.rows.memoryUsage.label"),
        paddle: t("settings.ocr.comparison.rows.memoryUsage.paddle"),
        ocrs: t("settings.ocr.comparison.rows.memoryUsage.ocrs"),
      },
      {
        key: "downloadSize",
        label: t("settings.ocr.comparison.rows.downloadSize.label"),
        paddle: t("settings.ocr.comparison.rows.downloadSize.paddle"),
        ocrs: t("settings.ocr.comparison.rows.downloadSize.ocrs"),
      },
    ],
    [t],
  );

  return (
    <section
      id="settings-ocr"
      ref={sectionRef}
      className={`rounded-[2px] border bg-surface transition-colors duration-300 ${
        highlight ? "border-cobalt-ink ring-1 ring-cobalt-ink" : "border-rule"
      }`}
    >
      {/* Section header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule px-5 py-3">
        <div>
          <h2 className="flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-bone-subtle">
            <ScanText size={13} className="text-cobalt-ink" aria-hidden />
            06 — {t("settings.ocr.title")}
          </h2>
          <p className="mt-1 text-xs text-bone-muted">{t("settings.ocr.subtitle")}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
          <span className="rounded-[2px] border border-verdigris-rule/60 bg-verdigris-wash/40 px-2.5 py-1 text-verdigris">
            {t("settings.ocr.localOnlyBadge")}
          </span>
          <span
            className={`inline-flex items-center gap-1.5 rounded-[2px] border px-2.5 py-1 ${
              activeIsDownloading
                ? "border-cobalt-rule bg-cobalt-wash text-cobalt-ink"
                : activeIsInstalled
                  ? "border-verdigris-rule bg-verdigris-wash text-verdigris"
                  : "border-rule bg-void text-bone-muted"
            }`}
          >
            {activeIsDownloading && <Loader2 size={11} className="animate-spin" aria-hidden />}
            {activeIsInstalled && <Check size={11} aria-hidden />}
            <strong className="font-semibold">
              {activeIsDownloading
                ? t("settings.ocr.state.downloadingPercent", {
                    percent: activeDownloadView.percent,
                  })
                : activeIsInstalled
                  ? t("settings.ocr.state.inUse")
                  : t("settings.ocr.state.notInstalled")}
            </strong>
          </span>
        </div>
      </div>

      <div className="space-y-4 p-5">
        <p className="text-xs leading-relaxed text-bone-muted">
          {t("settings.ocr.description")}
        </p>

        {/* Active model not installed banner */}
        {!activeIsInstalled && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-[2px] border border-cobalt-rule bg-cobalt-wash/55 px-4 py-3 text-xs">
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="font-medium text-bone">
                {t("settings.ocr.activeNotInstalledTitle", {
                  name: activeModel.display_name,
                })}
              </div>
              <p className="text-bone-muted">
                {t("settings.ocr.activeNotInstalledHint")}
              </p>
            </div>
            <button
              type="button"
              disabled={activeIsDownloading}
              onClick={() => void handleInstallModel(activeModel.model_id)}
              className="inline-flex shrink-0 items-center gap-2 rounded-[2px] border border-cobalt-rule bg-cobalt px-3.5 py-1.5 text-xs font-semibold text-bone transition-colors hover:bg-cobalt-bright focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none disabled:opacity-45"
            >
              {activeIsDownloading ? (
                <>
                  <Loader2 size={12} className="animate-spin" aria-hidden />
                  <span>
                    {t("settings.ocr.state.downloadingPercent", {
                      percent: activeDownloadView.percent,
                    })}
                  </span>
                </>
              ) : (
                <>
                  <Download size={12} aria-hidden />
                  <span>
                    {t("settings.ocr.installActiveButton", {
                      name: activeModel.display_name,
                    })}
                  </span>
                  <span className="font-mono tabular-nums opacity-85">
                    ({formatBytes(activeModel.size_bytes)})
                  </span>
                </>
              )}
            </button>
          </div>
        )}

        {/* Selection error */}
        {selectError && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 rounded-[2px] border border-cinnabar-rule bg-cinnabar-wash px-3.5 py-2.5 text-xs text-cinnabar"
          >
            <span>{selectError}</span>
            <button
              type="button"
              onClick={() => setSelectError(null)}
              className="font-mono text-[10px] underline decoration-cinnabar/50 underline-offset-2 hover:text-bone"
            >
              {t("common.close")}
            </button>
          </div>
        )}

        {/* Removed space freed confirmation */}
        {removedNotice && (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-2 rounded-[2px] border border-verdigris-rule bg-verdigris-wash/60 px-3.5 py-2.5 text-xs text-verdigris"
          >
            <span className="inline-flex items-center gap-1.5 font-mono text-[11px]">
              <Check size={12} aria-hidden />
              {t("settings.ocr.removedFreedNotice", {
                name: removedNotice.modelName,
                size: formatBytes(removedNotice.freedBytes),
              })}
            </span>
            <button
              type="button"
              onClick={() => setRemovedNotice(null)}
              className="font-mono text-[10px] underline decoration-verdigris/50 underline-offset-2 hover:text-bone"
            >
              {t("common.close")}
            </button>
          </div>
        )}

        {/* Two OCR engine cards side by side (stack on narrow widths) */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {sortedModels.map((model) => {
            const paddle = isPaddleModel(model);
            const isInstalling = Boolean(ocrInstallingByModel[model.model_id]);
            const isCancelling = Boolean(ocrCancellingByModel[model.model_id]);
            const isRemoving = Boolean(ocrRemovingByModel[model.model_id]);
            const isDownloading = isInstalling || model.state === "downloading";
            const isInstalled = !isDownloading && isEngineStateInstalled(model.state);
            const isActive = model.model_id === activeModelId;
            const isInUse = isInstalled && isActive;
            const modelError = ocrErrorByModel[model.model_id] ?? null;
            const rawProgress = ocrDownloadProgressByModel[model.model_id];
            const { displayProgress, percent } = buildModelDownloadView(
              model,
              rawProgress,
              ocrArtifactBytesByModel[model.model_id],
              isInstalling,
            );
            const sizeLabel = formatBytes(
              isInstalled && model.installed_bytes > 0
                ? model.installed_bytes
                : model.size_bytes,
            );
            const canRemove =
              !isDownloading &&
              !isRemoving &&
              (isInstalled || model.installed_bytes > 0);
            const canUse =
              isInstalled &&
              !isActive &&
              !isDownloading &&
              !isRemoving &&
              !savingSettings &&
              switchingModelId === null;

            const stateLabel = isDownloading
              ? t("settings.ocr.state.downloadingPercent", { percent })
              : isInUse
                ? t("settings.ocr.state.inUse")
                : isInstalled
                  ? t("settings.ocr.state.installed")
                  : t("settings.ocr.state.notInstalled");

            return (
              <article
                key={model.model_id}
                className={`flex flex-col rounded-[2px] border bg-void p-4 transition-colors ${
                  isInUse
                    ? "border-verdigris-rule"
                    : isActive
                      ? "border-cobalt-rule"
                      : "border-rule"
                }`}
              >
                {/* Card top: name + Recommended badge + state badge */}
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold text-bone">
                        {model.display_name}
                      </h3>
                      {paddle && (
                        <span className="inline-flex items-center gap-1 rounded-[2px] border border-cobalt-rule bg-cobalt-wash px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-cobalt-ink">
                          <Sparkles size={10} aria-hidden />
                          {t("settings.ocr.recommendedBadge")}
                        </span>
                      )}
                    </div>
                    <div className="font-mono text-[11px] tabular-nums text-bone-subtle">
                      {isInstalled
                        ? t("settings.ocr.installedSizeInline", { size: sizeLabel })
                        : t("settings.ocr.downloadSizeInline", { size: sizeLabel })}
                    </div>
                  </div>

                  <span
                    className={`inline-flex shrink-0 items-center gap-1 rounded-[2px] border px-2 py-0.5 font-mono text-[10px] font-semibold tabular-nums ${
                      isDownloading
                        ? "border-cobalt-rule bg-cobalt-wash text-cobalt-ink"
                        : isInUse
                          ? "border-verdigris-rule bg-verdigris-wash text-verdigris"
                          : isInstalled
                            ? "border-rule-strong bg-surface-2 text-bone"
                            : "border-rule bg-surface text-bone-muted"
                    }`}
                  >
                    {isDownloading && <Loader2 size={10} className="animate-spin" aria-hidden />}
                    {(isInUse || isInstalled) && !isDownloading && (
                      <Check size={10} aria-hidden />
                    )}
                    <span>{stateLabel}</span>
                  </span>
                </div>

                {/* Language note */}
                <p className="mt-3 text-xs leading-relaxed text-bone-muted">
                  <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-bone-subtle">
                    {t("settings.ocr.languagesLabel")}:{" "}
                  </span>
                  {paddle
                    ? t("settings.ocr.paddleLanguageNote")
                    : t("settings.ocr.ocrsLanguageNote")}
                </p>

                {/* Per-model download progress / error */}
                {(displayProgress || isInstalling || modelError) && (
                  <div className="mt-3">
                    <DownloadProgressBar
                      progress={displayProgress}
                      isInstalling={isInstalling}
                      isCancelling={isCancelling}
                      error={modelError}
                      onCancel={() => void cancelOcrDownload(model.model_id)}
                    />
                  </div>
                )}

                {/* Card actions */}
                <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
                  {!isInstalled && (
                    <button
                      type="button"
                      disabled={isDownloading || isRemoving}
                      onClick={() => void handleInstallModel(model.model_id)}
                      className="inline-flex items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-3 py-1.5 text-xs font-semibold text-bone transition-colors hover:bg-cobalt-bright focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none disabled:opacity-45"
                    >
                      {isDownloading ? (
                        <>
                          <Loader2 size={12} className="animate-spin" aria-hidden />
                          <span>
                            {t("settings.ocr.state.downloadingPercent", { percent })}
                          </span>
                        </>
                      ) : (
                        <>
                          <Download size={12} aria-hidden />
                          <span>{t("settings.ocr.installCardButton")}</span>
                          <span className="font-mono tabular-nums opacity-85">
                            ({formatBytes(model.size_bytes)})
                          </span>
                        </>
                      )}
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={!canUse}
                    title={
                      !isInstalled
                        ? t("settings.ocr.useThisRequiresInstall")
                        : undefined
                    }
                    onClick={() => void handleSelectModel(model.model_id)}
                    className={`inline-flex items-center gap-1.5 rounded-[2px] border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none disabled:opacity-45 ${
                      isInUse
                        ? "border-verdigris-rule bg-verdigris-wash text-verdigris"
                        : "border-rule-strong bg-surface-2 text-bone hover:border-cobalt-ink/60 hover:bg-surface-3"
                    }`}
                  >
                    {switchingModelId === model.model_id ? (
                      <Loader2 size={12} className="animate-spin" aria-hidden />
                    ) : isInUse ? (
                      <Check size={12} aria-hidden />
                    ) : null}
                    <span>
                      {isInUse
                        ? t("settings.ocr.state.inUse")
                        : t("settings.ocr.useThisButton")}
                    </span>
                  </button>

                  {canRemove && (
                    <button
                      type="button"
                      disabled={isRemoving}
                      onClick={() => void handleRemoveModel(model)}
                      className="ml-auto inline-flex items-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface px-2.5 py-1.5 text-xs font-medium text-bone-muted transition-colors hover:border-cinnabar-rule hover:bg-cinnabar-wash hover:text-cinnabar focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none disabled:opacity-45"
                    >
                      {isRemoving ? (
                        <Loader2 size={12} className="animate-spin" aria-hidden />
                      ) : (
                        <Trash2 size={12} aria-hidden />
                      )}
                      <span>
                        {isRemoving
                          ? t("settings.ocr.removingButton")
                          : t("settings.ocr.removeButton")}
                      </span>
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>

        {/* Plain-language comparison table */}
        <div className="overflow-hidden rounded-[2px] border border-rule bg-void">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-rule px-4 py-2.5">
            <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-bone-subtle">
              {t("settings.ocr.comparison.title")}
            </h3>
            <span className="text-[11px] text-bone-muted">
              {t("settings.ocr.comparison.measuredNote")}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-rule bg-surface/60 font-mono text-[10px] uppercase tracking-[0.08em] text-bone-subtle">
                  <th scope="col" className="px-4 py-2 font-medium">
                    {t("settings.ocr.comparison.metricColumn")}
                  </th>
                  <th scope="col" className="px-4 py-2 font-semibold text-cobalt-ink">
                    PaddleOCR
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium text-bone-muted">
                    ocrs
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {comparisonRows.map((row) => (
                  <tr key={row.key} className="hover:bg-surface/40">
                    <th
                      scope="row"
                      className="px-4 py-2.5 font-normal text-bone-muted"
                    >
                      {row.label}
                    </th>
                    <td className="px-4 py-2.5 font-mono tabular-nums text-bone">
                      {row.paddle}
                    </td>
                    <td className="px-4 py-2.5 font-mono tabular-nums text-bone-muted">
                      {row.ocrs}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Always-visible accuracy warning (applies to both engines) */}
        <div
          role="note"
          className="flex items-start gap-2.5 rounded-[2px] border border-ochre-rule bg-ochre-wash px-3.5 py-3 text-xs text-ochre"
        >
          <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden />
          <p className="leading-relaxed">{t("settings.ocr.accuracyWarning")}</p>
        </div>
      </div>
    </section>
  );
}
