import { useState } from "preact/hooks";
import { api } from "./api.ts";
import type { RunAction } from "./common.tsx";
import type {
  Alias,
  BootstrapResponse,
  CreateAliasInput,
  RuleAction,
} from "./types.ts";

export function AliasSettings(
  { alias, run, refresh }: {
    alias: Alias;
    run: RunAction;
    refresh: () => Promise<void>;
  },
) {
  const [description, setDescription] = useState(alias.description ?? "");
  const [days, setDays] = useState(alias.retentionDays);
  const [busy, setBusy] = useState(false);
  async function save(event: Event) {
    event.preventDefault();
    setBusy(true);
    await run(async () => {
      await api.patchAlias(alias.id, { description, retentionDays: days });
      await refresh();
    }, "邮箱设置已保存，新邮件使用新的保留天数");
    setBusy(false);
  }
  async function toggle() {
    setBusy(true);
    await run(async () => {
      await api.patchAlias(alias.id, { enabled: !alias.enabled });
      await refresh();
    }, alias.enabled ? "已停用此邮箱，新邮件将被拒收" : "已恢复收件");
    setBusy(false);
  }
  return (
    <details class="alias-settings">
      <summary>邮箱设置</summary>
      <form class="settings-form" onSubmit={save}>
        <label>
          网站 / 用途<input
            maxLength={120}
            value={description}
            onInput={(event) => setDescription(event.currentTarget.value)}
          />
        </label>
        <label>
          新邮件保留天数<input
            type="number"
            min="1"
            required
            value={days}
            onInput={(event) => setDays(Number(event.currentTarget.value))}
          />
        </label>
        <p class="muted">
          邮件到期清理，邮箱地址长期保留。停用后，此网站的验证码和找回邮件也会被拒收。
        </p>
        <div class="button-row">
          <button type="submit" class="button" disabled={busy}>保存设置</button>
          <button
            type="button"
            class="text-button"
            disabled={busy}
            onClick={toggle}
          >
            {alias.enabled ? "停用收件" : "恢复收件"}
          </button>
        </div>
      </form>
    </details>
  );
}

export function Settings(
  { bootstrap, run, refresh, onCreated }: {
    bootstrap: BootstrapResponse;
    run: RunAction;
    refresh: () => Promise<void>;
    onCreated: (alias: Alias) => void;
  },
) {
  const [alias, setAlias] = useState<CreateAliasInput>({
    address: "",
    description: "",
    retentionDays: bootstrap.config.defaultRetentionDays,
    defaultAction: bootstrap.config.forwardingConfigured ? "forward" : "keep",
  });
  const [busy, setBusy] = useState(false);
  const [tags, setTags] = useState("");
  async function createAlias(event: Event) {
    event.preventDefault();
    setBusy(true);
    await run(async () => {
      const created = await api.createAlias({
        ...alias,
        tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
      });
      await refresh();
      onCreated(created);
      setAlias({ ...alias, address: "", description: "" });
      setTags("");
    }, "自定义邮箱已创建");
    setBusy(false);
  }
  return (
    <details class="advanced-settings">
      <summary>
        手动登记地址
      </summary>
      <p class="muted">
        {bootstrap.config.allowCatchAll
          ? "未知地址首次收件时自动创建。"
          : "仅接收已创建地址的邮件。"}
      </p>
      <div class="custom-alias-form">
        <section>
          <h3>自定义邮箱</h3>
          <form class="settings-form" onSubmit={createAlias}>
            <label>
              完整邮箱地址<input
                type="email"
                required
                placeholder="my-account@mail.example.com"
                value={alias.address}
                onInput={(event) =>
                  setAlias({ ...alias, address: event.currentTarget.value })}
              />
            </label>
            <label>
              网站 / 用途<input
                value={alias.description}
                onInput={(event) =>
                  setAlias({
                    ...alias,
                    description: event.currentTarget.value,
                  })}
              />
            </label>
            <div class="form-pair">
              <label>
                默认处理<select
                  value={alias.defaultAction}
                  onChange={(event) =>
                    setAlias({
                      ...alias,
                      defaultAction: event.currentTarget.value as RuleAction,
                    })}
                >
                  <option value="keep">保留</option>
                  <option value="forward">转发</option>
                  <option value="trash">放入垃圾箱</option>
                  <option value="block">拒收</option>
                </select>
              </label>
              <label>
                保留天数<input
                  type="number"
                  min="1"
                  required
                  value={alias.retentionDays}
                  onInput={(event) =>
                    setAlias({
                      ...alias,
                      retentionDays: Number(event.currentTarget.value),
                    })}
                />
              </label>
            </div>
            {alias.defaultAction === "forward" && (
              <label>
                转发到<input
                  type="email"
                  required={!bootstrap.config.forwardingConfigured}
                  placeholder="留空使用默认转发地址"
                  value={alias.forwardTo ?? ""}
                  onInput={(event) =>
                    setAlias({
                      ...alias,
                      forwardTo: event.currentTarget.value,
                    })}
                />
              </label>
            )}
            <label>
              标签（逗号分隔）<input
                value={tags}
                onInput={(event) => setTags(event.currentTarget.value)}
              />
            </label>
            <button type="submit" class="button" disabled={busy}>
              创建自定义邮箱
            </button>
          </form>
        </section>
      </div>
    </details>
  );
}
