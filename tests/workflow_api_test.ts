import { assert, assertEquals, assertRejects } from "@std/assert";
import { handleRequest } from "../src/app.ts";
import { readConfig } from "../src/config.ts";
import { createGraphStore } from "../src/graph/storage.ts";
import {
  createMemoryBlobStore,
  createMemoryStore,
} from "../src/storage/memory.ts";
import { actionPolicy, legacyReceiptPolicy } from "./workflow_fixture.ts";

Deno.test("workflow API exposes rejection defaults and migration drafts without silently activating or overwriting legacy data", async () => {
  const values = new Map<string, string>();
  const kv = {
    get: (key: string) => Promise.resolve(values.get(key) ?? null),
    put: (key: string, value: string) => {
      values.set(key, value);
      return Promise.resolve();
    },
  };
  const store = createMemoryStore();
  await store.createRule({
    name: "Keep trusted",
    condition: {
      field: "fromDomain",
      operator: "equals",
      value: "example.com",
    },
    actions: { delivery: "keep", tags: ["trusted"] },
  });
  const legacy = legacyReceiptPolicy();
  values.set("graph:v1", JSON.stringify(legacy));
  const backend = {
    config: readConfig(),
    store,
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
    new Request(`http://localhost/api/${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-cfmailbin-request": "1",
        origin,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const original = new Map(values), rules = await store.listRules();
  const initial = await (await handleRequest(request("graph"), backend)).json();
  assertEquals(initial.graph, null);
  assertEquals(initial.effectiveGraph, null);
  assertEquals(initial.plan, null);
  assertEquals(initial.legacy, { rules: 1, graph: true });
  assertEquals(values, original);
  for (const source of ["rules", "graph"]) {
    const response = await handleRequest(
      request("graph/migrate", "POST", { source }),
      backend,
    );
    assertEquals(response.status, 200);
    const draft = await response.json();
    assertEquals(draft.graph.version, 2);
    assertEquals(draft.graph.enabled, false);
    assert(Array.isArray(draft.warnings));
    assertEquals(values, original);
    assertEquals(await store.listRules(), rules);
    assertEquals(await store.listMessages(), []);
    assertEquals(await store.listAuditEvents(), []);
  }
  assertEquals(
    (await handleRequest(
      request(
        "graph/migrate",
        "POST",
        { source: "rules" },
        "https://evil.example",
      ),
      backend,
    )).status,
    403,
  );
  const unauthorized = await handleRequest(
    request("graph/migrate", "POST", { source: "rules" }),
    { ...backend, developmentSession: undefined },
  );
  assert([401, 503].includes(unauthorized.status));
  assertEquals(
    (await handleRequest(request("graph", "PUT", legacy), backend)).status,
    400,
  );
  assertEquals(values, original);
  const saved = await handleRequest(
    request("graph", "PUT", actionPolicy()),
    backend,
  );
  assertEquals(saved.status, 200);
  assertEquals(JSON.parse(values.get("graph:legacy:v1")!), legacy);
  const reconstructed = createGraphStore(kv);
  assertEquals((await reconstructed.get())?.version, 2);
  assertEquals(await reconstructed.getLegacy(), legacy);
  assertEquals(await store.listRules(), rules);
  const disabled = await handleRequest(
    request("graph", "PUT", { ...actionPolicy(), enabled: false }),
    backend,
  );
  const inactive = await disabled.json();
  assertEquals(disabled.status, 200);
  assertEquals(inactive.graph.enabled, false);
  assertEquals(inactive.effectiveGraph, null);
  assertEquals(await reconstructed.getLegacy(), legacy);
});

Deno.test("a failed legacy backup prevents replacing the original workflow", async () => {
  const original = JSON.stringify(legacyReceiptPolicy());
  let current = original;
  const graph = createGraphStore({
    get: (key) => Promise.resolve(key === "graph:v1" ? current : null),
    put: (key, value) => {
      if (key === "graph:legacy:v1") throw new Error("storage unavailable");
      current = value;
      return Promise.resolve();
    },
  });
  await assertRejects(() => graph.put(actionPolicy()));
  assertEquals(current, original);
  assertEquals(await graph.getLegacy(), JSON.parse(original));
});
