interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
}

/**
 * Custom architectural switch control (`role="switch"`).
 * Avoids native GTK light-theme checkboxes in WebKitGTK.
 */
export function Toggle({
  checked,
  onChange,
  disabled = false,
  id,
  ariaLabel,
  ariaLabelledBy,
}: ToggleProps) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-[2px] border transition-colors focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45 ${
        checked
          ? "border-cobalt-rule bg-cobalt"
          : "border-rule-strong bg-surface-2 hover:border-bone-subtle"
      }`}
    >
      <span
        aria-hidden
        className={`inline-block h-3.5 w-3.5 rounded-[1px] transition-transform duration-150 ${
          checked ? "translate-x-[18px] bg-on-accent" : "translate-x-[2px] bg-bone-muted"
        }`}
      />
    </button>
  );
}
