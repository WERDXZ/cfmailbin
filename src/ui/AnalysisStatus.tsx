import { mailCategories } from "../domain/analysis.ts";
import type { MessageRecord } from "./types.ts";

export function AnalysisBadge({ message }: { message: MessageRecord }) {
  const analysis = message.analysis;
  if (!analysis) return null;
  const label = ["pending", "running"].includes(analysis.status)
    ? Date.now() - Date.parse(message.createdAt) > 60_000
      ? "识别未完成"
      : "识别中…"
    : analysis.status === "failed"
    ? "识别未完成"
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
      title={`AI 补充识别 · ${analysis.model}；识别结果仅供参考，不改变收件规则。`}
    >
      {label}
    </small>
  );
}
