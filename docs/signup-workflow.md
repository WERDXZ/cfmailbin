# Personal inbox workflow

## Objective

The owner primarily registers accounts and receives verification codes. The UI
is a direct personal utility: no slogans, hero sections, decorative steps or
setup form above the inbox. Addresses are remembered on first receipt. Creating
an alias is an optional advanced action, not a daily prerequisite.

## Daily interaction

1. With domain catch-all configured, type an ordinary address into a website.
2. Open the inbox: newest messages first, sender/recipient/relative time and
   code candidates in each row. Click a code to copy; click mail to expand text.
3. Visible pages receive SSE updates (30-second polling only on failure), with
   immediate refresh on focus or return. Hidden pages pause. New messages
   preserve the selected body and clipboard.
4. Search website notes, addresses or mail. Remembered addresses survive message
   retention cleanup and remain available for copying and future account
   recovery.
5. Settings contain domain/setup status, retention, explicit aliases and rules.

## Implementation

- Existing Preact/Deno/Worker/D1/R2 architecture and Access authentication
  remain.
- Additive migration `0003_inbox.sql` stores code candidates and alias receipt
  history. Apply it before deploying code that uses these columns.
- Intake extracts candidates once; polling reads D1 metadata, not R2 blobs.
  Legacy mail uses subject/preview fallback until its full content is opened.
- `GET /api/inbox` aggregates filtered messages, aliases and delivery evidence.
  All API routes require the same owner authentication and no-store behavior.
- Receipt/rejection audit records are used for connection history, scoped to the
  configured domain; empty lists and app-created aliases do not verify routing.
- Delivery UI distinguishes local development, no successful receipt yet, latest
  receipt, rejection and backend failure. It does not claim to synchronize CF
  rules.
- Copying preserves leading zeros, provides clipboard failure fallback, and
  never occurs automatically on arrival. Code identification remains heuristic.
- Plaintext rendering, bounded MIME parsing, raw downloads, tags and message
  management retain their existing behavior.

## Verification (2026-09-29)

- Deno tests cover authentication, APIs, MIME and code extraction, intake and
  retention. Shared memory/D1 storage checks use SQLite with the real
  migrations; tests cover old data preservation, receipt history after deletion,
  legacy code fallback, domain filtering and no raw-body reads during inbox
  polling.
- Isolated Chromium checked the running dev page, then simulated API replies
  without modifying the owner's data. Covered first-receipt status, focus
  refresh, list-level code copying, no eager body fetch, arrival while reading
  older mail, search for an address after all its mail is removed, offline
  recovery, denied clipboard fallback, hidden-tab pause/resume and
  expired-session handling.
- Desktop/mobile screenshots inspected. Widths 320, 390, 768, 1024 and 1440 have
  no horizontal overflow. No page errors or third-party requests in tested
  flows.
- Real Cloudflare delivery and Access sign-in are not verified locally. No
  deployment, account configuration or live mail sending was performed.
