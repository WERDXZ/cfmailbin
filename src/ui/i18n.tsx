import { type ComponentChildren, createContext } from "preact";
import { useContext, useEffect, useMemo, useState } from "preact/hooks";
import {
  type AccountLocale,
  fallbackLocale,
  isLocale,
  type Locale,
  localeCookie,
  readLocaleCookie,
  resolveLocale,
} from "../domain/locale.ts";
import { translator } from "./translate.ts";

const Localization = createContext({
  locale: fallbackLocale,
  browserLocale: null as Locale | null,
  setBrowserLocale: (_locale: Locale | null) => {},
  setAccountLocale: (_locale: AccountLocale) => {},
  t: translator(fallbackLocale),
});

export function LocaleProvider({ children }: { children: ComponentChildren }) {
  const [account, setAccountLocale] = useState<AccountLocale>("auto");
  const [browser, setBrowser] = useState<Locale | null>(() => {
    try {
      return readLocaleCookie(document.cookie);
    } catch {
      return null;
    }
  });
  const locale = resolveLocale(
    browser,
    account,
    typeof navigator === "undefined" ? undefined : navigator.language,
  );
  const value = useMemo(() => ({
    locale,
    browserLocale: browser,
    setAccountLocale,
    setBrowserLocale(next: Locale | null) {
      if (next !== null && !isLocale(next)) return;
      try {
        document.cookie = localeCookie(next, location.protocol === "https:");
      } catch {
        /* The selection still applies for this page if cookies are blocked. */
      }
      setBrowser(next);
    },
    t: translator(locale),
  }), [browser, locale]);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return <Localization.Provider value={value}>{children}
  </Localization.Provider>;
}

export const useI18n = () => useContext(Localization);
