import { migrateGraph } from "../src/graph/migrate.ts";
import { legacyReceiptPolicy } from "./workflow_fixture.ts";
import { assert, assertEquals } from "@std/assert";
import { graphTemplate } from "../src/graph/templates.ts";
import { createMemoryBlobStore } from "../src/storage/memory.ts";
import { sqliteStore } from "./storage_fixture.ts";
import { readConfig } from "../src/config.ts";
import { gatewayEnv } from "./analysis_fixture.ts";
import { processIncomingEmail } from "../src/email/processor.ts";
import { handleRequest } from "../src/app.ts";
import { createGraphStore } from "../src/graph/storage.ts";
import { builtInPresets } from "../src/graph/library.ts";

const config = readConfig({
  ...gatewayEnv,
  CFMAILBIN_ALLOW_CATCH_ALL: "true",
  CFMAILBIN_AI_ENABLED: "true",
});
function mail() {
  return {
    from: "sender@example.com",
    to: "test@example.com",
    headers: new Headers({ subject: "Test" }),
    raw: new Response("Subject: Test\r\n\r\nEnter 001234 to sign in.").body!,
    forwarded: 0,
    rejected: false,
    forward() {
      this.forwarded++;
      return Promise.resolve();
    },
    setReject() {
      this.rejected = true;
    },
  };
}

Deno.test("explicitly migrated policy retains existing rule order, immediate forwarding, tags and retention, and concurrent owner edits", async () => {
  const fixture = sqliteStore();
  try {
    await fixture.store.createRule({
      condition: { field: "hasCode", value: true },
      actions: { delivery: "trash" },
    });
    await fixture.store.createRule({
      condition: { field: "subject", operator: "contains", value: "test" },
      actions: {
        delivery: "forward",
        forwardTo: "owner@example.com",
        tags: ["rule"],
        retentionDays: 2,
      },
    });
    const message = mail();
    const result = await processIncomingEmail({
      graph: {
        ...migrateGraph(
          legacyReceiptPolicy(),
          await fixture.store.listRules(),
          await fixture.store.listAliases(),
        ).graph,
        enabled: true,
      },
      config,
      message,
      store: fixture.store,
      blobStore: createMemoryBlobStore(),
      analysisFetch: async () => {
        assertEquals(message.forwarded, 1);
        const saved = (await fixture.store.listMessages())[0];
        assertEquals(saved.status, "forwarded");
        assertEquals(saved.tags.includes("rule"), true);
        assertEquals(
          Date.parse(saved.expiresAt) - Date.parse(saved.receivedAt),
          2 * 86400000,
        );
        await fixture.store.updateMessage(saved.id, { status: "trashed" });
        await fixture.store.replaceMessageTags(saved.id, ["owner edit"]);
        return Response.json({
          choices: [{
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                enrich: {
                  category: "verification",
                  hasCode: true,
                  codes: [{
                    value: "001234",
                    context: "Enter 001234 to sign in.",
                  }],
                },
              }),
            },
          }],
        });
      },
    });
    const saved = (await fixture.store.getMessage(result.messageId!))!;
    assertEquals(saved.verificationCodes, ["001234"]);
    assertEquals(saved.status, "trashed");
    assertEquals(saved.tags, ["owner edit"]);
    assertEquals(message.forwarded, 1);
    assertEquals(saved.graphRun?.action, "forward");
    assertEquals(saved.graphRun?.status, "complete");
  } finally {
    fixture.close();
  }
});

Deno.test("explicitly migrated policy rejects before AI and removes stored mail, while trials only show rejection", async () => {
  const fixture = sqliteStore();
  try {
    await fixture.store.createRule({
      condition: { field: "subject", operator: "contains", value: "test" },
      actions: { delivery: "block" },
    });
    const message = mail(), blobStore = createMemoryBlobStore();
    const result = await processIncomingEmail({
      graph: {
        ...migrateGraph(
          legacyReceiptPolicy(),
          await fixture.store.listRules(),
          await fixture.store.listAliases(),
        ).graph,
        enabled: true,
      },
      config,
      message,
      store: fixture.store,
      blobStore,
      analysisFetch: () => {
        throw new Error("must not call AI");
      },
    });
    assertEquals(result.rejected, true);
    assertEquals(message.rejected, true);
    assertEquals(message.forwarded, 0);
    assertEquals(await fixture.store.listMessages(), []);
    assert(
      (await fixture.store.listAuditEvents()).some((e) =>
        e.eventType === "blocked_by_rule"
      ),
    );
    const response = await handleRequest(
      new Request("http://localhost/api/graph/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cfmailbin-request": "1",
          origin: "http://localhost",
        },
        body: JSON.stringify({
          graph: {
            ...migrateGraph(
              legacyReceiptPolicy(),
              await fixture.store.listRules(),
              await fixture.store.listAliases(),
            ).graph,
            enabled: true,
          },
          sample: { subject: "Test", text: "test" },
        }),
      }),
      {
        config,
        store: fixture.store,
        blobStore,
        developmentSession: { mode: "development", email: "owner@example.com" },
      },
    );
    const preview = await response.json();
    assertEquals(preview.action, "block");
    assertEquals(preview.trial, true);
    assertEquals(
      preview.steps.some((s: { nodeId: string }) => s.nodeId === "enrich"),
      false,
    );
  } finally {
    fixture.close();
  }
});

Deno.test("node library API enforces owner, origin, built-in immutability, revisions and snapshot isolation", async () => {
  const fixture = sqliteStore();
  try {
    const backend = {
      config: readConfig(),
      store: fixture.store,
      blobStore: createMemoryBlobStore(),
      graph: createGraphStore(),
      developmentSession: {
        mode: "development" as const,
        email: "owner@example.com",
      },
    };
    const request = (
      path: string,
      method = "GET",
      body?: unknown,
      origin = "http://localhost",
    ) =>
      handleRequest(
        new Request(`http://localhost${path}`, {
          method,
          headers: {
            "content-type": "application/json",
            "x-cfmailbin-request": "1",
            origin,
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
        backend,
      );
    const node = builtInPresets.find((p) =>
      p.id === "builtin_policy_checks"
    )!.node;
    assertEquals(
      (await request(
        "/api/node-library/custom",
        "PUT",
        { node },
        "https://evil.example",
      )).status,
      403,
    );
    assertEquals(
      (await handleRequest(new Request("http://localhost/api/node-library"), {
        ...backend,
        developmentSession: undefined,
      })).status,
      503,
    );
    assertEquals(
      (await request("/api/node-library/builtin_local_codes", "DELETE")).status,
      400,
    );
    const create = await request("/api/node-library/custom", "PUT", { node });
    assertEquals(create.status, 200);
    const preset = await create.json();
    const graph = { ...graphTemplate(), enabled: true };
    await backend.graph.put(graph);
    const updated = await request("/api/node-library/custom", "PUT", {
      node: { ...node, label: "New" },
      revision: preset.revision,
    });
    assertEquals(updated.status, 200);
    assertEquals(
      (await request("/api/node-library/custom", "PUT", {
        node,
        revision: preset.revision,
      })).status,
      409,
    );
    assertEquals(await backend.graph.get(), graph);
    assertEquals(
      (await request("/api/node-library/custom", "DELETE")).status,
      200,
    );
    assertEquals((await backend.graph.getLibrary()).length, 0);
    const response = await (await request("/api/graph")).json();
    assertEquals(response.effectiveGraph.enabled, true);
  } finally {
    fixture.close();
  }
});
