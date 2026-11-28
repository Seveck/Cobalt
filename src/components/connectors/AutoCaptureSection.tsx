import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BookOpenText,
  FileCode2,
  GitCommitHorizontal,
  Loader2,
  Radio,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { backendCall } from "@/lib/backend";
import { formatAiClientName, pathBasename } from "@/lib/format";
import { toDisplayError, type DisplayError } from "@/lib/friendlyError";
import { staggerStyle } from "@/lib/motion";
import { Skeleton, Toggle } from "@/components/ui";
import type {
  CaptureIntegration,
  CaptureStatus,
  ProjectStats,
} from "@/types/contracts";

interface AutoCaptureSectionProps {
  refreshSignal: number;
  onNotice: (message: string) => void;
  onError: (error: DisplayError) => void;
}

function captureItemKey(item: CaptureStatus): string {
  return `${item.integration}:${item.client ?? ""}:${item.project_id ?? ""}`;
}

export function AutoCaptureSection({
  refreshSignal,
  onNotice,
  onError,
}: AutoCaptureSectionProps) {
  const { t } = useTranslation();

  const [items, setItems] = useState<CaptureStatus[]>([]);
  const [projects, setProjects] = useState<ProjectStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [togglingKey, setTogglingKey] = useState<string | null>(null);

  const loadCaptureData = useCallback(async () => {
    setLoading(true);
    try {
      const [integrationsRes, projectsRes] = await Promise.allSettled([
        backendCall("list_capture_integrations"),
        backendCall("list_projects", { include_archived: false }),
      ]);
      if (integrationsRes.status === "fulfilled") {
        setItems(integrationsRes.value);
      } else {
        onError(toDisplayError(integrationsRes.reason, t, "list_capture_integrations"));
      }
      if (projectsRes.status === "fulfilled") {
        setProjects(projectsRes.value);
      }
    } finally {
      setLoading(false);
    }
  }, [onError, t]);

  useEffect(() => {
    void loadCaptureData();
  }, [loadCaptureData, refreshSignal]);

  const projectById = useMemo(
    () => new Map(projects.map((p) => [p.project.id, p.project])),
    [projects],
  );

  const grouped = useMemo(() => {
    const groups: Record<CaptureIntegration, CaptureStatus[]> = {
      global_instructions: [],
      session_hooks: [],
      git_hooks: [],
    };
    for (const item of items) {
      groups[item.integration].push(item);
    }
    return groups;
  }, [items]);

  const resolveItemTitle = (item: CaptureStatus): string => {
    if (item.client) {
      return formatAiClientName(item.client);
    }
    if (item.project_id) {
      const proj = projectById.get(item.project_id);
      if (proj) return proj.name;
    }
    if (item.path) {
      const parent = item.path.replace(/[\\/]\.git[\\/]hooks[\\/].*$/i, "");
      const folder = pathBasename(parent);
      if (folder) return folder;
    }
    return t(`capture.groups.${item.integration}.title`);
  };

  const handleToggle = async (item: CaptureStatus, enable: boolean) => {
    const key = captureItemKey(item);
    setTogglingKey(key);
    try {
      const updated = await backendCall("toggle_capture_integration", {
        integration: item.integration,
        client: item.client,
        project_id: item.project_id,
        enable,
      });
      setItems((prev) =>
        prev.map((existing) => (captureItemKey(existing) === key ? updated : existing)),
      );
      const targetName = resolveItemTitle(item);
      onNotice(
        enable
          ? t("capture.enabledNotice", { name: targetName })
          : t("capture.disabledNotice", { name: targetName }),
      );
    } catch (err: unknown) {
      onError(toDisplayError(err, t, "toggle_capture_integration"));
    } finally {
      setTogglingKey(null);
    }
  };

  const sections: Array<{
    kind: CaptureIntegration;
    icon: typeof BookOpenText;
    entries: CaptureStatus[];
  }> = [
    {
      kind: "global_instructions",
      icon: BookOpenText,
      entries: grouped.global_instructions,
    },
    {
      kind: "session_hooks",
      icon: Radio,
      entries: grouped.session_hooks,
    },
    {
      kind: "git_hooks",
      icon: GitCommitHorizontal,
      entries: grouped.git_hooks,
    },
  ];

  return (
    <section className="rounded-[2px] border border-rule bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-rule pb-4">
        <div className="max-w-3xl">
          <h2 className="flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-bone">
            <Sparkles size={13} className="text-cobalt-ink" aria-hidden />
            03 — {t("capture.title")}
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-bone-muted">{t("capture.subtitle")}</p>
        </div>

        <span className="inline-flex items-center gap-1.5 rounded-[2px] border border-verdigris-rule/70 bg-verdigris-wash/60 px-2.5 py-1 font-mono text-[10px] text-verdigris">
          <ShieldCheck size={11} aria-hidden />
          {t("capture.reversibleBadge")}
        </span>
      </div>

      {loading && items.length === 0 ? (
        <div className="mt-4 space-y-3" aria-busy="true" aria-label={t("capture.loading")}>
          {[0, 1, 2].map((idx) => (
            <div
              key={idx}
              className="flex items-center justify-between gap-3 rounded-[2px] border border-rule bg-void p-3"
            >
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-36" />
                <Skeleton className="h-3 w-56" />
              </div>
              <Skeleton className="h-5 w-9 shrink-0 rounded-full" />
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-4 space-y-5">
          {sections.map(({ kind, icon: Icon, entries }) => (
            <div key={kind} className="space-y-2.5">
              <div>
                <h3 className="flex items-center gap-1.5 text-xs font-semibold text-bone">
                  <Icon size={13} className="text-cobalt-ink" aria-hidden />
                  <span>{t(`capture.groups.${kind}.title`)}</span>
                </h3>
                <p className="mt-0.5 text-xs leading-relaxed text-bone-muted">
                  {t(`capture.groups.${kind}.plainExplanation`)}
                </p>
              </div>

              {entries.length === 0 ? (
                <div className="rounded-[2px] border border-rule bg-void px-3.5 py-2.5 text-xs text-bone-subtle">
                  {t(`capture.groups.${kind}.empty`)}
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
                  {entries.map((item, idx) => {
                    const key = captureItemKey(item);
                    const busy = togglingKey === key;
                    const title = resolveItemTitle(item);
                    const project = item.project_id ? projectById.get(item.project_id) : undefined;

                    return (
                      <div
                        key={key}
                        style={staggerStyle(idx, 22, 6)}
                        className={`cobalt-stagger-item flex flex-col justify-between gap-2.5 rounded-[2px] border p-3.5 transition-colors ${
                          item.enabled
                            ? "border-cobalt-rule/70 bg-void/90"
                            : "border-rule bg-void/70"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              {project && (
                                <span
                                  className="h-2.5 w-2.5 shrink-0 rounded-[1px]"
                                  style={{ backgroundColor: project.color_hex }}
                                  aria-hidden
                                />
                              )}
                              <span className="truncate text-xs font-semibold text-bone">
                                {title}
                              </span>
                              <span
                                className={`rounded-[2px] border px-1.5 py-0.5 font-mono text-[9px] font-medium uppercase tracking-[0.08em] ${
                                  !item.supported
                                    ? "border-rule bg-surface-2 text-bone-subtle"
                                    : item.enabled
                                      ? "border-verdigris-rule bg-verdigris-wash text-verdigris"
                                      : "border-rule-strong bg-surface-2 text-bone-muted"
                                }`}
                              >
                                {!item.supported
                                  ? t("capture.status.unsupported")
                                  : item.enabled
                                    ? t("capture.status.enabled")
                                    : t("capture.status.disabled")}
                              </span>
                            </div>

                            <div className="mt-1.5 flex items-center gap-1.5 font-mono text-[10px] text-bone-subtle">
                              <FileCode2 size={10} className="shrink-0 text-bone-subtle" aria-hidden />
                              <span className="shrink-0 text-bone-muted">
                                {t("capture.editsFileLabel")}:
                              </span>
                              <span
                                className="min-w-0 truncate text-bone"
                                title={item.path ?? undefined}
                              >
                                {item.path ?? t("capture.noFileDetected")}
                              </span>
                            </div>
                          </div>

                          <div className="flex shrink-0 items-center gap-2">
                            {busy && (
                              <Loader2
                                size={12}
                                className="animate-spin text-cobalt-ink"
                                aria-hidden
                              />
                            )}
                            <Toggle
                              checked={item.enabled}
                              disabled={busy || !item.supported}
                              ariaLabel={`${t(`capture.groups.${kind}.title`)} · ${title}`}
                              onChange={(enable) => void handleToggle(item, enable)}
                            />
                          </div>
                        </div>

                        {item.detail && (
                          <p className="border-t border-rule pt-2 text-[11px] leading-relaxed text-bone-muted">
                            {item.detail}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}

          <p className="border-t border-rule pt-3 text-[11px] text-bone-subtle">
            {t("capture.privacyNote")}
          </p>
        </div>
      )}
    </section>
  );
}
