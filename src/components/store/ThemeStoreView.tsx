import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Check,
  Download,
  FileArchive,
  Layers,
  Loader2,
  Moon,
  Palette,
  Pencil,
  RefreshCw,
  Search,
  Share2,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
  Upload,
} from "lucide-react";
import { backendCall } from "@/lib/backend";
import { pickSavePath, pickSinglePath, useFileDrop } from "@/lib/dialogs";
import { formatBytes } from "@/lib/format";
import { toDisplayError, type DisplayError } from "@/lib/friendlyError";
import { staggerStyle } from "@/lib/motion";
import { isBuiltinThemeId, resolvePreviewTokens } from "@/lib/themeEngine";
import { useSettingsStore, useThemeStore, useUiStore } from "@/stores";
import { ThemeWarningsBanner } from "@/components/canvas3d";
import { ErrorAlert, Skeleton } from "@/components/ui";
import { MINIMAL_THEME_MANIFEST } from "@/themes/minimal";
import {
  BUILTIN_THEME_ID,
  BUILTIN_THEME_IDS,
  type ThemeCard,
  type ThemeCompatibility,
  type ThemeManifest,
} from "@/types/contracts";
import { ThemeMiniPreview } from "./ThemeMiniPreview";

function compatibilityStyle(compat: ThemeCompatibility): string {
  switch (compat) {
    case "compatible":
      return "border-verdigris-rule bg-verdigris-wash text-verdigris";
    case "degraded":
      return "border-ochre-rule bg-ochre-wash text-ochre";
    default:
      return "border-cinnabar-rule bg-cinnabar-wash text-cinnabar";
  }
}

export function ThemeStoreView() {
  const { t } = useTranslation();

  const activeThemeId = useThemeStore((s) => s.activeThemeId);
  const manifest = useThemeStore((s) => s.committedManifest);
  const installedThemes = useThemeStore((s) => s.installedThemes);
  const themesVersion = useThemeStore((s) => s.themesVersion);
  const setActiveTheme = useThemeStore((s) => s.setActiveTheme);
  const loadInstalledThemes = useThemeStore((s) => s.loadInstalledThemes);
  const openThemeEditor = useThemeStore((s) => s.openThemeEditor);
  const pushThemeToast = useThemeStore((s) => s.pushThemeToast);
  const patchSettings = useSettingsStore((s) => s.patchSettings);
  const optionalTools = useSettingsStore((s) => s.settings.mcp.optional_tools);
  const openConnectorsSection = useUiStore((s) => s.openConnectorsSection);
  const createThemeEnabled = optionalTools.includes("create_theme");

  const [builtinManifests, setBuiltinManifests] = useState<ThemeManifest[]>([]);
  const [userManifests, setUserManifests] = useState<Record<string, ThemeManifest>>({});
  const [loadingBuiltins, setLoadingBuiltins] = useState(true);
  const [query, setQuery] = useState("");
  const [cards, setCards] = useState<ThemeCard[]>([]);
  const [searching, setSearching] = useState(true);
  const [registryError, setRegistryError] = useState<DisplayError | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [installingFile, setInstallingFile] = useState(false);
  const [brokenImages, setBrokenImages] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<DisplayError | string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const flashNotice = useCallback((msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 3200);
  }, []);

  const loadBuiltinManifests = useCallback(async () => {
    setLoadingBuiltins(true);
    try {
      const loaded = await Promise.all(
        BUILTIN_THEME_IDS.map(async (id) => {
          try {
            return await backendCall("get_theme_manifest", { theme_id: id });
          } catch {
            return id === BUILTIN_THEME_ID ? MINIMAL_THEME_MANIFEST : null;
          }
        }),
      );
      setBuiltinManifests(loaded.filter((item): item is ThemeManifest => item !== null));
    } finally {
      setLoadingBuiltins(false);
    }
  }, []);

  const searchRegistry = useCallback(async (q: string) => {
    setSearching(true);
    setRegistryError(null);
    try {
      const result = await backendCall("search_theme_registry", {
        query: q.trim() || null,
      });
      setCards(result);
    } catch (err: unknown) {
      setCards([]);
      setRegistryError(toDisplayError(err, t, "search_theme_registry"));
    } finally {
      setSearching(false);
    }
  }, [t]);

  useEffect(() => {
    void loadBuiltinManifests();
    void loadInstalledThemes();
    void searchRegistry("");
  }, [loadBuiltinManifests, loadInstalledThemes, searchRegistry]);

  // Refresh installed list & search cards when themes change externally (e.g. AI create_theme or editor save)
  useEffect(() => {
    if (themesVersion === 0) return;
    void loadInstalledThemes();
    void searchRegistry(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themesVersion]);

  const myThemes = useMemo(
    () => installedThemes.filter((item) => !isBuiltinThemeId(item.id)),
    [installedThemes],
  );

  // Load manifests for user/AI themes so cards render live ThemeMiniPreviews and edit smoothly
  useEffect(() => {
    let cancelled = false;
    if (myThemes.length === 0) {
      setUserManifests({});
      return;
    }
    void Promise.all(
      myThemes.map(async (theme) => {
        try {
          const loaded = await backendCall("get_theme_manifest", { theme_id: theme.id });
          return [theme.id, loaded] as const;
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      const next: Record<string, ThemeManifest> = {};
      for (const entry of entries) {
        if (entry) {
          next[entry[0]] = entry[1];
        }
      }
      setUserManifests(next);
    });
    return () => {
      cancelled = true;
    };
  }, [myThemes, themesVersion]);

  const handleApplyTheme = useCallback(
    async (themeId: string, themeName?: string) => {
      setBusyId(themeId);
      setError(null);
      try {
        const applied = await setActiveTheme(themeId);
        if (applied) {
          await patchSettings({ active_theme_id: themeId });
          flashNotice(t("store.appliedNotice", { id: themeName ?? themeId }));
        } else {
          setError(t("store.applyError"));
        }
      } catch (err: unknown) {
        setError(toDisplayError(err, t, "get_theme_manifest"));
      } finally {
        setBusyId(null);
      }
    },
    [flashNotice, patchSettings, setActiveTheme, t],
  );

  const handleEditUserTheme = async (themeId: string) => {
    setBusyId(themeId);
    setError(null);
    try {
      const cached = userManifests[themeId];
      const loaded = cached ?? (await backendCall("get_theme_manifest", { theme_id: themeId }));
      openThemeEditor({ manifest: loaded, mode: "edit" });
    } catch (err: unknown) {
      setError(toDisplayError(err, t, "get_theme_manifest"));
    } finally {
      setBusyId(null);
    }
  };

  const handleExportTheme = async (themeId: string, themeName: string) => {
    if (isBuiltinThemeId(themeId)) return;
    setError(null);
    const destPath = await pickSavePath({
      title: t("store.exportDialogTitle"),
      defaultPath: `${themeId}.cobalt-theme`,
      filters: [{ name: "Cobalt Theme", extensions: ["cobalt-theme"] }],
    });
    if (!destPath) return;

    setExportingId(themeId);
    try {
      const bytes = await backendCall("export_theme", {
        theme_id: themeId,
        path: destPath,
      });
      pushThemeToast({
        kind: "exported",
        message: t("store.exportedToast", {
          name: themeName,
          size: formatBytes(bytes),
        }),
      });
    } catch (err: unknown) {
      setError(toDisplayError(err, t, "export_theme"));
    } finally {
      setExportingId(null);
    }
  };

  const handleInstallFromRegistry = async (themeId: string) => {
    setBusyId(themeId);
    setError(null);
    try {
      const installed = await backendCall("install_theme", { theme_id: themeId });
      await Promise.all([loadInstalledThemes(), searchRegistry(query)]);
      flashNotice(t("store.installedNotice", { name: installed.name }));
    } catch (err: unknown) {
      setError(toDisplayError(err, t, "install_theme"));
    } finally {
      setBusyId(null);
    }
  };

  const handleUninstallTheme = async (themeId: string) => {
    if (isBuiltinThemeId(themeId)) return;
    setBusyId(themeId);
    setError(null);
    try {
      await backendCall("uninstall_theme", { theme_id: themeId });
      if (activeThemeId === themeId) {
        await setActiveTheme(BUILTIN_THEME_ID);
        await patchSettings({ active_theme_id: BUILTIN_THEME_ID });
      }
      await Promise.all([loadInstalledThemes(), searchRegistry(query)]);
      flashNotice(t("store.uninstalledNotice"));
    } catch (err: unknown) {
      setError(toDisplayError(err, t, "uninstall_theme"));
    } finally {
      setBusyId(null);
    }
  };

  const handleInstallThemeFilePath = useCallback(
    async (path: string) => {
      setInstallingFile(true);
      setError(null);
      try {
        const installed = await backendCall("install_theme_file", { path });
        await Promise.all([loadInstalledThemes(), searchRegistry(query)]);
        await handleApplyTheme(installed.id, installed.name);
        flashNotice(t("store.installedNotice", { name: installed.name }));
      } catch (err: unknown) {
        setError(toDisplayError(err, t, "install_theme_file"));
      } finally {
        setInstallingFile(false);
      }
    },
    [flashNotice, handleApplyTheme, loadInstalledThemes, query, searchRegistry, t],
  );

  const { isDragging } = useFileDrop((paths) => {
    const themeFile = paths.find((p) => p.toLowerCase().endsWith(".cobalt-theme")) ?? paths[0];
    if (themeFile) {
      void handleInstallThemeFilePath(themeFile);
    }
  }, !installingFile);

  const handlePickThemeFile = async () => {
    const path = await pickSinglePath({
      title: t("store.installFileDialogTitle"),
      filters: [{ name: "Cobalt Theme", extensions: ["cobalt-theme"] }],
    });
    if (path) {
      await handleInstallThemeFilePath(path);
    }
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void searchRegistry(query);
  };

  const activePreviewTokens = useMemo(() => resolvePreviewTokens(manifest), [manifest]);
  const activeSwatches = manifest.ui
    ? [
        activePreviewTokens.void,
        activePreviewTokens.surface2,
        activePreviewTokens.bone,
        activePreviewTokens.cobalt,
        manifest.palette.node,
      ]
    : [
        manifest.palette.background,
        manifest.palette.node,
        manifest.palette.core_pin,
        manifest.palette.reusable,
        manifest.palette.edge,
      ];

  const resolveBuiltinDescription = (theme: ThemeManifest): string | null => {
    const i18nKey = `store.builtinDescriptions.${theme.id}`;
    const translated = t(i18nKey, { defaultValue: "" });
    return translated || theme.description;
  };

  return (
    <div className="relative h-full overflow-y-auto bg-void p-6 lg:p-8">
      {isDragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-void/80 backdrop-blur-xs">
          <div className="flex flex-col items-center gap-3 rounded-[2px] border-2 border-dashed border-cobalt bg-cobalt-wash/90 px-10 py-8 text-center">
            <FileArchive size={28} className="text-cobalt-ink" aria-hidden />
            <div className="text-lg font-semibold tracking-tight text-bone">
              {t("store.dropOverlayTitle")}
            </div>
            <p className="text-xs text-bone-muted">{t("store.dropOverlayHint")}</p>
          </div>
        </div>
      )}

      <div className="@container mx-auto max-w-6xl space-y-6">
        {/* Header */}
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-rule pb-5">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-2xl font-semibold tracking-tight text-bone sm:text-3xl">
                {t("store.title")}
              </h1>
            </div>
            <p className="mt-1.5 text-sm text-bone-muted">{t("store.subtitle")}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => openThemeEditor()}
              className="inline-flex items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-3 py-1.5 font-mono text-xs font-semibold text-on-accent hover:bg-cobalt-bright"
            >
              <SlidersHorizontal size={12} aria-hidden />
              {t("store.customizeButton")}
            </button>
            <button
              type="button"
              disabled={installingFile}
              onClick={() => void handlePickThemeFile()}
              className="inline-flex items-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface px-3 py-1.5 font-mono text-xs font-medium text-bone hover:border-cobalt-ink/60 hover:bg-surface-2 disabled:opacity-45"
            >
              {installingFile ? (
                <Loader2 size={12} className="animate-spin" aria-hidden />
              ) : (
                <Upload size={12} aria-hidden />
              )}
              {t("store.installLocalButton")}
            </button>
            <button
              type="button"
              disabled={searching}
              onClick={() => void searchRegistry(query)}
              className="inline-flex items-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface px-3 py-1.5 font-mono text-xs text-bone-muted hover:text-bone disabled:opacity-45"
            >
              <RefreshCw size={12} className={searching ? "animate-spin" : ""} aria-hidden />
              {t("common.refresh")}
            </button>
          </div>
        </header>

        <ErrorAlert error={error} />
        {notice && (
          <div className="flex items-center gap-2 rounded-[2px] border border-verdigris-rule bg-verdigris-wash px-4 py-2.5 font-mono text-xs text-verdigris">
            <Check size={13} aria-hidden />
            <span>{notice}</span>
          </div>
        )}

        {/* Active theme banner */}
        <section className="rounded-[2px] border border-cobalt-rule border-t-2 border-t-cobalt bg-surface p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <Palette size={15} className="text-cobalt-ink" aria-hidden />
                <h2 className="text-lg font-semibold tracking-tight text-bone">{manifest.name}</h2>
                <span className="rounded-[2px] border border-rule bg-void px-2 py-0.5 font-mono text-[10px] text-bone-muted">
                  v{manifest.version}
                </span>
                <span className="rounded-[2px] border border-rule bg-void px-2 py-0.5 font-mono text-[10px] text-bone-muted">
                  {manifest.ui ? t("store.wholeAppBadge") : t("store.brainOnlyBadge")}
                </span>
                <span className="rounded-[2px] border border-rule bg-void px-2 py-0.5 font-mono text-[10px] text-bone-muted">
                  {t(`brain.layouts.${manifest.layout_type}`)}
                </span>
              </div>
              {(isBuiltinThemeId(manifest.id)
                ? resolveBuiltinDescription(manifest)
                : manifest.description) && (
                <p className="mt-1.5 text-xs text-bone-muted">
                  {isBuiltinThemeId(manifest.id)
                    ? resolveBuiltinDescription(manifest)
                    : manifest.description}
                </p>
              )}
              <div className="mt-3 flex items-center gap-1.5">
                {activeSwatches.map((color, index) => (
                  <span
                    key={`${color}-${index}`}
                    title={color}
                    className="h-5 w-5 rounded-[2px] border border-rule-strong"
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.08em]">
              {isBuiltinThemeId(activeThemeId) && (
                <span className="rounded-[2px] border border-rule bg-void px-2.5 py-1 text-bone-muted">
                  {t("store.builtin")}
                </span>
              )}
              <span className="inline-flex items-center gap-1 rounded-[2px] border border-verdigris-rule bg-verdigris-wash px-2.5 py-1 font-medium text-verdigris">
                <Check size={11} aria-hidden />
                {t("store.inUse")}
              </span>
            </div>
          </div>

          {/* Sharing + AI creation hints */}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-rule pt-3 text-xs text-bone-muted">
            <div className="flex items-center gap-2">
              <Share2 size={13} className="shrink-0 text-cobalt-ink" aria-hidden />
              <span>{t("store.shareExplain")}</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-cobalt-ink">
              <Sparkles size={13} className="shrink-0" aria-hidden />
              <span>{t("store.askAiHint")}</span>
              <span className="text-bone-muted">
                (
                {createThemeEnabled
                  ? t("store.askAiToolEnabledNote")
                  : t("store.askAiToolRequiredNote")}{" "}
                <button
                  type="button"
                  onClick={() => openConnectorsSection("ai_tools")}
                  className="font-medium text-cobalt-ink underline decoration-cobalt-ink/50 underline-offset-2 hover:text-cobalt-bright"
                >
                  {t("nav.connectors")}
                </button>
                )
              </span>
            </div>
          </div>
        </section>

        {/* Non-blocking runtime warnings from active theme shaders / custom meshes */}
        <ThemeWarningsBanner />

        {/* 01 — My themes (user-created, AI-created, and file-installed themes) */}
        <section className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-bone-subtle">
                01 — {t("store.myThemesSection")}
              </h2>
              <p className="mt-0.5 text-xs text-bone-muted">{t("store.myThemesDesc")}</p>
            </div>
            <span className="font-mono text-[10px] text-bone-subtle">
              {t("store.dropHintInline")}
            </span>
          </div>

          {myThemes.length === 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-[2px] border border-dashed border-rule-strong bg-surface/70 px-5 py-4">
              <div className="space-y-1">
                <p className="text-sm font-medium text-bone">{t("store.myThemesEmptyTitle")}</p>
                <p className="text-xs text-bone-muted">{t("store.myThemesEmptyDesc")}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => openThemeEditor()}
                  className="inline-flex items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-3 py-1.5 font-mono text-xs font-semibold text-on-accent hover:bg-cobalt-bright"
                >
                  <SlidersHorizontal size={12} aria-hidden />
                  {t("store.customizeButton")}
                </button>
                <button
                  type="button"
                  disabled={installingFile}
                  onClick={() => void handlePickThemeFile()}
                  className="inline-flex items-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface-2 px-3 py-1.5 font-mono text-xs text-bone hover:border-cobalt-ink/60 disabled:opacity-45"
                >
                  <Upload size={12} aria-hidden />
                  {t("store.installLocalButton")}
                </button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 items-stretch gap-4 @xl:grid-cols-2 @4xl:grid-cols-3">
              {myThemes.map((theme, idx) => {
                const isActive = activeThemeId === theme.id;
                const isBusy = busyId === theme.id;
                const isExporting = exportingId === theme.id;
                const themeManifest = userManifests[theme.id];
                const previewTokens = themeManifest ? resolvePreviewTokens(themeManifest) : null;
                const swatches = previewTokens
                  ? [
                      previewTokens.void,
                      previewTokens.surface2,
                      previewTokens.bone,
                      previewTokens.cobalt,
                    ]
                  : [];

                return (
                  <article
                    key={theme.id}
                    style={staggerStyle(idx, 24, 6)}
                    className={`@container/card cobalt-stagger-item flex h-full flex-col overflow-hidden rounded-[2px] border transition-colors ${
                      isActive
                        ? "border-cobalt-rule bg-cobalt-wash/35 ring-1 ring-cobalt/40"
                        : "border-rule bg-surface hover:border-rule-strong"
                    }`}
                  >
                    {themeManifest ? (
                      <ThemeMiniPreview manifest={themeManifest} />
                    ) : (
                      <div className="cobalt-grid-bg flex h-36 w-full items-center justify-center border-b border-rule text-bone-subtle">
                        <Palette size={20} aria-hidden />
                      </div>
                    )}

                    <div className="flex flex-1 flex-col justify-between gap-3 p-4">
                      <div className="space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <h3 className="truncate text-base font-semibold tracking-tight text-bone">
                              {theme.name}
                            </h3>
                            <p className="mt-0.5 truncate font-mono text-[10px] text-bone-subtle">
                              {theme.author} · v{theme.version} · {formatBytes(theme.size_bytes)}
                            </p>
                          </div>

                          {swatches.length > 0 && (
                            <div className="flex shrink-0 items-center gap-1 pt-0.5">
                              {swatches.map((color, sIdx) => (
                                <span
                                  key={`${theme.id}-sw-${sIdx}`}
                                  className="h-4 w-4 rounded-[2px] border border-rule-strong"
                                  style={{ backgroundColor: color }}
                                />
                              ))}
                            </div>
                          )}
                        </div>

                        {themeManifest?.description && (
                          <p className="line-clamp-2 text-xs leading-relaxed text-bone-muted">
                            {themeManifest.description}
                          </p>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-1.5 border-t border-rule pt-3">
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          {isActive ? (
                            <span className="inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-[2px] border border-verdigris-rule bg-verdigris-wash px-2 font-mono text-[10px] font-semibold text-verdigris">
                              <Check size={11} className="shrink-0" aria-hidden />
                              <span>{t("store.inUse")}</span>
                            </span>
                          ) : (
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => void handleApplyTheme(theme.id, theme.name)}
                              className="inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-[2px] border border-cobalt-rule bg-cobalt px-2.5 font-mono text-[10px] font-semibold text-on-accent hover:bg-cobalt-bright disabled:opacity-45"
                            >
                              {isBusy ? (
                                <Loader2 size={10} className="shrink-0 animate-spin" aria-hidden />
                              ) : (
                                <Sparkles size={10} className="shrink-0" aria-hidden />
                              )}
                              <span>{t("store.applyShort")}</span>
                            </button>
                          )}

                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => void handleEditUserTheme(theme.id)}
                            title={t("store.editButton")}
                            aria-label={t("store.editButton")}
                            className="inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-[2px] border border-rule-strong bg-surface-2 px-2 font-mono text-[10px] text-bone hover:border-cobalt-ink/60 disabled:opacity-45"
                          >
                            <Pencil size={10} className="shrink-0" aria-hidden />
                            <span className="hidden @[230px]/card:inline">{t("store.editButton")}</span>
                          </button>

                          <button
                            type="button"
                            disabled={isBusy || isExporting}
                            onClick={() => void handleExportTheme(theme.id, theme.name)}
                            title={t("store.exportButton")}
                            aria-label={t("store.exportButton")}
                            className="inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-[2px] border border-rule-strong bg-surface-2 px-2 font-mono text-[10px] text-bone hover:border-cobalt-ink/60 disabled:opacity-45"
                          >
                            {isExporting ? (
                              <Loader2 size={10} className="shrink-0 animate-spin" aria-hidden />
                            ) : (
                              <Share2 size={10} className="shrink-0" aria-hidden />
                            )}
                            <span className="hidden @[270px]/card:inline">{t("store.exportButton")}</span>
                          </button>
                        </div>

                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleUninstallTheme(theme.id)}
                          aria-label={t("store.deleteButton")}
                          title={t("store.deleteButton")}
                          className="inline-flex h-7 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-[2px] border border-cinnabar-rule/70 bg-cinnabar-wash/60 px-2 font-mono text-[10px] text-cinnabar hover:bg-cinnabar hover:text-on-accent disabled:opacity-45"
                        >
                          <Trash2 size={11} className="shrink-0" aria-hidden />
                          <span className="hidden @[310px]/card:inline">{t("store.deleteButton")}</span>
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        {/* 02 — Included with Cobalt (5 built-in themes: Apply + Customize, never Export/Delete) */}
        <section className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-bone-subtle">
                02 — {t("store.builtinSection")}
              </h2>
              <p className="mt-0.5 text-xs text-bone-muted">{t("store.builtinSectionDesc")}</p>
            </div>
          </div>

          {loadingBuiltins && builtinManifests.length === 0 ? (
            <div
              className="grid grid-cols-1 gap-4 @xl:grid-cols-2 @4xl:grid-cols-3"
              aria-busy="true"
              aria-label={t("store.loadingBuiltins")}
            >
              {[0, 1, 2].map((idx) => (
                <div
                  key={idx}
                  className="overflow-hidden rounded-[2px] border border-rule bg-surface"
                >
                  <Skeleton className="h-36 w-full rounded-none" />
                  <div className="space-y-3 p-4">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-full" />
                    <div className="flex items-center justify-between border-t border-rule pt-3">
                      <Skeleton className="h-3 w-16" />
                      <Skeleton className="h-6 w-20" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 items-stretch gap-4 @xl:grid-cols-2 @4xl:grid-cols-3">
              {builtinManifests.map((theme, idx) => {
                const isActive = activeThemeId === theme.id;
                const isBusy = busyId === theme.id;
                const previewTokens = resolvePreviewTokens(theme);
                const swatches = [
                  previewTokens.void,
                  previewTokens.surface2,
                  previewTokens.bone,
                  previewTokens.cobalt,
                ];
                const description = resolveBuiltinDescription(theme);

                return (
                  <article
                    key={theme.id}
                    style={staggerStyle(idx, 26, 6)}
                    className={`@container/card cobalt-stagger-item flex h-full flex-col overflow-hidden rounded-[2px] border transition-colors ${
                      isActive
                        ? "border-cobalt-rule bg-cobalt-wash/35 ring-1 ring-cobalt/40"
                        : "border-rule bg-surface hover:border-rule-strong"
                    }`}
                  >
                    <ThemeMiniPreview manifest={theme} />

                    <div className="flex flex-1 flex-col justify-between gap-3 p-4">
                      <div className="space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <h3 className="truncate text-base font-semibold tracking-tight text-bone">
                              {theme.name}
                            </h3>
                            <div className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-bone-subtle">
                              <span className="inline-flex items-center gap-1 rounded-[2px] border border-rule bg-void px-1.5 py-0.5 text-bone-muted">
                                {theme.ui ? (
                                  <>
                                    {theme.ui.mode === "light" ? (
                                      <Sun size={10} aria-hidden />
                                    ) : (
                                      <Moon size={10} aria-hidden />
                                    )}
                                    <span>{t("store.wholeAppBadge")}</span>
                                  </>
                                ) : (
                                  <span>{t("store.brainOnlyBadge")}</span>
                                )}
                              </span>
                              <span className="rounded-[2px] border border-rule bg-surface-2 px-1.5 py-0.5 text-bone-muted">
                                {t(`brain.layouts.${theme.layout_type}`)}
                              </span>
                            </div>
                          </div>

                          <div className="flex shrink-0 items-center gap-1 pt-0.5">
                            {swatches.map((color, sIdx) => (
                              <span
                                key={`${theme.id}-sw-${sIdx}`}
                                className="h-4 w-4 rounded-[2px] border border-rule-strong"
                                style={{ backgroundColor: color }}
                              />
                            ))}
                          </div>
                        </div>

                        {description && (
                          <p className="text-xs leading-relaxed text-bone-muted">{description}</p>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-rule pt-3">
                        <button
                          type="button"
                          onClick={() => openThemeEditor({ manifest: theme, mode: "create" })}
                          title={t("store.customizeButton")}
                          aria-label={t("store.customizeButton")}
                          className="inline-flex h-7 min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[2px] border border-rule-strong bg-surface-2 px-2.5 font-mono text-[11px] font-medium text-bone hover:border-cobalt-ink/60"
                        >
                          <SlidersHorizontal size={11} className="shrink-0" aria-hidden />
                          <span className="hidden @[220px]/card:inline">
                            {t("store.customizeButton")}
                          </span>
                        </button>

                        {isActive ? (
                          <span className="inline-flex h-7 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-[2px] border border-verdigris-rule bg-verdigris-wash px-2.5 font-mono text-[11px] font-semibold text-verdigris">
                            <Check size={12} className="shrink-0" aria-hidden />
                            <span>{t("store.inUse")}</span>
                          </span>
                        ) : (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => void handleApplyTheme(theme.id, theme.name)}
                            className="inline-flex h-7 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[2px] border border-cobalt-rule bg-cobalt px-3 font-mono text-[11px] font-semibold text-on-accent hover:bg-cobalt-bright disabled:opacity-45"
                          >
                            {isBusy ? (
                              <Loader2 size={11} className="shrink-0 animate-spin" aria-hidden />
                            ) : (
                              <Sparkles size={11} className="shrink-0" aria-hidden />
                            )}
                            <span>{t("store.applyShort")}</span>
                          </button>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        {/* 03 — Community registry search & catalog */}
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-bone-subtle">
                03 — {t("store.registrySection")}
              </h2>
              <p className="mt-0.5 text-xs text-bone-muted">{t("store.zeroHiddenDownloads")}</p>
            </div>

            <form onSubmit={handleSearchSubmit} className="flex items-center gap-2">
              <div className="relative">
                <Search
                  size={13}
                  className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-bone-subtle"
                  aria-hidden
                />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("store.searchPlaceholder")}
                  className="h-8 w-56 rounded-[2px] border border-rule-strong bg-surface pr-2.5 pl-8 text-xs text-bone placeholder:text-bone-subtle focus:border-cobalt-ink focus:outline-none"
                />
              </div>
              <button
                type="submit"
                disabled={searching}
                className="h-8 rounded-[2px] border border-cobalt-rule bg-cobalt-wash px-3 font-mono text-xs font-medium text-cobalt-ink hover:bg-cobalt hover:text-on-accent disabled:opacity-45"
              >
                {t("rag.run")}
              </button>
            </form>
          </div>

          {searching && cards.length === 0 ? (
            <div
              className="grid grid-cols-1 gap-4 @xl:grid-cols-2 @4xl:grid-cols-3"
              aria-busy="true"
              aria-label={t("store.searching")}
            >
              {[0, 1, 2].map((idx) => (
                <div
                  key={idx}
                  className="overflow-hidden rounded-[2px] border border-rule bg-surface"
                >
                  <Skeleton className="h-36 w-full rounded-none" />
                  <div className="space-y-3 p-4">
                    <Skeleton className="h-4 w-36" />
                    <Skeleton className="h-3 w-full" />
                    <div className="border-t border-rule pt-3">
                      <Skeleton className="h-7 w-full" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : registryError ? (
            <div className="rounded-[2px] border border-rule bg-surface p-8 text-center">
              <p className="text-sm font-medium text-bone">{t("store.registryErrorTitle")}</p>
              <p className="mx-auto mt-1.5 max-w-md text-xs text-bone-muted">
                {t("store.registryErrorDesc")}
              </p>
              <div className="mx-auto mt-3 max-w-md text-left">
                <ErrorAlert error={registryError} compact />
              </div>
              <button
                type="button"
                disabled={searching}
                onClick={() => void searchRegistry(query)}
                className="mt-4 inline-flex items-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface-2 px-3 py-1.5 font-mono text-xs text-bone hover:border-cobalt-ink/60 disabled:opacity-45"
              >
                <RefreshCw size={12} aria-hidden />
                {t("common.refresh")}
              </button>
            </div>
          ) : cards.length === 0 ? (
            <div className="rounded-[2px] border border-rule bg-surface p-8 text-center">
              {query.trim().length > 0 ? (
                <>
                  <p className="text-sm font-medium text-bone">{t("store.noResults")}</p>
                  <button
                    type="button"
                    onClick={() => {
                      setQuery("");
                      void searchRegistry("");
                    }}
                    className="mt-3 inline-flex items-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface-2 px-3 py-1.5 font-mono text-xs text-bone-muted hover:text-bone"
                  >
                    {t("filterDock.reset")}
                  </button>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium text-bone">{t("store.registryEmptyTitle")}</p>
                  <p className="mx-auto mt-1.5 max-w-md text-xs text-bone-muted">
                    {t("store.registryEmptyDesc")}
                  </p>
                </>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 items-stretch gap-4 @xl:grid-cols-2 @4xl:grid-cols-3">
              {cards.map((card, idx) => {
                const { entry } = card;
                const isActive = activeThemeId === entry.id;
                const isBusy = busyId === entry.id;
                const isBuiltin = isBuiltinThemeId(entry.id);
                const showPreview =
                  Boolean(entry.preview_url) && !brokenImages.has(entry.id);

                return (
                  <article
                    key={entry.id}
                    style={staggerStyle(idx, 24, 9)}
                    className="@container/card cobalt-stagger-item flex h-full flex-col overflow-hidden rounded-[2px] border border-rule bg-surface transition-colors hover:border-rule-strong"
                  >
                    {/* Preview */}
                    <div className="relative h-36 w-full border-b border-rule bg-void">
                      {showPreview ? (
                        <img
                          src={entry.preview_url}
                          alt={entry.name}
                          loading="lazy"
                          onError={() =>
                            setBrokenImages((prev) => new Set(prev).add(entry.id))
                          }
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="cobalt-grid-bg flex h-full w-full flex-col items-center justify-center gap-1.5 text-bone-subtle">
                          <Layers size={22} className="text-cobalt-ink/80" aria-hidden />
                          <span className="font-mono text-[10px] uppercase tracking-[0.12em]">
                            {t(`brain.layouts.${entry.layout_type}`)}
                          </span>
                        </div>
                      )}

                      <span
                        className={`absolute top-2.5 right-2.5 rounded-[2px] border px-2 py-0.5 font-mono text-[10px] font-medium uppercase ${compatibilityStyle(
                          card.compatibility,
                        )}`}
                      >
                        {t(`store.compatibility.${card.compatibility}`)}
                      </span>
                    </div>

                    {/* Body */}
                    <div className="flex flex-1 flex-col justify-between p-4">
                      <div className="space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <h3 className="text-base font-semibold tracking-tight text-bone">
                              {entry.name}
                            </h3>
                            <p className="font-mono text-[10px] text-bone-subtle">
                              {entry.author} · v{entry.version}
                            </p>
                          </div>
                          <span className="rounded-[2px] border border-rule bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] uppercase text-bone-muted">
                            {t(`tiers.${entry.hardware_tier}`)}
                          </span>
                        </div>

                        {entry.description && (
                          <p className="text-xs leading-relaxed text-bone-muted">
                            {entry.description}
                          </p>
                        )}

                        {card.compatibility === "degraded" && (
                          <div className="flex items-center gap-1.5 rounded-[2px] border border-ochre-rule/60 bg-ochre-wash/60 px-2 py-1 text-[10px] text-ochre">
                            <AlertTriangle size={11} className="shrink-0" aria-hidden />
                            <span>{t("store.degradedHint")}</span>
                          </div>
                        )}
                      </div>

                      {/* Exact size transparency + Actions */}
                      <div className="mt-4 space-y-2.5 border-t border-rule pt-3">
                        <div className="flex items-center justify-between font-mono text-[10px] tabular-nums text-bone-subtle">
                          <span>
                            {t("store.downloadSize")}:{" "}
                            <strong className="text-bone">
                              {formatBytes(entry.size_bytes)}
                            </strong>
                          </span>
                          <span>
                            {t("store.unpackedSize")}: {formatBytes(entry.unpacked_size_bytes)}
                          </span>
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-2">
                          {card.installed ? (
                            <>
                              {isActive ? (
                                <span className="inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-[2px] border border-verdigris-rule bg-verdigris-wash px-2.5 font-mono text-[11px] font-semibold text-verdigris">
                                  <Check size={12} className="shrink-0" aria-hidden />
                                  <span>{t("store.inUse")}</span>
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => void handleApplyTheme(entry.id, entry.name)}
                                  className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-[2px] border border-cobalt-rule bg-cobalt px-3 font-mono text-[11px] font-semibold text-on-accent hover:bg-cobalt-bright disabled:opacity-45"
                                >
                                  {isBusy ? (
                                    <Loader2 size={11} className="shrink-0 animate-spin" aria-hidden />
                                  ) : (
                                    <Sparkles size={11} className="shrink-0" aria-hidden />
                                  )}
                                  <span>{t("store.applyShort")}</span>
                                </button>
                              )}

                              {!isBuiltin && (
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => void handleUninstallTheme(entry.id)}
                                  title={t("store.uninstallButton")}
                                  aria-label={t("store.uninstallButton")}
                                  className="inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-[2px] border border-cinnabar-rule/70 bg-cinnabar-wash/60 px-2.5 font-mono text-[11px] text-cinnabar hover:bg-cinnabar hover:text-on-accent disabled:opacity-45"
                                >
                                  <Trash2 size={11} className="shrink-0" aria-hidden />
                                  <span className="hidden @[230px]/card:inline">
                                    {t("store.uninstallButton")}
                                  </span>
                                </button>
                              )}
                            </>
                          ) : (
                            <button
                              type="button"
                              disabled={isBusy || card.compatibility === "incompatible"}
                              onClick={() => void handleInstallFromRegistry(entry.id)}
                              className="inline-flex h-7 w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-[2px] border border-cobalt-rule bg-cobalt px-3 font-mono text-[11px] font-semibold text-on-accent hover:bg-cobalt-bright disabled:opacity-45"
                            >
                              {isBusy ? (
                                <Loader2 size={11} className="shrink-0 animate-spin" aria-hidden />
                              ) : (
                                <Download size={11} className="shrink-0" aria-hidden />
                              )}
                              <span>
                                {t("store.installButton", {
                                  size: formatBytes(entry.size_bytes),
                                })}
                              </span>
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
