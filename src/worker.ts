import { handleRequest } from "./app.ts";
import type { CfMailBinBindings } from "./config.ts";
import { readConfig } from "./config.ts";
import { processIncomingEmail } from "./email/processor.ts";
import type {
  D1Database,
  ForwardableEmailMessage,
  R2Bucket,
  ScheduledController,
  WaitUntilContext,
} from "./platform/cloudflare.ts";
import { purgeExpiredMessages } from "./services/retention.ts";
import { createD1Store, createR2BlobStore } from "./storage/d1.ts";
import { configWithSettings, createKVSettingsStore } from "./settings.ts";
import { notifyInbox, type Realtime } from "./realtime.ts";

export interface WorkerEnv extends CfMailBinBindings {
  DB: D1Database;
  RAW_EMAILS: R2Bucket;
  SETTINGS?: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<void>;
  };
  INBOX_EVENTS?: { getByName(name: string): Realtime };
}

function createBackend(env: WorkerEnv) {
  const settings = env.SETTINGS
    ? createKVSettingsStore(env.SETTINGS)
    : undefined;
  return {
    settings,
    events: env.INBOX_EVENTS?.getByName(env.CFMAILBIN_OWNER_EMAIL ?? "owner"),
    loadConfig: async () =>
      configWithSettings(env, await settings?.get() ?? null),
    blobStore: createR2BlobStore(env.RAW_EMAILS),
    config: readConfig({
      CFMAILBIN_EMAIL_DOMAIN: env.CFMAILBIN_EMAIL_DOMAIN,
      CFMAILBIN_ACCESS_AUD: env.CFMAILBIN_ACCESS_AUD,
      CFMAILBIN_ACCESS_TEAM_DOMAIN: env.CFMAILBIN_ACCESS_TEAM_DOMAIN,
      CFMAILBIN_OWNER_EMAIL: env.CFMAILBIN_OWNER_EMAIL,
      CFMAILBIN_ALLOW_CATCH_ALL: env.CFMAILBIN_ALLOW_CATCH_ALL,
      CFMAILBIN_APP_NAME: env.CFMAILBIN_APP_NAME,
      CFMAILBIN_AUTO_CREATE_ALIAS_TAG: env.CFMAILBIN_AUTO_CREATE_ALIAS_TAG,
      CFMAILBIN_DEFAULT_RETENTION_DAYS: env.CFMAILBIN_DEFAULT_RETENTION_DAYS,
      CFMAILBIN_FORWARD_TO: env.CFMAILBIN_FORWARD_TO,
      CFMAILBIN_AI_ENABLED: env.CFMAILBIN_AI_ENABLED,
      CFMAILBIN_AI_PROVIDER: env.CFMAILBIN_AI_PROVIDER,
      CFMAILBIN_AI_DAILY_LIMIT: env.CFMAILBIN_AI_DAILY_LIMIT,
      CFMAILBIN_AI_GATEWAY_ACCOUNT_ID: env.CFMAILBIN_AI_GATEWAY_ACCOUNT_ID,
      CFMAILBIN_AI_GATEWAY_ID: env.CFMAILBIN_AI_GATEWAY_ID,
      CF_AIG_TOKEN: env.CF_AIG_TOKEN,
      DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY,
      OPENAI_API_KEY: env.OPENAI_API_KEY,
    }),
    store: createD1Store(env.DB),
  };
}

const worker = {
  async email(
    message: ForwardableEmailMessage,
    env: WorkerEnv,
    ctx: WaitUntilContext,
  ) {
    const backend = createBackend(env);
    await processIncomingEmail({
      blobStore: backend.blobStore,
      config: await backend.loadConfig(),
      message,
      store: backend.store,
      waitUntil: (task) =>
        ctx.waitUntil(task.finally(() => notifyInbox(backend.events))),
    });
    ctx.waitUntil(notifyInbox(backend.events));
  },

  fetch(request: Request, env: WorkerEnv, _ctx: WaitUntilContext) {
    return handleRequest(request, createBackend(env));
  },

  async scheduled(
    _controller: ScheduledController,
    env: WorkerEnv,
    _ctx: WaitUntilContext,
  ) {
    const backend = createBackend(env);
    await purgeExpiredMessages(backend.store, backend.blobStore);
    await notifyInbox(backend.events);
  },
};

export default worker;
