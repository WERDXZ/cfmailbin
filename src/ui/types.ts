export type RuleAction = "keep" | "forward" | "trash" | "block";
export type RuleField = "alias" | "from" | "subject";
export type MessageStatus = "inbox" | "forwarded" | "trashed" | "blocked";

export interface Alias {
  address: string;
  createdAt: string;
  defaultAction: RuleAction;
  description?: string;
  enabled: boolean;
  forwardTo?: string;
  id: string;
  retentionDays: number;
  updatedAt: string;
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

export interface MessageRecord {
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

export interface BootstrapResponse {
  aliases: Alias[];
  config: {
    allowCatchAll: boolean;
    defaultRetentionDays: number;
    forwardingConfigured: boolean;
  };
  rules: Rule[];
  tags: Tag[];
}

export interface MessageFilters {
  aliasId?: string;
  q?: string;
  status?: MessageStatus;
}

export interface CreateAliasInput {
  address: string;
  defaultAction: RuleAction;
  description?: string;
  enabled?: boolean;
  forwardTo?: string;
  retentionDays: number;
}

export interface CreateRuleInput {
  action: RuleAction;
  aliasId: string | null;
  enabled?: boolean;
  field: RuleField;
  pattern: string;
}
