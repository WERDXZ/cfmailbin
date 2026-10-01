import { actionPolicy } from "./workflow_fixture.ts";
import { assert, assertEquals } from "@std/assert";
import { processIncomingEmail } from "../src/email/processor.ts";
import { createMemoryBlobStore } from "../src/storage/memory.ts";
import { sqliteStore } from "./storage_fixture.ts";
import { graphTemplate } from "../src/graph/templates.ts";
import { readConfig } from "../src/config.ts";
import { gatewayEnv } from "./analysis_fixture.ts";
import { handleRequest } from "../src/app.ts";
import { createGraphStore } from "../src/graph/storage.ts";

Deno.test("deleting mail while graph AI is running prevents later forwarding", async () => {
  const fixture = sqliteStore();
  try {
    const graph = graphTemplate("classification");
    graph.enabled = true;
    const target = graph.nodes.find((n) => n.id === "important")!;
    if (target.kind === "action") {
      target.actions.push({ type: "forward", to: "owner@example.com" });
    }
    let forwarded = 0;
    await processIncomingEmail({
      graph,
      store: fixture.store,
      blobStore: createMemoryBlobStore(),
      config: readConfig({
        ...gatewayEnv,
        CFMAILBIN_ALLOW_CATCH_ALL: "true",
        CFMAILBIN_AI_ENABLED: "true",
      }),
      message: {
        from: "sender@example.com",
        to: "test@example.com",
        headers: new Headers(),
        raw: new Response("Subject: Test\r\n\r\nHello").body!,
        setReject() {},
        forward() {
          forwarded++;
          return Promise.resolve();
        },
      },
      analysisFetch: async () => {
        const messages = await fixture.store.listMessages();
        await fixture.store.deleteMessages(
          messages.map((message) => message.id),
        );
        return Response.json({
          choices: [{
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                classify: { category: "verification", summary: "test" },
              }),
            },
          }],
        });
      },
    });
    assertEquals(forwarded, 0);
    assertEquals(await fixture.store.listMessages(), []);
  } finally {
    fixture.close();
  }
});

Deno.test("D1 graph intake persists raw mail first, applies AI-driven forwarding and records trace", async () => {
  const fixture = sqliteStore();
  try {
    const blobStore = createMemoryBlobStore();
    const graph = graphTemplate("classification");
    graph.enabled = true;
    graph.revision = "test-revision";
    const target = graph.nodes.find((n) => n.id === "important")!;
    if (target.kind === "action") {
      target.actions.push({ type: "forward", to: "owner@example.com" });
    }
    let forwarded = 0;
    const result = await processIncomingEmail({
      graph,
      store: fixture.store,
      blobStore,
      config: readConfig({
        ...gatewayEnv,
        CFMAILBIN_ALLOW_CATCH_ALL: "true",
        CFMAILBIN_AI_ENABLED: "true",
      }),
      message: {
        from: "test@example.org",
        to: "test@example.com",
        headers: new Headers({ subject: "Hello" }),
        raw: new Response("Subject: Hello\r\n\r\nThis is a test").body!,
        setReject: () => {
          throw new Error("must keep");
        },
        forward: async () => {
          const [saved] = await fixture.store.listMessages();
          assert(await blobStore.get(saved.rawKey!));
          assertEquals(saved.graphRun?.steps.at(-1)?.nodeId, "match");
          forwarded++;
        },
      },
      analysisFetch: () =>
        Promise.resolve(
          Response.json({
            choices: [{
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  classify: { category: "verification", summary: "test" },
                }),
              },
            }],
          }),
        ),
    });
    const saved = (await fixture.store.getMessage(result.messageId!))!;
    assertEquals(forwarded, 1);
    assertEquals(saved.status, "forwarded");
    assertEquals(saved.forwardedTo, "owner@example.com");
    assertEquals(saved.tags, ["验证码类"]);
    assertEquals(saved.graphRun?.status, "complete");
    assertEquals(saved.graphRun?.revision, "test-revision");
    assertEquals(
      Date.parse(saved.expiresAt) - Date.parse(saved.receivedAt),
      86400000,
    );
  } finally {
    fixture.close();
  }
});

Deno.test("graph API persists versioned configuration, denies cross-origin writes and isolates trials", async () => {
  const fixture = sqliteStore();
  try {
    const backend = {
      store: fixture.store,
      blobStore: createMemoryBlobStore(),
      graph: createGraphStore(),
      config: readConfig(),
      developmentSession: {
        mode: "development" as const,
        email: "owner@example.com",
      },
    };
    const graph = actionPolicy([{ type: "forward", to: "owner@example.com" }]);
    const request = (
      path: string,
      body: unknown,
      method = "POST",
      origin = "http://localhost",
    ) =>
      handleRequest(
        new Request(`http://localhost${path}`, {
          method,
          headers: {
            "x-cfmailbin-request": "1",
            "content-type": "application/json",
            origin,
          },
          body: JSON.stringify(body),
        }),
        backend,
      );
    assertEquals(
      (await request("/api/graph", graph, "PUT", "https://evil.example"))
        .status,
      403,
    );
    assertEquals(await backend.graph.get(), null);
    const save = await request("/api/graph", graph, "PUT");
    assertEquals(save.status, 200);
    assert((await save.json()).graph.revision);
    const response = await request("/api/graph/preview", {
      graph,
      sample: { subject: "test", text: "hello" },
    });
    assertEquals(response.status, 200);
    const run = await response.json();
    assertEquals(run.trial, true);
    assertEquals(run.action, "forward");
    assertEquals(await fixture.store.listMessages(), []);
    assertEquals(
      (await fixture.store.listAuditEvents()).map((e) => e.eventType).sort(),
      ["configuration_changed", "workflow_trial"],
    );
    const bad = structuredClone(graph);
    bad.edges[0].to = "absent";
    assertEquals((await request("/api/graph", bad, "PUT")).status, 400);
    const unauth = await handleRequest(
      new Request("https://example.com/api/graph"),
      { ...backend, developmentSession: undefined },
    );
    assert(unauth.status === 401 || unauth.status === 503);
  } finally {
    fixture.close();
  }
});
