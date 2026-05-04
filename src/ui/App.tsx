import { useEffect, useMemo, useState } from "preact/hooks";
import { api, ApiError } from "./api.ts";
import type {
  Alias,
  BootstrapResponse,
  CreateAliasInput,
  CreateRuleInput,
  MessageFilters,
  MessageRecord,
  MessageStatus,
  RuleAction,
  RuleField,
} from "./types.ts";

const SESSION_TOKEN_KEY = "cfmailbin.token";

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

function messageCountByStatus(
  messages: MessageRecord[],
  status: MessageStatus,
): number {
  return messages.filter((message) => message.status === status).length;
}

function splitTagInput(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function defaultAliasAction(forwardingConfigured: boolean): RuleAction {
  return forwardingConfigured ? "forward" : "keep";
}

export function App() {
  const [token, setToken] = useState(() =>
    sessionStorage.getItem(SESSION_TOKEN_KEY) ?? ""
  );
  const [tokenDraft, setTokenDraft] = useState(token);
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(
    null,
  );
  const [filters, setFilters] = useState<MessageFilters>({});
  const [aliasForm, setAliasForm] = useState<CreateAliasInput>({
    address: "",
    defaultAction: "forward",
    retentionDays: 7,
  });
  const [ruleForm, setRuleForm] = useState<CreateRuleInput>({
    action: "trash",
    aliasId: null,
    field: "from",
    pattern: "",
  });
  const [tagInput, setTagInput] = useState("");
  const [statusDraft, setStatusDraft] = useState<MessageStatus>("inbox");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadingBootstrap, setLoadingBootstrap] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const selectedMessage = useMemo(
    () => messages.find((message) => message.id === selectedMessageId) ?? null,
    [messages, selectedMessageId],
  );

  useEffect(() => {
    if (!selectedMessage) {
      setTagInput("");
      setStatusDraft("inbox");
      return;
    }

    setTagInput(selectedMessage.tags.join(", "));
    setStatusDraft(selectedMessage.status);
  }, [selectedMessage]);

  async function loadBootstrap(activeToken: string): Promise<void> {
    setLoadingBootstrap(true);

    try {
      const next = await api.getBootstrap(activeToken);
      setBootstrap(next);
      setAliasForm((current) => ({
        ...current,
        defaultAction: current.address
          ? current.defaultAction
          : defaultAliasAction(next.config.forwardingConfigured),
        retentionDays: current.retentionDays ||
          next.config.defaultRetentionDays,
      }));
      setRuleForm((current) => ({
        ...current,
        aliasId: current.aliasId && next.aliases.some((alias) =>
            alias.id === current.aliasId
          )
          ? current.aliasId
          : null,
      }));
    } finally {
      setLoadingBootstrap(false);
    }
  }

  async function loadMessages(activeToken: string): Promise<void> {
    setLoadingMessages(true);

    try {
      const nextMessages = await api.listMessages(activeToken, filters);
      setMessages(nextMessages);
      setSelectedMessageId((current) => {
        if (current && nextMessages.some((message) => message.id === current)) {
          return current;
        }

        return nextMessages[0]?.id ?? null;
      });
    } finally {
      setLoadingMessages(false);
    }
  }

  function clearSession(message?: string): void {
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
    setToken("");
    setTokenDraft("");
    setBootstrap(null);
    setMessages([]);
    setSelectedMessageId(null);
    setNotice(message ?? null);
  }

  async function runWithHandling<T>(
    action: () => Promise<T>,
    successMessage?: string,
  ): Promise<T | null> {
    setError(null);

    try {
      const result = await action();

      if (successMessage) {
        setNotice(successMessage);
      }

      return result;
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        clearSession("Session expired. Paste the token again.");
        return null;
      }

      const message = caught instanceof Error
        ? caught.message
        : "Request failed";
      setError(message);
      return null;
    }
  }

  useEffect(() => {
    if (!token) {
      return;
    }

    let cancelled = false;

    void (async () => {
      const ok = await runWithHandling(() => api.validateSession(token));

      if (!ok || cancelled) {
        return;
      }

      await runWithHandling(async () => {
        await loadBootstrap(token);
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!token) {
      return;
    }

    void runWithHandling(async () => {
      await loadMessages(token);
    });
  }, [filters.aliasId, filters.q, filters.status, token]);

  async function refreshAll(): Promise<void> {
    if (!token) {
      return;
    }

    await runWithHandling(async () => {
      await Promise.all([loadBootstrap(token), loadMessages(token)]);
    }, "Dashboard refreshed.");
  }

  async function handleTokenSubmit(event: Event): Promise<void> {
    event.preventDefault();
    const nextToken = tokenDraft.trim();

    if (!nextToken) {
      setError("Token is required.");
      return;
    }

    const valid = await runWithHandling(() => api.validateSession(nextToken));

    if (!valid) {
      return;
    }

    sessionStorage.setItem(SESSION_TOKEN_KEY, nextToken);
    setToken(nextToken);
    setNotice("Session token loaded.");
  }

  async function handleCreateAlias(event: Event): Promise<void> {
    event.preventDefault();

    if (!token) {
      return;
    }

    setSubmitting(true);

    try {
      const alias = await runWithHandling(
        () => api.createAlias(token, aliasForm),
        "Alias created.",
      );

      if (!alias) {
        return;
      }

      setAliasForm({
        address: "",
        defaultAction: bootstrap?.config.forwardingConfigured
          ? "forward"
          : "keep",
        retentionDays: bootstrap?.config.defaultRetentionDays ?? 7,
      });
      await Promise.all([loadBootstrap(token), loadMessages(token)]);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCreateRule(event: Event): Promise<void> {
    event.preventDefault();

    if (!token) {
      return;
    }

    setSubmitting(true);

    try {
      const rule = await runWithHandling(
        () => api.createRule(token, ruleForm),
        "Rule created.",
      );

      if (!rule) {
        return;
      }

      setRuleForm({
        action: "trash",
        aliasId: ruleForm.aliasId,
        field: "from",
        pattern: "",
      });
      await loadBootstrap(token);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAliasToggle(alias: Alias): Promise<void> {
    if (!token) {
      return;
    }

    await runWithHandling(async () => {
      await api.patchAlias(token, alias.id, { enabled: !alias.enabled });
      await loadBootstrap(token);
    }, alias.enabled ? "Alias disabled." : "Alias enabled.");
  }

  async function handleRuleToggle(
    ruleId: string,
    enabled: boolean,
  ): Promise<void> {
    if (!token) {
      return;
    }

    await runWithHandling(async () => {
      await api.patchRule(token, ruleId, { enabled: !enabled });
      await loadBootstrap(token);
    }, enabled ? "Rule disabled." : "Rule enabled.");
  }

  async function handleStatusSave(): Promise<void> {
    if (!token || !selectedMessage) {
      return;
    }

    await runWithHandling(async () => {
      await api.patchMessage(token, selectedMessage.id, {
        status: statusDraft,
      });
      await loadMessages(token);
    }, "Message status updated.");
  }

  async function handleTagSave(): Promise<void> {
    if (!token || !selectedMessage) {
      return;
    }

    await runWithHandling(async () => {
      await api.replaceMessageTags(
        token,
        selectedMessage.id,
        splitTagInput(tagInput),
      );
      await Promise.all([loadMessages(token), loadBootstrap(token)]);
    }, "Message tags saved.");
  }

  async function handleRawDownload(): Promise<void> {
    if (!token || !selectedMessage) {
      return;
    }

    const blob = await runWithHandling(() =>
      api.downloadRawMessage(token, selectedMessage.id)
    );

    if (!blob) {
      return;
    }

    triggerDownload(blob, `${selectedMessage.id}.eml`);
    setNotice("Raw message downloaded.");
  }

  if (!token) {
    return (
      <main class="auth-shell">
        <section class="auth-panel">
          <p class="eyebrow">Cloudflare disposable alias console</p>
          <h1>cfmailbin</h1>
          <p class="auth-copy">
            Paste an admin bearer token. The UI keeps it in{" "}
            <code>sessionStorage</code>
            and forwards it to the backend as an <code>Authorization</code>{" "}
            header.
          </p>
          <form class="auth-form" onSubmit={handleTokenSubmit}>
            <label class="field">
              <span>Session token</span>
              <input
                autoComplete="off"
                name="token"
                onInput={(event) =>
                  setTokenDraft(
                    (event.currentTarget as HTMLInputElement).value,
                  )}
                placeholder="paste token from D1"
                type="password"
                value={tokenDraft}
              />
            </label>
            <button class="button button--primary" type="submit">
              Open dashboard
            </button>
          </form>
          <div class="auth-footnote">
            <p>Minimal flow for v1:</p>
            <code>INSERT INTO tokens (token) VALUES ('replace-me');</code>
          </div>
          {error ? <p class="notice notice--error">{error}</p> : null}
          {notice ? <p class="notice">{notice}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main class="shell">
      <header class="hero">
        <div class="hero__copy">
          <p class="eyebrow">Own the alias. Keep the inbox light.</p>
          <h1>cfmailbin</h1>
          <p>
            A small operational console for disposable email aliases,
            short-lived inbox storage, forwarding rules, and fast cleanup.
          </p>
        </div>
        <div class="hero__card">
          <span class="hero__label">Control plane</span>
          <div class="hero__meta">
            <strong>
              {bootstrap?.config.allowCatchAll
                ? "Catch-all live"
                : "Explicit aliases"}
            </strong>
            <span>
              default retention {bootstrap?.config.defaultRetentionDays ?? 7}
              {" "}
              days
            </span>
            {bootstrap?.config.autoCreateAliasTag
              ? (
                <span>
                  auto-created aliases tagged as{" "}
                  <code>{bootstrap.config.autoCreateAliasTag}</code>
                </span>
              )
              : null}
          </div>
          <div class="hero__actions">
            <button
              class="button button--secondary"
              onClick={() => void refreshAll()}
              type="button"
            >
              Refresh
            </button>
            <button
              class="button button--ghost"
              onClick={() => clearSession("Session cleared.")}
              type="button"
            >
              Forget token
            </button>
          </div>
        </div>
      </header>

      {error ? <p class="notice notice--error">{error}</p> : null}
      {notice ? <p class="notice">{notice}</p> : null}

      <section class="metrics">
        <article class="metric-card">
          <span>aliases</span>
          <strong>{bootstrap?.aliases.length ?? 0}</strong>
        </article>
        <article class="metric-card">
          <span>rules</span>
          <strong>{bootstrap?.rules.length ?? 0}</strong>
        </article>
        <article class="metric-card">
          <span>messages</span>
          <strong>{messages.length}</strong>
        </article>
        <article class="metric-card">
          <span>forwarded</span>
          <strong>{messageCountByStatus(messages, "forwarded")}</strong>
        </article>
        <article class="metric-card">
          <span>trashed</span>
          <strong>{messageCountByStatus(messages, "trashed")}</strong>
        </article>
      </section>

      <section class="dashboard-grid">
        <section class="panel panel--aliases">
          <div class="panel__header">
            <div>
              <p class="panel__eyebrow">Alias registry</p>
              <h2>Mail slots</h2>
            </div>
            <span class="panel__badge">
              {loadingBootstrap ? "syncing" : "live"}
            </span>
          </div>

          <form class="stack" onSubmit={handleCreateAlias}>
            <label class="field">
              <span>Alias address</span>
              <input
                onInput={(event) =>
                  setAliasForm((current) => ({
                    ...current,
                    address: (event.currentTarget as HTMLInputElement).value,
                  }))}
                placeholder="shop@example.com"
                type="email"
                value={aliasForm.address}
              />
            </label>
            <label class="field">
              <span>Description</span>
              <input
                onInput={(event) =>
                  setAliasForm((current) => ({
                    ...current,
                    description:
                      (event.currentTarget as HTMLInputElement).value ||
                      undefined,
                  }))}
                placeholder="temporary checkout alias"
                type="text"
                value={aliasForm.description ?? ""}
              />
            </label>
            <div class="form-row">
              <label class="field">
                <span>Default action</span>
                <select
                  onInput={(event) =>
                    setAliasForm((current) => ({
                      ...current,
                      defaultAction: (event.currentTarget as HTMLSelectElement)
                        .value as RuleAction,
                    }))}
                  value={aliasForm.defaultAction}
                >
                  <option value="keep">keep</option>
                  <option value="forward">forward</option>
                  <option value="trash">trash</option>
                  <option value="block">block</option>
                </select>
              </label>
              <label class="field">
                <span>Retention days</span>
                <input
                  min="1"
                  onInput={(event) =>
                    setAliasForm((current) => ({
                      ...current,
                      retentionDays: Number(
                        (event.currentTarget as HTMLInputElement).value,
                      ) || 1,
                    }))}
                  type="number"
                  value={String(aliasForm.retentionDays)}
                />
              </label>
            </div>
            <label class="field">
              <span>Forward target</span>
              <input
                onInput={(event) =>
                  setAliasForm((current) => ({
                    ...current,
                    forwardTo:
                      (event.currentTarget as HTMLInputElement).value ||
                      undefined,
                  }))}
                placeholder="owner@example.com"
                type="email"
                value={aliasForm.forwardTo ?? ""}
              />
            </label>
            <button
              class="button button--primary"
              disabled={submitting}
              type="submit"
            >
              Create alias
            </button>
          </form>

          <div class="list">
            {bootstrap?.aliases.map((alias) => (
              <article class="card" key={alias.id}>
                <div class="card__header">
                  <div>
                    <strong>{alias.address}</strong>
                    <p>{alias.description ?? "No note"}</p>
                  </div>
                  <span
                    class={`pill ${
                      alias.enabled ? "pill--good" : "pill--muted"
                    }`}
                  >
                    {alias.enabled ? "enabled" : "disabled"}
                  </span>
                </div>
                <div class="card__meta">
                  <span>{alias.defaultAction}</span>
                  <span>{alias.retentionDays}d retention</span>
                </div>
                {alias.tags.length > 0
                  ? (
                    <div class="tag-cloud">
                      {alias.tags.map((tag) => (
                        <span class="pill pill--tag" key={tag}>{tag}</span>
                      ))}
                    </div>
                  )
                  : null}
                <button
                  class="button button--ghost"
                  onClick={() => void handleAliasToggle(alias)}
                  type="button"
                >
                  {alias.enabled ? "Disable" : "Enable"}
                </button>
              </article>
            ))}
          </div>
        </section>

        <section class="panel panel--messages">
          <div class="panel__header">
            <div>
              <p class="panel__eyebrow">Inbox surface</p>
              <h2>Messages</h2>
            </div>
            <span class="panel__badge">
              {loadingMessages ? "loading" : `${messages.length} visible`}
            </span>
          </div>

          <div class="stack">
            <label class="field">
              <span>Search</span>
              <input
                onInput={(event) => setFilters((current) => ({
                  ...current,
                  q: (event.currentTarget as HTMLInputElement).value ||
                    undefined,
                }))}
                placeholder="sender, subject, alias"
                type="search"
                value={filters.q ?? ""}
              />
            </label>
            <div class="form-row">
              <label class="field">
                <span>Alias</span>
                <select
                  onInput={(event) =>
                    setFilters((current) => ({
                      ...current,
                      aliasId:
                        (event.currentTarget as HTMLSelectElement).value ||
                        undefined,
                    }))}
                  value={filters.aliasId ?? ""}
                >
                  <option value="">all aliases</option>
                  {bootstrap?.aliases.map((alias) => (
                    <option key={alias.id} value={alias.id}>
                      {alias.address}
                    </option>
                  ))}
                </select>
              </label>
              <label class="field">
                <span>Status</span>
                <select
                  onInput={(event) => setFilters((current) => ({
                    ...current,
                    status: ((event.currentTarget as HTMLSelectElement).value ||
                      undefined) as MessageStatus | undefined,
                  }))}
                  value={filters.status ?? ""}
                >
                  <option value="">all statuses</option>
                  <option value="inbox">inbox</option>
                  <option value="forwarded">forwarded</option>
                  <option value="trashed">trashed</option>
                  <option value="blocked">blocked</option>
                </select>
              </label>
            </div>
          </div>

          <div class="list list--messages">
            {messages.length === 0
              ? (
                <article class="empty-state">
                  <strong>No messages yet.</strong>
                  <p>
                    Incoming email will appear here once the worker starts
                    storing mail.
                  </p>
                </article>
              )
              : messages.map((message) => (
                <button
                  class={`message-row ${
                    message.id === selectedMessageId
                      ? "message-row--active"
                      : ""
                  }`}
                  key={message.id}
                  onClick={() => setSelectedMessageId(message.id)}
                  type="button"
                >
                  <div class="message-row__header">
                    <strong>{message.subject || "(no subject)"}</strong>
                    <span class={`pill pill--status pill--${message.status}`}>
                      {message.status}
                    </span>
                  </div>
                  <div class="message-row__meta">
                    <span>{message.from}</span>
                    <span>{message.aliasAddress}</span>
                  </div>
                  <p>
                    {message.preview ||
                      "Stored raw message with no preview yet."}
                  </p>
                </button>
              ))}
          </div>
        </section>

        <section class="panel panel--detail">
          <div class="panel__header">
            <div>
              <p class="panel__eyebrow">Message detail</p>
              <h2>{selectedMessage?.subject || "Select a message"}</h2>
            </div>
            {selectedMessage
              ? (
                <span
                  class={`pill pill--status pill--${selectedMessage.status}`}
                >
                  {selectedMessage.status}
                </span>
              )
              : null}
          </div>

          {selectedMessage
            ? (
              <div class="stack">
                <div class="detail-grid">
                  <article>
                    <span class="detail-label">from</span>
                    <strong>{selectedMessage.from}</strong>
                  </article>
                  <article>
                    <span class="detail-label">alias</span>
                    <strong>{selectedMessage.aliasAddress}</strong>
                  </article>
                  <article>
                    <span class="detail-label">received</span>
                    <strong>{formatDate(selectedMessage.receivedAt)}</strong>
                  </article>
                  <article>
                    <span class="detail-label">expires</span>
                    <strong>{formatDate(selectedMessage.expiresAt)}</strong>
                  </article>
                </div>

                <div class="stack stack--tight">
                  <label class="field">
                    <span>Status</span>
                    <select
                      onInput={(event) =>
                        setStatusDraft(
                          (event.currentTarget as HTMLSelectElement)
                            .value as MessageStatus,
                        )}
                      value={statusDraft}
                    >
                      <option value="inbox">inbox</option>
                      <option value="forwarded">forwarded</option>
                      <option value="trashed">trashed</option>
                      <option value="blocked">blocked</option>
                    </select>
                  </label>
                  <button
                    class="button button--secondary"
                    onClick={() => void handleStatusSave()}
                    type="button"
                  >
                    Save status
                  </button>
                </div>

                <div class="stack stack--tight">
                  <label class="field">
                    <span>Tags</span>
                    <input
                      onInput={(event) => setTagInput(
                        (event.currentTarget as HTMLInputElement).value,
                      )}
                      placeholder="news, shopping"
                      type="text"
                      value={tagInput}
                    />
                  </label>
                  <div class="button-row">
                    <button
                      class="button button--secondary"
                      onClick={() => void handleTagSave()}
                      type="button"
                    >
                      Save tags
                    </button>
                    <button
                      class="button button--ghost"
                      onClick={() => void handleRawDownload()}
                      type="button"
                    >
                      Download raw
                    </button>
                  </div>
                </div>

                <div class="tag-cloud">
                  {selectedMessage.tags.length === 0
                    ? <span class="pill pill--muted">no tags</span>
                    : selectedMessage.tags.map((tag) => (
                      <span class="pill pill--tag" key={tag}>{tag}</span>
                    ))}
                </div>

                <article class="preview-card">
                  <span class="detail-label">preview</span>
                  <p>
                    {selectedMessage.preview ||
                      "No parsed body preview yet. Download raw MIME for now."}
                  </p>
                </article>
              </div>
            )
            : (
              <article class="empty-state">
                <strong>Nothing selected.</strong>
                <p>
                  Choose a message from the inbox column to inspect, retag, or
                  reclassify it.
                </p>
              </article>
            )}
        </section>

        <section class="panel panel--rules">
          <div class="panel__header">
            <div>
              <p class="panel__eyebrow">Rule engine</p>
              <h2>Filters</h2>
            </div>
            <span class="panel__badge">
              {bootstrap?.tags.length ?? 0} known tags
            </span>
          </div>

          <form class="stack" onSubmit={handleCreateRule}>
            <div class="form-row">
              <label class="field">
                <span>Alias scope</span>
                <select
                  onInput={(event) => setRuleForm((current) => ({
                    ...current,
                    aliasId: (event.currentTarget as HTMLSelectElement).value ||
                      null,
                  }))}
                  value={ruleForm.aliasId ?? ""}
                >
                  <option value="">global</option>
                  {bootstrap?.aliases.map((alias) => (
                    <option key={alias.id} value={alias.id}>
                      {alias.address}
                    </option>
                  ))}
                </select>
              </label>
              <label class="field">
                <span>Field</span>
                <select
                  onInput={(event) =>
                    setRuleForm((current) => ({
                      ...current,
                      field: (event.currentTarget as HTMLSelectElement)
                        .value as RuleField,
                    }))}
                  value={ruleForm.field}
                >
                  <option value="from">from</option>
                  <option value="subject">subject</option>
                  <option value="alias">alias</option>
                </select>
              </label>
            </div>
            <div class="form-row">
              <label class="field">
                <span>Pattern</span>
                <input
                  onInput={(event) => setRuleForm((current) => ({
                    ...current,
                    pattern: (event.currentTarget as HTMLInputElement).value,
                  }))}
                  placeholder="promo@shop.com"
                  type="text"
                  value={ruleForm.pattern}
                />
              </label>
              <label class="field">
                <span>Action</span>
                <select
                  onInput={(event) =>
                    setRuleForm((current) => ({
                      ...current,
                      action: (event.currentTarget as HTMLSelectElement)
                        .value as RuleAction,
                    }))}
                  value={ruleForm.action}
                >
                  <option value="keep">keep</option>
                  <option value="forward">forward</option>
                  <option value="trash">trash</option>
                  <option value="block">block</option>
                </select>
              </label>
            </div>
            <button
              class="button button--primary"
              disabled={submitting}
              type="submit"
            >
              Add rule
            </button>
          </form>

          <div class="list">
            {bootstrap?.rules.map((rule) => (
              <article class="card" key={rule.id}>
                <div class="card__header">
                  <div>
                    <strong>{rule.pattern}</strong>
                    <p>
                      {rule.aliasId ? "alias rule" : "global rule"} ·{" "}
                      {rule.field} → {rule.action}
                    </p>
                  </div>
                  <span
                    class={`pill ${
                      rule.enabled ? "pill--good" : "pill--muted"
                    }`}
                  >
                    {rule.enabled ? "enabled" : "disabled"}
                  </span>
                </div>
                <button
                  class="button button--ghost"
                  onClick={() => void handleRuleToggle(rule.id, rule.enabled)}
                  type="button"
                >
                  {rule.enabled ? "Disable" : "Enable"}
                </button>
              </article>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}
