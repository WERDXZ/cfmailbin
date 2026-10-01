export const sourceLocale = "zh-CN";
export const locales = { "zh-CN": "简体中文", en: "English" } as const;
export type Locale = keyof typeof locales;
export type AccountLocale = Locale | "auto";
export const fallbackLocale: Locale = "en";

export function isLocale(value: unknown): value is Locale {
  return value === "zh-CN" || value === "en";
}

export function isAccountLocale(value: unknown): value is AccountLocale {
  return value === "auto" || isLocale(value);
}

export const localeCookieName = "cfmailbin_locale";

export function readLocaleCookie(cookies: string): Locale | null {
  for (const cookie of cookies.split(";")) {
    const [key, ...parts] = cookie.trim().split("=");
    if (key !== localeCookieName) continue;
    try {
      const value = decodeURIComponent(parts.join("="));
      if (isLocale(value)) return value;
    } catch { /* Ignore malformed cookie values. */ }
  }
  return null;
}

export function localeCookie(locale: Locale | null, secure: boolean): string {
  return `${localeCookieName}=${locale ?? ""}; Path=/; Max-Age=${
    locale ? 31_536_000 : 0
  }; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function resolveLocale(
  cookie: unknown,
  account: unknown,
  browserLanguage?: unknown,
): Locale {
  if (isLocale(cookie)) return cookie;
  if (isLocale(account)) return account;
  return typeof browserLanguage === "string" &&
      /^zh(?:-|$)/i.test(browserLanguage.trim())
    ? sourceLocale
    : fallbackLocale;
}
