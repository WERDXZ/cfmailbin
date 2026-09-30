import type { CfMailBinConfig } from "../config.ts";
import { decodeWords } from "postal-mime";
import { parseMessageContent } from "./content.ts";
import { withContent } from "./rule-context.ts";
import type { Alias, IncomingMessage, RuleAction } from "../domain/models.ts";
import {
  messageStatusForAction,
  normalizeAddress,
  resolveMessageAction,
} from "../domain/rules.ts";
import type { ForwardableEmailMessage } from "../platform/cloudflare.ts";
import { computeExpiresAt } from "../services/retention.ts";
import { enrichMessage, pendingAnalysis } from "../services/email-analysis.ts";
import type { AnalysisFetch } from "./analysis.ts";
import type { AppStore, BlobStore } from "../storage/types.ts";

export interface EmailProcessingResult {
  action: RuleAction;
  alias: Alias | null;
  forwardedTo?: string;
  messageId?: string;
  rejected: boolean;
}

function defaultAliasAction(config: CfMailBinConfig): RuleAction {
  return config.defaultForwardTo ? "forward" : "keep";
}

function buildRawKey(receivedAt: string): string {
  return `messages/${receivedAt.slice(0, 10)}/${crypto.randomUUID()}.eml`;
}

async function readAllBytes(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    if (!value) {
      continue;
    }

    chunks.push(value);
    totalLength += value.length;
  }

  const merged = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

export async function processIncomingEmail(params: {
  blobStore: BlobStore;
  config: CfMailBinConfig;
  message: ForwardableEmailMessage;
  store: AppStore;
  waitUntil?: (task: Promise<unknown>) => void;
  analysisFetch?: AnalysisFetch;
}): Promise<EmailProcessingResult> {
  const receivedAt = new Date().toISOString();
  const aliasAddress = normalizeAddress(params.message.to);
  let alias = await params.store.findAliasByAddress(aliasAddress);
  let autoCreatedAlias = false;

  if (!alias && params.config.allowCatchAll) {
    const autoCreateTag = params.config.autoCreateAliasTag;

    alias = await params.store.ensureAliasByAddress({
      address: aliasAddress,
      defaultAction: defaultAliasAction(params.config),
      enabled: true,
      forwardTo: params.config.defaultForwardTo,
      retentionDays: params.config.defaultRetentionDays,
      tags: autoCreateTag ? [autoCreateTag] : undefined,
    });
    autoCreatedAlias = true;
  }

  if (!alias || !alias.enabled) {
    const reason = alias ? "Unknown or disabled alias" : "Unknown alias";
    params.message.setReject(reason);
    await params.store.createAuditEvent({
      aliasAddress,
      eventType: alias ? "rejected_disabled" : "rejected_unknown",
      reason,
      sender: params.message.from,
      subjectPreview: params.message.headers.get("subject")?.trim() ?? "",
    });

    return {
      action: "block",
      alias: alias ?? null,
      rejected: true,
    };
  }

  const incoming: IncomingMessage = {
    alias: aliasAddress,
    from: params.message.from,
    rawSize: params.message.rawSize,
    receivedAt,
    subject: decodeWords(params.message.headers.get("subject")?.trim() ?? ""),
  };

  if (autoCreatedAlias) {
    await params.store.createAuditEvent({
      aliasAddress,
      eventType: "auto_alias_created",
      metadata: { aliasId: alias.id },
      sender: incoming.from,
      subjectPreview: incoming.subject,
    });
  }

  const rules = await params.store.listRulesForAlias(alias.id);
  const rawBytes = await readAllBytes(params.message.raw);
  const content = await parseMessageContent(rawBytes);
  const decision = resolveMessageAction(
    alias,
    rules,
    withContent(incoming, content),
  );
  const ruleTrace = decision.trace.filter((trace) =>
    trace.condition.result !== false
  );

  if (decision.action === "block") {
    params.message.setReject("Blocked by rule");
    await params.store.createAuditEvent({
      aliasAddress,
      eventType: "blocked_by_rule",
      metadata: {
        matchedRuleId: decision.matchedRuleId ?? undefined,
        ruleTrace,
      },
      reason: "Blocked by rule",
      sender: incoming.from,
      subjectPreview: incoming.subject,
    });

    return {
      action: decision.action,
      alias,
      rejected: true,
    };
  }

  let forwardedTo: string | undefined;

  if (decision.action === "forward") {
    const forwardTarget = decision.forwardTo ?? params.config.defaultForwardTo;

    if (forwardTarget) {
      await params.message.forward(forwardTarget);
      forwardedTo = forwardTarget;
    }
  }

  const rawKey = buildRawKey(receivedAt);
  await params.blobStore.put(rawKey, rawBytes, "message/rfc822");
  const messageRecord = await params.store.createMessage({
    analysis: pendingAnalysis(params.config, content),
    aliasAddress,
    aliasId: alias.id,
    expiresAt: computeExpiresAt(receivedAt, decision.retentionDays),
    tags: decision.tags,
    ruleTrace,
    forwardedTo,
    from: incoming.from,
    matchedRuleId: decision.matchedRuleId ?? undefined,
    preview:
      (content.text || incoming.subject).replace(/\s+/g, " ").slice(0, 180) ||
      undefined,
    rawKey,
    verificationCodes: content.codes,
    receivedAt,
    status: messageStatusForAction(decision.action, Boolean(forwardedTo)),
    subject: incoming.subject,
  });
  await params.store.createAuditEvent({
    aliasAddress,
    eventType: "received",
    messageId: messageRecord.id,
    metadata: decision.matchedRuleId
      ? { matchedRuleId: decision.matchedRuleId }
      : undefined,
    sender: incoming.from,
    status: messageRecord.status,
    subjectPreview: incoming.subject,
  });

  if (forwardedTo) {
    await params.store.createAuditEvent({
      aliasAddress,
      eventType: "forwarded",
      messageId: messageRecord.id,
      metadata: { forwardedTo },
      sender: incoming.from,
      status: messageRecord.status,
      subjectPreview: incoming.subject,
    });
  }

  if (messageRecord.analysis?.status === "pending") {
    const enrichment = enrichMessage({
      id: messageRecord.id,
      content,
      config: params.config,
      store: params.store,
      fetcher: params.analysisFetch,
    });
    if (params.waitUntil) params.waitUntil(enrichment);
    else await enrichment;
  }

  return {
    action: decision.action,
    alias,
    forwardedTo,
    messageId: messageRecord.id,
    rejected: false,
  };
}
