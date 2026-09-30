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

export const analysisFailureLabels = {
  authentication: "AI 认证失败",
  billing: "AI 额度不足",
  rate_limit: "AI 请求被限流",
  timeout: "AI 识别超时",
  invalid_request: "AI 请求被拒绝",
  service_error: "AI 服务异常",
  network_error: "AI 连接失败",
  invalid_response: "AI 返回结果无效",
  storage_error: "识别结果保存失败",
  unavailable: "识别失败（原因未记录）",
} as const;

export type AnalysisFailureReason = keyof typeof analysisFailureLabels;

export interface MessageAnalysis {
  provider: AnalysisProvider;
  model: string;
  status: "pending" | "running" | "complete" | "failed" | "skipped";
  category?: MailCategory;
  codeStatus?: "found" | "not_found" | "unknown";
  reason?: "daily_limit" | AnalysisFailureReason;
  httpStatus?: number;
}

export const analysisModels: Record<AnalysisProvider, string> = {
  deepseek: "deepseek-flash",
  openai: "gpt-5.6-luna",
};
