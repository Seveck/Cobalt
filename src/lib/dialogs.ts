import { useEffect, useRef, useState } from "react";
import { open, save, type OpenDialogOptions, type SaveDialogOptions } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { isTauri } from "@/lib/ipc";

/**
 * Pick one or more local file/directory paths via Tauri's native dialog plugin.
 * In browser preview (`!isTauri()`), falls back to a prompt so UI flows remain testable.
 */
export async function pickPaths(
  options: OpenDialogOptions & { fallbackPlaceholder?: string },
): Promise<string[]> {
  if (isTauri()) {
    const selected = await open(options);
    if (!selected) return [];
    return Array.isArray(selected) ? selected : [selected];
  }
  if (typeof window === "undefined") return [];
  const raw = window.prompt(
    options.title ?? "Enter file or folder path (browser preview):",
    options.defaultPath ?? options.fallbackPlaceholder ?? "",
  );
  if (!raw || !raw.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Pick a single file or directory path. */
export async function pickSinglePath(
  options: Omit<OpenDialogOptions, "multiple"> & { fallbackPlaceholder?: string },
): Promise<string | null> {
  const results = await pickPaths({ ...options, multiple: false });
  return results[0] ?? null;
}

/** Pick a destination path for exporting a file. */
export async function pickSavePath(
  options: SaveDialogOptions & { fallbackPlaceholder?: string },
): Promise<string | null> {
  if (isTauri()) {
    const selected = await save(options);
    return selected ?? null;
  }
  if (typeof window === "undefined") return null;
  const raw = window.prompt(
    options.title ?? "Enter destination path (browser preview):",
    options.defaultPath ?? options.fallbackPlaceholder ?? "",
  );
  return raw && raw.trim() ? raw.trim() : null;
}

/** Copy text to system clipboard with safe fallback. */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback below
    }
  }
  if (typeof document !== "undefined") {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
      return true;
    } catch {
      return false;
    } finally {
      document.body.removeChild(textarea);
    }
  }
  return false;
}

/**
 * Subscribe to OS-level file drag & drop inside Tauri (`getCurrentWebview().onDragDropEvent`)
 * and HTML5 drag & drop in browser preview. Returns `isDragging` for visual drop feedback.
 */
export function useFileDrop(
  onDropPaths: (paths: string[]) => void,
  enabled = true,
): { isDragging: boolean } {
  const [isDragging, setIsDragging] = useState(false);
  const callbackRef = useRef(onDropPaths);
  callbackRef.current = onDropPaths;

  useEffect(() => {
    if (!enabled) {
      setIsDragging(false);
      return;
    }

    if (isTauri()) {
      let active = true;
      let unlisten: (() => void) | null = null;

      void getCurrentWebview()
        .onDragDropEvent((event) => {
          if (!active) return;
          if (event.payload.type === "enter" || event.payload.type === "over") {
            setIsDragging(true);
          } else if (event.payload.type === "leave") {
            setIsDragging(false);
          } else if (event.payload.type === "drop") {
            setIsDragging(false);
            if (event.payload.paths.length > 0) {
              callbackRef.current(event.payload.paths);
            }
          }
        })
        .then((fn) => {
          if (active) {
            unlisten = fn;
          } else {
            fn();
          }
        })
        .catch(() => {
          // Webview drag-drop listener unavailable in this context.
        });

      return () => {
        active = false;
        setIsDragging(false);
        unlisten?.();
      };
    }

    // Browser preview fallback (HTML5 drag & drop)
    let depth = 0;
    const onDragEnter = (e: DragEvent) => {
      e.preventDefault();
      depth += 1;
      setIsDragging(true);
    };
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
    };
    const onDragLeave = (e: DragEvent) => {
      e.preventDefault();
      depth = Math.max(0, depth - 1);
      if (depth === 0) setIsDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setIsDragging(false);
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      const paths: string[] = [];
      for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        if (file?.name) {
          paths.push(`/dropped/${file.name}`);
        }
      }
      if (paths.length > 0) {
        callbackRef.current(paths);
      }
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      setIsDragging(false);
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [enabled]);

  return { isDragging };
}
