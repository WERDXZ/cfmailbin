import { migrateGraph } from "../src/graph/migrate.ts";
import { legacyReceiptPolicy } from "./workflow_fixture.ts";
import { receiptPolicy } from "./workflow_fixture.ts";
import { assert, assertEquals } from "@std/assert";
import { readConfig } from "../src/config.ts";
import { handleRequest } from "../src/app.ts";
import { processIncomingEmail } from "../src/email/processor.ts";
import {
  createMemoryBlobStore,
  createMemoryStore,
} from "../src/storage/memory.ts";
import { sqliteStore } from "./storage_fixture.ts";
import { gateway, gatewayBase, gatewayEnv } from "./analysis_fixture.ts";

function mail(body = "Enter 001234 to finish signing in.") {
  const raw = new TextEncoder().encode(
    `Subject: Welcome back\r\nContent-Type: text/plain\r\n\r\n${body}`,
  );
  return {
    from: "login@example.org",
    to: "test@example.com",
    headers: new Headers({ subject: "Welcome back" }),
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

const config = readConfig({
  ...gatewayEnv,
  CFMAILBIN_ALLOW_CATCH_ALL: "true",
  CFMAILBIN_AI_ENABLED: "true",
  DEEPSEEK_API_KEY: "test-secret-never-public",
});
const successful = () =>
  Response.json({
    choices: [{
      finish_reason: "stop",
      message: {
        content: JSON.stringify({
          enrich: {
            category: "verification",
            hasCode: true,
            codes: [{
              value: "001234",
              context: "Enter 001234 to finish signing in.",
            }],
          },
        }),
      },
    }],
  });

for (const kind of ["memory", "D1"] as const) {
  Deno.test(`${kind}: concurrent receipts share the daily AI quota`, async () => {
    const fixture = kind === "D1"
      ? sqliteStore()
      : { store: createMemoryStore(), close() {} };
    try {
      const store = fixture.store, blobStore = createMemoryBlobStore();
      const gate = Promise.withResolvers<Response>();
      const started = Promise.withResolvers<void>();
      let calls = 0;
      const pending = Promise.all(
        Array.from({ length: 3 }, () =>
          processIncomingEmail({
            graph: receiptPolicy(),
            config: { ...config, ai: { ...config.ai!, dailyLimit: 1 } },
            store,
            blobStore,
            message: mail(),
            analysisFetch: () => {
              calls++;
              started.resolve();
              return gate.promise;
            },
          })),
      );
      await started.promise;
      gate.resolve(successful());
      const results = await pending;
      assertEquals(calls, 1);
      assertEquals(results.every((result) => !result.rejected), true);
      const messages = await store.listMessages();
      assertEquals(messages.length, 3);
      assertEquals(
        messages.filter((message) => message.analysis?.status === "complete")
          .map((message) => message.verificationCodes),
        [["001234"]],
      );
      assertEquals(
        messages.filter((message) => message.analysis?.reason === "daily_limit")
          .length,
        2,
      );
    } finally {
      fixture.close();
    }
  });
  Deno.test(`${kind}: graph analysis preserves concurrent edits, never replays rules, and polling never calls AI`, async () => {
    const fixture = kind === "D1"
      ? sqliteStore()
      : { store: createMemoryStore(), close() {} };
    try {
      const store = fixture.store, blobStore = createMemoryBlobStore();
      // If rerun after enrichment, this rule would forward the message.
      await store.createRule({
        condition: { field: "hasCode", value: true },
        actions: { delivery: "forward", forwardTo: "owner@example.com" },
      });
      await store.createRule({
        name: "Explicit fallback",
        condition: { field: "subject", operator: "contains", value: "welcome" },
        actions: { delivery: "keep" },
      });
      const graph = {
        ...migrateGraph(
          legacyReceiptPolicy(),
          await store.listRules(),
          await store.listAliases(),
        ).graph,
        enabled: true,
      };
      const gate = Promise.withResolvers<Response>();
      const started = Promise.withResolvers<void>();
      let calls = 0;
      const message = mail();
      const pending = processIncomingEmail({
        graph,
        store,
        blobStore,
        config,
        message,
        analysisFetch: () => {
          calls++;
          started.resolve();
          return gate.promise;
        },
      });
      await started.promise;
      const [receiving] = await store.listMessages();
      assertEquals(receiving.graphRun?.status, "running");
      assertEquals(receiving.verificationCodes, []);
      const ruleSnapshot = receiving.graphRun?.steps.filter((step) =>
        graph.nodes.find((node) => node.id === step.nodeId)?.kind === "evaluate"
      );
      assertEquals(
        ruleSnapshot?.map((step) =>
          (step.output as { matched: boolean }).matched
        ),
        [false, true],
      );
      await store.updateMessage(receiving.id, { status: "trashed" });
      await store.replaceMessageTags(receiving.id, ["owner-edited"]);
      gate.resolve(successful());
      const result = await pending;
      assertEquals(result.rejected, false);
      const saved = (await store.getMessage(result.messageId!))!;
      assertEquals(saved.verificationCodes, ["001234"]);
      assertEquals(saved.analysis?.category, "verification");
      assertEquals(saved.analysis?.status, "complete");
      assertEquals(saved.status, "trashed"); // User's concurrent edit survives.
      assertEquals(saved.tags, ["owner-edited"]);
      assertEquals(saved.graphRun?.status, "complete");
      assertEquals(message.forwarded, []);
      assertEquals(
        saved.graphRun?.steps.filter((step) =>
          graph.nodes.find((node) => node.id === step.nodeId)?.kind ===
            "evaluate"
        ),
        ruleSnapshot,
      );
      const backend = {
        config,
        store,
        blobStore,
        developmentSession: {
          mode: "development" as const,
          email: "owner@example.com",
        },
      };
      for (
        const path of [
          "inbox",
          "inbox",
          `messages/${saved.id}/content`,
          "bootstrap",
        ]
      ) {
        const response = await handleRequest(
          new Request(`http://localhost/api/${path}`),
          backend,
        );
        assertEquals(response.status, 200);
        const text = await response.text();
        assert(!text.includes("test-secret-never-public"));
        assert(!text.includes(gateway.token));
        if (path === "bootstrap") {
          assertEquals(JSON.parse(text).config.analysis.configured, true);
        }
        if (path.endsWith("/content")) {
          assertEquals(JSON.parse(text).codes, ["001234"]);
        }
      }
      assertEquals(calls, 1);
    } finally {
      fixture.close();
    }
  });

  Deno.test(`${kind}: daily quota is atomic across concurrent reservations and resets on a new UTC day`, async () => {
    const fixture = kind === "D1"
      ? sqliteStore()
      : { store: createMemoryStore(), close() {} };
    try {
      assertEquals(
        await fixture.store.reserveAnalysisCall("2026-09-29", 0),
        false,
      );
      const results = await Promise.all(
        Array.from(
          { length: 20 },
          () => fixture.store.reserveAnalysisCall("2026-09-29", 3),
        ),
      );
      assertEquals(results.filter(Boolean).length, 3);
      assertEquals(
        await fixture.store.reserveAnalysisCall("2026-09-30", 3),
        true,
      );
    } finally {
      fixture.close();
    }
  });
}

Deno.test("disabled, unconfigured, locally identified, and rejected mail never invokes AI", async () => {
  let calls = 0;
  const fetcher = () => {
    calls++;
    throw new Error("Should not call");
  };
  for (
    const entry of [
      {
        config: readConfig({
          CFMAILBIN_ALLOW_CATCH_ALL: "true",
          DEEPSEEK_API_KEY: "test",
        }),
        message: mail(),
      },
      {
        config: readConfig({
          CFMAILBIN_ALLOW_CATCH_ALL: "true",
          CFMAILBIN_AI_ENABLED: "true",
          DEEPSEEK_API_KEY: "test-without-gateway-must-not-go-direct",
        }),
        message: mail(),
      },
      { config, message: mail("Your verification code is 001234.") },
      { config: { ...config, allowCatchAll: false }, message: mail() },
    ]
  ) {
    await processIncomingEmail({
      graph: receiptPolicy(),
      ...entry,
      store: createMemoryStore(),
      blobStore: createMemoryBlobStore(),
      analysisFetch: fetcher,
    });
  }
  assertEquals(calls, 0);
  assertEquals(
    readConfig({
      CFMAILBIN_AI_ENABLED: "true",
      CFMAILBIN_AI_PROVIDER: "unrecognized",
      DEEPSEEK_API_KEY: "test",
    }).ai?.enabled,
    false,
  );
});

Deno.test("AI failure and exhausted quota preserve receipt and local data", async () => {
  for (const dailyLimit of [0, 100]) {
    const store = createMemoryStore(), blobStore = createMemoryBlobStore();
    let calls = 0;
    const result = await processIncomingEmail({
      graph: receiptPolicy(),
      store,
      blobStore,
      config: { ...config, ai: { ...config.ai!, dailyLimit } },
      message: mail(),
      analysisFetch: () => {
        calls++;
        throw new Error("private service detail");
      },
    });
    assertEquals(result.rejected, false);
    const saved = (await store.getMessage(result.messageId!))!;
    assertEquals(saved.status, "inbox");
    assertEquals(saved.verificationCodes, []);
    assertEquals(
      saved.analysis?.status,
      dailyLimit === 0 ? "skipped" : "failed",
    );
    assertEquals(calls, dailyLimit === 0 ? 0 : 1);
    assert(await blobStore.get(saved.rawKey!));
    assert(!JSON.stringify(saved).includes("private service detail"));
  }
});

Deno.test("verification template rejects AI codes and contexts absent from the original mail", async () => {
  for (
    const candidate of [
      { value: "999999", context: "Enter 001234 to finish signing in." },
      { value: "001234", context: "Your verification code is 001234." },
    ]
  ) {
    const store = createMemoryStore();
    const blobStore = createMemoryBlobStore();
    const incoming = mail();
    const result = await processIncomingEmail({
      graph: receiptPolicy(),
      config,
      store,
      blobStore,
      message: incoming,
      analysisFetch: () =>
        Promise.resolve(Response.json({
          choices: [{
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                enrich: {
                  category: "verification",
                  hasCode: true,
                  codes: [candidate],
                },
              }),
            },
          }],
        })),
    });
    const saved = (await store.getMessage(result.messageId!))!;
    assertEquals(result.rejected, false);
    assertEquals(saved.verificationCodes, []);
    assertEquals(saved.analysis?.status, "failed");
    assertEquals(saved.analysis?.reason, "invalid_response");
    assertEquals(saved.status, "inbox");
    assertEquals(incoming.forwarded, []);
    assert(await blobStore.get(saved.rawKey!));
  }
});

Deno.test("deleting mail during analysis never recreates the message", async () => {
  const store = createMemoryStore(), blobStore = createMemoryBlobStore();
  const gate = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  const pending = processIncomingEmail({
    graph: receiptPolicy(),
    config,
    store,
    blobStore,
    message: mail(),
    analysisFetch: () => {
      started.resolve();
      return gate.promise;
    },
  });
  await started.promise;
  const [receiving] = await store.listMessages();
  await store.deleteMessages([receiving.id]);
  gate.resolve(successful());
  await pending;
  assertEquals(await store.getMessage(receiving.id), null);
  assertEquals(await store.listMessages(), []);
});

Deno.test("AI failures persist safe diagnostic details in D1 and logs", async () => {
  const fixture = sqliteStore();
  const logs: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => logs.push(args);
  try {
    const result = await processIncomingEmail({
      graph: receiptPolicy(),
      config,
      store: fixture.store,
      blobStore: createMemoryBlobStore(),
      message: mail(),
      analysisFetch: () =>
        Promise.resolve(new Response("private upstream body", { status: 401 })),
    });
    const saved = (await fixture.store.getMessage(result.messageId!))!;
    const { durationMs, ...analysis } = saved.analysis!;
    assert(typeof durationMs === "number" && durationMs >= 0);
    assertEquals<unknown>(analysis, {
      provider: "deepseek",
      model: "deepseek-flash",
      status: "failed",
      reason: "authentication",
      httpStatus: 401,
      phase: "response",
    });
    assertEquals(saved.status, "inbox");
    assertEquals(logs.length, 1);
    assert(!JSON.stringify(logs).includes("private upstream body"));
    assert(!JSON.stringify(logs).includes("test-secret-never-public"));
    assert(!JSON.stringify(logs).includes("001234"));
  } finally {
    console.warn = warn;
    fixture.close();
  }
});

Deno.test("incomplete or invalid Gateway settings disable AI without blocking receipt", async () => {
  let calls = 0;
  for (
    const overrides of [
      { CFMAILBIN_AI_GATEWAY_ACCOUNT_ID: "" },
      { CFMAILBIN_AI_GATEWAY_ACCOUNT_ID: "../other" },
      { CFMAILBIN_AI_GATEWAY_ID: "" },
      { CFMAILBIN_AI_GATEWAY_ID: "../other?x=y" },
      { CF_AIG_TOKEN: "" },
      { CF_AIG_TOKEN: "invalid\r\nheader" },
    ]
  ) {
    const config = readConfig({
      ...gatewayEnv,
      ...overrides,
      CFMAILBIN_AI_ENABLED: "true",
      CFMAILBIN_ALLOW_CATCH_ALL: "true",
      DEEPSEEK_API_KEY: "must-not-go-direct",
    });
    assertEquals(config.ai?.gateway, undefined);
    const store = createMemoryStore();
    const result = await processIncomingEmail({
      graph: receiptPolicy(),
      config,
      store,
      blobStore: createMemoryBlobStore(),
      message: mail(),
      analysisFetch: () => {
        calls++;
        throw new Error("Should not call");
      },
    });
    assertEquals(result.rejected, false);
    assertEquals(
      (await store.getMessage(result.messageId!))?.analysis,
      undefined,
    );
    const response = await handleRequest(
      new Request("http://localhost/api/bootstrap"),
      {
        config,
        store,
        blobStore: createMemoryBlobStore(),
        developmentSession: { mode: "development", email: "owner@example.com" },
      },
    );
    assertEquals((await response.json()).config.analysis.configured, false);
  }
  assertEquals(calls, 0);
});

Deno.test("Gateway stored BYOK enables analysis without a Worker provider secret", async () => {
  const store = createMemoryStore();
  let calls = 0;
  const result = await processIncomingEmail({
    graph: receiptPolicy(),
    config: readConfig({
      ...gatewayEnv,
      CFMAILBIN_AI_ENABLED: "true",
      CFMAILBIN_ALLOW_CATCH_ALL: "true",
    }),
    store,
    blobStore: createMemoryBlobStore(),
    message: mail(),
    analysisFetch: (url, init) => {
      calls++;
      assertEquals(url, `${gatewayBase}/deepseek/chat/completions`);
      assertEquals(new Headers(init.headers).has("authorization"), false);
      return Promise.resolve(successful());
    },
  });
  assertEquals(calls, 1);
  assertEquals((await store.getMessage(result.messageId!))?.verificationCodes, [
    "001234",
  ]);
});
