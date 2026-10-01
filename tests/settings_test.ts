import { assertEquals } from "@std/assert";
import { handleRequest } from "../src/app.ts";
import { readConfig } from "../src/config.ts";
import {
  createMemoryBlobStore,
  createMemoryStore,
} from "../src/storage/memory.ts";
import {
  configWithSettings,
  createKVSettingsStore,
  parseSettings,
  settingsFromConfig,
} from "../src/settings.ts";

Deno.test("missing account language follows the browser while explicit choices are retained", () => {
  const settings = settingsFromConfig(configWithSettings({}, null));
  assertEquals(settings.locale, "auto");
  const old: Partial<typeof settings> = { ...settings };
  delete old.aiTimeoutSeconds;
  delete old.locale;
  assertEquals(parseSettings(old).aiTimeoutSeconds, 25);
  assertEquals(parseSettings(old).locale, "auto");
  for (const locale of ["zh-CN", "en", "auto"]) {
    assertEquals(parseSettings({ ...old, locale }).locale, locale);
  }
});

Deno.test("AI timeouts accept longer waits without overflowing the request timer", () => {
  const defaults = settingsFromConfig(readConfig());
  for (const seconds of [1, 26, 60, 120, 3600, 2_147_483]) {
    assertEquals(
      parseSettings({ ...defaults, aiTimeoutSeconds: seconds })
        .aiTimeoutSeconds,
      seconds,
    );
    assertEquals(
      readConfig({ CFMAILBIN_AI_TIMEOUT_SECONDS: String(seconds) }).ai
        ?.timeoutSeconds,
      seconds,
    );
  }
  for (const seconds of [0, -1, 1.5, 2_147_484, Infinity, NaN]) {
    assertEquals(
      readConfig({ CFMAILBIN_AI_TIMEOUT_SECONDS: String(seconds) }).ai
        ?.timeoutSeconds,
      25,
    );
  }
});

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
  assertEquals(body.settings.locale, "auto");
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
    aiTimeoutSeconds: 120,
    locale: "en",
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
      { ...settings, aiTimeoutSeconds: 0 },
      { ...settings, aiTimeoutSeconds: 2_147_484 },
      { ...settings, aiTimeoutSeconds: 1.5 },
      { ...settings, aiProvider: ["openai"] },
      { ...settings, locale: "fr" },
      { ...settings, locale: null },
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
  assertEquals(config.ai?.timeoutSeconds, 120);
  assertEquals(config.locale, "en");
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
  const boot = await bootstrap.json();
  assertEquals(boot.config.analysis.dailyLimit, 42);
  assertEquals(boot.config.locale, "en");
  assertEquals((await put({ ...settings, locale: "auto" })).status, 200);
  assertEquals((await next.loadConfig()).locale, "auto");
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
