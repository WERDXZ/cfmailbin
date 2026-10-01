import {
  type DisplayMessage,
  formatMessage,
  localizedMessage,
} from "./messages.ts";
import { useI18n } from "./i18n.tsx";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { RuleTrace } from "./RuleTrace.tsx";
import { GraphTrace } from "./GraphTrace.tsx";
import { api, ApiError } from "./api.ts";
import { CopyButton, formatDate, type RunAction } from "./common.tsx";
import { TagsInput } from "./TagsInput.tsx";
import type { MessageContent, MessageRecord, MessageStatus } from "./types.ts";

export function MessageDetail(
  { message, run, refresh, onError, onClose }: {
    message: MessageRecord;
    run: RunAction;
    refresh: () => void;
    onError: (error: unknown) => void;
    onClose: () => void;
  },
) {
  const { t, locale } = useI18n();
  const [content, setContent] = useState<MessageContent | null>(null);
  const detail = useRef<HTMLElement>(null);
  const [error, setError] = useState<DisplayMessage>("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [tags, setTags] = useState<string[] | undefined>();
  const [status, setStatus] = useState<MessageStatus | undefined>();
  const tagsChanged = tags !== undefined &&
    JSON.stringify(tags) !== JSON.stringify(message.tags);
  const statusChanged = status !== undefined && status !== message.status;
  useLayoutEffect(() => {
    setTags((edited) =>
      JSON.stringify(edited) === JSON.stringify(message.tags)
        ? undefined
        : edited
    );
    setStatus((edited) => edited === message.status ? undefined : edited);
  }, [message.tags, message.status]);
  const [bodyView, setBodyView] = useState<"text" | "html">("text");
  // An inbox update can finish AI enrichment while this body remains open.
  const codes = message.verificationCodes ?? content?.codes ?? [];
  useEffect(() => {
    if (content && matchMedia("(max-width: 900px)").matches) {
      detail.current?.scrollIntoView({ block: "start", behavior: "instant" });
    }
  }, [message.id, content]);
  useEffect(() => {
    const controller = new AbortController();
    setContent(null);
    setError("");
    api.getMessageContent(message.id, controller.signal).then((next) => {
      if (!controller.signal.aborted) setContent(next);
    }).catch((caught) => {
      if (!controller.signal.aborted) {
        setError(localizedMessage("errors.unableToLoadTheBodyTheEmail"));
        if (caught instanceof ApiError && [401, 403].includes(caught.status)) {
          onError(caught);
        }
      }
    });
    return () => controller.abort();
  }, [message.id, attempt, onError]);

  async function download() {
    await run(async () => {
      const blob = await api.downloadRawMessage(message.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${message.id}.eml`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  async function save(event: Event) {
    event.preventDefault();
    if (busy || !tagsChanged && !statusChanged) return;
    setBusy(true);
    await run(async () => {
      try {
        if (statusChanged) {
          await api.patchMessage(message.id, { status });
          setStatus((edited) => edited === status ? undefined : edited);
        }
        if (tagsChanged) {
          await api.replaceMessageTags(message.id, tags);
          setTags((edited) =>
            JSON.stringify(edited) === JSON.stringify(tags) ? undefined : edited
          );
        }
      } finally {
        // Reconcile successful fields even if a second request fails.
        refresh();
      }
    }, localizedMessage("message.mailSettingsSaved"));
    setBusy(false);
  }
  async function remove() {
    if (
      !confirm(
        t("message.confirmDelete", {
          subject: message.subject || t("inbox.noSubject"),
        }),
      )
    ) return;
    setBusy(true);
    await run(async () => {
      await api.deleteMessages([message.id]);
      refresh();
    }, localizedMessage("message.emailDeletedTheAddressIsRetained"));
    setBusy(false);
  }
  return (
    <article
      ref={detail}
      class="message-detail"
      aria-label={t("message.emailDetails")}
    >
      <header class="detail-heading">
        <button type="button" class="text-button" onClick={onClose}>
          {t("message.hideBody")}
        </button>
        <button type="button" class="text-button" onClick={download}>
          {t("message.downloadEml")}
        </button>
      </header>
      <dl class="message-meta message-envelope">
        <div>
          <dt>{t("message.from")}</dt>
          <dd>{message.from}</dd>
        </div>
        <div>
          <dt>{t("message.to")}</dt>
          <dd>{message.aliasAddress}</dd>
        </div>
        <div>
          <dt>{t("message.received")}</dt>
          <dd>{formatDate(message.receivedAt, locale)}</dd>
        </div>
      </dl>
      {error
        ? (
          <div class="inline-error" role="alert">
            {formatMessage(error, t)}
            <button
              type="button"
              class="button"
              onClick={() => setAttempt((value) => value + 1)}
            >
              {t("common.retry")}
            </button>
          </div>
        )
        : !content
        ? <p class="muted" role="status">{t("message.loadingEmailBody")}</p>
        : (
          <>
            {codes.length > 0 && (
              <section
                class="code-panel"
                aria-label={t("message.verificationCode")}
              >
                <div class="code-heading">
                  <span>{t("message.detectedVerificationCodes")}</span>
                </div>
                {codes.map((code) => (
                  <div class="code-row" key={code}>
                    <code>{code}</code>
                    <CopyButton
                      value={code}
                      label={t("message.copyVerificationCode")}
                      className="button button--primary"
                    />
                  </div>
                ))}
              </section>
            )}
            {content.warning && (
              <p class="inline-error">
                {content.warning === "too_large"
                  ? t("message.thisEmailExceeds1MibDownloadThe")
                  : t("message.thisEmailFormatCouldNotBeParsed")}
              </p>
            )}
            {content.links.length > 0 && (
              <details class="email-links">
                <summary>
                  {t("message.linksInThisEmail")}
                  {content.links.length}
                </summary>
                <ul>
                  {content.links.map((link) => (
                    <li key={link.url}>
                      <a
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        referrerPolicy="no-referrer"
                      >
                        <span>{link.label} ↗</span>
                        <small>{new URL(link.url).hostname}</small>
                      </a>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <section class="message-reader" aria-label={t("message.emailBody")}>
              <div class="body-heading">
                <h2>{t("message.body")}</h2>
                {content.html && (
                  <div
                    class="body-view-switch"
                    aria-label={t("message.bodyDisplayMode")}
                  >
                    <button
                      type="button"
                      class="text-button"
                      aria-pressed={bodyView === "text"}
                      onClick={() => setBodyView("text")}
                    >
                      {t("conditions.text")}
                    </button>
                    <button
                      type="button"
                      class="text-button"
                      aria-pressed={bodyView === "html"}
                      onClick={() => setBodyView("html")}
                    >
                      {t("message.htmlPreview")}
                    </button>
                  </div>
                )}
              </div>
              {bodyView === "html" && content.html
                ? (
                  <>
                    <p class="muted html-preview-note">
                      {t(
                        "message.externalImagesAndInteractiveContentAreBlocked",
                      )}
                    </p>
                    <iframe
                      class="email-html"
                      title={t("message.emailHtmlPreview")}
                      sandbox=""
                      referrerPolicy="no-referrer"
                      srcDoc={content.html}
                    />
                  </>
                )
                : (
                  <pre class="email-body">{content.text || t("message.noBodyToDisplay")}</pre>
                )}
              {content.truncated && (
                <p class="muted">
                  {t("message.bodyTruncatedDownloadTheOriginalForThe")}
                </p>
              )}
            </section>
          </>
        )}
      <details class="message-rule-details">
        <summary>
          {message.graphRun
            ? t("message.workflowExecution")
            : t("message.rulesAtReceipt")}
        </summary>
        {message.graphRun
          ? <GraphTrace run={message.graphRun} />
          : message.ruleTrace === undefined
          ? <p class="muted">{t("message.thisHistoricalEmailHasNoFullRule")}</p>
          : message.ruleTrace.length
          ? <RuleTrace traces={message.ruleTrace} />
          : (
            <p class="muted">
              {t("message.noRuleMatchedTheAddressDefaultWas")}
            </p>
          )}
      </details>
      <footer class="message-footer">
        <span>
          {t("message.scheduledForCleanupOn", {
            time: formatDate(message.expiresAt, locale),
          })}
        </span>
        <details class="management">
          <summary>{t("message.tagsAndMailManagement")}</summary>
          <form onSubmit={save} class="settings-form">
            <label>
              {t("actions.tagsCommaSeparated")}
              <TagsInput
                value={tags ?? message.tags}
                onChange={setTags}
              />
            </label>
            <label>
              {t("receiving.status")}
              <select
                value={status ?? message.status}
                onChange={(event) =>
                  setStatus(event.currentTarget.value as MessageStatus)}
              >
                <option value="inbox">{t("inbox.inbox")}</option>
                <option value="forwarded">{t("inbox.forwarded")}</option>
                <option value="trashed">{t("inbox.trash")}</option>
                <option value="blocked">{t("inbox.blocked")}</option>
              </select>
            </label>
            <div class="button-row">
              <button
                type="submit"
                class="button"
                disabled={busy || !tagsChanged && !statusChanged}
              >
                {t("common.save")}
              </button>
              <button
                type="button"
                class="text-button danger"
                disabled={busy}
                onClick={remove}
              >
                {t("message.permanentlyDeleteEmail")}
              </button>
            </div>
          </form>
        </details>
      </footer>
    </article>
  );
}
