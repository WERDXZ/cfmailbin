import { en } from "./locales/en.ts";
import { analysisFailureKeys } from "./labels.ts";
import type { TranslationKey, Translator } from "./translate.ts";

const aiFailureKeys = new Set<string>(Object.values(analysisFailureKeys));

export interface MessageDescriptor {
  message: string;
  code?: string;
  params?: Record<string, string | number>;
}
export type DisplayMessage = string | MessageDescriptor;

export function localizedMessage(code: TranslationKey): MessageDescriptor {
  return { code, message: en[code] };
}

/** Only explicit, recognized codes are translated; arbitrary text stays literal. */
export function formatMessage(value: DisplayMessage, t: Translator): string {
  if (typeof value === "string") return value;
  if (!value.code || !Object.hasOwn(en, value.code)) return value.message;
  // Dynamic API codes are validated above. Static UI calls use i18next's stricter
  // key and interpolation types directly.
  const translate = t as (key: TranslationKey, options: {
    replace: Record<string, string | number>;
  }) => string;
  const message = translate(value.code as TranslationKey, {
    replace: value.params ?? {},
  });
  const status = value.params?.httpStatus;
  return aiFailureKeys.has(value.code) && typeof status === "number"
    ? `${message} · HTTP ${status}`
    : message;
}
