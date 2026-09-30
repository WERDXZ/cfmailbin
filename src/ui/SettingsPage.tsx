import { useEffect, useState } from "preact/hooks";
import type { RuntimeSettings, SettingsResponse } from "../settings.ts";
import { api } from "./api.ts";
import type { RunAction } from "./common.tsx";
import { DeliverySettings } from "./DeliverySettings.tsx";
import { RulesManager } from "./RulesManager.tsx";
import { Settings } from "./Settings.tsx";
import type {
  Alias,
  BootstrapResponse,
  DeliveryStatus,
  SessionResponse,
} from "./types.ts";

const tabs = {
  receiving: "收件",
  ai: "验证码识别",
  rules: "规则",
  account: "账号",
};
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
  const tab = (path.split("/")[2] || "receiving") as Tab;
  const current = tab in tabs ? tab : "receiving";
  const [saved, setSaved] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<RuntimeSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
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
    }).catch((caught) => {
      if (!controller.signal.aborted) {
        setError(caught instanceof Error ? caught.message : "读取设置失败");
      }
    });
    return () => controller.abort();
  }, [attempt]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [dirty]);
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
      setNotice(
        result.storage === "kv"
          ? "已保存。收件设置可能需要约一分钟生效。"
          : "已保存，本地服务重启后重置。",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存失败，请重试");
    } finally {
      setBusy(false);
    }
  }
  function leave() {
    if (dirty && !confirm("设置尚未保存，放弃修改并返回收件箱？")) return;
    navigate("/");
  }
  return (
    <section class="settings-page">
      <header class="inbox-heading">
        <h1>设置</h1>
        <button type="button" class="text-button" onClick={leave}>
          返回收件箱
        </button>
      </header>
      <nav class="settings-tabs" aria-label="设置分类">
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
            {label}
          </a>
        ))}
      </nav>
      {error && (
        <div class="notice notice--error" role="alert">
          {error}
          {!draft && (
            <button
              type="button"
              class="text-button"
              onClick={() => setAttempt(attempt + 1)}
            >
              重试
            </button>
          )}
        </div>
      )}
      {notice && <p class="notice" role="status">{notice}</p>}
      {(current === "receiving" || current === "ai") && (draft
        ? (
          <form class="preferences-form" onSubmit={save}>
            <fieldset disabled={busy || saved?.storage === "unavailable"}>
              {current === "receiving"
                ? (
                  <>
                    <div class="settings-section-heading">
                      <h2>收件偏好</h2>
                      <p class="muted">调整收件方式和新地址的默认值。</p>
                    </div>
                    <label>
                      收件域名<input
                        value={draft.emailDomain}
                        placeholder="example.com"
                        maxLength={190}
                        onInput={(e) =>
                          change("emailDomain", e.currentTarget.value)}
                      />
                      <span class="muted">
                        使用已接入 Cloudflare Email Routing 的域名。
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
                        接收未登记地址<span class="muted">
                          第一次收到邮件时自动记住地址。
                        </span>
                      </span>
                    </label>
                    <div class="form-pair">
                      <label>
                        默认保留天数<input
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
                        新地址默认标签<input
                          maxLength={120}
                          value={draft.autoCreateAliasTag}
                          placeholder="可留空"
                          onInput={(e) =>
                            change("autoCreateAliasTag", e.currentTarget.value)}
                        />
                      </label>
                    </div>
                    <label>
                      默认转发到<input
                        type="email"
                        maxLength={254}
                        value={draft.defaultForwardTo}
                        placeholder="留空只在这里收件"
                        onInput={(e) =>
                          change("defaultForwardTo", e.currentTarget.value)}
                      />
                      <span class="muted">
                        转发目标需要先在 Cloudflare 验证。
                      </span>
                    </label>
                  </>
                )
                : (
                  <>
                    <div class="settings-section-heading">
                      <h2>验证码识别</h2>
                      <p class="muted">
                        先自动提取验证码，没找到时再由 AI 补充识别。
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
                        启用 AI 补充识别<span class="muted">
                          主题和部分正文会发给模型服务商，按调用计费。
                        </span>
                      </span>
                    </label>
                    <label>
                      模型<select
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
                      每天最多调用次数<input
                        type="number"
                        min={0}
                        max={1000}
                        required
                        value={draft.aiDailyLimit}
                        onInput={(e) =>
                          change("aiDailyLimit", Number(e.currentTarget.value))}
                      />
                      <span class="muted">UTC 零点重置；设为 0 暂停调用。</span>
                    </label>
                    <p class="muted">
                      {bootstrap.config.analysis?.configured
                        ? "网关已配置；所选模型需要对应的服务商密钥。"
                        : "网关尚未配置，当前使用本地识别。"}
                    </p>
                  </>
                )}
              <div class="settings-save">
                <button
                  type="submit"
                  class="button button--primary"
                  disabled={!dirty || busy}
                >
                  {busy ? "保存中…" : "保存设置"}
                </button>
                {dirty && <span class="muted">有未保存的修改</span>}
              </div>
            </fieldset>
            {saved?.storage === "unavailable" && (
              <p class="inline-error">设置存储尚未接入，暂时无法保存。</p>
            )}
          </form>
        )
        : !error && <p role="status" class="loading-panel">正在读取设置…</p>)}
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
      {current === "rules" && (
        <RulesManager bootstrap={bootstrap} run={run} refresh={refresh} />
      )}
      {current === "account" && (
        <section class="delivery-settings">
          <h2>当前账号</h2>
          <p>{session.email}</p>
          <p class="muted">
            {session.mode === "development"
              ? "本地开发，数据在服务重启后重置。"
              : "通过 Cloudflare Access 登录。"}
          </p>
          {session.mode === "access" && (
            <a class="button" href="/cdn-cgi/access/logout">退出登录</a>
          )}
        </section>
      )}
    </section>
  );
}
