import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AlertTriangle, ArrowUpRight, Check, Loader2, X } from "lucide-react";
import { backendCall } from "@/lib/backend";
import { toDisplayError, type DisplayError } from "@/lib/friendlyError";
import { isTauri } from "@/lib/ipc";
import { isUnsortedProject } from "@/lib/projects";
import {
  conflictReasonI18nKey,
  QUICKNOTE_CONFLICTS_STORAGE_KEY,
  QUICKNOTE_INSPECT_STORAGE_KEY,
} from "@/lib/savings";
import { applyThemeToRoot } from "@/lib/themeEngine";
import { DesktopOnlyNotice } from "@/components/shell/DesktopOnlyNotice";
import { ErrorAlert } from "@/components/ui";
import { BUILTIN_THEME_ID, type ConflictHint, type ProjectStats, type Uuid } from "@/types/contracts";

/**
 * Frameless quick-note window (label `quicknote`).
 * Wired to `submit_quick_note` on Enter, then hides the window in Tauri
 * (unless possible conflicts are returned, in which case a warning toast is shown).
 */
export default function QuickNote() {
  if (!isTauri()) {
    return <DesktopOnlyNotice />;
  }
  return <QuickNoteWindow />;
}

function QuickNoteWindow() {
  const { t, i18n } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);

  const [content, setContent] = useState("");
  const [projects, setProjects] = useState<ProjectStats[]>([]);
  const [projectId, setProjectId] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [conflicts, setConflicts] = useState<ConflictHint[]>([]);
  const [error, setError] = useState<DisplayError | null>(null);

  useEffect(() => {
    inputRef.current?.focus();

    void backendCall("get_settings")
      .then((settings) => {
        if (typeof document !== "undefined") {
          document.documentElement.lang = settings.language;
        }
        if (i18n.resolvedLanguage !== settings.language) {
          void i18n.changeLanguage(settings.language);
        }
        if (settings.active_theme_id && settings.active_theme_id !== BUILTIN_THEME_ID) {
          void backendCall("get_theme_manifest", { theme_id: settings.active_theme_id })
            .then(applyThemeToRoot)
            .catch(() => {});
        }
      })
      .catch(() => {});

    void backendCall("list_projects", { include_archived: false })
      .then((list) => setProjects(list.filter((stat) => !isUnsortedProject(stat.project))))
      .catch(() => {});

    const onFocus = () => {
      setError(null);
      setSavedFlash(false);
      setConflicts([]);
      inputRef.current?.focus();
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTauri()) {
        setContent("");
        setError(null);
        setConflicts([]);
        void getCurrentWindow().hide();
      }
    };

    window.addEventListener("focus", onFocus);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("keydown", onKey);
    };
  }, [i18n]);

  const handleOpenConflictMemory = (memoryId: Uuid) => {
    try {
      window.localStorage.setItem(
        QUICKNOTE_INSPECT_STORAGE_KEY,
        JSON.stringify({ ts: Date.now(), memoryId }),
      );
    } catch {
      // Ignore storage errors.
    }
    setConflicts([]);
    if (isTauri()) {
      void getCurrentWindow().hide();
    }
  };

  const handleDismissConflicts = () => {
    setConflicts([]);
    if (isTauri()) {
      void getCurrentWindow().hide();
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = content.trim();
    if (!trimmed || submitting) return;

    setSubmitting(true);
    setError(null);
    setConflicts([]);
    try {
      const outcome = await backendCall("submit_quick_note", {
        content: trimmed,
        project_id: projectId || null,
      });
      setContent("");
      setSavedFlash(true);

      const foundConflicts = outcome.possible_conflicts ?? [];
      if (foundConflicts.length > 0) {
        setConflicts(foundConflicts);
        try {
          window.localStorage.setItem(
            QUICKNOTE_CONFLICTS_STORAGE_KEY,
            JSON.stringify({ ts: Date.now(), conflicts: foundConflicts }),
          );
        } catch {
          // Ignore storage errors.
        }
        return;
      }

      if (isTauri()) {
        await getCurrentWindow().hide();
      } else {
        window.setTimeout(() => setSavedFlash(false), 1800);
      }
    } catch (err: unknown) {
      setError(toDisplayError(err, t, "submit_quick_note"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="flex h-full flex-col justify-center gap-2 overflow-y-auto rounded-[2px] border border-cobalt-rule border-t-2 border-t-cobalt bg-surface px-4 py-2"
    >
      {conflicts.length > 0 ? (
        <div
          role="alert"
          className="space-y-1.5 rounded-[2px] border border-ochre-rule bg-ochre-wash/75 px-3 py-2 text-xs"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 font-medium text-ochre">
              <AlertTriangle size={13} className="shrink-0" aria-hidden />
              {t("conflicts.possibleToast", { count: conflicts.length })}
            </span>
            <button
              type="button"
              onClick={handleDismissConflicts}
              aria-label={t("common.close")}
              className="rounded-[2px] p-0.5 text-ochre hover:bg-ochre/15"
            >
              <X size={12} aria-hidden />
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {conflicts.slice(0, 3).map((conflict) => {
              const reasonKey = conflictReasonI18nKey(conflict.reason);
              const reasonLabel = reasonKey ? t(reasonKey) : conflict.reason;
              return (
                <button
                  key={conflict.memory_id}
                  type="button"
                  title={reasonLabel}
                  onClick={() => handleOpenConflictMemory(conflict.memory_id)}
                  className="inline-flex max-w-full items-center gap-1 rounded-[2px] border border-ochre-rule/70 bg-surface px-2 py-0.5 text-[11px] text-bone hover:border-ochre hover:bg-surface-2"
                >
                  <span className="max-w-[220px] truncate">{conflict.preview}</span>
                  <ArrowUpRight size={11} className="shrink-0 text-ochre" aria-hidden />
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              type="text"
              value={content}
              disabled={submitting}
              onChange={(e) => setContent(e.target.value)}
              className="flex-1 rounded-[2px] border border-rule bg-void px-3 py-2 text-base text-bone placeholder:text-bone-subtle focus:border-cobalt-ink focus:outline-none disabled:opacity-60"
              placeholder={t("quicknote.placeholder")}
              aria-label={t("quicknote.placeholder")}
            />
            {projects.length > 0 && (
              <select
                value={projectId}
                disabled={submitting}
                onChange={(e) => setProjectId(e.target.value)}
                aria-label={t("filterDock.projects")}
                className="h-10 max-w-[140px] rounded-[2px] border border-rule-strong bg-surface-2 px-2 font-mono text-xs text-bone focus:border-cobalt-ink focus:outline-none"
              >
                <option value="">{t("brain.globalScope")}</option>
                {projects.map((p) => (
                  <option key={p.project.id} value={p.project.id}>
                    {p.project.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="flex items-center justify-between gap-2">
            {error ? (
              <ErrorAlert error={error} compact className="flex-1" />
            ) : savedFlash ? (
              <span className="inline-flex items-center gap-1 font-mono text-[10px] text-verdigris">
                <Check size={11} aria-hidden />
                {t("quicknote.saved")}
              </span>
            ) : (
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-bone-subtle">
                {t("quicknote.hint")}
              </span>
            )}
            {submitting && (
              <Loader2 size={12} className="animate-spin text-cobalt-ink" aria-hidden />
            )}
          </div>
        </>
      )}
    </form>
  );
}
