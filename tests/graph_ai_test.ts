import { assert, assertEquals } from "@std/assert";
import { graphTemplate } from "../src/graph/templates.ts";
import { graphAi } from "../src/graph/ai.ts";
import { runGraph } from "../src/graph/run.ts";
import { readConfig } from "../src/config.ts";
import { createMemoryStore } from "../src/storage/memory.ts";
import { gatewayEnv } from "./analysis_fixture.ts";

const email = {
  subject: "Test",
  text: "Shared email body",
  from: "sender@example.com",
  to: "inbox@example.com",
  codes: [],
  truncated: false,
};
function twoTasks() {
  const graph = graphTemplate("classification");
  const first = graph.nodes.find((n) => n.kind === "ai")!;
  if (first.kind !== "ai") throw new Error("fixture");
  first.batchGroup = "shared";
  graph.nodes.push({
    ...structuredClone(first),
    id: "second",
    label: "Second task",
  });
  graph.edges.find((e) => e.from === "classify")!.to = "second";
  graph.edges.push({ from: "second", port: "next", to: "match" });
  return graph;
}
Deno.test("AI batch sends one shared input and consumes one quota unit; invalid members fail the whole batch and follow the explicit fallback", async () => {
  for (const invalid of [false, true]) {
    const store = createMemoryStore();
    let calls = 0;
    const config = readConfig({
      ...gatewayEnv,
      CFMAILBIN_AI_ENABLED: "true",
      CFMAILBIN_AI_DAILY_LIMIT: "1",
    });
    const run = await runGraph(twoTasks(), email, {
      ai: graphAi(config, store, (_url, init) => {
        calls++;
        const body = JSON.parse(init.body as string);
        assertEquals(body.messages[1].content.split(email.text).length - 1, 1);
        const input = JSON.parse(body.messages[1].content);
        assertEquals(input.tasks.classify.text, input.tasks.second.text);
        assertEquals(init.redirect, "manual");
        const data = {
          classify: { category: "verification", summary: "test" },
          second: {
            category: invalid ? "unexpected" : "account",
            summary: "test",
          },
        };
        return Promise.resolve(
          Response.json({
            choices: [{
              finish_reason: "stop",
              message: { content: JSON.stringify(data) },
            }],
          }),
        );
      }),
    });
    assertEquals(calls, 1);
    assertEquals(run.status, "complete");
    assertEquals(
      await store.reserveAnalysisCall(new Date().toISOString().slice(0, 10), 1),
      false,
    );
    if (invalid) {
      assert(
        run.steps.filter((step) => ["classify", "second"].includes(step.nodeId))
          .every((step) => step.status === "failed"),
      );
      assertEquals(run.action, "keep");
    } else {assertEquals(
        run.steps.find((step) => step.nodeId === "second")?.batch,
        ["classify", "second"],
      );}
  }
});
Deno.test("dependent adjacent nodes remain two calls and receive the earlier output", async () => {
  const graph = twoTasks();
  const second = graph.nodes.find((node) => node.id === "second")!;
  if (second.kind !== "ai") throw new Error("fixture");
  second.inputs = { category: "nodes.classify.data?.category" };
  let calls = 0;
  const run = await runGraph(graph, email, {
    ai: (tasks) => {
      calls++;
      assertEquals(tasks.length, 1);
      if (calls === 2) assertEquals(tasks[0].input.category, "verification");
      return Promise.resolve({
        [tasks[0].node.id]: { category: "verification", summary: "test" },
      });
    },
  });
  assertEquals(calls, 2);
  assertEquals(run.status, "complete");
});
Deno.test("optimizer removes unreachable tasks and never crosses a branch", async () => {
  const graph = graphTemplate("classification");
  const ai = graph.nodes.find((node) => node.kind === "ai")!;
  if (ai.kind !== "ai") throw new Error("fixture");
  ai.batchGroup = "shared";
  graph.nodes.push({ ...structuredClone(ai), id: "branch" }, {
    ...structuredClone(ai),
    id: "unused",
  });
  graph.edges.find((edge) =>
    edge.from === "match" && edge.port === "case:verification"
  )!.to = "branch";
  graph.edges.push({ from: "branch", to: "important", port: "next" }, {
    from: "unused",
    to: "done",
    port: "next",
  });
  const called: string[] = [];
  const run = await runGraph(graph, email, {
    ai: (tasks) => {
      called.push(...tasks.map((task) => task.node.id));
      return Promise.resolve({
        [tasks[0].node.id]: { category: "marketing", summary: "test" },
      });
    },
  });
  assertEquals(called, ["classify"]);
  assertEquals(run.steps.at(-1)?.nodeId, "done");
});
