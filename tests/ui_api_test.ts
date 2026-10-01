import { assertEquals, assertRejects } from "@std/assert";
import { api, ApiError } from "../src/ui/api.ts";

Deno.test("dashboard API uses cookie credentials and the CSRF request header", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_input, init) => {
    assertEquals(init?.credentials, "same-origin");
    assertEquals(init?.redirect, "manual");
    const headers = new Headers(init?.headers);
    assertEquals(headers.get("x-cfmailbin-request"), "1");
    assertEquals(headers.get("authorization"), null);
    assertEquals(headers.get("content-type"), "application/json");
    return Promise.resolve(Response.json({ id: "created-alias" }));
  };
  try {
    const alias = await api.createAlias({
      address: "shop@example.com",
      defaultAction: "keep",
      retentionDays: 7,
    });
    assertEquals(alias.id, "created-alias");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Access redirects and login HTML prompt reauthentication for JSON and downloads", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (
      const response of [
        new Response(null, {
          status: 302,
          headers: { location: "https://team.cloudflareaccess.com" },
        }),
        new Response("<html>Sign in</html>", {
          headers: { "content-type": "text/html" },
        }),
      ]
    ) {
      globalThis.fetch = () => Promise.resolve(response.clone());
      for (
        const run of [
          () => api.validateSession(),
          () => api.downloadRawMessage("message-id"),
        ]
      ) {
        const error = await assertRejects(run, ApiError);
        assertEquals(error.status, 401);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("API errors preserve machine codes and parameters for localization", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      Response.json({
        error: "Original message",
        code: "inbox.copyAddress",
        params: { address: "私人@example.com" },
      }, { status: 400 }),
    );
  try {
    const error = await assertRejects(() => api.getSettings(), ApiError);
    assertEquals(error.message, "Original message");
    assertEquals(error.code, "inbox.copyAddress");
    assertEquals(error.params, { address: "私人@example.com" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
