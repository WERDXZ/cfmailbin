import type { CreateRuleInput, RuleCondition } from "./models.ts";
const contains = (value: string): RuleCondition => ({
  field: "subject",
  operator: "contains",
  value,
});
const accountWords = [
  "reset password",
  "password reset",
  "verify your email",
  "confirm your email",
  "activate",
  "magic link",
  "重置密码",
  "找回",
  "激活",
  "验证邮箱",
];
const alertWords = [
  "new sign-in",
  "new login",
  "security alert",
  "password changed",
  "新登录",
  "安全提醒",
  "密码已更改",
];
export function ruleTemplates(
  domain = "example.com",
): { id: string; name: string; description: string; rule: CreateRuleInput }[] {
  return [
    {
      id: "codes",
      name: "验证码 · 保留 1 天",
      description: "识别到验证码时添加标签，缩短保留时间，并继续执行后续规则。",
      rule: {
        name: "验证码短期保留",
        condition: { field: "hasCode", value: true },
        actions: { tags: ["验证码"], retentionDays: 1 },
        stopProcessing: false,
      },
    },
    {
      id: "recovery",
      name: "激活与找回 · 保留 30 天",
      description:
        "按主题关键词保留账号激活、邮箱确认和密码找回邮件；可补充常用网站的用词。",
      rule: {
        name: "激活与找回",
        condition: { any: accountWords.map(contains) },
        actions: { delivery: "keep", tags: ["账号"], retentionDays: 30 },
        stopProcessing: true,
      },
    },
    {
      id: "newsletters",
      name: "营销邮件 · 放入垃圾箱",
      description:
        "匹配 newsletter、促销或退订文字，排除已识别验证码和常见账号邮件。只移入垃圾箱，不拒收。",
      rule: {
        name: "营销邮件归类",
        condition: {
          all: [{
            any: [
              contains("newsletter"),
              contains("促销"),
              contains("限时优惠"),
              { field: "body", operator: "contains", value: "unsubscribe" },
            ],
          }, {
            not: {
              any: [
                { field: "hasCode", value: true },
                ...accountWords.map(contains),
                ...alertWords.map(contains),
              ],
            },
          }],
        },
        actions: { delivery: "trash", tags: ["营销"], retentionDays: 7 },
        stopProcessing: true,
      },
    },
    {
      id: "website",
      name: "按网站 · 自动加标签",
      description:
        "示例为 GitHub 地址，可改成你使用的前缀和域名；只加标签，继续执行其他规则。",
      rule: {
        name: "GitHub 标签",
        condition: {
          field: "alias",
          operator: "glob",
          value: `github*@${domain}`,
        },
        actions: { tags: ["github"] },
        stopProcessing: false,
      },
    },
    {
      id: "alerts",
      name: "账号安全提醒 · 转发",
      description:
        "将新登录、密码变更等主题的邮件转发并保留。填写已在 Cloudflare 验证的目标邮箱后使用。",
      rule: {
        name: "账号提醒转发",
        condition: {
          any: alertWords.map(contains),
        },
        actions: { delivery: "forward", tags: ["安全提醒"] },
        stopProcessing: true,
      },
    },
  ];
}
