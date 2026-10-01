import {
  type AiNode,
  type GraphEdge,
  GraphError,
  type GraphNode,
  type GraphPlan,
  type MailGraph,
} from "./types.ts";
import { actionPaths, parseActionChain } from "./actions.ts";
import { parsePolicyExpression, policyPaths } from "./policies.ts";
import { conditionPaths, parseCondition } from "./conditions.ts";
import type { JsonSchema } from "./schema.ts";
import { safeKey, validateSchema } from "./schema.ts";

import { pathParts } from "./paths.ts";
export { pathParts } from "./paths.ts";
export function parseGraph(input: unknown): MailGraph {
  if (
    JSON.stringify(input)?.length > 64000 || !input || typeof input !== "object"
  ) throw new GraphError("Graph 太大或格式无效", "errors.invalidGraph");
  const g = structuredClone(input) as MailGraph;
  if (
    ![1, 2].includes(g.version) || typeof g.enabled !== "boolean" ||
    (g.codeExtraction !== undefined && g.codeExtraction !== "nodes") ||
    !Array.isArray(g.nodes) || g.nodes.length < 2 || g.nodes.length > 32 ||
    !Array.isArray(g.edges) || g.edges.length > 64
  ) {
    throw new GraphError(
      "Graph 需要 2–32 个节点",
      "errors.graphNodeCount",
      { min: 2, max: 32 },
    );
  }
  if (
    g.revision !== undefined &&
    (typeof g.revision !== "string" || g.revision.length > 64)
  ) throw new GraphError("版本无效", "errors.invalidGraphRevision");
  if (g.nodes.filter((node) => node?.kind === "ai").length > 8) {
    throw new GraphError(
      "一个 Graph 最多包含 8 个 AI 节点",
      "errors.aiNodeLimit",
      { max: 8 },
    );
  }
  g.nodes = g.nodes.map((node) => {
    if (g.version === 2) {
      if (
        ["rules", "policies", "apply", "extract", "delivery"].includes(
          node?.kind,
        )
      ) {
        throw new GraphError(
          "旧处理节点不能用于新流程，请先转换配置",
          "errors.legacyNodeInV2Workflow",
        );
      }
      if (node?.kind === "condition") node.unknown = true;
      if (node?.kind === "evaluate" || node?.kind === "filter") {
        assertPurePolicies(node.policies);
      }
    }
    return parseNode(node);
  });
  if (g.version === 2) g.codeExtraction = "nodes";
  compileGraph(g);
  return g;
}

export function parseNode(input: unknown): GraphNode {
  const n = structuredClone(input) as GraphNode;
  if (
    !n || !safeKey(n.id) || typeof n.label !== "string" ||
    n.label.length > 80 || !Number.isFinite(n.x) || !Number.isFinite(n.y) ||
    n.x < 0 || n.y < 0 || n.x > 5000 || n.y > 5000
  ) throw new GraphError("节点名称或位置无效", "errors.invalidGraphNode");
  if (
    n.preset &&
    (typeof n.preset.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(n.preset.id) ||
      typeof n.preset.revision !== "string" || n.preset.revision.length > 80)
  ) {
    throw new GraphError("节点库版本无效", "errors.invalidNodePresetRevision");
  }
  if (n.kind === "ai") {
    if (
      (n.resultFormat !== undefined && n.resultFormat !== "envelope") ||
      (n.resultFormat === "envelope" &&
        [n.optional, n.onlyWhenMissingCodes, n.outputMode].some((v) =>
          v !== undefined
        )) ||
      (n.optional !== undefined && typeof n.optional !== "boolean") ||
      (n.onlyWhenMissingCodes !== undefined &&
        typeof n.onlyWhenMissingCodes !== "boolean") ||
      (n.outputMode !== undefined && n.outputMode !== "verification")
    ) {
      throw new GraphError(
        "AI 执行选项无效",
        "errors.invalidAiExecutionOptions",
      );
    }
    if (
      typeof n.prompt !== "string" || !n.prompt.trim() ||
      n.prompt.length > 6000 || typeof n.batchGroup !== "string" ||
      n.batchGroup.length > 40 || !n.inputs || typeof n.inputs !== "object" ||
      Array.isArray(n.inputs) || Object.keys(n.inputs).length > 16
    ) {
      throw new GraphError(
        "AI 节点配置无效",
        "errors.invalidAiNodeConfiguration",
      );
    }
    for (const [key, path] of Object.entries(n.inputs)) {
      if (!safeKey(key) || typeof path !== "string") {
        throw new GraphError("AI 输入映射无效", "errors.invalidAiInputMapping");
      }
      pathParts(path);
    }
    n.schema = validateSchema(n.schema);
    if (n.schema.type !== "object") {
      throw new GraphError(
        "AI 输出 Schema 顶层必须是 object",
        "errors.aiOutputSchemaMustBeObject",
      );
    }
  } else if (n.kind === "action" || n.kind === "finish") {
    if (n.kind === "action" || n.actions !== undefined) {
      n.actions =
        n.kind === "finish" && Array.isArray(n.actions) && !n.actions.length
          ? []
          : parseActionChain(n.actions);
    }
  } else if (n.kind === "match") {
    pathParts(n.input);
    if (
      !Array.isArray(n.cases) || !n.cases.length || n.cases.length > 8 ||
      n.cases.some((c) =>
        !c || !safeKey(c.id) || typeof c.label !== "string" ||
        c.label.length > 80 ||
        !(c.value === null || typeof c.value === "boolean" ||
          typeof c.value === "number" && Number.isFinite(c.value) ||
          typeof c.value === "string" && c.value.length <= 1000)
      ) ||
      new Set(n.cases.map((c) => c.id)).size !== n.cases.length ||
      new Set(n.cases.map((c) => JSON.stringify(c.value))).size !==
        n.cases.length
    ) {
      throw new GraphError(
        "Match 需要 1–8 个值不重复的分支",
        "errors.invalidMatchCases",
        { min: 1, max: 8 },
      );
    }
  } else if (n.kind === "condition") {
    if (n.unknown !== undefined && n.unknown !== true) {
      throw new GraphError(
        "IF 的 unknown 配置无效",
        "errors.invalidConditionUnknownOption",
      );
    }
    const c = parseCondition(
      n.condition ?? { path: n.path, operator: n.operator, value: n.value },
    );
    conditionPaths(c).forEach((path) => pathParts(path));
    if (n.condition) n.condition = c;
  } else if (n.kind === "evaluate" || n.kind === "filter") {
    n.policies = parsePolicyExpression(n.policies);
    policyPaths(n.policies).forEach((path) =>
      pathParts(path, n.kind === "filter")
    );
    if (n.kind === "filter") {
      if (typeof n.input !== "string") {
        throw new GraphError(
          "请配置候选数组输入",
          "errors.candidateArrayInputRequired",
        );
      }
      pathParts(n.input);
    }
  } else if (n.kind === "policies") {
    n.policies = parsePolicyExpression(n.policies);
    policyPaths(n.policies).forEach((path) => pathParts(path));
  } else if (n.kind === "apply") {
    if (typeof n.input !== "string") {
      throw new GraphError(
        "请配置 Policy 动作来源",
        "errors.policyActionSourceRequired",
      );
    }
    pathParts(n.input);
  } else if (n.kind === "tokens") {
    if (
      !Array.isArray(n.sources) || !n.sources.length || n.sources.length > 4 ||
      n.sources.some((v) => typeof v !== "string") ||
      !Array.isArray(n.formats) || !n.formats.length || n.formats.length > 4 ||
      n.formats.some((f) =>
        !f || !["digits", "mixed"].includes(f.characters) ||
        !Number.isInteger(f.min) || !Number.isInteger(f.max) || f.min < 1 ||
        f.max > 32 || f.min > f.max ||
        f.groupDigits !== undefined && typeof f.groupDigits !== "boolean"
      ) ||
      !Number.isInteger(n.contextBefore) || !Number.isInteger(n.contextAfter) ||
      n.contextBefore < 1 || n.contextBefore > 200 || n.contextAfter < 1 ||
      n.contextAfter > 200 || typeof n.normalizeContext !== "boolean"
    ) {
      throw new GraphError(
        "候选提取配置无效",
        "errors.invalidTokenExtractionConfiguration",
      );
    }
    n.sources.forEach((path) => pathParts(path));
  } else if (n.kind === "output") {
    if (
      typeof n.input !== "string" || !Number.isInteger(n.limit) ||
      n.limit < 1 || n.limit > 3
    ) {
      throw new GraphError(
        "验证码输出配置无效（最多 3 项）",
        "errors.invalidCodeOutputConfiguration",
        { max: 3 },
      );
    }
    pathParts(n.input);
  } else if (n.kind === "delivery") {
    if (
      !["keep", "trash", "forward"].includes(n.action) ||
      typeof n.forwardTo !== "string" || n.forwardTo.length > 254 ||
      n.action === "forward" &&
        !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(n.forwardTo) ||
      !Array.isArray(n.tags) || n.tags.length > 10 || n.tags.some((tag) =>
        typeof tag !== "string" || tag.length > 80 || !tag.trim()
      ) ||
      n.retentionDays !== undefined &&
        (!Number.isInteger(n.retentionDays) || n.retentionDays < 1 ||
          n.retentionDays > 3650)
    ) {
      throw new GraphError(
        "处理节点的转发地址、标签或保留时间无效",
        "errors.invalidDeliveryNodeConfiguration",
      );
    }
  } else if (!["entry", "extract", "rules", "finish"].includes(n.kind)) {
    throw new GraphError("不支持的节点类型", "errors.unsupportedNodeType");
  }
  return n;
}

export function ports(node: GraphNode): GraphEdge["port"][] {
  return node.kind === "action" && node.actions.some((a) => a.type === "deny")
    ? []
    : node.kind === "delivery" || node.kind === "finish" ||
        node.kind === "apply"
    ? []
    : node.kind === "policies"
    ? ["success", "failed"]
    : node.kind === "match"
    ? [...node.cases.map((c) => `case:${c.id}` as const), "default"]
    : node.kind === "condition"
    ? node.unknown ? ["yes", "no", "unknown"] : ["yes", "no"]
    : ["next"];
}

export function compileGraph(graph: MailGraph): GraphPlan {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const entries = graph.nodes.filter((n) => n.kind === "entry");
  if (nodes.size !== graph.nodes.length || entries.length !== 1) {
    throw new GraphError(
      "需要且只能有一个入口，节点 ID 不能重复",
      "errors.invalidGraphEntryOrNodeIds",
    );
  }
  for (const e of graph.edges) {
    if (
      !e || !nodes.has(e.from) || !nodes.has(e.to) ||
      !ports(nodes.get(e.from)!).includes(e.port) || e.to === entries[0].id
    ) throw new GraphError("连线的节点或出口无效", "errors.invalidGraphEdge");
  }
  for (const n of graph.nodes) {
    for (const port of ports(n)) {
      if (
        graph.edges.filter((e) => e.from === n.id && e.port === port).length !==
          1
      ) {
        throw new GraphError(
          `${n.label}：每个出口需要且只能有一条连线`,
          "errors.graphPortRequiresSingleEdge",
          { nodeLabel: n.label },
        );
      }
    }
  }
  const visited = new Set<string>(),
    visiting = new Set<string>(),
    order: string[] = [];
  function visit(id: string) {
    if (visiting.has(id)) {
      throw new GraphError(
        "Graph 不能包含循环",
        "errors.graphCannotContainCycles",
      );
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const e of graph.edges.filter((e) => e.from === id)) visit(e.to);
    visiting.delete(id);
    visited.add(id);
    order.unshift(id);
  }
  visit(entries[0].id);
  const reachable = new Set(visited), reachableOrder = [...order];
  for (const n of graph.nodes) visit(n.id); // Reject even disconnected cycles.
  const dominators = new Map<string, Set<string>>();
  const ancestors = new Map<string, Set<string>>();
  for (const id of reachableOrder) {
    const parents = graph.edges.filter((e) =>
      e.to === id && reachable.has(e.from)
    ).map((e) => e.from);
    const common = parents.length
      ? new Set(dominators.get(parents[0])!)
      : new Set<string>();
    for (const parent of parents.slice(1)) {
      for (
        const ancestor of common
      ) if (!dominators.get(parent)!.has(ancestor)) common.delete(ancestor);
    }
    const upstream = new Set(
      parents.flatMap((p) => [p, ...ancestors.get(p) ?? []]),
    );
    ancestors.set(id, upstream);
    const node = nodes.get(id)!;
    const paths = node.kind === "action" || node.kind === "finish"
      ? actionPaths(node.actions ?? [])
      : node.kind === "ai"
      ? Object.values(node.inputs)
      : node.kind === "condition"
      ? conditionPaths(
        node.condition ??
          { path: node.path, operator: node.operator, value: node.value },
      )
      : node.kind === "policies"
      ? policyPaths(node.policies)
      : node.kind === "evaluate"
      ? policyPaths(node.policies)
      : node.kind === "filter"
      ? [node.input, ...(policyPaths(node.policies))]
      : node.kind === "output" || node.kind === "apply" || node.kind === "match"
      ? [node.input]
      : node.kind === "tokens"
      ? node.sources
      : [];
    for (const path of paths) {
      const parts = pathParts(path, node.kind === "filter");
      if (!["nodes", "current"].includes(parts[0])) continue;
      const optional = path.includes("?.");
      const sourceIds = parts[0] === "current" ? parents : [parts[1]];
      if (!sourceIds.length) {
        throw new GraphError(
          `${node.label}：没有上游输出`,
          "errors.nodeHasNoUpstreamOutput",
          { nodeLabel: node.label },
        );
      }
      let validSources = 0;
      for (const sourceId of sourceIds) {
        const source = nodes.get(sourceId);
        if (
          !source || !upstream.has(sourceId) ||
          !optional && parts[0] === "nodes" && !common.has(sourceId)
        ) {
          throw new GraphError(
            `${node.label}：输入 ${path} 在此路径不可用`,
            "errors.nodeInputUnavailableOnPath",
            { nodeLabel: node.label, path },
          );
        }
        let schema = outputSchema(source);
        if (!schema) {
          if (optional && parts[0] === "current") continue;
          throw new GraphError(
            `${node.label}：输入 ${path} 没有输出`,
            "errors.nodeInputHasNoOutput",
            { nodeLabel: node.label, path },
          );
        }
        if (
          !optional && source.kind === "ai" &&
          (source.optional || source.onlyWhenMissingCodes)
        ) {
          throw new GraphError(
            `${node.label}：不能必填引用可能跳过的 AI 输出，请使用 ?. 和默认值`,
            "errors.requiredReferenceToOptionalAiOutput",
            { nodeLabel: node.label },
          );
        }
        if (
          !optional && source.kind === "ai" && source.resultFormat &&
          ["data", "error"].includes(parts[2]) && parts.length > 3
        ) {
          throw new GraphError(
            `${node.label}：AI 的 data / error 可能为 null，请使用 ?. 并先判断 success`,
            "errors.requiredReferenceToNullableAiEnvelope",
            { nodeLabel: node.label },
          );
        }
        for (const key of parts.slice(2)) {
          schema = schema?.type === "object"
            ? schema.properties?.[key]
            : undefined;
        }
        if (!schema) {
          if (optional && parts[0] === "current") continue;
          throw new GraphError(
            `${node.label}：输出字段 ${path} 不存在`,
            "errors.nodeOutputFieldMissing",
            { nodeLabel: node.label, path },
          );
        }
        validSources++;
      }
      if (!validSources) {
        throw new GraphError(
          `${node.label}：输出字段 ${path} 不存在`,
          "errors.nodeOutputFieldMissing",
          { nodeLabel: node.label, path },
        );
      }
    }
    if (
      (node.kind === "rules" || node.kind === "apply") &&
      [...upstream].some((sourceId) => {
        const source = nodes.get(sourceId)!;
        return source.kind === "action" &&
          source.actions.some((action) =>
            ["forward", "reply"].includes(action.type)
          );
      })
    ) {
      throw new GraphError(
        "转发或回复后不能执行可能拒收邮件的节点",
        "errors.rejectingNodeAfterIrreversibleAction",
      );
    }
    if (
      (node.kind === "action" || node.kind === "finish") &&
      node.actions?.some((a) => a.type === "deny")
    ) {
      if (
        [...upstream].some((id) => {
          const parent = nodes.get(id)!;
          return parent.kind === "action" &&
              parent.actions.some((a) =>
                ["forward", "reply"].includes(a.type)
              ) ||
            parent.kind === "delivery" && parent.action === "forward" ||
            ["rules", "apply"].includes(parent.kind);
        })
      ) {
        throw new GraphError(
          "同一路径不能先转发再拒收，也不能回复后拒收",
          "errors.denyAfterIrreversibleAction",
        );
      }
    }
    if (
      (node.kind === "action" || node.kind === "finish") &&
      node.actions?.some((a) => a.type === "reply") &&
      [...upstream].some((id) => {
        const parent = nodes.get(id)!;
        return parent.kind === "action" &&
          parent.actions.some((a) => a.type === "reply");
      })
    ) {
      throw new GraphError(
        "同一路径每封来信最多回复一次",
        "errors.replyPathLimit",
      );
    }
    if (node.kind === "apply") {
      const parts = pathParts(node.input);
      if (
        parts.length !== 3 || parts[0] !== "nodes" || parts[2] !== "actions" ||
        nodes.get(parts[1])?.kind !== "policies"
      ) {
        throw new GraphError(
          "执行动作只能读取上游 Policy 组合节点的 actions",
          "errors.invalidPolicyActionSource",
        );
      }
    }
    if (
      node.kind === "delivery" || node.kind === "rules" || node.kind === "apply"
    ) {
      const seen = new Set<string>();
      const visitParents = (child: string): boolean =>
        graph.edges.filter((e) => e.to === child && reachable.has(e.from)).some(
          (e) => {
            if (seen.has(e.from)) return false;
            seen.add(e.from);
            const parent = nodes.get(e.from)!;
            return parent.kind === "delivery" || parent.kind === "rules" ||
              parent.kind === "apply" ||
              visitParents(parent.id);
          },
        );
      if (visitParents(id)) {
        throw new GraphError(
          "同一路径只能有一个邮件处理或收件规则节点",
          "errors.duplicateDeliveryNodeOnPath",
        );
      }
    }
    common.add(id);
    dominators.set(id, common);
  }
  const batches: string[][] = [],
    assigned = new Set<string>(),
    notes: string[] = [];
  for (const id of reachableOrder) {
    const first = nodes.get(id)!;
    if (first.kind !== "ai" || assigned.has(id) || !batchable(first)) continue;
    const batch = [id];
    let current: AiNode = first;
    while (batch.length < 4) {
      const next = nodes.get(
        graph.edges.find((e) => e.from === current.id)!.to,
      )!;
      if (
        next.kind !== "ai" || !batchable(next) ||
        next.resultFormat !== first.resultFormat
      ) break;
      if (!first.batchGroup || next.batchGroup !== first.batchGroup) {
        notes.push(`${current.label} → ${next.label}：未设置相同合并组`);
        break;
      }
      if (
        graph.edges.filter((e) => e.to === next.id && reachable.has(e.from))
            .length !== 1 ||
        Object.values(next.inputs).some((path) => {
          const parts = pathParts(path);
          return parts[0] === "current" ||
            parts[0] === "nodes" && batch.includes(parts[1]);
        })
      ) {
        notes.push(
          `${current.label} → ${next.label}：有输出依赖或其他入边，保持独立`,
        );
        break;
      }
      batch.push(next.id);
      current = next;
    }
    if (batch.length > 1) {
      batches.push(batch);
      batch.forEach((member) => assigned.add(member));
    }
  }
  return {
    order: reachableOrder,
    batches,
    notes,
    unreachable: graph.nodes.filter((n) => !reachable.has(n.id)).map((n) =>
      n.id
    ),
  };
}

function batchable(node: AiNode) {
  return !node.optional && !node.onlyWhenMissingCodes && !node.outputMode &&
    !Object.values(node.inputs).some((path) =>
      pathParts(path)[0] === "current"
    );
}
export function outputSchema(node: GraphNode): JsonSchema | undefined {
  if (node.kind === "ai") {
    return node.resultFormat
      ? {
        type: "object",
        additionalProperties: false,
        required: ["success", "data", "error"],
        properties: {
          success: { type: "boolean" },
          // Reference shapes on success / failure. Required nested reads are rejected above.
          data: node.schema,
          error: {
            type: "object",
            additionalProperties: false,
            required: ["reason", "message"],
            properties: {
              reason: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      }
      : node.schema;
  }
  const properties: Record<string, JsonSchema> | undefined =
    node.kind === "action"
      ? {
        action: { type: ["string", "null"] },
        tags: { type: "array", items: { type: "string" } },
        retentionDays: { type: ["integer", "null"] },
        forwardTo: { type: ["string", "null"] },
      }
      : node.kind === "extract" || node.kind === "output"
      ? {
        codes: { type: "array", items: { type: "string" } },
        hasCode: { type: "boolean" },
      }
      : node.kind === "policies" || node.kind === "evaluate"
      ? {
        status: { type: "string", enum: ["success", "failed", "unknown"] },
        success: { type: ["boolean", "null"] },
        matched: { type: "boolean" },
        indeterminate: { type: "boolean" },
        actions: {
          type: "array",
          items: {
            type: "object",
            properties: {},
            additionalProperties: false,
            required: [],
          },
        },
        branches: { type: "array", items: { type: "string" } },
        reasons: { type: "array", items: { type: "string" } },
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      }
      : node.kind === "tokens" || node.kind === "filter"
      ? {
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["value", "raw", "before", "after", "standalone"],
            properties: {
              value: { type: "string" },
              raw: { type: "string" },
              before: { type: "string" },
              after: { type: "string" },
              standalone: { type: "boolean" },
            },
          },
        },
        truncated: { type: "boolean" },
      }
      : node.kind === "rules"
      ? {
        action: { type: "string" },
        forwardTo: { type: ["string", "null"] },
        tags: { type: "array", items: { type: "string" } },
        retentionDays: { type: "integer" },
      }
      : undefined;
  return properties
    ? {
      type: "object",
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    }
    : undefined;
}

function assertPurePolicies(value: unknown): void {
  const expression = parsePolicyExpression(value);
  function check(p: import("./types.ts").PolicyExpression) {
    if ("policy" in p) {
      if (p.policy.success?.actions.length) {
        throw new GraphError(
          "规则包含旧投递动作，请先转换为独立 Action",
          "errors.legacyPolicyDeliveryAction",
        );
      }
    } else if ("not" in p) check(p.not);
    else ("all" in p ? p.all : p.any).forEach(check);
  }
  check(expression);
}
