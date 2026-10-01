import { assertEquals, assertRejects } from "@std/assert";
import { createMemoryStore } from "../src/storage/memory.ts";
import { sqliteStore } from "./storage_fixture.ts";

for (const kind of ["memory", "D1"] as const) {
  Deno.test(`${kind}: appending action tags preserves existing and concurrent tags`, async () => {
    const fixture = kind === "D1"
      ? sqliteStore()
      : { store: createMemoryStore(), close() {} };
    try {
      const alias = await fixture.store.createAlias({
        address: "inbox@example.com",
        defaultAction: "keep",
        retentionDays: 7,
      });
      const message = await fixture.store.createMessage({
        aliasId: alias.id,
        aliasAddress: alias.address,
        subject: "Test",
        from: "sender@example.com",
        receivedAt: "2026-09-30T12:00:00.000Z",
        expiresAt: "2026-10-07T12:00:00.000Z",
        status: "inbox",
        tags: ["Owner"],
      });

      const [first, second] = await Promise.all([
        fixture.store.appendMessageTags(message.id, [
          " Automated ",
          "AUTOMATED",
        ]),
        fixture.store.appendMessageTags(message.id, ["Concurrent"]),
      ]);

      assertEquals(first?.id, message.id);
      assertEquals(second?.id, message.id);
      assertEquals(
        (await fixture.store.getMessage(message.id))?.tags.toSorted(),
        ["automated", "concurrent", "owner"],
      );
    } finally {
      fixture.close();
    }
  });

  Deno.test(`${kind}: appending tags cannot recreate a deleted message`, async () => {
    const fixture = kind === "D1"
      ? sqliteStore()
      : { store: createMemoryStore(), close() {} };
    try {
      const alias = await fixture.store.createAlias({
        address: "deleted@example.com",
        defaultAction: "keep",
        retentionDays: 7,
      });
      const message = await fixture.store.createMessage({
        aliasId: alias.id,
        aliasAddress: alias.address,
        subject: "Delete me",
        from: "sender@example.com",
        receivedAt: "2026-09-30T12:00:00.000Z",
        expiresAt: "2026-10-07T12:00:00.000Z",
        status: "inbox",
      });
      await fixture.store.deleteMessages([message.id]);

      assertEquals(
        await fixture.store.appendMessageTags(message.id, ["automated"]),
        null,
      );
      assertEquals(await fixture.store.getMessage(message.id), null);
      assertEquals(await fixture.store.listTags(), []);
    } finally {
      fixture.close();
    }
  });
}

Deno.test("D1: appending tags rolls back tag creation when membership insertion fails", async () => {
  const fixture = sqliteStore();
  try {
    const alias = await fixture.store.createAlias({
      address: "rollback@example.com",
      defaultAction: "keep",
      retentionDays: 7,
    });
    const message = await fixture.store.createMessage({
      aliasId: alias.id,
      aliasAddress: alias.address,
      subject: "Rollback",
      from: "sender@example.com",
      receivedAt: "2026-09-30T12:00:00.000Z",
      expiresAt: "2026-10-07T12:00:00.000Z",
      status: "inbox",
    });
    fixture.db.exec(`
      CREATE TRIGGER reject_appended_message_tag
      BEFORE INSERT ON message_tags
      BEGIN
        SELECT RAISE(ABORT, 'forced membership failure');
      END
    `);

    await assertRejects(() =>
      fixture.store.appendMessageTags(message.id, ["rolled-back"])
    );
    assertEquals(await fixture.store.listTags(), []);
    assertEquals((await fixture.store.getMessage(message.id))?.tags, []);
  } finally {
    fixture.close();
  }
});
