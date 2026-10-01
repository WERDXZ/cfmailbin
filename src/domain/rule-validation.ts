import type {
  CreateRuleInput,
  RuleActions,
  RuleCondition,
  TextOperator,
} from "./models.ts";
import type { ErrorParams } from "./errors.ts";

export class RuleValidationError extends Error {
  readonly status = 400;

  constructor(
    message: string,
    readonly code?: string,
    readonly params?: ErrorParams,
  ) {
    super(message);
  }
}
function fail(message: string, code?: string, params?: ErrorParams): never {
  throw new RuleValidationError(message, code, params);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("规则格式无效", "errors.invalidRuleFormat");
  }
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    fail("规则包含未知字段", "errors.unknownRuleField");
  }
}
function text(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    fail(
      `请填写 1–${max} 字符的内容`,
      "errors.textLengthRange",
      { min: 1, max },
    );
  }
  return value.trim();
}
function integer(value: unknown, min: number, max: number): number {
  if (
    typeof value !== "number" || !Number.isInteger(value) || value < min ||
    value > max
  ) {
    fail(
      `数值必须为 ${min}–${max} 的整数`,
      "errors.integerRange",
      { min, max },
    );
  }
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    fail("开关必须为布尔值", "errors.booleanRequired");
  }
  return value;
}
function parseCondition(value: unknown): RuleCondition {
  let nodes = 0;
  function walk(input: unknown, depth: number): RuleCondition {
    if (++nodes > 32 || depth > 4) {
      fail(
        "最多 32 个条件节点、4 层嵌套",
        "errors.ruleConditionComplexity",
        { maxNodes: 32, maxDepth: 4 },
      );
    }
    const item = object(input);
    for (const group of ["all", "any"] as const) {
      if (group in item) {
        keys(item, [group]);
        const children = item[group];
        if (!Array.isArray(children) || children.length === 0) {
          fail("条件组不能为空", "errors.emptyConditionGroup");
        }
        return {
          [group]: children.map((child) => walk(child, depth + 1)),
        } as RuleCondition;
      }
    }
    if ("not" in item) {
      keys(item, ["not"]);
      return { not: walk(item.not, depth + 1) };
    }
    if (item.field === "hasCode") {
      keys(item, ["field", "value"]);
      return { field: "hasCode", value: boolean(item.value) };
    }
    keys(item, ["field", "operator", "value"]);
    if (
      !["alias", "from", "fromDomain", "subject", "body"].includes(
        String(item.field),
      )
    ) fail("不支持的匹配字段", "errors.unsupportedMatchField");
    if (
      !["equals", "contains", "startsWith", "endsWith", "glob"].includes(
        String(item.operator),
      )
    ) fail("不支持的匹配方式", "errors.unsupportedMatchOperator");
    return {
      field: item.field as "subject",
      operator: item.operator as TextOperator,
      value: text(item.value),
    };
  }
  return walk(value, 1);
}
export function parseActions(value: unknown): RuleActions {
  const item = object(value);
  keys(item, ["delivery", "forwardTo", "tags", "retentionDays"]);
  const actions: RuleActions = {};
  if (item.delivery !== undefined) {
    if (
      !["keep", "forward", "trash", "block"].includes(String(item.delivery))
    ) fail("不支持的处理方式", "errors.unsupportedDeliveryAction");
    actions.delivery = item.delivery as RuleActions["delivery"];
  }
  if (item.forwardTo !== undefined) {
    actions.forwardTo = text(item.forwardTo, 254).toLowerCase();
    if (
      actions.delivery !== "forward" ||
      !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(actions.forwardTo)
    ) {
      fail(
        "请为转发操作填写有效的目标邮箱",
        "errors.invalidRuleForwardAddress",
      );
    }
  }
  if (item.retentionDays !== undefined) {
    actions.retentionDays = integer(item.retentionDays, 1, 365);
  }
  if (item.tags !== undefined) {
    if (!Array.isArray(item.tags) || item.tags.length > 10) {
      fail("最多添加 10 个标签", "errors.ruleTagLimit", { max: 10 });
    }
    actions.tags = [
      ...new Set(item.tags.map((tag) => text(tag, 64).toLowerCase())),
    ];
  }
  if (!actions.delivery && !actions.retentionDays && !actions.tags?.length) {
    fail("至少选择一个动作", "errors.ruleActionRequired");
  }
  return actions;
}
export function parseRuleInput(
  value: unknown,
  partial = false,
): CreateRuleInput {
  const item = object(value);
  keys(item, [
    "name",
    "condition",
    "actions",
    "priority",
    "stopProcessing",
    "aliasId",
    "enabled",
    "field",
    "pattern",
    "action",
  ]);
  const out: CreateRuleInput = {};
  if (item.name !== undefined) out.name = text(item.name, 120);
  if (item.aliasId !== undefined) {
    out.aliasId = item.aliasId === null ? null : text(item.aliasId, 100);
  }
  if (item.enabled !== undefined) out.enabled = boolean(item.enabled);
  if (item.stopProcessing !== undefined) {
    out.stopProcessing = boolean(item.stopProcessing);
  }
  if (item.priority !== undefined) {
    out.priority = integer(item.priority, 0, 1000000);
  }
  if (item.condition !== undefined) {
    out.condition = parseCondition(item.condition);
  }
  if (item.actions !== undefined) out.actions = parseActions(item.actions);
  if (item.field !== undefined) {
    if (!["alias", "from", "subject"].includes(String(item.field))) {
      fail("不支持的旧规则字段", "errors.unsupportedLegacyRuleField");
    }
    out.field = item.field as "subject";
  }
  if (item.pattern !== undefined) out.pattern = text(item.pattern);
  if (item.action !== undefined) {
    out.action = parseActions({ delivery: item.action }).delivery;
  }
  if (out.condition && (out.field !== undefined || out.pattern !== undefined)) {
    fail("请使用一种条件格式", "errors.singleConditionFormatRequired");
  }
  if (out.actions && out.action !== undefined) {
    fail("请使用一种动作格式", "errors.singleActionFormatRequired");
  }
  if (!partial && !out.condition && (!out.field || !out.pattern)) {
    fail("请添加匹配条件", "errors.ruleConditionRequired");
  }
  if (!partial && !out.actions && !out.action) {
    fail("请添加处理动作", "errors.ruleActionRequired");
  }
  return out;
}
