import type {
  Alias,
  AuditEvent,
  AuditFilters,
  CreateAliasInput,
  CreateAuditEventInput,
  CreateMessageInput,
  CreateRuleInput,
  DeleteMessagesResult,
  DeliveryStatus,
  ExpiredMessagesResult,
  MessageListFilters,
  MessageRecord,
  Rule,
  Tag,
  UpdateAliasInput,
  UpdateMessageInput,
  UpdateRuleInput,
} from "../domain/models.ts";

export interface StoredBlob {
  body: ReadableStream<Uint8Array>;
  contentType?: string;
}

export interface BlobStore {
  deleteMany(keys: string[]): Promise<void>;
  get(key: string): Promise<StoredBlob | null>;
  put(key: string, value: Uint8Array, contentType?: string): Promise<void>;
}

export interface AppStore {
  appendMessageTags(
    messageId: string,
    tagNames: string[],
  ): Promise<MessageRecord | null>;
  saveGraphRun(
    id: string,
    run: import("../graph/types.ts").GraphRun,
  ): Promise<boolean>;
  reserveAnalysisCall(day: string, limit: number): Promise<boolean>;
  createAuditEvent(input: CreateAuditEventInput): Promise<AuditEvent>;
  createAlias(input: CreateAliasInput): Promise<Alias>;
  createMessage(input: CreateMessageInput): Promise<MessageRecord>;
  createRule(input: CreateRuleInput): Promise<Rule>;
  deleteExpiredMessages(before: string): Promise<ExpiredMessagesResult>;
  deleteMessages(ids: string[]): Promise<DeleteMessagesResult>;
  ensureAliasByAddress(input: CreateAliasInput): Promise<Alias>;
  findAliasByAddress(address: string): Promise<Alias | null>;
  findAliasById(id: string): Promise<Alias | null>;
  getMessage(id: string): Promise<MessageRecord | null>;
  getDeliveryStatus(domain?: string): Promise<DeliveryStatus>;
  listAuditEvents(
    limit?: number,
    filters?: AuditFilters,
  ): Promise<AuditEvent[]>;
  listAliases(): Promise<Alias[]>;
  listMessages(filters?: MessageListFilters): Promise<MessageRecord[]>;
  listRules(): Promise<Rule[]>;
  listRulesForAlias(aliasId: string): Promise<Rule[]>;
  reorderRules(ids: string[]): Promise<Rule[]>;
  listTags(): Promise<Tag[]>;
  replaceMessageTags(messageId: string, tagNames: string[]): Promise<string[]>;
  updateAlias(id: string, patch: UpdateAliasInput): Promise<Alias | null>;
  updateMessage(
    id: string,
    patch: UpdateMessageInput,
  ): Promise<MessageRecord | null>;
  updateRule(id: string, patch: UpdateRuleInput): Promise<Rule | null>;
}
