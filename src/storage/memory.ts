import type { Alias, MessageRecord, Rule, Tag } from "../domain/models.ts";
import { normalizeAddress } from "../domain/rules.ts";
import type { AppStore, BlobStore, StoredBlob } from "./types.ts";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function normalizeTagName(value: string): string {
  return value.trim().toLowerCase();
}

function uniqueTagNames(tagNames: string[]): string[] {
  const next = new Set<string>();

  for (const tagName of tagNames) {
    const normalized = normalizeTagName(tagName);

    if (normalized) {
      next.add(normalized);
    }
  }

  return [...next];
}

function ensureTagRecords(
  tags: Map<string, Tag>,
  tagIdsByName: Map<string, string>,
  tagNames: string[],
  createdAt = new Date().toISOString(),
): void {
  for (const tagName of uniqueTagNames(tagNames)) {
    if (tagIdsByName.has(tagName)) {
      continue;
    }

    const tagId = crypto.randomUUID();
    tags.set(tagId, {
      createdAt,
      id: tagId,
      name: tagName,
    });
    tagIdsByName.set(tagName, tagId);
  }
}

function toStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export function createMemoryBlobStore(): BlobStore {
  const blobs = new Map<string, { bytes: Uint8Array; contentType?: string }>();

  return {
    deleteMany(keys) {
      for (const key of keys) {
        blobs.delete(key);
      }

      return Promise.resolve();
    },

    get(key) {
      const blob = blobs.get(key);

      if (!blob) {
        return Promise.resolve(null);
      }

      return Promise.resolve(
        {
          body: toStream(blob.bytes.slice()),
          contentType: blob.contentType,
        } satisfies StoredBlob,
      );
    },

    put(key, value, contentType) {
      blobs.set(key, { bytes: value.slice(), contentType });
      return Promise.resolve();
    },
  };
}

export function createMemoryStore(seed?: {
  aliases?: Alias[];
  messages?: MessageRecord[];
  rules?: Rule[];
  tags?: Tag[];
  tokens?: string[];
}): AppStore {
  const aliases = new Map<string, Alias>();
  const rules = new Map<string, Rule>();
  const messages = new Map<string, MessageRecord>();
  const tags = new Map<string, Tag>();
  const tagIdsByName = new Map<string, string>();
  const messageTags = new Map<string, Set<string>>();
  const tokens = new Set(seed?.tokens ?? []);

  for (const alias of seed?.aliases ?? []) {
    ensureTagRecords(tags, tagIdsByName, alias.tags, alias.createdAt);
    aliases.set(alias.id, clone(alias));
  }

  for (const rule of seed?.rules ?? []) {
    rules.set(rule.id, clone(rule));
  }

  for (const tag of seed?.tags ?? []) {
    tags.set(tag.id, clone(tag));
    tagIdsByName.set(tag.name, tag.id);
  }

  for (const message of seed?.messages ?? []) {
    messages.set(message.id, clone(message));

    if (message.tags.length > 0) {
      const linkedTagIds = new Set<string>();

      for (const tagName of message.tags) {
        const normalized = normalizeTagName(tagName);
        let tagId = tagIdsByName.get(normalized);

        if (!tagId) {
          tagId = crypto.randomUUID();
          ensureTagRecords(tags, tagIdsByName, [normalized], message.createdAt);
          tagId = tagIdsByName.get(normalized)!;
        }

        linkedTagIds.add(tagId);
      }

      messageTags.set(message.id, linkedTagIds);
    }
  }

  function tagNamesForMessage(messageId: string): string[] {
    const linkedTagIds = messageTags.get(messageId);

    if (!linkedTagIds) {
      return [];
    }

    return [...linkedTagIds]
      .map((tagId) => tags.get(tagId)?.name)
      .filter((tagName): tagName is string => Boolean(tagName))
      .sort();
  }

  function materializeMessage(message: MessageRecord): MessageRecord {
    return {
      ...clone(message),
      tags: tagNamesForMessage(message.id),
    };
  }

  function sortedRulesForAlias(aliasId: string): Rule[] {
    return [...rules.values()]
      .filter((rule) => rule.aliasId === null || rule.aliasId === aliasId)
      .sort((left, right) => {
        if (left.aliasId === null && right.aliasId !== null) {
          return 1;
        }

        if (left.aliasId !== null && right.aliasId === null) {
          return -1;
        }

        return left.createdAt.localeCompare(right.createdAt);
      })
      .map((rule) => clone(rule));
  }

  return {
    createAlias(input) {
      const now = new Date().toISOString();
      const alias: Alias = {
        address: normalizeAddress(input.address),
        createdAt: now,
        defaultAction: input.defaultAction,
        description: input.description?.trim() || undefined,
        enabled: input.enabled ?? true,
        forwardTo: input.forwardTo?.trim() || undefined,
        id: crypto.randomUUID(),
        retentionDays: input.retentionDays,
        tags: uniqueTagNames(input.tags ?? []),
        updatedAt: now,
      };
      ensureTagRecords(tags, tagIdsByName, alias.tags, now);
      aliases.set(alias.id, alias);
      return Promise.resolve(clone(alias));
    },

    async createMessage(input) {
      const now = new Date().toISOString();
      const message: MessageRecord = {
        aliasAddress: normalizeAddress(input.aliasAddress),
        aliasId: input.aliasId,
        createdAt: now,
        expiresAt: input.expiresAt,
        forwardedTo: input.forwardedTo,
        from: input.from,
        id: crypto.randomUUID(),
        matchedRuleId: input.matchedRuleId,
        preview: input.preview,
        rawKey: input.rawKey,
        receivedAt: input.receivedAt,
        status: input.status,
        subject: input.subject,
        tags: [],
      };

      messages.set(message.id, message);

      if (input.tags && input.tags.length > 0) {
        await this.replaceMessageTags(message.id, input.tags);
      }

      return materializeMessage(message);
    },

    createRule(input) {
      const now = new Date().toISOString();
      const rule: Rule = {
        action: input.action,
        aliasId: input.aliasId ?? null,
        createdAt: now,
        enabled: input.enabled ?? true,
        field: input.field,
        id: crypto.randomUUID(),
        pattern: input.pattern.trim(),
        updatedAt: now,
      };
      rules.set(rule.id, rule);
      return Promise.resolve(clone(rule));
    },

    deleteExpiredMessages(before) {
      const rawKeys: string[] = [];
      let count = 0;

      for (const [messageId, message] of messages.entries()) {
        if (message.expiresAt > before) {
          continue;
        }

        if (message.rawKey) {
          rawKeys.push(message.rawKey);
        }

        messages.delete(messageId);
        messageTags.delete(messageId);
        count += 1;
      }

      return Promise.resolve({ count, rawKeys });
    },

    async ensureAliasByAddress(input) {
      const existing = await this.findAliasByAddress(input.address);
      return existing ?? this.createAlias(input);
    },

    findAliasByAddress(address) {
      const normalizedAddress = normalizeAddress(address);

      for (const alias of aliases.values()) {
        if (alias.address === normalizedAddress) {
          return Promise.resolve(clone(alias));
        }
      }

      return Promise.resolve(null);
    },

    findAliasById(id) {
      const alias = aliases.get(id);
      return Promise.resolve(alias ? clone(alias) : null);
    },

    getMessage(id) {
      const message = messages.get(id);
      return Promise.resolve(message ? materializeMessage(message) : null);
    },

    listAliases() {
      return Promise.resolve(
        [...aliases.values()]
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .map((alias) => clone(alias)),
      );
    },

    listMessages(filters = {}) {
      const limit = Math.max(1, Math.min(filters.limit ?? 50, 100));
      const query = filters.q?.trim().toLowerCase();

      return Promise.resolve(
        [...messages.values()]
          .filter((message) => {
            if (filters.aliasId && message.aliasId !== filters.aliasId) {
              return false;
            }

            if (filters.status && message.status !== filters.status) {
              return false;
            }

            if (!query) {
              return true;
            }

            const haystack =
              `${message.aliasAddress} ${message.from} ${message.subject}`
                .toLowerCase();
            return haystack.includes(query);
          })
          .sort((left, right) =>
            right.receivedAt.localeCompare(left.receivedAt)
          )
          .slice(0, limit)
          .map((message) => materializeMessage(message)),
      );
    },

    listRules() {
      return Promise.resolve(
        [...rules.values()]
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .map((rule) => clone(rule)),
      );
    },

    listRulesForAlias(aliasId) {
      return Promise.resolve(sortedRulesForAlias(aliasId));
    },

    listTags() {
      return Promise.resolve(
        [...tags.values()]
          .sort((left, right) => left.name.localeCompare(right.name))
          .map((tag) => clone(tag)),
      );
    },

    replaceMessageTags(messageId, tagNames) {
      if (!messages.has(messageId)) {
        return Promise.resolve([]);
      }

      const normalizedTagNames = uniqueTagNames(tagNames);
      const linkedTagIds = new Set<string>();

      for (const tagName of normalizedTagNames) {
        let tagId = tagIdsByName.get(tagName);

        if (!tagId) {
          tagId = crypto.randomUUID();
          const tag: Tag = {
            createdAt: new Date().toISOString(),
            id: tagId,
            name: tagName,
          };
          tags.set(tagId, tag);
          tagIdsByName.set(tagName, tagId);
        }

        linkedTagIds.add(tagId);
      }

      messageTags.set(messageId, linkedTagIds);
      const message = messages.get(messageId);

      if (message) {
        message.tags = normalizedTagNames;
      }

      return Promise.resolve(normalizedTagNames);
    },

    updateAlias(id, patch) {
      const alias = aliases.get(id);

      if (!alias) {
        return Promise.resolve(null);
      }

      if (patch.address !== undefined) {
        alias.address = normalizeAddress(patch.address);
      }

      if (patch.defaultAction !== undefined) {
        alias.defaultAction = patch.defaultAction;
      }

      if (patch.description !== undefined) {
        alias.description = patch.description?.trim() || undefined;
      }

      if (patch.enabled !== undefined) {
        alias.enabled = patch.enabled;
      }

      if (patch.forwardTo !== undefined) {
        alias.forwardTo = patch.forwardTo?.trim() || undefined;
      }

      if (patch.retentionDays !== undefined) {
        alias.retentionDays = patch.retentionDays;
      }

      alias.updatedAt = new Date().toISOString();
      return Promise.resolve(clone(alias));
    },

    updateMessage(id, patch) {
      const message = messages.get(id);

      if (!message) {
        return Promise.resolve(null);
      }

      if (patch.status !== undefined) {
        message.status = patch.status;
      }

      return Promise.resolve(materializeMessage(message));
    },

    updateRule(id, patch) {
      const rule = rules.get(id);

      if (!rule) {
        return Promise.resolve(null);
      }

      if (patch.action !== undefined) {
        rule.action = patch.action;
      }

      if (patch.aliasId !== undefined) {
        rule.aliasId = patch.aliasId;
      }

      if (patch.enabled !== undefined) {
        rule.enabled = patch.enabled;
      }

      if (patch.field !== undefined) {
        rule.field = patch.field;
      }

      if (patch.pattern !== undefined) {
        rule.pattern = patch.pattern.trim();
      }

      rule.updatedAt = new Date().toISOString();
      return Promise.resolve(clone(rule));
    },

    validateToken(token) {
      return Promise.resolve(tokens.has(token));
    },
  };
}
