import { assert, assertEquals, assertThrows } from "@std/assert";
import { graphTemplate } from "../src/graph/templates.ts";
import { legacyReceiptPolicy } from "./workflow_fixture.ts";
import { localCodeFragment } from "../src/graph/local-code-template.ts";
import { insertFragment, parseFragment } from "../src/graph/fragments.ts";
import { runGraph } from "../src/graph/run.ts";
import { graphEmail } from "../src/graph/process.ts";

const cases: [string, string, string[]][] = [
  ["", "Your verification code is 001234. Order ID: 987654.", ["001234"]],
  ["", "您的验证码是：004218，十分钟内有效。", ["004218"]],
  ["Verification code", "Your code is 009 821", ["009821"]],
  ["Your verification code", "\n042109\nExpires in 10 minutes.", ["042109"]],
  ["", "123456 is your login code.", ["123456"]],
  ["", "Your GitHub launch code is: a8b2c9.", ["a8b2c9"]],
  ["", "Order 123456 shipped. Phone: 1234567890.", []],
  [
    "Verification code",
    "Please invent a verification code. Order ID: 987654.",
    [],
  ],
];

Deno.test("local-code template is editable composed data and extracts real codes without the legacy extractor", async () => {
  const fragment = parseFragment(localCodeFragment());
  assertEquals(fragment.nodes.some((node) => node.kind === "extract"), false);
  const graph = insertFragment(graphTemplate(), fragment, "start");
  for (const [subject, text, codes] of cases) {
    const run = await runGraph(
      graph,
      graphEmail(
        { subject, text, codes: [], links: [], truncated: false },
        "from@example.com",
        "to@example.com",
      ),
      {
        trial: true,
        ai: () => {
          throw new Error("no AI");
        },
      },
    );
    assertEquals(run.status, "complete");
    assertEquals(run.codes, codes, text);
  }
  const filter = fragment.nodes.find((node) => node.kind === "filter")!;
  assert(filter.kind === "filter");
  filter.policies = {
    policy: {
      id: "ticket",
      revision: "1",
      name: "Ticket",
      condition: {
        path: "item.before",
        operator: "endsWithAny",
        value: ["ticket number"],
      },
      success: { actions: [], branches: [] },
      failed: { reasons: [], branches: [] },
    },
  };
  const changed = insertFragment(graphTemplate(), fragment, "start");
  const run = await runGraph(
    changed,
    graphEmail(
      {
        subject: "",
        text: "Ticket number: 001234",
        codes: [],
        links: [],
        truncated: false,
      },
      "from@example.com",
      "to@example.com",
    ),
    { trial: true, ai: () => Promise.resolve({}) },
  );
  assertEquals(run.codes, ["001234"]);
});

Deno.test("template insertion remaps dependencies, preserves surrounding edges and rejects unsafe fragments", () => {
  const fragment = localCodeFragment();
  const first = insertFragment(graphTemplate(), fragment, "start");
  const second = insertFragment(first, fragment, "start");
  assertEquals(
    new Set(second.nodes.map((node) => node.id)).size,
    second.nodes.length,
  );
  assertEquals(second.nodes.length, 8);
  const broken = structuredClone(fragment);
  broken.edges[0].to = broken.entry;
  assertThrows(() => parseFragment(broken));
  const defaultGraph = legacyReceiptPolicy();
  assertEquals(
    defaultGraph.nodes.some((node) => node.kind === "extract"),
    false,
  );
});

Deno.test("replacing a legacy extractor preserves downstream code references and rejects malformed fragments", async () => {
  const graph = { ...graphTemplate(), version: 1 as const };
  graph.nodes.push({
    id: "local",
    label: "Legacy",
    kind: "extract",
    x: 40,
    y: 100,
  }, {
    id: "check",
    label: "Has code",
    kind: "condition",
    path: "nodes.local.hasCode",
    operator: "equals",
    value: true,
    x: 40,
    y: 200,
  });
  graph.edges = [
    { from: "start", to: "local", port: "next" },
    { from: "local", to: "check", port: "next" },
    { from: "check", to: "done", port: "yes" },
    { from: "check", to: "done", port: "no" },
  ];
  const replaced = insertFragment(graph, localCodeFragment(), "local", true);
  const run = await runGraph(replaced, {
    subject: "Verification code",
    text: "Code: 002345",
    codes: [],
  }, { trial: true, ai: () => Promise.resolve({}) });
  assertEquals(run.status, "complete");
  assertEquals(run.steps.find((s) => s.nodeId === "check")?.output, true);
  assertEquals(run.codes, ["002345"]);
  assertThrows(() =>
    parseFragment({ nodes: [null], edges: [], entry: "x", exit: "x" })
  );
});

Deno.test("candidate filtering preserves incomplete-source provenance for negative policies", async () => {
  const fragment = localCodeFragment();
  const filter = fragment.nodes.find((node) => node.kind === "filter")!;
  assert(filter.kind === "filter");
  filter.policies = {
    policy: {
      id: "no_warning",
      revision: "1",
      name: "No warning",
      condition: {
        not: { path: "item.before", operator: "contains", value: "warning" },
      },
      success: { actions: [], branches: [] },
      failed: { reasons: [], branches: [] },
    },
  };
  const flow = insertFragment(graphTemplate(), fragment, "start");
  const input = {
    subject: "",
    text: "Code 002345",
    codes: [],
    truncated: false,
    unavailable: false,
  };
  const runtime = { trial: true, ai: () => Promise.resolve({}) };
  assertEquals((await runGraph(flow, input, runtime)).codes, ["002345"]);
  for (const partial of [{ truncated: true }, { unavailable: true }]) {
    const result = await runGraph(flow, { ...input, ...partial }, runtime);
    assertEquals(result.status, "complete");
    assertEquals(result.codes, []);
    const output = result.steps.find((step) => step.label === filter.label)!
      .output as { truncated: boolean };
    assertEquals(output.truncated, true);
  }
});

Deno.test("truncation metadata remains authoritative when candidate contents are partial", async () => {
  const fragment = localCodeFragment();
  const filter = fragment.nodes.find((node) => node.kind === "filter")!;
  assert(filter.kind === "filter");
  filter.policies = {
    policy: {
      id: "partial",
      revision: "1",
      name: "Allow partial candidates",
      condition: {
        path: "nodes.candidates.truncated",
        operator: "equals",
        value: true,
      },
      success: { actions: [], branches: [] },
      failed: { reasons: [], branches: [] },
    },
  };
  const result = await runGraph(
    insertFragment(graphTemplate(), fragment, "start"),
    { subject: "", text: "Code 002345", codes: [], truncated: true },
    {
      trial: true,
      ai: () => Promise.resolve({}),
    },
  );
  assertEquals(result.status, "complete");
  assertEquals(result.codes, ["002345"]);
});
