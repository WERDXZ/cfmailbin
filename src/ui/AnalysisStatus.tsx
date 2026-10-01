import { useI18n } from "./i18n.tsx";
import { analysisFailureKeys, mailCategoryKeys } from "./labels.ts";
import type { MessageRecord } from "./types.ts";

export function AnalysisBadge({ message }: { message: MessageRecord }) {
  const { t } = useI18n();
  const analysis = message.analysis;
  if (!analysis) return null;
  const failureLabel = analysis.reason && analysis.reason !== "daily_limit"
    ? analysisFailureKeys[analysis.reason] ??
      analysisFailureKeys.unavailable
    : analysisFailureKeys.unavailable;
  const label = ["pending", "running"].includes(analysis.status)
    ? Date.now() - Date.parse(message.createdAt) > 60_000
      ? t("analysis.analysisIncomplete")
      : t("analysis.analyzing")
    : analysis.status === "failed"
    ? t(failureLabel)
    : analysis.status === "skipped"
    ? t("analysis.dailyAiLimitReached")
    : analysis.category && !["other", "unknown"].includes(analysis.category)
    ? t(mailCategoryKeys[analysis.category])
    : analysis.codeStatus === "not_found"
    ? t("analysis.noVerificationCodeFound")
    : t("analysis.unknown");
  return (
    <small
      class="status-badge"
      title={analysis.status === "failed"
        ? t("analysis.failureDetails", {
          reason: t(failureLabel),
          httpStatus: analysis.httpStatus
            ? ` · HTTP ${analysis.httpStatus}`
            : "",
          phase: analysis.phase === "request"
            ? t("analysis.waitingForResponse")
            : analysis.phase === "response"
            ? t("analysis.readingResponseBody")
            : "",
          duration: analysis.durationMs !== undefined
            ? t("analysis.seconds", {
              seconds: (analysis.durationMs / 1000).toFixed(1),
            })
            : "",
          model: analysis.model,
        })
        : t("analysis.modelDetails", {
          model: analysis.model,
        })}
    >
      {label}
    </small>
  );
}
