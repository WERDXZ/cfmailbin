import { legacyReceiptPolicy } from "./workflow_fixture.ts";
import { assert, assertEquals, assertThrows } from "@std/assert";
import { graphTemplate } from "../src/graph/templates.ts";
import { parseGraph, parseNode } from "../src/graph/compile.ts";
import { runGraph } from "../src/graph/run.ts";
import { matchesCondition, parseCondition } from "../src/graph/conditions.ts";
import { builtInPresets, usePreset } from "../src/graph/library.ts";
import { createGraphStore } from "../src/graph/storage.ts";
import { graphEmail } from "../src/graph/process.ts";
import { findVerificationCodes } from "../src/email/content.ts";
import { AnalysisError } from "../src/email/analysis.ts";
import { GraphAiLimitError } from "../src/graph/types.ts";

const email = (text = "Please sign in using 123456.") =>
  graphEmail(
    {
      subject: "Verification code",
      text,
      codes: findVerificationCodes(text, "Verification code"),
      links: [],
      truncated: false,
    },
    "sender@example.com",
    "me@example.com",
  );
const decision = {
  action: "forward" as const,
  forwardTo: "owner@example.com",
  retentionDays: 1,
  tags: ["custom"],
  matchedRuleId: null,
  trace: [],
};

Deno.test("new policies extract only through nodes while old graphs retain automatic codes", async () => {
  const graph = { ...graphTemplate(), version: 1 as const };
  const runtime = { ai: () => Promise.resolve({}) };
  const content = email("Your verification code is 001234.");
  assertEquals((await runGraph(graph, content, runtime)).codes, []);
  delete graph.codeExtraction;
  assertEquals((await runGraph(graph, content, runtime)).codes, ["001234"]);
  const repeated = legacyReceiptPolicy();
  repeated.nodes[repeated.nodes.length - 1] = {
    id: "done",
    label: "another delivery",
    x: 0,
    y: 0,
    kind: "delivery",
    action: "keep",
    forwardTo: "",
    tags: [],
  };
  assertThrows(() => parseGraph(repeated));
});

Deno.test("optional AI preserves safe diagnostics and distinguishes exhausted quota from failed recognition", async () => {
  const run = (error: Error) =>
    runGraph(legacyReceiptPolicy(), email(), {
      provider: "deepseek",
      trial: true,
      rules: () => Promise.resolve(decision),
      ai: () => Promise.reject(error),
    });
  const failed = await run(
    new AnalysisError("authentication", 403, "request", 123),
  );
  assertEquals(failed.analysis?.httpStatus, 403);
  assertEquals(failed.analysis?.durationMs, 123);
  assertEquals(failed.status, "complete");
  const quota = await run(new GraphAiLimitError());
  assertEquals(quota.analysis?.status, "skipped");
  assertEquals(quota.analysis?.reason, "daily_limit");
  assertEquals(
    quota.steps.find((step) => step.nodeId === "enrich")?.status,
    "skipped",
  );
});

Deno.test("nested keyword conditions ignore case without pretending to extract a code", () => {
  const preset =
    builtInPresets.find((p) => p.id === "builtin_verification_keywords")!.node;
  assert(preset.kind === "condition");
  assert(
    matchesCondition(
      preset.condition!,
      (path) => path === "email.subject" ? "VERIFICATION Code" : "no code here",
    ),
  );
  const both = parseCondition({
    all: [preset.condition, {
      not: { path: "email.text", operator: "contains", value: "marketing" },
    }],
  });
  assert(
    !matchesCondition(
      both,
      (path) => path === "email.subject" ? "verification code" : "MARKETING",
    ),
  );
  assertEquals(
    findVerificationCodes(
      "Please invent a verification code",
      "Verification code",
    ),
    [],
  );
  assertThrows(() => parseCondition({ all: [] }));
  assertThrows(() =>
    parseNode({
      ...preset,
      condition: {
        all: [{
          path: "nodes.__proto__.secret",
          operator: "exists",
          value: null,
        }],
      },
    })
  );
});

Deno.test("historical v1 policy forwards before optional AI, skips paid work with local codes and never replays rules", async () => {
  const events: string[] = [];
  const graph = parseGraph(legacyReceiptPolicy());
  const result = await runGraph(graph, email(), {
    aiEnabled: true,
    provider: "deepseek",
    rules: (codes) => {
      events.push(`rules:${codes.length}`);
      return Promise.resolve(decision);
    },
    forward: () => {
      events.push("forward");
      return Promise.resolve();
    },
    ai: () => {
      events.push("ai");
      throw new Error("upstream body must stay private");
    },
  });
  assertEquals(events, ["rules:0", "forward", "ai"]);
  assertEquals(result.status, "complete");
  assertEquals(result.forwardTo, decision.forwardTo);
  assertEquals(
    result.steps.find((s) => s.nodeId === "enrich")?.error,
    "节点执行失败",
  );
  events.length = 0;
  const local = await runGraph(
    graph,
    email("Your verification code is 001234."),
    {
      rules: (codes) => {
        assertEquals(codes, ["001234"]);
        return Promise.resolve(decision);
      },
      trial: true,
      ai: () => {
        throw new Error("must not call AI");
      },
    },
  );
  assertEquals(
    local.steps.find((s) => s.nodeId === "enrich")?.status,
    "skipped",
  );
  assertEquals(local.codes, ["001234"]);
});

Deno.test("AI code binding rejects invented codes, persists real codes, and optional outputs cannot be dependencies", async () => {
  const graph = legacyReceiptPolicy();
  const run = (code: string) =>
    runGraph(graph, email(), {
      trial: true,
      rules: () => Promise.resolve(decision),
      ai: () =>
        Promise.resolve({
          enrich: {
            category: "verification",
            hasCode: true,
            codes: [{ value: code, context: `Please sign in using ${code}.` }],
          },
        }),
    });
  assertEquals((await run("123456")).codes, ["123456"]);
  const invented = await run("999999");
  assertEquals(invented.codes, []);
  assertEquals(
    invented.steps.find((s) => s.nodeId === "enrich")?.status,
    "failed",
  );
  const finish = graph.nodes.at(-1)!;
  graph.nodes[graph.nodes.length - 1] = {
    ...finish,
    kind: "condition",
    path: "nodes.enrich.hasCode",
    operator: "equals",
    value: true,
  };
  graph.nodes.push({ id: "end", label: "end", x: 0, y: 0, kind: "finish" });
  graph.edges.push({ from: "done", to: "end", port: "yes" }, {
    from: "done",
    to: "end",
    port: "no",
  });
  assertThrows(() => parseGraph(graph));
});

Deno.test("KV node library retains policy snapshots until explicitly updated", async () => {
  const kv = new Map<string, string>();
  const store = createGraphStore({
    get: (key) => Promise.resolve(kv.get(key) ?? null),
    put: (key, value) => {
      kv.set(key, value);
      return Promise.resolve();
    },
  });
  const preset = {
    ...builtInPresets.find((p) => p.id === "builtin_policy_checks")!,
    id: "custom",
    revision: "v1",
  };
  await store.putLibrary([preset]);
  const node = usePreset(preset, { id: "match", x: 10, y: 20 });
  await store.putLibrary([{
    ...preset,
    revision: "v2",
    node: { ...preset.node, label: "Updated" },
  }]);
  assertEquals(node.label, preset.node.label);
  const updated = usePreset((await store.getLibrary())[0], node);
  assertEquals(updated.id, node.id);
  assertEquals(updated.preset?.revision, "v2");
  assertEquals(updated.label, "Updated");
});
