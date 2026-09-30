import type { CfMailBinConfig } from "../config.ts";
import { analysisModels, type MessageAnalysis } from "../domain/analysis.ts";
import type { MessageContent } from "../domain/models.ts";
import {
  AnalysisError,
  type AnalysisFetch,
  analyzeEmail,
} from "../email/analysis.ts";
import type { AppStore } from "../storage/types.ts";

export function pendingAnalysis(
  config: CfMailBinConfig,
  content: MessageContent,
): MessageAnalysis | undefined {
  const ai = config.ai;
  if (
    !ai?.enabled || !ai.gateway || content.warning || content.codes.length ||
    !(content.subject || content.text)
  ) return;
  return {
    provider: ai.provider,
    model: analysisModels[ai.provider],
    status: "pending",
  };
}

/** Enrich only stored metadata; never replay intake rules, forward, or reject. */
export async function enrichMessage(params: {
  id: string;
  content: MessageContent;
  config: CfMailBinConfig;
  store: AppStore;
  fetcher?: AnalysisFetch;
}) {
  const ai = params.config.ai;
  if (!ai?.enabled || !ai.gateway) return;
  const base = { provider: ai.provider, model: analysisModels[ai.provider] };
  try {
    if (!await params.store.claimMessageAnalysis(params.id)) return;
    if (
      !await params.store.reserveAnalysisCall(
        new Date().toISOString().slice(0, 10),
        ai.dailyLimit,
      )
    ) {
      await params.store.updateMessage(params.id, {
        analysis: { ...base, status: "skipped", reason: "daily_limit" },
      });
      return;
    }
    const result = await analyzeEmail(
      { provider: ai.provider, apiKey: ai.apiKey, gateway: ai.gateway },
      params.content,
      params.fetcher,
    );
    await params.store.updateMessage(params.id, {
      analysis: result.analysis,
      verificationCodes: result.codes,
    });
  } catch (error) {
    // Never log upstream bodies, email text, credentials or extracted codes.
    const failure = error instanceof AnalysisError
      ? {
        reason: error.reason,
        ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}),
      }
      : { reason: "storage_error" as const };
    console.warn("Email analysis failed", {
      messageId: params.id,
      ...base,
      ...failure,
    });
    await params.store.updateMessage(params.id, {
      analysis: { ...base, status: "failed", ...failure },
    }).catch(() => console.error("Email analysis result could not be saved"));
  }
}
