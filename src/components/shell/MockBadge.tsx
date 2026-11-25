import { useTranslation } from "react-i18next";

interface MockBadgeProps {
  className?: string;
}

/** Small dev badge displayed whenever data or backend calls are served by `backendMock`. */
export function MockBadge({ className = "" }: MockBadgeProps) {
  const { t } = useTranslation();
  return (
    <span
      title={t("shell.mockTooltip")}
      className={`inline-flex items-center rounded border border-amber-400/40 bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wider text-amber-300 ${className}`}
    >
      {t("shell.mockBadge")}
    </span>
  );
}
