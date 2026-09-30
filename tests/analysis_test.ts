import { assert, assertEquals, assertRejects } from "@std/assert";
import { analyzeEmail } from "../src/email/analysis.ts";
import { gateway, gatewayBase } from "./analysis_fixture.ts";

function modelResponse(value: unknown): Promise<Response> {
  return Promise.resolve(Response.json(value));
}

const content = {
  subject: "Welcome back",
  text: "Enter 001 234 to finish signing in. Order reference: 7654321.",
  codes: [],
  links: [],
  truncated: false,
};
const answer = {
  category: "verification",
  hasCode: true,
  codes: [{ value: "001 234", context: "Enter 001 234 to finish signing in." }],
};

Deno.test("analysis extracts source-backed codes, preserves zeros, and uses non-thinking DeepSeek", async () => {
  let calls = 0;
  const result = await analyzeEmail(
    { gateway, provider: "deepseek", apiKey: "test-key" },
    content,
    (url, init) => {
      calls++;
      assertEquals(url, `${gatewayBase}/deepseek/chat/completions`);
      const headers = new Headers(init.headers);
      assertEquals(
        headers.get("cf-aig-authorization"),
        `Bearer ${gateway.token}`,
      );
      assertEquals(headers.get("cf-aig-skip-cache"), "true");
      assertEquals(headers.get("cf-aig-collect-log"), "false");
      assertEquals(headers.get("cf-aig-no-wholesale"), "true");
      assertEquals(headers.get("cf-aig-max-attempts"), "1");
      assertEquals(headers.get("cf-aig-request-timeout"), "8000");
      assertEquals(
        headers.get("authorization"),
        url.includes("/openai/") ? "Bearer test" : "Bearer test-key",
      );
      const body = JSON.parse(init!.body as string);
      assertEquals(body.model, "deepseek-flash");
      assertEquals(body.thinking, { type: "disabled" });
      assertEquals(body.tools, undefined);
      assertEquals(body.response_format, { type: "json_object" });
      assertEquals(init!.redirect, "error");
      return modelResponse({
        choices: [{
          finish_reason: "stop",
          message: { content: JSON.stringify(answer) },
        }],
      });
    },
  );
  assertEquals(calls, 1);
  assertEquals(result.codes, ["001234"]);
  assertEquals(result.analysis.codeStatus, "found");
});

Deno.test("Luna uses Responses with schema, no reasoning, and no response storage", async () => {
  const result = await analyzeEmail(
    { gateway, provider: "openai", apiKey: "test" },
    content,
    (url, init) => {
      assertEquals(url, `${gatewayBase}/openai/responses`);
      const headers = new Headers(init.headers);
      assertEquals(
        headers.get("cf-aig-authorization"),
        `Bearer ${gateway.token}`,
      );
      assertEquals(headers.get("cf-aig-skip-cache"), "true");
      assertEquals(headers.get("cf-aig-collect-log"), "false");
      assertEquals(headers.get("cf-aig-no-wholesale"), "true");
      assertEquals(headers.get("cf-aig-max-attempts"), "1");
      assertEquals(headers.get("cf-aig-request-timeout"), "8000");
      assertEquals(
        headers.get("authorization"),
        url.includes("/openai/") ? "Bearer test" : "Bearer test-key",
      );
      const body = JSON.parse(init!.body as string);
      assertEquals(body.model, "gpt-5.6-luna");
      assertEquals(body.reasoning, { effort: "none" });
      assertEquals(body.store, false);
      assertEquals(body.text.format.type, "json_schema");
      return modelResponse({
        status: "completed",
        output: [{
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(answer) }],
        }],
      });
    },
  );
  assertEquals(result.codes, ["001234"]);
});

Deno.test("analysis rejects fabricated codes, changed zeros, partial tokens, invalid types and incomplete output", async () => {
  for (
    const invalid of [
      {
        ...answer,
        codes: [{ value: "1234", context: answer.codes[0].context }],
      },
      {
        ...answer,
        codes: [{ value: "999999", context: "Enter 999999 to sign in" }],
      },
      { ...answer, codes: [{ value: "765432", context: content.text }] },
      { ...answer, codes: [{ value: "654321", context: "654321" }] },
      { ...answer, hasCode: false },
      { ...answer, category: "<script>" },
      { ...answer, hasCode: "true" },
      { ...answer, codes: [{ value: 1234, context: content.text }] },
    ]
  ) {
    await assertRejects(() =>
      analyzeEmail(
        { gateway, provider: "deepseek", apiKey: "test" },
        content,
        () =>
          modelResponse({
            choices: [{
              finish_reason: "stop",
              message: { content: JSON.stringify(invalid) },
            }],
          }),
      )
    );
  }
  await assertRejects(() =>
    analyzeEmail(
      { gateway, provider: "deepseek", apiKey: "test" },
      content,
      () =>
        modelResponse({
          choices: [{
            finish_reason: "length",
            message: { content: JSON.stringify(answer) },
          }],
        }),
    )
  );
});

Deno.test("analysis cancels oversized responses and aborts slow requests", async () => {
  let cancelled = false;
  await assertRejects(() =>
    analyzeEmail(
      { gateway, provider: "deepseek", apiKey: "test" },
      content,
      () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new Uint8Array(65 * 1024));
              },
              cancel() {
                cancelled = true;
              },
            }),
          ),
        ),
    )
  );
  assertEquals(cancelled, true);
  let aborted = false;
  await assertRejects(() =>
    analyzeEmail(
      { gateway, provider: "deepseek", apiKey: "test" },
      content,
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        }),
      1,
    )
  );
  assertEquals(aborted, true);
});

Deno.test("negative results on partial text remain unknown; payload size is bounded", async () => {
  const result = await analyzeEmail({
    gateway,
    provider: "deepseek",
    apiKey: "test",
  }, {
    ...content,
    subject: "x".repeat(2000),
    text: "a".repeat(20000),
  }, (_url, init) => {
    const input = JSON.parse(
      JSON.parse(init!.body as string).messages[1].content,
    );
    assert(input.subject.length <= 500);
    assert(input.text.length <= 12000);
    assertEquals(input.truncated, true);
    return modelResponse({
      choices: [{
        finish_reason: "stop",
        message: {
          content: JSON.stringify({
            category: "other",
            hasCode: false,
            codes: [],
          }),
        },
      }],
    });
  });
  assertEquals(result.analysis.codeStatus, "unknown");
});

Deno.test("Gateway errors never retry, fall back to direct calls, or expose response bodies", async () => {
  for (
    const [status, reason] of [
      [401, "authentication"],
      [403, "authentication"],
      [402, "billing"],
      [429, "rate_limit"],
      [400, "invalid_request"],
      [404, "invalid_request"],
      [503, "service_error"],
      [504, "timeout"],
    ] as const
  ) {
    let calls = 0;
    const error = await assertRejects(() =>
      analyzeEmail(
        { gateway, provider: "deepseek", apiKey: "test" },
        content,
        (url) => {
          calls++;
          assertEquals(url, `${gatewayBase}/deepseek/chat/completions`);
          return Promise.resolve(
            new Response("sensitive-upstream-error", { status }),
          );
        },
      )
    );
    assertEquals(calls, 1);
    assert(!String(error).includes("sensitive-upstream-error"));
    const failure = error as Error & { reason?: string; httpStatus?: number };
    assertEquals(failure.reason, reason);
    assertEquals(failure.httpStatus, status);
  }
});

Deno.test("analysis distinguishes timeout, network failures and invalid JSON without leaking errors", async () => {
  const cases = [
    {
      reason: "timeout",
      fetcher: (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener(
            "abort",
            () => reject(new Error("private timeout")),
            { once: true },
          );
        }),
    },
    {
      reason: "network_error",
      fetcher: () => Promise.reject(new Error("private network detail")),
    },
    {
      reason: "invalid_response",
      fetcher: () => Promise.resolve(new Response("private malformed JSON")),
    },
    {
      reason: "invalid_response",
      fetcher: () => modelResponse({ choices: [] }),
    },
  ];
  for (const { reason, fetcher } of cases) {
    const error = await assertRejects(() =>
      analyzeEmail({ gateway, provider: "deepseek" }, content, fetcher, 5)
    );
    assertEquals((error as Error & { reason?: string }).reason, reason);
    assert(!String(error).includes("private"));
    assert(!JSON.stringify(error).includes("private"));
  }
});

Deno.test("Gateway BYOK omits provider authorization when its key is stored in Cloudflare", async () => {
  const result = await analyzeEmail(
    { gateway, provider: "deepseek" },
    content,
    (url, init) => {
      assertEquals(url, `${gatewayBase}/deepseek/chat/completions`);
      const headers = new Headers(init.headers);
      assertEquals(headers.has("authorization"), false);
      assertEquals(
        headers.get("cf-aig-authorization"),
        `Bearer ${gateway.token}`,
      );
      assertEquals(headers.get("cf-aig-no-wholesale"), "true");
      return modelResponse({
        choices: [{
          finish_reason: "stop",
          message: { content: JSON.stringify(answer) },
        }],
      });
    },
  );
  assertEquals(result.codes, ["001234"]);
});
