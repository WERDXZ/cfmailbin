# 可选 AI 补充识别

默认保留本地验证码提取。开启 AI 后，只对新收到、正文可以解析、且本地没有找到
验证码的邮件调用模型。邮件先入库，Worker 用 `waitUntil` 在后台补充分类和验证码，
不阻塞查看邮件。列表与已经展开的正文会随收件箱刷新更新复制按钮。

支持 DeepSeek V4.1 Flash（API 名 `deepseek-flash`，默认）与 OpenAI GPT-5.6 Luna
（`gpt-5.6-luna`）。通过 Cloudflare AI Gateway 的服务商原生 HTTP 端点调用，
未增加 SDK 依赖：邮件 → 本地提取 → 未识别到时由后台任务请求 Gateway → 所选模型。
DeepSeek 使用 Chat Completions，OpenAI 使用 Responses；不经过兼容层转换协议。

## AI Gateway 费用

2026-09-29 核对：AI Gateway 基础分析、缓存和限流功能在所有计划上免费，
模型推理仍由 DeepSeek/OpenAI 收费。这里采用 BYOK，直接由模型服务商结算， 不使用
Cloudflare 统一充值；后者购买 credits 时有 5% 手续费。

日志等附加功能有单独规则：2026-09-24 起首次创建网关的新客户使用 Workers Logs
计费与保留政策。应用每次请求都关闭 Gateway 请求日志和缓存，禁止自动重试， 并设置
`cf-aig-no-wholesale: true`，防止缺少 BYOK 时转用 Cloudflare 预充值余额。
这不改变现有 Worker、D1、R2 的计费。

来源：[AI Gateway 价格](https://developers.cloudflare.com/ai-gateway/reference/pricing/)、
[凭证及计费控制](https://developers.cloudflare.com/ai-gateway/glossary/)。

## 价格选择

2026-09-29 核对的官方标准价格，美元 / 百万 token，输入按未命中缓存计算：

| 模型                      | 输入  | 输出  | 每 1,000 封示例费用 |
| ------------------------- | ----- | ----- | ------------------- |
| DeepSeek V4.1 Flash，闲时 | $0.15 | $0.60 | $0.21               |
| DeepSeek V4.1 Flash，高峰 | $0.30 | $1.20 | $0.42               |
| GPT-5.6 Luna，短上下文    | $0.20 | $1.20 | $0.32               |

示例假设每封总输入 1,000 token、输出 100 token，非实际用量保证。 未计缓存折扣或
Cloudflare 本身的费用。实际 token 用量随邮件长度和模型分词变化。 DeepSeek
高峰为北京时间周一至周五（中国法定节假日除外）09:00–12:00、14:00–18:00，
其余时间为闲时。闲时 DeepSeek 更便宜，高峰未缓存输入 Luna 更便宜。 默认选择
DeepSeek 是偏向闲时/纽约白天使用的选择，不声称全天最低价；已有 OpenAI
账户或主要在高峰使用时可切换。不做按时段自动切换，避免维护两套密钥与价格路由。

来源：[DeepSeek 定价](https://api-docs.deepseek.com/quick_start/pricing/)、
[人民币定价与时段](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)、
[OpenAI 定价](https://developers.openai.com/api/docs/pricing)。价格可能调整。

## 启用

1. 先对目标 D1 应用全部未应用迁移，包括
   `0005_email_analysis.sql`。新增可空分析字段
   与每日调用计数表，不修改已有邮件内容和规则。即使关闭
   AI，部署新代码也需要迁移。
2. 在 Cloudflare 控制台创建一个 AI Gateway，例如 `cfmailbin`。开启 Authenticated
   Gateway，创建具有 **AI Gateway Run** 权限的 token。 在该网关 BYOK 中保存
   DeepSeek 的 API Key，使用 `default` 别名。 若选择 OpenAI，就保存 OpenAI 的
   Key。
3. 在 Worker 的变量中设置（Account ID 是 Cloudflare 账户 ID，不是 Zone ID）：

   ```toml
   CFMAILBIN_AI_ENABLED = "true"
   CFMAILBIN_AI_PROVIDER = "deepseek"
   CFMAILBIN_AI_DAILY_LIMIT = "100"
   CFMAILBIN_AI_GATEWAY_ACCOUNT_ID = "你的32位Cloudflare账户ID"
   CFMAILBIN_AI_GATEWAY_ID = "cfmailbin"
   ```

4. 使用 Wrangler 的 `secret put CF_AIG_TOKEN` 交互输入网关 token， 保存为 Worker
   Secret。不要把密钥写入命令参数、`wrangler.toml`、前端变量或版本控制。
   如果希望继续使用 Worker 中的模型 Key，也可配置 `DEEPSEEK_API_KEY` /
   `OPENAI_API_KEY` Secret；它优先于网关的 BYOK。这两种方式都经过 Gateway。
5. 建议同时在网关设置中关闭 Cache Responses 和日志；代码中的请求头也会强制关闭。
   部署后在「设置 → 验证码识别」检查配置状态，再发送测试邮件核对。
   配置状态只表示本地所需变量齐全，不会额外发付费请求验证 token 或远程 BYOK。
   缺少/无效网关参数时只运行本地识别。认证失败、BYOK 缺失或上游错误时显示
   「识别未完成」，保留原邮件，不自动绕过网关直连服务商。

网关 token 与模型 Key 是不同凭证：前者通过 `cf-aig-authorization` 发往
Cloudflare， 后者若在 Worker 中配置则使用 `Authorization`。使用网关保存的 BYOK
时省略 `Authorization`。不会发送占位密钥，以免覆盖网关保存的 Key。

设置参考：[网关认证](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)、
[BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)。

本地可将以上变量和密钥放入被 Git 忽略的 `.dev.vars`，用：

```sh
deno run --env-file=.dev.vars --watch --allow-env --allow-net src/main.ts
```

本地 HTTP 开发服务器不接收真实 Cloudflare 邮件，也不会仅因浏览历史邮件而调用
AI。

## 成本与行为边界

- 默认关闭，必须同时启用并配置网关及模型凭证。每日上限默认 100，支持
  0–1,000；设为 0 暂停调用。按 UTC 日期在 D1
  中原子计数，服务失败也占一次额度；本地计数随重启清空。
- 每条邮件记录只能由一个后台任务领取。刷新、查看正文、规则试运行均不调用 AI，
  不自动重试失败请求，也不回填历史邮件。不同的重复投递仍可能形成不同记录。
- 每次最多发送主题 500 字符、正文 12,000 字符，不发送附件、原始 MIME、收件地址或
  密钥之外的配置。正文自身仍可能包含验证码、地址及其他私人信息，经 Cloudflare
  发送到所选提供商。`cf-aig-collect-log: false` 关闭网关整条请求日志，
  `cf-aig-skip-cache: true` 跳过网关缓存，不等于服务商承诺零保留。
- 两家都关闭思考模式，输出限制 512 token；请求 8 秒超时，响应最多 64 KiB。
  OpenAI Responses 设置 `store: false`；这不等于关闭服务商所有日志或承诺零保留。
- 邮件内容作为不可信数据，模型没有工具，不访问链接。输出经过类型和枚举校验。
  验证码及其上下文必须原样出现在发送的文本中，保留大小写、前导零，允许合并显示用的
  空格与连字符。原文校验能排除凭空生成的码，不能保证模型不会把原文中的订单号误判。
- 解析失败不调用模型；截断文本的否定结论保留为「未确定」。没有识别到验证码不表示
  邮件一定没有验证码。识别失败/超额保留原邮件与本地结果；可直接查看正文。
- 分析结果持久化在 `messages.analysis_json`，补充码进入 `verification_codes`。
  不自动修改标签、投递状态或保留时间，不重放拒收/转发规则。现有 `hasCode`
  收件规则 与试运行仍使用本地识别结果；AI 分类当前用于展示，未接入规则条件。
- 后台任务若被平台中断，不重试；超过一分钟仍在运行的记录在界面显示「识别未完成」。
  关闭 AI 只停止后续收件安排新任务，已经发出的请求不撤回。

协议依据：[DeepSeek 首次调用](https://api-docs.deepseek.com/zh-cn/)、
[DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)、
[Luna 模型](https://developers.openai.com/api/docs/models/gpt-5.6-luna)、
[OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)。

网关协议：[DeepSeek 原生端点](https://developers.cloudflare.com/ai-gateway/usage/providers/deepseek/)、
[OpenAI 原生端点](https://developers.cloudflare.com/ai-gateway/usage/providers/openai/)、
[请求控制](https://developers.cloudflare.com/ai-gateway/configuration/request-handling/)、
[日志](https://developers.cloudflare.com/ai-gateway/observability/logging/)、
[缓存](https://developers.cloudflare.com/ai-gateway/features/caching/)。

## 验证范围

自动测试覆盖两家请求协议、原文校验、前导零、截断结果、超时、响应大小、服务失败、
异步收件、并发去重与每日额度、D1 持久化、删除竞态及密钥不进入 API 响应。
网关测试覆盖 URL、两种凭证方式、禁用缓存/日志/统一计费/重试的请求头、
不完整或无效配置及失败后不直连。
浏览器使用独立合成邮箱和模拟模型响应检查显示与复制。尚未使用真实密钥评估模型
准确率、延迟或实测费用；启用前应以自己的典型邮件抽样核对。
