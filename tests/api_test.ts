import { assertEquals, assertMatch } from "@std/assert";
import { handleRequest } from "../src/app.ts";
import {
  createMemoryBlobStore,
  createMemoryStore,
} from "../src/storage/memory.ts";

function authHeaders(): Headers {
  return new Headers({
    "x-cfmailbin-request": "1",
    "content-type": "application/json",
  });
}

function createBackend() {
  return {
    blobStore: createMemoryBlobStore(),
    config: {
      accessAudience: "test-audience",
      accessTeamDomain: "test.cloudflareaccess.com",
      ownerEmail: "owner@example.com",
      allowCatchAll: false,
      appName: "cfmailbin",
      autoCreateAliasTag: undefined,
      defaultForwardTo: "owner@example.com",
      defaultRetentionDays: 7,
    },
    store: createMemoryStore(),
    developmentSession: {
      email: "owner@example.com",
      mode: "development" as const,
    },
  };
}

Deno.test("generated registration aliases use the configured domain and retain website labels", async () => {
  const backend = createBackend();
  const configured = {
    ...backend,
    config: { ...backend.config, emailDomain: "mail.example.com" },
  };
  const create = (body: unknown, target = configured) =>
    handleRequest(
      new Request("http://localhost/api/aliases/generate", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
      }),
      target,
    );
  const response = await create({
    label: "GitHub",
    domain: "wrong.example.com",
  });
  assertEquals(response.status, 201);
  const alias = await response.json();
  assertMatch(alias.address, /^github-[a-f0-9]{12}@mail\.example\.com$/);
  assertEquals(alias.description, "GitHub");
  assertEquals(alias.defaultAction, "keep");
  assertEquals(alias.retentionDays, 7);
  const renamed = await handleRequest(
    new Request(`http://localhost/api/aliases/${alias.id}`, {
      method: "PATCH",
      headers: authHeaders(),
      body: '{"description":"","retentionDays":14}',
    }),
    configured,
  );
  assertEquals(renamed.status, 200);
  assertEquals((await renamed.json()).description, undefined);
  assertEquals((await create({ label: "" })).status, 400);
  assertEquals((await create({ label: "x".repeat(121) })).status, 400);
  const noDomain = await handleRequest(
    new Request("http://localhost/api/aliases/generate", {
      method: "POST",
      headers: authHeaders(),
      body: '{"label":"GitHub"}',
    }),
    backend,
  );
  assertEquals(noDomain.status, 400);
  assertEquals((await backend.store.listAliases()).length, 1);
});

Deno.test("parsed content is authenticated, uncached and available for existing raw messages", async () => {
  const backend = createBackend();
  const alias = await backend.store.createAlias({
    address: "site@example.com",
    defaultAction: "keep",
    retentionDays: 7,
  });
  await backend.blobStore.put(
    "verify.eml",
    new TextEncoder().encode(
      "Subject: Verification code\r\n\r\nYour verification code is 001234.",
    ),
  );
  const message = await backend.store.createMessage({
    aliasId: alias.id,
    aliasAddress: alias.address,
    expiresAt: "2030-01-01T00:00:00Z",
    from: "site@example.org",
    receivedAt: new Date().toISOString(),
    status: "inbox",
    subject: "Verification code",
    rawKey: "verify.eml",
  });
  const req = new Request(
    `http://localhost/api/messages/${message.id}/content`,
  );
  const denied = await handleRequest(req, {
    ...backend,
    developmentSession: undefined,
  });
  assertEquals(denied.status, 401);
  const result = await handleRequest(req, backend);
  assertEquals(result.status, 200);
  assertEquals(result.headers.get("cache-control"), "no-store");
  assertEquals((await result.json()).codes, ["001234"]);
  assertEquals(
    (await backend.store.getMessage(message.id))?.verificationCodes,
    ["001234"],
  );
  assertEquals(
    (await handleRequest(
      new Request("http://localhost/api/messages/missing/content"),
      backend,
    )).status,
    404,
  );
});

Deno.test("api rejects a legacy bearer token without an Access session", async () => {
  const response = await handleRequest(
    new Request("http://localhost/api/aliases", {
      headers: { authorization: "Bearer secret-token" },
    }),
    { ...createBackend(), developmentSession: undefined },
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
        tags: ["manual"],
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
  assertEquals(alias.tags, ["manual"]);

  const listResponse = await handleRequest(
    new Request("http://localhost/api/aliases", { headers: authHeaders() }),
    backend,
  );
  const aliases = await listResponse.json();

  assertEquals(listResponse.status, 200);
  assertEquals(aliases.length, 1);
  assertEquals(aliases[0].address, "shop@example.com");
  assertEquals(aliases[0].tags, ["manual"]);
});

Deno.test("cookie-authenticated writes reject cross-origin requests and plain forms", async () => {
  const backend = createBackend();
  const cases: HeadersInit[] = [
    { "content-type": "text/plain" },
    { "x-cfmailbin-request": "1", origin: "https://attacker.example" },
    { "x-cfmailbin-request": "1", origin: "null" },
    { "x-cfmailbin-request": "1", "sec-fetch-site": "cross-site" },
  ];
  for (const headers of cases) {
    const response = await handleRequest(
      new Request("http://localhost/api/aliases", {
        method: "POST",
        headers,
        body: JSON.stringify({
          address: "forged@example.com",
          defaultAction: "keep",
          retentionDays: 7,
        }),
      }),
      backend,
    );
    assertEquals(response.status, 403);
    assertEquals(response.headers.get("cache-control"), "no-store");
  }
  const response = await handleRequest(
    new Request("http://localhost/api/aliases"),
    backend,
  );
  assertEquals(await response.json(), []);
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

Deno.test("api can batch delete messages and raw blobs", async () => {
  const backend = createBackend();
  const alias = await backend.store.createAlias({
    address: "delete@example.com",
    defaultAction: "keep",
    retentionDays: 7,
  });
  await backend.blobStore.put(
    "messages/delete.eml",
    new TextEncoder().encode("delete me"),
  );
  const message = await backend.store.createMessage({
    aliasAddress: alias.address,
    aliasId: alias.id,
    expiresAt: "2026-05-01T00:00:00.000Z",
    from: "sender@example.com",
    rawKey: "messages/delete.eml",
    receivedAt: "2026-04-24T00:00:00.000Z",
    status: "inbox",
    subject: "Delete",
  });

  const response = await handleRequest(
    new Request("http://localhost/api/messages/batch-delete", {
      body: JSON.stringify({ ids: [message.id, "missing-message"] }),
      headers: authHeaders(),
      method: "POST",
    }),
    backend,
  );
  const payload = await response.json();

  assertEquals(response.status, 200);
  assertEquals(payload.deleted, 1);
  assertEquals(payload.rawDeleted, 1);
  assertEquals(payload.missing, ["missing-message"]);
  assertEquals(await backend.store.getMessage(message.id), null);
  assertEquals(await backend.blobStore.get("messages/delete.eml"), null);

  const auditResponse = await handleRequest(
    new Request("http://localhost/api/audit-events", {
      headers: authHeaders(),
    }),
    backend,
  );
  const events = await auditResponse.json();

  assertEquals(auditResponse.status, 200);
  assertEquals(events.length, 1);
  assertEquals(events[0].eventType, "manual_deleted");
  assertEquals(events[0].messageId, message.id);
});
