export interface CfMailBinConfig {
  autoCreateAliasTag?: string;
  appName: string;
  defaultForwardTo?: string;
  defaultRetentionDays: number;
  allowCatchAll: boolean;
}

export interface CfMailBinBindings {
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

export function readConfig(
  env: CfMailBinBindings = Deno.env.toObject(),
): CfMailBinConfig {
  return {
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
