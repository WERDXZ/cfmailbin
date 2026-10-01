import { assertEquals, assertRejects } from "@std/assert";
import { compileGraph, parseGraph } from "../src/graph/compile.ts";
import { runGraph } from "../src/graph/run.ts";
import type { JsonValue, MailGraph } from "../src/graph/types.ts";

type FixtureNode = {
  id: string;
  kind: string;
  [key: string]: unknown;
};

function graphOf(
  nodes: FixtureNode[],
  edges?: MailGraph["edges"],
): MailGraph {
  return {
    version: 1,
    enabled: true,
    codeExtraction: "nodes",
    nodes: nodes.map((node, index) => ({
      label: node.id,
      x: 0,
      y: index * 100,
      ...node,
    })),
    edges: edges ?? nodes.slice(1).map((node, index) => ({
      from: nodes[index].id,
      to: node.id,
      port: "next",
    })),
  } as MailGraph;
}

function destinationAi(
  id: string,
  inputs = { text: "email.text" },
): FixtureNode {
  return {
    id,
    kind: "ai",
    prompt: "Return the configured destination as JSON.",
    inputs,
    batchGroup: "shared",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["destination"],
      properties: { destination: { type: "string", maxLength: 200 } },
    },
  };
}

const noAi = () => Promise.resolve({});

Deno.test("an action chain tags, sets retention and forwards once", async () => {
  const forwarded: string[] = [];
  const graph = graphOf([
    { id: "start", kind: "entry" },
    {
      id: "actions",
      kind: "action",
      actions: [
        { type: "tag", tags: ["verification"] },
        { type: "set_retention", days: 1 },
        { type: "forward", to: "owner@example.com" },
      ],
    },
    { id: "done", kind: "finish" },
  ]);
  const run = await runGraph(graph, { text: "Test" }, {
    ai: noAi,
    forward: (destination) => {
      forwarded.push(destination);
      return Promise.resolve();
    },
  });

  assertEquals(run.status, "complete");
  assertEquals(run.tags, ["verification"]);
  assertEquals(run.retentionDays, 1);
  assertEquals(run.action, "forward");
  assertEquals(run.forwardTo, "owner@example.com");
  assertEquals(forwarded, ["owner@example.com"]);
});

Deno.test("consecutive action nodes expose tags, retention and delivery to downstream bindings", async () => {
  const forwarded: string[] = [];
  const observed: Record<string, JsonValue>[] = [];
  const graph = graphOf([
    { id: "start", kind: "entry" },
    {
      id: "prepare",
      kind: "action",
      actions: [
        { type: "tag", tags: ["account"] },
        { type: "set_retention", days: 2 },
      ],
    },
    {
      id: "deliver",
      kind: "action",
      actions: [
        { type: "tag", tags: { ref: "current.parent.tags" } },
        { type: "set_retention", days: { ref: "nodes.prepare.retentionDays" } },
        { type: "forward", to: "owner@example.com" },
      ],
    },
    {
      ...destinationAi("observe"),
      inputs: {
        action: "current.parent.action",
        tags: "nodes.prepare.tags",
        days: "nodes.deliver.retentionDays",
      },
    },
    { id: "done", kind: "finish" },
  ]);
  const run = await runGraph(graph, {}, {
    ai: (tasks) => {
      observed.push(...tasks.map((task) => task.input));
      return Promise.resolve({ observe: { destination: "owner@example.com" } });
    },
    forward: (destination) => {
      forwarded.push(destination);
      return Promise.resolve();
    },
  });

  assertEquals(run.status, "complete");
  assertEquals(run.tags, ["account"]);
  assertEquals(run.retentionDays, 2);
  assertEquals(forwarded, ["owner@example.com"]);
  assertEquals(observed, [{ action: "forward", tags: ["account"], days: 2 }]);
});

Deno.test("deny rejects with its configured reason and terminates the graph", async () => {
  const reasons: (string | undefined)[] = [];
  const graph = graphOf([
    { id: "start", kind: "entry" },
    {
      id: "deny",
      kind: "action",
      actions: [{ type: "deny", reason: "Sender is not trusted" }],
    },
  ]);
  const run = await runGraph(graph, {}, {
    ai: noAi,
    reject: (reason?: string) => reasons.push(reason),
  });

  assertEquals(run.status, "complete");
  assertEquals(run.action, "block");
  assertEquals(reasons, ["Sender is not trusted"]);
});

for (const splitNodes of [false, true]) {
  Deno.test(`forward and deny are rejected before effects ${splitNodes ? "across nodes" : "within a node"}`, async () => {
    const effects: string[] = [];
    const forward = { type: "forward", to: "owner@example.com" };
    const deny = { type: "deny", reason: "Blocked" };
    const graph = graphOf([
      { id: "start", kind: "entry" },
      ...(splitNodes
        ? [
          { id: "forward", kind: "action", actions: [forward] },
          { id: "deny", kind: "action", actions: [deny] },
        ]
        : [{ id: "conflict", kind: "action", actions: [forward, deny] }]),
    ]);

    await assertRejects(() =>
      runGraph(graph, {}, {
        ai: noAi,
        forward: (to) => {
          effects.push(to);
          return Promise.resolve();
        },
        reject: () => effects.push("rejected"),
      })
    );
    assertEquals(effects, []);
  });
}

Deno.test("a later invalid bound action is validated before an earlier native forward", async () => {
  const forwarded: string[] = [];
  const graph = graphOf([
    { id: "start", kind: "entry" },
    {
      id: "actions",
      kind: "action",
      actions: [
        { type: "forward", to: "owner@example.com" },
        { type: "forward", to: { ref: "email.subject" } },
      ],
    },
    { id: "done", kind: "finish" },
  ]);
  const run = await runGraph(
    graph,
    { subject: "This is not an email address" },
    {
      ai: noAi,
      forward: (destination) => {
        forwarded.push(destination);
        return Promise.resolve();
      },
    },
  );

  assertEquals(run.status, "failed");
  assertEquals(forwarded, []);
});

Deno.test("trial action chains preview outcomes without forwarding or rejecting", async () => {
  const effects: string[] = [];
  for (
    const action of [
      { type: "forward", to: "owner@example.com" },
      { type: "deny", reason: "Blocked" },
    ]
  ) {
    const graph = graphOf([
      { id: "start", kind: "entry" },
      { id: "actions", kind: "action", actions: [action] },
      ...(action.type === "deny" ? [] : [{ id: "done", kind: "finish" }]),
    ]);
    const run = await runGraph(graph, {}, {
      ai: noAi,
      trial: true,
      forward: (destination) => {
        effects.push(destination);
        return Promise.resolve();
      },
      reject: () => effects.push("rejected"),
    });
    assertEquals(run.status, "complete");
    assertEquals(run.action, action.type === "deny" ? "block" : "forward");
  }
  assertEquals(effects, []);
});

Deno.test("later AI failure preserves an already completed forwarding outcome", async () => {
  const forwarded: string[] = [];
  const graph = graphOf([
    { id: "start", kind: "entry" },
    {
      id: "forward",
      kind: "action",
      actions: [{ type: "forward", to: "owner@example.com" }],
    },
    destinationAi("ai"),
    { id: "done", kind: "finish" },
  ]);
  const run = await runGraph(graph, { text: "Test" }, {
    ai: () => Promise.reject(new Error("Provider unavailable")),
    forward: (destination) => {
      forwarded.push(destination);
      return Promise.resolve();
    },
  });

  assertEquals(run.status, "failed");
  assertEquals(forwarded, ["owner@example.com"]);
  assertEquals(run.action, "forward");
  assertEquals(run.forwardTo, "owner@example.com");
});

Deno.test("an AI parent output dependency prevents batching and feeds the next AI", async () => {
  const graph = graphOf([
    { id: "start", kind: "entry" },
    destinationAi("first"),
    destinationAi("second", { text: "current.parent.destination" }),
    { id: "done", kind: "finish" },
  ]);
  const plan = compileGraph(parseGraph(graph));
  assertEquals(plan.batches, []);
  const inputs: Record<string, JsonValue>[] = [];
  const run = await runGraph(graph, { text: "Original body" }, {
    ai: (tasks) => {
      inputs.push(...tasks.map((task) => task.input));
      return Promise.resolve(Object.fromEntries(tasks.map((task) => [
        task.node.id,
        { destination: "owner@example.com" },
      ])));
    },
  });

  assertEquals(run.status, "complete");
  assertEquals(inputs, [
    { text: "Original body" },
    { text: "owner@example.com" },
  ]);
});

Deno.test("an optional ancestor from an unselected branch uses its binding fallback", async () => {
  const forwarded: string[] = [];
  const graph = graphOf([
    { id: "start", kind: "entry" },
    {
      id: "check",
      kind: "condition",
      path: "email.subject",
      operator: "equals",
      value: "Select AI",
    },
    destinationAi("optional"),
    {
      id: "actions",
      kind: "action",
      actions: [{
        type: "forward",
        to: {
          ref: "nodes.optional?.destination",
          fallback: "owner@example.com",
        },
      }],
    },
    { id: "done", kind: "finish" },
  ], [
    { from: "start", to: "check", port: "next" },
    { from: "check", to: "optional", port: "yes" },
    { from: "check", to: "actions", port: "no" },
    { from: "optional", to: "actions", port: "next" },
    { from: "actions", to: "done", port: "next" },
  ]);
  const run = await runGraph(graph, { subject: "Skip AI" }, {
    ai: () => {
      throw new Error("Unselected branch must not run");
    },
    forward: (destination) => {
      forwarded.push(destination);
      return Promise.resolve();
    },
  });

  assertEquals(run.status, "complete");
  assertEquals(forwarded, ["owner@example.com"]);
});

Deno.test("an optional current parent uses fallback when its AI output is skipped", async () => {
  const forwarded: string[] = [];
  const graph = graphOf([
    { id: "start", kind: "entry" },
    { ...destinationAi("optional"), optional: true },
    {
      id: "actions",
      kind: "action",
      actions: [{
        type: "forward",
        to: {
          ref: "current.parent?.destination",
          fallback: "owner@example.com",
        },
      }],
    },
    { id: "done", kind: "finish" },
  ]);
  const run = await runGraph(graph, { text: "Test" }, {
    aiEnabled: false,
    ai: () => {
      throw new Error("Disabled optional AI must not run");
    },
    forward: (destination) => {
      forwarded.push(destination);
      return Promise.resolve();
    },
  });

  assertEquals(run.status, "complete");
  assertEquals(forwarded, ["owner@example.com"]);
});

for (const relation of ["downstream", "unrelated"] as const) {
  Deno.test(`even optional references reject ${relation} nodes before effects`, async () => {
    const forwarded: string[] = [];
    const graph = graphOf([
      { id: "start", kind: "entry" },
      {
        id: "actions",
        kind: "action",
        actions: [{
          type: "forward",
          to: {
            ref: "nodes.source?.destination",
            fallback: "owner@example.com",
          },
        }],
      },
      destinationAi("source"),
      { id: "done", kind: "finish" },
    ], [
      { from: "start", to: "actions", port: "next" },
      {
        from: "actions",
        to: relation === "downstream" ? "source" : "done",
        port: "next",
      },
      { from: "source", to: "done", port: "next" },
    ]);

    await assertRejects(() =>
      runGraph(graph, { text: "Test" }, {
        ai: noAi,
        forward: (destination) => {
          forwarded.push(destination);
          return Promise.resolve();
        },
      })
    );
    assertEquals(forwarded, []);
  });
}

Deno.test("explicit keep restores inbox after trash without losing forwarding history", async () => {
  const graph = graphOf([
    { id: "start", kind: "entry" },
    {
      id: "actions",
      kind: "action",
      actions: [
        { type: "forward", to: "owner@example.com" },
        { type: "trash" },
        { type: "keep" },
      ],
    },
    { id: "done", kind: "finish" },
  ]);
  const run = await runGraph(graph, {}, { ai: noAi, trial: true });
  assertEquals(run.status, "complete");
  assertEquals(run.action, "keep");
  assertEquals(run.forwardTo, "owner@example.com");
});
