import { useState } from "preact/hooks";

export type RunAction = <T>(
  action: () => Promise<T>,
  notice?: string,
) => Promise<T | undefined>;

export function formatDate(value: string): string {
  return new Date(value).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function relativeDate(value: string): string {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(value)) / 60000),
  );
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)} 天前`;
  return formatDate(value);
}

export function CopyButton(
  {
    value,
    label = "复制",
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
          {copied ? "已复制 ✓" : label}
        </span>
      </button>
      {failed && (
        <span class="copy-fallback" role="status">
          无法访问剪贴板，请选中复制：<input
            aria-label="手动复制内容"
            readOnly
            value={value}
            onFocus={(event) => event.currentTarget.select()}
          />
        </span>
      )}
    </span>
  );
}
