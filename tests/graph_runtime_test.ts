import { assertEquals } from "@std/assert";
import { runGraph } from "../src/graph/run.ts";
import { graphTemplate } from "../src/graph/templates.ts";

const email = {
  subject: "Hello",
  text: "Test",
  from: "sender@example.com",
  to: "test@example.com",
  codes: [],
  truncated: false,
};
function forwardingGraph() {
  const graph = graphTemplate("classification");
  const node = graph.nodes.find((node) => node.id === "important")!;
  if (node.kind === "action") {
    node.actions.push({ type: "forward", to: "owner@example.com" });
  }
  return graph;
}
Deno.test("graph uses completed AI output before exactly one native forward", async () => {
  let forwarded = 0;
  const run = await runGraph(forwardingGraph(), email, {
    ai: () =>
      Promise.resolve({
        classify: { category: "verification", summary: "test" },
      }),
    forward: () => {
      forwarded++;
      return Promise.resolve();
    },
  });
  assertEquals(forwarded, 1);
  assertEquals(run.status, "complete");
  assertEquals(run.action, "forward");
  assertEquals(run.retentionDays, 1);
  assertEquals(run.steps.map((s) => s.nodeId), [
    "start",
    "classify",
    "match",
    "important",
    "done",
  ]);
});
Deno.test("failed or invalid AI follows Match fallback and retains mail; dry runs never forward", async () => {
  let forwarded = 0;
  for (
    const ai of [
      () => Promise.reject(new Error("secret upstream body")),
      () =>
        Promise.resolve({ classify: { category: "invented", summary: "bad" } }),
    ]
  ) {
    const run = await runGraph(forwardingGraph(), email, {
      ai,
      forward: () => {
        forwarded++;
        return Promise.resolve();
      },
    });
    assertEquals(run.status, "complete");
    assertEquals(run.action, "keep");
    assertEquals(
      run.steps.find((step) => step.nodeId === "classify")?.status,
      "failed",
    );
    assertEquals(JSON.stringify(run).includes("secret upstream body"), false);
  }
  const trial = await runGraph(forwardingGraph(), email, {
    trial: true,
    ai: () =>
      Promise.resolve({
        classify: { category: "verification", summary: "test" },
      }),
    forward: () => {
      forwarded++;
      return Promise.resolve();
    },
  });
  assertEquals(trial.status, "complete");
  assertEquals(trial.action, "forward");
  assertEquals(forwarded, 0);
});
