import { useTranslation } from "react-i18next";
import { Check, Palette } from "lucide-react";
import { useThemeStore } from "@/stores";
import { MockBadge } from "@/components/shell/MockBadge";

export function ThemeStoreView() {
  const { t } = useTranslation();
  const manifest = useThemeStore((s) => s.manifest);
  const isMockData = useThemeStore((s) => s.isMockData);

  const swatches = [
    manifest.palette.background,
    manifest.palette.node,
    manifest.palette.core_pin,
    manifest.palette.reusable,
    manifest.palette.edge,
  ];

  return (
    <div className="h-full overflow-y-auto p-6 lg:p-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold text-slate-100">{t("store.title")}</h1>
              {isMockData && <MockBadge />}
            </div>
            <p className="mt-1 text-sm text-slate-400">{t("store.subtitle")}</p>
          </div>
          <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-400">
            {t("shell.phasePreviewBadge")}
          </span>
        </div>

        <p className="rounded-xl border border-cobalt-500/20 bg-cobalt-900/25 px-4 py-3 text-xs text-slate-300">
          {t("store.comingSoon")}
        </p>

        <div className="rounded-2xl border border-cobalt-500/40 bg-cobalt-900/30 p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <Palette size={16} className="text-cobalt-300" aria-hidden />
                <h2 className="text-base font-semibold text-slate-100">{manifest.name}</h2>
                <span className="rounded bg-white/10 px-2 py-0.5 font-mono text-[11px] text-slate-300">
                  v{manifest.version}
                </span>
              </div>
              {manifest.description && (
                <p className="mt-1.5 text-xs text-slate-400">{manifest.description}</p>
              )}
              <div className="mt-3 flex items-center gap-2">
                {swatches.map((hex, index) => (
                  <span
                    key={`${hex}-${index}`}
                    title={hex}
                    className="h-5 w-5 rounded-full border border-white/20"
                    style={{ backgroundColor: hex }}
                  />
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs text-slate-300">
                {t("store.builtin")}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/20 px-2.5 py-1 text-xs font-medium text-emerald-300">
                <Check size={12} aria-hidden />
                {t("store.active")}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
