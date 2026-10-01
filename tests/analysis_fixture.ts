import {
  analysisModels,
  type MessageAnalysis,
} from "../src/domain/analysis.ts";
import type { MessageContent } from "../src/domain/models.ts";
import {
  type AnalysisConfig,
  type AnalysisFetch,
  requestStructured,
  validateVerificationResult,
  verificationInstructions,
  verificationSchema,
} from "../src/email/analysis.ts";

export const gatewayEnv = {
  CFMAILBIN_AI_GATEWAY_ACCOUNT_ID: "a".repeat(32),
  CFMAILBIN_AI_GATEWAY_ID: "cfmailbin",
  CF_AIG_TOKEN: "test-gateway-token-never-public",
};

export const gateway = {
  accountId: gatewayEnv.CFMAILBIN_AI_GATEWAY_ACCOUNT_ID,
  id: gatewayEnv.CFMAILBIN_AI_GATEWAY_ID,
  token: gatewayEnv.CF_AIG_TOKEN,
};

export const gatewayBase =
  `https://gateway.ai.cloudflare.com/v1/${gateway.accountId}/${gateway.id}`;

/** Exercise the production transport and source validation with the verification preset. */
export async function analyzeEmail(
  config: AnalysisConfig,
  content: MessageContent,
  fetcher: AnalysisFetch = fetch,
  timeoutMs = 25_000,
): Promise<{ codes: string[]; analysis: MessageAnalysis }> {
  const subject = content.subject.slice(0, 500);
  const text = content.text.slice(0, 12000);
  const truncated = content.truncated ||
    subject.length < content.subject.length ||
    text.length < content.text.length;
  const { result, durationMs } = await requestStructured(
    config,
    {
      prompt: verificationInstructions,
      input: JSON.stringify({ subject, text, truncated }),
      schema: verificationSchema,
      maxTokens: 512,
    },
    (value) =>
      validateVerificationResult(value, `${subject}\n${text}`, truncated),
    fetcher,
    timeoutMs,
  );
  return {
    codes: result.codes,
    analysis: {
      provider: config.provider,
      model: analysisModels[config.provider],
      status: "complete",
      category: result.category,
      codeStatus: result.codeStatus,
      durationMs,
    },
  };
}
