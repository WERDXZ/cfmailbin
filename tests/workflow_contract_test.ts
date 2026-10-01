import { assert, assertEquals, assertThrows } from "@std/assert";
import { processIncomingEmail } from "../src/email/processor.ts";
import {
  createMemoryBlobStore,
  createMemoryStore,
} from "../src/storage/memory.ts";
import { graphTemplate } from "../src/graph/templates.ts";
import { parseGraph } from "../src/graph/compile.ts";
import { runGraph } from "../src/graph/run.ts";
import { evaluatePolicies, parsePolicy } from "../src/graph/policies.ts";
import type {
  GraphNode,
  JsonValue,
  MailGraph,
  PolicyDefinition,
} from "../src/graph/types.ts";
import { actionPolicy, legacyReceiptPolicy } from "./workflow_fixture.ts";

const config = {
  appName: "test",
  allowCatchAll: true,
  defaultRetentionDays: 7,
  defaultForwardTo: "old@example.com",
};
const email = {
  from: "sender@example.com",
  to: "new@example.com",
  subject: "Hello",
  text: "Hello",
  body: "Hello",
  codes: [],
  truncated: false,
};
function incoming() {
  let reads = 0, forwards = 0, rejected = false;
  return {
    ...email,
    headers: new Headers({ subject: email.subject }),
    get raw(): ReadableStream<Uint8Array> {
      reads++;
      return new Response("Subject: Hello\r\n\r\nHello").body!;
    },
    forward() {
      forwards++;
      return Promise.resolve();
    },
    setReject() {
      rejected = true;
    },
    counts: () => ({ reads, forwards, rejected }),
  };
}
for (const variant of ["missing", "disabled", "legacy"] as const) {
  Deno.test(`inactive ${variant} workflow rejects before MIME, alias, raw storage, rules or AI`, async () => {
    const store = createMemoryStore(), blobs = createMemoryBlobStore();
    await store.createRule({
      condition: { field: "subject", operator: "contains", value: "Hello" },
      actions: { delivery: "forward", forwardTo: "old@example.com" },
    });
    let puts = 0, calls = 0;
    const message = incoming();
    const result = await processIncomingEmail({
      config,
      store,
      message,
      blobStore: {
        ...blobs,
        put: async (...args: Parameters<typeof blobs.put>) => {
          puts++;
          return await blobs.put(...args);
        },
      },
      graph: variant === "missing"
        ? undefined
        : variant === "legacy"
        ? legacyReceiptPolicy()
        : { ...actionPolicy(), enabled: false },
      analysisFetch: () => {
        calls++;
        throw new Error("unexpected AI");
      },
    });
    assertEquals(result.rejected, true);
    assertEquals(message.counts(), { reads: 0, forwards: 0, rejected: true });
    assertEquals(await store.listAliases(), []);
    assertEquals(await store.listMessages(), []);
    assertEquals(puts, 0);
    assertEquals(calls, 0);
  });
}
Deno.test("only an explicit enabled v2 action accepts; metadata and bare finish do not", async () => {
  for (
    const [actions, accepted] of [[[{ type: "keep" }], true], [[{
      type: "tag",
      tags: ["classified"],
    }], false]] as const
  ) {
    const store = createMemoryStore(), message = incoming();
    const result = await processIncomingEmail({
      config,
      store,
      message,
      blobStore: createMemoryBlobStore(),
      graph: actionPolicy(
        structuredClone(actions) as unknown as Parameters<
          typeof actionPolicy
        >[0],
      ),
    });
    assertEquals(result.rejected, !accepted);
    assertEquals(message.counts().forwards, 0);
    assertEquals((await store.listMessages()).length, accepted ? 1 : 0);
  }
  const run = await runGraph({ ...graphTemplate(), enabled: true }, email, {
    ai: () => Promise.resolve({}),
    trial: true,
  });
  assertEquals(run.action, "block");
});
function predicate(): PolicyDefinition {
  return {
    version: 2,
    id: "trusted",
    revision: "1",
    name: "trusted",
    condition: { path: "email.text", operator: "contains", value: "hello" },
    success: { actions: [], branches: ["trusted"] },
    failed: { reasons: ["not trusted"], branches: [] },
  };
}
function branchGraph(kind: "match" | "condition"): MailGraph {
  const nodes: GraphNode[] = [
    { id: "start", kind: "entry", label: "start", x: 0, y: 0 },
    {
      id: "check",
      kind: "evaluate",
      label: "check",
      x: 0,
      y: 100,
      policies: { policy: predicate() },
    },
    kind === "match"
      ? {
        id: "branch",
        kind: "match",
        label: "branch",
        x: 0,
        y: 200,
        input: "nodes.check.status",
        cases: [{ id: "ok", label: "ok", value: "success" }, {
          id: "no",
          label: "no",
          value: "failed",
        }],
      }
      : {
        id: "branch",
        kind: "condition",
        label: "branch",
        x: 0,
        y: 200,
        path: "email.text",
        operator: "contains",
        value: "hello",
        unknown: true,
      },
    ...["success", "failed", "unknown"].map((id, i): GraphNode => ({
      id,
      label: id,
      x: i * 200,
      y: 300,
      kind: "action",
      actions: [{ type: "tag", tags: [id] }, { type: "keep" }],
    })),
    { id: "done", kind: "finish", label: "done", x: 0, y: 400 },
  ];
  return {
    version: 2,
    enabled: true,
    codeExtraction: "nodes",
    nodes,
    edges: [
      { from: "start", to: "check", port: "next" },
      { from: "check", to: "branch", port: "next" },
      {
        from: "branch",
        to: "success",
        port: kind === "match" ? "case:ok" : "yes",
      },
      {
        from: "branch",
        to: "failed",
        port: kind === "match" ? "case:no" : "no",
      },
      {
        from: "branch",
        to: "unknown",
        port: kind === "match" ? "default" : "unknown",
      },
      ...["success", "failed", "unknown"].map((id) => ({
        from: id,
        to: "done",
        port: "next" as const,
      })),
    ],
  };
}
Deno.test("pure Policy needs only a name and condition and exposes a nullable success result", () => {
  const definition = {
    version: 2,
    id: "check",
    revision: "1",
    name: "contains_hello",
    condition: { path: "email.text", operator: "contains", value: "hello" },
  };
  const policy = parsePolicy(definition);
  assertEquals<unknown>(policy, definition);
  for (const [input, expected] of [["Hello", true], ["No", false]] as const) {
    const result = evaluatePolicies({ policy }, () => input);
    assertEquals(Reflect.get(result, "success"), expected);
    assertEquals(Reflect.get(result.results[0], "success"), expected);
    assertEquals(result.results[0].name, "contains_hello");
  }
  const unknown = evaluatePolicies(
    { not: { policy } },
    () => "No",
    () => "truncated",
  );
  assertEquals(Reflect.get(unknown, "success"), null);
  assertEquals(unknown.status, "unknown");
  assertThrows(() =>
    parsePolicy({
      ...definition,
      success: { actions: [{ delivery: "keep" }], branches: [] },
    })
  );
});

for (const kind of ["match", "condition"] as const) {
  for (const path of ["nodes.check.success", "current.parent.success"]) {
    Deno.test(`${kind} reads ${path} and never treats an unknown Policy as false`, async () => {
      const graph = branchGraph(kind);
      const branch = graph.nodes.find((n) => n.id === "branch")!;
      if (branch.kind === "condition") {
        branch.path = path;
        branch.operator = "equals";
        branch.value = true;
      }
      if (branch.kind === "match") {
        branch.input = path;
        branch.cases[0].value = true;
        branch.cases[1].value = false;
      }
      for (
        const [text, truncated, expected] of [["Hello", false, "success"], [
          "No",
          false,
          "failed",
        ], ["No", true, "unknown"]] as const
      ) {
        const run = await runGraph(graph, { ...email, text, truncated }, {
          trial: true,
          ai: () => Promise.resolve({}),
        });
        assertEquals(run.status, "complete");
        assertEquals(run.tags, [expected]);
      }
    });
  }
}
for (const kind of ["match", "condition"] as const) {
  Deno.test(`${kind}: pure policy outputs distinguish success, failed and unknown without implicit delivery`, async () => {
    const graph = branchGraph(kind);
    for (
      const [text, truncated, expected] of [["Hello", false, "success"], [
        "No",
        false,
        "failed",
      ], ["No", true, "unknown"]] as const
    ) {
      const run = await runGraph(graph, {
        ...email,
        text,
        body: text,
        truncated,
      }, { ai: () => Promise.resolve({}), trial: true });
      assertEquals(run.status, "complete");
      assertEquals(run.tags, [expected]);
      const output = run.steps.find((s) => s.nodeId === "check")
        ?.output as Record<string, unknown>;
      assertEquals(output.status, expected);
      assertEquals(output.matched, expected === "success");
      assertEquals(
        run.actionResults?.filter((a) => a.type === "keep").length,
        1,
      );
    }
    const pure = structuredClone(graph);
    pure.nodes = pure.nodes.filter((n) =>
      ["start", "check", "done"].includes(n.id)
    );
    pure.edges = [{ from: "start", to: "check", port: "next" }, {
      from: "check",
      to: "done",
      port: "next",
    }];
    assertEquals(
      (await runGraph(pure, email, {
        ai: () => Promise.resolve({}),
        trial: true,
      }))
        .action,
      "block",
    );
  });
}
Deno.test("match uses strict primitive equality and an explicit default for unknown content", async () => {
  const graph = branchGraph("match");
  const node = graph.nodes.find((n) => n.id === "branch")!;
  assert(node.kind === "match");
  node.input = "email.subject";
  node.cases = [{ id: "ok", label: "number", value: 1 }, {
    id: "no",
    label: "string",
    value: "1",
  }];
  assertEquals(
    (await runGraph(graph, { ...email, subject: "1" }, {
      trial: true,
      ai: () => Promise.resolve({}),
    })).tags,
    ["failed"],
  );
  assertEquals(
    (await runGraph(graph, { ...email, subject: "other" }, {
      trial: true,
      ai: () => Promise.resolve({}),
    })).tags,
    ["unknown"],
  );
  node.input = "email.text";
  node.cases[0].value = "Hello";
  assertEquals(
    (await runGraph(graph, { ...email, truncated: true }, {
      trial: true,
      ai: () => Promise.resolve({}),
    })).tags,
    ["unknown"],
  );
  const missingDefault = structuredClone(graph);
  missingDefault.edges = missingDefault.edges.filter((edge) =>
    edge.port !== "default"
  );
  assertThrows(() => parseGraph(missingDefault));
});
Deno.test("v2 rejects legacy processing nodes that remain valid in historical v1 graphs", () => {
  const base = { id: "actions", label: "Legacy", x: 0, y: 100 };
  const nodes: GraphNode[] = [
    { ...base, kind: "rules" },
    { ...base, kind: "extract" },
    { ...base, kind: "delivery", action: "keep", forwardTo: "", tags: [] },
    { ...base, kind: "policies", policies: { policy: predicate() } },
  ];
  for (const node of nodes) {
    const graph = actionPolicy();
    graph.nodes[1] = node;
    if (node.kind === "delivery") {
      graph.edges = graph.edges.filter((edge) => edge.from !== "actions");
    }
    if (node.kind === "policies") {
      graph.edges = [{ from: "start", to: "actions", port: "next" }, {
        from: "actions",
        to: "done",
        port: "success",
      }, { from: "actions", to: "done", port: "failed" }];
    }
    parseGraph({ ...graph, version: 1 });
    assertThrows(() => parseGraph(graph));
  }
  const apply = actionPolicy();
  apply.nodes[1] = {
    ...base,
    kind: "policies",
    policies: { policy: predicate() },
  };
  apply.nodes[2] = {
    id: "done",
    label: "Apply",
    x: 0,
    y: 200,
    kind: "apply",
    input: "nodes.actions.actions",
  };
  apply.nodes.push({
    id: "finish",
    label: "Finish",
    x: 100,
    y: 200,
    kind: "finish",
  });
  apply.edges = [{ from: "start", to: "actions", port: "next" }, {
    from: "actions",
    to: "done",
    port: "success",
  }, { from: "actions", to: "finish", port: "failed" }];
  parseGraph({ ...apply, version: 1 });
  assertThrows(() => parseGraph(apply));
});

Deno.test("stored alias forwarding and old saved rules cannot bypass an inactive workflow", async () => {
  const store = createMemoryStore(), message = incoming();
  await store.createAlias({
    address: email.to,
    enabled: true,
    defaultAction: "forward",
    forwardTo: "old@example.com",
    retentionDays: 7,
  });
  await store.createRule({
    condition: { field: "subject", operator: "contains", value: "Hello" },
    actions: { delivery: "forward", forwardTo: "old@example.com" },
  });
  const result = await processIncomingEmail({
    config,
    store,
    message,
    blobStore: createMemoryBlobStore(),
  });
  assertEquals(result.rejected, true);
  assertEquals(message.counts(), { reads: 0, forwards: 0, rejected: true });
  assertEquals(await store.listMessages(), []);
  assertEquals((await store.listRules()).length, 1);
  assertEquals((await store.listAliases())[0].forwardTo, "old@example.com");
});

Deno.test("v2 policies cannot hide delivery actions in success outcomes", () => {
  const graph = branchGraph("condition");
  const policy = predicate();
  policy.success!.actions = [{
    delivery: "forward",
    forwardTo: "owner@example.com",
  }];
  const checks = graph.nodes.find((node) => node.kind === "evaluate")!;
  assert(checks.kind === "evaluate");
  checks.policies = { policy };
  assertThrows(() => parseGraph(graph));
});

for (const kind of ["match", "condition"] as const) {
  Deno.test(`${kind}: a missing optional parent field is unknown while an explicit null is a value`, async () => {
    const base = { x: 0, y: 0 };
    const graph: MailGraph = {
      version: 2,
      enabled: true,
      codeExtraction: "nodes",
      nodes: [
        { ...base, id: "start", label: "start", kind: "entry" },
        {
          ...base,
          id: "branch",
          label: "branch",
          kind: "condition",
          path: "email.subject",
          operator: "equals",
          value: "left",
          unknown: true,
        },
        {
          ...base,
          id: "left",
          label: "left",
          kind: "ai",
          prompt: "Return a category",
          inputs: {},
          batchGroup: "",
          schema: {
            type: "object",
            properties: { category: { type: ["string", "null"] } },
            required: ["category"],
            additionalProperties: false,
          },
        },
        {
          ...base,
          id: "right",
          label: "right",
          kind: "ai",
          prompt: "Return another field",
          inputs: {},
          batchGroup: "",
          schema: {
            type: "object",
            properties: { other: { type: "string" } },
            required: ["other"],
            additionalProperties: false,
          },
        },
        kind === "match"
          ? {
            ...base,
            id: "route",
            label: "route",
            kind: "match",
            input: "current.parent?.category",
            cases: [{ id: "null", label: "Explicit null", value: null }],
          }
          : {
            ...base,
            id: "route",
            label: "route",
            kind: "condition",
            path: "current.parent?.category",
            operator: "equals",
            value: "denied",
            condition: {
              not: {
                path: "current.parent?.category",
                operator: "equals",
                value: "denied",
              },
            },
            unknown: true,
          },
        {
          ...base,
          id: "accept",
          label: "accept",
          kind: "action",
          actions: [{ type: "keep" }],
        },
        {
          ...base,
          id: "deny",
          label: "deny",
          kind: "action",
          actions: [{ type: "deny", reason: "No verified result" }],
        },
        { ...base, id: "done", label: "done", kind: "finish" },
      ],
      edges: [
        { from: "start", to: "branch", port: "next" },
        { from: "branch", to: "left", port: "yes" },
        { from: "branch", to: "right", port: "no" },
        { from: "branch", to: "deny", port: "unknown" },
        { from: "left", to: "route", port: "next" },
        { from: "right", to: "route", port: "next" },
        {
          from: "route",
          to: "accept",
          port: kind === "match" ? "case:null" : "yes",
        },
        {
          from: "route",
          to: "deny",
          port: kind === "match" ? "default" : "no",
        },
        ...(kind === "condition"
          ? [{ from: "route", to: "deny", port: "unknown" as const }]
          : []),
        { from: "accept", to: "done", port: "next" },
      ],
    };
    for (const subject of ["left", "right"]) {
      const run = await runGraph(graph, { ...email, subject }, {
        trial: true,
        ai: (tasks) =>
          Promise.resolve<Record<string, JsonValue>>({
            [tasks[0].node.id]: subject === "left"
              ? { category: null }
              : { other: "present" },
          }),
      });
      assertEquals(run.status, "complete");
      assertEquals(run.action, subject === "left" ? "keep" : "block");
    }
  });
}
