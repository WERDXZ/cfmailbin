import { compileGraph, parseGraph } from "./compile.ts";
import { actionField, isBinding } from "./actions.ts";
import { pathParts } from "./paths.ts";
import {
  type GraphCondition,
  GraphError,
  type GraphFragment,
  type GraphNode,
  type MailAction,
  type MailGraph,
  type PolicyExpression,
} from "./types.ts";

export function parseFragment(input: unknown): GraphFragment {
  const f = structuredClone(input) as GraphFragment;
  if (
    !f || !Array.isArray(f.nodes) || f.nodes.length < 1 ||
    f.nodes.length > 16 ||
    !Array.isArray(f.edges) || !f.nodes.some((n) => n?.id === f.entry) ||
    !f.nodes.some((n) => n?.id === f.exit) ||
    f.nodes.some((n) =>
      !n ||
      ["entry", "finish", "delivery", "rules", "extract", "apply"].includes(
        n.kind,
      ) || ["templateStart", "templateEnd"].includes(n.id)
    )
  ) {
    throw new GraphError(
      "模板需要 1–16 个判断或数据处理节点、一个入口和一个出口",
      "errors.invalidGraphFragment",
      { minNodes: 1, maxNodes: 16 },
    );
  }
  const graph = parseGraph({
    version: 1,
    enabled: false,
    nodes: [
      { id: "templateStart", kind: "entry", label: "start", x: 0, y: 0 },
      ...f.nodes,
      { id: "templateEnd", kind: "finish", label: "end", x: 0, y: 0 },
    ],
    edges: [{ from: "templateStart", to: f.entry, port: "next" }, ...f.edges, {
      from: f.exit,
      to: "templateEnd",
      port: "next",
    }],
  });
  if (compileGraph(graph).unreachable.length) {
    throw new GraphError(
      "模板不能包含不可达节点",
      "errors.fragmentHasUnreachableNodes",
    );
  }
  return { ...f, nodes: graph.nodes.slice(1, -1) };
}

function remapNode(node: GraphNode, ids: Map<string, string>): GraphNode {
  const path = (value: string) => {
    if (!value.startsWith("nodes.") && !value.startsWith("nodes?.")) {
      return value;
    }
    const parts = pathParts(value);
    if (parts[0] !== "nodes" || !ids.has(parts[1])) return value;
    const prefix = value.startsWith("nodes?.") ? "nodes?." : "nodes.";
    return `${prefix}${ids.get(parts[1])}${
      value.slice(prefix.length + parts[1].length)
    }`;
  };
  const condition = (c: GraphCondition): GraphCondition =>
    "all" in c
      ? { all: c.all.map(condition) }
      : "any" in c
      ? { any: c.any.map(condition) }
      : "not" in c
      ? { not: condition(c.not) }
      : { ...c, path: path(c.path) };
  const policies = (p: PolicyExpression): PolicyExpression =>
    "policy" in p
      ? { policy: { ...p.policy, condition: condition(p.policy.condition) } }
      : "all" in p
      ? { all: p.all.map(policies) }
      : "any" in p
      ? { any: p.any.map(policies) }
      : { not: policies(p.not) };
  const next = structuredClone(node);
  next.id = ids.get(node.id)!;
  delete next.preset;
  if (next.kind === "ai") {
    next.inputs = Object.fromEntries(
      Object.entries(next.inputs).map(([key, value]) => [key, path(value)]),
    );
  }
  if (next.kind === "action") {
    next.actions = next.actions.map((action) => {
      const field = actionField(action);
      if (!field) return action;
      const input = (action as unknown as Record<string, unknown>)[field];
      if (!isBinding(input)) return action;
      return {
        ...action,
        [field]: { ...input, ref: path(input.ref) },
      } as MailAction;
    });
  }
  if (next.kind === "condition") {
    if (typeof next.path === "string") next.path = path(next.path);
    if (next.condition) next.condition = condition(next.condition);
  }
  if (
    next.kind === "evaluate" || next.kind === "filter" ||
    next.kind === "policies"
  ) next.policies = policies(next.policies);
  if (
    next.kind === "filter" || next.kind === "output" || next.kind === "match"
  ) {
    next.input = path(next.input);
  }
  if (next.kind === "tokens") next.sources = next.sources.map(path);
  return next;
}

/** Materialize a template as ordinary editable graph nodes, never a hidden callback. */
export function insertFragment(
  graph: MailGraph,
  input: GraphFragment,
  anchorId: string,
  replace = false,
): MailGraph {
  const fragment = parseFragment(input);
  const anchor = graph.nodes.find((node) => node.id === anchorId);
  const outgoing = graph.edges.find((edge) =>
    edge.from === anchorId && edge.port === "next"
  );
  if (!anchor || !outgoing || replace && anchor.kind !== "extract") {
    throw new GraphError(
      "请选择有下一步的节点插入模板",
      "errors.invalidFragmentInsertionPoint",
    );
  }
  const used = new Set(graph.nodes.map((node) => node.id));
  const ids = new Map<string, string>();
  let counter = 1;
  for (const node of fragment.nodes) {
    while (used.has(`step${counter}`)) counter++;
    const id = replace && node.id === fragment.exit
      ? anchorId
      : `step${counter++}`;
    ids.set(node.id, id);
    used.add(id);
  }
  const startY = anchor.y + (replace ? 0 : 170);
  const nodes = graph.nodes.filter((node) => !replace || node.id !== anchorId)
    .map((node) => ({
      ...node,
      y: node.y > anchor.y
        ? Math.min(
          4800,
          node.y + 170 * (fragment.nodes.length - Number(replace)),
        )
        : node.y,
    }));
  const internal = fragment.nodes.map((node, i) => ({
    ...remapNode(node, ids),
    x: anchor.x,
    y: Math.min(4800, startY + 170 * i),
  }));
  const edges = graph.edges.filter((edge) => edge !== outgoing).map((edge) =>
    replace && edge.to === anchorId
      ? { ...edge, to: ids.get(fragment.entry)! }
      : edge
  );
  if (!replace) {
    edges.push({ from: anchorId, to: ids.get(fragment.entry)!, port: "next" });
  }
  edges.push(
    ...fragment.edges.map((edge) => ({
      ...edge,
      from: ids.get(edge.from)!,
      to: ids.get(edge.to)!,
    })),
    { from: ids.get(fragment.exit)!, to: outgoing.to, port: "next" },
  );
  return parseGraph({ ...graph, nodes: [...nodes, ...internal], edges });
}
