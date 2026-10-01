import type { AuditEvent, AuditEventType, AuditFilters } from "./models.ts";
import type { ErrorParams } from "./errors.ts";

export const auditEventLabels: Record<AuditEventType, string> = {
  received: "收到邮件",
  auto_alias_created: "自动登记地址",
  rejected_unknown: "拒收：地址未登记",
  rejected_disabled: "拒收：地址已停用",
  blocked_by_rule: "流程拒收",
  forwarded: "已转发",
  replied: "已回复",
  expired_deleted: "到期清理",
  manual_deleted: "手动删除",
  workflow_completed: "流程完成",
  workflow_failed: "流程失败",
  workflow_degraded: "流程完成 · 有节点异常",
  workflow_trial: "流程试运行",
  configuration_changed: "配置变更",
  message_updated: "邮件修改",
};
export class AuditQueryError extends Error {
  readonly status = 400;

  constructor(
    message: string,
    readonly code?: string,
    readonly params?: ErrorParams,
  ) {
    super(message);
  }
}
export function parseAuditQuery(
  params: URLSearchParams,
): { limit: number; filters: AuditFilters } {
  const limit = Number(params.get("limit") ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new AuditQueryError(
      "每页需要 1–100 条记录",
      "errors.auditPageSizeRange",
      { min: 1, max: 100 },
    );
  }
  const filters: AuditFilters = {};
  const type = params.get("type");
  if (type) {
    if (!Object.hasOwn(auditEventLabels, type)) {
      throw new AuditQueryError("审计类型无效", "errors.invalidAuditType");
    }
    filters.eventType = type as AuditEventType;
  }
  for (const key of ["q", "messageId", "correlationId"] as const) {
    const value = params.get(key)?.trim();
    if (value) {
      if (value.length > (key === "q" ? 200 : 80)) {
        throw new AuditQueryError(
          "筛选条件过长",
          "errors.auditFilterTooLong",
          { field: key, max: key === "q" ? 200 : 80 },
        );
      }
      filters[key] = value;
    }
  }
  for (const key of ["since", "until"] as const) {
    const value = params.get(key);
    if (value) {
      if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
        !Number.isFinite(Date.parse(value))
      ) {
        throw new AuditQueryError(
          "请提供有效的 UTC 时间",
          "errors.invalidUtcTime",
          { field: key },
        );
      }
      filters[key] = new Date(value).toISOString();
    }
  }
  if (filters.since && filters.until && filters.since > filters.until) {
    throw new AuditQueryError(
      "开始时间不能晚于结束时间",
      "errors.invalidAuditTimeRange",
    );
  }
  const cursor = params.get("cursor");
  if (cursor) {
    try {
      if (cursor.length > 512) throw new Error();
      const [createdAt, id, ...extra] = JSON.parse(atob(cursor));
      if (
        extra.length || typeof createdAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt) ||
        !Number.isFinite(Date.parse(createdAt)) || typeof id !== "string" ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(id)
      ) throw new Error();
      filters.before = { createdAt, id };
    } catch {
      throw new AuditQueryError(
        "分页位置无效，请刷新记录",
        "errors.invalidAuditCursor",
      );
    }
  }
  return { limit, filters };
}
export function auditCursor(event: AuditEvent): string {
  return btoa(JSON.stringify([event.createdAt, event.id]));
}
