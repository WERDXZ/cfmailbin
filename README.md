# cfmailbin

`cfmailbin` is a disposable-email inbox and forwarding layer for domains managed
on Cloudflare.

The goal is simple: receive mail on aliases under your own domain, decide what
to do with each message, optionally forward it to your main inbox, and keep
temporary copies only as long as you want.

## What The Product Is

- Disposable aliases on your own domain
- Catch-all or explicit alias handling
- Rule-based actions like `keep`, `forward`, `trash`, and `block`
- Temporary inbox storage with retention limits
- A small dashboard for searching, tagging, and managing aliases

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

The backend uses a minimal bearer-token check.

- tokens live in the `tokens` D1 table
- the frontend can keep the active token in `sessionStorage`
- API requests send `Authorization: Bearer <token>`
- rotation is manual: insert a new token row, switch the client token, then
  delete the old row

Example token insert:

```sql
INSERT INTO tokens (token) VALUES ('replace-me');
```

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
```

The frontend tooling is still Vite-based, but it is launched through Deno with
`npm:` packages declared in `deno.json`, so the workflow does not depend on the
`npm` executable.

## Cloudflare Config

`wrangler.toml` is included for the worker backend and currently configures:

- `src/worker.ts` as the worker entrypoint
- `./dist/ui` as Workers Assets for the frontend dashboard
- `DB` as the D1 binding
- `RAW_EMAILS` as the R2 binding
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
- optional `CFMAILBIN_AUTO_CREATE_ALIAS_TAG`
- optional `CFMAILBIN_FORWARD_TO`

Before deploying for the first time, also make sure `dist/ui` exists locally by
running `deno task ui:build` once. Wrangler will do this automatically on deploy
via the configured build step.

Run the backend and frontend separately in development:

- `deno task dev` serves the API at `http://127.0.0.1:8000`
- `deno task ui:dev` serves the dashboard at `http://127.0.0.1:5173`
- the Vite dev server proxies `/api` and `/health` to the backend

## Current Status

The repo now has a working backend skeleton:

- a single-worker backend entrypoint in `src/worker.ts`
- a local in-memory dev server in `src/main.ts`
- D1 migration SQL in `src/db/migrations/0001_init.sql`
- authenticated HTTP routes for aliases, rules, messages, raw message reads, and
  tags
- inbound email processing with optional catch-all alias creation
- optional tag assignment for auto-created aliases
- scheduled retention cleanup
- a CSR Preact dashboard for token entry, alias management, rule creation,
  message filtering, tag editing, and raw message downloads
