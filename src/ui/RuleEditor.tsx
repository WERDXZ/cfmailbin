import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.ts";
import { parseRuleInput } from "../domain/rule-validation.ts";
import { actionLabels } from "../domain/rules.ts";
import type {
  Alias,
  CreateRuleInput,
  RuleActions,
  RulePreview,
} from "./types.ts";
import type { RunAction } from "./common.tsx";
import {
  conditionSize,
  emptyCondition,
  RuleConditionEditor,
} from "./RuleConditionEditor.tsx";
import { ConditionTrace, RuleTrace } from "./RuleTrace.tsx";

export function RuleEditor(
  { initial, ruleId, aliases, run, onSaved, onCancel, onBusy }: {
    initial: CreateRuleInput;
    ruleId?: string;
    aliases: Alias[];
    run: RunAction;
    onSaved: () => Promise<void>;
    onBusy: (busy: boolean) => void;
    onCancel: () => void;
  },
) {
  const initialCondition = initial.condition ?? { all: [emptyCondition()] };
  const [draft, setDraft] = useState<CreateRuleInput>({
    ...initial,
    enabled: initial.enabled ?? true,
    aliasId: initial.aliasId ?? null,
    stopProcessing: initial.stopProcessing ?? true,
    condition: "field" in initialCondition
      ? { all: [initialCondition] }
      : initialCondition,
    actions: initial.actions ?? { delivery: "keep" },
  });
  const [tags, setTags] = useState(initial.actions?.tags?.join(", ") ?? "");
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [error, setError] = useState("");
  const [busy, setLocalBusy] = useState(false);
  function setBusy(next: boolean) {
    setLocalBusy(next);
    onBusy(next);
  }
  const form = useRef<HTMLFormElement>(null);
  const controller = useRef<AbortController>();
  useEffect(() => () => controller.current?.abort(), []);
  function change(patch: Partial<CreateRuleInput>) {
    controller.current?.abort();
    setDraft((old) => ({ ...old, ...patch }));
    setPreview(null);
    setError("");
  }
  function effects(patch: Partial<RuleActions>) {
    change({ actions: { ...draft.actions, ...patch } });
  }
  function validated() {
    if (!form.current?.reportValidity()) return;
    try {
      return parseRuleInput(draft);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "请检查规则");
    }
  }
  async function save(event: Event) {
    event.preventDefault();
    const input = validated();
    if (!input) return;
    setBusy(true);
    await run(
      async () => {
        if (ruleId) await api.patchRule(ruleId, input);
        else await api.createRule(input);
        await onSaved();
      },
      input.enabled
        ? "规则已保存并启用，仅影响之后收到的邮件"
        : "规则已保存，当前停用",
    );
    setBusy(false);
  }
  async function trial() {
    const input = validated();
    if (!input) return;
    setBusy(true);
    setPreview(null);
    const current = new AbortController();
    controller.current = current;
    const result = await run(async () => {
      try {
        return await api.previewRule(input, ruleId, current.signal);
      } catch (caught) {
        if (!current.signal.aborted) throw caught;
      }
    });
    if (!current.signal.aborted && result) setPreview(result);
    setBusy(false);
  }
  const actions = draft.actions!;
  return (
    <form
      ref={form}
      class="rule-editor"
      onSubmit={save}
      onInvalidCapture={(event) => {
        let ancestor = (event.target as Element).closest("details");
        while (ancestor) {
          ancestor.open = true;
          ancestor = ancestor.parentElement?.closest("details") ?? null;
        }
      }}
      aria-label="规则编辑器"
    >
      <fieldset disabled={busy}>
        <legend>{ruleId ? "编辑规则" : "新规则"}</legend>
        <div class="form-pair">
          <label>
            规则名称<input
              required
              maxLength={120}
              value={draft.name ?? ""}
              onInput={(event) => change({ name: event.currentTarget.value })}
            />
          </label>
          <label>
            适用地址<select
              aria-label="适用地址"
              value={draft.aliasId ?? ""}
              onChange={(event) =>
                change({ aliasId: event.currentTarget.value || null })}
            >
              <option value="">全部地址</option>
              {aliases.map((alias) => (
                <option key={alias.id} value={alias.id}>
                  {alias.description ? `${alias.description} · ` : ""}
                  {alias.address}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div class="rule-section-heading">
          <h3>当</h3>
          <span class="muted">
            文字匹配忽略大小写；* 匹配任意长度，? 匹配单个字符
          </span>
        </div>
        <RuleConditionEditor
          condition={draft.condition!}
          onChange={(condition) => change({ condition })}
          remaining={32 - conditionSize(draft.condition!)}
        />
        <div class="rule-section-heading">
          <h3>则</h3>
        </div>
        <div class="rule-effects">
          <label>
            邮件处理<select
              aria-label="邮件处理"
              value={actions.delivery ?? ""}
              onChange={(event) => {
                const delivery = event.currentTarget
                  .value as RuleActions["delivery"];
                change({
                  actions: {
                    ...actions,
                    delivery: delivery || undefined,
                    forwardTo: undefined,
                  },
                  stopProcessing: delivery === "block"
                    ? true
                    : draft.stopProcessing,
                });
              }}
            >
              <option value="">保持当前处理方式</option>
              {Object.entries(actionLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          {actions.delivery === "forward" && (
            <label>
              转发目标<input
                type="email"
                required
                value={actions.forwardTo ?? ""}
                placeholder="已在 Cloudflare 验证的邮箱"
                onInput={(event) =>
                  effects({ forwardTo: event.currentTarget.value })}
              />
            </label>
          )}
          <label>
            添加标签（逗号分隔）<input
              value={tags}
              placeholder="例如 登录, github"
              onInput={(event) => {
                const value = event.currentTarget.value;
                setTags(value);
                effects({
                  tags: value.split(",").map((tag) => tag.trim()).filter(
                    Boolean,
                  ),
                });
              }}
            />
          </label>
          <div class="retention-effect">
            <label class="checkbox-label">
              <input
                type="checkbox"
                checked={actions.retentionDays !== undefined}
                onChange={(event) =>
                  effects({
                    retentionDays: event.currentTarget.checked ? 7 : undefined,
                  })}
              />覆盖邮件保留时间
            </label>
            {actions.retentionDays !== undefined && (
              <label>
                保留天数<input
                  type="number"
                  min={1}
                  max={365}
                  required
                  value={actions.retentionDays}
                  onInput={(event) =>
                    effects({
                      retentionDays: Number(event.currentTarget.value),
                    })}
                />
              </label>
            )}
          </div>
        </div>
        <div class="rule-switches">
          <label class="checkbox-label">
            <input
              type="checkbox"
              checked={actions.delivery === "block" || draft.stopProcessing}
              disabled={actions.delivery === "block"}
              onChange={(event) =>
                change({ stopProcessing: event.currentTarget.checked })}
            />执行后停止后续规则{actions.delivery === "block"
              ? "（拒收始终停止）"
              : ""}
          </label>
          <label class="checkbox-label">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) =>
                change({ enabled: event.currentTarget.checked })}
            />保存后启用
          </label>
        </div>
        <p class="muted">
          标签累加；后续命中的规则可覆盖处理方式和保留天数。试运行按启用状态测试此草稿，不修改已有邮件。
        </p>
        {error && <p class="inline-error" role="alert">{error}</p>}
        <div class="button-row">
          <button type="submit" class="button button--primary">
            {draft.enabled ? "保存并启用" : "保存为停用"}
          </button>
          <button type="button" class="button" onClick={trial}>
            用最近邮件试运行
          </button>
          <button type="button" class="text-button" onClick={onCancel}>
            取消
          </button>
          {busy && <span role="status">处理中…</span>}
        </div>
      </fieldset>
      {preview && (
        <section
          class="rule-preview"
          aria-label="试运行结果"
          aria-live="polite"
        >
          <h3>检查 {preview.examined} 封 · 草稿命中 {preview.matched} 封</h3>
          <p class="muted">
            仅检查最近 20
            封适用地址的邮件，按当前规则顺序计算。转发、拒收和修改均未实际执行。
          </p>
          {!preview.examined && (
            <p class="muted">
              没有可试运行的历史邮件。可先保存为停用，收到邮件后再试。
            </p>
          )}
          {preview.rows.map((row) => (
            <details key={row.messageId} class="preview-row">
              <summary>
                {row.subject || "无主题"} · {!row.draftReached
                  ? "未执行到草稿"
                  : row.draftResult === null
                  ? "无法判断"
                  : row.draftResult
                  ? "命中草稿"
                  : "不匹配"}
              </summary>
              <p class="muted">
                {row.aliasAddress}{" "}
                · 最终处理：{actionLabels[row.decision.action]}
                {row.decision.action === "forward"
                  ? ` → ${row.decision.forwardTo ?? "尚未配置转发目标"}`
                  : ""} · 保留 {row.decision.retentionDays}{" "}
                天{row.decision.tags.length
                  ? ` · 标签：${row.decision.tags.join("、")}`
                  : ""}
              </p>
              {!row.draftReached && (
                <p class="muted">
                  前面的规则已停止处理，或此地址已停用。草稿条件单独判断如下。
                </p>
              )}
              <ul>
                <ConditionTrace trace={row.draftCondition} />
              </ul>
              <RuleTrace traces={row.decision.trace} />
            </details>
          ))}
        </section>
      )}
    </form>
  );
}
