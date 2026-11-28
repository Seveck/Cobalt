import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { MoreHorizontal, Trash2 } from "lucide-react";

export interface FolderRowMenuProps {
  folderName: string;
  disabled?: boolean;
  compact?: boolean;
  /** Optional class applied to the trigger button. */
  triggerClassName?: string;
  onDelete: () => void;
}

/**
 * Compact folder actions menu ("Eliminar carpeta…") rendered in a portal so it is
 * never clipped inside scrollable sidebars, FilterDock panels, or FolderPicker dialogs.
 */
export function FolderRowMenu({
  folderName,
  disabled = false,
  compact = false,
  triggerClassName = "",
  onDelete,
}: FolderRowMenuProps) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const menuWidth = 188;
      const menuHeight = 42;
      const padding = 8;
      const left = Math.max(
        padding,
        Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - padding),
      );
      const fitsBelow = rect.bottom + 4 + menuHeight <= window.innerHeight - padding;
      const top = fitsBelow ? rect.bottom + 4 : Math.max(padding, rect.top - menuHeight - 4);
      setCoords({ top, left });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (
        target &&
        (triggerRef.current?.contains(target) || menuRef.current?.contains(target))
      ) {
        return;
      }
      setOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open]);

  const menuPortal =
    open && coords && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={t("folders.menuAria", { name: folderName })}
            style={{
              position: "fixed",
              top: coords.top,
              left: coords.left,
              width: 188,
              boxShadow: "var(--cobalt-shadow-elevated)",
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            className="z-[70] rounded-[2px] border border-rule-strong bg-surface p-1 text-bone"
          >
            <button
              type="button"
              role="menuitem"
              disabled={disabled}
              onClick={() => {
                setOpen(false);
                onDelete();
              }}
              className="flex w-full items-center gap-2 rounded-[2px] px-2.5 py-1.5 text-left text-xs font-medium text-cinnabar transition-colors hover:bg-cinnabar-wash focus-visible:bg-cinnabar-wash focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Trash2 size={12} className="shrink-0" aria-hidden />
              <span className="truncate">{t("folders.deleteAction")}</span>
            </button>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("folders.menuAria", { name: folderName })}
        title={t("folders.menuAria", { name: folderName })}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={`inline-flex shrink-0 items-center justify-center rounded-[2px] text-bone-subtle transition-colors hover:bg-surface-2 hover:text-bone focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none ${
          compact ? "h-5 w-5" : "h-6 w-6"
        } ${triggerClassName} ${open ? "bg-surface-2 text-bone opacity-100" : ""}`}
      >
        <MoreHorizontal size={compact ? 11 : 13} aria-hidden />
      </button>
      {menuPortal}
    </>
  );
}
