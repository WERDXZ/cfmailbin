import type {
  Alias,
  AuditEvent,
  MessageRecord,
  Rule,
  Tag,
} from "../domain/models.ts";
import { makeRule, normalizeAddress, patchRule } from "../domain/rules.ts";
import type { D1Database, R2Bucket } from "../platform/cloudflare.ts";
import type { AppStore, BlobStore } from "./types.ts";

interface AliasRow {
  last_received_at: string | null;
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
  name: string | null;
  condition_json: string | null;
  actions_json: string | null;
  priority: number;
  stop_processing: number;
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
  graph_run: string | null;
  analysis_json: string | null;
  rule_trace: string | null;
  verification_codes: string | null;
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

interface AuditEventRow {
  actor: string | null;
  correlation_id: string | null;
  alias_address: string | null;
  created_at: string;
  event_type: AuditEvent["eventType"];
  id: string;
  message_id: string | null;
  metadata_json: string | null;
  reason: string | null;
  sender: string | null;
  status: AuditEvent["status"] | null;
  subject_preview: string | null;
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

function mapAlias(row: AliasRow, tags: string[]): Alias {
  return {
    address: row.address,
    createdAt: row.created_at,
    lastReceivedAt: row.last_received_at ?? undefined,
    defaultAction: row.default_action,
    description: row.description ?? undefined,
    enabled: Boolean(row.enabled),
    forwardTo: row.forward_to ?? undefined,
    id: row.id,
    retentionDays: row.retention_days,
    tags,
    updatedAt: row.updated_at,
  };
}

function mapRule(row: RuleRow): Rule {
  return {
    name: row.name ?? undefined,
    condition: row.condition_json ? JSON.parse(row.condition_json) : undefined,
    actions: row.actions_json ? JSON.parse(row.actions_json) : undefined,
    priority: row.priority,
    stopProcessing: Boolean(row.stop_processing),
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
    graphRun: row.graph_run ? JSON.parse(row.graph_run) : undefined,
    analysis: row.analysis_json ? JSON.parse(row.analysis_json) : undefined,
    ruleTrace: row.rule_trace ? JSON.parse(row.rule_trace) : undefined,
    aliasAddress: row.alias_address,
    aliasId: row.alias_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    forwardedTo: row.forwarded_to ?? undefined,
    from: row.sender,
    id: row.id,
    matchedRuleId: row.matched_rule_id ?? undefined,
    preview: row.preview ?? undefined,
    verificationCodes: row.verification_codes == null
      ? undefined
      : JSON.parse(row.verification_codes),
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

function mapAuditEvent(row: AuditEventRow): AuditEvent {
  return {
    actor: row.actor ?? undefined,
    correlationId: row.correlation_id ?? undefined,
    aliasAddress: row.alias_address ?? undefined,
    createdAt: row.created_at,
    eventType: row.event_type,
    id: row.id,
    messageId: row.message_id ?? undefined,
    metadata: row.metadata_json
      ? JSON.parse(row.metadata_json) as Record<string, unknown>
      : undefined,
    reason: row.reason ?? undefined,
    sender: row.sender ?? undefined,
    status: row.status ?? undefined,
    subjectPreview: row.subject_preview ?? undefined,
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

  async function readAliasTags(
    aliasIds: string[],
  ): Promise<Map<string, string[]>> {
    const grouped = new Map<string, string[]>();

    if (aliasIds.length === 0) {
      return grouped;
    }

    const query = `
      SELECT at.alias_id, t.name
      FROM alias_tags at
      JOIN tags t ON t.id = at.tag_id
      WHERE at.alias_id IN (${createPlaceholders(aliasIds.length)})
      ORDER BY t.name ASC
    `;
    const result = await db.prepare(query).bind(...aliasIds).all<{
      alias_id: string;
      name: string;
    }>();

    for (const row of result.results ?? []) {
      const current = grouped.get(row.alias_id) ?? [];
      current.push(row.name);
      grouped.set(row.alias_id, current);
    }

    return grouped;
  }

  async function ensureTagIds(
    tagNames: string[],
  ): Promise<Map<string, string>> {
    const normalizedTagNames = uniqueTagNames(tagNames);
    const tagIdsByName = new Map<string, string>();

    if (normalizedTagNames.length === 0) {
      return tagIdsByName;
    }

    for (const tagName of normalizedTagNames) {
      await db.prepare(
        `INSERT OR IGNORE INTO tags (id, name, created_at) VALUES (?, ?, ?)`,
      ).bind(crypto.randomUUID(), tagName, new Date().toISOString()).run();
    }

    const tags = await db.prepare(
      `
        SELECT id, name
        FROM tags
        WHERE name IN (${createPlaceholders(normalizedTagNames.length)})
      `,
    ).bind(...normalizedTagNames).all<{ id: string; name: string }>();
    for (const row of tags.results ?? []) {
      tagIdsByName.set(row.name, row.id);
    }

    return tagIdsByName;
  }

  async function replaceAliasTags(
    aliasId: string,
    tagNames: string[],
  ): Promise<string[]> {
    const normalizedTagNames = uniqueTagNames(tagNames);

    await db.prepare(
      `DELETE FROM alias_tags WHERE alias_id = ?`,
    ).bind(aliasId).run();

    if (normalizedTagNames.length === 0) {
      return [];
    }

    const tagIdsByName = await ensureTagIds(normalizedTagNames);

    for (const tagName of normalizedTagNames) {
      await db.prepare(
        `INSERT INTO alias_tags (alias_id, tag_id) VALUES (?, ?)`,
      ).bind(aliasId, tagIdsByName.get(tagName)!).run();
    }

    return normalizedTagNames;
  }

  async function getAliasById(id: string): Promise<Alias | null> {
    const row = await db.prepare(
      `SELECT * FROM aliases WHERE id = ? LIMIT 1`,
    ).bind(id).first<AliasRow>();

    if (!row) {
      return null;
    }

    const tags = await readAliasTags([id]);
    return mapAlias(row, tags.get(id) ?? []);
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
    async createAuditEvent(input) {
      const event: AuditEvent = {
        actor: input.actor,
        correlationId: input.correlationId,
        aliasAddress: input.aliasAddress
          ? normalizeAddress(input.aliasAddress)
          : undefined,
        createdAt: new Date().toISOString(),
        eventType: input.eventType,
        id: crypto.randomUUID(),
        messageId: input.messageId,
        metadata: input.metadata,
        reason: input.reason,
        sender: input.sender,
        status: input.status,
        subjectPreview: input.subjectPreview?.slice(0, 180),
      };

      await db.prepare(
        `
          INSERT INTO audit_events (
            id,
            event_type,
            alias_address,
            message_id,
            sender,
            subject_preview,
            status,
            reason,
            metadata_json,
            created_at,
            actor,
            correlation_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).bind(
        event.id,
        event.eventType,
        event.aliasAddress ?? null,
        event.messageId ?? null,
        event.sender ?? null,
        event.subjectPreview ?? null,
        event.status ?? null,
        event.reason ?? null,
        event.metadata ? JSON.stringify(event.metadata) : null,
        event.createdAt,
        event.actor ?? null,
        event.correlationId ?? null,
      ).run();

      const row = await db.prepare(
        `SELECT * FROM audit_events WHERE id = ? LIMIT 1`,
      ).bind(event.id).first<AuditEventRow>();
      return mapAuditEvent(row!);
    },

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
        tags: uniqueTagNames(input.tags ?? []),
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

      if (alias.tags.length > 0) {
        await replaceAliasTags(alias.id, alias.tags);
      }

      return (await getAliasById(alias.id))!;
    },

    async createMessage(input) {
      const now = new Date().toISOString();
      const message: MessageRecord = {
        graphRun: input.graphRun,
        analysis: input.analysis,
        aliasAddress: normalizeAddress(input.aliasAddress),
        aliasId: input.aliasId,
        createdAt: now,
        expiresAt: input.expiresAt,
        forwardedTo: input.forwardedTo,
        from: input.from,
        id: crypto.randomUUID(),
        matchedRuleId: input.matchedRuleId,
        preview: input.preview,
        verificationCodes: input.verificationCodes,
        ruleTrace: input.ruleTrace,
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
            created_at,
            verification_codes,
            rule_trace,
            analysis_json,
            graph_run
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        message.verificationCodes === undefined
          ? null
          : JSON.stringify(message.verificationCodes),
        message.ruleTrace ? JSON.stringify(message.ruleTrace) : null,
        message.analysis ? JSON.stringify(message.analysis) : null,
        message.graphRun ? JSON.stringify(message.graphRun) : null,
      ).run();

      await db.prepare(`UPDATE aliases SET last_received_at = ?
        WHERE id = ? AND (last_received_at IS NULL OR last_received_at < ?)`)
        .bind(message.receivedAt, message.aliasId, message.receivedAt).run();

      if (input.tags && input.tags.length > 0) {
        await this.replaceMessageTags(message.id, input.tags);
      }

      return (await this.getMessage(message.id))!;
    },

    async createRule(input) {
      const row = await db.prepare(
        "SELECT COALESCE(MAX(priority), 0) AS priority FROM rules",
      ).first<{ priority: number }>();
      const rule = makeRule(input, (row?.priority ?? 0) + 10);
      await db.prepare(
        `INSERT INTO rules (id, alias_id, field, pattern, action, enabled, created_at, updated_at,
        name, condition_json, actions_json, priority, stop_processing)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          rule.id,
          rule.aliasId,
          rule.field,
          rule.pattern,
          rule.action,
          rule.enabled ? 1 : 0,
          rule.createdAt,
          rule.updatedAt,
          rule.name ?? null,
          JSON.stringify(rule.condition),
          JSON.stringify(rule.actions),
          rule.priority,
          rule.stopProcessing ? 1 : 0,
        ).run();
      return rule;
    },

    async deleteExpiredMessages(before) {
      const result = await db.prepare(
        `SELECT * FROM messages WHERE expires_at <= ?`,
      ).bind(before).all<MessageRow>();
      const rows = result.results ?? [];

      if (rows.length === 0) {
        return { count: 0, messages: [], rawKeys: [] };
      }

      const messageIds = rows.map((row) => row.id);
      const rawKeys = rows.flatMap((row) => row.raw_key ? [row.raw_key] : []);
      const tags = await readMessageTags(messageIds);
      await db.prepare(
        `DELETE FROM messages WHERE id IN (${
          createPlaceholders(messageIds.length)
        })`,
      ).bind(...messageIds).run();

      return {
        count: messageIds.length,
        messages: rows.map((row) => mapMessage(row, tags.get(row.id) ?? [])),
        rawKeys,
      };
    },

    async deleteMessages(ids) {
      const uniqueIds = [
        ...new Set(ids.map((id) => id.trim()).filter(Boolean)),
      ];

      if (uniqueIds.length === 0) {
        return { deleted: [], missing: [], rawKeys: [] };
      }

      const result = await db.prepare(
        `
          SELECT *
          FROM messages
          WHERE id IN (${createPlaceholders(uniqueIds.length)})
        `,
      ).bind(...uniqueIds).all<MessageRow>();
      const rows = result.results ?? [];
      const foundIds = new Set(rows.map((row) => row.id));
      const deletedIds = rows.map((row) => row.id);
      const missing = uniqueIds.filter((id) => !foundIds.has(id));

      if (deletedIds.length === 0) {
        return { deleted: [], missing, rawKeys: [] };
      }

      const tags = await readMessageTags(deletedIds);
      await db.prepare(
        `DELETE FROM messages WHERE id IN (${
          createPlaceholders(deletedIds.length)
        })`,
      ).bind(...deletedIds).run();

      return {
        deleted: rows.map((row) => mapMessage(row, tags.get(row.id) ?? [])),
        missing,
        rawKeys: rows.flatMap((row) => row.raw_key ? [row.raw_key] : []),
      };
    },

    async ensureAliasByAddress(input) {
      const existing = await this.findAliasByAddress(input.address);
      if (existing) return existing;
      try {
        return await this.createAlias(input);
      } catch (error) {
        // Another receipt may create this unique address between SELECT/INSERT.
        const created = await this.findAliasByAddress(input.address);
        if (created) return created;
        throw error;
      }
    },

    async findAliasByAddress(address) {
      const row = await db.prepare(
        `SELECT * FROM aliases WHERE address = ? LIMIT 1`,
      ).bind(normalizeAddress(address)).first<AliasRow>();

      if (!row) {
        return null;
      }

      const tags = await readAliasTags([row.id]);
      return mapAlias(row, tags.get(row.id) ?? []);
    },

    findAliasById(id) {
      return getAliasById(id);
    },

    getMessage(id) {
      return getMessageById(id);
    },

    async getDeliveryStatus(domain) {
      async function latest(types: string[]) {
        const domainClause = domain
          ? "AND substr(alias_address, instr(alias_address, '@') + 1) = ?"
          : "";
        return await db.prepare(`SELECT * FROM audit_events
          WHERE event_type IN (${
          createPlaceholders(types.length)
        }) ${domainClause}
          ORDER BY created_at DESC LIMIT 1`)
          .bind(...types, ...(domain ? [domain] : [])).first<AuditEventRow>();
      }
      const [received, rejected] = await Promise.all([
        latest(["received"]),
        latest(["rejected_unknown", "rejected_disabled", "blocked_by_rule"]),
      ]);
      return {
        ...(received ? { lastReceived: mapAuditEvent(received) } : {}),
        ...(rejected ? { lastRejected: mapAuditEvent(rejected) } : {}),
      };
    },

    async listAuditEvents(limit = 100, filters = {}) {
      const clauses: string[] = [], values: unknown[] = [];
      for (
        const [column, value] of [
          ["event_type", filters.eventType],
          ["message_id", filters.messageId],
          ["correlation_id", filters.correlationId],
        ]
      ) {
        if (value) {
          clauses.push(`${column} = ?`);
          values.push(value);
        }
      }
      if (filters.since) {
        clauses.push("created_at >= ?");
        values.push(filters.since);
      }
      if (filters.until) {
        clauses.push("created_at <= ?");
        values.push(filters.until);
      }
      if (filters.before) {
        clauses.push("(created_at < ? OR (created_at = ? AND id < ?))");
        values.push(
          filters.before.createdAt,
          filters.before.createdAt,
          filters.before.id,
        );
      }
      if (filters.q) {
        clauses.push(
          "instr(lower(COALESCE(alias_address,'') || char(10) || COALESCE(sender,'') || char(10) || COALESCE(subject_preview,'') || char(10) || COALESCE(reason,'') || char(10) || COALESCE(actor,'') || char(10) || COALESCE(message_id,'') || char(10) || COALESCE(correlation_id,'')), ?) > 0",
        );
        values.push(filters.q.toLowerCase());
      }
      const result = await db.prepare(`SELECT * FROM audit_events
        ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
        ORDER BY created_at DESC, id DESC LIMIT ?`)
        .bind(...values, Math.max(1, Math.min(limit, 500))).all<
        AuditEventRow
      >();
      return (result.results ?? []).map(mapAuditEvent);
    },

    async listAliases() {
      const result = await db.prepare(
        `SELECT * FROM aliases ORDER BY last_received_at DESC, created_at DESC`,
      ).all<AliasRow>();
      const rows = result.results ?? [];
      const tags = await readAliasTags(rows.map((row) => row.id));
      return rows.map((row) => mapAlias(row, tags.get(row.id) ?? []));
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
          lower(subject) LIKE ? OR
          lower(preview) LIKE ? OR
          alias_id IN (SELECT id FROM aliases WHERE lower(description) LIKE ?)
        )`);
        const query = `%${filters.q.trim().toLowerCase()}%`;
        values.push(query, query, query, query, query);
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
        `SELECT * FROM rules ORDER BY priority, created_at, id`,
      ).all<RuleRow>();
      return (result.results ?? []).map(mapRule);
    },

    async reorderRules(ids) {
      // One statement keeps the order atomic and uses only three bound parameters.
      const json = JSON.stringify(ids);
      await db.prepare(`UPDATE rules SET priority = (
        SELECT (CAST(key AS INTEGER) + 1) * 10 FROM json_each(?) WHERE value = rules.id
      ), updated_at = ? WHERE id IN (SELECT value FROM json_each(?))`)
        .bind(json, new Date().toISOString(), json).run();
      return this.listRules();
    },

    async listRulesForAlias(aliasId) {
      const result = await db.prepare(
        `
          SELECT *
          FROM rules
          WHERE alias_id IS NULL OR alias_id = ?
          ORDER BY priority, created_at, id
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

    async appendMessageTags(messageId, tagNames) {
      const normalizedTagNames = uniqueTagNames(tagNames);
      if (!normalizedTagNames.length) return getMessageById(messageId);

      const entries = JSON.stringify(
        normalizedTagNames.map((name) => ({ id: crypto.randomUUID(), name })),
      );
      const statements = [
        db.prepare(`
          INSERT OR IGNORE INTO tags (id, name, created_at)
          SELECT
            json_extract(value, '$.id'),
            json_extract(value, '$.name'),
            ?
          FROM json_each(?)
          WHERE EXISTS (SELECT 1 FROM messages WHERE id = ?)
        `).bind(new Date().toISOString(), entries, messageId),
        db.prepare(`
          INSERT OR IGNORE INTO message_tags (message_id, tag_id)
          SELECT ?, tags.id
          FROM tags
          JOIN json_each(?) AS requested
            ON tags.name = json_extract(requested.value, '$.name')
          WHERE EXISTS (SELECT 1 FROM messages WHERE id = ?)
        `).bind(messageId, entries, messageId),
      ];
      await db.batch(statements);
      return getMessageById(messageId);
    },

    async replaceMessageTags(messageId, tagNames) {
      const normalizedTagNames = uniqueTagNames(tagNames);

      await db.prepare(
        `DELETE FROM message_tags WHERE message_id = ?`,
      ).bind(messageId).run();

      if (normalizedTagNames.length === 0) {
        return [];
      }

      const tagIdsByName = await ensureTagIds(normalizedTagNames);

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

      for (
        const [field, column] of [["graphRun", "graph_run"], [
          "forwardedTo",
          "forwarded_to",
        ], ["expiresAt", "expires_at"]] as const
      ) {
        if (patch[field] !== undefined) {
          assignments.push(`${column} = ?`);
          values.push(
            field === "graphRun" ? JSON.stringify(patch[field]) : patch[field],
          );
        }
      }

      if (patch.analysis !== undefined) {
        assignments.push(`analysis_json = ?`);
        values.push(JSON.stringify(patch.analysis));
      }

      if (patch.verificationCodes !== undefined) {
        assignments.push(`verification_codes = ?`);
        values.push(JSON.stringify(patch.verificationCodes));
      }

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

    async saveGraphRun(id, run) {
      const row = await db.prepare(
        "UPDATE messages SET graph_run = ? WHERE id = ? RETURNING id",
      )
        .bind(JSON.stringify(run), id).first<{ id: string }>();
      return row !== null;
    },

    async reserveAnalysisCall(day, limit) {
      if (limit <= 0) return false;
      const row = await db.prepare(`
        INSERT INTO ai_daily_usage (day, calls) VALUES (?, 1)
        ON CONFLICT(day) DO UPDATE SET calls = calls + 1 WHERE calls < ?
        RETURNING day
      `).bind(day, limit).first<{ day: string }>();
      return row !== null;
    },

    async updateRule(id, patch) {
      const current = await getRuleById(id);
      if (!current) return null;
      const rule = patchRule(current, patch);
      const columns: Record<string, unknown> = { updated_at: rule.updatedAt };
      if (patch.aliasId !== undefined) columns.alias_id = rule.aliasId;
      if (patch.field !== undefined) columns.field = rule.field;
      if (patch.pattern !== undefined) columns.pattern = rule.pattern;
      if (patch.action !== undefined || patch.actions?.delivery !== undefined) {
        columns.action = rule.action;
      }
      if (patch.enabled !== undefined) columns.enabled = rule.enabled ? 1 : 0;
      if (patch.name !== undefined) columns.name = rule.name;
      if (patch.priority !== undefined) columns.priority = rule.priority;
      if (patch.stopProcessing !== undefined) {
        columns.stop_processing = rule.stopProcessing ? 1 : 0;
      }
      if (
        patch.condition !== undefined || patch.field !== undefined ||
        patch.pattern !== undefined
      ) columns.condition_json = JSON.stringify(rule.condition);
      if (patch.actions !== undefined || patch.action !== undefined) {
        columns.actions_json = JSON.stringify(rule.actions);
      }
      await db.prepare(
        `UPDATE rules SET ${
          Object.keys(columns).map((column) => `${column} = ?`).join(", ")
        } WHERE id = ?`,
      )
        .bind(...Object.values(columns), id).run();
      return getRuleById(id);
    },
  };
}
