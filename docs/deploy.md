# 部署到 Cloudflare

前端与 API 一起部署到 `cfmailbin` Worker；D1 保存邮件索引、地址和规则，R2 保存
邮件原件。Access 保护网页，Email Routing 将邮件送到 Worker，AI Gateway
可稍后开启。

下文按首次部署编写。已有实例请直接看最后的「更新已有部署」，继续使用原来的资源。

## 1. 准备工具并登录

本机需要 Deno 2 和 Node.js（建议 24 LTS）。项目固定使用 Wrangler 4.142.0， 由
Deno 安装依赖、Node.js 运行 CLI，无需安装全局 Wrangler。

在项目根目录运行：

```sh
deno install --frozen --allow-scripts=npm:esbuild,npm:workerd
deno task wrangler login
deno task wrangler whoami
```

登录会打开浏览器。确认输出的 Cloudflare 账户是托管收件域名的账户。
如有多个账户，在 `wrangler.toml` 顶层填写 `account_id = "你的账户ID"`，
让后续资源创建与部署使用同一个账户。

依据：[Wrangler 安装](https://developers.cloudflare.com/workers/wrangler/install-and-update/)。

## 2. 创建 D1 和 R2

在 Cloudflare 控制台启用 R2，然后运行：

```sh
deno task wrangler d1 create cfmailbin --update-config=false
deno task wrangler r2 bucket create cfmailbin-raw-emails --update-config=false
```

将 D1 命令返回的 `database_id` 填入 `wrangler.toml` 已有的 `[[d1_databases]]`
段，替换 `replace-with-d1-database-id`。保持绑定名 `DB` 不变。 R2 使用
`bucket_name = "cfmailbin-raw-emails"`，绑定名保持 `RAW_EMAILS`。
如果账户中已有同名资源，核对用途后复用，不要重新创建或改指向空库。

生产部署只用 `bucket_name`。`preview_bucket_name` 用于 Wrangler 的远程开发；
首次生产部署无需创建该预览桶。以后使用远程开发时，应创建独立的预览桶。
邮件原件通过 Worker 的鉴权 API 读取，R2 桶保持私有。

依据：[D1 命令](https://developers.cloudflare.com/d1/wrangler-commands/)、
[R2 建桶](https://developers.cloudflare.com/r2/buckets/create-buckets/)。

## 设置存储与实时更新

创建独立设置 KV，并把返回的 ID 填入 `wrangler.toml` 的 `SETTINGS` 绑定：

```sh
deno task wrangler kv namespace create cfmailbin-settings --binding SETTINGS
```

已有部署若已绑定该 namespace，请沿用现有 ID，不要重复创建。 `INBOX_EVENTS`
Durable Object 及 `inbox-events-v1` SQLite 类迁移由部署时自动创建。
它只分发刷新通知，邮件仍在 D1/R2。后续部署保留这条 DO 迁移记录。

`[vars]` 中的收件和 AI 偏好用作初始值。之后在 `/settings` 修改并保存到 KV，
不需要重新部署。Access 身份、Gateway ID 和 Secrets 仍由部署配置管理。

## 3. 配置收件域名、迁移并首次上传

在 `wrangler.toml` 已有的 `[vars]` 段中取消注释并填写：

```toml
CFMAILBIN_EMAIL_DOMAIN = "example.com"
CFMAILBIN_OWNER_EMAIL = "你用于登录的现有邮箱"
CFMAILBIN_ALLOW_CATCH_ALL = "true"
CFMAILBIN_DEFAULT_RETENTION_DAYS = "7"
```

`example.com` 是计划用来收件的真实域名。网页可以先用部署返回的
`cfmailbin.<你的子域>.workers.dev` 地址；网页地址与邮箱域名可以不同。 Access 的
AUD 和团队域名在下一步取得，AI 变量先保持关闭。

```sh
deno task wrangler d1 migrations list DB --remote
deno task wrangler d1 migrations apply DB --remote
deno task deploy:check
deno task deploy
```

迁移必须应用到远程 D1，包括 `0001` 至 `0006` 中所有未应用项。即使不启用 AI，
新代码也需要 `0005`。不要手动重复执行已经应用的 `ALTER TABLE`。

`deploy:check` 会构建前端、打包 Worker
并检查配置，不上传，也不验证远程资源是否存在。 `deploy`
会再次构建并上传前端和后端。无需另建 Pages 项目。

首次上传是为了创建 Worker，随后才能为它配置 Access。此时没有 Access 配置， API
会拒绝访问；暂不将邮件路由切换到这个 Worker。完成下一步后才能正常登录使用。

依据：[部署命令](https://developers.cloudflare.com/workers/wrangler/commands/workers/)、
[D1 迁移](https://developers.cloudflare.com/d1/wrangler-commands/#d1-migrations-apply)。

## 4. 配置只允许自己登录

1. 启用 Zero Trust，并配置 Cloudflare 作为身份提供商，使用现有 Cloudflare
   账号登录。
2. 控制台打开 Workers & Pages → `cfmailbin` → Access → **Protect this Worker
   behind Access**，范围选 **All traffic**。
3. 在对应 Access 应用中，登录方式选择 Cloudflare。Allow 策略的 Emails 只填写
   你的完整邮箱地址，移除该应用中更宽泛的 Allow / Bypass 策略。
4. 复制该 Access 应用的 AUD 和 Zero Trust 团队域名，在 `[vars]` 中填写：

   ```toml
   CFMAILBIN_ACCESS_TEAM_DOMAIN = "你的团队.cloudflareaccess.com"
   CFMAILBIN_ACCESS_AUD = "该Access应用的AUD"
   ```

   团队域名不含 `https://`。AUD 不是 Cloudflare Account ID。
   `CFMAILBIN_OWNER_EMAIL` 必须与允许登录的邮箱一致。
5. 再运行 `deno task deploy`，使应用读到上述变量。
6. 用无痕窗口打开部署地址，应先登录，再进入空收件箱；登录后侧栏显示你的邮箱。

之后新增自定义网页域名也会受到此 Worker 的 Access 保护。Access 保护 HTTP 访问，
不要求发信人在投递邮件前登录。

详细步骤见 [Access 配置](access.md)；
官方依据：[Worker Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)、
[Cloudflare 身份提供商](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/cloudflare/)。

## 5. 接入真实收件

1. 在 Cloudflare 的 Email Service → Email Routing 中，启用目标域名，完成所需 MX
   / TXT 配置及目标地址验证。已有邮箱服务时先核对 MX
   的用途，不直接替换现有收件系统。
2. 打开 Routing Rules，开启 **Catch-all**，Action 选择 **Send to a Worker**，
   Worker 选择 `cfmailbin`。已有 catch-all 时，切换目标会改变这些邮件的去向。
3. 从另一个邮箱发送一封测试邮件到 `test@example.com`，正文例如
   `Your verification code is 001234.`。
4. 打开网页确认收到邮件、出现 `test@example.com` 地址、能复制 `001234`
   和展开正文。 「设置 → 收件接入」应显示最近收件记录。

之后可以直接用 `github@example.com`、`notion@example.com`
注册，无需先在应用里创建地址。 已有 Cloudflare 精确地址规则优先于
catch-all；它们发往其他目标的邮件不会出现在这里。

截至 2026-09-30，Cloudflare 的 catch-all 只支持根域名；Email Routing 子域名需要
逐个配置具体地址规则。因此想获得“任意地址直接用”的体验，应选择用于收件的根域名。

依据：[路由规则](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/)、
[规则优先顺序](https://developers.cloudflare.com/email-service/concepts/email-lifecycle/)、
[子域名限制](https://developers.cloudflare.com/email-service/configuration/subdomains/)。

## 6. 启用 AI Gateway（可选）

先完成本地验证码提取的收件验证，再按 [AI Gateway 接入说明](email-analysis.md)
创建带认证的网关、在 BYOK 的 `default` 别名保存模型 Key。 在 `wrangler.toml` 的
`[vars]` 中配置：

```toml
CFMAILBIN_AI_ENABLED = "true"
CFMAILBIN_AI_PROVIDER = "deepseek"
CFMAILBIN_AI_DAILY_LIMIT = "100"
CFMAILBIN_AI_GATEWAY_ACCOUNT_ID = "你的32位Cloudflare账户ID"
CFMAILBIN_AI_GATEWAY_ID = "cfmailbin"
```

将具有 AI Gateway Run 权限的 token 通过终端交互输入：

```sh
deno task wrangler secret put CF_AIG_TOKEN
deno task deploy
```

`secret put` 会更新已部署 Worker 的 secret 并发布版本，随后的 `deploy`
发布本地变量 和代码。网关保存 BYOK 后，不必再上传模型 Key 到
Worker。密钥不要写进配置或聊天。 本地 `.dev.vars` 不会自动上传。

在设置页确认配置状态，并发送一封本地识别未覆盖的邮件验证 AI 补充识别。
普通验证码若已被本地提取，不会触发 AI，这属于预期行为。

## 更新已有部署

继续使用原来的 Worker 名称、Account ID、D1 ID、R2 桶和 Access 应用。
部署前将控制台设置的非密钥变量同步到 `wrangler.toml`，避免下一次部署覆盖它们。
不要为了更新代码另建空库。

```sh
deno install --frozen --allow-scripts=npm:esbuild,npm:workerd
deno task wrangler whoami
deno task wrangler d1 migrations list DB --remote
deno task check
deno task lint
deno task test
deno task deploy:check
deno task wrangler d1 migrations apply DB --remote
deno task deploy
```

先检查待应用迁移，再部署代码。部署后验证 Access 登录与一封真实收件，检查已配置的
路由仍指向当前 Worker。如需看运行错误，可使用 `deno task wrangler tail`。

AI 故障时在「设置 → 验证码识别」关闭 AI，保留正常收件。保存过设置后，KV 设置
优先于同名环境变量，不能只修改环境变量来覆盖它们。 代码问题可通过 Cloudflare 的
Deployments 回退到前一个版本；代码回退不会撤销 D1 迁移或恢复已删除邮件，Access
与路由配置也应继续保留。

依据：[Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)、
[回退限制](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)。

## 当前验证范围

2026-09-30 已完成生产部署，绑定 SETTINGS KV 和实时通知 Durable Object，并应用
`0006_alias_tags_repair.sql` 修复旧数据库缺失的关联表，保留原有地址和邮件。
收件箱、设置页与 SSE 接口的未登录请求均跳转到 Cloudflare Access。

本地验证包含类型检查、72 个测试、依赖审计、Workers 运行时中的 SSE / KV，以及真实
浏览器中的收件更新、断线恢复、HTML 隔离和明暗色响应式布局。未使用所有者的登录
会话执行线上操作，也未调用生产 AI 模型来验证密钥。
