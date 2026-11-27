import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Check, Loader2 } from "lucide-react";
import { backendCall } from "@/lib/backend";
import { isTauri } from "@/lib/ipc";
import { DesktopOnlyNotice } from "@/components/shell/DesktopOnlyNotice";
import type { ProjectStats } from "@/types/contracts";

/**
 * Frameless quick-note window (label `quicknote`).
 * Wired to `submit_quick_note` on Enter, then hides the window in Tauri.
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
  const [error, setError] = useState<string | null>(null);

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
      })
      .catch(() => {});

    void backendCall("list_projects", { include_archived: false })
      .then(setProjects)
      .catch(() => {});

    const onFocus = () => {
      setError(null);
      setSavedFlash(false);
      inputRef.current?.focus();
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTauri()) {
        setContent("");
        setError(null);
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = content.trim();
    if (!trimmed || submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      await backendCall("submit_quick_note", {
        content: trimmed,
        project_id: projectId || null,
      });
      setContent("");
      setSavedFlash(true);
      if (isTauri()) {
        await getCurrentWindow().hide();
      } else {
        window.setTimeout(() => setSavedFlash(false), 1800);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="flex h-full flex-col justify-center gap-2 rounded-[2px] border border-cobalt-rule border-t-2 border-t-cobalt bg-surface px-4"
    >
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
          <span className="truncate font-mono text-[10px] text-cinnabar">{error}</span>
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
        {submitting && <Loader2 size={12} className="animate-spin text-cobalt-ink" aria-hidden />}
      </div>
    </form>
  );
}
