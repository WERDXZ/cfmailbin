import { assertEquals, assertRejects } from "@std/assert";
import { processIncomingEmail } from "../src/email/processor.ts";
import {
  createMemoryBlobStore,
  createMemoryStore,
} from "../src/storage/memory.ts";
import { readConfig } from "../src/config.ts";
import { gatewayEnv } from "./analysis_fixture.ts";
import type { GraphNode, MailGraph } from "../src/graph/types.ts";

Deno.test("intake tempfails when persistence stops deny before acceptance", async () => {
  const store = createMemoryStore();
  const failingStore = {
    ...store,
    saveGraphRun() {
      return Promise.reject(new Error("private D1 diagnostic"));
    },
  };
  let rejected = false;

  await assertRejects(() =>
    processIncomingEmail({
      graph: {
        version: 2,
        enabled: true,
        codeExtraction: "nodes",
        nodes: [
          { id: "start", kind: "entry", label: "start", x: 0, y: 0 },
          {
            id: "deny",
            kind: "action",
            label: "deny",
            x: 0,
            y: 100,
            actions: [{ type: "deny", reason: "Policy denied" }],
          },
        ],
        edges: [{ from: "start", to: "deny", port: "next" }],
      },
      store: failingStore,
      blobStore: createMemoryBlobStore(),
      config: readConfig({ CFMAILBIN_ALLOW_CATCH_ALL: "true" }),
      message: {
        from: "sender@example.com",
        to: "inbox@example.com",
        headers: new Headers({ subject: "Test" }),
        raw: new Response("Subject: Test\r\n\r\nHello").body!,
        setReject() {
          rejected = true;
        },
        forward() {
          throw new Error("must not forward");
        },
      },
    })
  );

  assertEquals(rejected, false);
  const [saved] = await store.listMessages();
  assertEquals(saved.graphRun?.status, "failed");
  assertEquals(
    JSON.stringify(saved.graphRun).includes("private D1 diagnostic"),
    false,
  );
});

Deno.test("intake accepts an ambiguous native forward failure without retrying it", async () => {
  const store = createMemoryStore();
  let forwards = 0;
  let rejected = false;
  const result = await processIncomingEmail({
    graph: {
      version: 2,
      enabled: true,
      codeExtraction: "nodes",
      nodes: [
        { id: "start", kind: "entry", label: "start", x: 0, y: 0 },
        {
          id: "forward",
          kind: "action",
          label: "forward",
          x: 0,
          y: 100,
          actions: [{ type: "forward", to: "owner@example.com" }],
        },
        { id: "done", kind: "finish", label: "done", x: 0, y: 200 },
      ],
      edges: [{ from: "start", to: "forward", port: "next" }, {
        from: "forward",
        to: "done",
        port: "next",
      }],
    },
    store,
    blobStore: createMemoryBlobStore(),
    config: readConfig({ CFMAILBIN_ALLOW_CATCH_ALL: "true" }),
    message: {
      from: "sender@example.com",
      to: "inbox@example.com",
      headers: new Headers({ subject: "Test" }),
      raw: new Response("Subject: Test\r\n\r\nHello").body!,
      setReject() {
        rejected = true;
      },
      forward() {
        forwards++;
        return Promise.reject(new Error("private SMTP diagnostic"));
      },
    },
  });

  assertEquals(result.action, "keep");
  assertEquals(result.rejected, false);
  assertEquals(forwards, 1);
  assertEquals(rejected, false);
  const saved = await store.getMessage(result.messageId!);
  assertEquals(saved?.graphRun?.status, "failed");
  assertEquals(
    JSON.stringify(saved).includes("private SMTP diagnostic"),
    false,
  );
});

for (const nativeAction of ["forward", "reply"] as const) {
  Deno.test(`intake resolves after successful native ${nativeAction} when persistence fails`, async () => {
    const store = createMemoryStore();
    let completedNativeEffect = false;
    let attempts = 0;
    const failingStore = {
      ...store,
      updateMessage: async (
        ...args: Parameters<typeof store.updateMessage>
      ) => {
        if (completedNativeEffect) {
          throw new Error("private post-delivery D1 diagnostic");
        }
        return await store.updateMessage(...args);
      },
    };
    const result = await processIncomingEmail({
      graph: {
        version: 2,
        enabled: true,
        codeExtraction: "nodes",
        nodes: [
          { id: "start", kind: "entry", label: "start", x: 0, y: 0 },
          {
            id: "deliver",
            kind: "action",
            label: "deliver",
            x: 0,
            y: 100,
            actions: nativeAction === "forward"
              ? [{ type: "forward", to: "owner@example.com" }]
              : [{ type: "reply", text: "Hello" }],
          },
          { id: "done", kind: "finish", label: "done", x: 0, y: 200 },
        ],
        edges: [{ from: "start", to: "deliver", port: "next" }, {
          from: "deliver",
          to: "done",
          port: "next",
        }],
      },
      store: failingStore,
      blobStore: createMemoryBlobStore(),
      config: readConfig({ CFMAILBIN_ALLOW_CATCH_ALL: "true" }),
      message: {
        from: "sender@example.com",
        to: "inbox@example.com",
        headers: new Headers({ subject: "Test" }),
        raw: new Response("Subject: Test\r\n\r\nHello").body!,
        setReject() {
          throw new Error("must not reject");
        },
        forward() {
          attempts++;
          completedNativeEffect = true;
          return Promise.resolve();
        },
        reply() {
          attempts++;
          completedNativeEffect = true;
          return Promise.resolve();
        },
      },
    });

    assertEquals(
      result.action,
      nativeAction === "forward" ? "forward" : "keep",
    );
    assertEquals(result.rejected, false);
    assertEquals(attempts, 1);
    assertEquals(
      JSON.stringify(await store.listAuditEvents()).includes(
        "private post-delivery D1 diagnostic",
      ),
      false,
    );
  });
}

for (const scenario of ["failure", "concurrent edits"] as const) {
  Deno.test(`action intake persists completed effects through ${scenario}`, async () => {
    const store = createMemoryStore(), blobs = createMemoryBlobStore();
    const nodes: GraphNode[] = [
      { id: "start", kind: "entry", label: "start", x: 0, y: 0 },
      {
        id: "actions",
        kind: "action",
        label: "actions",
        x: 0,
        y: 100,
        actions: [{ type: "tag", tags: ["automated"] }, {
          type: "set_retention",
          days: 1,
        }, { type: "forward", to: "owner@example.com" }],
      },
      {
        id: "ai",
        kind: "ai",
        label: "AI",
        x: 0,
        y: 200,
        prompt: "Return ok",
        batchGroup: "",
        inputs: { text: "email.text" },
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
      },
      ...(scenario === "concurrent edits"
        ? [{
          id: "later",
          kind: "action" as const,
          label: "later",
          x: 0,
          y: 300,
          actions: [{ type: "tag" as const, tags: ["later"] }],
        }]
        : []),
      { id: "done", kind: "finish", label: "done", x: 0, y: 400 },
    ];
    const graph: MailGraph = {
      version: 2,
      enabled: true,
      codeExtraction: "nodes",
      nodes,
      edges: nodes.slice(1).map((n, i) => ({
        from: nodes[i].id,
        to: n.id,
        port: "next",
      })),
    };
    let forwards = 0;
    const result = await processIncomingEmail({
      graph,
      store,
      blobStore: blobs,
      config: readConfig({
        ...gatewayEnv,
        CFMAILBIN_AI_ENABLED: "true",
        CFMAILBIN_ALLOW_CATCH_ALL: "true",
      }),
      message: {
        from: "sender@example.com",
        to: "inbox@example.com",
        headers: new Headers({ subject: "Test" }),
        raw: new Response("Subject: Test\r\n\r\nHello").body!,
        setReject() {
          throw new Error("must not reject");
        },
        forward() {
          forwards++;
          return Promise.resolve();
        },
      },
      analysisFetch: async () => {
        const saved = (await store.listMessages())[0];
        assertEquals(saved.tags, ["automated"]);
        assertEquals(saved.status, "forwarded");
        if (scenario === "failure") {
          return new Response("private error", { status: 503 });
        }
        await store.updateMessage(saved.id, { status: "trashed" });
        await store.replaceMessageTags(saved.id, ["owner"]);
        return Response.json({
          choices: [{
            finish_reason: "stop",
            message: { content: JSON.stringify({ ai: { ok: true } }) },
          }],
        });
      },
    });
    const saved = (await store.getMessage(result.messageId!))!;
    assertEquals(forwards, 1);
    assertEquals(result.action, "forward");
    assertEquals(saved.forwardedTo, "owner@example.com");
    assertEquals(
      saved.tags,
      scenario === "failure" ? ["automated"] : ["later", "owner"],
    );
    assertEquals(
      saved.status,
      scenario === "failure" ? "forwarded" : "trashed",
    );
    assertEquals(
      Date.parse(saved.expiresAt) - Date.parse(saved.receivedAt),
      86_400_000,
    );
    assertEquals(
      saved.graphRun?.status,
      scenario === "failure" ? "failed" : "complete",
    );
    assertEquals(
      saved.graphRun?.actionResults?.filter((a) => a.type === "forward").length,
      1,
    );
  });
}

for (const action of ["forward", "trash"] as const) {
  Deno.test(`action tags followed by ${action} persist every effect`, async () => {
    const store = createMemoryStore();
    let ownerEdit = false;
    const racingStore = {
      ...store,
      getMessage: async (id: string) => {
        const snapshot = await store.getMessage(id);
        if (snapshot && !ownerEdit) {
          ownerEdit = true;
          await store.replaceMessageTags(id, ["owner"]);
        }
        return snapshot;
      },
    };
    const nodes: GraphNode[] = [
      { id: "start", kind: "entry", label: "start", x: 0, y: 0 },
      {
        id: "tag",
        kind: "action",
        label: "tag",
        x: 0,
        y: 100,
        actions: [{ type: "tag", tags: ["first"] }],
      },
      {
        id: "deliver",
        kind: "action",
        label: "deliver",
        x: 0,
        y: 200,
        actions: [
          { type: "tag", tags: ["last"] },
          { type: "set_retention", days: 2 },
          action === "forward"
            ? { type: "forward", to: "owner@example.com" }
            : { type: "trash" },
        ],
      },
      { id: "done", kind: "finish", label: "done", x: 0, y: 300 },
    ];
    let forwards = 0;
    const result = await processIncomingEmail({
      graph: {
        version: 2,
        enabled: true,
        codeExtraction: "nodes",
        nodes,
        edges: [{ from: "start", to: "tag", port: "next" }, {
          from: "tag",
          to: "deliver",
          port: "next",
        }, { from: "deliver", to: "done", port: "next" }],
      },
      store: racingStore,
      blobStore: createMemoryBlobStore(),
      config: readConfig({ CFMAILBIN_ALLOW_CATCH_ALL: "true" }),
      message: {
        from: "sender@example.com",
        to: "inbox@example.com",
        headers: new Headers({ subject: "Test" }),
        raw: new Response("Subject: Test\r\n\r\nHello").body!,
        setReject() {
          throw new Error("must not reject");
        },
        forward() {
          forwards++;
          return Promise.resolve();
        },
      },
    });
    const saved = (await store.getMessage(result.messageId!))!;
    assertEquals(saved.status, action === "forward" ? "forwarded" : "trashed");
    assertEquals(
      saved.forwardedTo,
      action === "forward" ? "owner@example.com" : undefined,
    );
    assertEquals(saved.tags, ["first", "last", "owner"]);
    assertEquals(
      Date.parse(saved.expiresAt) - Date.parse(saved.receivedAt),
      2 * 86_400_000,
    );
    assertEquals(forwards, action === "forward" ? 1 : 0);
  });
}

Deno.test("deletion during optional AI prevents a subsequent deny", async () => {
  const store = createMemoryStore();
  const nodes: GraphNode[] = [
    { id: "start", kind: "entry", label: "start", x: 0, y: 0 },
    {
      id: "ai",
      kind: "ai",
      label: "optional AI",
      x: 0,
      y: 100,
      prompt: "Return JSON with ok",
      inputs: { text: "email.text" },
      batchGroup: "",
      optional: true,
      schema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
    {
      id: "deny",
      kind: "action",
      label: "deny",
      x: 0,
      y: 200,
      actions: [{ type: "deny", reason: "Policy denied" }],
    },
  ];
  let rejected = false;
  await processIncomingEmail({
    graph: {
      version: 2,
      enabled: true,
      codeExtraction: "nodes",
      nodes,
      edges: [{ from: "start", to: "ai", port: "next" }, {
        from: "ai",
        to: "deny",
        port: "next",
      }],
    },
    store,
    blobStore: createMemoryBlobStore(),
    config: readConfig({
      ...gatewayEnv,
      CFMAILBIN_AI_ENABLED: "true",
      CFMAILBIN_ALLOW_CATCH_ALL: "true",
    }),
    message: {
      from: "sender@example.com",
      to: "inbox@example.com",
      headers: new Headers({ subject: "Test" }),
      raw: new Response("Subject: Test\r\n\r\nHello").body!,
      setReject() {
        rejected = true;
      },
      forward() {
        throw new Error("must not forward");
      },
    },
    analysisFetch: async () => {
      const received = (await store.listMessages())[0];
      await store.deleteMessages([received.id]);
      return Response.json({
        choices: [{
          finish_reason: "stop",
          message: { content: JSON.stringify({ ai: { ok: true } }) },
        }],
      });
    },
  });
  assertEquals(rejected, false);
  assertEquals(await store.listMessages(), []);
});
