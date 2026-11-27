import { useEffect, useRef, useState } from "react";
import { open, save, type OpenDialogOptions, type SaveDialogOptions } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { isTauri } from "@/lib/ipc";

/**
 * Pick one or more local file/directory paths via Tauri's native dialog plugin.
 */
export async function pickPaths(options: OpenDialogOptions): Promise<string[]> {
  if (!isTauri()) return [];
  const selected = await open(options);
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
}

/** Pick a single file or directory path. */
export async function pickSinglePath(
  options: Omit<OpenDialogOptions, "multiple">,
): Promise<string | null> {
  const results = await pickPaths({ ...options, multiple: false });
  return results[0] ?? null;
}

/** Pick a destination path for exporting a file. */
export async function pickSavePath(options: SaveDialogOptions): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await save(options);
  return selected ?? null;
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
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      document.body.removeChild(textarea);
    }
  }
  return false;
}

/**
 * Subscribe to OS-level file drag & drop inside Tauri (`getCurrentWebview().onDragDropEvent`).
 * Returns `isDragging` for visual drop feedback.
 */
export function useFileDrop(
  onDropPaths: (paths: string[]) => void,
  enabled = true,
): { isDragging: boolean } {
  const [isDragging, setIsDragging] = useState(false);
  const callbackRef = useRef(onDropPaths);
  callbackRef.current = onDropPaths;

  useEffect(() => {
    if (!enabled || !isTauri()) {
      setIsDragging(false);
      return;
    }

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
  }, [enabled]);

  return { isDragging };
}
