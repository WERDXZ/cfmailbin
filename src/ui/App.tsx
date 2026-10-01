import {
  type DisplayMessage,
  formatMessage,
  localizedMessage,
} from "./messages.ts";
import { AuditPage } from "./AuditPage.tsx";
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
import { useI18n } from "./i18n.tsx";
import type {
  Alias,
  BootstrapResponse,
  MessageFilters,
  MessageStatus,
  SessionResponse,
} from "./types.ts";

export function App() {
  const { t, locale, setAccountLocale } = useI18n();
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [checking, setChecking] = useState(true);
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [error, setError] = useState<DisplayMessage>("");
  const [notice, setNotice] = useState<DisplayMessage>("");
  const [filters, setFilters] = useState<MessageFilters>({});
  const [search, setSearch] = useState("");
  const [revision, setRevision] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { path, navigate } = usePage();
  const auditOpen = path === "/audit";
  const settingsOpen = path.startsWith("/settings");
  const inboxOpen = !settingsOpen && !auditOpen;
  const setSettingsOpen = (open: boolean) => navigate(open ? "/settings" : "/");

  const onError = useCallback((caught: unknown) => {
    if (caught instanceof ApiError && [401, 403].includes(caught.status)) {
      setSession(null);
      setBootstrap(null);
      setSelectedId(null);
      setError(
        caught.status === 401
          ? localizedMessage("inbox.yourSessionHasExpiredPleaseSignIn")
          : localizedMessage("inbox.thisAccountDoesNotHaveAccessSign"),
      );
    } else {
      setError(
        caught instanceof Error
          ? caught
          : localizedMessage("inbox.requestFailedPleaseTryAgain"),
      );
    }
  }, []);
  const run: RunAction = useCallback(
    async <T,>(action: () => Promise<T>, success?: DisplayMessage) => {
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
    if (bootstrap) setAccountLocale(bootstrap.config.locale);
  }, [bootstrap, setAccountLocale]);

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
    if (!setSettingsOpen(false)) return;
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
          <h1>{t("inbox.signInToYourInbox")}</h1>
          {checking
            ? <p role="status">{t("inbox.checkingYourSession")}</p>
            : (
              <div class="auth-actions">
                <button
                  type="button"
                  class="button button--primary"
                  onClick={() => location.assign("/")}
                >
                  {t("inbox.signInWithCloudflare")}
                </button>
                <button
                  type="button"
                  class="text-button"
                  onClick={() => location.assign("/cdn-cgi/access/logout")}
                >
                  {t("inbox.useAnotherAccount")}
                </button>
              </div>
            )}
          {error && (
            <p class="inline-error" role="alert">{formatMessage(error, t)}</p>
          )}
        </section>
      </main>
    );
  }

  return (
    <div class="app-shell">
      <aside class="sidebar" aria-label={t("inbox.mailboxNavigation")}>
        <a class="app-name" href="/">cfmailbin</a>
        <button
          type="button"
          class={`all-inboxes ${
            !filters.aliasId && inboxOpen ? "is-active" : ""
          }`}
          aria-current={!filters.aliasId && inboxOpen ? "page" : undefined}
          onClick={() => selectAlias()}
        >
          {t("inbox.allMail")}
        </button>
        <div class="sidebar-heading">
          <span>{t("inbox.usedAddresses")}</span>
          <span class="count">{allAliases.length}</span>
        </div>
        <div class="alias-list">
          {aliases.map((item) => (
            <div
              key={item.id}
              class={`alias-item ${
                item.id === filters.aliasId && inboxOpen ? "is-active" : ""
              }`}
            >
              <button
                type="button"
                class="alias-select"
                onClick={() => selectAlias(item)}
                aria-current={item.id === filters.aliasId && inboxOpen
                  ? "page"
                  : undefined}
                title={`${item.address}${
                  item.lastReceivedAt
                    ? t("inbox.lastReceived", {
                      time: formatDate(item.lastReceivedAt, locale),
                    })
                    : t("inbox.noMailReceivedYet")
                }`}
              >
                <span class="alias-label">
                  <strong>{item.description || item.address}</strong>
                  {item.description && <small>{item.address}</small>}
                </span>
                {!item.enabled && (
                  <span class="disabled-label">{t("inbox.disabled")}</span>
                )}
              </button>
              <CopyButton
                value={item.address}
                accessibleLabel={t("inbox.copyAddress", {
                  address: item.address,
                })}
                className="alias-copy"
                iconOnly
              />
            </div>
          ))}
        </div>
        {!aliases.length && (
          <p class="sidebar-empty">
            {search
              ? t("inbox.noMatchingAddresses")
              : t("inbox.addressesAppearHereAfterTheirFirstIncoming")}
          </p>
        )}
        <div class="sidebar-bottom">
          <button
            type="button"
            class={`all-inboxes ${auditOpen ? "is-active" : ""}`}
            aria-current={auditOpen ? "page" : undefined}
            onClick={() => navigate("/audit")}
          >
            {t("inbox.auditLog")}
          </button>
          <button
            type="button"
            class={`all-inboxes ${settingsOpen ? "is-active" : ""}`}
            aria-current={settingsOpen ? "page" : undefined}
            onClick={() => setSettingsOpen(true)}
          >
            {t("settings.title")}
          </button>
          <div class="sidebar-account">
            <span class="owner-email" title={session.email}>
              {session.email}
            </span>
            {session.mode === "development"
              ? <small>{t("inbox.localDevelopmentDataIsTemporary")}</small>
              : <a href="/cdn-cgi/access/logout">{t("inbox.signOut")}</a>}
          </div>
        </div>
      </aside>
      <main class="workspace">
        {error && (
          <div class="notice notice--error" role="alert">
            <span>{formatMessage(error, t)}</span>
            <button
              type="button"
              class="text-button"
              onClick={() => setError("")}
            >
              {t("common.close")}
            </button>
          </div>
        )}
        {notice && (
          <div class="notice" role="status">{formatMessage(notice, t)}</div>
        )}
        {auditOpen ? <AuditPage onError={onError} /> : settingsOpen
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
                  {t("inbox.loadingSettings")}
                  <button
                    type="button"
                    class="button"
                    onClick={() => void run(refreshAll)}
                  >
                    {t("common.retry")}
                  </button>
                </div>
              )
          )
          : (
            <>
              <header class="inbox-heading">
                <div>
                  <h1>
                    {alias?.description || alias?.address || t("inbox.inbox")}
                  </h1>
                  <span class="count">
                    {inbox.items.length}
                    {inbox.items.length === 100 ? "+" : ""}
                  </span>
                </div>
                <div class="inbox-actions">
                  <span class="poll-status">
                    {inbox.error
                      ? t("inbox.automaticRefreshFailed")
                      : !inbox.visible
                      ? t("inbox.paused")
                      : inbox.connection === "live"
                      ? t("inbox.liveUpdates")
                      : inbox.connection === "connecting"
                      ? t("inbox.connecting")
                      : t("inbox.reconnectingCheckingPeriodically")}
                  </span>
                  <button type="button" class="text-button" onClick={refresh}>
                    {t("common.refresh")}
                  </button>
                </div>
              </header>
              <div class="inbox-toolbar">
                <label class="message-search">
                  <span class="sr-only">
                    {t("inbox.searchMailAndAddresses")}
                  </span>
                  <input
                    type="search"
                    placeholder={t("inbox.searchSitesAddressesSendersOrMail")}
                    value={search}
                    onInput={(event) => {
                      setSearch(event.currentTarget.value);
                      setFilters((old) => ({ ...old, aliasId: undefined }));
                      setSelectedId(null);
                    }}
                  />
                </label>
                <label>
                  <span class="sr-only">{t("inbox.mailStatus")}</span>
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
                    <option value="">{t("inbox.allStatuses")}</option>
                    <option value="inbox">{t("inbox.inbox")}</option>
                    <option value="forwarded">{t("inbox.forwarded")}</option>
                    <option value="trashed">{t("inbox.trash")}</option>
                    <option value="blocked">{t("inbox.blocked")}</option>
                  </select>
                </label>
              </div>
              <div class="delivery-status">
                <button
                  type="button"
                  class="text-button"
                  onClick={() => setSettingsOpen(true)}
                >
                  {formatMessage(inbox.error, t) ||
                    deliveryLabel(session.mode, delivery, locale)}
                </button>
                {inbox.checkedAt > 0 && (
                  <span
                    title={new Date(inbox.checkedAt).toLocaleString(locale)}
                  >
                    {t("inbox.lastChecked")}{" "}
                    {new Date(inbox.checkedAt).toLocaleTimeString(locale, {
                      hour12: false,
                    })}
                    {inbox.error ? t("inbox.showingPreviousResults") : ""}
                  </span>
                )}
              </div>
              {alias && (
                <div class="active-address">
                  <div class="address-line">
                    <span>{alias.address}</span>
                    <CopyButton
                      value={alias.address}
                      label={t("inbox.copyAddressButton")}
                      className="text-button"
                    />
                    {!alias.enabled && (
                      <span class="disabled-label">{t("inbox.disabled")}</span>
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
              <ul class="inbox-list" aria-label={t("inbox.mailList")}>
                {inbox.items.map((message) => (
                  <li
                    key={message.id}
                    class={`mail-row ${
                      selectedId === message.id ? "is-selected" : ""
                    }`}
                  >
                    <div class="mail-summary">
                      <button
                        type="button"
                        class="mail-open"
                        aria-label={t("inbox.viewMessage", {
                          subject: message.subject || t("inbox.noSubject"),
                        })}
                        aria-expanded={selectedId === message.id}
                        onClick={() =>
                          setSelectedId(
                            selectedId === message.id ? null : message.id,
                          )}
                      >
                        <span class="mail-subject">
                          {message.subject || t("message.noSubject")}
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
                          title={formatDate(message.receivedAt, locale)}
                        >
                          {relativeDate(message.receivedAt, locale)}
                        </time>
                        <div class="inline-codes">
                          {message.verificationCodes?.map((code) => (
                            <CopyButton
                              key={code}
                              value={code}
                              label={code}
                              accessibleLabel={t("inbox.copyCode", {
                                code: code,
                              })}
                              className="code-copy"
                            />
                          ))}
                        </div>
                        <AnalysisBadge message={message} />
                        {message.status !== "inbox" && (
                          <small class="status-badge">
                            {({
                              forwarded: t("inbox.forwarded"),
                              trashed: t("inbox.trash"),
                              blocked: t("inbox.blocked"),
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
                  </li>
                ))}
              </ul>
              {!inbox.items.length && (
                <div class="empty-state">
                  <strong>
                    {inbox.error
                      ? t("errors.unableToCheckMail")
                      : inbox.loading
                      ? t("inbox.checkingMail")
                      : filters.q || filters.status
                      ? t("inbox.noMatchingMail")
                      : t("inbox.noMailYet")}
                  </strong>
                  <p>
                    {inbox.error
                      ? t(
                        "inbox.checkingResumesAutomaticallyWhenTheConnectionRecovers",
                      )
                      : filters.q || filters.status
                      ? t("inbox.tryAnotherKeywordOrCopyAUsed")
                      : session.mode === "development"
                      ? t("inbox.localDevelopmentDoesNotReceiveCloudflareEmail")
                      : delivery?.lastReceived
                      ? t("inbox.thisPageChecksForNewMailAutomatically")
                      : t("inbox.checkYourReceivingSetupInSettingsBefore")}
                  </p>
                  {!inbox.error && !inbox.loading && !filters.q &&
                    !delivery?.lastReceived && (
                    <button
                      type="button"
                      class="text-button"
                      onClick={() => setSettingsOpen(true)}
                    >
                      {t("inbox.viewReceivingSettings")}
                    </button>
                  )}
                </div>
              )}
            </>
          )}
      </main>
    </div>
  );
}
