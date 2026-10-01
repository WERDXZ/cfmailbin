import {
  type DisplayMessage,
  formatMessage,
  localizedMessage,
} from "./messages.ts";
import { useEffect, useState } from "preact/hooks";
import type { RuntimeSettings, SettingsResponse } from "../settings.ts";
import { maxAiTimeoutSeconds } from "../domain/analysis.ts";
import { isAccountLocale, isLocale, locales } from "../domain/locale.ts";
import { useI18n } from "./i18n.tsx";
import { api } from "./api.ts";
import type { RunAction } from "./common.tsx";
import { DeliverySettings } from "./DeliverySettings.tsx";
import { Settings } from "./Settings.tsx";
import { GraphEditor } from "./GraphEditor.tsx";
import { NodeLibrary } from "./NodeLibrary.tsx";
import { PolicyLibrary } from "./PolicyLibrary.tsx";
import { useUnsavedChanges } from "./useUnsavedChanges.ts";
import type {
  Alias,
  BootstrapResponse,
  DeliveryStatus,
  SessionResponse,
} from "./types.ts";

const tabs = {
  receiving: "settings.receiving",
  graph: "graph.receivingWorkflow",
  rules: "policies.rulesPolicy",
  nodes: "nodes.nodeLibrary",
  ai: "graph.kind.ai",
  account: "settings.account",
} as const;
type Tab = keyof typeof tabs;

export function SettingsPage(
  { bootstrap, session, delivery, run, refresh, onCreated, navigate, path }: {
    bootstrap: BootstrapResponse;
    session: SessionResponse;
    delivery?: DeliveryStatus;
    run: RunAction;
    refresh: () => Promise<void>;
    onCreated: (alias: Alias) => void;
    navigate: (path: string) => void;
    path: string;
  },
) {
  const { t, browserLocale, setBrowserLocale, setAccountLocale } = useI18n();
  const tab = (path.split("/")[2] || "receiving") as Tab;
  const current = String(tab) === "policies"
    ? "rules"
    : tab in tabs
    ? tab
    : "receiving";
  const [saved, setSaved] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<RuntimeSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DisplayMessage>("");
  const [notice, setNotice] = useState<DisplayMessage>("");
  const [attempt, setAttempt] = useState(0);
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(saved?.settings ?? null);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    api.getSettings(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setSaved(result);
      setDraft(result.settings);
      setAccountLocale(result.settings.locale);
    }).catch((caught) => {
      if (!controller.signal.aborted) {
        setError(
          caught instanceof Error
            ? caught
            : localizedMessage("errors.unableToLoadSettings"),
        );
      }
    });
    return () => controller.abort();
  }, [attempt]);
  useUnsavedChanges(
    dirty,
    t("settings.settingsHaveUnsavedChangesDiscardThemAnd"),
    () => {
      setDraft(saved?.settings ?? null);
    },
  );
  function change<K extends keyof RuntimeSettings>(
    key: K,
    value: RuntimeSettings[K],
  ) {
    setDraft((old) => old ? { ...old, [key]: value } : old);
    setNotice("");
  }
  async function save(event: Event) {
    event.preventDefault();
    if (!draft) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api.saveSettings(draft);
      setSaved(result);
      setDraft(result.settings);
      setAccountLocale(result.settings.locale);
      setNotice(
        result.storage === "kv"
          ? localizedMessage("settings.savedReceivingSettingsMayTakeAboutA")
          : localizedMessage("settings.savedResetsWhenTheLocalServerRestarts"),
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught
          : localizedMessage("settings.saveFailedPleaseTryAgain"),
      );
    } finally {
      setBusy(false);
    }
  }
  function leave() {
    navigate("/");
  }
  return (
    <section
      class={`settings-page ${
        current === "graph" || current === "nodes" || current === "rules"
          ? "settings-page--graph"
          : ""
      }`}
    >
      <header class="inbox-heading">
        <h1>{t("settings.title")}</h1>
        <button
          type="button"
          class="text-button text-button--quiet"
          onClick={leave}
        >
          {t("settings.backToInbox")}
        </button>
      </header>
      <nav class="settings-tabs" aria-label={t("settings.settingsSections")}>
        {Object.entries(tabs).map(([key, label]) => (
          <a
            href={`/settings/${key}`}
            aria-current={current === key ? "page" : undefined}
            onClick={(event) => {
              if (
                event.button || event.metaKey || event.ctrlKey ||
                event.shiftKey || event.altKey
              ) return;
              event.preventDefault();
              navigate(`/settings/${key}`);
            }}
          >
            {t(label)}
          </a>
        ))}
      </nav>
      {error && (
        <div class="notice notice--error" role="alert">
          {formatMessage(error, t)}
          {!draft && (
            <button
              type="button"
              class="text-button"
              onClick={() => setAttempt(attempt + 1)}
            >
              {t("common.retry")}
            </button>
          )}
        </div>
      )}
      {notice && <p class="notice" role="status">{formatMessage(notice, t)}</p>}
      {current === "account" && (
        <section
          class="preferences-form language-settings"
          aria-labelledby="language-heading"
        >
          <header class="settings-section-heading">
            <h2 id="language-heading">{t("settings.language")}</h2>
            <p class="muted">{t("settings.languageHint")}</p>
          </header>
          <label>
            {t("settings.browserLanguage")}
            <select
              value={browserLocale ?? ""}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setBrowserLocale(isLocale(value) ? value : null);
              }}
            >
              <option value="">{t("settings.useAccountDefault")}</option>
              {Object.entries(locales).map(([value, label]) => (
                <option value={value}>{label}</option>
              ))}
            </select>
            <span class="muted">
              {t("settings.browserLanguageHint")}
            </span>
          </label>
          {draft && (
            <form onSubmit={save}>
              <fieldset disabled={busy || saved?.storage === "unavailable"}>
                <label>
                  {t("settings.accountLanguage")}
                  <select
                    value={draft.locale}
                    onChange={(event) => {
                      if (isAccountLocale(event.currentTarget.value)) {
                        change("locale", event.currentTarget.value);
                      }
                    }}
                  >
                    <option value="auto">
                      {t("settings.useBrowserLanguage")}
                    </option>
                    {Object.entries(locales).map(([value, label]) => (
                      <option value={value}>{label}</option>
                    ))}
                  </select>
                </label>
                <div class="settings-save">
                  <button
                    type="submit"
                    class="button button--primary"
                    disabled={!dirty || busy}
                  >
                    {t(busy ? "common.saving" : "settings.saveSettings")}
                  </button>
                  {dirty && (
                    <span class="muted">{t("graph.unsavedChanges")}</span>
                  )}
                </div>
              </fieldset>
              {saved?.storage === "unavailable" && (
                <p class="inline-error">
                  {t("settings.settingsStorageIsNotConnectedSavingIs")}
                </p>
              )}
            </form>
          )}
        </section>
      )}
      {(current === "receiving" || current === "ai") && (draft
        ? (
          <form class="preferences-form" onSubmit={save}>
            <fieldset disabled={busy || saved?.storage === "unavailable"}>
              {current === "receiving"
                ? (
                  <>
                    <div class="settings-section-heading">
                      <h2>{t("settings.receivingPreferences")}</h2>
                      <p class="muted">
                        {t(
                          "settings.configureAddressRegistrationAndRetentionAcceptanceIs",
                        )}
                      </p>
                    </div>
                    <label>
                      {t("settings.receivingDomain")}
                      <input
                        value={draft.emailDomain}
                        placeholder="example.com"
                        maxLength={190}
                        onInput={(e) =>
                          change("emailDomain", e.currentTarget.value)}
                      />
                      <span class="muted">
                        {t("settings.useADomainConfiguredWithCloudflareEmail")}
                      </span>
                    </label>
                    <label class="toggle-setting">
                      <input
                        type="checkbox"
                        checked={draft.allowCatchAll}
                        onChange={(e) =>
                          change("allowCatchAll", e.currentTarget.checked)}
                      />
                      <span>
                        {t("settings.acceptUnregisteredAddresses")}
                        <span class="muted">
                          {t(
                            "settings.rememberTheAddressWhenTheWorkflowAccepts",
                          )}
                        </span>
                      </span>
                    </label>
                    <div class="form-pair">
                      <label>
                        {t("settings.defaultRetentionDays")}
                        <input
                          type="number"
                          min={1}
                          max={3650}
                          required
                          value={draft.defaultRetentionDays}
                          onInput={(e) =>
                            change(
                              "defaultRetentionDays",
                              Number(e.currentTarget.value),
                            )}
                        />
                      </label>
                      <label>
                        {t("settings.defaultTagForNewAddresses")}
                        <input
                          maxLength={120}
                          value={draft.autoCreateAliasTag}
                          placeholder={t("settings.optional")}
                          onInput={(e) =>
                            change("autoCreateAliasTag", e.currentTarget.value)}
                        />
                      </label>
                    </div>
                  </>
                )
                : (
                  <>
                    <div class="settings-section-heading">
                      <h2>{t("settings.aiSettings")}</h2>
                      <p class="muted">
                        {t(
                          "settings.workflowAiNodesShareThisModelAnd",
                        )}
                      </p>
                    </div>
                    <label class="toggle-setting">
                      <input
                        type="checkbox"
                        checked={draft.aiEnabled}
                        onChange={(e) =>
                          change("aiEnabled", e.currentTarget.checked)}
                      />
                      <span>
                        {t("settings.allowAiCalls")}
                        <span class="muted">
                          {t("settings.nodeInputsAreSentToTheModel")}
                        </span>
                      </span>
                    </label>
                    <label>
                      {t("settings.model")}
                      <select
                        value={draft.aiProvider}
                        onChange={(e) =>
                          change(
                            "aiProvider",
                            e.currentTarget
                              .value as RuntimeSettings["aiProvider"],
                          )}
                      >
                        <option value="deepseek">DeepSeek Flash</option>
                        <option value="openai">GPT-5.6 Luna</option>
                      </select>
                    </label>
                    <label>
                      {t("settings.maximumDailyCalls")}
                      <input
                        type="number"
                        min={0}
                        max={1000}
                        required
                        value={draft.aiDailyLimit}
                        onInput={(e) =>
                          change("aiDailyLimit", Number(e.currentTarget.value))}
                      />
                      <span class="muted">
                        {t("settings.resetsAtMidnightUtcSetTo0")}
                      </span>
                    </label>
                    <label>
                      {t("settings.workflowAiTimeoutSeconds")}
                      <input
                        type="number"
                        min={1}
                        max={maxAiTimeoutSeconds}
                        required
                        value={draft.aiTimeoutSeconds}
                        onInput={(e) =>
                          change(
                            "aiTimeoutSeconds",
                            Number(e.currentTarget.value),
                          )}
                      />
                      <span class="muted">
                        {t(
                          "settings.measuredFromWorkflowStartAndSharedBy",
                        )}
                      </span>
                    </label>
                    <p class="muted">
                      {bootstrap.config.analysis?.configured
                        ? t(
                          "settings.gatewayConfiguredTheSelectedModelRequiresIts",
                        )
                        : t("settings.gatewayNotConfiguredAiNodesCannotRun")}
                    </p>
                  </>
                )}
              <div class="settings-save">
                <button
                  type="submit"
                  class="button button--primary"
                  disabled={!dirty || busy}
                >
                  {busy ? t("common.saving") : t("settings.saveSettings")}
                </button>
                {dirty && (
                  <span class="muted">{t("graph.unsavedChanges")}</span>
                )}
              </div>
            </fieldset>
            {saved?.storage === "unavailable" && (
              <p class="inline-error">
                {t("settings.settingsStorageIsNotConnectedSavingIs")}
              </p>
            )}
          </form>
        )
        : !error && (
          <p role="status" class="loading-panel">
            {t("inbox.loadingSettings")}
          </p>
        ))}
      {current === "receiving" && (
        <>
          <DeliverySettings
            delivery={delivery}
            mode={session.mode}
            error=""
          />
          <Settings
            bootstrap={bootstrap}
            run={run}
            refresh={refresh}
            onCreated={onCreated}
          />
        </>
      )}
      {current === "graph" && <GraphEditor />}
      {current === "rules" && <PolicyLibrary />}
      {current === "nodes" && <NodeLibrary />}
      {current === "account" && (
        <section class="delivery-settings">
          <h2>{t("settings.currentAccount")}</h2>
          <p>{session.email}</p>
          <p class="muted">
            {session.mode === "development"
              ? t("settings.localDevelopmentDataResetsWhenTheServer")
              : t("settings.signedInThroughCloudflareAccess")}
          </p>
          {session.mode === "access" && (
            <a class="button" href="/cdn-cgi/access/logout">
              {t("inbox.signOut")}
            </a>
          )}
        </section>
      )}
    </section>
  );
}
