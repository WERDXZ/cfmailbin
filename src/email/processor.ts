import type { CfMailBinConfig } from "../config.ts";
import { decodeWords } from "postal-mime";
import { parseMessageContent } from "./content.ts";
import type { Alias, IncomingMessage, RuleAction } from "../domain/models.ts";
import { normalizeAddress } from "../domain/rules.ts";
import type { ForwardableEmailMessage } from "../platform/cloudflare.ts";
import type { AnalysisFetch } from "./analysis.ts";
import type { AppStore, BlobStore } from "../storage/types.ts";
import type { MailGraph } from "../graph/types.ts";
import { recordAudit } from "../services/audit.ts";
import { processGraphEmail } from "../graph/process.ts";

export interface EmailProcessingResult {
  action: RuleAction;
  alias: Alias | null;
  forwardedTo?: string;
  messageId?: string;
  rejected: boolean;
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
  analysisFetch?: AnalysisFetch;
  graph?: MailGraph | null;
  notify?: () => Promise<void>;
}): Promise<EmailProcessingResult> {
  const correlationId = crypto.randomUUID();
  const receivedAt = new Date().toISOString();
  const aliasAddress = normalizeAddress(params.message.to);
  if (!params.graph?.enabled || params.graph.version !== 2) {
    const reason = "No active receiving workflow";
    params.message.setReject(reason);
    await recordAudit(params.store, {
      correlationId,
      aliasAddress,
      eventType: "blocked_by_rule",
      reason,
      sender: params.message.from,
      subjectPreview: params.message.headers.get("subject")?.trim() ?? "",
    });
    return { action: "block", alias: null, rejected: true };
  }
  let alias = await params.store.findAliasByAddress(aliasAddress);
  let autoCreatedAlias = false;

  if (!alias && params.config.allowCatchAll) {
    const autoCreateTag = params.config.autoCreateAliasTag;

    alias = await params.store.ensureAliasByAddress({
      address: aliasAddress,
      defaultAction: "block",
      enabled: true,
      retentionDays: params.config.defaultRetentionDays,
      tags: autoCreateTag ? [autoCreateTag] : undefined,
    });
    autoCreatedAlias = true;
  }

  if (!alias || !alias.enabled) {
    const reason = alias ? "Unknown or disabled alias" : "Unknown alias";
    params.message.setReject(reason);
    await recordAudit(params.store, {
      correlationId,
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
    await recordAudit(params.store, {
      correlationId,
      aliasAddress,
      eventType: "auto_alias_created",
      metadata: { aliasId: alias.id },
      sender: incoming.from,
      subjectPreview: incoming.subject,
    });
  }

  const rawBytes = await readAllBytes(params.message.raw);
  const content = await parseMessageContent(rawBytes);
  return processGraphEmail(
    params,
    params.graph,
    alias,
    incoming,
    content,
    rawBytes,
    buildRawKey(receivedAt),
    correlationId,
  );
}
