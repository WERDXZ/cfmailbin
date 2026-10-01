import { assertEquals } from "@std/assert";
import { handleRequest } from "../src/app.ts";
import { readConfig } from "../src/config.ts";
import { createMemoryBlobStore } from "../src/storage/memory.ts";
import { sqliteStore } from "./storage_fixture.ts";
import { createGraphStore } from "../src/graph/storage.ts";
import { builtInPolicies } from "../src/graph/policies.ts";
import { builtInPresets } from "../src/graph/library.ts";

Deno.test("Policy library persists in KV, protects owner writes and keeps embedded snapshots stable", async () => {
  const fixture = sqliteStore();
  const data = new Map<string, string>();
  const kv = {
    get: (key: string) => Promise.resolve(data.get(key) ?? null),
    put: (key: string, value: string) => {
      data.set(key, value);
      return Promise.resolve();
    },
  };
  const backend = {
    config: readConfig(),
    store: fixture.store,
    blobStore: createMemoryBlobStore(),
    graph: createGraphStore(kv),
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
          "x-cfmailbin-request": "1",
          origin,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      backend,
    );
  try {
    const policy = {
      ...builtInPolicies[0],
      id: "mine",
      success: { actions: [], branches: ["old-label"] },
      failed: { reasons: ["old-reason"], branches: ["old-failure"] },
    };
    assertEquals(
      (await request(
        "/api/policies/mine",
        "PUT",
        policy,
        "https://evil.example",
      )).status,
      403,
    );
    assertEquals(
      (await handleRequest(new Request("http://localhost/api/policies"), {
        ...backend,
        developmentSession: undefined,
      })).status,
      503,
    );
    assertEquals(
      (await request("/api/policies/builtin_from_trusted_domain", "DELETE"))
        .status,
      400,
    );
    const created = await (await request("/api/policies/mine", "PUT", policy))
      .json();
    assertEquals(Object.hasOwn(created, "success"), false);
    assertEquals(Object.hasOwn(created, "failed"), false);
    assertEquals((await createGraphStore(kv).getPolicies())[0], created);
    const preset = structuredClone(
      builtInPresets.find((p) => p.id === "builtin_policy_checks")!,
    );
    if (preset.node.kind !== "evaluate") throw new Error("fixture");
    preset.node.policies = { policy: created };
    await request("/api/node-library/combo", "PUT", { node: preset.node });
    const updated = await request("/api/policies/mine", "PUT", {
      ...created,
      name: "Version 2",
    });
    assertEquals(updated.status, 200);
    assertEquals(
      (await request("/api/policies/mine", "PUT", created)).status,
      409,
    );
    assertEquals(
      (await createGraphStore(kv).getLibrary())[0].node,
      preset.node,
    );
    assertEquals((await request("/api/policies/mine", "DELETE")).status, 200);
    assertEquals(await createGraphStore(kv).getPolicies(), []);
    const fragment = builtInPresets.find((p) =>
      p.id === "builtin_local_codes"
    )!;
    assertEquals(
      (await request("/api/node-library/codes", "PUT", fragment)).status,
      200,
    );
    assertEquals(
      (await createGraphStore(kv).getLibrary()).find((p) => p.id === "codes")
        ?.fragment,
      fragment.fragment,
    );
    assertEquals(
      (await request("/api/policies/invalid", "PUT", {
        ...policy,
        success: { actions: [{ delivery: "forward" }], branches: [] },
      })).status,
      400,
    );
  } finally {
    fixture.close();
  }
});

Deno.test("pure composed Policy and explicit action preserve original mail and persists exactly one native forward", async () => {
  const { processIncomingEmail } = await import("../src/email/processor.ts");
  const { graphTemplate } = await import("../src/graph/templates.ts");
  const fixture = sqliteStore();
  try {
    const blobStore = createMemoryBlobStore();
    const graph = graphTemplate();
    graph.enabled = true;
    const policy = structuredClone(builtInPolicies[0]);
    graph.nodes.push({
      id: "checks",
      kind: "evaluate",
      label: "Check",
      x: 0,
      y: 0,
      policies: { all: [{ policy }, { policy }] },
    }, {
      id: "if",
      kind: "condition",
      label: "Matched?",
      x: 0,
      y: 100,
      path: "nodes.checks.matched",
      operator: "equals",
      value: true,
      unknown: true,
    }, {
      id: "forward",
      kind: "action",
      label: "Forward",
      x: 0,
      y: 200,
      actions: [
        { type: "tag", tags: ["trusted"] },
        { type: "set_retention", days: 2 },
        { type: "forward", to: "owner@example.com" },
        { type: "forward", to: "owner@example.com" },
      ],
    });
    graph.edges = [
      { from: "start", to: "checks", port: "next" },
      { from: "checks", to: "if", port: "next" },
      { from: "if", to: "forward", port: "yes" },
      { from: "if", to: "done", port: "no" },
      { from: "if", to: "done", port: "unknown" },
      { from: "forward", to: "done", port: "next" },
    ];
    let forwarded = 0;
    const result = await processIncomingEmail({
      graph,
      config: readConfig({ CFMAILBIN_ALLOW_CATCH_ALL: "true" }),
      store: fixture.store,
      blobStore,
      message: {
        from: "sender@example.com",
        to: "inbox@example.com",
        headers: new Headers({ subject: "Hi" }),
        raw: new Response("Subject: Hi\r\n\r\nHello").body!,
        setReject: () => {
          throw new Error("must not reject");
        },
        forward: async (target) => {
          assertEquals(target, "owner@example.com");
          const stored = (await fixture.store.listMessages())[0];
          assertEquals(stored.status, "inbox");
          assertEquals(!!await blobStore.get(stored.rawKey!), true);
          forwarded++;
        },
      },
    });
    const message = (await fixture.store.getMessage(result.messageId!))!;
    assertEquals(forwarded, 1);
    assertEquals(message.status, "forwarded");
    assertEquals(message.forwardedTo, "owner@example.com");
    assertEquals(message.tags, ["trusted"]);
    assertEquals(
      Date.parse(message.expiresAt) - Date.parse(message.receivedAt),
      2 * 86400000,
    );
    assertEquals(message.graphRun?.status, "complete");
  } finally {
    fixture.close();
  }
});
