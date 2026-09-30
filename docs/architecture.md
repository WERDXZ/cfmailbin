# Architecture Notes

## Problem

We want disposable email addresses under a domain we control without building a
full mailbox provider.

The useful behavior is:

- receive mail sent to aliases on our domain
- decide whether to keep, forward, trash, or block it
- retain messages for a limited time only
- give the user a lightweight inbox and control panel

## Product Model

### Aliases

An alias is an address like `shop@example.com` or `random123@example.com`.

Each alias has:

- enabled or disabled state
- a default action
- an optional forward target
- a retention period
- tags or notes for organization

### Messages

Each message stores:

- envelope recipient alias
- sender
- subject
- received timestamp
- status
- tag list
- raw message storage key
- expiration timestamp

### Rules

Rules evaluate message data and select an action.

Useful first-pass rule inputs:

- alias contains or equals
- sender contains or equals
- subject contains

Useful first-pass actions:

- `keep`
- `forward`
- `trash`
- `block`

## Technical Direction

### Inbound Path

1. Cloudflare receives email for the domain.
2. An email handler extracts envelope data and message headers.
3. The system looks up the alias or creates a disposable alias record.
4. Rules are evaluated.
5. The system decides whether to forward, store, or reject the message.
6. Metadata is written to `D1` and raw content is written to `R2` when needed.

### Storage Split

Use `D1` for searchable structured data:

- aliases
- rules
- tags
- message metadata

Use `R2` for large or unstructured data:

- raw MIME source
- attachments
- attachments remain inside the original MIME (no separate parsed-body
  snapshots)

## Suggested V1 Scope

- explicit aliases
- optional catch-all mode
- single forward destination
- metadata search
- message tags
- message retention expiry
- lightweight inbox view

## Current Backend Decisions

- One Cloudflare Worker handles `fetch`, `email`, and `scheduled`
- `D1` stores aliases, rules, messages, tags, and message-tag links
- `R2` stores raw MIME bodies
- Cloudflare Access handles sign-in; the API validates its JWT and restricts
  access to the configured owner email (see [Access setup](access.md))
- the browser uses Access cookies; writes require a custom request header and
  reject foreign origins, and API responses are not cached
- historical D1 tokens no longer authenticate requests; no destructive database
  migration is needed
- blocked or unknown aliases are rejected instead of stored
- catch-all mode auto-creates aliases on first inbound mail when enabled

## Non-Goals For V1

- sending mail as any alias
- full IMAP or SMTP support
- permanent storage
- advanced threading
- multi-user collaboration

## Open Questions

- Do we want per-alias forward targets only, or also multiple global targets?

## Inbox workflow

- `GET /api/inbox` returns up to 100 matching messages, remembered aliases and
  delivery evidence in one authenticated, uncached response. Search includes
  alias description, recipient, sender, subject and stored body preview.
- Inbound MIME parsing stores a decoded subject, short plaintext preview and
  contextual code candidates. `0003_inbox.sql` adds nullable JSON-encoded
  `messages.verification_codes` and `aliases.last_received_at`. The latter is
  updated monotonically on receipt and persists after message deletion.
  Migration backfills it from remaining messages and receipt audit events.
- Inbox snapshots never read raw MIME from R2. Legacy NULL code candidates fall
  back to subject/preview detection; opening legacy content persists the
  complete extraction for subsequent snapshots. Code candidates share the
  message's lifetime.
- `GET /api/messages/:id/content` uses `postal-mime` and `htmlparser2` to
  produce plaintext and explicit HTTP(S) links. No email HTML execution, remote
  images or automatic link visits. Limits: 1 MiB MIME input, 32 nesting levels,
  64 KiB aggregate headers and 50,000 displayed characters. Attachments and
  attached emails are excluded from detection; raw MIME remains downloadable.
- The browser subscribes to authenticated `/api/events` while visible. A
  per-owner Durable Object publishes metadata-free invalidations after receipt,
  AI completion, mutations and retention cleanup. Each reconnect reloads the
  authoritative D1 snapshot; streams rotate after 55 seconds to reauthenticate.
  Hidden tabs disconnect. Failed SSE connections retry with bounded backoff and
  fall back to 30-second checks. Focus/return refreshes immediately; concurrent
  invalidations coalesce with one follow-up fetch, and obsolete requests cannot
  overwrite a newer view. Codes can be copied from rows without fetching bodies.
  Bodies open only on selection; new arrivals do not change the selected
  message. One search filters messages and addresses.
- Delivery status queries the latest successful receipt and rejection audit
  events, optionally scoped to the exact configured domain. It does not infer
  connectivity from address creation or a successful API request. Audit history
  survives mail deletion. Development mode never claims live Cloudflare receipt.
- The application does not read or manage Cloudflare routing configuration.
  Domain catch-all routing and app-level unknown-alias acceptance are separate.
  The optional explicit alias/generation APIs remain compatible, but generation
  is no longer the primary UI workflow. Settings retain rules and custom
  aliases.
- Access JWT verification, no-store responses and same-origin write protection
  apply to the new endpoint. The local Vite proxy preserves Host for the same
  Origin checks without weakening production authentication.

## Expressive rules

See [rules.md](rules.md) for the condition/action contract, ordering, unknown
semantics, preview API and migration 0004. The same pure evaluator powers
preview and intake. Templates are editable client-side drafts, not automatic
configuration changes. Message rule traces snapshot matched/unknown conditions
at receipt; rejected mail keeps its trace in the audit event instead.

## Optional email analysis

See [email-analysis.md](email-analysis.md) for provider selection, setup,
pricing, privacy boundaries and migration 0005. A stored message without locally
extracted codes can be enriched through `waitUntil`, after receipt and rule
execution. The AI adapter uses provider-native routes on the fixed
`gateway.ai.cloudflare.com` host with bounded requests and validated,
source-backed code extraction. D1 atomically claims each message and reserves a
daily call; metadata updates preserve concurrent status/tag changes. Polling and
body reads only use saved results and never invoke a model. AI classifications
do not replay delivery rules or change retention.

Gateway authentication uses the server-only `CF_AIG_TOKEN`. The provider key can
be stored in Gateway BYOK under the default alias or supplied from a Worker
secret; without a Worker key the provider Authorization header is omitted. Every
request disables Gateway caching, request logs and retries, and requires BYOK
(`cf-aig-no-wholesale`) to avoid falling through to prepaid billing. Incomplete
Gateway configuration leaves local extraction active; Gateway errors never
trigger a direct provider request. No extra SDK or Workers AI binding is
required.

## Runtime settings and HTML previews

- `/settings` and `/settings/{receiving,ai,rules,account}` are directly
  accessible SPA routes, including browser history and reloads. Deployment
  instructions live in the documentation, rather than the daily settings screen.
- Owner-authenticated `GET /api/settings` reads defaults from deployment
  variables until `PUT /api/settings` saves a complete validated settings object
  in the `SETTINGS` KV namespace (`settings:v1`). The saved response is
  authoritative for the form; it does not immediately re-read an eventually
  consistent KV value.
- KV overrides only the domain, catch-all switch, default
  retention/forwarding/tag, and AI enable/provider/daily quota. Access identity,
  Gateway identifiers and all credentials remain deployment bindings/secrets.
  Changing provider selects the matching server secret, never the previous
  provider's key. Missing KV is a readable, non-editable defaults mode; local
  Deno uses an in-memory settings store.
- Settings are low-frequency, last-write-wins preferences. KV can take roughly
  60 seconds or longer to propagate between locations and allows one write per
  second per key. Exact AI call counts remain atomic in D1, not in KV. See
  [KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/).
- HTML bodies remain plain text by default. Optional HTML preview preserves
  basic formatting with an allowlist, strips
  forms/scripts/SVG/images/navigation, and runs in `iframe sandbox=""` without
  `allow-same-origin` or `allow-scripts`. An embedded CSP blocks all resource
  loads, connections, forms and nested frames; only inline CSS is allowed. Links
  are opened deliberately from the separate validated link list. HTML above
  200,000 characters has no formatted preview.
- Shared blue/gray design variables are bundled from
  `https://cloud.werdxz.info/shared/styles/variables.css` (2026-09-30 snapshot),
  including system dark mode. The inbox has no runtime stylesheet dependency on
  that host.
- `0006_alias_tags_repair.sql` repairs early databases whose recorded migration
  0001 predates the alias-tags table. It is additive and idempotent; original
  addresses and messages are preserved.
- `src/entry.ts` exports the Cloudflare Durable Object and checks the portable
  Worker handlers against Wrangler-generated runtime types. Deno/UI checks use
  their own runtime libraries to avoid conflicting browser/Worker global types.
  Run `deno task types` after changing bindings. SSE keeps its DO active while a
  visible tab is connected; it is not a hibernating WebSocket.
