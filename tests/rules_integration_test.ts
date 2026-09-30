import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { handleRequest } from "../src/app.ts";
import { processIncomingEmail } from "../src/email/processor.ts";
import {
  createMemoryBlobStore,
  createMemoryStore,
} from "../src/storage/memory.ts";
import { sqliteStore } from "./storage_fixture.ts";
import type { CreateRuleInput } from "../src/domain/models.ts";

const codeRule: CreateRuleInput = {
  name: "验证码",
  condition: { field: "hasCode", value: true },
  actions: { tags: ["login"], retentionDays: 1 },
  stopProcessing: false,
};
const config = {
  appName: "cfmailbin",
  allowCatchAll: true,
  defaultRetentionDays: 7,
};
function mail() {
  const raw = new TextEncoder().encode(
    "Subject: Account login\r\nContent-Type: text/plain\r\n\r\nYour verification code is 001234.",
  );
  return {
    from: "security@example.org",
    to: "login@example.com",
    headers: new Headers({ subject: "Account login" }),
    raw: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(raw);
        c.close();
      },
    }),
    forwarded: [] as string[],
    rejected: "",
    forward(to: string) {
      this.forwarded.push(to);
      return Promise.resolve();
    },
    setReject(reason: string) {
      this.rejected = reason;
    },
  };
}
function req(path: string, data: unknown, method = "POST") {
  return new Request(`http://localhost/api/rules${path}`, {
    method,
    headers: { "content-type": "application/json", "x-cfmailbin-request": "1" },
    body: JSON.stringify(data),
  });
}

for (const kind of ["memory", "D1"] as const) {
  Deno.test(`${kind}: expressive rule persistence, trial and actual intake agree`, async () => {
    const fixture = kind === "D1"
      ? sqliteStore()
      : { store: createMemoryStore(), close() {} };
    try {
      const store = fixture.store, blobStore = createMemoryBlobStore();
      const backend = {
        store,
        blobStore,
        config,
        developmentSession: {
          email: "owner@example.com",
          mode: "development" as const,
        },
      };
      const first = await store.createRule(codeRule);
      const second = await store.createRule({
        name: "send alert",
        condition: { field: "subject", operator: "contains", value: "account" },
        actions: {
          delivery: "forward",
          forwardTo: "owner@example.com",
          tags: ["alert"],
        },
      });
      const incoming = mail();
      await processIncomingEmail({ ...backend, message: incoming });
      assertEquals(incoming.forwarded, ["owner@example.com"]);
      const saved = (await store.listMessages())[0];
      assertEquals(saved.status, "forwarded");
      assertEquals(saved.tags, ["alert", "login"]);
      assertEquals(
        Date.parse(saved.expiresAt) - Date.parse(saved.receivedAt),
        86400000,
      );
      assertEquals(saved.ruleTrace?.map((t) => t.name), [
        "验证码",
        "send alert",
      ]);
      assertEquals((await store.listRules()).map((r) => r.id), [
        first.id,
        second.id,
      ]);
      const before = {
        messages: await store.listMessages(),
        rules: await store.listRules(),
        events: await store.listAuditEvents(),
      };
      const draft = {
        ...codeRule,
        actions: { delivery: "trash", retentionDays: 2 },
        stopProcessing: true,
      };
      const trial = await handleRequest(
        req("/preview", { draft, ruleId: first.id }),
        backend,
      );
      assertEquals(trial.status, 200);
      const preview = await trial.json();
      assertEquals(preview.matched, 1);
      assertEquals(preview.rows[0].decision.action, "trash");
      assertEquals(preview.rows[0].decision.retentionDays, 2);
      assertEquals({
        messages: await store.listMessages(),
        rules: await store.listRules(),
        events: await store.listAuditEvents(),
      }, before);
      assertEquals(incoming.forwarded, ["owner@example.com"]);
      // Appending the same draft is skipped by the earlier stop rule.
      const appended =
        await (await handleRequest(req("/preview", { draft }), backend)).json();
      assertEquals(appended.matched, 0);
      assertEquals(appended.rows[0].draftReached, false);
      // Invalid reorder is rejected without changing order; valid order persists.
      assertEquals(
        (await handleRequest(
          req("/reorder", { ids: [first.id, first.id] }),
          backend,
        )).status,
        409,
      );
      assertEquals(
        (await handleRequest(
          req("/reorder", { ids: [second.id, first.id] }),
          backend,
        )).status,
        200,
      );
      assertEquals(
        (await store.listRulesForAlias(saved.aliasId)).map((r) => r.id),
        [second.id, first.id],
      );
      const update = await handleRequest(
        req(`/${second.id}`, {
          condition: { not: { field: "hasCode", value: false } },
          actions: { delivery: "keep", retentionDays: 30 },
          name: "updated",
        }, "PATCH"),
        backend,
      );
      assertEquals(update.status, 200);
      const secondMail = mail();
      await processIncomingEmail({ ...backend, message: secondMail });
      assertEquals(secondMail.forwarded, []);
      const newer = (await store.listMessages()).find((m) =>
        m.id !== saved.id
      )!;
      assertEquals(
        Date.parse(newer.expiresAt) - Date.parse(newer.receivedAt),
        30 * 86400000,
      );
      // Historical explanation is a snapshot, unaffected by rule editing.
      assertEquals(
        (await store.getMessage(saved.id))?.ruleTrace?.[1].name,
        "send alert",
      );
      assertEquals(
        (await handleRequest(
          req("", { condition: { all: [] }, actions: { delivery: "block" } }),
          backend,
        )).status,
        400,
      );
      assertEquals(
        (await handleRequest(
          req("", { field: "subject", pattern: "newsletter", action: "trash" }),
          backend,
        )).status,
        201,
      );
    } finally {
      fixture.close();
    }
  });
}

Deno.test("rule migration preserves scoped-first legacy order and existing mail", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (
      const name of ["0001_init.sql", "0002_audit_events.sql", "0003_inbox.sql"]
    ) db.exec(Deno.readTextFileSync(`src/db/migrations/${name}`));
    db.exec(
      `INSERT INTO aliases (id,address,default_action,retention_days,enabled,created_at,updated_at) VALUES ('a','a@example.com','keep',7,1,'1','1');
      INSERT INTO rules (id,alias_id,field,pattern,action,enabled,created_at,updated_at) VALUES
      ('global-old',NULL,'subject','x','trash',1,'1','1'), ('scoped-new','a','from','x','keep',1,'3','3'), ('global-new',NULL,'subject','y','block',1,'2','2');`,
    );
    db.exec(Deno.readTextFileSync("src/db/migrations/0004_rules.sql"));
    assertEquals(
      db.prepare("SELECT id FROM rules ORDER BY priority").all().map((r) =>
        r.id
      ),
      ["scoped-new", "global-old", "global-new"],
    );
    assertEquals(
      db.prepare(
        "SELECT action,stop_processing,condition_json FROM rules WHERE id='global-old'",
      ).get()?.action,
      "trash",
    );
    assertEquals(
      db.prepare("SELECT stop_processing FROM rules WHERE id='global-old'")
        .get()?.stop_processing,
      1,
    );
  } finally {
    db.close();
  }
});

Deno.test("final reject prevents an earlier forwarding effect and leaves only an audit record", async () => {
  const store = createMemoryStore(), blobStore = createMemoryBlobStore();
  await store.createRule({
    condition: { field: "hasCode", value: true },
    actions: { delivery: "forward", forwardTo: "owner@example.com" },
    stopProcessing: false,
  });
  await store.createRule({
    condition: { field: "subject", operator: "contains", value: "account" },
    actions: { delivery: "block" },
    stopProcessing: false,
  });
  const incoming = mail();
  const result = await processIncomingEmail({
    store,
    blobStore,
    config,
    message: incoming,
  });
  assertEquals(result.rejected, true);
  assertEquals(incoming.forwarded, []);
  assertEquals(await store.listMessages(), []);
  const event = (await store.listAuditEvents()).find((e) =>
    e.eventType === "blocked_by_rule"
  );
  assertEquals(Array.isArray(event?.metadata?.ruleTrace), true);
});
