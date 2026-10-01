import type { GraphCondition, PolicyDefinition } from "./types.ts";

const english = [
  "verification",
  "security",
  "confirmation",
  "authentication",
  "login",
  "sign in",
  "signin",
  "access",
  "reset",
  "launch",
  "email",
  "account",
];
const chinese = ["验证码", "校验码", "动态码", "安全码", "一次性密码"];
const markers = [
  ...chinese,
  ...english.flatMap((word) =>
    ["code", "pin"].flatMap((noun) =>
      [" ", "-", ""].map((separator) => `${word}${separator}${noun}`)
    )
  ),
  "one time password",
  "one-time password",
  "one time code",
  "one-time code",
  "otp",
  "passcode",
];
const normalized = [
  ...new Set(markers.map((word) => word.replaceAll("-", " "))),
];
const suffixes = normalized.flatMap((
  word,
) => [
  word,
  `${word} is`,
  `${word}为`,
  `${word}是`,
  ...(chinese.includes(word) ? [`${word} 为`, `${word} 是`] : []),
]);

const policy = (
  id: string,
  name: string,
  condition: GraphCondition,
): PolicyDefinition => ({
  version: 2,
  id: `builtin_${id}`,
  revision: "3",
  name,
  condition,
});

export const codePolicies = {
  subject: policy("code_subject", "subject_has_code_hint", {
    path: "email.subject",
    operator: "containsAny",
    value: markers,
  }),
  before: policy("code_prefix", "code_follows_hint", {
    path: "item.before",
    operator: "endsWithAny",
    value: suffixes,
  }),
  after: policy("code_suffix", "code_precedes_hint", {
    path: "item.after",
    operator: "startsWithAny",
    value: normalized.flatMap((
      word,
    ) => [`is your ${word}`, `is the ${word}`, `is ${word}`]),
  }),
  standalone: policy("code_standalone", "code_on_own_line", {
    path: "item.standalone",
    operator: "equals",
    value: true,
  }),
  short: policy("code_short_prefix", "code_follows_short_hint", {
    path: "item.before",
    operator: "endsWithAny",
    value: ["code", "code is", "code为", "code是"],
  }),
};
