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
      className={`inline-flex items-center rounded-[2px] border border-ochre-rule bg-ochre-wash px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-ochre ${className}`}
    >
      {t("shell.mockBadge")}
    </span>
  );
}
