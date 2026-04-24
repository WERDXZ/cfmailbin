import type { Alias, IncomingMessage, Rule, RuleDecision } from "./models.ts";
import type { MessageStatus, RuleAction } from "./models.ts";

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeAddress(value: string): string {
  return normalizeText(value);
}

function fieldValue(message: IncomingMessage, field: Rule["field"]): string {
  switch (field) {
    case "alias":
      return message.alias;
    case "from":
      return message.from;
    case "subject":
      return message.subject;
  }
}

export function ruleMatches(
  alias: Alias,
  message: IncomingMessage,
  rule: Rule,
): boolean {
  if (!rule.enabled) {
    return false;
  }

  if (rule.aliasId && rule.aliasId !== alias.id) {
    return false;
  }

  const actual = normalizeText(fieldValue(message, rule.field));
  const expected = normalizeText(rule.pattern);
  return actual.includes(expected);
}

export function resolveMessageAction(
  alias: Alias,
  rules: Rule[],
  message: IncomingMessage,
): RuleDecision {
  const normalizedAlias = normalizeAddress(alias.address);
  const normalizedTarget = normalizeAddress(message.alias);

  if (normalizedAlias !== normalizedTarget) {
    return {
      action: "block",
      matchedRuleId: null,
    };
  }

  const matchedRule = rules.find((rule) => ruleMatches(alias, message, rule));

  if (matchedRule) {
    return {
      action: matchedRule.action,
      matchedRuleId: matchedRule.id,
    };
  }

  return {
    action: alias.defaultAction,
    matchedRuleId: null,
  };
}

export function messageStatusForAction(
  action: RuleAction,
  forwarded: boolean,
): MessageStatus {
  switch (action) {
    case "keep":
      return "inbox";
    case "forward":
      return forwarded ? "forwarded" : "inbox";
    case "trash":
      return "trashed";
    case "block":
      return "blocked";
  }
}
