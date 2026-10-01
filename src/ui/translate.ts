import { createInstance, type TFunction } from "i18next";
import type { Locale } from "../domain/locale.ts";
import { fallbackLocale } from "../domain/locale.ts";
import { en } from "./locales/en.ts";
import { zhCN } from "./locales/zh-CN.ts";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    keySeparator: false;
    returnNull: false;
    strictKeyChecks: true;
    resources: { translation: typeof en };
  }
}

export const i18n = createInstance();
// Both catalogs are bundled, so initialization is synchronous and needs no fetch.
void i18n.init({
  resources: { en: { translation: en }, "zh-CN": { translation: zhCN } },
  lng: fallbackLocale,
  fallbackLng: fallbackLocale,
  supportedLngs: ["en", "zh-CN"],
  load: "currentOnly",
  initAsync: false,
  keySeparator: false,
  nsSeparator: false,
  returnNull: false,
  // Preact escapes text nodes. Interpolated values must remain literal strings.
  interpolation: { escapeValue: false },
});

export type Translator = TFunction<"translation">;
export type TranslationKey = keyof typeof en;

export function translator(locale: Locale): Translator {
  return i18n.getFixedT(locale);
}
