import { translator } from "./translate.ts";
import type { DisplayMessage } from "./messages.ts";
import { useI18n } from "./i18n.tsx";
import { type Locale, sourceLocale } from "../domain/locale.ts";
import { useState } from "preact/hooks";

export type RunAction = <T>(
  action: () => Promise<T>,
  notice?: DisplayMessage,
) => Promise<T | undefined>;

export function formatDate(
  value: string,
  locale: Locale = sourceLocale,
): string {
  return new Date(value).toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function relativeDate(
  value: string,
  locale: Locale = sourceLocale,
): string {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(value)) / 60000),
  );
  if (minutes < 1) return translator(locale)("common.justNow");
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "always" });
  if (minutes < 60) return format.format(-minutes, "minute");
  if (minutes < 1440) return format.format(-Math.floor(minutes / 60), "hour");
  if (minutes < 10080) return format.format(-Math.floor(minutes / 1440), "day");
  return formatDate(value, locale);
}

export function CopyButton(
  {
    value,
    label,
    accessibleLabel,
    className = "button",
    iconOnly = false,
  }: {
    value: string;
    label?: string;
    accessibleLabel?: string;
    className?: string;
    iconOnly?: boolean;
  },
) {
  const { t } = useI18n();
  label ??= t("common.copy");
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setFailed(false);
    } catch {
      setFailed(true);
      setCopied(false);
    }
  }
  return (
    <span class="copy-control">
      <button
        type="button"
        class={className}
        onClick={copy}
        onBlur={() => setCopied(false)}
        aria-label={accessibleLabel ?? `${label} ${value}`}
        title={accessibleLabel ?? `${label} ${value}`}
      >
        {iconOnly && (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            {copied ? <path d="m5 12 4 4L19 6" /> : (
              <>
                <rect x="8" y="8" width="12" height="12" rx="2" />
                <path d="M16 8V4H4v12h4" />
              </>
            )}
          </svg>
        )}
        <span class={iconOnly ? "sr-only" : undefined} aria-live="polite">
          {copied ? t("common.copied") : label}
        </span>
      </button>
      {failed && (
        <span class="copy-fallback" role="status">
          {t("common.clipboardUnavailableSelectAndCopy")}
          <input
            aria-label={t("common.contentToCopyManually")}
            readOnly
            value={value}
            onFocus={(event) => event.currentTarget.select()}
          />
        </span>
      )}
    </span>
  );
}
