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
    <div className="h-full overflow-y-auto p-6 lg:p-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold text-slate-100">{t("library.title")}</h1>
              {isMockData && <MockBadge />}
            </div>
            <p className="mt-1 text-sm text-slate-400">{t("library.subtitle")}</p>
          </div>
          <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-400">
            {t("shell.phasePreviewBadge")}
          </span>
        </div>

        <p className="rounded-xl border border-cobalt-500/20 bg-cobalt-900/25 px-4 py-3 text-xs text-slate-300">
          {t("library.comingSoon")}
        </p>

        {assets.length === 0 ? (
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-8 text-center text-sm text-slate-400">
            {t("library.empty")}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {assets.slice(0, 12).map((asset) => (
              <article
                key={asset.memory_id}
                className="rounded-xl border border-white/10 bg-cobalt-900/20 p-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs text-slate-300">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: asset.origin_project_color ?? "#94A3B8" }}
                    />
                    <span>{asset.origin_project_name ?? t("brain.globalScope")}</span>
                  </div>
                  <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] uppercase text-slate-300">
                    {asset.source_type}
                  </span>
                </div>
                <p className="mt-2 line-clamp-2 text-sm text-slate-100">{asset.summary}</p>
                <div className="mt-3 flex items-center justify-between text-xs text-slate-400">
                  <span className="inline-flex items-center gap-1 text-violet-300">
                    <Repeat size={12} aria-hidden />
                    {t("library.reuses", { count: asset.reuse_count })}
                  </span>
                  <span className="font-mono text-emerald-300">
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
