export type RuleAction = "keep" | "forward" | "trash" | "block";
export type { MessageContent } from "../domain/models.ts";
import type { DeliveryStatus, Rule, RuleTrace } from "../domain/models.ts";
import type { MessageAnalysis } from "../domain/analysis.ts";
export type {
  ConditionTrace,
  CreateRuleInput,
  DeliveryStatus,
  Rule,
  RuleActions,
  RuleCondition,
  RulePreview,
  RuleTrace,
  UpdateRuleInput,
} from "../domain/models.ts";
export type RuleField = "alias" | "from" | "subject";
export type MessageStatus = "inbox" | "forwarded" | "trashed" | "blocked";

export interface SessionResponse {
  ok: true;
  email: string;
  mode: "access" | "development";
}

export interface Alias {
  lastReceivedAt?: string;
  address: string;
  createdAt: string;
  defaultAction: RuleAction;
  description?: string;
  enabled: boolean;
  forwardTo?: string;
  id: string;
  retentionDays: number;
  tags: string[];
  updatedAt: string;
}

export interface MessageRecord {
  graphRun?: import("../graph/types.ts").GraphRun;
  analysis?: MessageAnalysis;
  ruleTrace?: RuleTrace[];
  verificationCodes?: string[];
  aliasAddress: string;
  aliasId: string;
  createdAt: string;
  expiresAt: string;
  forwardedTo?: string;
  from: string;
  id: string;
  matchedRuleId?: string;
  preview?: string;
  rawKey?: string;
  receivedAt: string;
  status: MessageStatus;
  subject: string;
  tags: string[];
}

export interface Tag {
  createdAt: string;
  id: string;
  name: string;
}

export type {
  AuditEvent,
  AuditEventType,
  AuditPage,
} from "../domain/models.ts";

export interface BootstrapResponse {
  aliases: Alias[];
  config: {
    locale: import("../domain/locale.ts").AccountLocale;
    emailDomain?: string;
    allowCatchAll: boolean;
    autoCreateAliasTag?: string;
    defaultRetentionDays: number;
    forwardingConfigured: boolean;
    analysis?: {
      enabled: boolean;
      configured: boolean;
      model: string;
      dailyLimit: number;
    };
  };
  rules: Rule[];
  tags: Tag[];
}

export interface MessageFilters {
  aliasId?: string;
  q?: string;
  status?: MessageStatus;
}

export interface InboxResponse {
  messages: MessageRecord[];
  aliases: Alias[];
  delivery: DeliveryStatus;
}

export interface BatchDeleteResponse {
  deleted: number;
  missing: string[];
  rawDeleted: number;
}

export interface CreateAliasInput {
  address: string;
  defaultAction: RuleAction;
  description?: string;
  enabled?: boolean;
  forwardTo?: string;
  retentionDays: number;
  tags?: string[];
}
