import { useCallback, useEffect, useState } from "preact/hooks";
import { api, ApiError } from "./api.ts";
import {
  CopyButton,
  formatDate,
  relativeDate,
  type RunAction,
} from "./common.tsx";
import { MessageDetail } from "./MessageDetail.tsx";
import { AnalysisBadge } from "./AnalysisStatus.tsx";
import { SettingsPage } from "./SettingsPage.tsx";
import { usePage } from "./usePage.ts";
import { AliasSettings } from "./Settings.tsx";
import { deliveryLabel } from "./DeliverySettings.tsx";
import { useInbox } from "./useInbox.ts";
import type {
  Alias,
  BootstrapResponse,
  MessageFilters,
  MessageStatus,
  SessionResponse,
} from "./types.ts";

export function App() {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [checking, setChecking] = useState(true);
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [filters, setFilters] = useState<MessageFilters>({});
  const [search, setSearch] = useState("");
  const [revision, setRevision] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { path, navigate } = usePage();
  const settingsOpen = path.startsWith("/settings");
  const setSettingsOpen = (open: boolean) => navigate(open ? "/settings" : "/");

  const onError = useCallback((caught: unknown) => {
    if (caught instanceof ApiError && [401, 403].includes(caught.status)) {
      setSession(null);
      setBootstrap(null);
      setSelectedId(null);
      setError(
        caught.status === 401
          ? "登录已过期，请重新登录。"
          : "此账号无权访问，请使用配置的所有者账号登录。",
      );
    } else {
      setError(caught instanceof Error ? caught.message : "请求失败，请重试。");
    }
  }, []);
  const run: RunAction = useCallback(
    async <T,>(action: () => Promise<T>, success?: string) => {
      setError("");
      try {
        const result = await action();
        if (success) setNotice(success);
        return result;
      } catch (caught) {
        onError(caught);
      }
    },
    [onError],
  );
  const inbox = useInbox(filters, !!session, revision, onError);
  const allAliases = inbox.data?.aliases ?? bootstrap?.aliases ?? [];
  const aliases = allAliases.filter((item) =>
    `${item.address} ${item.description ?? ""}`.toLowerCase().includes(
      search.trim().toLowerCase(),
    )
  );
  const alias = allAliases.find((item) => item.id === filters.aliasId);
  const selected = inbox.items.find((item) => item.id === selectedId);
  const delivery = inbox.data?.delivery;

  useEffect(() => {
    let disposed = false;
    try {
      sessionStorage.removeItem("cfmailbin.token");
    } catch { /* Optional storage. */ }
    api.validateSession().then((next) => {
      if (!disposed) setSession(next);
    })
      .catch((caught) => {
        if (!disposed) onError(caught);
      })
      .finally(() => {
        if (!disposed) setChecking(false);
      });
    return () => {
      disposed = true;
    };
  }, [onError]);
  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    api.getBootstrap(controller.signal).then((next) => {
      if (!controller.signal.aborted) setBootstrap(next);
    }).catch((caught) => {
      if (!controller.signal.aborted) onError(caught);
    });
    return () => controller.abort();
  }, [session, onError]);
  useEffect(() => {
    const timer = setTimeout(
      () => setFilters((old) => ({ ...old, q: search.trim() || undefined })),
      250,
    );
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  function selectAlias(next?: Alias) {
    setSettingsOpen(false);
    setFilters({ aliasId: next?.id });
    setSelectedId(null);
    setSearch("");
  }
  function refresh() {
    setRevision((value) => value + 1);
  }
  async function refreshAll() {
    const next = await api.getBootstrap();
    setBootstrap(next);
    refresh();
  }

  if (checking || !session) {
    return (
      <main class="auth-page">
        <section class="auth-panel" aria-busy={checking}>
          <h1>登录收件箱</h1>
          {checking
            ? <p role="status">正在检查登录状态…</p>
            : (
              <div class="auth-actions">
                <button
                  type="button"
                  class="button button--primary"
                  onClick={() => location.assign("/")}
                >
                  使用 Cloudflare 登录
                </button>
                <button
                  type="button"
                  class="text-button"
                  onClick={() => location.assign("/cdn-cgi/access/logout")}
                >
                  换一个账号
                </button>
              </div>
            )}
          {error && <p class="inline-error" role="alert">{error}</p>}
        </section>
      </main>
    );
  }

  return (
    <div class="app-shell">
      <aside class="sidebar" aria-label="邮箱导航">
        <a class="app-name" href="/">cfmailbin</a>
        <button
          type="button"
          class={`all-inboxes ${
            !filters.aliasId && !settingsOpen ? "is-active" : ""
          }`}
          aria-current={!filters.aliasId && !settingsOpen ? "page" : undefined}
          onClick={() => selectAlias()}
        >
          所有邮件
        </button>
        <div class="sidebar-heading">
          <span>用过的地址</span>
          <span class="count">{allAliases.length}</span>
        </div>
        <div class="alias-list">
          {aliases.map((item) => (
            <div
              key={item.id}
              class={`alias-item ${
                item.id === filters.aliasId && !settingsOpen ? "is-active" : ""
              }`}
            >
              <button
                type="button"
                class="alias-select"
                onClick={() => selectAlias(item)}
                aria-current={item.id === filters.aliasId && !settingsOpen
                  ? "page"
                  : undefined}
                title={`${item.address}${
                  item.lastReceivedAt
                    ? ` · 最近收件 ${formatDate(item.lastReceivedAt)}`
                    : " · 尚未收件"
                }`}
              >
                <span class="alias-label">
                  <strong>{item.description || item.address}</strong>
                  {item.description && <small>{item.address}</small>}
                </span>
                {!item.enabled && <span class="disabled-label">已停用</span>}
              </button>
              <CopyButton
                value={item.address}
                accessibleLabel={`复制地址 ${item.address}`}
                className="alias-copy"
                iconOnly
              />
            </div>
          ))}
        </div>
        {!aliases.length && (
          <p class="sidebar-empty">
            {search ? "没有匹配的地址" : "首次收件后，地址会留在这里。"}
          </p>
        )}
        <div class="sidebar-bottom">
          <button
            type="button"
            class={`all-inboxes ${settingsOpen ? "is-active" : ""}`}
            aria-current={settingsOpen ? "page" : undefined}
            onClick={() => setSettingsOpen(true)}
          >
            设置
          </button>
          <div class="sidebar-account">
            <span class="owner-email" title={session.email}>
              {session.email}
            </span>
            {session.mode === "development"
              ? <small>本地开发 · 数据不持久保存</small>
              : <a href="/cdn-cgi/access/logout">退出登录</a>}
          </div>
        </div>
      </aside>
      <main class="workspace">
        {error && (
          <div class="notice notice--error" role="alert">
            <span>{error}</span>
            <button
              type="button"
              class="text-button"
              onClick={() => setError("")}
            >
              关闭
            </button>
          </div>
        )}
        {notice && <div class="notice" role="status">{notice}</div>}
        {settingsOpen
          ? (
            bootstrap
              ? (
                <SettingsPage
                  bootstrap={{ ...bootstrap, aliases: allAliases }}
                  session={session}
                  delivery={delivery}
                  run={run}
                  refresh={refreshAll}
                  onCreated={selectAlias}
                  navigate={navigate}
                  path={path}
                />
              )
              : (
                <div class="loading-panel">
                  正在读取设置…<button
                    type="button"
                    class="button"
                    onClick={() => void run(refreshAll)}
                  >
                    重试
                  </button>
                </div>
              )
          )
          : (
            <>
              <header class="inbox-heading">
                <div>
                  <h1>{alias?.description || alias?.address || "收件箱"}</h1>
                  <span class="count">
                    {inbox.items.length}
                    {inbox.items.length === 100 ? "+" : ""}
                  </span>
                </div>
                <div class="inbox-actions">
                  <span class="poll-status">
                    {inbox.error
                      ? "自动刷新失败"
                      : !inbox.visible
                      ? "已暂停"
                      : inbox.connection === "live"
                      ? "实时更新中"
                      : inbox.connection === "connecting"
                      ? "正在连接"
                      : "正在重连 · 定时检查"}
                  </span>
                  <button type="button" class="text-button" onClick={refresh}>
                    刷新
                  </button>
                </div>
              </header>
              <div class="inbox-toolbar">
                <label class="message-search">
                  <span class="sr-only">搜索邮件和地址</span>
                  <input
                    type="search"
                    placeholder="搜索网站、地址、发件人或邮件"
                    value={search}
                    onInput={(event) => {
                      setSearch(event.currentTarget.value);
                      setFilters((old) => ({ ...old, aliasId: undefined }));
                      setSelectedId(null);
                    }}
                  />
                </label>
                <label>
                  <span class="sr-only">邮件状态</span>
                  <select
                    value={filters.status ?? ""}
                    onChange={(event) => {
                      setFilters({
                        ...filters,
                        status: event.currentTarget.value as MessageStatus ||
                          undefined,
                      });
                      setSelectedId(null);
                    }}
                  >
                    <option value="">全部状态</option>
                    <option value="inbox">收件箱</option>
                    <option value="forwarded">已转发</option>
                    <option value="trashed">垃圾箱</option>
                    <option value="blocked">已拦截</option>
                  </select>
                </label>
              </div>
              <div class="delivery-status">
                <button
                  type="button"
                  class="text-button"
                  onClick={() => setSettingsOpen(true)}
                >
                  {inbox.error || deliveryLabel(session.mode, delivery)}
                </button>
                {inbox.checkedAt > 0 && (
                  <span
                    title={new Date(inbox.checkedAt).toLocaleString("zh-CN")}
                  >
                    上次检查{" "}
                    {new Date(inbox.checkedAt).toLocaleTimeString("zh-CN", {
                      hour12: false,
                    })}
                    {inbox.error ? " · 显示上次结果" : ""}
                  </span>
                )}
              </div>
              {alias && (
                <div class="active-address">
                  <div class="address-line">
                    <span>{alias.address}</span>
                    <CopyButton
                      value={alias.address}
                      label="复制地址"
                      className="text-button"
                    />
                    {!alias.enabled && (
                      <span class="disabled-label">已停用</span>
                    )}
                  </div>
                  <AliasSettings
                    key={`${alias.id}:${alias.updatedAt}`}
                    alias={alias}
                    run={run}
                    refresh={refreshAll}
                  />
                </div>
              )}
              <section class="inbox-list" aria-label="邮件列表">
                {inbox.items.map((message) => (
                  <article
                    key={message.id}
                    class={`mail-row ${
                      selectedId === message.id ? "is-selected" : ""
                    }`}
                  >
                    <div class="mail-summary">
                      <button
                        type="button"
                        class="mail-open"
                        aria-label={`查看邮件 ${message.subject || "无主题"}`}
                        aria-expanded={selectedId === message.id}
                        onClick={() =>
                          setSelectedId(
                            selectedId === message.id ? null : message.id,
                          )}
                      >
                        <span class="mail-subject">
                          {message.subject || "（无主题）"}
                        </span>
                        <span class="mail-addresses">
                          <span>{message.from}</span>
                          {!alias && <span>→ {message.aliasAddress}</span>}
                        </span>
                        {selectedId !== message.id &&
                          !message.verificationCodes?.length &&
                          message.preview && (
                          <span class="mail-preview">{message.preview}</span>
                        )}
                      </button>
                      <div class="mail-actions">
                        <time
                          dateTime={message.receivedAt}
                          title={formatDate(message.receivedAt)}
                        >
                          {relativeDate(message.receivedAt)}
                        </time>
                        <div class="inline-codes">
                          {message.verificationCodes?.map((code) => (
                            <CopyButton
                              key={code}
                              value={code}
                              label={code}
                              accessibleLabel={`复制验证码 ${code}`}
                              className="code-copy"
                            />
                          ))}
                        </div>
                        <AnalysisBadge message={message} />
                        {message.status !== "inbox" && (
                          <small class="status-badge">
                            {({
                              forwarded: "已转发",
                              trashed: "垃圾箱",
                              blocked: "已拦截",
                            } as const)[message.status]}
                          </small>
                        )}
                      </div>
                    </div>
                    {selected?.id === message.id && (
                      <div class="expanded-message">
                        <MessageDetail
                          key={message.id}
                          message={message}
                          run={run}
                          refresh={refresh}
                          onError={onError}
                          onClose={() => setSelectedId(null)}
                        />
                      </div>
                    )}
                  </article>
                ))}
                {!inbox.items.length && (
                  <div class="empty-state">
                    <strong>
                      {inbox.error
                        ? "暂时无法检查邮件"
                        : inbox.loading
                        ? "正在检查邮件…"
                        : filters.q || filters.status
                        ? "没有匹配的邮件"
                        : "暂无邮件"}
                    </strong>
                    <p>
                      {inbox.error
                        ? "恢复连接后会自动重试。"
                        : filters.q || filters.status
                        ? "可以换个关键词，或从左侧复制用过的地址。"
                        : session.mode === "development"
                        ? "本地开发不接收 Cloudflare 邮件。"
                        : delivery?.lastReceived
                        ? "页面会自动检查新邮件。"
                        : "首次使用请在设置中确认收件接入。"}
                    </p>
                    {!inbox.error && !inbox.loading && !filters.q &&
                      !delivery?.lastReceived && (
                      <button
                        type="button"
                        class="text-button"
                        onClick={() => setSettingsOpen(true)}
                      >
                        查看收件设置
                      </button>
                    )}
                  </div>
                )}
              </section>
            </>
          )}
      </main>
    </div>
  );
}
