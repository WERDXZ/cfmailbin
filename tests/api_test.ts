import { assertEquals } from "@std/assert";
import { handleRequest } from "../src/app.ts";
import {
  createMemoryBlobStore,
  createMemoryStore,
} from "../src/storage/memory.ts";

function authHeaders(): Headers {
  return new Headers({
    authorization: "Bearer secret-token",
    "content-type": "application/json",
  });
}

function createBackend() {
  return {
    blobStore: createMemoryBlobStore(),
    config: {
      allowCatchAll: false,
      appName: "cfmailbin",
      defaultForwardTo: "owner@example.com",
      defaultRetentionDays: 7,
    },
    store: createMemoryStore({ tokens: ["secret-token"] }),
  };
}

Deno.test("api rejects missing bearer token", async () => {
  const response = await handleRequest(
    new Request("http://localhost/api/aliases"),
    createBackend(),
  );

  assertEquals(response.status, 401);
});

Deno.test("api can create and list aliases", async () => {
  const backend = createBackend();
  const createResponse = await handleRequest(
    new Request("http://localhost/api/aliases", {
      body: JSON.stringify({
        address: "shop@example.com",
        defaultAction: "forward",
        retentionDays: 14,
      }),
      headers: authHeaders(),
      method: "POST",
    }),
    backend,
  );

  assertEquals(createResponse.status, 201);
  const alias = await createResponse.json();
  assertEquals(alias.address, "shop@example.com");
  assertEquals(alias.defaultAction, "forward");

  const listResponse = await handleRequest(
    new Request("http://localhost/api/aliases", { headers: authHeaders() }),
    backend,
  );
  const aliases = await listResponse.json();

  assertEquals(listResponse.status, 200);
  assertEquals(aliases.length, 1);
  assertEquals(aliases[0].address, "shop@example.com");
});

Deno.test("api can replace message tags and fetch raw message", async () => {
  const backend = createBackend();
  const alias = await backend.store.createAlias({
    address: "tagged@example.com",
    defaultAction: "keep",
    retentionDays: 7,
  });
  await backend.blobStore.put(
    "messages/raw.eml",
    new TextEncoder().encode("hello"),
  );
  const message = await backend.store.createMessage({
    aliasAddress: alias.address,
    aliasId: alias.id,
    expiresAt: "2026-05-01T00:00:00.000Z",
    from: "sender@example.com",
    rawKey: "messages/raw.eml",
    receivedAt: "2026-04-24T00:00:00.000Z",
    status: "inbox",
    subject: "Hello",
  });

  const tagsResponse = await handleRequest(
    new Request(`http://localhost/api/messages/${message.id}/tags`, {
      body: JSON.stringify({ tags: ["news", "shop"] }),
      headers: authHeaders(),
      method: "PUT",
    }),
    backend,
  );
  const tagged = await tagsResponse.json();

  assertEquals(tagsResponse.status, 200);
  assertEquals(tagged.tags, ["news", "shop"]);

  const rawResponse = await handleRequest(
    new Request(`http://localhost/api/messages/${message.id}/raw`, {
      headers: authHeaders(),
    }),
    backend,
  );

  assertEquals(rawResponse.status, 200);
  assertEquals(await rawResponse.text(), "hello");
});
