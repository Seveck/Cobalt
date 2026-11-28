import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  FolderPlus,
  Info,
  Loader2,
  Plus,
  X,
} from "lucide-react";
import { backendCall } from "@/lib/backend";
import { pickSinglePath } from "@/lib/dialogs";
import { toDisplayError, type DisplayError } from "@/lib/friendlyError";
import { findProjectByName, pickNextFolderColor, PROJECT_COLORS } from "@/lib/projects";
import { useMemoryStore, useThemeStore } from "@/stores";
import { ErrorAlert } from "@/components/ui";
import type { Project, ProjectStats } from "@/types/contracts";

export interface CreateFolderDialogProps {
  onClose: () => void;
  onCreated?: (project: Project) => void;
  /** Called when the user submits a name that matches an existing folder instead of creating a duplicate. */
  onSelectExisting?: (project: Project) => void;
}

export function CreateFolderDialog({
  onClose,
  onCreated,
  onSelectExisting,
}: CreateFolderDialogProps) {
  const { t } = useTranslation();
  const graphProjects = useMemoryStore((s) => s.graph?.projects);
  const loadGraph = useMemoryStore((s) => s.loadGraph);
  const pushThemeToast = useThemeStore((s) => s.pushThemeToast);

  const nameInputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);

  const [knownProjects, setKnownProjects] = useState<ProjectStats[]>(() => [
    ...(graphProjects ?? []),
  ]);
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(() =>
    pickNextFolderColor((graphProjects ?? []).map((s) => s.project)),
  );
  const [linkCodeOpen, setLinkCodeOpen] = useState(false);
  const [rootPath, setRootPath] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<DisplayError | null>(null);

  useEffect(() => {
    let active = true;
    void backendCall("list_projects", { include_archived: true })
      .then((list) => {
        if (active) setKnownProjects(list);
      })
      .catch(() => {
        // Keep seeded graph projects if fetch fails transiently.
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const raf = window.requestAnimationFrame(() => {
      nameInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose, saving]);

  const existingMatch = useMemo(
    () => findProjectByName(knownProjects, name),
    [knownProjects, name],
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || saving || submittingRef.current) return;

    // If the typed name already exists (case-insensitive), select it instead of calling create_project
    if (existingMatch) {
      submittingRef.current = true;
      pushThemeToast({
        kind: "info",
        message: t("folders.existingSelectedToast", { name: existingMatch.project.name }),
      });
      if (onSelectExisting) {
        onSelectExisting(existingMatch.project);
      } else {
        onCreated?.(existingMatch.project);
      }
      onClose();
      return;
    }

    submittingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const created = await backendCall("create_project", {
        name: trimmed,
        root_path: linkCodeOpen && rootPath.trim() ? rootPath.trim() : null,
        color_hex: color,
      });
      await loadGraph();
      pushThemeToast({
        kind: "saved",
        message: t("folders.createdToast", { name: created.name }),
      });
      onCreated?.(created);
      onClose();
    } catch (err: unknown) {
      setError(toDisplayError(err, t, "create_project"));
      setSaving(false);
      submittingRef.current = false;
    }
  };

  return (
    <div
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !saving) {
          onClose();
        }
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-void/65 p-4 backdrop-blur-[2px]"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-folder-dialog-title"
        style={{ boxShadow: "var(--cobalt-shadow-elevated)" }}
        className="cobalt-modal-enter w-[min(420px,calc(100vw-2rem))] rounded-[2px] border border-rule-strong bg-surface text-bone"
      >
        <div className="flex items-center justify-between gap-2 border-b border-rule px-4 py-3">
          <div className="flex items-center gap-2">
            <FolderPlus size={15} className="text-cobalt-ink" aria-hidden />
            <h2
              id="create-folder-dialog-title"
              className="text-sm font-semibold tracking-tight text-bone"
            >
              {t("folders.newFolder")}
            </h2>
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            aria-label={t("common.close")}
            className="rounded-[2px] p-1 text-bone-muted hover:bg-surface-2 hover:text-bone disabled:opacity-45"
          >
            <X size={14} aria-hidden />
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4 p-4">
          <ErrorAlert error={error} compact />

          <p className="text-xs leading-relaxed text-bone-muted">
            {t("folders.newFolderHint")}
          </p>

          <div className="space-y-1.5">
            <label
              htmlFor="create-folder-name-input"
              className="block font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle"
            >
              {t("folders.nameLabel")}
            </label>
            <input
              id="create-folder-name-input"
              ref={nameInputRef}
              type="text"
              value={name}
              disabled={saving}
              onChange={(e) => {
                setName(e.target.value);
                if (error) setError(null);
              }}
              placeholder={t("folders.namePlaceholder")}
              className="h-9 w-full rounded-[2px] border border-rule-strong bg-void px-3 text-xs text-bone placeholder:text-bone-subtle focus:border-cobalt-ink focus:outline-none"
            />
            {existingMatch && (
              <div
                role="status"
                className="flex items-start gap-2 rounded-[2px] border border-cobalt-rule/70 bg-cobalt-wash/55 px-2.5 py-2 text-[11px] leading-snug text-bone"
              >
                <Info size={13} className="mt-0.5 shrink-0 text-cobalt-ink" aria-hidden />
                <span>
                  {t("folders.alreadyExistsSelectHint", {
                    name: existingMatch.project.name,
                  })}
                </span>
              </div>
            )}
          </div>

          {!existingMatch && (
            <>
              <div className="space-y-1.5">
                <span className="block font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
                  {t("tools.projects.colorLabel")}
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  {PROJECT_COLORS.map((hex) => (
                    <button
                      key={hex}
                      type="button"
                      onClick={() => setColor(hex)}
                      aria-label={hex}
                      className={`h-6 w-6 rounded-[2px] border transition-transform ${
                        color === hex
                          ? "scale-110 border-bone ring-1 ring-bone"
                          : "border-rule-strong"
                      }`}
                      style={{ backgroundColor: hex }}
                    />
                  ))}
                  <input
                    type="color"
                    value={color}
                    onChange={(e) => setColor(e.target.value)}
                    aria-label={t("tools.projects.customColor")}
                    className="h-6 w-8 cursor-pointer rounded-[2px] border border-rule-strong bg-void p-0.5"
                  />
                </div>
              </div>

              {/* Optional link to disk folder (for code projects) */}
              <div className="border-t border-rule pt-3">
                <button
                  type="button"
                  onClick={() => setLinkCodeOpen((v) => !v)}
                  className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-bone-subtle hover:text-bone"
                >
                  {linkCodeOpen ? (
                    <ChevronDown size={11} aria-hidden />
                  ) : (
                    <ChevronRight size={11} aria-hidden />
                  )}
                  <span>{t("folders.linkCodeFolderOptional")}</span>
                </button>

                {linkCodeOpen && (
                  <div className="mt-2 flex gap-1.5">
                    <input
                      type="text"
                      value={rootPath}
                      disabled={saving}
                      onChange={(e) => setRootPath(e.target.value)}
                      placeholder={t("tools.projects.folderPlaceholder")}
                      className="h-8 flex-1 rounded-[2px] border border-rule-strong bg-void px-2.5 font-mono text-xs text-bone placeholder:text-bone-subtle focus:border-cobalt-ink focus:outline-none"
                    />
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() =>
                        void pickSinglePath({
                          title: t("tools.projects.pickFolder"),
                          directory: true,
                        }).then((p) => {
                          if (p) setRootPath(p);
                        })
                      }
                      className="inline-flex h-8 items-center rounded-[2px] border border-rule-strong bg-surface-2 px-2.5 text-bone-muted hover:text-bone"
                    >
                      <FolderOpen size={12} aria-hidden />
                    </button>
                  </div>
                )}
              </div>
            </>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-rule pt-3">
            <button
              type="button"
              disabled={saving}
              onClick={onClose}
              className="rounded-[2px] border border-rule-strong bg-surface-2 px-3 py-1.5 font-mono text-xs text-bone-muted hover:text-bone disabled:opacity-45"
            >
              {t("common.cancel")}
            </button>
            <button
              type="submit"
              disabled={saving || !name.trim()}
              className="inline-flex items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-3.5 py-1.5 font-mono text-xs font-semibold text-on-accent hover:bg-cobalt-bright disabled:opacity-45"
            >
              {saving ? (
                <Loader2 size={12} className="animate-spin" aria-hidden />
              ) : existingMatch ? (
                <Check size={12} aria-hidden />
              ) : (
                <Plus size={12} aria-hidden />
              )}
              <span>
                {existingMatch ? t("folders.selectExistingButton") : t("folders.createButton")}
              </span>
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
