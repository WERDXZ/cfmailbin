import { useEffect, useRef, useState } from "preact/hooks";
import { RuleTrace } from "./RuleTrace.tsx";
import { api } from "./api.ts";
import { CopyButton, formatDate, type RunAction } from "./common.tsx";
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
  const [content, setContent] = useState<MessageContent | null>(null);
  const detail = useRef<HTMLElement>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [tags, setTags] = useState(message.tags.join(", "));
  const [status, setStatus] = useState(message.status);
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
        setError("暂时无法读取正文，邮件可能已被清理。可以重试或下载原件。");
        onError(caught);
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
    setBusy(true);
    await run(async () => {
      await api.patchMessage(message.id, { status });
      await api.replaceMessageTags(
        message.id,
        tags.split(",").map((tag) => tag.trim()).filter(Boolean),
      );
      refresh();
    }, "邮件设置已保存");
    setBusy(false);
  }
  async function remove() {
    if (
      !confirm(
        `删除「${message.subject || "无主题"}」及原始邮件？此操作无法撤销。`,
      )
    ) return;
    setBusy(true);
    await run(async () => {
      await api.deleteMessages([message.id]);
      refresh();
    }, "邮件已删除，邮箱地址仍然保留");
    setBusy(false);
  }
  return (
    <article ref={detail} class="message-detail" aria-label="邮件详情">
      <header class="detail-heading">
        <button type="button" class="text-button" onClick={onClose}>
          收起正文
        </button>
        <button type="button" class="text-button" onClick={download}>
          下载 .eml
        </button>
      </header>
      <dl class="message-meta message-envelope">
        <div>
          <dt>发件人</dt>
          <dd>{message.from}</dd>
        </div>
        <div>
          <dt>收件人</dt>
          <dd>{message.aliasAddress}</dd>
        </div>
        <div>
          <dt>收到于</dt>
          <dd>{formatDate(message.receivedAt)}</dd>
        </div>
      </dl>
      {error
        ? (
          <div class="inline-error" role="alert">
            {error}
            <button
              type="button"
              class="button"
              onClick={() => setAttempt((value) => value + 1)}
            >
              重试
            </button>
          </div>
        )
        : !content
        ? <p class="muted" role="status">正在读取邮件正文…</p>
        : (
          <>
            {codes.length > 0 && (
              <section class="code-panel" aria-label="验证码">
                <div class="code-heading">
                  <span>识别到的验证码</span>
                </div>
                {codes.map((code) => (
                  <div class="code-row" key={code}>
                    <code>{code}</code>
                    <CopyButton
                      value={code}
                      label="复制验证码"
                      className="button button--primary"
                    />
                  </div>
                ))}
              </section>
            )}
            {content.warning && (
              <p class="inline-error">
                {content.warning === "too_large"
                  ? "邮件超过 1 MiB，未展开正文。请下载原始邮件查看。"
                  : "这封邮件的格式无法解析，请下载原始邮件查看。"}
              </p>
            )}
            {content.links.length > 0 && (
              <details class="email-links">
                <summary>邮件中的链接 · {content.links.length}</summary>
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
            <section class="message-reader" aria-label="邮件正文">
              <div class="body-heading">
                <h2>正文</h2>
                {content.html && (
                  <div class="body-view-switch" aria-label="正文显示方式">
                    <button
                      type="button"
                      aria-pressed={bodyView === "text"}
                      onClick={() =>
                        setBodyView("text")}
                    >
                      文本
                    </button>
                    <button
                      type="button"
                      aria-pressed={bodyView === "html"}
                      onClick={() =>
                        setBodyView("html")}
                    >
                      HTML 预览
                    </button>
                  </div>
                )}
              </div>
              {bodyView === "html" && content.html
                ? (
                  <>
                    <p class="muted html-preview-note">
                      已屏蔽外部图片和交互内容。打开链接请使用上方链接列表。
                    </p>
                    <iframe
                      class="email-html"
                      title="邮件 HTML 预览"
                      sandbox=""
                      referrerPolicy="no-referrer"
                      srcDoc={content.html}
                    />
                  </>
                )
                : (
                  <pre class="email-body">{content.text || "没有可显示的正文。"}</pre>
                )}
              {content.truncated && (
                <p class="muted">正文已截断，完整内容请下载原件。</p>
              )}
            </section>
          </>
        )}
      <details class="message-rule-details">
        <summary>收件时的规则记录</summary>
        {message.ruleTrace === undefined
          ? <p class="muted">这封历史邮件未保存完整规则记录。</p>
          : message.ruleTrace.length
          ? <RuleTrace traces={message.ruleTrace} />
          : <p class="muted">没有命中规则，按地址的默认设置处理。</p>}
      </details>
      <footer class="message-footer">
        <span>邮件计划于 {formatDate(message.expiresAt)} 清理</span>
        <details class="management">
          <summary>标签与邮件管理</summary>
          <form onSubmit={save} class="settings-form">
            <label>
              标签（逗号分隔）<input
                value={tags}
                onInput={(event) => setTags(event.currentTarget.value)}
              />
            </label>
            <label>
              状态<select
                value={status}
                onChange={(event) =>
                  setStatus(event.currentTarget.value as MessageStatus)}
              >
                <option value="inbox">收件箱</option>
                <option value="forwarded">已转发</option>
                <option value="trashed">垃圾箱</option>
                <option value="blocked">已拦截</option>
              </select>
            </label>
            <div class="button-row">
              <button type="submit" class="button" disabled={busy}>保存</button>
              <button
                type="button"
                class="text-button danger"
                disabled={busy}
                onClick={remove}
              >
                永久删除邮件
              </button>
            </div>
          </form>
        </details>
      </footer>
    </article>
  );
}
