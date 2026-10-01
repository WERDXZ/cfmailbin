import type { CreateAuditEventInput } from "../domain/models.ts";
import type { GraphRun, MailGraph } from "../graph/types.ts";
import type { AppStore } from "../storage/types.ts";

// Observability must not turn a completed native forward or save into a retry.
export async function recordAudit(
  store: AppStore,
  event: CreateAuditEventInput,
) {
  try {
    await store.createAuditEvent(event);
  } catch {
    console.error(JSON.stringify({
      event: "audit_write_failed",
      eventType: event.eventType,
      messageId: event.messageId,
      correlationId: event.correlationId,
    }));
  }
}

// Node outputs can contain entire emails, prompts and verification codes.
// Only retain control-flow metadata here, independently of message retention.
export function workflowAuditMetadata(graph: MailGraph, run: GraphRun) {
  return {
    revision: run.revision,
    status: run.status,
    trial: run.trial,
    action: run.action,
    error: run.error,
    errorCode: run.errorCode,
    errorParams: run.errorParams,
    steps: run.steps.map((step) => {
      const node = graph.nodes.find((node) => node.id === step.nodeId);
      const output = step.output && typeof step.output === "object" &&
          !Array.isArray(step.output)
        ? step.output
        : {};
      // Several ports may share a target. Read the actual decision, not the
      // next node ID, so converging branches aren't attributed to the wrong port.
      let branch: string | undefined;
      if (step.status === "complete") {
        switch (node?.kind) {
          case "condition":
            branch = step.output === null
              ? "unknown"
              : step.output
              ? "yes"
              : "no";
            break;
          case "match":
            branch = typeof output.selected === "string"
              ? `case:${output.selected}`
              : "default";
            break;
          case "policies":
            branch = output.matched ? "success" : "failed";
        }
      }
      return {
        nodeId: step.nodeId,
        label: step.label,
        kind: node?.kind,
        status: step.status,
        durationMs: step.durationMs,
        error: step.error,
        errorCode: step.errorCode,
        errorParams: step.errorParams,
        branch,
        batch: step.batch,
        ...(node?.kind === "ai" && node.resultFormat
          ? {
            success: output.success === true,
            reason: output.error && typeof output.error === "object" &&
                !Array.isArray(output.error)
              ? output.error.reason
              : undefined,
          }
          : {}),
        ...(node?.kind === "evaluate"
          ? {
            success: output.indeterminate === true
              ? null
              : output.success ?? output.matched === true,
            matched: output.matched === true,
            indeterminate: output.indeterminate === true,
          }
          : {}),
        ...(step.status === "skipped" && node?.kind === "ai" &&
            typeof output.reason === "string"
          ? { reason: output.reason }
          : {}),
      };
    }),
    actions: run.actionResults?.map(({ nodeId, type, status }) => ({
      nodeId,
      type,
      status,
    })),
  };
}

export function workflowEventType(run: GraphRun) {
  return run.trial
    ? "workflow_trial" as const
    : run.status === "failed"
    ? "workflow_failed" as const
    : run.steps.some((step) => step.status === "failed")
    ? "workflow_degraded" as const
    : "workflow_completed" as const;
}

export async function auditApiMutation(
  store: AppStore,
  method: string,
  pathname: string,
  response: Response,
  actor: string,
) {
  if (!response.ok || !["PUT", "POST", "PATCH", "DELETE"].includes(method)) {
    return;
  }
  const match = pathname.match(
    /^\/api\/(settings|graph|policies|node-library|aliases|rules|messages)(?:\/([^/]+))?(?:\/(tags))?$/,
  );
  if (!match) return;
  const [, resource, id, field] = match;
  // Previews and migration drafts do not change configuration.
  if (
    (resource === "graph" && ["preview", "migrate"].includes(id)) ||
    (resource === "rules" && id === "preview") ||
    (resource === "messages" && id === "batch-delete")
  ) return;
  const labels: Record<string, string> = {
    settings: "设置",
    graph: "收件流程",
    policies: "Policy",
    "node-library": "节点库",
    aliases: "地址",
    rules: "旧规则",
    messages: "邮件",
  };
  const operation = method === "DELETE"
    ? "删除"
    : method === "POST" && id !== "reorder"
    ? "创建"
    : "更新";
  const payload = await response.clone().json().catch(() => null) as
    | Record<string, unknown>
    | null;
  const saved: Record<string, unknown> = resource === "graph"
    ? (payload?.graph ?? {}) as Record<string, unknown>
    : payload ?? {};
  await recordAudit(store, {
    eventType: resource === "messages"
      ? "message_updated"
      : "configuration_changed",
    actor,
    aliasAddress: resource === "aliases" && typeof saved?.address === "string"
      ? saved.address
      : undefined,
    ...(resource === "messages" ? { messageId: id } : {}),
    reason: `${operation}${labels[resource]}${field === "tags" ? "标签" : ""}`,
    metadata: {
      resource,
      operation: method,
      ...(saved?.id || id ? { resourceId: saved?.id ?? id } : {}),
      ...(field ? { field } : {}),
      ...(typeof saved?.revision === "string"
        ? { revision: saved.revision }
        : {}),
      ...(typeof saved?.enabled === "boolean"
        ? { enabled: saved.enabled }
        : {}),
      ...(resource === "graph" && Array.isArray(saved?.nodes)
        ? { nodeCount: saved.nodes.length }
        : {}),
      ...(resource === "messages" && typeof saved?.status === "string"
        ? { status: saved.status }
        : {}),
      ...(resource === "messages" && Array.isArray(saved?.tags)
        ? { tagCount: saved.tags.length }
        : {}),
    },
  });
}
