import {
  type AnalysisProvider,
  maxAiTimeoutSeconds,
} from "./domain/analysis.ts";
import type { AccountLocale } from "./domain/locale.ts";

export interface AnalysisGateway {
  accountId: string;
  id: string;
  token: string;
}

export interface CfMailBinConfig {
  locale?: AccountLocale;
  ai?: {
    enabled: boolean;
    provider: AnalysisProvider;
    apiKey?: string;
    gateway?: AnalysisGateway;
    dailyLimit: number;
    timeoutSeconds: number;
  };
  emailDomain?: string;
  accessAudience?: string;
  accessTeamDomain?: string;
  ownerEmail?: string;
  autoCreateAliasTag?: string;
  appName: string;
  defaultForwardTo?: string;
  defaultRetentionDays: number;
  allowCatchAll: boolean;
}

export interface CfMailBinBindings {
  CFMAILBIN_AI_ENABLED?: string;
  CFMAILBIN_AI_PROVIDER?: string;
  CFMAILBIN_AI_DAILY_LIMIT?: string;
  CFMAILBIN_AI_TIMEOUT_SECONDS?: string;
  CFMAILBIN_AI_GATEWAY_ACCOUNT_ID?: string;
  CFMAILBIN_AI_GATEWAY_ID?: string;
  CF_AIG_TOKEN?: string;
  DEEPSEEK_API_KEY?: string;
  OPENAI_API_KEY?: string;
  CFMAILBIN_EMAIL_DOMAIN?: string;
  CFMAILBIN_ACCESS_AUD?: string;
  CFMAILBIN_ACCESS_TEAM_DOMAIN?: string;
  CFMAILBIN_OWNER_EMAIL?: string;
  CFMAILBIN_ALLOW_CATCH_ALL?: string;
  CFMAILBIN_APP_NAME?: string;
  CFMAILBIN_AUTO_CREATE_ALIAS_TAG?: string;
  CFMAILBIN_DEFAULT_RETENTION_DAYS?: string;
  CFMAILBIN_FORWARD_TO?: string;
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function readGateway(env: CfMailBinBindings): AnalysisGateway | undefined {
  const accountId = env.CFMAILBIN_AI_GATEWAY_ACCOUNT_ID?.trim() ?? "";
  const id = env.CFMAILBIN_AI_GATEWAY_ID?.trim() ?? "";
  const token = env.CF_AIG_TOKEN?.trim() ?? "";
  if (
    !/^[a-fA-F0-9]{32}$/.test(accountId) ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) ||
    !/^[\x21-\x7e]+$/.test(token)
  ) return;
  return { accountId, id, token };
}

export function readConfig(
  env: CfMailBinBindings = {},
): CfMailBinConfig {
  const provider = env.CFMAILBIN_AI_PROVIDER?.trim() || "deepseek";
  const validProvider = provider === "deepseek" || provider === "openai";
  const dailyLimit = Number(env.CFMAILBIN_AI_DAILY_LIMIT ?? 100);
  const timeout = Number(env.CFMAILBIN_AI_TIMEOUT_SECONDS ?? 25);
  return {
    ai: {
      enabled: validProvider && parseBoolean(env.CFMAILBIN_AI_ENABLED, false),
      provider: provider === "openai" ? "openai" : "deepseek",
      gateway: validProvider ? readGateway(env) : undefined,
      apiKey: validProvider
        ? (provider === "openai" ? env.OPENAI_API_KEY : env.DEEPSEEK_API_KEY)
          ?.trim() || undefined
        : undefined,
      dailyLimit:
        Number.isInteger(dailyLimit) && dailyLimit >= 0 && dailyLimit <= 1000
          ? dailyLimit
          : 100,
      timeoutSeconds: Number.isInteger(timeout) && timeout >= 1 &&
          timeout <= maxAiTimeoutSeconds
        ? timeout
        : 25,
    },
    emailDomain: env.CFMAILBIN_EMAIL_DOMAIN?.trim().toLowerCase() || undefined,
    accessAudience: env.CFMAILBIN_ACCESS_AUD?.trim() || undefined,
    accessTeamDomain: env.CFMAILBIN_ACCESS_TEAM_DOMAIN?.trim().toLowerCase() ||
      undefined,
    ownerEmail: env.CFMAILBIN_OWNER_EMAIL?.trim().toLowerCase() || undefined,
    allowCatchAll: parseBoolean(env.CFMAILBIN_ALLOW_CATCH_ALL, false),
    appName: env.CFMAILBIN_APP_NAME ?? "cfmailbin",
    autoCreateAliasTag: env.CFMAILBIN_AUTO_CREATE_ALIAS_TAG?.trim() ||
      undefined,
    defaultForwardTo: env.CFMAILBIN_FORWARD_TO,
    defaultRetentionDays: parseNumber(
      env.CFMAILBIN_DEFAULT_RETENTION_DAYS,
      7,
    ),
  };
}
