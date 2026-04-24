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

export interface WorkerEnv extends CfMailBinBindings {
  DB: D1Database;
  RAW_EMAILS: R2Bucket;
}

function createBackend(env: WorkerEnv) {
  return {
    blobStore: createR2BlobStore(env.RAW_EMAILS),
    config: readConfig({
      CFMAILBIN_ALLOW_CATCH_ALL: env.CFMAILBIN_ALLOW_CATCH_ALL,
      CFMAILBIN_APP_NAME: env.CFMAILBIN_APP_NAME,
      CFMAILBIN_DEFAULT_RETENTION_DAYS: env.CFMAILBIN_DEFAULT_RETENTION_DAYS,
      CFMAILBIN_FORWARD_TO: env.CFMAILBIN_FORWARD_TO,
    }),
    store: createD1Store(env.DB),
  };
}

const worker = {
  async email(
    message: ForwardableEmailMessage,
    env: WorkerEnv,
    _ctx: WaitUntilContext,
  ) {
    const backend = createBackend(env);
    await processIncomingEmail({
      blobStore: backend.blobStore,
      config: backend.config,
      message,
      store: backend.store,
    });
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
  },
};

export default worker;
