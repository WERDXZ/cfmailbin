import type { CfMailBinBindings, CfMailBinConfig } from "./config.ts";
import { readConfig } from "./config.ts";
import type { AnalysisProvider } from "./domain/analysis.ts";

/** Only these settings may be changed through the authenticated dashboard. */
export interface RuntimeSettings {
  emailDomain: string;
  allowCatchAll: boolean;
  defaultRetentionDays: number;
  defaultForwardTo: string;
  autoCreateAliasTag: string;
  aiEnabled: boolean;
  aiProvider: AnalysisProvider;
  aiDailyLimit: number;
}

export interface SettingsResponse {
  settings: RuntimeSettings;
  storage: "kv" | "memory" | "unavailable";
}

export interface SettingsStore {
  kind: "kv" | "memory";
  get(): Promise<RuntimeSettings | null>;
  put(settings: RuntimeSettings): Promise<void>;
}

export class SettingsError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function settingsFromConfig(config: CfMailBinConfig): RuntimeSettings {
  return {
    emailDomain: config.emailDomain ?? "",
    allowCatchAll: config.allowCatchAll,
    defaultRetentionDays: config.defaultRetentionDays,
    defaultForwardTo: config.defaultForwardTo ?? "",
    autoCreateAliasTag: config.autoCreateAliasTag ?? "",
    aiEnabled: config.ai?.enabled ?? false,
    aiProvider: config.ai?.provider ?? "deepseek",
    aiDailyLimit: config.ai?.dailyLimit ?? 100,
  };
}

export function parseSettings(input: unknown): RuntimeSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SettingsError(400, "设置必须是一个完整的对象");
  }
  const value = input as Record<string, unknown>;
  const allowed = [
    "emailDomain",
    "allowCatchAll",
    "defaultRetentionDays",
    "defaultForwardTo",
    "autoCreateAliasTag",
    "aiEnabled",
    "aiProvider",
    "aiDailyLimit",
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new SettingsError(
      400,
      "包含不支持的设置；账号和密钥请在部署配置中修改",
    );
  }
  function string(key: string, max: number) {
    if (
      typeof value[key] !== "string" || value[key].length > max ||
      Array.from(value[key]).some((character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      )
    ) {
      throw new SettingsError(400, `${key} 格式无效`);
    }
    return value[key].trim();
  }
  function integer(key: string, min: number, max: number) {
    const number = value[key];
    if (
      typeof number !== "number" || !Number.isInteger(number) || number < min ||
      number > max
    ) {
      throw new SettingsError(400, `${key} 必须是 ${min}–${max} 之间的整数`);
    }
    return number;
  }
  const emailDomain = string("emailDomain", 190).toLowerCase();
  if (
    emailDomain &&
    (!emailDomain.includes(".") ||
      emailDomain.split(".").some((label) =>
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
      ))
  ) {
    throw new SettingsError(400, "请填写有效的收件域名");
  }
  const defaultForwardTo = string("defaultForwardTo", 254).toLowerCase();
  if (
    defaultForwardTo &&
    !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(defaultForwardTo)
  ) {
    throw new SettingsError(400, "请填写有效的转发邮箱地址");
  }
  if (
    typeof value.allowCatchAll !== "boolean" ||
    typeof value.aiEnabled !== "boolean" ||
    (value.aiProvider !== "deepseek" && value.aiProvider !== "openai")
  ) {
    throw new SettingsError(400, "收件开关或 AI 配置无效");
  }
  return {
    emailDomain,
    defaultForwardTo,
    allowCatchAll: value.allowCatchAll,
    defaultRetentionDays: integer("defaultRetentionDays", 1, 3650),
    autoCreateAliasTag: string("autoCreateAliasTag", 120),
    aiEnabled: value.aiEnabled,
    aiProvider: value.aiProvider as AnalysisProvider,
    aiDailyLimit: integer("aiDailyLimit", 0, 1000),
  };
}

export function configWithSettings(
  env: CfMailBinBindings,
  settings: RuntimeSettings | null,
): CfMailBinConfig {
  if (!settings) return readConfig(env);
  return readConfig({
    ...env,
    CFMAILBIN_EMAIL_DOMAIN: settings.emailDomain,
    CFMAILBIN_ALLOW_CATCH_ALL: String(settings.allowCatchAll),
    CFMAILBIN_DEFAULT_RETENTION_DAYS: String(settings.defaultRetentionDays),
    CFMAILBIN_FORWARD_TO: settings.defaultForwardTo || undefined,
    CFMAILBIN_AUTO_CREATE_ALIAS_TAG: settings.autoCreateAliasTag,
    CFMAILBIN_AI_ENABLED: String(settings.aiEnabled),
    CFMAILBIN_AI_PROVIDER: settings.aiProvider,
    CFMAILBIN_AI_DAILY_LIMIT: String(settings.aiDailyLimit),
  });
}

export function createKVSettingsStore(kv: {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}): SettingsStore {
  return {
    kind: "kv",
    async get() {
      const value = await kv.get("settings:v1");
      if (value === null) return null;
      try {
        return parseSettings(JSON.parse(value));
      } catch {
        throw new SettingsError(503, "保存的设置无法读取，请检查设置存储");
      }
    },
    async put(settings) {
      try {
        await kv.put("settings:v1", JSON.stringify(settings));
      } catch (error) {
        if (
          error instanceof Error &&
          /429|rate limit|too many requests/i.test(error.message)
        ) {
          throw new SettingsError(429, "保存过于频繁，请稍后重试");
        }
        throw new SettingsError(503, "暂时无法保存设置，请稍后重试");
      }
    },
  };
}

export function createMemorySettingsStore(): SettingsStore {
  let saved: RuntimeSettings | null = null;
  return {
    kind: "memory",
    get: () => Promise.resolve(saved && structuredClone(saved)),
    put(value) {
      saved = structuredClone(value);
      return Promise.resolve();
    },
  };
}
