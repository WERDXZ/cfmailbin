import type {
  Alias,
  ConditionTrace,
  CreateRuleInput,
  IncomingMessage,
  MessageStatus,
  Rule,
  RuleActions,
  RuleCondition,
  RuleDecision,
  TextOperator,
  UpdateRuleInput,
} from "./models.ts";

export const fieldLabels = {
  alias: "收件地址",
  from: "发件地址",
  fromDomain: "发件域名",
  subject: "主题",
  body: "正文",
  hasCode: "识别到验证码",
};
export const operatorLabels: Record<TextOperator, string> = {
  equals: "等于",
  contains: "包含",
  startsWith: "开头是",
  endsWith: "结尾是",
  glob: "匹配通配符",
};
export const actionLabels = {
  keep: "保留",
  forward: "转发并保留",
  trash: "移入垃圾箱",
  block: "拒收",
};
export function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}
export function ruleCondition(rule: Rule): RuleCondition {
  return rule.condition ??
    { field: rule.field, operator: "contains", value: rule.pattern };
}
export function ruleActions(rule: Rule): RuleActions {
  return rule.actions ?? { delivery: rule.action };
}
export function ruleName(rule: Rule): string {
  return rule.name ||
    (rule.pattern
      ? `${fieldLabels[rule.field]}包含 ${rule.pattern}`
      : "未命名规则");
}

export function makeRule(input: CreateRuleInput, priority: number): Rule {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    aliasId: input.aliasId ?? null,
    enabled: input.enabled ?? true,
    field: input.field ?? "subject",
    pattern: input.pattern?.trim() ?? "",
    action: input.action ?? input.actions?.delivery ?? "keep",
    name: input.name,
    priority: input.priority ?? priority,
    condition: input.condition ??
      {
        field: input.field ?? "subject",
        operator: "contains",
        value: input.pattern?.trim() ?? "",
      },
    actions: input.actions ?? { delivery: input.action ?? "keep" },
    stopProcessing: input.stopProcessing ?? true,
  };
}
export function patchRule(rule: Rule, patch: UpdateRuleInput): Rule {
  const next = {
    ...rule,
    ...Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ),
    updatedAt: new Date().toISOString(),
  };
  if (patch.field !== undefined || patch.pattern !== undefined) {
    next.condition = {
      field: next.field,
      operator: "contains",
      value: next.pattern,
    };
  }
  if (patch.action !== undefined) {
    next.actions = { ...ruleActions(next), delivery: patch.action };
  }
  if (patch.actions?.delivery) next.action = patch.actions.delivery;
  return next;
}
export function compareRules(a: Rule, b: Rule): number {
  if (
    a.priority === undefined && b.priority === undefined &&
    !!a.aliasId !== !!b.aliasId
  ) return a.aliasId ? -1 : 1;
  return (a.priority ?? 0) - (b.priority ?? 0) ||
    a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

/** Whole-field glob; no user-provided regular expressions are executed. */
function globMatches(text: string, pattern: string): boolean {
  let i = 0, j = 0, star = -1, retry = 0;
  while (i < text.length) {
    if (j < pattern.length && (pattern[j] === "?" || pattern[j] === text[i])) {
      i++;
      j++;
    } else if (pattern[j] === "*") {
      star = j++;
      retry = i;
    } else if (star >= 0) {
      j = star + 1;
      i = ++retry;
    } else return false;
  }
  while (pattern[j] === "*") j++;
  return j === pattern.length;
}
export function evaluateCondition(
  condition: RuleCondition,
  message: IncomingMessage,
): ConditionTrace {
  if ("all" in condition || "any" in condition) {
    const all = "all" in condition;
    const children = ("all" in condition ? condition.all : condition.any).map(
      (c) => evaluateCondition(c, message),
    );
    const results = children.map((c) => c.result);
    const result = all
      ? results.includes(false) ? false : results.includes(null) ? null : true
      : results.includes(true)
      ? true
      : results.includes(null)
      ? null
      : false;
    return { label: all ? "全部满足" : "任一满足", result, children };
  }
  if ("not" in condition) {
    const child = evaluateCondition(condition.not, message);
    return {
      label: "排除",
      result: child.result === null ? null : !child.result,
      children: [child],
    };
  }
  if (condition.field === "hasCode") {
    return {
      label: condition.value ? "识别到验证码" : "未识别到验证码",
      result: message.hasCode === undefined
        ? null
        : message.hasCode === condition.value,
    };
  }
  const value = condition.field === "fromDomain"
    ? message.from.slice(message.from.lastIndexOf("@") + 1)
    : condition.field === "body"
    ? message.body
    : message[condition.field];
  const label = `${fieldLabels[condition.field]} ${
    operatorLabels[condition.operator]
  }「${condition.value}」`;
  if (value === undefined) return { label, result: null };
  const actual = value.trim().toLowerCase(),
    expected = condition.value.trim().toLowerCase();
  let result: boolean | null;
  switch (condition.operator) {
    case "equals":
      result = actual === expected;
      break;
    case "contains":
      result = actual.includes(expected);
      break;
    case "startsWith":
      result = actual.startsWith(expected);
      break;
    case "endsWith":
      result = actual.endsWith(expected);
      break;
    case "glob":
      result = globMatches(actual, expected);
      break;
  }
  // A truncated body can prove a positive contains/prefix match, not absence.
  if (
    condition.field === "body" && !message.contentComplete &&
    !(result && ["contains", "startsWith"].includes(condition.operator))
  ) result = null;
  return { label, result };
}
export function ruleMatches(
  alias: Alias,
  message: IncomingMessage,
  rule: Rule,
): boolean {
  return rule.enabled && (!rule.aliasId || rule.aliasId === alias.id) &&
    evaluateCondition(ruleCondition(rule), message).result === true;
}
export function resolveMessageAction(
  alias: Alias,
  rules: Rule[],
  message: IncomingMessage,
): RuleDecision {
  const decision: RuleDecision = {
    action: alias.defaultAction,
    forwardTo: alias.forwardTo,
    retentionDays: alias.retentionDays,
    tags: [],
    matchedRuleId: null,
    trace: [],
  };
  if (
    normalizeAddress(alias.address) !== normalizeAddress(message.alias) ||
    !alias.enabled
  ) return { ...decision, action: "block" };
  for (const rule of [...rules].sort(compareRules)) {
    if (!rule.enabled || (rule.aliasId && rule.aliasId !== alias.id)) continue;
    const condition = evaluateCondition(ruleCondition(rule), message),
      actions = ruleActions(rule);
    const stopped = condition.result === true &&
      ((rule.stopProcessing ?? true) || actions.delivery === "block");
    decision.trace.push({
      ruleId: rule.id,
      name: ruleName(rule),
      condition,
      actions,
      stopped,
    });
    if (condition.result !== true) continue;
    decision.matchedRuleId = rule.id;
    if (actions.delivery) {
      decision.action = actions.delivery;
      decision.forwardTo = actions.delivery === "forward"
        ? actions.forwardTo ?? alias.forwardTo
        : undefined;
    }
    if (actions.retentionDays !== undefined) {
      decision.retentionDays = actions.retentionDays;
    }
    decision.tags = [...new Set([...decision.tags, ...(actions.tags ?? [])])];
    if (stopped) break;
  }
  return decision;
}
export function messageStatusForAction(
  action: RuleDecision["action"],
  forwarded: boolean,
): MessageStatus {
  switch (action) {
    case "keep":
      return "inbox";
    case "forward":
      return forwarded ? "forwarded" : "inbox";
    case "trash":
      return "trashed";
    case "block":
      return "blocked";
  }
}
