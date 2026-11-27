import { useTranslation } from "react-i18next";
import {
  BookmarkPlus,
  Code2,
  HardDrive,
  Lock,
  Plug,
  Search,
  ShieldCheck,
  WifiOff,
  Zap,
  type LucideIcon,
} from "lucide-react";

interface StageSpec {
  key: "save" | "connect" | "remember" | "saveTokens";
  icon: LucideIcon;
  accentClass: string;
}

const STAGES: readonly StageSpec[] = [
  {
    key: "save",
    icon: BookmarkPlus,
    accentClass: "border-cobalt-rule bg-cobalt-wash text-cobalt-ink",
  },
  {
    key: "connect",
    icon: Plug,
    accentClass: "border-verdigris-rule bg-verdigris-wash text-verdigris",
  },
  {
    key: "remember",
    icon: Search,
    accentClass: "border-ochre-rule bg-ochre-wash text-ochre",
  },
  {
    key: "saveTokens",
    icon: Zap,
    accentClass: "border-cobalt-rule bg-cobalt-wash text-cobalt-ink",
  },
] as const;

interface PrincipleSpec {
  key: "yours" | "local" | "noTelemetry" | "noDelete" | "openSource";
  icon: LucideIcon;
}

const PRINCIPLES: readonly PrincipleSpec[] = [
  { key: "yours", icon: ShieldCheck },
  { key: "local", icon: HardDrive },
  { key: "noTelemetry", icon: WifiOff },
  { key: "noDelete", icon: Lock },
  { key: "openSource", icon: Code2 },
] as const;

export interface WelcomeExplainerProps {
  /** Compact spacing for embedding inside Settings → About. */
  compact?: boolean;
}

export function WelcomeExplainer({ compact = false }: WelcomeExplainerProps) {
  const { t } = useTranslation();

  return (
    <div className={compact ? "space-y-4" : "space-y-6"}>
      <div>
        {!compact && (
          <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-cobalt-ink">
            01 — {t("explainer.stepLabel")}
          </div>
        )}
        <h2
          className={
            compact
              ? "text-base font-semibold tracking-tight text-bone"
              : "mt-2 text-2xl font-semibold tracking-tight text-bone sm:text-3xl"
          }
        >
          {t("explainer.title")}
        </h2>
        <p
          className={
            compact
              ? "mt-1 text-xs leading-relaxed text-bone-muted"
              : "mt-2 max-w-2xl text-sm leading-relaxed text-bone-muted"
          }
        >
          {t("explainer.subtitle")}
        </p>
      </div>

      {/* Four stages */}
      <div
        className={`grid grid-cols-1 gap-3 ${
          compact ? "sm:grid-cols-2" : "sm:grid-cols-2 lg:grid-cols-4"
        }`}
      >
        {STAGES.map(({ key, icon: Icon, accentClass }, index) => (
          <div
            key={key}
            className="flex flex-col gap-2.5 rounded-[2px] border border-rule bg-void p-4"
          >
            <div className="flex items-center justify-between gap-2">
              <span
                className={`inline-flex h-8 w-8 items-center justify-center rounded-[2px] border ${accentClass}`}
              >
                <Icon size={15} aria-hidden />
              </span>
              <span className="font-mono text-[10px] text-bone-subtle">0{index + 1}</span>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-bone">
                {t(`explainer.stages.${key}.title`)}
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-bone-muted">
                {t(`explainer.stages.${key}.desc`)}
              </p>
            </div>
          </div>
        ))}
      </div>

      {/* Principles */}
      <div className="space-y-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-bone-subtle">
          {t("explainer.principlesTitle")}
        </div>
        <ul className="flex flex-wrap gap-2">
          {PRINCIPLES.map(({ key, icon: Icon }) => (
            <li
              key={key}
              className="inline-flex items-center gap-1.5 rounded-[2px] border border-rule bg-surface-2 px-2.5 py-1.5 text-xs text-bone"
            >
              <Icon size={12} className="shrink-0 text-cobalt-ink" aria-hidden />
              <span>{t(`explainer.principles.${key}`)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
