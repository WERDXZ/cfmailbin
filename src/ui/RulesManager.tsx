import { useRef, useState } from "preact/hooks";
import { api } from "./api.ts";
import { ruleTemplates } from "../domain/rule-templates.ts";
import { ruleActions, ruleCondition, ruleName } from "../domain/rules.ts";
import { RuleEditor } from "./RuleEditor.tsx";
import { actionSummary } from "./RuleTrace.tsx";
import type { BootstrapResponse, CreateRuleInput, Rule } from "./types.ts";
import type { RunAction } from "./common.tsx";

export function RulesManager(
  { bootstrap, run, refresh }: {
    bootstrap: BootstrapResponse;
    run: RunAction;
    refresh: () => Promise<void>;
  },
) {
  const templates = ruleTemplates(bootstrap.config.emailDomain);
  const [templateId, setTemplateId] = useState(templates[0].id);
  const [editor, setEditor] = useState<
    { key: number; initial: CreateRuleInput; id?: string } | null
  >(null);
  const [busy, setBusy] = useState(false);
  const editorKey = useRef(0);
  const selected = templates.find((item) => item.id === templateId)!;
  function open(initial: CreateRuleInput, id?: string) {
    setEditor({
      initial: structuredClone(initial),
      id,
      key: ++editorKey.current,
    });
  }
  async function toggle(rule: Rule) {
    setBusy(true);
    await run(async () => {
      await api.patchRule(rule.id, { enabled: !rule.enabled });
      await refresh();
    });
    setBusy(false);
  }
  async function move(index: number, delta: number) {
    const ids = bootstrap.rules.map((rule) => rule.id);
    [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
    setBusy(true);
    await run(async () => {
      await api.reorderRules(ids);
      await refresh();
    }, "规则顺序已更新");
    setBusy(false);
  }
  return (
    <section class="rules-manager" aria-label="收件规则">
      <div class="rule-section-heading">
        <h2>收件规则</h2>
        <button
          type="button"
          class="text-button"
          disabled={busy}
          onClick={() =>
            open({
              name: "",
              actions: { delivery: "keep" },
              stopProcessing: true,
            })}
        >
          新建规则
        </button>
      </div>
      <p class="muted">
        从上往下执行。停用的规则跳过，未命中时沿用地址的默认处理。
      </p>
      <div class="template-picker">
        <label>
          从模板开始<select
            aria-label="从模板开始"
            value={templateId}
            onChange={(event) => setTemplateId(event.currentTarget.value)}
          >
            {templates.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          class="button"
          disabled={busy}
          onClick={() => open(selected.rule)}
        >
          使用模板
        </button>
      </div>
      <p class="muted">{selected.description}</p>
      {editor && (
        <RuleEditor
          key={editor.key}
          initial={editor.initial}
          ruleId={editor.id}
          aliases={bootstrap.aliases}
          run={run}
          onBusy={setBusy}
          onSaved={async () => {
            await refresh();
            setEditor(null);
          }}
          onCancel={() => setEditor(null)}
        />
      )}
      <ol class="managed-rules">
        {bootstrap.rules.map((rule, index) => (
          <li key={rule.id} class={!rule.enabled ? "rule-disabled" : ""}>
            <div class="rule-description">
              <strong>{index + 1}. {ruleName(rule)}</strong>
              <small>
                {rule.enabled ? "启用" : "停用"} · {rule.aliasId
                  ? bootstrap.aliases.find((alias) =>
                    alias.id === rule.aliasId
                  )
                    ?.address ?? "指定地址"
                  : "全部地址"} · {(rule.stopProcessing ?? true) ||
                    ruleActions(rule).delivery === "block"
                  ? "命中后停止"
                  : "继续后续规则"}
              </small>
              <small>{actionSummary(ruleActions(rule))}</small>
            </div>
            <div class="rule-controls">
              <button
                type="button"
                class="text-button"
                disabled={busy || index === 0 || !!editor}
                onClick={() => move(index, -1)}
                aria-label={`上移 ${ruleName(rule)}`}
              >
                ↑
              </button>
              <button
                type="button"
                class="text-button"
                disabled={busy || index === bootstrap.rules.length - 1 ||
                  !!editor}
                onClick={() => move(index, 1)}
                aria-label={`下移 ${ruleName(rule)}`}
              >
                ↓
              </button>
              <button
                type="button"
                class="text-button"
                disabled={busy}
                onClick={() =>
                  open({
                    name: ruleName(rule),
                    aliasId: rule.aliasId,
                    enabled: rule.enabled,
                    condition: ruleCondition(rule),
                    actions: ruleActions(rule),
                    stopProcessing: rule.stopProcessing ?? true,
                  }, rule.id)}
              >
                编辑
              </button>
              <button
                type="button"
                class="text-button"
                disabled={busy || !!editor}
                onClick={() => toggle(rule)}
              >
                {rule.enabled ? "停用" : "启用"}
              </button>
            </div>
          </li>
        ))}
      </ol>
      {!bootstrap.rules.length && (
        <p class="muted rules-empty">暂无规则，当前按地址的默认设置收件。</p>
      )}
    </section>
  );
}
