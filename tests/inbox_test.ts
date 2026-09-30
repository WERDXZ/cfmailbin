import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { sqliteStore } from "./storage_fixture.ts";
import { handleRequest } from "../src/app.ts";
import {
  createMemoryBlobStore,
  createMemoryStore,
} from "../src/storage/memory.ts";

for (const kind of ["memory", "D1"] as const) {
  Deno.test(`${kind}: inbox keeps codes, used addresses and delivery evidence after cleanup`, async () => {
    const { store, close } = kind === "D1"
      ? sqliteStore()
      : { store: createMemoryStore(), close() {} };
    try {
      assertEquals(await store.getDeliveryStatus("example.com"), {});
      const alias = await store.createAlias({
        address: "account@example.com",
        description: "GitHub",
        defaultAction: "keep",
        retentionDays: 7,
      });
      const newer = await store.createMessage({
        aliasId: alias.id,
        aliasAddress: alias.address,
        subject: "Sign in",
        from: "sender@example.org",
        receivedAt: "2026-09-29T12:00:00.000Z",
        expiresAt: "2026-10-06T12:00:00.000Z",
        status: "inbox",
        verificationCodes: ["001234"],
      });
      await store.createMessage({
        aliasId: alias.id,
        aliasAddress: alias.address,
        subject: "Earlier",
        from: "sender@example.org",
        receivedAt: "2026-09-28T12:00:00.000Z",
        expiresAt: "2026-10-05T12:00:00.000Z",
        status: "inbox",
      });
      assertEquals(
        (await store.listMessages({ q: "github" }))[0].verificationCodes,
        ["001234"],
      );
      assertEquals(
        (await store.findAliasById(alias.id))?.lastReceivedAt,
        newer.receivedAt,
      );
      const received = await store.createAuditEvent({
        aliasAddress: alias.address,
        eventType: "received",
        messageId: newer.id,
      });
      const rejected = await store.createAuditEvent({
        aliasAddress: "disabled@example.com",
        eventType: "rejected_disabled",
        reason: "Alias disabled",
      });
      await store.createAuditEvent({
        aliasAddress: "other@sub.example.com",
        eventType: "received",
      });
      // Unrelated administrative events must not hide the last successful delivery.
      for (let i = 0; i < 105; i++) {
        await store.createAuditEvent({ eventType: "manual_deleted" });
      }
      await store.deleteExpiredMessages("2030-01-01T00:00:00.000Z");
      assertEquals(await store.listMessages(), []);
      assertEquals(
        (await store.listAliases())[0].lastReceivedAt,
        newer.receivedAt,
      );
      const delivery = await store.getDeliveryStatus("example.com");
      assertEquals(delivery.lastReceived?.id, received.id);
      assertEquals(delivery.lastRejected?.id, rejected.id);
      assertEquals(await store.getDeliveryStatus("not-example.com"), {});

      const response = await handleRequest(
        new Request("http://localhost/api/inbox?q=github"),
        {
          store,
          blobStore: createMemoryBlobStore(),
          config: {
            appName: "cfmailbin",
            allowCatchAll: true,
            defaultRetentionDays: 7,
            emailDomain: "example.com",
          },
          developmentSession: {
            email: "owner@example.com",
            mode: "development",
          },
        },
      );
      assertEquals(response.status, 200);
      assertEquals(response.headers.get("cache-control"), "no-store");
      const inbox = await response.json();
      assertEquals(inbox.messages, []);
      assertEquals(inbox.aliases[0].address, alias.address);
      assertEquals(inbox.delivery.lastReceived.id, received.id);
    } finally {
      close();
    }
  });
}

Deno.test("inbox migration preserves legacy mail and backfills receipt history from deleted mail", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const name of ["0001_init.sql", "0002_audit_events.sql"]) {
      db.exec(Deno.readTextFileSync(`src/db/migrations/${name}`));
    }
    db.exec(
      `INSERT INTO aliases (id, address, default_action, enabled, retention_days, created_at, updated_at)
      VALUES ('old', 'old@example.com', 'keep', 1, 7, '2026-01-01', '2026-01-01');
      INSERT INTO messages (id, alias_id, alias_address, sender, subject, status, received_at, expires_at, created_at)
      VALUES ('old-mail', 'old', 'old@example.com', 'sender@example.org', 'Legacy', 'inbox', '2026-01-02', '2026-01-09', '2026-01-02');
      INSERT INTO audit_events (id, event_type, alias_address, created_at)
      VALUES ('receipt', 'received', 'old@example.com', '2026-01-05');`,
    );
    db.exec(Deno.readTextFileSync("src/db/migrations/0003_inbox.sql"));
    const mail = db.prepare("SELECT subject, verification_codes FROM messages")
      .get();
    assertEquals(mail?.subject, "Legacy");
    assertEquals(mail?.verification_codes, null);
    assertEquals(
      db.prepare("SELECT last_received_at FROM aliases").get()
        ?.last_received_at,
      "2026-01-05",
    );
  } finally {
    db.close();
  }
});

Deno.test("inbox API requires authentication and never reads MIME blobs while polling", async () => {
  const store = createMemoryStore();
  const backend = {
    store,
    blobStore: {
      ...createMemoryBlobStore(),
      get() {
        throw new Error("Polling must not read raw mail");
      },
    },
    config: {
      appName: "cfmailbin",
      allowCatchAll: true,
      defaultRetentionDays: 7,
      ownerEmail: "owner@example.com",
      accessAudience: "test-audience",
      accessTeamDomain: "test.cloudflareaccess.com",
    },
  };
  const request = new Request("http://localhost/api/inbox");
  assertEquals((await handleRequest(request, backend)).status, 401);
  const alias = await store.createAlias({
    address: "old@example.com",
    defaultAction: "keep",
    retentionDays: 7,
  });
  await store.createMessage({
    aliasId: alias.id,
    aliasAddress: alias.address,
    subject: "Your verification code is 001234",
    rawKey: "old.eml",
    from: "sender@example.org",
    status: "inbox",
    receivedAt: "2026-09-29T00:00:00.000Z",
    expiresAt: "2026-10-06T00:00:00.000Z",
  });
  const response = await handleRequest(request, {
    ...backend,
    developmentSession: { email: "owner@example.com", mode: "development" },
  });
  assertEquals(response.status, 200);
  const inbox = await response.json();
  assertEquals(inbox.messages[0].verificationCodes, ["001234"]);
  assertEquals(inbox.delivery, {}); // Merely creating records does not establish real delivery.
});
