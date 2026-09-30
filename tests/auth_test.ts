import { assertEquals } from "@std/assert";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import worker from "../src/worker.ts";
import { InboxEvents } from "../src/realtime.ts";

const issuer = "https://cfmailbin-test.cloudflareaccess.com";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...await exportJWK(publicKey), kid: "test-key", alg: "RS256" };

function environment() {
  return {
    CFMAILBIN_OWNER_EMAIL: "owner@example.com",
    CFMAILBIN_ACCESS_TEAM_DOMAIN: "cfmailbin-test.cloudflareaccess.com",
    CFMAILBIN_ACCESS_AUD: "cfmailbin-test",
    DB: {
      prepare() {
        throw new Error("Session authentication must not query D1");
      },
    },
    RAW_EMAILS: {
      delete: () => Promise.resolve(),
      get: () => Promise.resolve(null),
      put: () => Promise.resolve(),
    },
  };
}

async function request(claims: Record<string, unknown> = {}, key = privateKey) {
  const token = await new SignJWT({
    iss: issuer,
    aud: ["cfmailbin-test"],
    sub: "owner-id",
    email: "owner@example.com",
    exp: Math.floor(Date.now() / 1000) + 300,
    ...claims,
  }).setProtectedHeader({ alg: "RS256", kid: "test-key" }).sign(key);
  return new Request("https://mail.example.com/api/session", {
    headers: { "cf-access-jwt-assertion": token },
  });
}

function accessTest(name: string, run: () => Promise<void>) {
  Deno.test(name, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input) => {
      assertEquals(String(input), `${issuer}/cdn-cgi/access/certs`);
      return Promise.resolve(Response.json({ keys: [jwk] }));
    };
    try {
      await run();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

const ctx = { waitUntil() {} };

accessTest(
  "settings and SSE enforce signed owner identity before touching bindings",
  async () => {
    const events = new InboxEvents();
    const env = { ...environment(), INBOX_EVENTS: { getByName: () => events } };
    for (const path of ["/api/events", "/api/settings"]) {
      for (const email of ["other@example.com", "owner@example.com"]) {
        const signed = await request({ email });
        const response = await worker.fetch(
          new Request(`https://mail.example.com${path}`, {
            headers: signed.headers,
          }),
          env,
          ctx,
        );
        assertEquals(
          response.status,
          email === "owner@example.com" ? 200 : 403,
        );
        await response.body?.cancel();
      }
      const unsigned = await worker.fetch(
        new Request(`https://mail.example.com${path}`),
        env,
        ctx,
      );
      assertEquals(unsigned.status, 401);
    }
  },
);

accessTest(
  "signed Access owner can open a session without a bearer token",
  async () => {
    const response = await worker.fetch(await request(), environment(), ctx);
    assertEquals(response.status, 200);
    assertEquals(await response.json(), {
      ok: true,
      email: "owner@example.com",
      mode: "access",
    });
    assertEquals(response.headers.get("cache-control"), "no-store");
  },
);

accessTest(
  "owner email comparison ignores case and outer whitespace",
  async () => {
    const env = {
      ...environment(),
      CFMAILBIN_OWNER_EMAIL: " Owner@Example.com ",
    };
    const response = await worker.fetch(
      await request({ email: "OWNER@example.com" }),
      env,
      ctx,
    );
    assertEquals(response.status, 200);
  },
);

accessTest("Access rejects another authenticated account", async () => {
  const response = await worker.fetch(
    await request({ email: "other@example.com" }),
    environment(),
    ctx,
  );
  assertEquals(response.status, 403);
});

accessTest(
  "Access fails closed for missing or invalid configuration",
  async () => {
    for (
      const override of [
        { CFMAILBIN_OWNER_EMAIL: "" },
        { CFMAILBIN_ACCESS_AUD: "" },
        { CFMAILBIN_ACCESS_TEAM_DOMAIN: "" },
        { CFMAILBIN_ACCESS_TEAM_DOMAIN: "attacker.example" },
      ]
    ) {
      const response = await worker.fetch(await request(), {
        ...environment(),
        ...override,
      }, ctx);
      assertEquals(response.status, 503);
    }
  },
);

accessTest("Access rejects forged headers and legacy tokens", async () => {
  const cases: HeadersInit[] = [
    {},
    { "cf-access-authenticated-user-email": "owner@example.com" },
    { "cf-access-jwt-assertion": "forged.jwt.value" },
    { authorization: "Bearer secret-token" },
  ];
  for (const headers of cases) {
    const response = await worker.fetch(
      new Request("https://mail.example.com/api/session", { headers }),
      environment(),
      ctx,
    );
    assertEquals(response.status, 401);
    assertEquals(response.headers.get("cache-control"), "no-store");
  }
});

accessTest(
  "Access rejects expired, premature, wrong-issuer and wrong-audience tokens",
  async () => {
    for (
      const claims of [
        { exp: 1 },
        { nbf: Math.floor(Date.now() / 1000) + 600 },
        { iss: "https://other.cloudflareaccess.com" },
        { aud: ["another-application"] },
        { email: undefined },
        { exp: undefined },
      ]
    ) {
      const response = await worker.fetch(
        await request(claims),
        environment(),
        ctx,
      );
      assertEquals(response.status, 401);
    }
  },
);

accessTest("Access rejects a token signed with an untrusted key", async () => {
  const attacker = await generateKeyPair("RS256");
  const response = await worker.fetch(
    await request({}, attacker.privateKey),
    environment(),
    ctx,
  );
  assertEquals(response.status, 401);
});

accessTest(
  "Access key retrieval failure denies access without exposing details",
  async () => {
    globalThis.fetch = () =>
      Promise.reject(new Error("sensitive upstream details"));
    const env = {
      ...environment(),
      CFMAILBIN_ACCESS_TEAM_DOMAIN: "outage.cloudflareaccess.com",
    };
    const response = await worker.fetch(await request(), env, ctx);
    assertEquals(response.status, 503);
    assertEquals(await response.json(), {
      error: "Authentication unavailable",
    });
  },
);
