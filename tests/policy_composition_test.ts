import { assertEquals, assertThrows } from "@std/assert";
import {
  builtInPolicies,
  evaluatePolicies,
  parsePolicyExpression,
} from "../src/graph/policies.ts";
import { parseGraph } from "../src/graph/compile.ts";
import { runGraph } from "../src/graph/run.ts";
import type { MailGraph, PolicyExpression } from "../src/graph/types.ts";

const trusted = structuredClone(builtInPolicies[0]);
delete trusted.version;
const legacyWarning = structuredClone(builtInPolicies[1]);
delete legacyWarning.version;
legacyWarning.success = {
  actions: [{ tags: ["警告"] }],
  branches: ["warning"],
};
legacyWarning.failed = { reasons: ["未找到警告关键词"], branches: ["normal"] };
trusted.success = {
  branches: ["trusted"],
  actions: [{
    delivery: "forward",
    forwardTo: "owner@example.com",
  }],
};
trusted.failed = {
  reasons: ["发件地址不属于配置的域名"],
  branches: ["untrusted"],
};
const expression: PolicyExpression = {
  all: [{ policy: trusted }, { policy: legacyWarning }],
};
const email = {
  from: "sender@example.com",
  subject: "WARNING",
  text: "",
  codes: [],
};
const graph = (policies: PolicyExpression = expression): MailGraph => ({
  version: 1,
  enabled: true,
  nodes: [
    { id: "start", label: "开始", kind: "entry", x: 0, y: 0 },
    { id: "checks", label: "检查", kind: "policies", policies, x: 0, y: 150 },
    {
      id: "apply",
      label: "执行",
      kind: "apply",
      input: "nodes.checks.actions",
      x: 0,
      y: 300,
    },
    { id: "done", label: "结束", kind: "finish", x: 300, y: 300 },
  ],
  edges: [{ from: "start", to: "checks", port: "next" }, {
    from: "checks",
    to: "apply",
    port: "success",
  }, { from: "checks", to: "done", port: "failed" }],
});

Deno.test("historical v1 policies aggregate reasons, branches and deferred actions", () => {
  const read = (path: string) =>
    path === "email.from"
      ? email.from
      : path === "email.subject"
      ? email.subject
      : "";
  const success = evaluatePolicies(parsePolicyExpression(expression), read);
  assertEquals(success.matched, true);
  assertEquals(success.actions.length, 2);
  assertEquals(success.branches, ["trusted", "warning"]);
  const failed = evaluatePolicies(
    expression,
    (path) => path === "email.from" ? email.from : "hello",
  );
  assertEquals(failed.matched, false);
  assertEquals(failed.actions, []);
  assertEquals(failed.reasons, ["未找到警告关键词"]);
  assertEquals(failed.branches, ["normal"]);
  assertEquals(failed.results.map((r) => r.matched), [true, false]);
  const or = evaluatePolicies(
    { any: expression.all },
    (path) => path === "email.from" ? email.from : "hello",
  );
  assertEquals(or.actions, trusted.success!.actions);
  assertEquals(evaluatePolicies({ not: expression }, read).actions, []);
  assertThrows(() => parsePolicyExpression({ all: [] }));
});

Deno.test("historical v1 policy actions execute once after success and never on failed AND or trial", async () => {
  const forwarded: string[] = [];
  const runtime = {
    ai: () => Promise.resolve({}),
    forward: (to: string) => {
      forwarded.push(to);
      return Promise.resolve();
    },
  };
  const result = await runGraph(graph(), email, runtime);
  assertEquals(result.status, "complete");
  assertEquals(result.tags, ["警告"]);
  assertEquals(forwarded, ["owner@example.com"]);
  await runGraph(graph(), { ...email, subject: "Hello" }, runtime);
  await runGraph(graph(), email, { ...runtime, trial: true });
  assertEquals(forwarded.length, 1);
  const conflict = structuredClone(trusted);
  conflict.success!.actions = [{ delivery: "trash" }];
  const failure = await runGraph(
    graph({ all: [{ policy: trusted }, { policy: conflict }] }),
    email,
    runtime,
  );
  assertEquals(failure.status, "failed");
  assertEquals(forwarded.length, 1);
  const invalid = graph();
  const apply = invalid.nodes.find((n) => n.kind === "apply")!;
  if (apply.kind === "apply") apply.input = "email.codes";
  assertThrows(() => parseGraph(invalid));
});

Deno.test("incomplete content cannot turn a negated Policy into a successful action", async () => {
  const policy = structuredClone(trusted);
  policy.condition = {
    not: { path: "email.text", operator: "contains", value: "warning" },
  };
  const runtime = {
    ai: () => Promise.resolve({}),
    forward: () => {
      throw new Error("must not forward");
    },
  };
  const result = await runGraph(graph({ policy }), {
    ...email,
    truncated: true,
  }, runtime);
  assertEquals(result.status, "complete");
  assertEquals(result.action, "keep");
  const output = result.steps.find((step) => step.nodeId === "checks")!
    .output as { indeterminate: boolean };
  assertEquals(output.indeterminate, true);
  const expression: PolicyExpression = { not: { policy: builtInPolicies[1] } };
  const uncertain = evaluatePolicies(expression, () => "", () => "unavailable");
  assertEquals(uncertain.matched, false);
  assertEquals(uncertain.indeterminate, true);
});

Deno.test("pure evaluation carries incompleteness through a downstream delivery branch", async () => {
  const policy = structuredClone(trusted);
  policy.condition = {
    not: { path: "email.text", operator: "contains", value: "warning" },
  };
  policy.version = 2;
  policy.success!.actions = [];
  const flow = graph();
  flow.version = 2;
  flow.codeExtraction = "nodes";
  flow.nodes = flow.nodes.map((node) =>
    node.id === "checks"
      ? {
        id: node.id,
        x: 0,
        y: 0,
        label: "Evaluate",
        kind: "evaluate",
        policies: { policy },
      }
      : node.id === "apply"
      ? {
        id: node.id,
        x: 0,
        y: 0,
        label: "Forward",
        kind: "action",
        actions: [{ type: "forward", to: "owner@example.com" }],
      }
      : node
  );
  flow.nodes.push({
    id: "route",
    x: 0,
    y: 0,
    label: "Route",
    kind: "condition",
    path: "nodes.checks.matched",
    operator: "equals",
    value: true,
    unknown: true,
  });
  flow.edges = [
    { from: "start", to: "checks", port: "next" },
    { from: "checks", to: "route", port: "next" },
    { from: "route", to: "apply", port: "yes" },
    { from: "route", to: "done", port: "no" },
    { from: "route", to: "done", port: "unknown" },
    { from: "apply", to: "done", port: "next" },
  ];
  for (const incomplete of [{ truncated: true }, { unavailable: true }]) {
    let rejected = 0;
    const run = await runGraph(flow, {
      ...email,
      truncated: false,
      unavailable: false,
      ...incomplete,
    }, {
      reject: () => {
        rejected++;
      },
      ai: () => Promise.resolve({}),
      forward: () => {
        throw new Error("must not forward");
      },
    });
    assertEquals(run.status, "complete", JSON.stringify(run));
    assertEquals(run.action, "block");
    assertEquals(rejected, 1);
  }
});

Deno.test("body truncation does not change a complete subject's negative Policy verdict", async () => {
  const { graphEmail } = await import("../src/graph/process.ts");
  const policy = structuredClone(trusted);
  policy.condition = {
    not: { path: "email.subject", operator: "contains", value: "warning" },
  };
  const input = graphEmail(
    {
      subject: "Hello",
      text: "x".repeat(13000),
      truncated: false,
      codes: [],
      links: [],
    },
    email.from,
    "inbox@example.com",
  );
  assertEquals(input.truncated, true);
  let forwarded = 0;
  const run = await runGraph(graph({ policy }), input, {
    ai: () => Promise.resolve({}),
    forward: () => {
      forwarded++;
      return Promise.resolve();
    },
  });
  assertEquals(run.status, "complete");
  assertEquals(forwarded, 1);
});
