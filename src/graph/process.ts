import {
  recordAudit,
  workflowAuditMetadata,
  workflowEventType,
} from "../services/audit.ts";
import type {
  Alias,
  IncomingMessage,
  MessageContent,
} from "../domain/models.ts";
import type {
  EmailProcessingResult,
  processIncomingEmail,
} from "../email/processor.ts";
import { computeExpiresAt } from "../services/retention.ts";
import { graphAi } from "./ai.ts";
import { replyToIncoming } from "../email/reply.ts";
import { runGraph } from "./run.ts";
import {
  GraphError,
  type GraphRun,
  type JsonValue,
  type MailGraph,
} from "./types.ts";
import { messageStatusForAction } from "../domain/rules.ts";

export function graphEmail(
  content: MessageContent,
  from: string,
  to: string,
): Record<string, JsonValue> {
  return {
    subject: content.subject.slice(0, 500),
    text: content.text.slice(0, 12000),
    body: content.text.slice(0, 50000),
    from,
    fromDomain: from.slice(from.lastIndexOf("@") + 1).toLowerCase(),
    to,
    codes: content.codes,
    localCodes: content.codes,
    unavailable: !!content.warning,
    subjectTruncated: content.subject.length > 500,
    textTruncated: content.truncated || !!content.warning ||
      content.text.length > 12000,
    bodyTruncated: content.truncated || !!content.warning ||
      content.text.length > 50000,
    truncated: content.truncated || !!content.warning ||
      content.text.length > 12000 || content.subject.length > 500,
  };
}

export async function processGraphEmail(
  params: Parameters<typeof processIncomingEmail>[0],
  graph: MailGraph,
  alias: Alias,
  incoming: IncomingMessage,
  content: MessageContent,
  rawBytes: Uint8Array,
  rawKey: string,
  correlationId: string,
): Promise<EmailProcessingResult> {
  await params.blobStore.put(rawKey, rawBytes, "message/rfc822");
  const message = await params.store.createMessage({
    aliasAddress: alias.address,
    aliasId: alias.id,
    from: incoming.from,
    subject: incoming.subject,
    receivedAt: incoming.receivedAt,
    expiresAt: computeExpiresAt(incoming.receivedAt, alias.retentionDays),
    status: "inbox",
    rawKey,
    verificationCodes: graph.codeExtraction === "nodes" ? [] : content.codes,
    preview: content.text.replace(/\s+/g, " ").slice(0, 180),
    tags: alias.tags,
    graphRun: {
      revision: graph.revision,
      status: "running",
      steps: [],
      tags: [],
      trial: false,
    },
  });
  await recordAudit(params.store, {
    correlationId,
    eventType: "received",
    messageId: message.id,
    aliasAddress: alias.address,
    sender: incoming.from,
    subjectPreview: incoming.subject,
    status: "inbox",
  });
  let forwardedTo: string | undefined;
  let nativeDeliveryAttempted = false;
  let savedActions = 0;
  async function saveActions(run: GraphRun) {
    const entries = run.actionResults ?? [];
    const pending = entries.slice(savedActions);
    if (!pending.length) return;
    if (!await params.store.getMessage(message.id)) {
      throw new GraphError(
        "邮件已删除，流程停止",
        "errors.messageDeletedWorkflowStopped",
      );
    }
    const retention = pending.findLast((a) =>
      a.type === "set_retention" ||
      a.type === "keep" && typeof a.value === "number"
    );
    const disposition = pending.some((a) =>
      ["keep", "trash", "forward", "reply"].includes(a.type)
    );
    if (retention || disposition) {
      await params.store.updateMessage(message.id, {
        ...(retention
          ? {
            expiresAt: computeExpiresAt(
              incoming.receivedAt,
              retention.value as number,
            ),
          }
          : {}),
        ...(disposition
          ? {
            status: messageStatusForAction(
              run.action ?? "keep",
              !!run.forwardTo,
            ),
          }
          : {}),
        ...(run.forwardTo ? { forwardedTo: run.forwardTo } : {}),
      });
    }
    const tags = pending.filter((a) => a.type === "tag").flatMap((a) =>
      a.value as string[]
    );
    if (
      tags.length && !await params.store.appendMessageTags(message.id, tags)
    ) {
      throw new GraphError(
        "邮件已删除，流程停止",
        "errors.messageDeletedWorkflowStopped",
      );
    }
    savedActions = entries.length;
  }
  await params.notify?.();
  const run = await runGraph(
    graph,
    graphEmail(content, incoming.from, alias.address),
    {
      ai: graphAi(params.config, params.store, params.analysisFetch),
      aiEnabled: !!params.config.ai?.enabled && !!params.config.ai.gateway,
      aiTimeoutMs: (params.config.ai?.timeoutSeconds ?? 25) * 1000,
      provider: params.config.ai?.provider,
      reply: async (text) => {
        nativeDeliveryAttempted = true;
        await replyToIncoming(params.message, text);
        await recordAudit(params.store, {
          correlationId,
          eventType: "replied",
          messageId: message.id,
          aliasAddress: alias.address,
          sender: incoming.from,
          subjectPreview: incoming.subject,
        });
      },
      reject: (reason) => params.message.setReject(reason),
      forward: async (destination) => {
        nativeDeliveryAttempted = true;
        await params.message.forward(destination);
        forwardedTo = destination;
        await recordAudit(params.store, {
          correlationId,
          eventType: "forwarded",
          messageId: message.id,
          aliasAddress: alias.address,
          sender: incoming.from,
          subjectPreview: incoming.subject,
          status: "forwarded",
          metadata: { forwardedTo: destination },
        });
      },
      checkpoint: async (graphRun, beforeEffect) => {
        await saveActions(graphRun);
        const lastId = graphRun.steps.at(-1)?.nodeId;
        const lastKind = graph.nodes.find((node) => node.id === lastId)?.kind;
        // Persist expensive steps and the final decision, keeping D1 writes bounded.
        if (
          lastKind === "ai" || lastKind === "action" ||
          graphRun.status === "complete" || beforeEffect
        ) {
          if (!await params.store.saveGraphRun(message.id, graphRun)) {
            throw new GraphError(
              "邮件已删除，流程停止",
              "errors.messageDeletedWorkflowStopped",
            );
          }
          await params.notify?.();
        }
      },
    },
  );
  await recordAudit(params.store, {
    correlationId,
    eventType: workflowEventType(run),
    messageId: message.id,
    aliasAddress: alias.address,
    sender: incoming.from,
    subjectPreview: incoming.subject,
    reason: run.error,
    metadata: { workflow: workflowAuditMetadata(graph, run) },
  });
  const acceptedResult = (): EmailProcessingResult => ({
    action: run.action ?? "keep",
    alias,
    messageId: message.id,
    forwardedTo,
    rejected: false,
  });
  const reportNativePersistenceFailure = () =>
    console.error(JSON.stringify({
      event: "workflow_persistence_failed_after_native_delivery",
      messageId: message.id,
      correlationId,
      action: run.action ?? "keep",
    }));
  try {
    await saveActions(run);
  } catch (error) {
    if (!nativeDeliveryAttempted) throw error;
    reportNativePersistenceFailure();
    return acceptedResult();
  }
  if (run.action === "block") {
    await recordAudit(params.store, {
      correlationId,
      eventType: "blocked_by_rule",
      messageId: message.id,
      aliasAddress: alias.address,
      sender: incoming.from,
      subjectPreview: incoming.subject,
      reason: String(
        run.actionResults?.findLast((a) => a.type === "deny")?.value ??
          "Blocked by rule",
      ),
    });
    await params.store.deleteMessages([message.id]);
    await params.blobStore.deleteMany([rawKey]);
    return { action: "block", alias, rejected: true };
  }
  let saved;
  try {
    saved = await params.store.updateMessage(message.id, {
      graphRun: run,
      verificationCodes: run.codes,
      ...(run.analysis ? { analysis: run.analysis } : {}),
    });
  } catch (error) {
    if (!nativeDeliveryAttempted) throw error;
    reportNativePersistenceFailure();
    return acceptedResult();
  }
  if (
    saved && run.status === "failed" && !run.action &&
    !nativeDeliveryAttempted
  ) {
    throw new GraphError(
      "邮件流程在接受前失败，请稍后重试",
      "errors.workflowFailedBeforeAcceptance",
    );
  }
  return acceptedResult();
}
