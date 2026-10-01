import type { TranslationKey } from "./translate.ts";

export const mailActionKeys = {
  "tag": "common.addTags",
  "set_retention": "common.setRetention",
  "keep": "graph.keep",
  "trash": "graph.moveToTrash",
  "forward": "common.forwardOriginal",
  "reply": "common.replyToSender",
  "deny": "common.rejectAndFinish",
} as const satisfies Record<string, TranslationKey>;

export const deliveryActionKeys = {
  "keep": "graph.keep",
  "forward": "common.forwardAndKeep",
  "trash": "graph.moveToTrash",
  "block": "common.reject",
} as const satisfies Record<string, TranslationKey>;

export const auditEventKeys = {
  "received": "common.emailReceived",
  "auto_alias_created": "common.addressRegisteredAutomatically",
  "rejected_unknown": "common.rejectedUnregisteredAddress",
  "rejected_disabled": "common.rejectedDisabledAddress",
  "blocked_by_rule": "common.rejectedByWorkflow",
  "forwarded": "inbox.forwarded",
  "replied": "common.replied",
  "expired_deleted": "common.expiredMailDeleted",
  "manual_deleted": "common.deletedManually",
  "workflow_completed": "common.workflowCompleted",
  "workflow_failed": "common.workflowFailed",
  "workflow_degraded": "common.workflowCompletedWithNodeErrors",
  "workflow_trial": "common.workflowTrial",
  "configuration_changed": "common.configurationChanged",
  "message_updated": "common.emailUpdated",
} as const satisfies Record<string, TranslationKey>;

export const analysisFailureKeys = {
  "authentication": "common.aiAuthenticationFailed",
  "billing": "common.insufficientAiCredit",
  "rate_limit": "common.aiRateLimitReached",
  "timeout": "common.aiRequestTimedOut",
  "invalid_request": "common.aiRequestRejected",
  "service_error": "common.aiServiceError",
  "network_error": "common.aiConnectionFailed",
  "invalid_response": "errors.invalidAiResponse",
  "storage_error": "errors.failedToSaveAnalysis",
  "unavailable": "common.analysisFailedReasonNotRecorded",
} as const satisfies Record<string, TranslationKey>;

export const mailCategoryKeys = {
  "verification": "message.verificationCode",
  "account": "common.accountActivity",
  "security": "common.securityAlert",
  "marketing": "common.marketing",
  "other": "common.other",
  "unknown": "analysis.unknown",
} as const satisfies Record<string, TranslationKey>;
