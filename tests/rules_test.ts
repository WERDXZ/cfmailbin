import { assertEquals, assertThrows } from "@std/assert";
import {
  evaluateCondition,
  makeRule,
  resolveMessageAction,
} from "../src/domain/rules.ts";
import { parseRuleInput } from "../src/domain/rule-validation.ts";
import type {
  Alias,
  IncomingMessage,
  RuleCondition,
} from "../src/domain/models.ts";

const alias: Alias = {
  id: "a",
  address: "github-personal@example.com",
  defaultAction: "keep",
  enabled: true,
  retentionDays: 7,
  tags: [],
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};
const message: IncomingMessage = {
  alias: alias.address,
  from: "security@github.com",
  subject: "Your sign-in code",
  receivedAt: "2026-09-29",
  body: "Your code is 001234",
  hasCode: true,
  contentComplete: true,
};
const subject: RuleCondition = {
  field: "subject",
  operator: "contains",
  value: "sign-in",
};

Deno.test("rules combine nested all/any/not and exact sender domains", () => {
  const condition: RuleCondition = {
    all: [
      { field: "alias", operator: "glob", value: "github*@example.com" },
      { any: [{ field: "hasCode", value: true }, subject] },
      {
        not: { field: "fromDomain", operator: "equals", value: "bad.example" },
      },
    ],
  };
  assertEquals(evaluateCondition(condition, message).result, true);
  assertEquals(
    evaluateCondition({
      field: "fromDomain",
      operator: "equals",
      value: "github.com",
    }, { ...message, from: "spoof@github.com.evil.example" }).result,
    false,
  );
});

Deno.test("glob matching treats regex syntax literally and handles long repeated stars", () => {
  const match = (value: string, text: string) =>
    evaluateCondition({ field: "subject", operator: "glob", value }, {
      ...message,
      subject: text,
    }).result;
  assertEquals(match("a.[b]?*", "a.[b]Xtail"), true);
  assertEquals(match("a.[b]?*", "azbXtail"), false);
  assertEquals(match("*a".repeat(100) + "z", "a".repeat(50000)), false);
  assertEquals(match("SIGN*", "sign in"), true);
});

Deno.test("unavailable or truncated body cannot satisfy a negated condition", () => {
  const condition: RuleCondition = {
    not: { field: "body", operator: "contains", value: "verify" },
  };
  assertEquals(
    evaluateCondition(condition, {
      ...message,
      body: undefined,
      contentComplete: false,
    }).result,
    null,
  );
  assertEquals(
    evaluateCondition(condition, {
      ...message,
      body: "partial",
      contentComplete: false,
    }).result,
    null,
  );
  assertEquals(
    evaluateCondition(condition, {
      ...message,
      body: "verify now",
      contentComplete: false,
    }).result,
    false,
  );
  assertEquals(
    evaluateCondition({ not: { field: "hasCode", value: true } }, {
      ...message,
      hasCode: undefined,
    }).result,
    null,
  );
  assertEquals(
    evaluateCondition({ any: [subject, condition] }, {
      ...message,
      body: undefined,
    }).result,
    true,
  );
});

Deno.test("ordered effects accumulate tags, override delivery/retention, and obey stop", () => {
  const first = makeRule({
    name: "label",
    condition: subject,
    actions: { tags: ["login"], retentionDays: 1 },
    stopProcessing: false,
  }, 10);
  const second = makeRule({
    name: "forward",
    condition: subject,
    actions: {
      delivery: "forward",
      forwardTo: "owner@example.com",
      tags: ["login", "account"],
      retentionDays: 30,
    },
    stopProcessing: true,
  }, 20);
  const third = makeRule({
    name: "trash",
    condition: subject,
    actions: { delivery: "trash" },
  }, 30);
  const decision = resolveMessageAction(alias, [third, second, first], message);
  assertEquals(decision.action, "forward");
  assertEquals(decision.forwardTo, "owner@example.com");
  assertEquals(decision.retentionDays, 30);
  assertEquals(decision.tags, ["login", "account"]);
  assertEquals(decision.trace.map((t) => t.name), ["label", "forward"]);
  assertEquals(decision.matchedRuleId, second.id);
});

Deno.test("reject is terminal and unknown/disabled/scoped-out rules do not execute", () => {
  const unknown = makeRule({
    condition: { not: { field: "hasCode", value: true } },
    actions: { delivery: "block" },
  }, 0);
  const disabled = makeRule({
    enabled: false,
    condition: subject,
    actions: { delivery: "trash" },
  }, 1);
  const scoped = makeRule({
    aliasId: "other",
    condition: subject,
    actions: { delivery: "trash" },
  }, 2);
  assertEquals(
    resolveMessageAction(alias, [unknown, disabled, scoped], {
      ...message,
      hasCode: undefined,
    }).action,
    "keep",
  );
  const block = makeRule({
    condition: subject,
    actions: { delivery: "block" },
    stopProcessing: false,
  }, 5);
  const keep = makeRule(
    { condition: subject, actions: { delivery: "keep" } },
    6,
  );
  assertEquals(
    resolveMessageAction(alias, [block, keep], message).action,
    "block",
  );
});

Deno.test("legacy rules still perform case-insensitive contains and stop at first match", () => {
  const rule = makeRule({
    field: "subject",
    pattern: "SIGN-IN",
    action: "trash",
  }, 10);
  assertEquals(resolveMessageAction(alias, [rule], message).action, "trash");
  assertEquals(rule.stopProcessing, true);
});

Deno.test("rule boundary rejects empty, oversized, malformed conditions and effects", () => {
  for (
    const condition of [
      { all: [] },
      { any: [] },
      { field: "oops", operator: "contains", value: "x" },
      { field: "subject", operator: "regex", value: ".*" },
      { field: "hasCode", value: "true" },
      { field: "body", operator: "contains", value: "" },
      { all: [subject], any: [subject] },
      { all: Array(33).fill(subject) },
    ]
  ) {
    assertThrows(() =>
      parseRuleInput({ condition, actions: { delivery: "keep" } })
    );
  }
  for (
    const actions of [
      {},
      { retentionDays: 0 },
      { retentionDays: 1.5 },
      { retentionDays: 366 },
      { delivery: "forward", forwardTo: "bad\naddress" },
      { delivery: "keep", forwardTo: "a@example.com" },
      { tags: ["x".repeat(65)] },
      { arbitrary: true },
    ]
  ) {
    assertThrows(() => parseRuleInput({ condition: subject, actions }));
  }
  assertThrows(() =>
    parseRuleInput({
      condition: { not: { not: { not: { not: subject } } } },
      actions: { delivery: "keep" },
    })
  );
  assertEquals(
    parseRuleInput({
      condition: subject,
      actions: { tags: [" Login ", "login"] },
      stopProcessing: false,
    }).actions?.tags,
    ["login"],
  );
});

Deno.test("all built-in templates validate and marketing excludes account mail", async () => {
  const { ruleTemplates } = await import("../src/domain/rule-templates.ts");
  const templates = ruleTemplates("example.com");
  for (const template of templates) parseRuleInput(template.rule);
  const newsletter = makeRule(
    templates.find((t) => t.id === "newsletters")!.rule,
    10,
  );
  assertEquals(
    resolveMessageAction(alias, [newsletter], {
      ...message,
      subject: "Newsletter",
      body: "Your code is 001234. Unsubscribe here",
      hasCode: true,
    }).action,
    "keep",
  );
  assertEquals(
    resolveMessageAction(alias, [newsletter], {
      ...message,
      subject: "Reset password",
      body: "Unsubscribe here",
      hasCode: false,
    }).action,
    "keep",
  );
  assertEquals(
    resolveMessageAction(alias, [newsletter], {
      ...message,
      subject: "Newsletter",
      body: "Unsubscribe here",
      hasCode: false,
    }).action,
    "trash",
  );
  assertEquals(
    resolveMessageAction(alias, [newsletter], {
      ...message,
      subject: "Newsletter",
      body: undefined,
      hasCode: undefined,
      contentComplete: false,
    }).action,
    "keep",
  );
});

Deno.test("newsletter template preserves account security alerts with unsubscribe footers", async () => {
  const { ruleTemplates } = await import("../src/domain/rule-templates.ts");
  const rule = makeRule(
    ruleTemplates().find((t) => t.id === "newsletters")!.rule,
    10,
  );
  assertEquals(
    resolveMessageAction(alias, [rule], {
      ...message,
      subject: "Security alert: new login",
      hasCode: false,
      body: "Unsubscribe from future alerts",
    }).action,
    "keep",
  );
});
