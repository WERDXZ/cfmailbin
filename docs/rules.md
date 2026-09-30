# Expressive inbox rules

Rules belong to cfmailbin's inbound processing, not Cloudflare Email Routing. An
enabled address must first reach the Worker. Existing routes, disabled-address
handling and authentication remain unchanged.

## Contract and behavior

- Conditions combine ALL, ANY and NOT groups with address, envelope sender,
  sender domain, subject, plaintext body or detected verification-code checks.
- Text comparisons are case-insensitive: equals, contains, starts with, ends
  with and glob (`*` and `?`). Globs match the whole field; other regex syntax
  is literal. Trees are limited to 4 levels and 32 nodes.
- Each rule may set one delivery action (keep, forward, trash or reject), append
  tags and override retention (1–365 days). Tag-only rules preserve delivery.
- Rules run in ascending priority, then creation time and ID. Tags accumulate;
  the last matched delivery/retention setting wins. Forwarding happens only
  after evaluation finishes. Stop-processing ends evaluation; rejection always
  stops.
- Incomplete/unavailable body parsing produces unknown results where a decision
  cannot be made. NOT does not turn unknown into a match. Unknown rules do not
  execute, and their trace explains why.
- New fields and migration 0004 preserve legacy single-condition rules and their
  effective order (address-specific rules before global rules, oldest first).
- Trial runs evaluate a draft against the latest 20 matching existing messages,
  in the current rule order. They never save rules, update mail or
  forward/reject. Replacing an existing rule in a trial uses its ID; a new draft
  is appended.
- New messages retain the matching rule names, conditions and effects as a
  historical trace. Later editing rules does not rewrite that explanation.

## Templates and interface

Templates fill an editable draft and are never installed automatically:
verification codes (tag + 1-day retention), recovery/activation mail (keep 30
days), newsletters (trash, with account-email exclusions), per-site labelling,
and account-alert forwarding (requires a destination). No rejection template.

The compact rule editor provides groups, exclusions, additional effects,
ordering, enable/disable, editing and trial results. Retention affects new
messages only. Templates are starting points; detection and keyword matching are
heuristic.

## API and deployment

- `POST /api/rules` accepts structured condition/actions or the legacy field,
  pattern and action payload. `PATCH /api/rules/:id` changes only supplied
  fields. Condition/actions objects are replaced as a whole when supplied.
- `POST /api/rules/preview` accepts `{ draft, ruleId? }`. The optional ID
  identifies the rule to replace in the simulation. No new mailbox or email is
  created.
- `POST /api/rules/reorder` accepts `{ ids }` containing each rule ID exactly
  once; stale/incomplete lists receive 409. Apply migration 0004 before
  deployment.
- Reordering uses one parameterized update with the D1-supported
  [json_each function](https://developers.cloudflare.com/d1/sql-api/query-json/).
- Intake parses MIME before executing the final forwarding action, consistent
  with Cloudflare
  [email routing examples](https://developers.cloudflare.com/email-service/local-development/routing/).

## Verification

45 Deno tests, type checks, lint, formatting and the production UI build pass.

Memory and SQLite/D1 contract tests exercise trial/receipt parity, historical
traces, overrides and stop behavior. Isolated Chromium ran the real HTTP API and
processor against synthetic mail on a separate local fixture server: draft-only
templates, read-only trials, nested conditions, tags, edit/order/toggle
operations, forwarding-destination validation and stored intake traces. No real
emails were sent and the owner's development data was not used. Responsive
checks cover 320, 390, 768, 1024 and 1440px.
