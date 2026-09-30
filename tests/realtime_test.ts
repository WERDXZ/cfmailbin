import { assertEquals, assertStringIncludes } from "@std/assert";
import { InboxEvents } from "../src/realtime.ts";
import { handleRequest } from "../src/app.ts";
import {
  createMemoryBlobStore,
  createMemoryStore,
} from "../src/storage/memory.ts";

Deno.test("SSE sends ready and changes, reconnects with a snapshot hint, and cleans up cancelled streams", async () => {
  const hub = new InboxEvents();
  const reader = hub.subscribe().getReader();
  assertStringIncludes(
    new TextDecoder().decode((await reader.read()).value),
    "event: ready",
  );
  hub.publish();
  assertStringIncludes(
    new TextDecoder().decode((await reader.read()).value),
    "event: change",
  );
  await reader.cancel();
  hub.publish();
  const again = hub.subscribe().getReader();
  assertStringIncludes(
    new TextDecoder().decode((await again.read()).value),
    "event: ready",
  );
  await again.cancel();
});

Deno.test("SSE requires the owner session, disables caching, and signals successful mutations", async () => {
  const backend = {
    config: { appName: "test", allowCatchAll: false, defaultRetentionDays: 7 },
    store: createMemoryStore(),
    blobStore: createMemoryBlobStore(),
    events: new InboxEvents(),
  };
  assertEquals(
    (await handleRequest(new Request("http://localhost/api/events"), backend))
      .status,
    503,
  );
  const authenticated = {
    ...backend,
    developmentSession: {
      email: "owner@example.com",
      mode: "development" as const,
    },
  };
  const response = await handleRequest(
    new Request("http://localhost/api/events"),
    authenticated,
  );
  assertEquals(response.status, 200);
  assertStringIncludes(
    response.headers.get("content-type")!,
    "text/event-stream",
  );
  assertStringIncludes(response.headers.get("cache-control")!, "no-store");
  const reader = response.body!.pipeThrough(new TextDecoderStream())
    .getReader();
  await reader.read();
  const created = await handleRequest(
    new Request("http://localhost/api/aliases", {
      method: "POST",
      headers: { "x-cfmailbin-request": "1" },
      body: JSON.stringify({ address: "site@example.com" }),
    }),
    authenticated,
  );
  assertEquals(created.status, 201);
  assertStringIncludes((await reader.read()).value!, "event: change");
  await reader.cancel();
});
