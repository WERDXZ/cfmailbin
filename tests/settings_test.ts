import { assertEquals } from "@std/assert";
import { handleRequest } from "../src/app.ts";
import {
  createMemoryBlobStore,
  createMemoryStore,
} from "../src/storage/memory.ts";
import {
  configWithSettings,
  createKVSettingsStore,
  settingsFromConfig,
} from "../src/settings.ts";

Deno.test("settings are owner-only and expose only editable non-secret defaults", async () => {
  const backend = {
    config: { appName: "test", allowCatchAll: false, defaultRetentionDays: 7 },
    store: createMemoryStore(),
    blobStore: createMemoryBlobStore(),
  };
  assertEquals(
    (await handleRequest(new Request("http://localhost/api/settings"), backend))
      .status,
    503,
  );
  const response = await handleRequest(
    new Request("http://localhost/api/settings"),
    {
      ...backend,
      developmentSession: { email: "owner@example.com", mode: "development" },
    },
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.settings.defaultRetentionDays, 7);
  assertEquals(body.storage, "unavailable");
  assertEquals(body.settings.ownerEmail, undefined);
});

Deno.test("KV settings survive new backends, validate writes, and never switch authentication or leak keys", async () => {
  const values = new Map<string, string>();
  const kv = {
    get: (key: string) => Promise.resolve(values.get(key) ?? null),
    put(key: string, value: string) {
      values.set(key, value);
      return Promise.resolve();
    },
  };
  const env = {
    CFMAILBIN_OWNER_EMAIL: "owner@example.com",
    CFMAILBIN_ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
    CFMAILBIN_ACCESS_AUD: "original-audience",
    CF_AIG_TOKEN: "gateway-secret",
    CFMAILBIN_AI_GATEWAY_ACCOUNT_ID: "a".repeat(32),
    CFMAILBIN_AI_GATEWAY_ID: "inbox",
    DEEPSEEK_API_KEY: "deepseek-secret",
    OPENAI_API_KEY: "openai-secret",
  };
  const makeBackend = () => {
    const settings = createKVSettingsStore(kv);
    return {
      config: configWithSettings(env, null),
      settings,
      loadConfig: async () => configWithSettings(env, await settings.get()),
      store: createMemoryStore(),
      blobStore: createMemoryBlobStore(),
      developmentSession: {
        email: "owner@example.com",
        mode: "development" as const,
      },
    };
  };
  const backend = makeBackend();
  const settings = {
    ...settingsFromConfig(backend.config),
    defaultRetentionDays: 30,
    allowCatchAll: true,
    aiEnabled: true,
    aiProvider: "openai",
    aiDailyLimit: 42,
  };
  const put = (body: unknown, origin = "http://localhost") =>
    handleRequest(
      new Request("http://localhost/api/settings", {
        method: "PUT",
        headers: { "x-cfmailbin-request": "1", origin },
        body: JSON.stringify(body),
      }),
      backend,
    );
  assertEquals((await put(settings, "https://foreign.example")).status, 403);
  for (
    const invalid of [
      { ...settings, defaultRetentionDays: 0 },
      { ...settings, aiDailyLimit: 1001 },
      { ...settings, aiProvider: ["openai"] },
      { ...settings, ownerEmail: "intruder@example.com" },
      { ...settings, defaultForwardTo: "x\r\ny@example.com" },
      { ...settings, emailDomain: "https://example.com" },
    ]
  ) assertEquals((await put(invalid)).status, 400);
  assertEquals(values.size, 0);
  assertEquals((await put(settings)).status, 200);
  const next = makeBackend();
  const config = await next.loadConfig();
  assertEquals(config.defaultRetentionDays, 30);
  assertEquals(config.ai?.apiKey, "openai-secret");
  assertEquals(config.ownerEmail, "owner@example.com");
  const response = await handleRequest(
    new Request("http://localhost/api/settings"),
    next,
  );
  const body = await response.text();
  assertEquals(JSON.parse(body).settings, settings);
  assertEquals(body.includes("secret"), false);
  assertEquals([...values.values()].join().includes("secret"), false);
  const bootstrap = await handleRequest(
    new Request("http://localhost/api/bootstrap"),
    next,
  );
  assertEquals((await bootstrap.json()).config.analysis.dailyLimit, 42);
});

Deno.test("settings write failures return actionable errors without storage details", async () => {
  for (
    const [failure, status] of [
      ["KV PUT failed: 429 Too Many Requests private-key", 429],
      ["connection failed private-key", 503],
    ] as const
  ) {
    const config = configWithSettings({}, null);
    const response = await handleRequest(
      new Request("http://localhost/api/settings", {
        method: "PUT",
        headers: {
          "x-cfmailbin-request": "1",
          origin: "http://localhost",
        },
        body: JSON.stringify(settingsFromConfig(config)),
      }),
      {
        config,
        store: createMemoryStore(),
        blobStore: createMemoryBlobStore(),
        developmentSession: { email: "owner@example.com", mode: "development" },
        settings: createKVSettingsStore({
          get: () => Promise.resolve(null),
          put: () => Promise.reject(new Error(failure)),
        }),
      },
    );
    assertEquals(response.status, status);
    const body = await response.text();
    assertEquals(body.includes("稍后重试"), true);
    assertEquals(body.includes("private-key"), false);
  }
});
