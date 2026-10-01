import { runGraph } from "../src/graph/run.ts";
import { workflowAuditMetadata } from "../src/services/audit.ts";
import { graphTemplate } from "../src/graph/templates.ts";
import { gatewayEnv } from "./analysis_fixture.ts";
import { DatabaseSync } from "node:sqlite";
import { sqliteStore } from "./storage_fixture.ts";
import type { AuditPage } from "../src/domain/models.ts";
import { createGraphStore } from "../src/graph/storage.ts";
import { actionPolicy } from "./workflow_fixture.ts";
import { processIncomingEmail } from "../src/email/processor.ts";
import { assert, assertEquals } from "@std/assert";
import { handleRequest } from "../src/app.ts";
import { readConfig } from "../src/config.ts";
import {
  createMemoryBlobStore,
  createMemoryStore,
} from "../src/storage/memory.ts";

Deno.test("audit page API returns a bounded page and requires the owner session", async () => {
  const backend = {
    config: readConfig(),
    store: createMemoryStore(),
    blobStore: createMemoryBlobStore(),
    developmentSession: {
      mode: "development" as const,
      email: "owner@example.com",
    },
  };
  const response = await handleRequest(
    new Request("http://localhost/api/audit"),
    backend,
  );
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { events: [], nextCursor: null });
  assertEquals(response.headers.get("cache-control"), "no-store");
  const denied = await handleRequest(
    new Request("http://localhost/api/audit"),
    { ...backend, developmentSession: undefined },
  );
  assertEquals(denied.status, 503);
  for (
    const query of [
      "limit=1000",
      "type=bogus",
      "cursor=bad",
      "since=yesterday",
      "q=" + "x".repeat(201),
    ]
  ) {
    assertEquals(
      (await handleRequest(
        new Request("http://localhost/api/audit?" + query),
        backend,
      )).status,
      400,
    );
  }
});

Deno.test("audit filters and cursor pagination behave identically in memory and SQLite", async () => {
  for (
    const factory of [
      () => ({ store: createMemoryStore(), close() {} }),
      sqliteStore,
    ]
  ) {
    const fixture = factory();
    try {
      const backend = {
        config: readConfig(),
        store: fixture.store,
        blobStore: createMemoryBlobStore(),
        developmentSession: {
          mode: "development" as const,
          email: "owner@example.com",
        },
      };
      const get = async (params = new URLSearchParams()) => {
        const response = await handleRequest(
          new Request(`http://localhost/api/audit?${params}`),
          backend,
        );
        assertEquals(response.status, 200);
        return await response.json() as AuditPage;
      };
      const written = [];
      for (let i = 0; i < 6; i++) {
        written.push(
          await fixture.store.createAuditEvent({
            eventType: i % 2 ? "received" : "configuration_changed",
            aliasAddress: "inbox@example.com",
            messageId: `message_${i}`,
            correlationId: "receipt_1",
            actor: "owner@example.com",
            reason: i === 0 ? "literal %_ 字符" : "other",
            subjectPreview: `subject ${i}`,
          }),
        );
      }
      const all = (await get()).events;
      assertEquals(all.length, 6);
      const first = await get(new URLSearchParams({ limit: "2" }));
      assert(first.nextCursor);
      const second = await get(
        new URLSearchParams({ limit: "2", cursor: first.nextCursor }),
      );
      const third = await get(
        new URLSearchParams({ limit: "2", cursor: second.nextCursor! }),
      );
      assertEquals(
        [...first.events, ...second.events, ...third.events].map((e) => e.id),
        all.map((e) => e.id),
      );
      assertEquals(third.nextCursor, null);
      assertEquals(
        (await get(new URLSearchParams({ q: "%_" }))).events.map((e) => e.id),
        [written[0].id],
      );
      assertEquals(
        (await get(
          new URLSearchParams({
            q: "OWNER@EXAMPLE.COM",
            type: "configuration_changed",
          }),
        )).events.length,
        3,
      );
      assertEquals(
        (await get(new URLSearchParams({ messageId: "message_2" }))).events.map(
          (e) => e.id,
        ),
        [written[2].id],
      );
      assertEquals(
        (await get(new URLSearchParams({ correlationId: "receipt_1" }))).events
          .length,
        6,
      );
      assertEquals(
        (await get(new URLSearchParams({ since: "2100-01-01T00:00:00Z" })))
          .events.length,
        0,
      );
      assertEquals(
        (await get(new URLSearchParams({ until: "2000-01-01T00:00:00Z" })))
          .events.length,
        0,
      );
    } finally {
      fixture.close();
    }
  }
});

Deno.test("audit migration keeps historical events while accepting new event types", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(Deno.readTextFileSync("src/db/migrations/0002_audit_events.sql"));
    db.exec(
      "INSERT INTO audit_events(id,event_type,created_at,metadata_json) VALUES ('old','received','2026-01-01T00:00:00.000Z','{\"old\":true}')",
    );
    db.exec(Deno.readTextFileSync("src/db/migrations/0008_audit_history.sql"));
    const old = db.prepare("SELECT * FROM audit_events WHERE id='old'").get()!;
    assertEquals(old.event_type, "received");
    assertEquals(old.metadata_json, '{"old":true}');
    assertEquals(old.actor, null);
    db.exec(
      "INSERT INTO audit_events(id,event_type,created_at,actor,correlation_id) VALUES ('new','workflow_completed','2026-01-01T00:00:00.000Z','owner','receipt')",
    );
    assertEquals(
      db.prepare("SELECT count(*) AS total FROM audit_events").get()!.total,
      2,
    );
  } finally {
    db.close();
  }
});

Deno.test("only successful owner writes create configuration audit events without copying request contents", async () => {
  const store = createMemoryStore();
  const backend = {
    store,
    config: readConfig(),
    blobStore: createMemoryBlobStore(),
    graph: createGraphStore(),
    developmentSession: {
      mode: "development" as const,
      email: "owner@example.com",
    },
  };
  const write = (body: unknown, origin = "http://localhost") =>
    handleRequest(
      new Request("http://localhost/api/graph", {
        method: "PUT",
        headers: { "x-cfmailbin-request": "1", origin },
        body: JSON.stringify(body),
      }),
      backend,
    );
  assertEquals(
    (await write(actionPolicy(), "https://evil.example")).status,
    403,
  );
  assertEquals((await write({})).status, 400);
  assertEquals(await store.listAuditEvents(), []);
  assertEquals((await write(actionPolicy())).status, 200);
  const [event] = await store.listAuditEvents();
  assertEquals(event.eventType, "configuration_changed");
  assertEquals(event.actor, "owner@example.com");
  assertEquals(event.metadata?.resource, "graph");
  assertEquals(JSON.stringify(event).includes('"nodes"'), false);
  const broken = {
    ...backend,
    store: {
      ...store,
      createAuditEvent() {
        throw new Error("private database error");
      },
    },
  };
  const response = await handleRequest(
    new Request("http://localhost/api/graph", {
      method: "PUT",
      headers: { "x-cfmailbin-request": "1" },
      body: JSON.stringify(actionPolicy()),
    }),
    broken,
  );
  assertEquals(response.status, 200);
  assert((await backend.graph.get())?.enabled);
});

Deno.test("receipt audit links native forwarding and workflow results without keeping body or codes", async () => {
  const fixture = sqliteStore();
  try {
    const bytes = new TextEncoder().encode(
      "Subject: login\r\n\r\nYour code is 918274. private_body_sentinel",
    );
    const message = {
      from: "sender@example.com",
      to: "inbox@example.com",
      headers: new Headers({ subject: "login" }),
      rawSize: bytes.length,
      raw: new Blob([bytes]).stream(),
      forward: () => Promise.resolve(),
      setReject() {},
    };
    const result = await processIncomingEmail({
      store: fixture.store,
      blobStore: createMemoryBlobStore(),
      config: { ...readConfig(), allowCatchAll: true },
      message,
      graph: actionPolicy([{ type: "forward", to: "owner@example.com" }]),
    });
    const events = await fixture.store.listAuditEvents();
    assertEquals(new Set(events.map((e) => e.correlationId)).size, 1);
    assert(events[0].correlationId);
    const complete = events.find((e) => e.eventType === "workflow_completed")!;
    assertEquals(complete.messageId, result.messageId);
    assertEquals(
      events.find((e) => e.eventType === "forwarded")?.metadata?.forwardedTo,
      "owner@example.com",
    );
    assertEquals(
      JSON.stringify(events).includes("private_body_sentinel"),
      false,
    );
    assertEquals(JSON.stringify(events).includes("918274"), false);
    await fixture.store.deleteMessages([result.messageId!]);
    assertEquals((await fixture.store.listAuditEvents()).length, events.length);
    const denied = { ...message, raw: new Blob([bytes]).stream() };
    await processIncomingEmail({
      store: fixture.store,
      blobStore: createMemoryBlobStore(),
      config: { ...readConfig(), allowCatchAll: true },
      message: denied,
      graph: actionPolicy([{ type: "deny", reason: "untrusted sender" }]),
    });
    const rejected = (await fixture.store.listAuditEvents()).find((e) =>
      e.eventType === "blocked_by_rule"
    )!;
    assert(rejected.messageId);
    assertEquals(rejected.reason, "untrusted sender");
    assertEquals(await fixture.store.getMessage(rejected.messageId), null);
    assert(
      (await fixture.store.listAuditEvents(100, {
        correlationId: rejected.correlationId,
      })).some((e) => e.eventType === "workflow_completed"),
    );
  } finally {
    fixture.close();
  }
});

Deno.test("audit summaries report actual converging branches and omit AI outputs and prompts", async () => {
  const graph = actionPolicy();
  graph.nodes.push({
    id: "classify",
    kind: "ai",
    label: "Classifier",
    x: 0,
    y: 0,
    prompt: "private_prompt_sentinel",
    inputs: { text: "email.text" },
    schema: {
      type: "object",
      properties: { decision: { type: "boolean" }, secret: { type: "string" } },
      required: ["decision", "secret"],
      additionalProperties: false,
    },
    batchGroup: "",
  }, {
    id: "branch",
    kind: "condition",
    label: "IF",
    x: 0,
    y: 0,
    path: "nodes.classify.decision",
    operator: "equals",
    value: true,
    unknown: true,
  });
  graph.edges = graph.edges.filter((e) => e.from !== "start");
  graph.edges.push(
    { from: "start", to: "classify", port: "next" },
    { from: "classify", to: "branch", port: "next" },
    ...(["yes", "no", "unknown"] as const).map((port) => ({
      from: "branch",
      to: "actions",
      port,
    })),
  );
  const run = await runGraph(graph, { text: "private_body_sentinel" }, {
    ai: () =>
      Promise.resolve({
        classify: { decision: false, secret: "private_output_sentinel" },
      }),
  });
  assertEquals(run.status, "complete");
  run.error = "动态错误";
  run.errorCode = "errors.dynamicFailure";
  run.errorParams = { field: "subject" };
  const branchStep = run.steps.find((step) => step.nodeId === "branch")!;
  branchStep.error = "步骤错误";
  branchStep.errorCode = "errors.stepFailure";
  branchStep.errorParams = { nodeId: "branch" };
  const summary = workflowAuditMetadata(graph, run);
  assertEquals(
    summary.steps.find((step) => step.nodeId === "branch")?.branch,
    "no",
  );
  assertEquals(summary.errorCode, "errors.dynamicFailure");
  assertEquals(summary.errorParams, { field: "subject" });
  assertEquals(
    summary.steps.find((step) => step.nodeId === "branch")?.errorCode,
    "errors.stepFailure",
  );
  assertEquals(
    summary.steps.find((step) => step.nodeId === "branch")?.errorParams,
    { nodeId: "branch" },
  );
  for (
    const sensitive of [
      "private_output_sentinel",
      "private_prompt_sentinel",
      "private_body_sentinel",
    ]
  ) assertEquals(JSON.stringify(summary).includes(sensitive), false);
});

Deno.test("audit records handled AI failures as degraded with safe diagnostics", async () => {
  for (const template of ["classification", "verification"] as const) {
    const store = createMemoryStore();
    const graph = graphTemplate(template);
    graph.enabled = true;
    let calls = 0;
    await processIncomingEmail({
      store,
      blobStore: createMemoryBlobStore(),
      graph,
      config: readConfig({
        ...gatewayEnv,
        CFMAILBIN_ALLOW_CATCH_ALL: "true",
        CFMAILBIN_AI_ENABLED: "true",
      }),
      message: {
        from: "sender@example.com",
        to: "test@example.com",
        headers: new Headers({ subject: "Hello" }),
        raw: new Response("Subject: Hello\r\n\r\nprivate_body_sentinel").body!,
        setReject() {},
        async forward() {},
      },
      analysisFetch: () => {
        calls++;
        return Promise.resolve(
          new Response("private_provider_response", { status: 503 }),
        );
      },
    });
    assert(calls > 0);
    const event = (await store.listAuditEvents()).find((e) =>
      e.eventType === "workflow_degraded"
    )!;
    assert(event);
    assert(JSON.stringify(event.metadata).includes("503"));
    assertEquals(
      JSON.stringify(event).includes("private_body_sentinel"),
      false,
    );
    assertEquals(
      JSON.stringify(event).includes("private_provider_response"),
      false,
    );
  }
});
