import type { Alias, MessageRecord, Rule, Tag } from "../domain/models.ts";
import { normalizeAddress } from "../domain/rules.ts";
import type { D1Database, R2Bucket } from "../platform/cloudflare.ts";
import type { AppStore, BlobStore } from "./types.ts";

interface AliasRow {
  address: string;
  created_at: string;
  default_action: Alias["defaultAction"];
  description: string | null;
  enabled: number;
  forward_to: string | null;
  id: string;
  retention_days: number;
  updated_at: string;
}

interface RuleRow {
  action: Rule["action"];
  alias_id: string | null;
  created_at: string;
  enabled: number;
  field: Rule["field"];
  id: string;
  pattern: string;
  updated_at: string;
}

interface MessageRow {
  alias_address: string;
  alias_id: string;
  created_at: string;
  expires_at: string;
  forwarded_to: string | null;
  id: string;
  matched_rule_id: string | null;
  preview: string | null;
  raw_key: string | null;
  received_at: string;
  sender: string;
  status: MessageRecord["status"];
  subject: string;
}

interface TagRow {
  created_at: string;
  id: string;
  name: string;
}

function createPlaceholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
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

function mapAlias(row: AliasRow): Alias {
  return {
    address: row.address,
    createdAt: row.created_at,
    defaultAction: row.default_action,
    description: row.description ?? undefined,
    enabled: Boolean(row.enabled),
    forwardTo: row.forward_to ?? undefined,
    id: row.id,
    retentionDays: row.retention_days,
    updatedAt: row.updated_at,
  };
}

function mapRule(row: RuleRow): Rule {
  return {
    action: row.action,
    aliasId: row.alias_id,
    createdAt: row.created_at,
    enabled: Boolean(row.enabled),
    field: row.field,
    id: row.id,
    pattern: row.pattern,
    updatedAt: row.updated_at,
  };
}

function mapMessage(row: MessageRow, tags: string[]): MessageRecord {
  return {
    aliasAddress: row.alias_address,
    aliasId: row.alias_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    forwardedTo: row.forwarded_to ?? undefined,
    from: row.sender,
    id: row.id,
    matchedRuleId: row.matched_rule_id ?? undefined,
    preview: row.preview ?? undefined,
    rawKey: row.raw_key ?? undefined,
    receivedAt: row.received_at,
    status: row.status,
    subject: row.subject,
    tags,
  };
}

function mapTag(row: TagRow): Tag {
  return {
    createdAt: row.created_at,
    id: row.id,
    name: row.name,
  };
}

export function createR2BlobStore(bucket: R2Bucket): BlobStore {
  return {
    async deleteMany(keys) {
      if (keys.length === 0) {
        return;
      }

      await bucket.delete(keys.length === 1 ? keys[0] : keys);
    },

    async get(key) {
      const object = await bucket.get(key);

      if (!object?.body) {
        return null;
      }

      return {
        body: object.body,
        contentType: object.httpMetadata?.contentType,
      };
    },

    async put(key, value, contentType) {
      await bucket.put(key, value, {
        httpMetadata: contentType ? { contentType } : undefined,
      });
    },
  };
}

export function createD1Store(db: D1Database): AppStore {
  async function readMessageTags(
    messageIds: string[],
  ): Promise<Map<string, string[]>> {
    const grouped = new Map<string, string[]>();

    if (messageIds.length === 0) {
      return grouped;
    }

    const query = `
      SELECT mt.message_id, t.name
      FROM message_tags mt
      JOIN tags t ON t.id = mt.tag_id
      WHERE mt.message_id IN (${createPlaceholders(messageIds.length)})
      ORDER BY t.name ASC
    `;
    const result = await db.prepare(query).bind(...messageIds).all<{
      message_id: string;
      name: string;
    }>();

    for (const row of result.results ?? []) {
      const current = grouped.get(row.message_id) ?? [];
      current.push(row.name);
      grouped.set(row.message_id, current);
    }

    return grouped;
  }

  async function getAliasById(id: string): Promise<Alias | null> {
    const row = await db.prepare(
      `SELECT * FROM aliases WHERE id = ? LIMIT 1`,
    ).bind(id).first<AliasRow>();
    return row ? mapAlias(row) : null;
  }

  async function getRuleById(id: string): Promise<Rule | null> {
    const row = await db.prepare(
      `SELECT * FROM rules WHERE id = ? LIMIT 1`,
    ).bind(id).first<RuleRow>();
    return row ? mapRule(row) : null;
  }

  async function getMessageById(id: string): Promise<MessageRecord | null> {
    const row = await db.prepare(
      `SELECT * FROM messages WHERE id = ? LIMIT 1`,
    ).bind(id).first<MessageRow>();

    if (!row) {
      return null;
    }

    const tags = await readMessageTags([id]);
    return mapMessage(row, tags.get(id) ?? []);
  }

  return {
    async createAlias(input) {
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
        updatedAt: now,
      };

      await db.prepare(
        `
          INSERT INTO aliases (
            id,
            address,
            description,
            default_action,
            enabled,
            forward_to,
            retention_days,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).bind(
        alias.id,
        alias.address,
        alias.description ?? null,
        alias.defaultAction,
        alias.enabled ? 1 : 0,
        alias.forwardTo ?? null,
        alias.retentionDays,
        alias.createdAt,
        alias.updatedAt,
      ).run();

      return alias;
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

      await db.prepare(
        `
          INSERT INTO messages (
            id,
            alias_id,
            alias_address,
            sender,
            subject,
            preview,
            status,
            received_at,
            expires_at,
            raw_key,
            forwarded_to,
            matched_rule_id,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).bind(
        message.id,
        message.aliasId,
        message.aliasAddress,
        message.from,
        message.subject,
        message.preview ?? null,
        message.status,
        message.receivedAt,
        message.expiresAt,
        message.rawKey ?? null,
        message.forwardedTo ?? null,
        message.matchedRuleId ?? null,
        message.createdAt,
      ).run();

      if (input.tags && input.tags.length > 0) {
        await this.replaceMessageTags(message.id, input.tags);
      }

      return (await this.getMessage(message.id))!;
    },

    async createRule(input) {
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

      await db.prepare(
        `
          INSERT INTO rules (
            id,
            alias_id,
            field,
            pattern,
            action,
            enabled,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).bind(
        rule.id,
        rule.aliasId,
        rule.field,
        rule.pattern,
        rule.action,
        rule.enabled ? 1 : 0,
        rule.createdAt,
        rule.updatedAt,
      ).run();

      return rule;
    },

    async deleteExpiredMessages(before) {
      const result = await db.prepare(
        `SELECT id, raw_key FROM messages WHERE expires_at <= ?`,
      ).bind(before).all<{ id: string; raw_key: string | null }>();
      const rows = result.results ?? [];

      if (rows.length === 0) {
        return { count: 0, rawKeys: [] };
      }

      const messageIds = rows.map((row) => row.id);
      const rawKeys = rows.flatMap((row) => row.raw_key ? [row.raw_key] : []);
      await db.prepare(
        `DELETE FROM messages WHERE id IN (${
          createPlaceholders(messageIds.length)
        })`,
      ).bind(...messageIds).run();

      return {
        count: messageIds.length,
        rawKeys,
      };
    },

    async ensureAliasByAddress(input) {
      const existing = await this.findAliasByAddress(input.address);
      return existing ?? this.createAlias(input);
    },

    async findAliasByAddress(address) {
      const row = await db.prepare(
        `SELECT * FROM aliases WHERE address = ? LIMIT 1`,
      ).bind(normalizeAddress(address)).first<AliasRow>();
      return row ? mapAlias(row) : null;
    },

    findAliasById(id) {
      return getAliasById(id);
    },

    getMessage(id) {
      return getMessageById(id);
    },

    async listAliases() {
      const result = await db.prepare(
        `SELECT * FROM aliases ORDER BY created_at DESC`,
      ).all<AliasRow>();
      return (result.results ?? []).map(mapAlias);
    },

    async listMessages(filters = {}) {
      const limit = Math.max(1, Math.min(filters.limit ?? 50, 100));
      const clauses: string[] = [];
      const values: unknown[] = [];

      if (filters.aliasId) {
        clauses.push(`alias_id = ?`);
        values.push(filters.aliasId);
      }

      if (filters.status) {
        clauses.push(`status = ?`);
        values.push(filters.status);
      }

      if (filters.q?.trim()) {
        clauses.push(`(
          lower(alias_address) LIKE ? OR
          lower(sender) LIKE ? OR
          lower(subject) LIKE ?
        )`);
        const query = `%${filters.q.trim().toLowerCase()}%`;
        values.push(query, query, query);
      }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = await db.prepare(
        `
          SELECT *
          FROM messages
          ${where}
          ORDER BY received_at DESC
          LIMIT ?
        `,
      ).bind(...values, limit).all<MessageRow>();
      const results = rows.results ?? [];
      const tags = await readMessageTags(results.map((row) => row.id));
      return results.map((row) => mapMessage(row, tags.get(row.id) ?? []));
    },

    async listRules() {
      const result = await db.prepare(
        `SELECT * FROM rules ORDER BY created_at DESC`,
      ).all<RuleRow>();
      return (result.results ?? []).map(mapRule);
    },

    async listRulesForAlias(aliasId) {
      const result = await db.prepare(
        `
          SELECT *
          FROM rules
          WHERE alias_id IS NULL OR alias_id = ?
          ORDER BY CASE WHEN alias_id IS NULL THEN 1 ELSE 0 END, created_at ASC
        `,
      ).bind(aliasId).all<RuleRow>();
      return (result.results ?? []).map(mapRule);
    },

    async listTags() {
      const result = await db.prepare(
        `SELECT * FROM tags ORDER BY name ASC`,
      ).all<TagRow>();
      return (result.results ?? []).map(mapTag);
    },

    async replaceMessageTags(messageId, tagNames) {
      const normalizedTagNames = uniqueTagNames(tagNames);

      await db.prepare(
        `DELETE FROM message_tags WHERE message_id = ?`,
      ).bind(messageId).run();

      if (normalizedTagNames.length === 0) {
        return [];
      }

      const existingTags = await db.prepare(
        `
          SELECT id, name
          FROM tags
          WHERE name IN (${createPlaceholders(normalizedTagNames.length)})
        `,
      ).bind(...normalizedTagNames).all<{ id: string; name: string }>();
      const tagIdsByName = new Map(
        (existingTags.results ?? []).map((row) => [row.name, row.id]),
      );

      for (const tagName of normalizedTagNames) {
        if (tagIdsByName.has(tagName)) {
          continue;
        }

        const tagId = crypto.randomUUID();
        await db.prepare(
          `INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?)`,
        ).bind(tagId, tagName, new Date().toISOString()).run();
        tagIdsByName.set(tagName, tagId);
      }

      for (const tagName of normalizedTagNames) {
        await db.prepare(
          `INSERT INTO message_tags (message_id, tag_id) VALUES (?, ?)`,
        ).bind(messageId, tagIdsByName.get(tagName)!).run();
      }

      return normalizedTagNames;
    },

    async updateAlias(id, patch) {
      const assignments: string[] = [];
      const values: unknown[] = [];

      if (patch.address !== undefined) {
        assignments.push(`address = ?`);
        values.push(normalizeAddress(patch.address));
      }

      if (patch.defaultAction !== undefined) {
        assignments.push(`default_action = ?`);
        values.push(patch.defaultAction);
      }

      if (patch.description !== undefined) {
        assignments.push(`description = ?`);
        values.push(patch.description?.trim() || null);
      }

      if (patch.enabled !== undefined) {
        assignments.push(`enabled = ?`);
        values.push(patch.enabled ? 1 : 0);
      }

      if (patch.forwardTo !== undefined) {
        assignments.push(`forward_to = ?`);
        values.push(patch.forwardTo?.trim() || null);
      }

      if (patch.retentionDays !== undefined) {
        assignments.push(`retention_days = ?`);
        values.push(patch.retentionDays);
      }

      if (assignments.length === 0) {
        return getAliasById(id);
      }

      assignments.push(`updated_at = ?`);
      values.push(new Date().toISOString(), id);
      await db.prepare(
        `UPDATE aliases SET ${assignments.join(", ")} WHERE id = ?`,
      ).bind(...values).run();

      return getAliasById(id);
    },

    async updateMessage(id, patch) {
      const assignments: string[] = [];
      const values: unknown[] = [];

      if (patch.status !== undefined) {
        assignments.push(`status = ?`);
        values.push(patch.status);
      }

      if (assignments.length === 0) {
        return getMessageById(id);
      }

      values.push(id);
      await db.prepare(
        `UPDATE messages SET ${assignments.join(", ")} WHERE id = ?`,
      ).bind(...values).run();

      return getMessageById(id);
    },

    async updateRule(id, patch) {
      const assignments: string[] = [];
      const values: unknown[] = [];

      if (patch.action !== undefined) {
        assignments.push(`action = ?`);
        values.push(patch.action);
      }

      if (patch.aliasId !== undefined) {
        assignments.push(`alias_id = ?`);
        values.push(patch.aliasId);
      }

      if (patch.enabled !== undefined) {
        assignments.push(`enabled = ?`);
        values.push(patch.enabled ? 1 : 0);
      }

      if (patch.field !== undefined) {
        assignments.push(`field = ?`);
        values.push(patch.field);
      }

      if (patch.pattern !== undefined) {
        assignments.push(`pattern = ?`);
        values.push(patch.pattern.trim());
      }

      if (assignments.length === 0) {
        return getRuleById(id);
      }

      assignments.push(`updated_at = ?`);
      values.push(new Date().toISOString(), id);
      await db.prepare(
        `UPDATE rules SET ${assignments.join(", ")} WHERE id = ?`,
      ).bind(...values).run();

      return getRuleById(id);
    },

    async validateToken(token) {
      const row = await db.prepare(
        `SELECT token FROM tokens WHERE token = ? LIMIT 1`,
      ).bind(token).first<{ token: string }>();
      return Boolean(row);
    },
  };
}
