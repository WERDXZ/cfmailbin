import { useState } from "preact/hooks";
import type { RuleCondition } from "./types.ts";
import type { ConditionField, TextOperator } from "../domain/models.ts";
import { fieldLabels, operatorLabels } from "../domain/rules.ts";

export const emptyCondition = (): RuleCondition => ({
  field: "subject",
  operator: "contains",
  value: "",
});
export function conditionSize(condition: RuleCondition): number {
  if ("not" in condition) return 1 + conditionSize(condition.not);
  if ("all" in condition || "any" in condition) {
    return 1 +
      ("all" in condition ? condition.all : condition.any).reduce(
        (sum, child) => sum + conditionSize(child),
        0,
      );
  }
  return 1;
}
function conditionDepth(condition: RuleCondition): number {
  if ("not" in condition) return 1 + conditionDepth(condition.not);
  if ("all" in condition || "any" in condition) {
    return 1 +
      Math.max(
        ...("all" in condition ? condition.all : condition.any).map(
          conditionDepth,
        ),
      );
  }
  return 1;
}
function incomplete(condition: RuleCondition): boolean {
  if ("not" in condition) return incomplete(condition.not);
  if ("all" in condition || "any" in condition) {
    return ("all" in condition ? condition.all : condition.any).some(
      incomplete,
    );
  }
  return typeof condition.value === "string" && !condition.value.trim();
}
export function RuleConditionEditor(
  { condition, onChange, onRemove, depth = 1, path = "条件", remaining }: {
    condition: RuleCondition;
    onChange: (next: RuleCondition) => void;
    onRemove?: () => void;
    depth?: number;
    path?: string;
    remaining: number;
  },
) {
  const negated = "not" in condition;
  const node = "not" in condition ? condition.not : condition;
  const actualDepth = depth + Number(negated);
  function update(next: RuleCondition) {
    onChange(negated ? { not: next } : next);
  }
  const group = "all" in node || "any" in node;
  const children = "all" in node ? node.all : "any" in node ? node.any : [];
  const mode = "all" in node ? "all" : "any";
  const foldable = group && (depth > 1 || children.length > 3);
  const [expanded, setExpanded] = useState(!foldable || incomplete(condition));
  function updateChildren(next: RuleCondition[]) {
    update(mode === "all" ? { all: next } : { any: next });
  }
  const editor = (
    <div
      class={`condition-editor ${group ? "condition-group" : "condition-leaf"}`}
    >
      <div class="condition-controls">
        {group && (
          <select
            aria-label={`${path} 组合方式`}
            value={mode}
            onChange={(event) =>
              update(
                event.currentTarget.value === "all"
                  ? { all: children }
                  : { any: children },
              )}
          >
            <option value="all">全部满足（AND）</option>
            <option value="any">任一满足（OR）</option>
          </select>
        )}
        <label class="checkbox-label">
          <input
            type="checkbox"
            checked={negated}
            disabled={!negated &&
              (remaining < 1 || depth + conditionDepth(node) > 4)}
            onChange={(event) =>
              onChange(event.currentTarget.checked ? { not: node } : node)}
          />排除（NOT）
        </label>
        {onRemove && (
          <button
            type="button"
            class="text-button"
            aria-label={`删除${path}`}
            onClick={onRemove}
          >
            删除
          </button>
        )}
      </div>
      {group
        ? (
          <>
            <div class="condition-children">
              {children.map((child, index) => (
                <RuleConditionEditor
                  key={index}
                  condition={child}
                  remaining={remaining}
                  depth={actualDepth + 1}
                  path={`${path} ${index + 1}`}
                  onChange={(next) =>
                    updateChildren(
                      children.map((c, i) => i === index ? next : c),
                    )}
                  onRemove={children.length > 1
                    ? () =>
                      updateChildren(children.filter((_, i) => i !== index))
                    : undefined}
                />
              ))}
            </div>
            <div class="button-row">
              <button
                type="button"
                class="text-button"
                disabled={remaining < 1 || actualDepth >= 4}
                onClick={() => updateChildren([...children, emptyCondition()])}
              >
                添加条件
              </button>
              <button
                type="button"
                class="text-button"
                disabled={remaining < 2 || actualDepth >= 3}
                onClick={() =>
                  updateChildren([...children, { any: [emptyCondition()] }])}
              >
                添加条件组
              </button>
            </div>
          </>
        )
        : "field" in node
        ? (
          <div class="condition-fields">
            <select
              aria-label={`${path} 字段`}
              value={node.field}
              onChange={(event) => {
                const field = event.currentTarget.value;
                update(
                  field === "hasCode" ? { field, value: true } : {
                    field: field as ConditionField,
                    operator: "operator" in node ? node.operator : "contains",
                    value: typeof node.value === "string" ? node.value : "",
                  },
                );
              }}
            >
              {Object.entries(fieldLabels).map(([field, label]) => (
                <option key={field} value={field}>{label}</option>
              ))}
            </select>
            {node.field === "hasCode"
              ? (
                <select
                  aria-label={`${path} 验证码状态`}
                  value={String(node.value)}
                  onChange={(event) =>
                    update({
                      field: "hasCode",
                      value: event.currentTarget.value === "true",
                    })}
                >
                  <option value="true">已识别到</option>
                  <option value="false">未识别到</option>
                </select>
              )
              : (
                <>
                  <select
                    aria-label={`${path} 匹配方式`}
                    value={node.operator}
                    onChange={(event) =>
                      update({
                        ...node,
                        operator: event.currentTarget.value as TextOperator,
                      })}
                  >
                    {Object.entries(operatorLabels).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                  <input
                    aria-label={`${path} 匹配内容`}
                    required
                    maxLength={256}
                    placeholder={node.operator === "glob"
                      ? "例如 github*@example.com"
                      : "匹配内容"}
                    value={node.value}
                    onInput={(event) =>
                      update({ ...node, value: event.currentTarget.value })}
                  />
                </>
              )}
          </div>
        )
        : "not" in node
        ? (
          <RuleConditionEditor
            condition={node}
            onChange={update}
            depth={actualDepth}
            path={path}
            remaining={remaining}
          />
        )
        : null}
    </div>
  );
  return foldable
    ? (
      <details
        class="condition-fold"
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary>
          {negated ? "排除 · " : ""}
          {mode === "all" ? "全部满足" : "任一满足"} · {children.length} 项条件
        </summary>
        {editor}
      </details>
    )
    : editor;
}
