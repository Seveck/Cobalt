import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Repeat } from "lucide-react";
import { useLibraryStore } from "@/stores";
import { MockBadge } from "@/components/shell/MockBadge";

export function LibraryView() {
  const { t } = useTranslation();
  const assets = useLibraryStore((s) => s.assets);
  const loading = useLibraryStore((s) => s.loading);
  const isMockData = useLibraryStore((s) => s.isMockData);
  const loadLibrary = useLibraryStore((s) => s.loadLibrary);

  useEffect(() => {
    if (assets.length === 0 && !loading) {
      void loadLibrary();
    }
  }, [assets.length, loading, loadLibrary]);

  return (
    <div className="h-full overflow-y-auto bg-void p-6 lg:p-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-rule pb-5">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="font-display text-2xl font-medium tracking-tight text-bone sm:text-3xl">
                {t("library.title")}
              </h1>
              {isMockData && <MockBadge />}
            </div>
            <p className="mt-1.5 text-sm text-bone-muted">{t("library.subtitle")}</p>
          </div>
          <span className="rounded-[2px] border border-rule bg-surface px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
            {t("shell.phasePreviewBadge")}
          </span>
        </header>

        <p className="rounded-[2px] border border-rule border-l-2 border-l-cobalt bg-surface px-4 py-3 text-xs text-bone-muted">
          {t("library.comingSoon")}
        </p>

        {assets.length === 0 ? (
          <div className="rounded-[2px] border border-rule bg-surface p-8 text-center text-sm text-bone-muted">
            {t("library.empty")}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {assets.slice(0, 12).map((asset) => (
              <article
                key={asset.memory_id}
                className="rounded-[2px] border border-rule bg-surface p-4 transition-colors hover:border-rule-strong"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 font-mono text-[11px] text-bone-muted">
                    <span
                      className="h-2 w-2 rounded-[1px]"
                      style={{ backgroundColor: asset.origin_project_color ?? "#A4A096" }}
                    />
                    <span>{asset.origin_project_name ?? t("brain.globalScope")}</span>
                  </div>
                  <span className="rounded-[2px] border border-rule bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] uppercase text-bone-muted">
                    {asset.source_type}
                  </span>
                </div>
                <p className="mt-2.5 line-clamp-2 text-sm leading-relaxed text-bone">
                  {asset.summary}
                </p>
                <div className="mt-3 flex items-center justify-between border-t border-rule pt-2.5 font-mono text-[11px] tabular-nums">
                  <span className="inline-flex items-center gap-1 text-pulse-reuse">
                    <Repeat size={12} aria-hidden />
                    {t("library.reuses", { count: asset.reuse_count })}
                  </span>
                  <span className="text-verdigris">
                    {t("library.tokensSaved", { count: asset.output_tokens_saved })}
                  </span>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
