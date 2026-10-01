import { graphTemplate } from "../graph/templates.ts";
import type {
  GraphNode,
  NodePreset,
  PolicyDefinition,
  PolicyExpression,
} from "../graph/types.ts";
import type { TranslationKey, Translator } from "./translate.ts";
const presetKeys: Readonly<Record<string, TranslationKey>> = {
  "builtin_reply": "common.replyWithAcknowledgment",
  "builtin_forward": "common.forwardOriginalEmail",
  "builtin_trash": "common.moveToTrash",
  "builtin_deny": "common.reject",
  "builtin_retain_day": "common.tagAndKeepForOneDay",
  "builtin_local_codes": "common.extractVerificationCodesLocally",
  "builtin_policy_checks": "common.trustedDomainWithAWarning",
  "builtin_if": "common.branchOnPolicySuccess",
  "builtin_match": "common.matchPolicyStatus",
  "builtin_verification_keywords": "common.verificationKeywords",
  "builtin_ai_codes": "common.extractVerificationCodesWithAi",
  "builtin_ai_summary": "common.aiSummary",
  "builtin_keep": "graph.keep",
  "builtin_finish_keep": "common.keepAndFinish",
  "builtin_finish_forward": "common.forwardAndFinish",
  "builtin_finish_deny": "common.rejectAndFinish",
};
const policyKeys: Readonly<Record<string, TranslationKey>> = {
  "builtin_from_trusted_domain": "templates.trustedDomain",
  "builtin_contain_warning": "templates.containsWarning",
  "builtin_code_subject": "templates.subjectCodeHint",
  "builtin_code_prefix": "templates.codeAfterHint",
  "builtin_code_suffix": "templates.codeBeforeHint",
  "builtin_code_standalone": "templates.codeOwnLine",
  "builtin_code_short_prefix": "templates.codeShortHint",
};
const fragmentKeys: Readonly<Record<string, TranslationKey>> = {
  "candidates": "templates.candidates",
  "context": "templates.filterCandidates",
  "result": "templates.writeCodes",
};
// IDs belong to fresh built-in templates only, never saved user nodes.
const workflowKeys: Readonly<Record<string, TranslationKey>> = {
  "start": "common.emailReceived",
  "done": "templates.finishUnaccepted",
  "keep": "graph.keepEmail",
  "enrich": "common.extractVerificationCodesWithAi",
  "needsAi": "templates.needsAi",
  "aiSucceeded": "templates.aiSucceeded",
  "aiCodes": "templates.writeAiCodes",
  "step1": "templates.candidates",
  "step2": "templates.filterCandidates",
  "step3": "templates.writeCodes",
  "classify": "templates.classify",
  "match": "templates.branchCategory",
  "important": "templates.keepCodeDay",
};
export function presetLabel(preset: NodePreset, t: Translator): string {
  const key = Object.hasOwn(presetKeys, preset.id)
    ? presetKeys[preset.id]
    : undefined;
  return key ? t(key) : preset.node.label;
}
export function policyTemplateLabel(
  policy: PolicyDefinition,
  t: Translator,
): string {
  const key = Object.hasOwn(policyKeys, policy.id)
    ? policyKeys[policy.id]
    : undefined;
  return key ? t(key) : policy.name;
}
function localizePolicies(
  expression: PolicyExpression,
  t: Translator,
): PolicyExpression {
  if ("policy" in expression) {
    return {
      policy: {
        ...expression.policy,
        name: policyTemplateLabel(expression.policy, t),
      },
    };
  }
  if ("all" in expression) {
    return { all: expression.all.map((e) => localizePolicies(e, t)) };
  }
  if ("any" in expression) {
    return { any: expression.any.map((e) => localizePolicies(e, t)) };
  }
  return { not: localizePolicies(expression.not, t) };
}
function localizeNode(node: GraphNode, t: Translator): void {
  if (
    node.kind === "evaluate" || node.kind === "filter" ||
    node.kind === "policies"
  ) node.policies = localizePolicies(node.policies, t);
  if (node.kind === "match") {
    node.cases = node.cases.map((c) => ({
      ...c,
      label: c.id === "success"
        ? t("graph.passed")
        : c.id === "verification"
        ? t("message.verificationCode")
        : c.label,
    }));
  }
}
/** Translate built-in display names once when creating a draft. Prompts and values stay literal. */
export function localizedPreset(preset: NodePreset, t: Translator): NodePreset {
  const copy = structuredClone(preset);
  if (!Object.hasOwn(presetKeys, preset.id)) return copy;
  copy.node.label = presetLabel(preset, t);
  localizeNode(copy.node, t);
  for (const node of copy.fragment?.nodes ?? []) {
    const key = fragmentKeys[node.id];
    if (key) node.label = t(key);
    localizeNode(node, t);
  }
  return copy;
}
export function localizedGraphTemplate(
  kind: Parameters<typeof graphTemplate>[0],
  t: Translator,
) {
  const graph = graphTemplate(kind);
  for (const node of graph.nodes) {
    const key = workflowKeys[node.id];
    if (key) node.label = t(key);
    localizeNode(node, t);
  }
  return graph;
}
