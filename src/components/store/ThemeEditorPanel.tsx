import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  Loader2,
  Moon,
  Palette,
  RotateCcw,
  Save,
  Sun,
  X,
} from "lucide-react";
import { backendCall } from "@/lib/backend";
import { toDisplayError, type DisplayError } from "@/lib/friendlyError";
import {
  ACCENT_SWATCHES,
  BRAIN_BG_SWATCHES,
  DEFAULT_EDITOR_UI,
  UI_SIZE_OPTIONS,
  isBuiltinThemeId,
  normalizeHexColor,
  slugifyThemeId,
  type UiSize,
} from "@/lib/themeEngine";
import { useSettingsStore, useThemeStore } from "@/stores";
import { ErrorAlert } from "@/components/ui";
import {
  MEMORY_CATEGORIES,
  type MemoryCategory,
  type ThemeManifest,
  type ThemeUi,
} from "@/types/contracts";
import { ThemeMiniPreview } from "./ThemeMiniPreview";

const DENSITY_OPTIONS: readonly ThemeUi["density"][] = [
  "compact",
  "comfortable",
  "spacious",
] as const;

export function ThemeEditorPanel() {
  const { t } = useTranslation();
  const nameInputId = useId();
  const hueInputId = useId();
  const tintInputId = useId();
  const contrastInputId = useId();
  const radiusInputId = useId();
  const nameInputRef = useRef<HTMLInputElement>(null);

  const open = useThemeStore((s) => s.themeEditorOpen);
  const mode = useThemeStore((s) => s.themeEditorMode);
  const manifest = useThemeStore((s) => s.manifest);
  const baseManifest = useThemeStore((s) => s.themeEditorBaseManifest);
  const uiSize = useThemeStore((s) => s.uiSize);
  const dirty = useThemeStore((s) => s.themeEditorDirty);
  const updateDraft = useThemeStore((s) => s.updateThemeEditorDraft);
  const previewUiSize = useThemeStore((s) => s.previewUiSize);
  const resetEditor = useThemeStore((s) => s.resetThemeEditor);
  const discardAndClose = useThemeStore((s) => s.discardAndCloseThemeEditor);
  const commitSave = useThemeStore((s) => s.commitThemeEditorSave);
  const loadInstalledThemes = useThemeStore((s) => s.loadInstalledThemes);
  const pushThemeToast = useThemeStore((s) => s.pushThemeToast);

  const userDisplayName = useSettingsStore((s) => s.settings.user_display_name);
  const patchSettings = useSettingsStore((s) => s.patchSettings);

  const [savePromptOpen, setSavePromptOpen] = useState(false);
  const [themeName, setThemeName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<DisplayError | string | null>(null);

  useEffect(() => {
    if (!open) {
      setSavePromptOpen(false);
      setSaveError(null);
      setSaving(false);
      return;
    }
    setSavePromptOpen(false);
    setSaveError(null);
    if (mode === "edit" && baseManifest) {
      setThemeName(baseManifest.name);
    } else if (baseManifest) {
      setThemeName(t("themeEditor.suggestedName", { name: baseManifest.name }));
    } else {
      setThemeName("");
    }
  }, [baseManifest, mode, open, t]);

  useEffect(() => {
    if (savePromptOpen) {
      window.requestAnimationFrame(() => {
        nameInputRef.current?.focus();
        nameInputRef.current?.select();
      });
    }
  }, [savePromptOpen]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || saving) return;
      event.preventDefault();
      if (savePromptOpen) {
        setSavePromptOpen(false);
        setSaveError(null);
      } else {
        discardAndClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [discardAndClose, open, savePromptOpen, saving]);

  const currentUi: ThemeUi = manifest.ui ?? DEFAULT_EDITOR_UI;

  const isEditingUserTheme = mode === "edit" && !isBuiltinThemeId(manifest.id);
  const computedId = useMemo(() => {
    if (isEditingUserTheme) {
      return manifest.id;
    }
    return slugifyThemeId(themeName.trim() || manifest.name);
  }, [isEditingUserTheme, manifest.id, manifest.name, themeName]);

  if (!open) return null;

  const patchUi = (patch: Partial<ThemeUi>) => {
    updateDraft((draft) => ({
      ...draft,
      ui: {
        ...(draft.ui ?? DEFAULT_EDITOR_UI),
        ...patch,
      },
    }));
  };

  const setBrainBackground = (hex: string) => {
    const normalized = normalizeHexColor(hex, manifest.palette.background);
    updateDraft((draft) => ({
      ...draft,
      palette: {
        ...draft.palette,
        background: normalized,
      },
    }));
  };

  const setCategoryColor = (category: MemoryCategory, hex: string) => {
    const fallback = manifest.palette.category_colors[category] ?? manifest.palette.node;
    const normalized = normalizeHexColor(hex, fallback);
    updateDraft((draft) => ({
      ...draft,
      palette: {
        ...draft.palette,
        category_colors: {
          ...draft.palette.category_colors,
          [category]: normalized,
        },
      },
    }));
  };

  const handleSaveSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const cleanedName = themeName.trim();
    if (!cleanedName) {
      setSaveError(t("themeEditor.nameRequired"));
      nameInputRef.current?.focus();
      return;
    }

    const targetId = isEditingUserTheme ? manifest.id : slugifyThemeId(cleanedName);
    if (isBuiltinThemeId(targetId)) {
      setSaveError(t("themeEditor.builtinIdError"));
      return;
    }

    const normalizedCategories: Partial<Record<MemoryCategory, string>> = {};
    for (const cat of MEMORY_CATEGORIES) {
      const raw = manifest.palette.category_colors[cat] ?? manifest.palette.node;
      normalizedCategories[cat] = normalizeHexColor(raw, "#3B82F6");
    }

    const preparedManifest: ThemeManifest = {
      ...manifest,
      id: targetId,
      name: cleanedName,
      author: isEditingUserTheme
        ? manifest.author || userDisplayName?.trim() || t("themeEditor.defaultAuthor")
        : userDisplayName?.trim() || t("themeEditor.defaultAuthor"),
      version: manifest.version || "1.0.0",
      description: isEditingUserTheme
        ? manifest.description
        : t("themeEditor.customThemeDescription", {
            base: baseManifest?.name ?? manifest.name,
          }),
      layout_type:
        !isEditingUserTheme && manifest.layout_type === "custom_mesh"
          ? "galaxy"
          : manifest.layout_type,
      palette: {
        ...manifest.palette,
        background: normalizeHexColor(manifest.palette.background, "#05070D"),
        node: normalizeHexColor(manifest.palette.node, "#3B82F6"),
        core_pin: normalizeHexColor(manifest.palette.core_pin, "#FACC15"),
        reusable: normalizeHexColor(manifest.palette.reusable, "#A78BFA"),
        edge: normalizeHexColor(manifest.palette.edge, "#1E3A8A"),
        text: normalizeHexColor(manifest.palette.text, "#E2E8F0"),
        pulse_read: normalizeHexColor(manifest.palette.pulse_read, "#60A5FA"),
        pulse_reuse: normalizeHexColor(manifest.palette.pulse_reuse, "#A78BFA"),
        pulse_write: normalizeHexColor(manifest.palette.pulse_write, "#34D399"),
        pulse_update: normalizeHexColor(manifest.palette.pulse_update, "#FBBF24"),
        pulse_blocked: normalizeHexColor(manifest.palette.pulse_blocked, "#F87171"),
        category_colors: normalizedCategories,
      },
      shaders: isEditingUserTheme
        ? manifest.shaders
        : {
            node_vertex: null,
            node_fragment: null,
            edge_vertex: null,
            edge_fragment: null,
            background_fragment: null,
          },
      mesh_path: isEditingUserTheme ? manifest.mesh_path : null,
      ui: {
        ...currentUi,
        accent: normalizeHexColor(currentUi.accent, "#3D6EF0"),
        base_hue: Math.round(Math.max(0, Math.min(360, currentUi.base_hue))),
        base_tint: Math.round(Math.max(0, Math.min(100, currentUi.base_tint))),
        contrast: Math.round(Math.max(0, Math.min(100, currentUi.contrast))),
        radius: Math.round(Math.max(0, Math.min(16, currentUi.radius))),
      },
    };

    setSaving(true);
    setSaveError(null);
    try {
      const installed = await backendCall("save_custom_theme", {
        manifest: preparedManifest,
        apply: true,
      });
      commitSave(preparedManifest);
      await patchSettings({ active_theme_id: installed.id });
      await loadInstalledThemes();
      pushThemeToast({
        kind: "saved",
        message: t("themeEditor.savedNotice", { name: installed.name }),
        themeId: installed.id,
        themeName: installed.name,
        applied: true,
      });
    } catch (err: unknown) {
      setSaveError(toDisplayError(err, t, "save_custom_theme"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <aside
      aria-label={t("themeEditor.title")}
      className="cobalt-drawer-enter-right flex h-full w-80 shrink-0 flex-col border-l border-rule-strong bg-surface text-bone sm:w-[356px]"
    >
      {/* Header */}
      <header className="flex items-start justify-between gap-2 border-b border-rule px-4 py-3.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Palette size={15} className="shrink-0 text-cobalt-ink" aria-hidden />
            <h2 className="truncate text-sm font-semibold tracking-tight text-bone">
              {t("themeEditor.title")}
            </h2>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-bone-muted">
            {isEditingUserTheme
              ? t("themeEditor.editingUserSubtitle", { name: baseManifest?.name ?? manifest.name })
              : t("themeEditor.customizingSubtitle", { name: baseManifest?.name ?? manifest.name })}
          </p>
        </div>

        <button
          type="button"
          disabled={saving}
          onClick={discardAndClose}
          aria-label={t("themeEditor.closeAndRevert")}
          title={t("themeEditor.closeAndRevert")}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[2px] border border-transparent text-bone-muted transition-colors hover:border-rule hover:bg-surface-2 hover:text-bone focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none disabled:opacity-45"
        >
          <X size={14} aria-hidden />
        </button>
      </header>

      {/* Scrollable controls */}
      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {/* Live miniature preview (useful when 3D brain is not the active tab) */}
        <div className="overflow-hidden rounded-[2px] border border-rule">
          <ThemeMiniPreview manifest={manifest} />
          <div className="flex items-center justify-between bg-surface-2 px-2.5 py-1.5 font-mono text-[10px] text-bone-muted">
            <span>{t("themeEditor.livePreviewBadge")}</span>
            {dirty && <span className="text-ochre">{t("themeEditor.unsavedBadge")}</span>}
          </div>
        </div>

        {/* 1. Mode & Accent */}
        <section className="space-y-3 border-t border-rule pt-4 first:border-t-0 first:pt-0">
          <h3 className="font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-bone-subtle">
            {t("themeEditor.sections.theme")}
          </h3>

          {/* Light / Dark */}
          <div className="space-y-1.5">
            <span className="block text-xs font-medium text-bone">
              {t("themeEditor.modeLabel")}
            </span>
            <div
              role="group"
              aria-label={t("themeEditor.modeLabel")}
              className="grid grid-cols-2 overflow-hidden rounded-[2px] border border-rule-strong bg-void"
            >
              {(["light", "dark"] as const).map((m) => {
                const active = currentUi.mode === m;
                return (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={active}
                    onClick={() => patchUi({ mode: m })}
                    className={`inline-flex items-center justify-center gap-1.5 py-1.5 text-xs font-medium transition-colors focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none ${
                      active
                        ? "bg-cobalt text-on-accent"
                        : "text-bone-muted hover:bg-surface-2 hover:text-bone"
                    }`}
                  >
                    {m === "light" ? <Sun size={12} aria-hidden /> : <Moon size={12} aria-hidden />}
                    <span>{t(`themeEditor.modes.${m}`)}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Accent swatches + picker */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-bone">{t("themeEditor.accentLabel")}</span>
              <span className="font-mono text-[11px] uppercase text-bone-muted">
                {normalizeHexColor(currentUi.accent)}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {ACCENT_SWATCHES.map((swatch) => {
                const selected =
                  normalizeHexColor(currentUi.accent) === normalizeHexColor(swatch);
                return (
                  <button
                    key={swatch}
                    type="button"
                    aria-label={t("themeEditor.accentSwatchAria", { color: swatch })}
                    aria-pressed={selected}
                    onClick={() => patchUi({ accent: swatch })}
                    className={`h-6 w-6 rounded-full border-2 transition-transform motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-cobalt-ink focus-visible:outline-none ${
                      selected
                        ? "scale-110 border-bone ring-1 ring-cobalt"
                        : "border-transparent hover:scale-105"
                    }`}
                    style={{ backgroundColor: swatch }}
                  />
                );
              })}
              <label className="relative inline-flex h-6 w-8 cursor-pointer items-center justify-center overflow-hidden rounded-[2px] border border-rule-strong bg-void">
                <input
                  type="color"
                  value={normalizeHexColor(currentUi.accent)}
                  onChange={(e) => patchUi({ accent: normalizeHexColor(e.target.value) })}
                  aria-label={t("themeEditor.customAccentAria")}
                  className="h-full w-full cursor-pointer border-0 bg-transparent"
                />
              </label>
            </div>
          </div>

          {/* Base Hue */}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <label htmlFor={hueInputId} className="font-medium text-bone">
                {t("themeEditor.baseHueLabel")}
              </label>
              <output
                htmlFor={hueInputId}
                className="font-mono text-[11px] tabular-nums text-bone-muted"
              >
                {Math.round(currentUi.base_hue)}°
              </output>
            </div>
            <input
              id={hueInputId}
              type="range"
              min={0}
              max={360}
              step={1}
              value={Math.round(currentUi.base_hue)}
              onChange={(e) => patchUi({ base_hue: Number(e.target.value) })}
              className="w-full"
            />
          </div>

          {/* Base Tint */}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <label htmlFor={tintInputId} className="font-medium text-bone">
                {t("themeEditor.baseTintLabel")}
              </label>
              <output
                htmlFor={tintInputId}
                className="font-mono text-[11px] tabular-nums text-bone-muted"
              >
                {Math.round(currentUi.base_tint)}
              </output>
            </div>
            <input
              id={tintInputId}
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round(currentUi.base_tint)}
              onChange={(e) => patchUi({ base_tint: Number(e.target.value) })}
              className="w-full"
            />
          </div>

          {/* Contrast */}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <label htmlFor={contrastInputId} className="font-medium text-bone">
                {t("themeEditor.contrastLabel")}
              </label>
              <output
                htmlFor={contrastInputId}
                className="font-mono text-[11px] tabular-nums text-bone-muted"
              >
                {Math.round(currentUi.contrast)}
              </output>
            </div>
            <input
              id={contrastInputId}
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round(currentUi.contrast)}
              onChange={(e) => patchUi({ contrast: Number(e.target.value) })}
              className="w-full"
            />
          </div>
        </section>

        {/* 2. Layout, Shape & Interface Size */}
        <section className="space-y-3 border-t border-rule pt-4">
          <h3 className="font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-bone-subtle">
            {t("themeEditor.sections.layout")}
          </h3>

          {/* Density */}
          <div className="space-y-1.5">
            <span className="block text-xs font-medium text-bone">
              {t("themeEditor.densityLabel")}
            </span>
            <div
              role="group"
              aria-label={t("themeEditor.densityLabel")}
              className="grid grid-cols-3 overflow-hidden rounded-[2px] border border-rule-strong bg-void"
            >
              {DENSITY_OPTIONS.map((density) => {
                const active = currentUi.density === density;
                return (
                  <button
                    key={density}
                    type="button"
                    aria-pressed={active}
                    onClick={() => patchUi({ density })}
                    className={`py-1.5 text-[11px] font-medium transition-colors focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none ${
                      active
                        ? "bg-cobalt text-on-accent"
                        : "text-bone-muted hover:bg-surface-2 hover:text-bone"
                    }`}
                  >
                    {t(`themeEditor.densities.${density}`)}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Corner radius */}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <label htmlFor={radiusInputId} className="font-medium text-bone">
                {t("themeEditor.radiusLabel")}
              </label>
              <output
                htmlFor={radiusInputId}
                className="font-mono text-[11px] tabular-nums text-bone-muted"
              >
                {Math.round(currentUi.radius)} px
              </output>
            </div>
            <input
              id={radiusInputId}
              type="range"
              min={0}
              max={16}
              step={1}
              value={Math.round(currentUi.radius)}
              onChange={(e) => patchUi({ radius: Number(e.target.value) })}
              className="w-full"
            />
          </div>

          {/* Interface size */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-bone">{t("settings.uiSizeTitle")}</span>
              <span className="font-mono text-[10px] text-bone-subtle">
                {t("themeEditor.deviceLocalHint")}
              </span>
            </div>
            <div
              role="group"
              aria-label={t("settings.uiSizeTitle")}
              className="grid grid-cols-3 overflow-hidden rounded-[2px] border border-rule-strong bg-void"
            >
              {UI_SIZE_OPTIONS.map((size: UiSize) => {
                const active = uiSize === size;
                return (
                  <button
                    key={size}
                    type="button"
                    aria-pressed={active}
                    onClick={() => previewUiSize(size)}
                    className={`py-1.5 text-[11px] font-medium transition-colors focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none ${
                      active
                        ? "bg-cobalt text-on-accent"
                        : "text-bone-muted hover:bg-surface-2 hover:text-bone"
                    }`}
                  >
                    {t(`settings.uiSizes.${size}`)}
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        {/* 3. 3D Brain Colors */}
        <section className="space-y-3 border-t border-rule pt-4">
          <h3 className="font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-bone-subtle">
            {t("themeEditor.sections.brain")}
          </h3>

          {/* Brain background */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-bone">{t("themeEditor.brainBgLabel")}</span>
              <span className="font-mono text-[11px] uppercase text-bone-muted">
                {normalizeHexColor(manifest.palette.background, "#05070D")}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {BRAIN_BG_SWATCHES.map((swatch) => {
                const selected =
                  normalizeHexColor(manifest.palette.background, "#05070D") ===
                  normalizeHexColor(swatch);
                return (
                  <button
                    key={swatch}
                    type="button"
                    aria-label={t("themeEditor.brainBgSwatchAria", { color: swatch })}
                    aria-pressed={selected}
                    onClick={() => setBrainBackground(swatch)}
                    className={`h-6 w-6 rounded-[2px] border transition-transform motion-reduce:transition-none focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none ${
                      selected
                        ? "scale-110 border-cobalt ring-1 ring-cobalt"
                        : "border-rule-strong hover:scale-105"
                    }`}
                    style={{ backgroundColor: swatch }}
                  />
                );
              })}
              <label className="relative inline-flex h-6 w-8 cursor-pointer items-center justify-center overflow-hidden rounded-[2px] border border-rule-strong bg-void">
                <input
                  type="color"
                  value={normalizeHexColor(manifest.palette.background, "#05070D")}
                  onChange={(e) => setBrainBackground(e.target.value)}
                  aria-label={t("themeEditor.brainBgCustomAria")}
                  className="h-full w-full cursor-pointer border-0 bg-transparent"
                />
              </label>
            </div>
          </div>

          {/* Category colors */}
          <div className="space-y-2">
            <span className="block text-xs font-medium text-bone">
              {t("themeEditor.categoryColorsLabel")}
            </span>
            <div className="grid grid-cols-2 gap-2">
              {MEMORY_CATEGORIES.map((category) => {
                const colorHex = normalizeHexColor(
                  manifest.palette.category_colors[category] ?? manifest.palette.node,
                  "#3B82F6",
                );
                return (
                  <label
                    key={category}
                    className="flex cursor-pointer items-center justify-between gap-2 rounded-[2px] border border-rule bg-void px-2 py-1.5 hover:border-rule-strong"
                  >
                    <span className="truncate text-[11px] text-bone">
                      {t(`categories.${category}`)}
                    </span>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <span className="font-mono text-[9px] uppercase text-bone-subtle">
                        {colorHex}
                      </span>
                      <input
                        type="color"
                        value={colorHex}
                        onChange={(e) => setCategoryColor(category, e.target.value)}
                        aria-label={t("themeEditor.categoryColorAria", {
                          category: t(`categories.${category}`),
                        })}
                        className="h-4 w-5 cursor-pointer rounded-[2px] border border-rule-strong bg-transparent"
                      />
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
        </section>
      </div>

      {/* Footer: inline save prompt + actions */}
      <footer className="space-y-2.5 border-t border-rule bg-surface-2 px-4 py-3.5">
        {savePromptOpen ? (
          <form onSubmit={(e) => void handleSaveSubmit(e)} className="space-y-2.5">
            <div className="space-y-1">
              <label
                htmlFor={nameInputId}
                className="block font-mono text-[10px] uppercase tracking-[0.1em] text-bone-subtle"
              >
                {t("themeEditor.themeNameLabel")}
              </label>
              <input
                ref={nameInputRef}
                id={nameInputId}
                type="text"
                maxLength={60}
                disabled={saving}
                value={themeName}
                onChange={(e) => {
                  setThemeName(e.target.value);
                  if (saveError) setSaveError(null);
                }}
                placeholder={t("themeEditor.themeNamePlaceholder")}
                className="h-8 w-full rounded-[2px] border border-rule-strong bg-void px-2.5 text-xs text-bone placeholder:text-bone-subtle focus:border-cobalt-ink focus:outline-none disabled:opacity-45"
              />
              <div className="flex items-center justify-between font-mono text-[10px] text-bone-subtle">
                <span className="truncate">
                  {isEditingUserTheme
                    ? t("themeEditor.overwriteHint", { id: computedId })
                    : t("themeEditor.slugPreview", { id: computedId })}
                </span>
              </div>
            </div>

            <ErrorAlert error={saveError} compact />

            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={saving}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-3 py-1.5 font-mono text-xs font-semibold text-on-accent hover:bg-cobalt-bright disabled:opacity-45"
              >
                {saving ? (
                  <Loader2 size={12} className="animate-spin" aria-hidden />
                ) : (
                  <Check size={12} aria-hidden />
                )}
                {saving ? t("themeEditor.saving") : t("themeEditor.confirmSave")}
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  setSavePromptOpen(false);
                  setSaveError(null);
                }}
                className="rounded-[2px] border border-rule-strong bg-surface px-3 py-1.5 font-mono text-xs text-bone-muted hover:text-bone disabled:opacity-45"
              >
                {t("common.cancel")}
              </button>
            </div>
          </form>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setSavePromptOpen(true)}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-3 py-2 font-mono text-xs font-semibold text-on-accent hover:bg-cobalt-bright focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none"
            >
              <Save size={13} aria-hidden />
              {t("themeEditor.saveAsTheme")}
            </button>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={resetEditor}
                disabled={!dirty}
                className="inline-flex items-center justify-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface px-2.5 py-1.5 font-mono text-[11px] text-bone-muted hover:text-bone disabled:opacity-45"
              >
                <RotateCcw size={11} aria-hidden />
                {t("themeEditor.reset")}
              </button>
              <button
                type="button"
                onClick={discardAndClose}
                className="inline-flex items-center justify-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface px-2.5 py-1.5 font-mono text-[11px] text-bone-muted hover:border-cinnabar-rule hover:text-cinnabar"
              >
                <X size={11} aria-hidden />
                {t("themeEditor.discard")}
              </button>
            </div>
          </>
        )}
      </footer>
    </aside>
  );
}
