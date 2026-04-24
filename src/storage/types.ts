import type {
  Alias,
  CreateAliasInput,
  CreateMessageInput,
  CreateRuleInput,
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
  createAlias(input: CreateAliasInput): Promise<Alias>;
  createMessage(input: CreateMessageInput): Promise<MessageRecord>;
  createRule(input: CreateRuleInput): Promise<Rule>;
  deleteExpiredMessages(before: string): Promise<ExpiredMessagesResult>;
  ensureAliasByAddress(input: CreateAliasInput): Promise<Alias>;
  findAliasByAddress(address: string): Promise<Alias | null>;
  findAliasById(id: string): Promise<Alias | null>;
  getMessage(id: string): Promise<MessageRecord | null>;
  listAliases(): Promise<Alias[]>;
  listMessages(filters?: MessageListFilters): Promise<MessageRecord[]>;
  listRules(): Promise<Rule[]>;
  listRulesForAlias(aliasId: string): Promise<Rule[]>;
  listTags(): Promise<Tag[]>;
  replaceMessageTags(messageId: string, tagNames: string[]): Promise<string[]>;
  updateAlias(id: string, patch: UpdateAliasInput): Promise<Alias | null>;
  updateMessage(
    id: string,
    patch: UpdateMessageInput,
  ): Promise<MessageRecord | null>;
  updateRule(id: string, patch: UpdateRuleInput): Promise<Rule | null>;
  validateToken(token: string): Promise<boolean>;
}
