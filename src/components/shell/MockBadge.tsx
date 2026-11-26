import { useTranslation } from "react-i18next";
import { isTauri } from "@/lib/ipc";

interface MockBadgeProps {
  className?: string;
}

/** Browser-preview only badge; never rendered inside Tauri. */
export function MockBadge({ className = "" }: MockBadgeProps) {
  const { t } = useTranslation();
  if (isTauri()) return null;
  return (
    <span
      title={t("shell.mockTooltip")}
      className={`inline-flex items-center rounded-[2px] border border-ochre-rule bg-ochre-wash px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-ochre ${className}`}
    >
      {t("shell.mockBadge")}
    </span>
  );
}
