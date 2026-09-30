export type AnalysisProvider = "deepseek" | "openai";

export const mailCategories = {
  verification: "验证码",
  account: "账号操作",
  security: "安全提醒",
  marketing: "营销",
  other: "其他",
  unknown: "未确定",
} as const;

export type MailCategory = keyof typeof mailCategories;

export interface MessageAnalysis {
  provider: AnalysisProvider;
  model: string;
  status: "pending" | "running" | "complete" | "failed" | "skipped";
  category?: MailCategory;
  codeStatus?: "found" | "not_found" | "unknown";
  reason?: "daily_limit" | "unavailable";
}

export const analysisModels: Record<AnalysisProvider, string> = {
  deepseek: "deepseek-flash",
  openai: "gpt-5.6-luna",
};
