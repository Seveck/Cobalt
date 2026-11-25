import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import type { Language } from "@/types/contracts";
import en from "./locales/en.json";
import es from "./locales/es.json";

export const SUPPORTED_LANGUAGES: readonly Language[] = ["es", "en"];

function detectInitialLanguage(): Language {
  const nav = typeof navigator !== "undefined" ? navigator.language.slice(0, 2) : "es";
  return nav === "en" ? "en" : "es";
}

void i18n.use(initReactI18next).init({
  resources: { es: { translation: es }, en: { translation: en } },
  lng: detectInitialLanguage(),
  fallbackLng: "es",
  supportedLngs: [...SUPPORTED_LANGUAGES],
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
