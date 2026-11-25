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
    <div className="h-full overflow-y-auto bg-void p-6 lg:p-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-rule pb-5">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="font-display text-2xl font-medium tracking-tight text-bone sm:text-3xl">
                {t("store.title")}
              </h1>
              {isMockData && <MockBadge />}
            </div>
            <p className="mt-1.5 text-sm text-bone-muted">{t("store.subtitle")}</p>
          </div>
          <span className="rounded-[2px] border border-rule bg-surface px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
            {t("shell.phasePreviewBadge")}
          </span>
        </header>

        <p className="rounded-[2px] border border-rule border-l-2 border-l-cobalt bg-surface px-4 py-3 text-xs text-bone-muted">
          {t("store.comingSoon")}
        </p>

        <div className="rounded-[2px] border border-cobalt-rule border-t-2 border-t-cobalt bg-surface p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <Palette size={15} className="text-cobalt-ink" aria-hidden />
                <h2 className="font-display text-lg font-medium text-bone">{manifest.name}</h2>
                <span className="rounded-[2px] border border-rule bg-void px-2 py-0.5 font-mono text-[10px] text-bone-muted">
                  v{manifest.version}
                </span>
              </div>
              {manifest.description && (
                <p className="mt-1.5 text-xs text-bone-muted">{manifest.description}</p>
              )}
              <div className="mt-3.5 flex items-center gap-1.5">
                {swatches.map((hex, index) => (
                  <span
                    key={`${hex}-${index}`}
                    title={hex}
                    className="h-5 w-5 rounded-[2px] border border-rule-strong"
                    style={{ backgroundColor: hex }}
                  />
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.08em]">
              <span className="rounded-[2px] border border-rule bg-void px-2.5 py-1 text-bone-muted">
                {t("store.builtin")}
              </span>
              <span className="inline-flex items-center gap-1 rounded-[2px] border border-verdigris-rule bg-verdigris-wash px-2.5 py-1 font-medium text-verdigris">
                <Check size={11} aria-hidden />
                {t("store.active")}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
