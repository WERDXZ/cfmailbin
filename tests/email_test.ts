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
  assertEquals(
    (await store.findAliasById(alias.id))?.address,
    "cleanup@example.com",
  );
});

Deno.test("received MIME yields a decoded subject and searchable body preview", async () => {
  const store = createMemoryStore();
  const blobStore = createMemoryBlobStore();
  const message = new FakeEmailMessage(
    "security@github.example",
    "github@example.com",
  );
  const raw = new TextEncoder().encode(
    "Subject: =?UTF-8?B?VmVyaWZpY2F0aW9uIGNvZGU=?=\r\nContent-Type: text/plain\r\n\r\nYour verification code is 004218.",
  );
  message.headers.set("subject", "=?UTF-8?B?VmVyaWZpY2F0aW9uIGNvZGU=?=");
  message.raw = new ReadableStream({
    start(controller) {
      controller.enqueue(raw);
      controller.close();
    },
  });
  message.rawSize = raw.length;
  const result = await processIncomingEmail({
    store,
    blobStore,
    message,
    config: {
      allowCatchAll: true,
      appName: "cfmailbin",
      defaultRetentionDays: 7,
    },
  });
  assertEquals(result.rejected, false);
  const stored = (await store.listMessages({ q: "004218" }))[0];
  assertEquals(stored.subject, "Verification code");
  assertEquals(stored.preview, "Your verification code is 004218.");
  assertEquals(stored.verificationCodes, ["004218"]);
  assertEquals(
    (await store.listAliases())[0].lastReceivedAt,
    stored.receivedAt,
  );
});

Deno.test("code beyond the preview is available without opening the email", async () => {
  const store = createMemoryStore();
  const message = new FakeEmailMessage(
    "security@example.org",
    "new@example.com",
  );
  const raw = new TextEncoder().encode(
    "Subject: Sign in\r\nContent-Type: text/plain\r\n\r\n" +
      "Welcome to our website. ".repeat(20) +
      "Your verification code is 000789.",
  );
  message.raw = new ReadableStream({
    start(controller) {
      controller.enqueue(raw);
      controller.close();
    },
  });
  await processIncomingEmail({
    store,
    blobStore: createMemoryBlobStore(),
    message,
    config: {
      allowCatchAll: true,
      appName: "cfmailbin",
      defaultRetentionDays: 7,
    },
  });
  const saved = (await store.listMessages())[0];
  assertEquals(saved.preview?.includes("000789"), false);
  assertEquals(saved.verificationCodes, ["000789"]);
});
