import { assertEquals, assertThrows } from "@std/assert";
import { parseGraph } from "../src/graph/compile.ts";
import { runGraph } from "../src/graph/run.ts";
import { graphTemplate } from "../src/graph/templates.ts";
import type { MailAction } from "../src/graph/types.ts";
import { processIncomingEmail } from "../src/email/processor.ts";
import { readConfig } from "../src/config.ts";
import {
  createMemoryBlobStore,
  createMemoryStore,
} from "../src/storage/memory.ts";

function finishing(actions?: MailAction[]) {
  const graph = graphTemplate();
  Object.assign(graph.nodes.find((n) => n.kind === "finish")!, { actions });
  return graph;
}

Deno.test("finish executes optional actions through the shared chain and still defaults to reject", async () => {
  for (
    const [actions, expected] of [
      [undefined, "block"],
      [[], "block"],
      [[{ type: "tag", tags: ["test"] }], "block"],
      [[{ type: "keep" }], "keep"],
      [[{ type: "trash" }], "trash"],
      [[{ type: "deny", reason: "Untrusted" }], "block"],
    ] as [MailAction[] | undefined, string][]
  ) {
    const run = await runGraph(finishing(actions), {}, {
      trial: true,
      ai: () => Promise.resolve({}),
    });
    assertEquals(run.status, "complete");
    assertEquals(run.action, expected);
    assertEquals(run.actionResults?.every((a) => a.nodeId === "done"), true);
  }
});

Deno.test("finish forwarding resolves upstream data, checkpoints and does not run native effects during trials", async () => {
  const graph = finishing([{ type: "tag", tags: ["account"] }, {
    type: "forward",
    to: { ref: "current.parent.destination" },
  }]);
  graph.nodes.push({
    id: "source",
    label: "Source",
    x: 0,
    y: 100,
    kind: "ai",
    prompt: "Return destination",
    inputs: {},
    batchGroup: "",
    schema: {
      type: "object",
      properties: { destination: { type: "string" } },
      required: ["destination"],
      additionalProperties: false,
    },
  });
  graph.edges = [{ from: "start", to: "source", port: "next" }, {
    from: "source",
    to: "done",
    port: "next",
  }];
  for (const trial of [true, false]) {
    const events: string[] = [];
    const run = await runGraph(graph, {}, {
      trial,
      ai: () =>
        Promise.resolve({ source: { destination: "owner@example.com" } }),
      checkpoint: (run, beforeEffect) => {
        if (beforeEffect) events.push(run.forwardTo ? "stored" : "before");
        return Promise.resolve();
      },
      forward: (to) => {
        events.push(to);
        return Promise.resolve();
      },
    });
    assertEquals(run.action, "forward");
    assertEquals(run.tags, ["account"]);
    assertEquals(
      events,
      trial ? ["stored"] : ["before", "owner@example.com", "stored"],
    );
    assertEquals(run.actionResults?.at(-1)?.nodeId, "done");
  }
});

Deno.test("finish actions receive the same binding, validation and forward/deny safeguards as action nodes", () => {
  for (
    const actions of [
      [{ type: "forward", to: "invalid" }],
      [{ type: "forward", to: { ref: "nodes.missing.destination" } }],
      [{ type: "forward", to: "owner@example.com" }, {
        type: "deny",
        reason: "No",
      }],
    ] as MailAction[][]
  ) assertThrows(() => parseGraph(finishing(actions)));
  const graph = finishing([{ type: "deny", reason: "No" }]);
  graph.nodes.push({
    id: "forward",
    label: "Forward",
    kind: "action",
    x: 0,
    y: 100,
    actions: [{ type: "forward", to: "owner@example.com" }],
  });
  graph.edges = [{ from: "start", to: "forward", port: "next" }, {
    from: "forward",
    to: "done",
    port: "next",
  }];
  assertThrows(() => parseGraph(graph));
  const wiredFinish = finishing([{ type: "keep" }]);
  wiredFinish.edges.push({ from: "done", to: "start", port: "next" });
  assertThrows(() => parseGraph(wiredFinish));
});

Deno.test("intake stores mail before a finish forward and records the terminal outcome", async () => {
  const store = createMemoryStore(), blobStore = createMemoryBlobStore();
  const graph = finishing([{ type: "forward", to: "owner@example.com" }]);
  graph.enabled = true;
  let forwards = 0;
  const received = await processIncomingEmail({
    config: readConfig({ CFMAILBIN_ALLOW_CATCH_ALL: "true" }),
    store,
    blobStore,
    graph,
    message: {
      from: "sender@example.com",
      to: "test@example.com",
      headers: new Headers({ subject: "Test" }),
      raw: new Response("Subject: Test\r\n\r\nHello").body!,
      setReject: () => {
        throw new Error("must accept");
      },
      forward: async (to) => {
        assertEquals(to, "owner@example.com");
        const message = (await store.listMessages())[0];
        assertEquals(!!await blobStore.get(message.rawKey!), true);
        forwards++;
      },
    },
  });
  assertEquals(forwards, 1);
  const message = await store.getMessage(received.messageId!);
  assertEquals(message?.status, "forwarded");
  assertEquals(message?.graphRun?.steps.at(-1)?.nodeId, "done");
  assertEquals(message?.graphRun?.actionResults?.at(-1)?.type, "forward");
});
