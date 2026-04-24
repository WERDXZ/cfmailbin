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
- parsed message body snapshots

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
- `D1` stores aliases, rules, tokens, messages, tags, and message-tag links
- `R2` stores raw MIME bodies
- bearer-token auth is intentionally minimal
- tokens are inserted manually in `D1`
- blocked or unknown aliases are rejected instead of stored
- catch-all mode auto-creates aliases on first inbound mail when enabled

## Non-Goals For V1

- sending mail as any alias
- full IMAP or SMTP support
- permanent storage
- advanced threading
- multi-user collaboration

## Open Questions

- Should we keep raw tokens in `D1` or move to hashed tokens later?
- Do we want per-alias forward targets only, or also multiple global targets?
- Should we parse and store text previews from MIME bodies instead of using the
  subject as a temporary preview?
