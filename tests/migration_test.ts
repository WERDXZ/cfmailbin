import { assertEquals } from "@std/assert";
import { handleRequest } from "../src/app.ts";
import { createMemoryBlobStore } from "../src/storage/memory.ts";
import { sqliteStore } from "./storage_fixture.ts";

Deno.test("upgrading an older database restores inbox access without losing addresses", async () => {
  const fixture = sqliteStore(true);
  try {
    fixture.db.exec(`INSERT INTO aliases
      (id, address, default_action, retention_days, created_at, updated_at)
      VALUES ('old', 'old@example.com', 'keep', 7, '2026-04-24', '2026-04-24')`);
    const response = await handleRequest(
      new Request("http://localhost/api/inbox"),
      {
        store: fixture.store,
        blobStore: createMemoryBlobStore(),
        config: {
          appName: "test",
          allowCatchAll: true,
          defaultRetentionDays: 7,
        },
        developmentSession: { email: "owner@example.com", mode: "development" },
      },
    );
    assertEquals(response.status, 200);
    const data = await response.json();
    assertEquals(data.aliases[0].address, "old@example.com");
    assertEquals(data.aliases[0].tags, []);
    const created = await fixture.store.createAlias({
      address: "new@example.com",
      defaultAction: "keep",
      retentionDays: 7,
      tags: ["registration"],
    });
    assertEquals(created.tags, ["registration"]);
  } finally {
    fixture.close();
  }
});
