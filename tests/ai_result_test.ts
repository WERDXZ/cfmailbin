import { assertEquals, assertThrows } from "@std/assert";
import { AnalysisError } from "../src/email/analysis.ts";
import { compileGraph, parseNode } from "../src/graph/compile.ts";
import { runGraph } from "../src/graph/run.ts";
import { collectCodes } from "../src/graph/text-operations.ts";
import { GraphAiLimitError, type MailGraph } from "../src/graph/types.ts";
import { graphTemplate } from "../src/graph/templates.ts";

function flow(): MailGraph {
  const base = { x: 0, y: 0, label: "test" };
  return {
    version: 2,
    enabled: false,
    nodes: [
      { ...base, id: "start", kind: "entry" },
      {
        ...base,
        id: "ai",
        kind: "ai",
        prompt: "Extract data",
        inputs: { text: "email.text" },
        batchGroup: "",
        ...{ resultFormat: "envelope" as const },
        schema: {
          type: "object",
          properties: { summary: { type: "string" } },
          required: ["summary"],
          additionalProperties: false,
        },
      },
      {
        ...base,
        id: "if",
        kind: "condition",
        unknown: true,
        path: "current.parent.success",
        operator: "equals",
        value: true,
      },
      { ...base, id: "keep", kind: "finish", actions: [{ type: "keep" }] },
      { ...base, id: "deny", kind: "finish" },
    ],
    edges: [
      { from: "start", to: "ai", port: "next" },
      { from: "ai", to: "if", port: "next" },
      { from: "if", to: "keep", port: "yes" },
      { from: "if", to: "deny", port: "no" },
      { from: "if", to: "deny", port: "unknown" },
    ],
  };
}

Deno.test("AI uses the remaining configured workflow budget even after 25 seconds", async () => {
  const now = Date.now;
  let elapsed = 0;
  Date.now = () => 1_000_000 + elapsed;
  try {
    for (const delay of [0, 30_000, 119_000, 120_000]) {
      elapsed = 0;
      const timeouts: number[] = [];
      const run = await runGraph(flow(), { text: "hello" }, {
        trial: true,
        aiTimeoutMs: 120_000,
        checkpoint: () => {
          elapsed = delay;
          return Promise.resolve();
        },
        ai: (_tasks, timeout) => {
          timeouts.push(timeout);
          return Promise.resolve({ ai: { summary: "ok" } });
        },
      });
      assertEquals(run.status, "complete");
      assertEquals(timeouts, delay < 120_000 ? [120_000 - delay] : []);
      assertEquals(run.action, delay < 120_000 ? "keep" : "block");
    }
  } finally {
    Date.now = now;
  }
});

Deno.test("AI returns a generic result; IF decides whether to accept mail", async () => {
  const run = await runGraph(flow(), { text: "hello" }, {
    trial: true,
    ai: () => Promise.resolve({ ai: { summary: "ok" } }),
  });
  assertEquals(run.action, "keep");
  assertEquals(run.steps.find((s) => s.nodeId === "ai")?.output, {
    success: true,
    data: { summary: "ok" },
    error: null,
  });
  for (
    const [error, reason] of [[new AnalysisError("timeout"), "timeout"], [
      new GraphAiLimitError(),
      "daily_limit",
    ], [new Error("secret response body"), "unavailable"]] as const
  ) {
    const failed = await runGraph(flow(), { text: "hello" }, {
      trial: true,
      ai: () => Promise.reject(error),
    });
    assertEquals(failed.status, "complete");
    assertEquals(failed.action, "block");
    const output = failed.steps.find((s) => s.nodeId === "ai")?.output;
    assertEquals(
      (output as { error: { reason: string } }).error.reason,
      reason,
    );
    assertEquals(
      JSON.stringify(failed).includes("secret response body"),
      false,
    );
  }
  const providerFailure = await runGraph(flow(), { text: "hello" }, {
    trial: true,
    ai: () => Promise.reject(new AnalysisError("service_error", 503)),
  });
  const providerStep = providerFailure.steps.find((step) =>
    step.nodeId === "ai"
  );
  assertEquals(providerStep?.errorCode, "common.aiServiceError");
  assertEquals(providerStep?.errorParams, { httpStatus: 503 });
  const disabled = await runGraph(flow(), { text: "hello" }, {
    trial: true,
    aiEnabled: false,
    ai: () => {
      throw new Error("must not call");
    },
  });
  assertEquals(disabled.action, "block");
  assertEquals(
    disabled.steps.find((s) => s.nodeId === "ai")?.status,
    "skipped",
  );
});

Deno.test("AI output schema errors become failed results, checkpoint failures still stop execution", async () => {
  const invalid = await runGraph(flow(), { text: "hello" }, {
    trial: true,
    ai: () => Promise.resolve({ ai: { summary: 42 } }),
  });
  assertEquals(invalid.action, "block");
  assertEquals(
    (invalid.steps[1].output as { error: { reason: string } }).error.reason,
    "invalid_response",
  );
  const storage = await runGraph(flow(), { text: "hello" }, {
    trial: true,
    ai: () => Promise.resolve({ ai: { summary: "ok" } }),
    checkpoint: (run) => {
      if (run.steps.at(-1)?.nodeId === "ai") throw new Error("deleted");
      return Promise.resolve();
    },
  });
  assertEquals(storage.status, "failed");
  assertEquals(storage.action, undefined);
});

Deno.test("new AI contracts reject legacy execution flags and invalid result formats", () => {
  const ai = flow().nodes[1];
  for (
    const extra of [{ optional: true }, { onlyWhenMissingCodes: true }, {
      outputMode: "verification",
    }, { resultFormat: "other" }]
  ) {
    assertThrows(() => parseNode({ ...ai, ...extra }));
  }
  const graph = flow();
  const check = graph.nodes[2];
  if (check.kind !== "condition") throw new Error("fixture");
  check.path = "nodes.ai.data.summary";
  assertThrows(() => compileGraph(graph), Error, "?.");
  check.path = "nodes.ai.data?.summary";
  compileGraph(graph);
});

Deno.test("output accepts AI candidates only with exact source evidence", () => {
  const source = "Enter 001-234 to sign in.";
  assertEquals(
    collectCodes([{ value: "001-234", context: source }], source, 3),
    ["001234"],
  );
  for (
    const candidates of [
      [{ value: "999999", context: source }],
      [{ value: "001-234", context: "made up context" }],
      [{ value: "001-234" }],
      [{ value: "001-234", context: "" }],
    ]
  ) assertThrows(() => collectCodes(candidates, source, 3));
});

Deno.test("verification template uses ordinary IF, AI and output nodes without hidden AI options", async () => {
  const graph = graphTemplate("verification");
  const ai = graph.nodes.find((n) => n.kind === "ai")!;
  if (ai.kind !== "ai") throw new Error("fixture");
  assertEquals([ai.optional, ai.onlyWhenMissingCodes, ai.outputMode], [
    undefined,
    undefined,
    undefined,
  ]);
  let calls = 0;
  const runtime = {
    trial: true,
    aiTimeoutMs: 7000,
    ai: (tasks: import("../src/graph/run.ts").AiTask[], timeout: number) => {
      calls++;
      assertEquals(timeout > 0 && timeout <= 7000, true);
      return Promise.resolve({
        [tasks[0].node.id]: {
          codes: [{ value: "001234", context: "Enter 001234 to sign in." }],
        },
      });
    },
  };
  // No local keyword pattern here: the AI candidate has to pass the output node.
  const run = await runGraph(graph, {
    subject: "Hello",
    text: "Enter 001234 to sign in.",
    unavailable: false,
    truncated: false,
  }, runtime);
  assertEquals(calls, 1);
  assertEquals(run.codes, ["001234"]);
  assertEquals(run.action, "keep");
  assertEquals(
    run.steps.find((s) => s.nodeId === "aiCodes")?.status,
    "complete",
  );
  for (
    const input of [
      {
        subject: "Verification code",
        text: "Your verification code is 001234.",
        unavailable: false,
      },
      { subject: "", text: "", unavailable: false },
      { subject: "Hello", text: "content", unavailable: true },
    ]
  ) {
    const skipped = await runGraph(
      graph,
      { ...input, truncated: false },
      runtime,
    );
    assertEquals(skipped.action, "keep");
    assertEquals(calls, 1);
  }
  const noBudget = await runGraph(graph, {
    subject: "Hello",
    text: "plain text",
    truncated: false,
  }, { ...runtime, aiTimeoutMs: 0 });
  assertEquals(noBudget.action, "keep");
  assertEquals(calls, 1);
  assertEquals(
    (noBudget.steps.find((s) => s.nodeId === "enrich")?.output as {
      error: { reason: string };
    }).error.reason,
    "timeout",
  );
});
