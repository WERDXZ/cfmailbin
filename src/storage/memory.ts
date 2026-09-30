import type {
  Alias,
  AuditEvent,
  MessageRecord,
  Rule,
  Tag,
} from "../domain/models.ts";
import {
  compareRules,
  makeRule,
  normalizeAddress,
  patchRule,
} from "../domain/rules.ts";
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
  auditEvents?: AuditEvent[];
  messages?: MessageRecord[];
  rules?: Rule[];
  tags?: Tag[];
}): AppStore {
  const aliases = new Map<string, Alias>();
  const auditEvents = new Map<string, AuditEvent>();
  const rules = new Map<string, Rule>();
  const messages = new Map<string, MessageRecord>();
  const analysisCalls = new Map<string, number>();
  const tags = new Map<string, Tag>();
  const tagIdsByName = new Map<string, string>();
  const messageTags = new Map<string, Set<string>>();

  for (const alias of seed?.aliases ?? []) {
    ensureTagRecords(tags, tagIdsByName, alias.tags, alias.createdAt);
    aliases.set(alias.id, clone(alias));
  }

  for (const event of seed?.auditEvents ?? []) {
    auditEvents.set(event.id, clone(event));
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
      .sort(compareRules)
      .map((rule) => clone(rule));
  }

  return {
    createAuditEvent(input) {
      const event: AuditEvent = {
        aliasAddress: input.aliasAddress
          ? normalizeAddress(input.aliasAddress)
          : undefined,
        createdAt: new Date().toISOString(),
        eventType: input.eventType,
        id: crypto.randomUUID(),
        messageId: input.messageId,
        metadata: input.metadata ? clone(input.metadata) : undefined,
        reason: input.reason,
        sender: input.sender,
        status: input.status,
        subjectPreview: input.subjectPreview?.slice(0, 180),
      };
      auditEvents.set(event.id, event);
      return Promise.resolve(clone(event));
    },

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
        analysis: input.analysis ? clone(input.analysis) : undefined,
        aliasAddress: normalizeAddress(input.aliasAddress),
        aliasId: input.aliasId,
        createdAt: now,
        expiresAt: input.expiresAt,
        forwardedTo: input.forwardedTo,
        from: input.from,
        id: crypto.randomUUID(),
        matchedRuleId: input.matchedRuleId,
        preview: input.preview,
        verificationCodes: input.verificationCodes?.slice(),
        ruleTrace: input.ruleTrace ? clone(input.ruleTrace) : undefined,
        rawKey: input.rawKey,
        receivedAt: input.receivedAt,
        status: input.status,
        subject: input.subject,
        tags: [],
      };

      messages.set(message.id, message);
      const alias = aliases.get(message.aliasId);
      if (
        alias &&
        (!alias.lastReceivedAt || alias.lastReceivedAt < message.receivedAt)
      ) {
        alias.lastReceivedAt = message.receivedAt;
      }

      if (input.tags && input.tags.length > 0) {
        await this.replaceMessageTags(message.id, input.tags);
      }

      return materializeMessage(message);
    },

    createRule(input) {
      const priority =
        Math.max(0, ...[...rules.values()].map((rule) => rule.priority ?? 0)) +
        10;
      const rule = makeRule(input, priority);
      rules.set(rule.id, rule);
      return Promise.resolve(clone(rule));
    },

    deleteExpiredMessages(before) {
      const rawKeys: string[] = [];
      const deleted: MessageRecord[] = [];
      let count = 0;

      for (const [messageId, message] of messages.entries()) {
        if (message.expiresAt > before) {
          continue;
        }

        if (message.rawKey) {
          rawKeys.push(message.rawKey);
        }

        deleted.push(materializeMessage(message));
        messages.delete(messageId);
        messageTags.delete(messageId);
        count += 1;
      }

      return Promise.resolve({ count, messages: deleted, rawKeys });
    },

    deleteMessages(ids) {
      const uniqueIds = [
        ...new Set(ids.map((id) => id.trim()).filter(Boolean)),
      ];
      const deleted: MessageRecord[] = [];
      const missing: string[] = [];
      const rawKeys: string[] = [];

      for (const messageId of uniqueIds) {
        const message = messages.get(messageId);

        if (!message) {
          missing.push(messageId);
          continue;
        }

        deleted.push(materializeMessage(message));

        if (message.rawKey) {
          rawKeys.push(message.rawKey);
        }

        messages.delete(messageId);
        messageTags.delete(messageId);
      }

      return Promise.resolve({ deleted, missing, rawKeys });
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

    getDeliveryStatus(domain) {
      const events = [...auditEvents.values()]
        .filter((event) =>
          !domain || event.aliasAddress?.split("@")[1] === domain
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      const lastReceived = events.find((event) =>
        event.eventType === "received"
      );
      const lastRejected = events.find((event) =>
        ["rejected_unknown", "rejected_disabled", "blocked_by_rule"].includes(
          event.eventType,
        )
      );
      return Promise.resolve({
        ...(lastReceived ? { lastReceived: clone(lastReceived) } : {}),
        ...(lastRejected ? { lastRejected: clone(lastRejected) } : {}),
      });
    },

    listAuditEvents(limit = 100) {
      const cappedLimit = Math.max(1, Math.min(limit, 500));
      return Promise.resolve(
        [...auditEvents.values()]
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .slice(0, cappedLimit)
          .map((event) => clone(event)),
      );
    },

    listAliases() {
      return Promise.resolve(
        [...aliases.values()]
          .sort((left, right) =>
            (right.lastReceivedAt ?? "").localeCompare(
              left.lastReceivedAt ?? "",
            ) || right.createdAt.localeCompare(left.createdAt)
          )
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
              `${message.aliasAddress} ${message.from} ${message.subject} ${
                message.preview ?? ""
              } ${aliases.get(message.aliasId)?.description ?? ""}`
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
        [...rules.values()].sort(compareRules).map((rule) => clone(rule)),
      );
    },
    reorderRules(ids) {
      ids.forEach((id, index) => {
        const rule = rules.get(id);
        if (rule) {
          rule.priority = (index + 1) * 10;
          rule.updatedAt = new Date().toISOString();
        }
      });
      return this.listRules();
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

      if (patch.analysis !== undefined) {
        message.analysis = clone(patch.analysis);
      }

      if (patch.status !== undefined) {
        message.status = patch.status;
      }
      if (patch.verificationCodes !== undefined) {
        message.verificationCodes = patch.verificationCodes.slice();
      }

      return Promise.resolve(materializeMessage(message));
    },

    reserveAnalysisCall(day, limit) {
      const count = analysisCalls.get(day) ?? 0;
      if (count >= limit) return Promise.resolve(false);
      analysisCalls.set(day, count + 1);
      return Promise.resolve(true);
    },

    claimMessageAnalysis(id) {
      const message = messages.get(id);
      if (message?.analysis?.status !== "pending") {
        return Promise.resolve(false);
      }
      message.analysis.status = "running";
      return Promise.resolve(true);
    },

    updateRule(id, patch) {
      const rule = rules.get(id);

      if (!rule) {
        return Promise.resolve(null);
      }

      const next = patchRule(rule, patch);
      rules.set(id, clone(next));
      return Promise.resolve(clone(next));
    },
  };
}
