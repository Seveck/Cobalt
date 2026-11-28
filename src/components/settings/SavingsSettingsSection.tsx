import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Coins, Info, Plus, RotateCcw, Save } from "lucide-react";
import { backendCall } from "@/lib/backend";
import { formatAiClientName } from "@/lib/format";
import { isInternalClient, normalizeClientKey } from "@/lib/savings";
import { useSettingsStore, useUiStore } from "@/stores";
import { AI_CLIENTS, type ClientStats } from "@/types/contracts";

interface SavingsSettingsSectionProps {
  onSaved: () => void;
}

function formatNumberDraft(value: number): string {
  return Number.isFinite(value) ? String(value) : "";
}

export function SavingsSettingsSection({ onSaved }: SavingsSettingsSectionProps) {
  const { t } = useTranslation();
  const sectionRef = useRef<HTMLElement | null>(null);

  const globalPriceId = useId();
  const tokensPerSecId = useId();

  const settings = useSettingsStore((s) => s.settings);
  const saving = useSettingsStore((s) => s.saving);
  const patchSettings = useSettingsStore((s) => s.patchSettings);
  const clearSettingsError = useSettingsStore((s) => s.clearError);

  const settingsFocusSection = useUiStore((s) => s.settingsFocusSection);
  const clearSettingsFocusSection = useUiStore((s) => s.clearSettingsFocusSection);

  const [highlight, setHighlight] = useState(false);
  const [telemetryClients, setTelemetryClients] = useState<ClientStats[]>([]);

  const [globalPriceDraft, setGlobalPriceDraft] = useState<string>(() =>
    formatNumberDraft(settings.savings.usd_per_million_tokens),
  );
  const [tpsDraft, setTpsDraft] = useState<string>(() =>
    formatNumberDraft(settings.savings.tokens_per_second),
  );
  const [clientPriceDrafts, setClientPriceDrafts] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const [k, v] of Object.entries(settings.savings.client_prices ?? {})) {
      initial[k] = formatNumberDraft(v);
    }
    return initial;
  });

  const [newClientName, setNewClientName] = useState("");
  const [newClientPrice, setNewClientPrice] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    setGlobalPriceDraft(formatNumberDraft(settings.savings.usd_per_million_tokens));
    setTpsDraft(formatNumberDraft(settings.savings.tokens_per_second));
    const nextDrafts: Record<string, string> = {};
    for (const [k, v] of Object.entries(settings.savings.client_prices ?? {})) {
      nextDrafts[k] = formatNumberDraft(v);
    }
    setClientPriceDrafts(nextDrafts);
  }, [settings.savings]);

  useEffect(() => {
    void backendCall("get_telemetry_summary", { from: null, to: null, session_only: false })
      .then((res) => setTelemetryClients(res.by_client ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (settingsFocusSection !== "savings") return;
    sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    setHighlight(true);
    clearSettingsFocusSection();
    const timer = window.setTimeout(() => setHighlight(false), 2400);
    return () => window.clearTimeout(timer);
  }, [clearSettingsFocusSection, settingsFocusSection]);

  const knownClients = useMemo<Array<{ key: string; label: string }>>(() => {
    const list: Array<{ key: string; label: string }> = [];
    const seenNorms = new Set<string>();

    for (const client of AI_CLIENTS) {
      seenNorms.add(normalizeClientKey(client));
      list.push({ key: client, label: formatAiClientName(client) });
    }

    for (const client of telemetryClients) {
      if (isInternalClient(client.client_name)) continue;
      const norm = normalizeClientKey(client.client_name);
      if (seenNorms.has(norm)) continue;
      seenNorms.add(norm);
      list.push({ key: client.client_name, label: formatAiClientName(client.client_name) });
    }

    for (const key of Object.keys(clientPriceDrafts)) {
      if (isInternalClient(key)) continue;
      const norm = normalizeClientKey(key);
      if (seenNorms.has(norm)) continue;
      seenNorms.add(norm);
      list.push({ key, label: formatAiClientName(key) });
    }

    return list;
  }, [clientPriceDrafts, telemetryClients]);

  const handleSetClientDraft = (clientKey: string, value: string) => {
    setValidationError(null);
    setClientPriceDrafts((prev) => ({
      ...prev,
      [clientKey]: value,
    }));
  };

  const handleClearClientDraft = (clientKey: string) => {
    setValidationError(null);
    setClientPriceDrafts((prev) => {
      const next = { ...prev };
      delete next[clientKey];
      return next;
    });
  };

  const handleAddCustomClient = () => {
    const trimmedName = newClientName.trim();
    if (!trimmedName || isInternalClient(trimmedName)) return;
    const trimmedPrice = newClientPrice.trim();
    setClientPriceDrafts((prev) => ({
      ...prev,
      [trimmedName]: trimmedPrice,
    }));
    setNewClientName("");
    setNewClientPrice("");
    setValidationError(null);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);
    clearSettingsError();

    const parsedGlobal = Number(globalPriceDraft);
    if (!Number.isFinite(parsedGlobal) || parsedGlobal < 0) {
      setValidationError(t("settings.savings.invalidPrice"));
      return;
    }

    const parsedTps = Number(tpsDraft);
    if (!Number.isFinite(parsedTps) || parsedTps <= 0) {
      setValidationError(t("settings.savings.invalidTps"));
      return;
    }

    const nextClientPrices: Record<string, number> = {};
    for (const [key, raw] of Object.entries(clientPriceDrafts)) {
      const trimmed = raw.trim();
      if (trimmed === "") continue;
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed) || parsed < 0) {
        setValidationError(
          t("settings.savings.invalidClientPrice", { client: formatAiClientName(key) }),
        );
        return;
      }
      nextClientPrices[key] = parsed;
    }

    await patchSettings({
      savings: {
        usd_per_million_tokens: parsedGlobal,
        client_prices: nextClientPrices,
        tokens_per_second: parsedTps,
      },
    });
    if (!useSettingsStore.getState().error) {
      onSaved();
    }
  };

  return (
    <section
      id="settings-savings"
      ref={sectionRef}
      className={`rounded-[2px] border bg-surface transition-colors duration-300 ${
        highlight ? "border-cobalt-ink ring-1 ring-cobalt-ink" : "border-rule"
      }`}
    >
      <div className="border-b border-rule px-5 py-3">
        <h2 className="flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-bone-subtle">
          <Coins size={13} className="text-verdigris" aria-hidden />
          04 — {t("settings.savings.title")}
        </h2>
        <p className="mt-1 text-xs text-bone-muted">{t("settings.savings.subtitle")}</p>
      </div>

      <form onSubmit={(e) => void handleSave(e)}>
        <div className="space-y-5 p-5">
          {/* Estimates disclaimer */}
          <div className="flex items-start gap-2 rounded-[2px] border border-cobalt-rule/60 bg-cobalt-wash/40 px-3.5 py-2.5 text-xs text-bone-muted">
            <Info size={14} className="mt-0.5 shrink-0 text-cobalt-ink" aria-hidden />
            <span>{t("settings.savings.estimateNote")}</span>
          </div>

          {validationError && (
            <div className="rounded-[2px] border border-cinnabar-rule bg-cinnabar-wash px-3.5 py-2 text-xs text-cinnabar">
              {validationError}
            </div>
          )}

          {/* Global price + Tokens/second */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label
                htmlFor={globalPriceId}
                className="block text-sm font-medium text-bone"
              >
                {t("settings.savings.globalPriceLabel")}
              </label>
              <div className="relative">
                <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 font-mono text-xs text-bone-subtle">
                  $
                </span>
                <input
                  id={globalPriceId}
                  type="number"
                  min={0}
                  step="0.01"
                  value={globalPriceDraft}
                  disabled={saving}
                  onChange={(e) => {
                    setGlobalPriceDraft(e.target.value);
                    setValidationError(null);
                  }}
                  className="h-9 w-full rounded-[2px] border border-rule-strong bg-void pr-24 pl-6 font-mono text-xs tabular-nums text-bone focus:border-cobalt-ink focus:outline-none disabled:opacity-45"
                />
                <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 font-mono text-[10px] text-bone-subtle">
                  / 1M tokens
                </span>
              </div>
              <p className="text-[11px] text-bone-muted">
                {t("settings.savings.globalPriceHint")}
              </p>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor={tokensPerSecId}
                className="block text-sm font-medium text-bone"
              >
                {t("settings.savings.tokensPerSecondLabel")}
              </label>
              <div className="relative">
                <input
                  id={tokensPerSecId}
                  type="number"
                  min={1}
                  step="10"
                  value={tpsDraft}
                  disabled={saving}
                  onChange={(e) => {
                    setTpsDraft(e.target.value);
                    setValidationError(null);
                  }}
                  className="h-9 w-full rounded-[2px] border border-rule-strong bg-void pr-20 pl-3 font-mono text-xs tabular-nums text-bone focus:border-cobalt-ink focus:outline-none disabled:opacity-45"
                />
                <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 font-mono text-[10px] text-bone-subtle">
                  tokens/s
                </span>
              </div>
              <p className="text-[11px] text-bone-muted">
                {t("settings.savings.tokensPerSecondHint")}
              </p>
            </div>
          </div>

          {/* Per-AI prices */}
          <div className="space-y-2.5 border-t border-rule pt-4">
            <div>
              <h3 className="text-sm font-medium text-bone">
                {t("settings.savings.perAiTitle")}
              </h3>
              <p className="mt-0.5 text-xs text-bone-muted">
                {t("settings.savings.perAiHint")}
              </p>
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {knownClients.map((client) => {
                const draft = clientPriceDrafts[client.key] ?? "";
                const hasCustom = draft.trim().length > 0;
                return (
                  <div
                    key={client.key}
                    className="flex items-center justify-between gap-2 rounded-[2px] border border-rule bg-void/70 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium text-bone">
                        {client.label}
                      </div>
                      <div className="font-mono text-[10px] text-bone-subtle">
                        {hasCustom
                          ? t("settings.savings.customPriceBadge")
                          : t("settings.savings.usingGlobalBadge")}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                      <div className="relative w-28">
                        <span className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 font-mono text-[11px] text-bone-subtle">
                          $
                        </span>
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          value={draft}
                          disabled={saving}
                          aria-label={t("settings.savings.clientPriceAria", {
                            client: client.label,
                          })}
                          placeholder={globalPriceDraft || "3"}
                          onChange={(e) => handleSetClientDraft(client.key, e.target.value)}
                          className="h-7 w-full rounded-[2px] border border-rule-strong bg-surface pr-2 pl-5 font-mono text-xs tabular-nums text-bone placeholder:text-bone-subtle/60 focus:border-cobalt-ink focus:outline-none disabled:opacity-45"
                        />
                      </div>
                      {hasCustom && (
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => handleClearClientDraft(client.key)}
                          title={t("settings.savings.resetToGlobal")}
                          aria-label={t("settings.savings.resetToGlobal")}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-[2px] border border-rule bg-surface text-bone-subtle hover:border-rule-strong hover:text-bone disabled:opacity-45"
                        >
                          <RotateCcw size={11} aria-hidden />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Add custom AI client price row */}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <input
                type="text"
                value={newClientName}
                disabled={saving}
                onChange={(e) => setNewClientName(e.target.value)}
                placeholder={t("settings.savings.addClientPlaceholder")}
                className="h-8 min-w-[160px] flex-1 rounded-[2px] border border-rule-strong bg-void px-2.5 text-xs text-bone placeholder:text-bone-subtle focus:border-cobalt-ink focus:outline-none disabled:opacity-45"
              />
              <div className="relative w-28">
                <span className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 font-mono text-[11px] text-bone-subtle">
                  $
                </span>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={newClientPrice}
                  disabled={saving}
                  onChange={(e) => setNewClientPrice(e.target.value)}
                  placeholder={globalPriceDraft || "3"}
                  className="h-8 w-full rounded-[2px] border border-rule-strong bg-void pr-2 pl-5 font-mono text-xs tabular-nums text-bone placeholder:text-bone-subtle/60 focus:border-cobalt-ink focus:outline-none disabled:opacity-45"
                />
              </div>
              <button
                type="button"
                disabled={saving || !newClientName.trim() || isInternalClient(newClientName)}
                onClick={handleAddCustomClient}
                className="inline-flex h-8 items-center gap-1 rounded-[2px] border border-rule-strong bg-surface-2 px-3 font-mono text-[11px] text-bone-muted hover:border-cobalt-ink/60 hover:text-bone disabled:opacity-45"
              >
                <Plus size={12} aria-hidden />
                {t("settings.savings.addClientButton")}
              </button>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end border-t border-rule bg-surface-2 px-5 py-3">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-4 py-1.5 text-xs font-semibold text-on-accent transition-colors hover:bg-cobalt-bright focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none disabled:opacity-45"
          >
            <Save size={13} aria-hidden />
            {t("settings.savings.saveButton")}
          </button>
        </div>
      </form>
    </section>
  );
}
