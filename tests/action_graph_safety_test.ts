import { assertEquals, assertThrows } from "@std/assert";
import { compileGraph, parseGraph } from "../src/graph/compile.ts";
import { insertFragment } from "../src/graph/fragments.ts";
import { runGraph } from "../src/graph/run.ts";
import { graphTemplate } from "../src/graph/templates.ts";
import type {
  GraphFragment,
  JsonValue,
  MailGraph,
} from "../src/graph/types.ts";

function destinationAi(
  id: string,
  inputs: Record<string, string>,
  optional = false,
) {
  return {
    id,
    label: id,
    kind: "ai" as const,
    x: 0,
    y: 0,
    prompt: "Return a destination.",
    inputs,
    batchGroup: "shared",
    optional: optional || undefined,
    schema: {
      type: "object" as const,
      additionalProperties: false as const,
      required: ["destination"],
      properties: { destination: { type: "string" as const } },
    },
  };
}

function linearAiGraph(secondInput: string): MailGraph {
  return {
    version: 1,
    enabled: true,
    codeExtraction: "nodes",
    nodes: [
      { id: "start", label: "start", kind: "entry", x: 0, y: 0 },
      destinationAi("first", { text: "email.text" }),
      destinationAi("second", { text: secondInput }),
      { id: "done", label: "done", kind: "finish", x: 0, y: 0 },
    ],
    edges: [
      { from: "start", to: "first", port: "next" },
      { from: "first", to: "second", port: "next" },
      { from: "second", to: "done", port: "next" },
    ],
  };
}

for (
  const path of [
    "nodes.first?.destination",
    "current?.parent.destination",
  ]
) {
  Deno.test(`optional dependency ${path} prevents AI batching`, async () => {
    const graph = parseGraph(linearAiGraph(path));
    assertEquals(compileGraph(graph).batches, []);

    const inputs: Record<string, JsonValue>[] = [];
    const run = await runGraph(graph, { text: "body" }, {
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
      { text: "body" },
      { text: "owner@example.com" },
    ]);
  });
}

function actionFragment(optional = false): GraphFragment {
  return {
    entry: "source",
    exit: "send",
    nodes: [
      destinationAi("source", { text: "email.text" }, optional),
      {
        id: "send",
        label: "send",
        kind: "action",
        x: 0,
        y: 100,
        actions: [{
          type: "forward",
          to: optional
            ? {
              ref: "nodes.source?.destination",
              fallback: "owner@example.com",
            }
            : { ref: "nodes.source.destination" },
        }],
      },
    ],
    edges: [{ from: "source", to: "send", port: "next" }],
  };
}

Deno.test("fragment insertion remaps required action bindings", async () => {
  const graph = insertFragment(graphTemplate(), actionFragment(), "start");
  const internal = graph.nodes.find((node) =>
    node.kind === "ai" && node.id !== "source"
  )!;
  const forwarded: string[] = [];
  const run = await runGraph(graph, { text: "body" }, {
    ai: (tasks) =>
      Promise.resolve({
        [tasks[0].node.id]: { destination: "owner@example.com" },
      }),
    forward: (to) => {
      forwarded.push(to);
      return Promise.resolve();
    },
  });

  assertEquals(internal.kind, "ai");
  assertEquals(run.status, "complete");
  assertEquals(forwarded, ["owner@example.com"]);
});

Deno.test("optional action binding follows the remapped fragment node despite a host ID collision", async () => {
  const host: MailGraph = {
    version: 1,
    enabled: true,
    codeExtraction: "nodes",
    nodes: [
      { id: "start", label: "start", kind: "entry", x: 0, y: 0 },
      destinationAi("source", { text: "email.text" }),
      { id: "done", label: "done", kind: "finish", x: 0, y: 0 },
    ],
    edges: [
      { from: "start", to: "source", port: "next" },
      { from: "source", to: "done", port: "next" },
    ],
  };
  const graph = insertFragment(host, actionFragment(true), "source");
  const forwarded: string[] = [];
  const run = await runGraph(graph, { text: "body" }, {
    aiEnabled: false,
    ai: (tasks) =>
      Promise.resolve({
        [tasks[0].node.id]: { destination: "attacker@example.com" },
      }),
    forward: (to) => {
      forwarded.push(to);
      return Promise.resolve();
    },
  });

  assertEquals(run.status, "complete");
  assertEquals(forwarded, ["owner@example.com"]);
});

Deno.test("forward actions cannot precede rules that may deny", () => {
  assertThrows(() =>
    parseGraph({
      version: 1,
      enabled: true,
      codeExtraction: "nodes",
      nodes: [
        { id: "start", label: "start", kind: "entry", x: 0, y: 0 },
        {
          id: "send",
          label: "send",
          kind: "action",
          x: 0,
          y: 0,
          actions: [{ type: "forward", to: "owner@example.com" }],
        },
        { id: "rules", label: "rules", kind: "rules", x: 0, y: 0 },
        { id: "done", label: "done", kind: "finish", x: 0, y: 0 },
      ],
      edges: [
        { from: "start", to: "send", port: "next" },
        { from: "send", to: "rules", port: "next" },
        { from: "rules", to: "done", port: "next" },
      ],
    })
  );
});

Deno.test("forward actions cannot precede policy application that may deny", () => {
  const policy = {
    id: "deny",
    revision: "1",
    name: "deny",
    condition: {
      path: "email.subject",
      operator: "exists" as const,
      value: null,
    },
    success: {
      actions: [{ delivery: "block" as const }],
      branches: [],
    },
    failed: { reasons: [], branches: [] },
  };
  assertThrows(() =>
    parseGraph({
      version: 1,
      enabled: true,
      codeExtraction: "nodes",
      nodes: [
        { id: "start", label: "start", kind: "entry", x: 0, y: 0 },
        {
          id: "checks",
          label: "checks",
          kind: "policies",
          x: 0,
          y: 0,
          policies: { policy },
        },
        {
          id: "send",
          label: "send",
          kind: "action",
          x: 0,
          y: 0,
          actions: [{ type: "forward", to: "owner@example.com" }],
        },
        {
          id: "apply",
          label: "apply",
          kind: "apply",
          x: 0,
          y: 0,
          input: "nodes.checks.actions",
        },
      ],
      edges: [
        { from: "start", to: "checks", port: "next" },
        { from: "checks", to: "send", port: "success" },
        { from: "checks", to: "send", port: "failed" },
        { from: "send", to: "apply", port: "next" },
      ],
    })
  );
});
