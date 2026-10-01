import { assert, assertEquals, assertThrows } from "@std/assert";
import type {
  Alias,
  Rule,
  RuleActions,
  RuleCondition,
} from "../src/domain/models.ts";
import { makeRule } from "../src/domain/rules.ts";
import { verificationSchema } from "../src/email/analysis.ts";
import { migrateGraph, migrateRules } from "../src/graph/migrate.ts";
import { runGraph } from "../src/graph/run.ts";
import type { GraphNode, JsonValue, MailGraph } from "../src/graph/types.ts";

const alias: Alias = {
  id: "alias",
  address: "test@example.com",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  enabled: true,
  defaultAction: "forward",
  forwardTo: "owner@example.net",
  retentionDays: 7,
  tags: [],
};

function rule(
  condition: RuleCondition,
  actions: RuleActions,
  priority = 0,
  stop = true,
): Rule {
  return makeRule({
    name: `rule ${priority}`,
    condition,
    actions,
    priority,
    stopProcessing: stop,
  }, priority);
}

const any = { field: "subject", operator: "contains", value: "" } as const;

async function execute(
  graph: MailGraph,
  email: Record<string, JsonValue> = {},
) {
  const forwarded: string[] = [], rejected: string[] = [];
  const run = await runGraph(graph, {
    from: "person@trusted.example",
    to: alias.address,
    subject: "Hello",
    text: "body",
    contentComplete: true,
    ...email,
  }, {
    ai: () => Promise.resolve({}),
    forward: (to) => {
      forwarded.push(to);
      return Promise.resolve();
    },
    reject: (reason) => {
      rejected.push(reason);
    },
  });
  return { run, forwarded, rejected };
}

function oldGraph(
  nodes:
    (Record<string, unknown> & { id: string; label: string; kind: string })[],
  edges?: MailGraph["edges"],
): MailGraph {
  return {
    version: 1,
    enabled: true,
    codeExtraction: "nodes",
    nodes: nodes.map((node, i) => ({ ...node, x: 0, y: i * 100 } as GraphNode)),
    edges: edges ??
      nodes.slice(1).map((node, i) => ({
        from: nodes[i].id,
        to: node.id,
        port: "next",
      })),
  };
}

Deno.test("migration produces a disabled pure workflow without changing rules or aliases", async () => {
  const rules = [rule(any, { delivery: "keep", tags: ["account"] })];
  const original = structuredClone({ rules, alias });
  const draft = migrateRules(rules, [alias]);
  assertEquals(draft.graph.version, 2);
  assertEquals(draft.graph.enabled, false);
  assertEquals({ rules, alias }, original);
  assert(
    draft.graph.nodes.every((node) =>
      !["rules", "apply", "policies", "extract", "delivery"].includes(node.kind)
    ),
  );
  const evaluation = draft.graph.nodes.find((node) =>
    node.kind === "evaluate"
  )!;
  assert(evaluation.kind === "evaluate" && "policy" in evaluation.policies);
  assertEquals(evaluation.policies.policy.success, undefined);
  assertEquals(evaluation.policies.policy.failed, undefined);
  assertEquals((await execute(draft.graph)).run.tags, ["account"]);
});

Deno.test("migration rejects unmatched mail and metadata-only matches", async () => {
  const empty = await execute(migrateRules([], [alias]).graph);
  assertEquals(empty.run.action, "block");
  assertEquals(empty.forwarded, []);
  assertEquals(empty.rejected.length, 1);
  const tags = await execute(
    migrateRules([rule(any, { tags: ["tag"] })], [alias]).graph,
  );
  assertEquals(tags.run.action, "block");
});

Deno.test("migration defers forwarding until all non-stopping rules settle", async () => {
  const rules = [
    rule(
      any,
      {
        delivery: "forward",
        forwardTo: "first@example.net",
        tags: ["one"],
        retentionDays: 3,
      },
      0,
      false,
    ),
    rule(
      any,
      {
        delivery: "forward",
        forwardTo: "last@example.net",
        tags: ["two"],
        retentionDays: 1,
      },
      1,
      false,
    ),
  ];
  const result = await execute(migrateRules(rules, [alias]).graph);
  assertEquals(result.run.status, "complete");
  assertEquals(result.forwarded, ["last@example.net"]);
  assertEquals(result.run.tags, ["one", "two"]);
  assertEquals(result.run.retentionDays, 1);
  rules.push(rule(any, { delivery: "block" }, 2, false));
  const blocked = await execute(migrateRules(rules, [alias]).graph);
  assertEquals(blocked.forwarded, []);
  assertEquals(blocked.run.action, "block");
});

Deno.test("migration respects stop-processing, priorities and scoped addresses", async () => {
  const stop = rule(
    { field: "fromDomain", operator: "equals", value: " TRUSTED.EXAMPLE " },
    { delivery: "forward" },
    0,
  );
  stop.aliasId = alias.id;
  const reject = rule(any, { delivery: "block" }, 1);
  const graph = migrateRules([reject, stop], [alias]).graph;
  assertEquals((await execute(graph)).forwarded, ["owner@example.net"]);
  assertEquals(
    (await execute(graph, { to: "other@example.com" })).run.action,
    "block",
  );
  assertEquals(
    (await execute(graph, { from: "person@other.example" })).run.action,
    "block",
  );
});

Deno.test("migrated text comparisons preserve trimmed case-insensitive glob/prefix/suffix semantics", async () => {
  const graph = migrateRules([rule({
    all: [
      { field: "subject", operator: "startsWith", value: " hi " },
      { field: "subject", operator: "endsWith", value: " THERE " },
      { field: "subject", operator: "glob", value: " HI*?HERE " },
    ],
  }, { delivery: "keep" })], [alias]).graph;
  assertEquals(
    (await execute(graph, { subject: "   Hi there   " })).run.action,
    "keep",
  );
});

Deno.test("unknown policy results skip that old rule via explicit unknown branch", async () => {
  const graph = migrateRules([
    rule({ not: { field: "body", operator: "contains", value: "warning" } }, {
      delivery: "forward",
      forwardTo: "owner@example.net",
    }, 0),
    rule(any, { delivery: "keep" }, 1),
  ], [alias]).graph;
  const result = await execute(graph, {
    text: "partial",
    bodyTruncated: true,
  });
  assertEquals(result.forwarded, []);
  assertEquals(result.run.action, "keep");
  assert(result.run.steps.some((step) => step.output === null));
});

Deno.test("hasCode migration expands local extraction only when needed", async () => {
  const draft = migrateRules([
    rule({ field: "hasCode", value: true }, { delivery: "keep" }),
  ], [alias]);
  assert(draft.graph.nodes.some((node) => node.kind === "tokens"));
  assert(
    !migrateRules([rule(any, { delivery: "keep" })], [alias]).graph.nodes.some((
      node,
    ) => node.kind === "tokens"),
  );
  assertEquals(
    (await execute(draft.graph, { text: "Your verification code is 123456" }))
      .run.action,
    "keep",
  );
  assertEquals(
    (await execute(draft.graph, { text: "No code here" })).run.action,
    "block",
  );
});

Deno.test("migration fails clearly for missing targets, deleted scopes and excessive branching", () => {
  assertThrows(
    () => migrateRules([rule(any, { delivery: "forward" })], [alias]),
    Error,
    "转发目标",
  );
  const scoped = rule(any, { delivery: "keep" });
  scoped.aliasId = "deleted";
  assertThrows(() => migrateRules([scoped], [alias]), Error, "地址已不存在");
  const many = Array.from(
    { length: 20 },
    (_, i) =>
      rule(
        { field: "subject", operator: "contains", value: String(i) },
        { delivery: "keep", tags: [String(i)] },
        i,
        false,
      ),
  );
  assertThrows(() => migrateRules(many, [alias]), Error, "超过 32");
});

Deno.test("disabled alias remains rejected even under global keep rules", async () => {
  const graph = migrateRules([rule(any, { delivery: "keep" })], [{
    ...alias,
    enabled: false,
  }]).graph;
  assertEquals((await execute(graph)).run.action, "block");
  assertEquals(
    (await execute(graph, { to: "new@example.com" })).run.action,
    "keep",
  );
});

Deno.test("legacy implicit keep is explicit in disabled migrated graph", async () => {
  const source = oldGraph([{ id: "start", label: "start", kind: "entry" }, {
    id: "end",
    label: "end",
    kind: "finish",
  }]);
  const snapshot = structuredClone(source);
  const draft = migrateGraph(source, [], []);
  assertEquals(source, snapshot);
  assertEquals(draft.graph.enabled, false);
  assertEquals((await execute(draft.graph)).run.action, "keep");
  assert(
    draft.graph.nodes.some((node) =>
      node.kind === "action" &&
      node.actions.some((action) => action.type === "keep")
    ),
  );
});

Deno.test("legacy default Rules bridge migrates without leaving hidden rules nodes", async () => {
  const source = oldGraph([
    { id: "start", label: "start", kind: "entry" },
    { id: "local", label: "local", kind: "extract" },
    { id: "rules", label: "rules", kind: "rules" },
    { id: "end", label: "end", kind: "finish" },
  ]);
  const graph = migrateGraph(source, [
    rule({ field: "hasCode", value: true }, { delivery: "keep" }),
  ], [alias]).graph;
  assertEquals(graph.nodes.filter((node) => node.kind === "tokens").length, 1);
  assert(!graph.nodes.some((node) => node.kind === "rules"));
  assertEquals(
    (await execute(graph, { subject: "Verification code", text: "123456" })).run
      .action,
    "keep",
  );
});

Deno.test("legacy policy branches become pure evaluation followed by IF", async () => {
  const source = oldGraph([
    { id: "start", label: "start", kind: "entry" },
    {
      id: "check",
      label: "trusted",
      kind: "policies",
      policies: {
        policy: {
          id: "trusted",
          revision: "1",
          name: "trusted",
          condition: {
            path: "email.subject",
            operator: "contains",
            value: "hello",
          },
          success: { actions: [], branches: ["trusted"] },
          failed: { reasons: ["not trusted"], branches: [] },
        },
      },
    },
    {
      id: "keep",
      label: "keep",
      kind: "delivery",
      action: "keep",
      tags: ["trusted"],
      forwardTo: "",
    },
    {
      id: "trash",
      label: "trash",
      kind: "delivery",
      action: "trash",
      tags: [],
      forwardTo: "",
    },
  ], [
    { from: "start", to: "check", port: "next" },
    { from: "check", to: "keep", port: "success" },
    { from: "check", to: "trash", port: "failed" },
  ]);
  const migrated = migrateGraph(source, [], []).graph;
  assertEquals((await execute(migrated)).run.tags, ["trusted"]);
  assertEquals(
    (await execute(migrated, { subject: "other" })).run.action,
    "trash",
  );
  assertEquals(
    (await execute(migrated, { subject: "", subjectTruncated: true })).run
      .action,
    "trash",
  );
  const checked = source.nodes.find((node) => node.kind === "policies")!;
  assert(checked.kind === "policies" && "policy" in checked.policies);
  checked.policies.policy.success!.actions.push({
    delivery: "forward",
    forwardTo: "owner@example.net",
  });
  assertThrows(() => migrateGraph(source, [], []), Error, "独立 Action");
});

Deno.test("default bridge keeps optional AI after accepted delivery and skips it for rejected mail", async () => {
  const source = oldGraph([
    { id: "start", label: "start", kind: "entry" },
    { id: "rules", label: "rules", kind: "rules" },
    {
      id: "enrich",
      label: "enrich",
      kind: "ai",
      prompt: "Return existing verification codes as JSON",
      inputs: { text: "email.text" },
      optional: true,
      outputMode: "verification",
      onlyWhenMissingCodes: true,
      batchGroup: "",
      schema: verificationSchema,
    },
    { id: "done", label: "done", kind: "finish" },
  ]);
  const graph = migrateGraph(source, [
    rule({ field: "subject", operator: "contains", value: "hello" }, {
      delivery: "forward",
      forwardTo: "owner@example.net",
    }),
  ], [alias]).graph;
  const events: string[] = [];
  const run = await runGraph(graph, {
    subject: "hello",
    text: "body",
    to: alias.address,
  }, {
    forward: () => {
      events.push("forward");
      return Promise.resolve();
    },
    ai: () => {
      events.push("ai");
      return Promise.resolve({
        enrich: { category: "other", hasCode: false, codes: [] },
      });
    },
    reject: () => {
      events.push("reject");
    },
  });
  assertEquals(run.status, "complete");
  assertEquals(events, ["forward", "ai"]);
  events.length = 0;
  await runGraph(graph, { subject: "other", text: "body", to: alias.address }, {
    ai: () => {
      events.push("ai");
      return Promise.resolve({});
    },
    reject: () => {
      events.push("reject");
    },
  });
  assertEquals(events, ["reject"]);
});

Deno.test("legacy hidden extraction is visible in the migrated workflow", async () => {
  const source = oldGraph([
    { id: "start", label: "start", kind: "entry" },
    { id: "done", label: "done", kind: "finish" },
  ]);
  delete source.codeExtraction;
  const draft = migrateGraph(source, [], []);
  assert(draft.graph.nodes.some((node) => node.kind === "tokens"));
  assertEquals(
    (await execute(draft.graph, { text: "Verification code: 123456" })).run
      .codes,
    ["123456"],
  );
});
