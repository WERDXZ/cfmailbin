import type { CfMailBinConfig } from "../config.ts";
import type { Alias, IncomingMessage, RuleAction } from "../domain/models.ts";
import {
  messageStatusForAction,
  normalizeAddress,
  resolveMessageAction,
} from "../domain/rules.ts";
import type { ForwardableEmailMessage } from "../platform/cloudflare.ts";
import { computeExpiresAt } from "../services/retention.ts";
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
}): Promise<EmailProcessingResult> {
  const receivedAt = new Date().toISOString();
  const aliasAddress = normalizeAddress(params.message.to);
  let alias = await params.store.findAliasByAddress(aliasAddress);

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
  }

  if (!alias || !alias.enabled) {
    params.message.setReject("Unknown or disabled alias");

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
    subject: params.message.headers.get("subject")?.trim() ?? "",
  };
  const rules = await params.store.listRulesForAlias(alias.id);
  const decision = resolveMessageAction(alias, rules, incoming);

  if (decision.action === "block") {
    params.message.setReject("Blocked by rule");

    return {
      action: decision.action,
      alias,
      rejected: true,
    };
  }

  let forwardedTo: string | undefined;

  if (decision.action === "forward") {
    const forwardTarget = alias.forwardTo ?? params.config.defaultForwardTo;

    if (forwardTarget) {
      await params.message.forward(forwardTarget);
      forwardedTo = forwardTarget;
    }
  }

  const rawKey = buildRawKey(receivedAt);
  const rawBytes = await readAllBytes(params.message.raw);
  await params.blobStore.put(rawKey, rawBytes, "message/rfc822");
  const messageRecord = await params.store.createMessage({
    aliasAddress,
    aliasId: alias.id,
    expiresAt: computeExpiresAt(receivedAt, alias.retentionDays),
    forwardedTo,
    from: incoming.from,
    matchedRuleId: decision.matchedRuleId ?? undefined,
    preview: incoming.subject.slice(0, 180) || undefined,
    rawKey,
    receivedAt,
    status: messageStatusForAction(decision.action, Boolean(forwardedTo)),
    subject: incoming.subject,
  });

  return {
    action: decision.action,
    alias,
    forwardedTo,
    messageId: messageRecord.id,
    rejected: false,
  };
}
