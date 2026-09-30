import { analysisFailureLabels, mailCategories } from "../domain/analysis.ts";
import type { MessageRecord } from "./types.ts";

export function AnalysisBadge({ message }: { message: MessageRecord }) {
  const analysis = message.analysis;
  if (!analysis) return null;
  const failureLabel = analysis.reason && analysis.reason !== "daily_limit"
    ? analysisFailureLabels[analysis.reason] ??
      analysisFailureLabels.unavailable
    : analysisFailureLabels.unavailable;
  const label = ["pending", "running"].includes(analysis.status)
    ? Date.now() - Date.parse(message.createdAt) > 60_000
      ? "识别未完成"
      : "识别中…"
    : analysis.status === "failed"
    ? failureLabel
    : analysis.status === "skipped"
    ? "今日识别额度已用完"
    : analysis.category && !["other", "unknown"].includes(analysis.category)
    ? mailCategories[analysis.category]
    : analysis.codeStatus === "not_found"
    ? "未识别到验证码"
    : "未确定";
  return (
    <small
      class="status-badge"
      title={analysis.status === "failed"
        ? `${failureLabel}${
          analysis.httpStatus ? ` · HTTP ${analysis.httpStatus}` : ""
        } · ${analysis.model}。邮件已保存；刷新页面不会重新识别。`
        : `AI 补充识别 · ${analysis.model}；识别结果仅供参考，不改变收件规则。`}
    >
      {label}
    </small>
  );
}
