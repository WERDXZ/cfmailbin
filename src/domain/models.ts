export type RuleAction = "keep" | "forward" | "trash" | "block";
export type RuleField = "alias" | "from" | "subject";
export type MessageStatus = "inbox" | "forwarded" | "trashed" | "blocked";
export type AuditEventType =
  | "received"
  | "auto_alias_created"
  | "rejected_unknown"
  | "rejected_disabled"
  | "blocked_by_rule"
  | "forwarded"
  | "replied"
  | "expired_deleted"
  | "manual_deleted"
  | "workflow_completed"
  | "workflow_failed"
  | "workflow_degraded"
  | "workflow_trial"
  | "configuration_changed"
  | "message_updated";

export interface Alias {
  id: string;
  address: string;
  description?: string;
  createdAt: string;
  lastReceivedAt?: string;
  defaultAction: RuleAction;
  enabled: boolean;
  forwardTo?: string;
  retentionDays: number;
  tags: string[];
  updatedAt: string;
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

export interface UpdateAliasInput {
  address?: string;
  defaultAction?: RuleAction;
  description?: string;
  enabled?: boolean;
  forwardTo?: string;
  retentionDays?: number;
}

export interface IncomingMessage {
  body?: string;
  hasCode?: boolean;
  contentComplete?: boolean;
  alias: string;
  from: string;
  receivedAt: string;
  rawSize?: number;
  subject: string;
}

export interface MessageRecord {
  graphRun?: import("../graph/types.ts").GraphRun;
  analysis?: MessageAnalysis;
  ruleTrace?: RuleTrace[];
  id: string;
  aliasId: string;
  aliasAddress: string;
  createdAt: string;
  expiresAt: string;
  from: string;
  forwardedTo?: string;
  matchedRuleId?: string;
  subject: string;
  preview?: string;
  verificationCodes?: string[];
  receivedAt: string;
  rawKey?: string;
  status: MessageStatus;
  tags: string[];
}

export interface MessageContent {
  /** Sanitized document; must only be rendered in a sandboxed, opaque-origin iframe. */
  html?: string;
  subject: string;
  text: string;
  codes: string[];
  links: { url: string; label: string }[];
  truncated: boolean;
  warning?: "too_large" | "parse_failed";
}

export interface CreateMessageInput {
  graphRun?: import("../graph/types.ts").GraphRun;
  analysis?: MessageAnalysis;
  ruleTrace?: RuleTrace[];
  aliasAddress: string;
  aliasId: string;
  expiresAt: string;
  from: string;
  forwardedTo?: string;
  matchedRuleId?: string;
  preview?: string;
  verificationCodes?: string[];
  rawKey?: string;
  receivedAt: string;
  status: MessageStatus;
  subject: string;
  tags?: string[];
}

export interface UpdateMessageInput {
  graphRun?: import("../graph/types.ts").GraphRun;
  forwardedTo?: string;
  expiresAt?: string;
  analysis?: MessageAnalysis;
  status?: MessageStatus;
  verificationCodes?: string[];
}

export interface DeliveryStatus {
  lastReceived?: AuditEvent;
  lastRejected?: AuditEvent;
}

export interface MessageListFilters {
  aliasId?: string;
  limit?: number;
  q?: string;
  status?: MessageStatus;
}

export type ConditionField = RuleField | "fromDomain" | "body";
export type TextOperator =
  | "equals"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "glob";
export type RuleCondition =
  | { all: RuleCondition[] }
  | { any: RuleCondition[] }
  | { not: RuleCondition }
  | { field: "hasCode"; value: boolean }
  | { field: ConditionField; operator: TextOperator; value: string };

export interface RuleActions {
  delivery?: RuleAction;
  forwardTo?: string;
  tags?: string[];
  retentionDays?: number;
}

export interface ConditionTrace {
  label: string;
  result: boolean | null;
  children?: ConditionTrace[];
}

export interface RuleTrace {
  ruleId: string;
  name: string;
  condition: ConditionTrace;
  actions: RuleActions;
  stopped: boolean;
}

export interface Rule {
  name?: string;
  condition?: RuleCondition;
  actions?: RuleActions;
  priority?: number;
  stopProcessing?: boolean;
  action: RuleAction;
  aliasId: string | null;
  createdAt: string;
  enabled: boolean;
  field: RuleField;
  id: string;
  pattern: string;
  updatedAt: string;
}

export interface CreateRuleInput {
  name?: string;
  condition?: RuleCondition;
  actions?: RuleActions;
  priority?: number;
  stopProcessing?: boolean;
  action?: RuleAction;
  aliasId?: string | null;
  enabled?: boolean;
  field?: RuleField;
  pattern?: string;
}

export type UpdateRuleInput = Partial<CreateRuleInput>;

export interface Tag {
  createdAt: string;
  id: string;
  name: string;
}

export interface AuditFilters {
  eventType?: AuditEventType;
  q?: string;
  messageId?: string;
  correlationId?: string;
  since?: string;
  until?: string;
  before?: { createdAt: string; id: string };
}
export interface AuditPage {
  events: AuditEvent[];
  nextCursor: string | null;
}

export interface AuditEvent {
  actor?: string;
  correlationId?: string;
  aliasAddress?: string;
  createdAt: string;
  eventType: AuditEventType;
  id: string;
  messageId?: string;
  metadata?: Record<string, unknown>;
  reason?: string;
  sender?: string;
  status?: MessageStatus;
  subjectPreview?: string;
}

export interface CreateAuditEventInput {
  actor?: string;
  correlationId?: string;
  aliasAddress?: string;
  eventType: AuditEventType;
  messageId?: string;
  metadata?: Record<string, unknown>;
  reason?: string;
  sender?: string;
  status?: MessageStatus;
  subjectPreview?: string;
}

export interface RuleDecision {
  forwardTo?: string;
  retentionDays: number;
  tags: string[];
  trace: RuleTrace[];
  action: RuleAction;
  matchedRuleId: string | null;
}

export interface RulePreview {
  examined: number;
  matched: number;
  rows: {
    messageId: string;
    subject: string;
    aliasAddress: string;
    receivedAt: string;
    draftResult: boolean | null;
    draftReached: boolean;
    draftCondition: ConditionTrace;
    decision: RuleDecision;
  }[];
}

export interface ExpiredMessagesResult {
  count: number;
  messages: MessageRecord[];
  rawKeys: string[];
}

export interface DeleteMessagesResult {
  deleted: MessageRecord[];
  missing: string[];
  rawKeys: string[];
}
import type { MessageAnalysis } from "./analysis.ts";
