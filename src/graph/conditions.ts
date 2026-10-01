import { globMatches } from "../domain/rules.ts";
import { type GraphCondition, GraphError, type JsonValue } from "./types.ts";

/** Bounded, data-only boolean expressions. Contains ignores case. */
export function parseCondition(input: unknown): GraphCondition {
  let count = 0;
  function walk(value: unknown, depth: number): GraphCondition {
    if (
      ++count > 32 || depth > 5 || !value || typeof value !== "object" ||
      Array.isArray(value)
    ) {
      throw new GraphError(
        "条件最多 32 项、5 层嵌套",
        "errors.conditionComplexity",
        { maxItems: 32, maxDepth: 5 },
      );
    }
    const c = value as Record<string, unknown>;
    for (const key of ["all", "any"] as const) {
      if (key in c) {
        if (
          Object.keys(c).length !== 1 || !Array.isArray(c[key]) ||
          !c[key].length
        ) {
          throw new GraphError(
            "条件组不能为空或混用组合方式",
            "errors.invalidConditionGroup",
          );
        }
        return {
          [key]: c[key].map((v) => walk(v, depth + 1)),
        } as GraphCondition;
      }
    }
    if ("not" in c) {
      if (Object.keys(c).length !== 1) {
        throw new GraphError(
          "NOT 条件格式无效",
          "errors.invalidNotCondition",
        );
      }
      return { not: walk(c.not, depth + 1) };
    }
    if (
      Object.keys(c).some((k) => !["path", "operator", "value"].includes(k)) ||
      typeof c.path !== "string" || c.path.length > 320 ||
      ![
        "equals",
        "contains",
        "exists",
        "containsAny",
        "startsWithAny",
        "endsWithAny",
        "textEquals",
        "startsWith",
        "endsWith",
        "glob",
      ].includes(String(c.operator)) ||
      (["containsAny", "startsWithAny", "endsWithAny"].includes(
          String(c.operator),
        )
        ? !Array.isArray(c.value) || c.value.length < 1 ||
          c.value.length > 256 ||
          c.value.some((v) => typeof v !== "string" || !v || v.length > 1000)
        : c.value !== null &&
          !["string", "boolean", "number"].includes(typeof c.value)) ||
      typeof c.value === "string" && c.value.length > 1000 ||
      typeof c.value === "number" && !Number.isFinite(c.value)
    ) {
      throw new GraphError(
        "条件字段、比较方式或值无效",
        "errors.invalidCondition",
      );
    }
    return c as unknown as GraphCondition;
  }
  return walk(input, 1);
}

export function conditionPaths(c: GraphCondition): string[] {
  if ("all" in c) return c.all.flatMap(conditionPaths);
  if ("any" in c) return c.any.flatMap(conditionPaths);
  if ("not" in c) return conditionPaths(c.not);
  return [c.path];
}

export function matchesCondition(
  c: GraphCondition,
  read: (path: string) => JsonValue,
): boolean {
  if ("all" in c) return c.all.every((child) => matchesCondition(child, read));
  if ("any" in c) return c.any.some((child) => matchesCondition(child, read));
  if ("not" in c) return !matchesCondition(c.not, read);
  const value = read(c.path);
  if (["textEquals", "startsWith", "endsWith", "glob"].includes(c.operator)) {
    if (typeof value !== "string" || typeof c.value !== "string") return false;
    const actual = value.trim().toLowerCase(),
      expected = c.value.trim().toLowerCase();
    return c.operator === "textEquals"
      ? actual === expected
      : c.operator === "startsWith"
      ? actual.startsWith(expected)
      : c.operator === "endsWith"
      ? actual.endsWith(expected)
      : globMatches(actual, expected);
  }
  if (["containsAny", "startsWithAny", "endsWithAny"].includes(c.operator)) {
    if (typeof value !== "string" || !Array.isArray(c.value)) return false;
    const actual = value.toLowerCase();
    return c.value.some((entry) =>
      typeof entry === "string" &&
      (c.operator === "containsAny"
        ? actual.includes(entry.toLowerCase())
        : c.operator === "startsWithAny"
        ? actual.startsWith(entry.toLowerCase())
        : actual.endsWith(entry.toLowerCase()))
    );
  }
  return c.operator === "exists"
    ? value !== null && value !== "" &&
      (!Array.isArray(value) || value.length > 0)
    : c.operator === "equals"
    ? value === c.value
    : typeof value === "string" && typeof c.value === "string"
    ? value.toLowerCase().includes(c.value.toLowerCase())
    : Array.isArray(value) && value.includes(c.value);
}

export type Completeness = (
  path: string,
) => "unavailable" | "truncated" | undefined;
export function conditionVerdict(
  condition: GraphCondition,
  read: (path: string) => JsonValue,
  completeness?: Completeness,
): boolean | null {
  if ("not" in condition) {
    const value = conditionVerdict(condition.not, read, completeness);
    return value === null ? null : !value;
  }
  if ("all" in condition || "any" in condition) {
    const all = "all" in condition;
    const values = ("all" in condition ? condition.all : condition.any).map((
      c,
    ) => conditionVerdict(c, read, completeness));
    if (all && values.includes(false)) return false;
    if (!all && values.includes(true)) return true;
    return values.includes(null) ? null : all;
  }
  const state = completeness?.(condition.path);
  if (state === "unavailable") return null;
  const value = matchesCondition(condition, read);
  if (
    state === "truncated" &&
    !(value &&
      ["contains", "containsAny", "startsWithAny", "startsWith", "exists"]
        .includes(
          condition.operator,
        ))
  ) return null;
  return value;
}
