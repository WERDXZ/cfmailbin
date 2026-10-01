import { localCodeFragment } from "../src/graph/local-code-template.ts";
import { assertEquals } from "@std/assert";
import { graphEmail } from "../src/graph/process.ts";
import { runGraph } from "../src/graph/run.ts";
import { legacyReceiptPolicy } from "./workflow_fixture.ts";
import type { MailGraph } from "../src/graph/types.ts";
import { previewRule } from "../src/services/rule-preview.ts";
import {
  createMemoryBlobStore,
  createMemoryStore,
} from "../src/storage/memory.ts";

function forwardWithoutWarning(): MailGraph {
  return {
    version: 1,
    enabled: true,
    codeExtraction: "nodes",
    nodes: [
      { id: "start", label: "Start", kind: "entry", x: 0, y: 0 },
      {
        id: "check",
        label: "No warning",
        kind: "condition",
        path: "email.text",
        operator: "contains",
        value: "warning",
        condition: {
          not: { path: "email.text", operator: "contains", value: "warning" },
        },
        x: 0,
        y: 100,
      },
      {
        id: "forward",
        label: "Forward",
        kind: "delivery",
        action: "forward",
        forwardTo: "owner@example.com",
        tags: [],
        x: 0,
        y: 200,
      },
      { id: "keep", label: "Keep", kind: "finish", x: 100, y: 200 },
    ],
    edges: [
      { from: "start", to: "check", port: "next" },
      { from: "check", to: "forward", port: "yes" },
      { from: "check", to: "keep", port: "no" },
    ],
  };
}

for (const source of ["truncated", "unavailable"] as const) {
  Deno.test(`negative text condition does not forward when content is ${source}`, async () => {
    const forwarded: string[] = [];
    await runGraph(forwardWithoutWarning(), {
      text: source === "truncated" ? "Message prefix" : "",
      textTruncated: source === "truncated",
      unavailable: source === "unavailable",
    }, {
      ai: () => Promise.resolve({}),
      forward: (destination) => {
        forwarded.push(destination);
        return Promise.resolve();
      },
    });

    assertEquals(forwarded, []);
  });
}

Deno.test("negative text condition can forward a complete message without a warning", async () => {
  const forwarded: string[] = [];
  await runGraph(forwardWithoutWarning(), { text: "An ordinary message" }, {
    ai: () => Promise.resolve({}),
    forward: (destination) => {
      forwarded.push(destination);
      return Promise.resolve();
    },
  });

  assertEquals(forwarded, ["owner@example.com"]);
});

for (const text of ["验证码 是: 123456", "验证码 为: 123456"]) {
  Deno.test(`default code template recognizes ${text}`, async () => {
    const run = await runGraph(
      legacyReceiptPolicy(),
      graphEmail(
        { subject: "", text, codes: [], links: [], truncated: false },
        "sender@example.com",
        "test@example.com",
      ),
      {
        aiEnabled: false,
        ai: () => {
          throw new Error("Local extraction must not call AI");
        },
        rules: () =>
          Promise.resolve({
            action: "keep",
            retentionDays: 7,
            matchedRuleId: null,
            tags: [],
            trace: [],
          }),
      },
    );

    assertEquals(run.status, "complete");
    assertEquals(run.codes, ["123456"]);
  });
}

for (
  const { name, codes, body, matched } of [
    {
      name: "authoritative empty code result",
      codes: [],
      body: "Your verification code is 001234.",
      matched: false,
    },
    {
      name: "authoritative custom code result",
      codes: ["custom"],
      body: "Your service token: custom.",
      matched: true,
    },
  ]
) {
  Deno.test(`rule preview respects ${name} instead of recomputing extraction`, async () => {
    const store = createMemoryStore();
    const blobs = createMemoryBlobStore();
    const alias = await store.createAlias({
      address: "test@example.com",
      defaultAction: "keep",
      retentionDays: 7,
    });
    const raw = new TextEncoder().encode(
      `Subject: Test\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`,
    );
    await blobs.put("raw", raw, "message/rfc822");
    await store.createMessage({
      aliasAddress: alias.address,
      aliasId: alias.id,
      expiresAt: "2030-01-01T00:00:00Z",
      from: "sender@example.org",
      subject: "Test",
      receivedAt: "2026-09-30T12:00:00Z",
      rawKey: "raw",
      status: "inbox",
      verificationCodes: codes,
    });

    const preview = await previewRule(store, blobs, {
      name: "Only code emails",
      condition: { field: "hasCode", value: true },
      actions: { tags: ["code"] },
    });

    assertEquals(preview.examined, 1);
    assertEquals(preview.rows[0].draftResult, matched);
    assertEquals(preview.matched, matched ? 1 : 0);
  });
}

Deno.test("parent alias preserves candidate truncation in filter output", async () => {
  const fragment = localCodeFragment();
  const filter = fragment.nodes.find((n) => n.kind === "filter")!;
  if (filter.kind === "filter") filter.input = "current.parent.items";
  const graph: MailGraph = {
    version: 1,
    enabled: true,
    codeExtraction: "nodes",
    nodes: [
      { id: "start", kind: "entry", label: "start", x: 0, y: 0 },
      ...fragment.nodes,
      { id: "done", kind: "finish", label: "done", x: 0, y: 500 },
    ],
    edges: [
      { from: "start", to: fragment.entry, port: "next" },
      ...fragment.edges,
      { from: fragment.exit, to: "done", port: "next" },
    ],
  };
  const run = await runGraph(graph, {
    subject: "",
    body: "Verification code is 123456",
    bodyTruncated: true,
  }, { ai: () => Promise.resolve({}) });
  assertEquals(run.status, "complete");
  const output = run.steps.find((s) => s.nodeId === filter.id)?.output as {
    truncated: boolean;
  };
  assertEquals(output.truncated, true);
});
