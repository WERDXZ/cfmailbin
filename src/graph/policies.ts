import { codePolicies } from "./code-policies.ts";
import { parseActions } from "../domain/rule-validation.ts";
import {
  type Completeness,
  conditionPaths,
  conditionVerdict,
  parseCondition,
} from "./conditions.ts";
import { pathParts } from "./paths.ts";
import {
  GraphError,
  type JsonValue,
  type PolicyDefinition,
  type PolicyExpression,
  type PolicyResult,
} from "./types.ts";

function strings(value: unknown): string[] {
  if (
    !Array.isArray(value) || value.length > 8 ||
    value.some((v) => typeof v !== "string" || !v.trim() || v.length > 200)
  ) {
    throw new GraphError(
      "输出最多 8 项，每项 1–200 字符",
      "errors.policyOutputLimits",
      { maxItems: 8, minLength: 1, maxLength: 200 },
    );
  }
  return [...new Set(value)];
}
/** New library versions omit legacy outcome configuration; embedded snapshots stay intact. */
export function purePolicy(p: PolicyDefinition): PolicyDefinition {
  return {
    version: 2,
    id: p.id,
    revision: p.revision,
    name: p.name,
    condition: p.condition,
  };
}
export function parsePolicy(input: unknown): PolicyDefinition {
  const p = input as PolicyDefinition;
  if (
    !p || typeof p.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(p.id) ||
    typeof p.revision !== "string" || p.revision.length > 80 ||
    typeof p.name !== "string" || !p.name.trim() || p.name.length > 80 ||
    p.version !== 2 && (!p.success || !p.failed) ||
    p.success !== undefined &&
      (!p.success || !Array.isArray(p.success.actions) ||
        p.success.actions.length > 8)
  ) {
    throw new GraphError(
      "Policy 名称、版本或输出配置无效",
      "errors.invalidPolicyConfiguration",
    );
  }
  if (
    p.version !== undefined && p.version !== 2 ||
    p.version === 2 && p.success?.actions.length
  ) {
    throw new GraphError(
      "规则只返回结果；邮件处理请使用流程中的 Action",
      "errors.policyActionsNotAllowed",
    );
  }
  const condition = parseCondition(p.condition);
  conditionPaths(condition).forEach((path) => pathParts(path, true));
  const actions = p.success?.actions.map(parseActions) ?? [];
  if (
    actions.some((action) => action.delivery === "forward" && !action.forwardTo)
  ) {
    throw new GraphError(
      "Policy 转发动作需要明确的目标地址",
      "errors.policyForwardAddressRequired",
    );
  }
  return {
    ...(p.version === 2 ? { version: 2 as const } : {}),
    id: p.id,
    revision: p.revision,
    name: p.name.trim(),
    condition,
    ...(p.success === undefined ? {} : {
      success: { actions, branches: strings(p.success.branches) },
    }),
    ...(p.failed === undefined ? {} : {
      failed: {
        reasons: strings(p.failed?.reasons),
        branches: strings(p.failed?.branches),
      },
    }),
  };
}
export function parsePolicyLibrary(input: unknown): PolicyDefinition[] {
  if (
    !Array.isArray(input) || input.length > 50 ||
    JSON.stringify(input).length > 240000
  ) {
    throw new GraphError(
      "Policy 库最多 50 项、240,000 字符",
      "errors.policyLibraryLimits",
      { maxItems: 50, maxSize: 240000 },
    );
  }
  const policies = input.map(parsePolicy);
  if (
    new Set(policies.map((p) => p.id)).size !== policies.length ||
    policies.some((p) => p.id.startsWith("builtin_"))
  ) {
    throw new GraphError(
      "Policy ID 重复或属于内置预设",
      "errors.invalidPolicyId",
    );
  }
  return policies;
}
export function parsePolicyExpression(input: unknown): PolicyExpression {
  let count = 0;
  function walk(value: unknown, depth: number): PolicyExpression {
    if (
      ++count > 24 || depth > 5 || !value || typeof value !== "object" ||
      Array.isArray(value) || Object.keys(value).length !== 1
    ) {
      throw new GraphError(
        "Policy 组合最多 24 项、5 层",
        "errors.policyGroupComplexity",
        { maxItems: 24, maxDepth: 5 },
      );
    }
    const c = value as Record<string, unknown>;
    if ("policy" in c) return { policy: parsePolicy(c.policy) };
    if ("not" in c) return { not: walk(c.not, depth + 1) };
    for (const key of ["all", "any"] as const) {
      if (Array.isArray(c[key]) && c[key].length) {
        return {
          [key]: c[key].map((child) => walk(child, depth + 1)),
        } as PolicyExpression;
      }
    }
    throw new GraphError(
      "请选择 Policy 或 AND / OR / NOT 组合",
      "errors.policyExpressionRequired",
    );
  }
  return walk(input, 1);
}
export function policyPaths(expr: PolicyExpression): string[] {
  return "policy" in expr
    ? conditionPaths(expr.policy.condition)
    : "not" in expr
    ? policyPaths(expr.not)
    : ("all" in expr ? expr.all : expr.any).flatMap(policyPaths);
}
export function evaluatePolicies(
  expr: PolicyExpression,
  read: (path: string) => JsonValue,
  completeness?: Completeness,
): PolicyResult {
  if ("policy" in expr) {
    const p = expr.policy,
      value = conditionVerdict(p.condition, read, completeness),
      matched = value === true;
    const indeterminate = value === null;
    const reasons = matched
      ? []
      : indeterminate
      ? ["邮件内容不完整，无法确定此 Policy 的结果"]
      : p.failed?.reasons ?? [];
    const branches = indeterminate
      ? []
      : matched
      ? p.success?.branches ?? []
      : p.failed?.branches ?? [];
    return {
      success: value,
      status: indeterminate ? "unknown" : matched ? "success" : "failed",
      matched,
      indeterminate,
      actions: matched ? p.success?.actions ?? [] : [],
      reasons,
      branches,
      results: [{
        id: p.id,
        name: p.name,
        revision: p.revision,
        success: value,
        matched,
        indeterminate,
        reasons,
        branches,
      }],
    };
  }
  if ("not" in expr) {
    const result = evaluatePolicies(expr.not, read, completeness);
    return {
      ...result,
      success: result.success === null ? null : !result.success,
      status: result.indeterminate
        ? "unknown"
        : result.matched
        ? "failed"
        : "success",
      matched: !result.matched && !result.indeterminate,
      actions: [],
      branches: [],
      reasons: result.indeterminate
        ? result.reasons
        : result.matched
        ? ["NOT：被排除的 Policy 已命中"]
        : [],
    };
  }
  const all = "all" in expr;
  const results = ("all" in expr ? expr.all : expr.any).map((c) =>
    evaluatePolicies(c, read, completeness)
  );
  const matched = all
    ? results.every((r) => r.matched)
    : results.some((r) => r.matched);
  const selected = results.filter((r) => r.matched === matched);
  const indeterminate = !matched && results.some((r) => r.indeterminate) &&
    (!all || !results.some((r) => !r.matched && !r.indeterminate));
  return {
    success: indeterminate ? null : matched,
    status: indeterminate ? "unknown" : matched ? "success" : "failed",
    matched,
    indeterminate,
    actions: matched ? selected.flatMap((r) => r.actions) : [],
    branches: [...new Set(selected.flatMap((r) => r.branches))],
    reasons: matched ? [] : [...new Set(selected.flatMap((r) => r.reasons))],
    results: results.flatMap((r) => r.results),
  };
}
const policyDefinitions: PolicyDefinition[] = [
  {
    id: "builtin_from_trusted_domain",
    revision: "3",
    name: "from_trusted_domain",
    condition: {
      path: "email.from",
      operator: "endsWithAny",
      value: ["@example.com"],
    },
  },
  {
    id: "builtin_contain_warning",
    revision: "3",
    name: "contain_warning",
    condition: {
      any: [{
        path: "email.subject",
        operator: "containsAny",
        value: ["warning", "警告"],
      }, {
        path: "email.text",
        operator: "containsAny",
        value: ["warning", "警告"],
      }],
    },
  },
  ...Object.values(codePolicies),
];
export const builtInPolicies: PolicyDefinition[] = policyDefinitions.map(
  purePolicy,
);
