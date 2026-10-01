import { assert, assertEquals } from "@std/assert";
import { handleRequest } from "../src/app.ts";
import { readConfig } from "../src/config.ts";
import { createGraphStore } from "../src/graph/storage.ts";
import { graphTemplate } from "../src/graph/templates.ts";
import {
  createMemoryBlobStore,
  createMemoryStore,
} from "../src/storage/memory.ts";

Deno.test("fresh configuration has no saved workflow, policies or nodes; templates only create explicitly saved copies", async () => {
  const data = new Map<string, string>();
  const graph = createGraphStore({
    get: (key) => Promise.resolve(data.get(key) ?? null),
    put: (key, value) => {
      data.set(key, value);
      return Promise.resolve();
    },
  });
  const backend = {
    config: readConfig(),
    store: createMemoryStore(),
    blobStore: createMemoryBlobStore(),
    graph,
    developmentSession: {
      mode: "development" as const,
      email: "owner@example.com",
    },
  };
  const request = (path: string, method = "GET", body?: unknown) =>
    handleRequest(
      new Request(`http://localhost/api/${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          "x-cfmailbin-request": "1",
          origin: "http://localhost",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      backend,
    );
  const initial = await (await request("graph")).json();
  assertEquals(initial.graph, null);
  assertEquals(initial.effectiveGraph, null);
  assertEquals(initial.plan, null);
  const policies = await (await request("policies")).json();
  const nodes = await (await request("node-library")).json();
  assertEquals(policies.policies, []);
  assertEquals(nodes.presets, []);
  assert(policies.templates.length > 0);
  assert(nodes.templates.length > 0);
  assertEquals(data.size, 0, "reading templates must not seed storage");
  const policy = { ...policies.templates[0], id: "custom" };
  const savedPolicy = await request("policies/custom", "PUT", policy);
  assertEquals(savedPolicy.status, 200);
  assertEquals((await (await request("policies")).json()).policies.length, 1);
  const preset = nodes.templates.find((item: { id: string }) =>
    item.id === "builtin_keep"
  );
  const savedNode = await request("node-library/custom", "PUT", preset);
  assertEquals(savedNode.status, 200);
  assertEquals(
    (await (await request("node-library")).json()).presets.length,
    1,
  );
  assertEquals(
    await graph.get(),
    null,
    "saving a library item cannot create a workflow",
  );
  const flow = graphTemplate("verification");
  assertEquals(flow.enabled, false);
  assertEquals((await request("graph", "PUT", flow)).status, 200);
  assertEquals((await (await request("graph")).json()).effectiveGraph, null);
  await request("policies/custom", "DELETE");
  await request("node-library/custom", "DELETE");
  assertEquals((await (await request("policies")).json()).policies, []);
  assertEquals((await (await request("node-library")).json()).presets, []);
});
