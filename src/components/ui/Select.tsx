import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Check, ChevronDown } from "lucide-react";

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  detail?: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string = string> {
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  id?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  size?: "sm" | "md";
  placement?: "auto" | "top" | "bottom";
  align?: "left" | "right";
  className?: string;
  menuClassName?: string;
}

function findNextEnabledIndex<T extends string>(
  options: readonly SelectOption<T>[],
  start: number,
  step: 1 | -1,
): number {
  const len = options.length;
  if (len === 0) return -1;
  for (let i = 0; i < len; i += 1) {
    const idx = (start + step * i + len) % len;
    if (!options[idx]?.disabled) return idx;
  }
  return -1;
}

/**
 * Custom dark-themed accessible dropdown (`role="combobox"` + `role="listbox"`).
 * Replaces native `<select>` elements which render white-on-white under WebKitGTK.
 */
export function Select<T extends string = string>({
  value,
  options,
  onChange,
  disabled = false,
  id,
  ariaLabel,
  ariaLabelledBy,
  size = "md",
  placement = "auto",
  align = "left",
  className = "",
  menuClassName = "",
}: SelectProps<T>) {
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const triggerId = id ?? `${baseId}-trigger`;

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxRef = useRef<HTMLUListElement>(null);
  const typeaheadRef = useRef<{ buffer: string; timer: number | null }>({
    buffer: "",
    timer: null,
  });

  const [open, setOpen] = useState(false);
  const [resolvedPlacement, setResolvedPlacement] = useState<"top" | "bottom">(
    placement === "top" ? "top" : "bottom",
  );
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);

  const selectedIndex = options.findIndex((opt) => opt.value === value);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const computePlacement = useCallback((): "top" | "bottom" => {
    if (placement === "top" || placement === "bottom") return placement;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect || typeof window === "undefined") return "bottom";
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    return spaceBelow < 220 && spaceAbove > spaceBelow ? "top" : "bottom";
  }, [placement]);

  const openMenu = useCallback(
    (initialIndex?: number) => {
      if (disabled || options.length === 0) return;
      setResolvedPlacement(computePlacement());
      const start =
        initialIndex !== undefined
          ? initialIndex
          : selectedIndex >= 0 && !options[selectedIndex]?.disabled
            ? selectedIndex
            : findNextEnabledIndex(options, 0, 1);
      setHighlightedIndex(start);
      setOpen(true);
    },
    [computePlacement, disabled, options, selectedIndex],
  );

  const closeMenu = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) {
      triggerRef.current?.focus();
    }
  }, []);

  const commitIndex = useCallback(
    (index: number) => {
      const opt = options[index];
      if (!opt || opt.disabled) return;
      if (opt.value !== value) {
        onChange(opt.value);
      }
      closeMenu(true);
    },
    [closeMenu, onChange, options, value],
  );

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        closeMenu(false);
      }
    };
    const handleWindowBlur = () => closeMenu(false);

    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, [closeMenu, open]);

  useEffect(() => {
    if (!open || highlightedIndex < 0) return;
    const optionEl = listboxRef.current?.querySelector<HTMLElement>(
      `[data-option-index="${highlightedIndex}"]`,
    );
    optionEl?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex, open]);

  useEffect(() => {
    const state = typeaheadRef.current;
    return () => {
      if (state.timer !== null) {
        window.clearTimeout(state.timer);
      }
    };
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;

    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        if (!open) {
          openMenu();
        } else {
          setHighlightedIndex((prev) =>
            findNextEnabledIndex(options, prev < 0 ? 0 : prev + 1, 1),
          );
        }
        return;
      }
      case "ArrowUp": {
        event.preventDefault();
        if (!open) {
          openMenu();
        } else {
          setHighlightedIndex((prev) =>
            findNextEnabledIndex(options, prev < 0 ? options.length - 1 : prev - 1, -1),
          );
        }
        return;
      }
      case "Home": {
        if (!open) return;
        event.preventDefault();
        setHighlightedIndex(findNextEnabledIndex(options, 0, 1));
        return;
      }
      case "End": {
        if (!open) return;
        event.preventDefault();
        setHighlightedIndex(findNextEnabledIndex(options, options.length - 1, -1));
        return;
      }
      case "Enter":
      case " ": {
        event.preventDefault();
        if (!open) {
          openMenu();
        } else if (highlightedIndex >= 0) {
          commitIndex(highlightedIndex);
        } else {
          closeMenu(true);
        }
        return;
      }
      case "Escape": {
        if (!open) return;
        event.preventDefault();
        closeMenu(true);
        return;
      }
      case "Tab": {
        if (open) {
          closeMenu(false);
        }
        return;
      }
      default: {
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const state = typeaheadRef.current;
          if (state.timer !== null) {
            window.clearTimeout(state.timer);
          }
          state.buffer = (state.buffer + event.key).toLowerCase();
          state.timer = window.setTimeout(() => {
            state.buffer = "";
            state.timer = null;
          }, 500);

          const matchIdx = options.findIndex(
            (opt) => !opt.disabled && opt.label.toLowerCase().startsWith(state.buffer),
          );
          if (matchIdx >= 0) {
            if (open) {
              setHighlightedIndex(matchIdx);
            } else {
              const matched = options[matchIdx];
              if (matched && matched.value !== value) {
                onChange(matched.value);
              }
            }
          }
        }
      }
    }
  };

  const sizeClasses =
    size === "sm"
      ? "h-7 px-2.5 text-xs gap-2"
      : "h-10 px-3 text-sm gap-2.5";

  const activeDescendantId =
    open && highlightedIndex >= 0 ? `${listboxId}-opt-${highlightedIndex}` : undefined;

  return (
    <div ref={containerRef} className={`relative inline-block ${className}`}>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        role="combobox"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={activeDescendantId}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        onClick={() => (open ? closeMenu(false) : openMenu())}
        onKeyDown={handleKeyDown}
        className={`flex w-full items-center justify-between rounded-[2px] border border-rule-strong bg-surface-2 text-left font-medium text-bone transition-colors hover:border-cobalt-ink/60 hover:bg-surface-3 focus-visible:border-cobalt-ink focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45 ${sizeClasses}`}
      >
        <span className="truncate">{selectedOption?.label ?? value}</span>
        <ChevronDown
          size={size === "sm" ? 13 : 15}
          aria-hidden
          className={`shrink-0 text-bone-muted transition-transform duration-150 ${
            open ? "rotate-180 text-cobalt-ink" : ""
          }`}
        />
      </button>

      {open && (
        <ul
          ref={listboxRef}
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          className={`absolute z-50 max-h-60 min-w-full overflow-y-auto rounded-[2px] border border-rule-strong bg-surface py-1 shadow-[0_12px_32px_rgba(0,0,0,0.72)] ${
            resolvedPlacement === "top"
              ? "cobalt-panel-enter-up bottom-full mb-1"
              : "cobalt-panel-enter-down top-full mt-1"
          } ${align === "right" ? "right-0" : "left-0"} ${menuClassName}`}
        >
          {options.map((opt, index) => {
            const isSelected = opt.value === value;
            const isHighlighted = index === highlightedIndex;
            return (
              <li
                key={opt.value}
                id={`${listboxId}-opt-${index}`}
                role="option"
                data-option-index={index}
                aria-selected={isSelected}
                aria-disabled={opt.disabled || undefined}
                onMouseEnter={() => {
                  if (!opt.disabled) setHighlightedIndex(index);
                }}
                onMouseDown={(event) => {
                  // Prevent trigger blur before selection commits.
                  event.preventDefault();
                }}
                onClick={() => commitIndex(index)}
                className={`flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-xs transition-colors select-none ${
                  opt.disabled
                    ? "cursor-not-allowed text-bone-subtle opacity-50"
                    : isSelected && isHighlighted
                      ? "bg-cobalt-wash text-bone"
                      : isHighlighted
                        ? "bg-surface-3 text-bone"
                        : isSelected
                          ? "bg-cobalt-wash/70 text-bone"
                          : "bg-surface text-bone-muted"
                }`}
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{opt.label}</div>
                  {opt.detail && (
                    <div className="truncate font-mono text-[10px] text-bone-subtle">
                      {opt.detail}
                    </div>
                  )}
                </div>
                {isSelected && (
                  <Check size={13} className="shrink-0 text-cobalt-ink" aria-hidden />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
