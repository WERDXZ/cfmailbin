# cfmailbin

`cfmailbin` is a private registration inbox and forwarding layer for domains
managed on Cloudflare.

The goal is simple: receive mail on aliases under your own domain, decide what
to do with each message, optionally forward it to your main inbox, and keep
temporary copies only as long as you want.

## What The Product Is

- Long-lived, per-website email aliases without plus tags
- Automatically remembered addresses and one-click copying
- Verification codes directly in the inbox, readable bodies and activation links
- Optional background AI fallback through Cloudflare AI Gateway (BYOK), with
  DeepSeek Flash or GPT-5.6 Luna and a daily call limit
- Catch-all or explicit alias handling
- Composable rules, multiple effects, editable templates and read-only trial
  runs
- Temporary inbox storage with retention limits
- A small dashboard for searching, tagging, and managing aliases

## 日常使用

推荐「一个网站，一个长期地址」：

1. 接好 catch-all 后，在注册页直接填写 `github@example.com` 这样的普通地址。
2. 打开收件箱，直接点击邮件列表中的验证码复制；正文按需展开。
3. 页面通过 SSE
   实时更新，断线自动重连，切回窗口立即刷新。新邮件不会切走已展开的正文。
4. 搜索网站备注、地址或邮件；用过的地址长期保留，方便下次复制。
5. 域名接入、保留期限和规则都在设置中。邮件清理不删除地址。

首次使用需要接入自己的邮箱域名。详见 [使用与域名配置](docs/usage.md)。 可选的 AI
补充识别、价格比较和密钥配置见 [邮件识别](docs/email-analysis.md)。

首次部署与后续更新按 [Cloudflare 部署步骤](docs/deploy.md) 操作，包含 D1、R2、
Access、Email Routing 和 AI Gateway 的完整顺序。

## What The Product Is Not

- A full email provider
- A long-term archival mailbox
- An outbound sending platform
- A Gmail replacement

## MVP

1. Receive email through Cloudflare email handling
2. Match the target alias or create a disposable alias record
3. Apply rules based on alias, sender, or subject
4. Forward allowed mail to a configured destination email
5. Store message metadata in `D1`
6. Store raw message content and attachments in `R2`
7. Expire stored mail automatically after the configured retention window
8. Show a lightweight inbox with filters and tags

## Architecture Direction

- `Cloudflare Worker`: one backend for `fetch`, `email`, and `scheduled`
- `D1`: aliases, rules, tags, and message metadata
- `R2`: raw MIME bodies and attachments
- `Deno`: local development, tests, and tooling
- `Preact + Vite`: CSR dashboard under `src/ui`

## Auth

The dashboard uses Cloudflare Access with Cloudflare account sign-in, restricted
to one owner email. The backend verifies Access's signed JWT, its issuer,
application audience, expiry, and owner email. Missing configuration denies API
access. The browser uses the Access session cookie; no token entry is needed.

Follow [Cloudflare Access setup](docs/access.md) before deploying. Set
`CFMAILBIN_OWNER_EMAIL`, `CFMAILBIN_ACCESS_TEAM_DOMAIN`, and
`CFMAILBIN_ACCESS_AUD`, and protect the entire Worker, including production and
preview URLs. Existing bearer tokens no longer grant access; the historical
`tokens` table is left intact.

## Repository Layout

```text
.
├── README.md
├── deno.json
├── wrangler.toml
├── docs/
│   └── architecture.md
├── src/
│   ├── app.ts
│   ├── auth.ts
│   ├── config.ts
│   ├── worker.ts
│   ├── main.ts
│   ├── db/
│   │   └── migrations/
│   │       └── 0001_init.sql
│   ├── domain/
│   │   ├── models.ts
│   │   └── rules.ts
│   ├── email/
│   │   └── processor.ts
│   ├── platform/
│   │   └── cloudflare.ts
│   ├── ui/
│   │   ├── App.tsx
│   │   ├── api.ts
│   │   ├── index.html
│   │   ├── main.tsx
│   │   ├── styles.css
│   │   └── types.ts
│   ├── storage/
│   │   ├── d1.ts
│   │   ├── memory.ts
│   │   └── types.ts
│   └── services/
│       └── retention.ts
└── tests/
    ├── api_test.ts
    └── email_test.ts
```

## Local Commands

```sh
deno task dev
deno task ui:dev
deno task ui:build
deno task check
deno task fmt
deno task lint
deno task test
deno task deploy:check
deno task deploy
```

The frontend tooling is still Vite-based, but it is launched through Deno with
`npm:` packages declared in `deno.json`, so the workflow does not depend on the
`npm` executable.

Deployment requires Node.js (24 LTS recommended). Install the pinned Wrangler
with `deno install --frozen --allow-scripts=npm:esbuild,npm:workerd`, then run
`deno task wrangler <command>`. `deploy:check` builds and packages locally;
`deploy` uploads the Worker and frontend assets. Follow
[deployment setup](docs/deploy.md) before the first upload.

## Cloudflare Config

`wrangler.toml` is included for the worker backend and currently configures:

- `src/entry.ts` as the Cloudflare entrypoint, delegating to `src/worker.ts`
- `./dist/ui` as Workers Assets for the frontend dashboard
- `DB` as the D1 binding
- `RAW_EMAILS` as the R2 binding
- `SETTINGS` as the KV binding for editable preferences
- `INBOX_EVENTS` as the per-owner Durable Object for SSE notifications
- app vars for catch-all mode, auto-created alias tagging, retention, and
  forwarding
- an hourly cleanup cron for expired mail
- a deploy-time build step that runs `deno task ui:build`

Deployed routing works like this:

- `/api/*` and `/health` run through the worker backend
- everything else is served from the built frontend assets
- unknown frontend routes fall back to `index.html` for SPA routing

Before deploying, replace the placeholder values in `wrangler.toml`:

- `database_id`
- `bucket_name`
- `preview_bucket_name`
- `CFMAILBIN_EMAIL_DOMAIN` for domain-specific delivery status
- optional `CFMAILBIN_AUTO_CREATE_ALIAS_TAG`
- optional `CFMAILBIN_FORWARD_TO`
- required Access settings described in [docs/access.md](docs/access.md)

Apply all pending D1 migrations before deploying this version, including
`0003_inbox.sql` (stored code candidates and persistent alias receipt history),
`0004_rules.sql` (expressive rules, explicit order and historical rule traces),
`0005_email_analysis.sql` (optional AI results and daily call limits), and
`0006_alias_tags_repair.sql` (repair for early database installations). These
preserve existing addresses and messages. Migration 0005 is required for the new
code even when AI is disabled.

Before deploying for the first time, also make sure `dist/ui` exists locally by
running `deno task ui:build` once. Wrangler will do this automatically on deploy
via the configured build step.

Run the backend and frontend separately in development:

- `deno task dev` serves the API at `http://127.0.0.1:8000`
- `deno task ui:dev` serves the dashboard at `http://127.0.0.1:5173`
- the Vite dev server proxies `/api` and `/health` to the backend

The local API binds only to `127.0.0.1` and supplies a development identity, so
the dashboard opens automatically. It uses in-memory data and does not test
Cloudflare sign-in. The production Worker always requires a verified Access JWT;
it has no development-auth environment switch.

## Current Status

The repo includes:

- a single-worker backend entrypoint in `src/worker.ts`
- a local in-memory dev server in `src/main.ts`
- Additive D1 migrations in `src/db/migrations/`
- authenticated HTTP routes for inbox snapshots, aliases, rules, messages, raw
  message reads, and tags
- inbound email processing with optional catch-all alias creation
- optional tag assignment for auto-created aliases
- scheduled retention cleanup
- a registration-focused Preact inbox with website-labelled aliases, code
  copying, visible-tab SSE with reconnect and polling fallback, mobile layouts
  and Access sign-in
- MIME decoding, stored code candidates, and bounded plaintext/HTTP(S)-link
  extraction
- alias settings, rule creation, message filtering, tags and raw downloads
