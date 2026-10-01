import {
  analysisFailureCodes,
  analysisFailureLabels,
} from "../domain/analysis.ts";
import { AnalysisError } from "../email/analysis.ts";
import type { AiTask, GraphRuntime } from "./run.ts";
import { validateOutput } from "./schema.ts";
import { GraphAiLimitError, GraphError, type JsonValue } from "./types.ts";

/** Only model execution errors become values. Storage and action failures stay fatal. */
export async function aiResults(
  tasks: AiTask[],
  runtime: GraphRuntime,
  timeoutMs: number,
) {
  let reason: string, message: string, code: string, skipped = false;
  let errorParams: { httpStatus: number } | undefined;
  if (runtime.aiEnabled === false) {
    reason = "disabled";
    message = "AI 未启用或网关未配置";
    code = "common.aiIsDisabledOrTheGatewayIs";
    skipped = true;
  } else {
    try {
      if (timeoutMs <= 0) throw new AnalysisError("timeout");
      const data = await runtime.ai(tasks, timeoutMs);
      // Validate the entire batch before publishing any result.
      try {
        for (const task of tasks) {
          validateOutput(data[task.node.id], task.node.schema);
        }
      } catch {
        throw new AnalysisError("invalid_response");
      }
      return tasks.map(({ node }) => ({
        nodeId: node.id,
        status: "complete" as const,
        output: {
          success: true,
          data: data[node.id],
          error: null,
        } as JsonValue,
        error: undefined,
      }));
    } catch (error) {
      skipped = error instanceof GraphAiLimitError;
      reason = skipped
        ? "daily_limit"
        : error instanceof AnalysisError
        ? error.reason
        : error instanceof GraphError
        ? "invalid_request"
        : "unavailable";
      message = skipped
        ? "已达每日 AI 调用额度"
        : error instanceof AnalysisError
        ? `${analysisFailureLabels[error.reason]}${
          error.httpStatus ? ` · HTTP ${error.httpStatus}` : ""
        }`
        : error instanceof GraphError
        ? "AI 输入配置无效"
        : "AI 调用失败";
      code = skipped
        ? "common.dailyAiCallLimitReached"
        : error instanceof AnalysisError
        ? analysisFailureCodes[error.reason]
        : error instanceof GraphError
        ? "errors.invalidAiInputConfiguration"
        : "common.aiCallFailed";
      errorParams = error instanceof AnalysisError && error.httpStatus
        ? { httpStatus: error.httpStatus }
        : undefined;
    }
  }
  return tasks.map(({ node }) => ({
    nodeId: node.id,
    status: skipped ? "skipped" as const : "failed" as const,
    output: {
      success: false,
      data: null,
      error: { reason, message },
    } as JsonValue,
    error: message,
    errorCode: code,
    ...(errorParams ? { errorParams } : {}),
  }));
}
