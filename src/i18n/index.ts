import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import type { Language } from "@/types/contracts";
import en from "./locales/en.json";
import es from "./locales/es.json";

export const SUPPORTED_LANGUAGES: readonly Language[] = ["es", "en"];

/**
 * Detect OS/browser preferred language using the same rule as the Rust backend:
 * Spanish if the locale starts with `"es"`, otherwise English.
 */
export function detectOsLanguage(): Language {
  if (typeof navigator === "undefined") return "en";
  const raw = (navigator.language || navigator.languages?.[0] || "").trim().toLowerCase();
  return raw.startsWith("es") ? "es" : "en";
}

const initialLanguage = detectOsLanguage();

if (typeof document !== "undefined") {
  document.documentElement.lang = initialLanguage;
}

void i18n.use(initReactI18next).init({
  resources: { es: { translation: es }, en: { translation: en } },
  lng: initialLanguage,
  fallbackLng: "en",
  supportedLngs: [...SUPPORTED_LANGUAGES],
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
