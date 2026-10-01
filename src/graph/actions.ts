import type { RuleActions } from "../domain/models.ts";
import { pathParts } from "./paths.ts";
import {
  type ActionBinding,
  GraphError,
  type GraphRun,
  type JsonValue,
  type MailAction,
} from "./types.ts";

export const actionLabels: Record<MailAction["type"], string> = {
  tag: "添加标签",
  set_retention: "设置保留时间",
  keep: "保留",
  trash: "移入垃圾箱",
  forward: "原样转发",
  reply: "回复发件人",
  deny: "拒收并结束",
};
export const actionField = (action: MailAction): string | undefined =>
  ({
    tag: "tags",
    set_retention: "days",
    forward: "to",
    reply: "text",
    deny: "reason",
    keep: "retentionDays",
    trash: undefined,
  })[action.type];
export function isBinding(value: unknown): value is ActionBinding {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    "ref" in value;
}
function validateValue(type: MailAction["type"], value: unknown): JsonValue {
  if (type === "tag") {
    const tags = typeof value === "string" ? [value] : value;
    if (
      !Array.isArray(tags) || tags.length > 10 ||
      tags.some((v) => typeof v !== "string" || !v.trim() || v.length > 64)
    ) {
      throw new GraphError(
        "标签需要文字或最多 10 项的文字数组",
        "errors.invalidActionTags",
        { max: 10 },
      );
    }
    return [...new Set(tags.map((v: string) => v.trim().toLowerCase()))];
  }
  if (type === "set_retention" || type === "keep") {
    if (
      typeof value !== "number" || !Number.isInteger(value) || value < 1 ||
      value > 3650
    ) {
      throw new GraphError(
        "保留时间需要 1–3650 天",
        "errors.invalidRetentionDays",
        { min: 1, max: 3650 },
      );
    }
    return value;
  }
  if (type === "reply") {
    if (
      typeof value !== "string" || !value.trim() || value.length > 12000 ||
      value.includes("\0")
    ) {
      throw new GraphError(
        "回复正文需要 1–12,000 字符",
        "errors.invalidReplyBody",
        { min: 1, max: 12000 },
      );
    }
    return value;
  }
  if (type === "forward") {
    if (
      typeof value !== "string" || value.length > 254 ||
      !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value)
    ) {
      throw new GraphError(
        "转发目标需要有效邮箱地址",
        "errors.invalidForwardAddress",
      );
    }
    return value.toLowerCase();
  }
  if (
    typeof value !== "string" || !value.trim() || value.length > 200 ||
    /[\r\n]/.test(value)
  ) {
    throw new GraphError(
      "拒收原因需要 1–200 字符，不能换行",
      "errors.invalidRejectionReason",
      { min: 1, max: 200 },
    );
  }
  return value.trim();
}
export function parseActionChain(input: unknown): MailAction[] {
  if (!Array.isArray(input) || !input.length || input.length > 16) {
    throw new GraphError(
      "动作链需要 1–16 个动作",
      "errors.actionChainLength",
      { min: 1, max: 16 },
    );
  }
  const actions = structuredClone(input) as MailAction[];
  for (const action of actions) {
    if (!action || !Object.hasOwn(actionLabels, action.type)) {
      throw new GraphError("不支持的动作", "errors.unsupportedAction");
    }
    const field = actionField(action);
    if (Object.keys(action).some((k) => k !== "type" && k !== field)) {
      throw new GraphError("动作参数无效", "errors.invalidActionParameters");
    }
    if (!field) continue;
    const value = (action as unknown as Record<string, unknown>)[field];
    if (action.type === "keep" && value === undefined) continue;
    if (isBinding(value)) {
      if (
        typeof value.ref !== "string" ||
        Object.keys(value).some((k) => !["ref", "fallback"].includes(k))
      ) {
        throw new GraphError(
          "动作输入引用无效",
          "errors.invalidActionBinding",
        );
      }
      pathParts(value.ref);
      if (Object.hasOwn(value, "fallback")) {
        validateValue(action.type, value.fallback);
      }
    } else validateValue(action.type, value);
  }
  const deny = actions.findIndex((a) => a.type === "deny");
  if (
    deny >= 0 &&
    (deny !== actions.length - 1 ||
      actions.some((a) => ["forward", "reply"].includes(a.type)))
  ) {
    throw new GraphError(
      "拒收必须是最后一个动作，且不能与转发或回复组合",
      "errors.invalidDenyActionOrder",
    );
  }
  if (actions.filter((a) => a.type === "reply").length > 1) {
    throw new GraphError("每封来信最多回复一次", "errors.replyLimit");
  }
  return actions;
}
export function actionPaths(actions: MailAction[]): string[] {
  return actions.flatMap((action) =>
    Object.values(action).filter(isBinding).map((v) => v.ref)
  );
}
export function ruleActions(action: RuleActions): MailAction[] {
  return [
    ...(action.tags?.length
      ? [{ type: "tag" as const, tags: action.tags }]
      : []),
    ...(action.retentionDays !== undefined
      ? [{ type: "set_retention" as const, days: action.retentionDays }]
      : []),
    ...(action.delivery === "block"
      ? [{ type: "deny" as const, reason: "Blocked by rule" }]
      : action.delivery === "forward"
      ? action.forwardTo
        ? [{ type: "forward" as const, to: action.forwardTo }]
        : [{ type: "keep" as const }]
      : action.delivery
      ? [{ type: action.delivery }]
      : []),
  ];
}

/** Preflight a whole chain before effects; completed effects survive a later failure. */
export async function executeActions(actions: MailAction[], context: {
  run: GraphRun;
  nodeId: string;
  read: (path: string) => JsonValue;
  forward?: (to: string) => Promise<unknown>;
  reply?: (text: string) => Promise<unknown>;
  reject?: (reason: string) => void;
  checkpoint?: (run: GraphRun, beforeEffect?: boolean) => Promise<void>;
}) {
  const { run } = context;
  const plan = parseActionChain(actions).map((action) => {
    const field = actionField(action);
    if (!field) return { action, value: null };
    const input = (action as unknown as Record<string, unknown>)[field];
    if (action.type === "keep" && input === undefined) {
      return { action, value: null };
    }
    const value = isBinding(input)
      ? context.read(input.ref) ?? input.fallback
      : input;
    return { action, value: validateValue(action.type, value) };
  });
  const targets = new Set([
    ...(run.forwardTo ? [run.forwardTo] : []),
    ...plan.filter((p) => p.action.type === "forward").map((p) => p.value),
  ]);
  if (
    targets.size > 1 ||
    targets.size && plan.some((p) => p.action.type === "deny")
  ) {
    throw new GraphError(
      "同一路径不能转发到不同目标或同时拒收",
      "errors.conflictingForwardActions",
    );
  }
  const replies =
    (run.actionResults ?? []).filter((a) => a.type === "reply").length +
    plan.filter((p) => p.action.type === "reply").length;
  if (replies > 1) {
    throw new GraphError("每封来信最多回复一次", "errors.replyLimit");
  }
  if (replies && plan.some((p) => p.action.type === "deny")) {
    throw new GraphError("回复后不能拒收", "errors.replyThenDeny");
  }
  const tags = new Set([
    ...run.tags,
    ...plan.filter((p) => p.action.type === "tag").flatMap((p) =>
      p.value as string[]
    ),
  ]);
  if (tags.size > 10) {
    throw new GraphError(
      "合并后最多 10 个标签",
      "errors.mergedTagLimit",
      { max: 10 },
    );
  }
  for (const { action, value } of plan) {
    switch (action.type) {
      case "tag":
        run.tags = [...new Set([...run.tags, ...value as string[]])];
        break;
      case "set_retention":
        run.retentionDays = value as number;
        break;
      case "keep":
        run.action = "keep";
        if (value !== null) run.retentionDays = value as number;
        break;
      case "reply":
        if (!run.trial) {
          if (!context.reply) {
            throw new GraphError(
              "当前环境不能回复邮件",
              "errors.replyUnavailable",
            );
          }
          await context.checkpoint?.(structuredClone(run), true);
          try {
            await context.reply(value as string);
          } catch (error) {
            throw new GraphError(
              error instanceof GraphError
                ? error.message
                : "回复未确认，请检查 Cloudflare 投递记录；原邮件已保留，不会自动重试",
              error instanceof GraphError
                ? error.code
                : "errors.replyUnconfirmed",
              error instanceof GraphError ? error.params : undefined,
            );
          }
        }
        run.action ??= "keep";
        break;
      case "trash":
        run.action = "trash";
        break;
      case "deny":
        if (!run.trial) {
          if (!context.reject) {
            throw new GraphError(
              "当前环境不能拒收邮件",
              "errors.rejectUnavailable",
            );
          }
          await context.checkpoint?.(structuredClone(run), true);
          context.reject(value as string);
        }
        run.action = "block";
        run.status = "complete";
        break;
      case "forward":
        if (run.forwardTo !== value) {
          if (!run.trial) {
            if (!context.forward) {
              throw new GraphError(
                "当前环境不能转发原邮件",
                "errors.forwardUnavailable",
              );
            }
            await context.checkpoint?.(structuredClone(run), true);
            try {
              await context.forward(value as string);
            } catch {
              throw new GraphError(
                "转发未确认，请检查 Cloudflare 投递记录和已验证目标地址；原邮件已保留",
                "errors.forwardUnconfirmed",
              );
            }
          }
          run.forwardTo = value as string;
        }
        run.action = "forward";
        break;
    }
    (run.actionResults ??= []).push({
      nodeId: context.nodeId,
      type: action.type,
      status: run.trial ? "simulated" : "complete",
      ...(value !== null ? { value } : {}),
    });
    if (action.type === "forward" || action.type === "reply") {
      await context.checkpoint?.(structuredClone(run), true);
    }
  }
}
