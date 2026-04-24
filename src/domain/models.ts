export type RuleAction = "keep" | "forward" | "trash" | "block";
export type RuleField = "alias" | "from" | "subject";
export type MessageStatus = "inbox" | "forwarded" | "trashed" | "blocked";

export interface Alias {
  id: string;
  address: string;
  description?: string;
  createdAt: string;
  defaultAction: RuleAction;
  enabled: boolean;
  forwardTo?: string;
  retentionDays: number;
  updatedAt: string;
}

export interface CreateAliasInput {
  address: string;
  defaultAction: RuleAction;
  description?: string;
  enabled?: boolean;
  forwardTo?: string;
  retentionDays: number;
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
  alias: string;
  from: string;
  receivedAt: string;
  rawSize?: number;
  subject: string;
}

export interface MessageRecord {
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
  receivedAt: string;
  rawKey?: string;
  status: MessageStatus;
  tags: string[];
}

export interface CreateMessageInput {
  aliasAddress: string;
  aliasId: string;
  expiresAt: string;
  from: string;
  forwardedTo?: string;
  matchedRuleId?: string;
  preview?: string;
  rawKey?: string;
  receivedAt: string;
  status: MessageStatus;
  subject: string;
  tags?: string[];
}

export interface UpdateMessageInput {
  status?: MessageStatus;
}

export interface MessageListFilters {
  aliasId?: string;
  limit?: number;
  q?: string;
  status?: MessageStatus;
}

export interface Rule {
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
  action: RuleAction;
  aliasId?: string | null;
  enabled?: boolean;
  field: RuleField;
  pattern: string;
}

export interface UpdateRuleInput {
  action?: RuleAction;
  aliasId?: string | null;
  enabled?: boolean;
  field?: RuleField;
  pattern?: string;
}

export interface Tag {
  createdAt: string;
  id: string;
  name: string;
}

export interface RuleDecision {
  action: RuleAction;
  matchedRuleId: string | null;
}

export interface ExpiredMessagesResult {
  count: number;
  rawKeys: string[];
}
