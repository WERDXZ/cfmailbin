import { assert, assertEquals, assertThrows } from "@std/assert";
import { parseActionChain } from "../src/graph/actions.ts";
import { type GraphRuntime, runGraph } from "../src/graph/run.ts";
import { parseGraph } from "../src/graph/compile.ts";
import type { MailAction } from "../src/graph/types.ts";
import { actionPolicy } from "./workflow_fixture.ts";
import { processIncomingEmail } from "../src/email/processor.ts";
import { replyToIncoming } from "../src/email/reply.ts";
import { readConfig } from "../src/config.ts";
import { createMemoryBlobStore } from "../src/storage/memory.ts";
import { sqliteStore } from "./storage_fixture.ts";
import { assertRejects } from "@std/assert";

const keep = (retentionDays?: unknown) =>
  ({
    type: "keep",
    ...(retentionDays === undefined ? {} : { retentionDays }),
  }) as MailAction;
const reply = (text: unknown) =>
  ({ type: "reply", text }) as unknown as MailAction;

Deno.test("keep accepts optional literal or bound retention and preflights before delivery", async () => {
  assertEquals(parseActionChain([keep()]), [{ type: "keep" }]);
  for (const days of [0, 3651, "1", null, 1.5]) {
    assertThrows(() => parseActionChain([keep(days)]));
  }
  const graph = actionPolicy([keep(2)]);
  graph.nodes.find((n) => n.kind === "finish")!.label = "end";
  const kept = await runGraph(graph, {}, {
    trial: true,
    ai: () => Promise.resolve({}),
  });
  assertEquals(kept.action, "keep");
  assertEquals(kept.retentionDays, 2);
  const bound = actionPolicy([keep({ ref: "email.subject" }), {
    type: "forward",
    to: "owner@example.com",
  }]);
  let forwards = 0;
  const failed = await runGraph(bound, { subject: "bad" }, {
    ai: () => Promise.resolve({}),
    forward: () => {
      forwards++;
      return Promise.resolve();
    },
  });
  assertEquals(failed.status, "failed");
  assertEquals(forwards, 0);
});

Deno.test("reply chains with keep and forward, trials never send and duplicate replies cannot execute", async () => {
  let replies = 0, forwards = 0;
  const graph = actionPolicy([keep(1), reply({ ref: "email.subject" }), {
    type: "forward",
    to: "owner@example.com",
  }]);
  const runtime = {
    ai: () => Promise.resolve({}),
    reply: (text: string) => {
      assertEquals(text, "received");
      replies++;
      return Promise.resolve();
    },
    forward: () => {
      forwards++;
      return Promise.resolve();
    },
  } as GraphRuntime;
  const result = await runGraph(graph, { subject: "received" }, runtime);
  assertEquals(result.action, "forward");
  assertEquals(result.retentionDays, 1);
  assertEquals([replies, forwards], [1, 1]);
  const trial = await runGraph(graph, { subject: "received" }, {
    ...runtime,
    trial: true,
  });
  assertEquals(trial.status, "complete");
  assertEquals([replies, forwards], [1, 1]);
  assert(trial.actionResults?.every((action) => action.status === "simulated"));
  for (
    const chain of [[reply("one"), reply("two")], [
      reply("hi"),
      { type: "deny", reason: "no" } as MailAction,
    ]]
  ) {
    assertThrows(() => parseGraph(actionPolicy(chain)));
  }
  const acrossNodes = actionPolicy([reply("one")]);
  const end = acrossNodes.nodes.find((n) => n.kind === "finish")!;
  if (end.kind === "finish") end.actions = [reply("two")];
  assertThrows(() => parseGraph(acrossNodes));
});

Deno.test("reply failure is sanitized, never retried, and preserves earlier keep", async () => {
  let attempts = 0;
  const result = await runGraph(actionPolicy([keep(3), reply("Hello")]), {}, {
    ai: () => Promise.resolve({}),
    ...{
      reply: () => {
        attempts++;
        return Promise.reject(new Error("private SMTP diagnostic"));
      },
    },
  });
  assertEquals(attempts, 1);
  assertEquals(result.status, "failed");
  assertEquals(result.action, "keep");
  assertEquals(result.retentionDays, 3);
  assertEquals(
    JSON.stringify(result).includes("private SMTP diagnostic"),
    false,
  );
  assertEquals(result.actionResults?.map((a) => a.type), ["keep"]);
});

Deno.test("native reply uses the original conversation, persists keep retention and audits without the reply body", async () => {
  const fixture = sqliteStore(), blobs = createMemoryBlobStore();
  try {
    let replied = 0;
    const result = await processIncomingEmail({
      store: fixture.store,
      blobStore: blobs,
      graph: actionPolicy([keep(2), reply("Private reply body\n第二行")]),
      config: readConfig({ CFMAILBIN_ALLOW_CATCH_ALL: "true" }),
      message: {
        from: "sender@example.com",
        to: "inbox@example.com",
        headers: new Headers({
          subject: "Hello",
          "message-id": "<original@example.com>",
          "reply-to": "attacker@example.com",
        }),
        raw: new Response("Subject: Hello\r\n\r\nOriginal text").body!,
        forward: () => Promise.resolve(),
        setReject() {
          throw new Error("must not reject");
        },
        reply: async (outgoing) => {
          const [stored] = await fixture.store.listMessages();
          assert(await blobs.get(stored.rawKey!));
          assertEquals(
            Date.parse(stored.expiresAt) - Date.parse(stored.receivedAt),
            2 * 86400000,
          );
          assertEquals(outgoing, {
            from: "inbox@example.com",
            subject: "Re: Hello",
            text: "Private reply body\n第二行",
            headers: {
              "Auto-Submitted": "auto-replied",
            },
          });
          // Native reply() owns the recipient; no Reply-To or model-supplied address is forwarded.
          assertEquals("to" in outgoing, false);
          replied++;
        },
      },
    });
    assertEquals(replied, 1);
    const saved = await fixture.store.getMessage(result.messageId!);
    assertEquals(saved?.graphRun?.status, "complete");
    assertEquals(saved?.graphRun?.actionResults?.map((a) => a.type), [
      "keep",
      "reply",
    ]);
    const audits = await fixture.store.listAuditEvents();
    assert(audits.some((a) => a.eventType === "replied"));
    assertEquals(JSON.stringify(audits).includes("Private reply body"), false);
  } finally {
    fixture.close();
  }
});

Deno.test("native replies reject automated senders and do not propagate unsafe thread headers", async () => {
  let sent = 0;
  const message = {
    from: "sender@example.com",
    to: "inbox@example.com",
    headers: new Headers({ "auto-submitted": "auto-replied" }),
    raw: new Response("").body!,
    forward: () => Promise.resolve(),
    setReject() {},
    reply: () => {
      sent++;
      return Promise.resolve();
    },
  };
  await assertRejects(
    () => replyToIncoming(message, "Hello"),
    Error,
    "回复循环",
  );
  await assertRejects(() =>
    replyToIncoming({ ...message, from: "", headers: new Headers() }, "Hello")
  );
  assertEquals(sent, 0);
  await replyToIncoming({
    ...message,
    headers: new Headers({
      subject: "Re: Existing",
      "message-id": "not-a-message-id",
    }),
    reply: (outgoing) => {
      assertEquals(outgoing.subject, "Re: Existing");
      assertEquals(outgoing.headers?.["In-Reply-To"], undefined);
      return Promise.resolve();
    },
  }, "Hello");
});
