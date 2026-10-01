import type { CreateRuleInput, RulePreview } from "../domain/models.ts";
import {
  evaluateCondition,
  makeRule,
  resolveMessageAction,
  ruleCondition,
} from "../domain/rules.ts";
import { findVerificationCodes, readMessageContent } from "../email/content.ts";
import { withContent } from "../email/rule-context.ts";
import type { AppStore, BlobStore } from "../storage/types.ts";

export async function previewRule(
  store: AppStore,
  blobs: BlobStore,
  input: CreateRuleInput,
  ruleId?: string,
  defaultForwardTo?: string,
): Promise<RulePreview> {
  const rules = await store.listRules();
  const existing = rules.find((rule) => rule.id === ruleId);
  const draft = makeRule(
    { ...input, enabled: true },
    existing?.priority ??
      Math.max(0, ...rules.map((r) => r.priority ?? 0)) + 10,
  );
  if (existing) {
    draft.id = existing.id;
    draft.createdAt = existing.createdAt;
  }
  const trialRules = [...rules.filter((rule) => rule.id !== draft.id), draft];
  const messages = await store.listMessages({
    aliasId: draft.aliasId ?? undefined,
    limit: 20,
  });
  const result: RulePreview = { examined: 0, matched: 0, rows: [] };
  for (const message of messages) {
    const alias = await store.findAliasById(message.aliasId);
    if (!alias) continue;
    const blob = message.rawKey ? await blobs.get(message.rawKey) : null;
    const content = blob ? await readMessageContent(blob.body) : undefined;
    if (content && message.verificationCodes === undefined) {
      content.codes = findVerificationCodes(content.text, content.subject);
    }
    const incoming = withContent({
      alias: message.aliasAddress,
      from: message.from,
      subject: message.subject,
      receivedAt: message.receivedAt,
      hasCode: message.verificationCodes?.length ? true : undefined,
    }, content);
    if (message.verificationCodes !== undefined) {
      incoming.hasCode = message.verificationCodes.length > 0;
    }
    const decision = resolveMessageAction(alias, trialRules, incoming);
    if (decision.action === "forward") decision.forwardTo ??= defaultForwardTo;
    const draftCondition = evaluateCondition(ruleCondition(draft), incoming);
    const draftReached = decision.trace.some((trace) =>
      trace.ruleId === draft.id
    );
    result.examined++;
    if (draftReached && draftCondition.result === true) result.matched++;
    result.rows.push({
      messageId: message.id,
      subject: message.subject,
      aliasAddress: message.aliasAddress,
      receivedAt: message.receivedAt,
      draftResult: draftCondition.result,
      draftReached,
      draftCondition,
      decision,
    });
  }
  return result;
}
