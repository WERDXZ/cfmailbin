import { assertEquals } from "@std/assert";
import { processIncomingEmail } from "../src/email/processor.ts";
import { purgeExpiredMessages } from "../src/services/retention.ts";
import {
  createMemoryBlobStore,
  createMemoryStore,
} from "../src/storage/memory.ts";

class FakeEmailMessage {
  forwardedTo?: string;
  headers = new Headers([["subject", "Weekly deal"]]);
  raw = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("raw mime content"));
      controller.close();
    },
  });
  rawSize = 16;
  rejectionReason?: string;

  constructor(readonly from: string, readonly to: string) {}

  forward(destination: string) {
    this.forwardedTo = destination;
    return Promise.resolve();
  }

  setReject(reason: string) {
    this.rejectionReason = reason;
  }
}

Deno.test("email processing auto-creates aliases in catch-all mode", async () => {
  const store = createMemoryStore();
  const blobStore = createMemoryBlobStore();
  const message = new FakeEmailMessage(
    "promo@shop.com",
    "new-alias@example.com",
  );

  const result = await processIncomingEmail({
    blobStore,
    config: {
      allowCatchAll: true,
      appName: "cfmailbin",
      autoCreateAliasTag: "auto-created",
      defaultForwardTo: "owner@example.com",
      defaultRetentionDays: 7,
    },
    message,
    store,
  });

  assertEquals(result.rejected, false);
  assertEquals(result.action, "forward");
  assertEquals(message.forwardedTo, "owner@example.com");

  const aliases = await store.listAliases();
  const messages = await store.listMessages();

  assertEquals(aliases.length, 1);
  assertEquals(aliases[0].address, "new-alias@example.com");
  assertEquals(aliases[0].tags, ["auto-created"]);
  assertEquals(messages.length, 1);
  assertEquals(messages[0].status, "forwarded");
});

Deno.test("retention cleanup removes expired messages and blobs", async () => {
  const store = createMemoryStore();
  const blobStore = createMemoryBlobStore();
  const alias = await store.createAlias({
    address: "cleanup@example.com",
    defaultAction: "keep",
    retentionDays: 1,
  });
  await blobStore.put(
    "messages/expired.eml",
    new TextEncoder().encode("expired"),
  );
  await store.createMessage({
    aliasAddress: alias.address,
    aliasId: alias.id,
    expiresAt: "2026-04-20T00:00:00.000Z",
    from: "sender@example.com",
    rawKey: "messages/expired.eml",
    receivedAt: "2026-04-19T00:00:00.000Z",
    status: "inbox",
    subject: "Old mail",
  });

  const result = await purgeExpiredMessages(
    store,
    blobStore,
    "2026-04-21T00:00:00.000Z",
  );

  assertEquals(result.deletedCount, 1);
  assertEquals((await store.listMessages()).length, 0);
  assertEquals(await blobStore.get("messages/expired.eml"), null);
});
