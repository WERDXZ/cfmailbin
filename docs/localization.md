# Localization

The UI uses [i18next](https://www.i18next.com/) with bundled English and
Simplified Chinese catalogs. It does not use language-specific routes or fetch
translations at runtime. Preact's `LocaleProvider` selects the language and
exposes i18next's fixed-language `t` function through `useI18n()`.

Language precedence is:

1. The `cfmailbin_locale` cookie for this browser, if explicitly set.
2. An explicit account language stored in runtime settings.
3. The browser's locale when the account language is `auto`.
4. English for unsupported or missing locales.

All `zh-*` browser locales currently use Simplified Chinese. Settings → Account
can change either preference. Browser overrides take effect immediately; account
preferences take effect when saved. Changing the language does not change
routes.

## Adding messages

Add a stable semantic key to `src/ui/locales/en.ts` and its translation to
`src/ui/locales/zh-CN.ts`. Use the key at the call site:

```tsx
const { t } = useI18n();
<button title={t("inbox.copyAddress", { address })}>
  {t("common.copy")}
</button>;
```

Use named `{{parameters}}`, not positional substitutions. For counts, use `_one`
/ `_other` resources and pass a numeric `count`; i18next selects the form.
TypeScript checks static keys and interpolation arguments. Catalog tests check
key parity and interpolation names. Dates and relative times use `Intl` with the
resolved locale.

Translations produce text, never HTML. Preact escapes rendered text, so
i18next's HTML escaping is disabled to avoid double escaping. Do not inject a
translated string into `dangerouslySetInnerHTML`.

## Dynamic data and errors

Enums and built-in template IDs map explicitly to message keys. Built-in
template names are localized once when creating a draft. After saving, names are
ordinary user content. Email contents, custom labels, prompts, match values,
reply bodies, and stored snapshots remain literal; changing language never
rewrites them.

Errors may carry a stable `code` and named `params` alongside their original
`message`. API errors expose `{ error, code?, params? }`; workflow traces use
`errorCode` and `errorParams`. The UI translates recognized codes at render
time. Unknown codes and older records without codes display their original
message. There is no source-text lookup, so a custom label that happens to equal
a UI message is never translated accidentally. Raw audit JSON remains raw data.

Use `localizedMessage(key)` for UI notices stored in state and `formatMessage`
when rendering them. This keeps notices responsive to language changes without
caching already-translated text.

## Adding a language

1. Add its identifier and native-language label in `src/domain/locale.ts` and
   update locale resolution deliberately.
2. Add a catalog with the same keys as English; register it in
   `src/ui/translate.ts` and extend `supportedLngs`.
3. Extend the catalog and language-precedence tests in `tests/locale_test.ts`.
4. Verify switching, persistence, template creation, validation messages and
   narrow layouts in an isolated browser profile.

Run `deno task check`, `deno task test`, `deno task lint`, and
`deno fmt --check` before committing.
