import type {
  Alias,
  Rule,
  RuleActions,
  RuleCondition,
} from "../domain/models.ts";
import {
  compareRules,
  ruleActions,
  ruleCondition,
  ruleName,
} from "../domain/rules.ts";
import { parseGraph } from "./compile.ts";
import { insertFragment } from "./fragments.ts";
import { localCodeFragment } from "./local-code-template.ts";
import {
  type GraphCondition,
  GraphError,
  type GraphNode,
  type MailAction,
  type MailGraph,
  type PolicyExpression,
} from "./types.ts";

type Unpositioned<T> = T extends GraphNode ? Omit<T, "id" | "x" | "y"> : never;

export interface MigrationDraft {
  graph: MailGraph;
  warnings: string[];
}

function condition(input: RuleCondition): GraphCondition {
  if ("all" in input) return { all: input.all.map(condition) };
  if ("any" in input) return { any: input.any.map(condition) };
  if ("not" in input) return { not: condition(input.not) };
  if (input.field === "hasCode") {
    const present: GraphCondition = {
      path: "email.codes",
      operator: "exists",
      value: null,
    };
    return input.value ? present : { not: present };
  }
  return {
    path: `email.${input.field === "alias" ? "to" : input.field}`,
    operator: input.operator === "equals" ? "textEquals" : input.operator,
    value: input.value.trim().toLowerCase(),
  };
}

function usesCodes(input: RuleCondition): boolean {
  if ("all" in input) return input.all.some(usesCodes);
  if ("any" in input) return input.any.some(usesCodes);
  if ("not" in input) return usesCodes(input.not);
  return input.field === "hasCode";
}

function pure(input: PolicyExpression): PolicyExpression {
  if ("all" in input) return { all: input.all.map(pure) };
  if ("any" in input) return { any: input.any.map(pure) };
  if ("not" in input) return { not: pure(input.not) };
  if (input.policy.success?.actions.length) {
    throw new GraphError(
      `Policy「${input.policy.name}」含有旧动作，请先将动作移到独立 Action 节点后再迁移`,
      "errors.policyHasLegacyActions",
      { policyName: input.policy.name },
    );
  }
  return { policy: { ...structuredClone(input.policy), version: 2 } };
}

function pureNodes(graph: MailGraph): void {
  for (const node of graph.nodes) {
    if (
      node.kind === "evaluate" || node.kind === "filter" ||
      node.kind === "policies"
    ) {
      node.policies = pure(node.policies);
    }
  }
}

function bounded(graph: MailGraph): void {
  if (graph.nodes.length > 32 || graph.edges.length > 64) {
    throw new GraphError(
      "迁移结果超过 32 个节点或 64 条连线，请先合并条件或拆分旧规则后重试；原配置未修改",
      "errors.migrationGraphLimits",
      { maxNodes: 32, maxEdges: 64 },
    );
  }
}

function target(rule: Rule, aliases: Alias[], fallback?: string): string {
  const explicit = ruleActions(rule).forwardTo;
  const applicable = rule.aliasId
    ? aliases.filter((alias) => alias.id === rule.aliasId)
    : aliases.filter((alias) => alias.enabled);
  const targets = explicit ? [explicit] : [
    ...applicable.map((alias) => alias.forwardTo ?? fallback),
    ...(!rule.aliasId ? [fallback] : []),
  ];
  const distinct = [
    ...new Set(targets.map((value) => value?.trim().toLowerCase())),
  ];
  if (
    distinct.length !== 1 || !distinct[0] ||
    !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(distinct[0])
  ) {
    throw new GraphError(
      `规则「${
        ruleName(rule)
      }」的转发目标缺失或因地址而异，请为该规则填写明确的转发目标后重试`,
      "errors.migrationForwardTargetRequired",
      { ruleName: ruleName(rule) },
    );
  }
  return distinct[0];
}

interface State {
  tags: string[];
  retentionDays?: number;
  delivery?: RuleActions["delivery"];
  forwardTo?: string;
}

function actions(state: State): MailAction[] {
  return [
    ...(state.tags.length ? [{ type: "tag" as const, tags: state.tags }] : []),
    ...(state.retentionDays !== undefined
      ? [{ type: "set_retention" as const, days: state.retentionDays }]
      : []),
    ...(state.delivery === "forward"
      ? [{ type: "forward" as const, to: state.forwardTo! }]
      : state.delivery === "keep" || state.delivery === "trash"
      ? [{ type: state.delivery }]
      : [{
        type: "deny" as const,
        reason: state.delivery === "block"
          ? "旧规则拒收"
          : "没有匹配的接收动作",
      }]),
  ];
}

function rulesDraft(
  rules: Rule[],
  aliases: Alias[],
  defaultForwardTo?: string,
  extract = true,
): MigrationDraft {
  const graph: MailGraph = {
    version: 2,
    codeExtraction: "nodes",
    enabled: false,
    nodes: [],
    edges: [],
  };
  const warnings = [
    "草稿默认停用；没有明确接收动作的路径会拒收，不沿用地址的默认处理。",
    "旧规则的判断失败或结果未知时继续下一条；所有投递动作延迟到最终分支执行。",
  ];
  const enabled = rules.filter((rule) => rule.enabled).sort(compareRules);
  for (const rule of enabled) {
    if (rule.aliasId && !aliases.some((alias) => alias.id === rule.aliasId)) {
      throw new GraphError(
        `规则「${ruleName(rule)}」引用的地址已不存在，请修正地址范围后重试`,
        "errors.migrationAliasMissing",
        { ruleName: ruleName(rule) },
      );
    }
  }
  const active = enabled.filter((rule) =>
    !rule.aliasId || aliases.find((alias) => alias.id === rule.aliasId)!.enabled
  );
  const targets = new Map(
    active.filter((rule) => ruleActions(rule).delivery === "forward").map((
      rule,
    ) => [rule.id, target(rule, aliases, defaultForwardTo)]),
  );
  let serial = 0;
  const add = (node: Unpositioned<GraphNode>): string => {
    const id = `migrated_${serial++}`;
    graph.nodes.push(
      {
        ...node,
        id,
        x: (serial % 4) * 260,
        y: Math.floor(serial / 4) * 190,
      } as GraphNode,
    );
    bounded(graph);
    return id;
  };
  const start = add({ kind: "entry", label: "收到邮件" });
  let finish: string | undefined;
  const leaves = new Map<string, string>(), states = new Map<string, string>();
  const leaf = (state: State): string => {
    const key = JSON.stringify(state);
    const existing = leaves.get(key);
    if (existing) return existing;
    const chain = actions(state);
    const id = add({
      kind: "action",
      label: state.delivery === "forward"
        ? "转发并保留"
        : state.delivery === "keep"
        ? "保留"
        : state.delivery === "trash"
        ? "移入垃圾箱"
        : "拒收",
      actions: chain,
    });
    leaves.set(key, id);
    if (!chain.some((action) => action.type === "deny")) {
      finish ??= add({ kind: "finish", label: "完成" });
      graph.edges.push({ from: id, to: finish, port: "next" });
    }
    return id;
  };
  function build(index: number, state: State): string {
    if (index === active.length) return leaf(state);
    const key = `${index}:${JSON.stringify(state)}`;
    const cached = states.get(key);
    if (cached) return cached;
    const rule = active[index], effect = ruleActions(rule);
    let when = condition(ruleCondition(rule));
    if (rule.aliasId) {
      when = {
        all: [{
          path: "email.to",
          operator: "textEquals",
          value: aliases.find((alias) => alias.id === rule.aliasId)!.address
            .trim().toLowerCase(),
        }, when],
      };
    }
    const check = add({
      kind: "evaluate",
      label: ruleName(rule).slice(0, 80),
      policies: {
        policy: {
          version: 2,
          id: `rule_${index}`,
          revision: "migration_v2",
          name: ruleName(rule).slice(0, 80),
          condition: when,
        },
      },
    });
    const branch = add({
      kind: "condition",
      label: "规则通过？",
      path: `nodes.${check}.success`,
      operator: "equals",
      value: true,
      unknown: true,
    });
    graph.edges.push({ from: check, to: branch, port: "next" });
    states.set(key, check);
    const next: State = {
      ...state,
      tags: [
        ...new Set([
          ...state.tags,
          ...(effect.tags ?? []).map((tag) => tag.trim().toLowerCase()),
        ]),
      ],
      ...(effect.retentionDays !== undefined
        ? { retentionDays: effect.retentionDays }
        : {}),
      ...(effect.delivery
        ? {
          delivery: effect.delivery,
          forwardTo: effect.delivery === "forward"
            ? targets.get(rule.id)
            : undefined,
        }
        : {}),
    };
    const yes = (rule.stopProcessing ?? true) || effect.delivery === "block"
      ? leaf(next)
      : build(index + 1, next);
    const no = build(index + 1, state);
    graph.edges.push({ from: branch, to: yes, port: "yes" }, {
      from: branch,
      to: no,
      port: "no",
    }, { from: branch, to: no, port: "unknown" });
    bounded(graph);
    return check;
  }
  let first = build(0, { tags: [] });
  const disabled = aliases.filter((alias) => !alias.enabled);
  if (disabled.length) {
    const check = add({
      kind: "condition",
      label: "地址已停用？",
      path: "email.to",
      operator: "exists",
      value: null,
      condition: {
        any: disabled.map((alias) => ({
          path: "email.to",
          operator: "textEquals",
          value: alias.address.trim().toLowerCase(),
        })),
      },
      unknown: true,
    });
    const reject = leaf({ tags: [] });
    graph.edges.push({ from: check, to: reject, port: "yes" }, {
      from: check,
      to: first,
      port: "no",
    }, { from: check, to: reject, port: "unknown" });
    first = check;
  }
  graph.edges.push({ from: start, to: first, port: "next" });
  let draft = graph;
  if (extract && active.some((rule) => usesCodes(ruleCondition(rule)))) {
    draft = insertFragment(graph, localCodeFragment(), start);
    warnings.push(
      "旧规则依赖验证码结果，已显式加入可编辑的本地提取模板。不会自动调用 AI。",
    );
  }
  pureNodes(draft);
  bounded(draft);
  return { graph: parseGraph(draft), warnings };
}

/** Read-only conversion. Callers must explicitly save and enable the returned draft. */
export function migrateRules(
  rules: Rule[],
  aliases: Alias[],
  defaultForwardTo?: string,
): MigrationDraft {
  return rulesDraft(rules, aliases, defaultForwardTo);
}

/** Convert supported legacy graph shapes without executing or modifying their sources. */
export function migrateGraph(
  source: MailGraph,
  rules: Rule[],
  aliases: Alias[],
  defaultForwardTo?: string,
): MigrationDraft {
  let graph = parseGraph(source);
  graph.enabled = false;
  delete graph.revision;
  if (graph.version === 2) {
    return { graph, warnings: ["已复制为停用草稿，原配置未修改。"] };
  }
  if (graph.nodes.some((node) => node.kind === "apply")) {
    throw new GraphError(
      "旧流程含有 Apply 动作节点，请先把 Policy 动作移到独立 Action 节点后再迁移",
      "errors.migrationLegacyApplyNode",
    );
  }
  // Old v1 graphs extracted codes implicitly. Materialize that behavior in the
  // draft so every operation is visible and can be removed by the owner.
  const implicitExtraction = graph.codeExtraction !== "nodes";
  if (implicitExtraction) {
    graph = insertFragment(
      graph,
      localCodeFragment(),
      graph.nodes.find((node) => node.kind === "entry")!.id,
    );
  }
  for (const node of [...graph.nodes]) {
    if (node.kind === "extract") {
      graph = insertFragment(graph, localCodeFragment(), node.id, true);
    }
  }
  if (graph.nodes.some((node) => node.kind === "rules")) {
    const chain: GraphNode[] = [];
    let node: GraphNode = graph.nodes.find((node) => node.kind === "entry")!;
    while (true) {
      chain.push(node);
      if (node.kind === "finish") break;
      const outgoing = graph.edges.filter((edge) => edge.from === node.id);
      if (outgoing.length !== 1 || outgoing[0].port !== "next") break;
      node = graph.nodes.find((candidate) => candidate.id === outgoing[0].to)!;
    }
    const index = chain.findIndex((node) => node.kind === "rules");
    const prefix = chain.slice(1, index), suffix = chain.slice(index + 1, -1);
    if (
      chain.length !== graph.nodes.length || chain.at(-1)?.kind !== "finish" ||
      index < 0 ||
      prefix.some((node) =>
        !["tokens", "filter", "output", "evaluate"].includes(node.kind)
      ) ||
      suffix.some((node) =>
        node.kind !== "ai" || !node.optional ||
        node.outputMode !== "verification"
      )
    ) {
      throw new GraphError(
        "旧 Rules 节点位于自定义分支中，无法安全自动迁移；请先单独导入旧规则草稿，再手动连接其他节点",
        "errors.migrationBranchedRulesNode",
      );
    }
    const draft = rulesDraft(
      rules,
      aliases,
      defaultForwardTo,
      !prefix.some((node) => node.kind === "output"),
    );
    const migrated = draft.graph,
      start = migrated.nodes.find((node) => node.kind === "entry")!;
    if (
      [...prefix, ...suffix].some((node) =>
        migrated.nodes.some((other) => other.id === node.id)
      )
    ) {
      throw new GraphError(
        "迁移节点 ID 冲突，请重命名旧流程节点后重试",
        "errors.migrationNodeIdConflict",
      );
    }
    if (prefix.length) {
      const first = migrated.edges.find((edge) => edge.from === start.id)!;
      const after = first.to;
      first.to = prefix[0].id;
      migrated.nodes.push(...prefix);
      prefix.forEach((node, i) =>
        migrated.edges.push({
          from: node.id,
          to: prefix[i + 1]?.id ?? after,
          port: "next",
        })
      );
    }
    const finish = migrated.nodes.find((node) => node.kind === "finish");
    if (suffix.length && finish) {
      for (const edge of migrated.edges) {
        if (edge.to === finish.id) edge.to = suffix[0].id;
      }
      migrated.nodes.push(...suffix);
      suffix.forEach((node, i) =>
        migrated.edges.push({
          from: node.id,
          to: suffix[i + 1]?.id ?? finish.id,
          port: "next",
        })
      );
      draft.warnings.push(
        "保留旧流程的可选 AI 补充节点，仅在规则明确接收邮件后运行。",
      );
    } else if (suffix.length) {
      draft.warnings.push(
        "所有迁移路径均拒收，没有可运行 AI 的接收分支；请添加接收动作后再加入 AI 节点。",
      );
    }
    pureNodes(migrated);
    bounded(migrated);
    draft.graph = parseGraph(migrated);
    return draft;
  }
  const warnings = [
    "草稿默认停用；原配置未修改。旧隐式保留已转换成显式 Action。",
    "IF 无法确定结果时进入拒收分支，请在启用前检查该分支。",
  ];
  if (implicitExtraction) {
    warnings.push("旧流程隐式运行的验证码提取已展开为可编辑模板。");
  }
  const used = new Set(graph.nodes.map((node) => node.id));
  let serial = 0;
  const id = () => {
    while (used.has(`migration_${serial}`)) serial++;
    const value = `migration_${serial++}`;
    used.add(value);
    return value;
  };
  let end: string | undefined, rejected: string | undefined;
  const finish = () => {
    if (!end) {
      end = id();
      graph.nodes.push({
        id: end,
        kind: "finish",
        label: "完成",
        x: 300,
        y: 4800,
      });
    }
    return end;
  };
  const deny = () => {
    if (!rejected) {
      rejected = id();
      graph.nodes.push({
        id: rejected,
        kind: "action",
        label: "判断未知：拒收",
        x: 600,
        y: 4800,
        actions: [{ type: "deny", reason: "无法确定收件条件" }],
      });
    }
    return rejected;
  };
  for (const node of [...graph.nodes]) {
    if (node.kind === "delivery" || node.kind === "finish") {
      const chain = node.kind === "delivery"
        ? actions({
          tags: node.tags,
          retentionDays: node.retentionDays,
          delivery: node.action,
          forwardTo: node.forwardTo,
        })
        : [{ type: "keep" as const }];
      graph.nodes[graph.nodes.indexOf(node)] = {
        id: node.id,
        label: node.label,
        x: node.x,
        y: node.y,
        kind: "action",
        actions: chain,
      };
      graph.edges.push({ from: node.id, to: finish(), port: "next" });
    } else if (node.kind === "condition") {
      node.unknown = true;
      graph.edges.push({ from: node.id, to: deny(), port: "unknown" });
    } else if (node.kind === "policies") {
      const branch = id();
      graph.nodes[graph.nodes.indexOf(node)] = {
        ...node,
        kind: "evaluate",
        policies: pure(node.policies),
      };
      graph.nodes.push({
        id: branch,
        label: `${node.label.slice(0, 65)}：分支`,
        kind: "condition",
        x: node.x,
        y: Math.min(4800, node.y + 130),
        path: `nodes.${node.id}.success`,
        operator: "equals",
        value: true,
        unknown: true,
      });
      const failed = graph.edges.find((edge) =>
        edge.from === node.id && edge.port === "failed"
      )!.to;
      for (const edge of graph.edges) {
        if (edge.from === node.id) {
          edge.from = branch;
          edge.port = edge.port === "success" ? "yes" : "no";
        }
      }
      graph.edges.push({ from: node.id, to: branch, port: "next" }, {
        from: branch,
        to: failed,
        port: "unknown",
      });
    }
  }
  graph.version = 2;
  graph.codeExtraction = "nodes";
  pureNodes(graph);
  bounded(graph);
  return { graph: parseGraph(graph), warnings };
}
