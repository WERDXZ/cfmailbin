# Mail workflow

One active workflow controls receipt. Policies return results, IF / Match
selects a route, and Action nodes perform effects. No active workflow means
reject.

## Action chains and consolidation (2026-09-30)

Mail actions share one executor. Legacy readers use the same executor only for
historical trials and migration checks. An `action` node contains an ordered
chain of `tag`, `keep`, `trash`, `forward`, `reply` or `deny` actions. Action
nodes can connect to subsequent nodes. Deny is terminal; a path cannot
forward/reply and then deny. `keep` takes optional `retentionDays` (1–3650);
omission preserves the current/default retention. Historical `set_retention`
actions remain readable without silently changing their disposition. Parameters
accept literal values or explicit `{ref, fallback?}` bindings. Resolve and
validate a chain before starting its effects. Record completed effects, stop on
failure, and never automatically replay forwarding or replies. Trials produce
the same plan/results without external effects.

Context references keep `email.*` and `nodes.<id>.*`; `current.parent.*`
addresses the logical predecessor on the executed route. Optional paths (`?.`)
may read an upstream branch that did not run and return null; required paths
must exist on every incoming route. References never expose downstream/unrelated
nodes, and parent dependencies prevent AI batching. Outputs remain namespaced
and read-only; only explicitly mapped values are sent to AI.

A chain preflights its parameters before any effect. Completed actions are
journaled and persisted before moving on, including before/after native
forwarding. A later failure does not roll back a forward or reapply earlier
effects. Subsequent nodes can add tags or override retention/disposition; `deny`
cannot follow forwarding. The compiler rejects any reachable deny after a
forward action. Only one forward destination is allowed on an executed route;
repeated forwarding to the same address is deduplicated.

Forwarding and rejection checkpoint the stored message before their external
effect. Deleting a message during AI processing prevents a later delivery
action. Tag actions append atomically, preserving concurrent owner edits. D1
uses a
[batch transaction](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
for tag creation and membership insertion; the test adapter exercises the same
rollback contract.

Examples: `tag → keep(retentionDays: 1) → forward`, or
`AI → action(tag from
nodes.classify.data?.category) → action(forward)`. A
binding such as
`{ "ref": "nodes.classify.data?.destination", "fallback": "owner@example.com" }`
uses a fallback only when that upstream value is absent. `current.parent` is the
immediate logical predecessor on the selected route; named `nodes.<id>`
references access other ancestors. No implicit flattening or merging of parent
fields occurs.

## Replies

Reply accepts plain text or an upstream binding, targets the original envelope
sender, and uses the receiving address and original subject. The native reply
builder handles MIME encoding. One reply is allowed per executed route,
including finish actions; repeated replies and reply-then-deny are rejected.
Empty return-path and automated messages are not replied to. No sending
credentials or `send_email` binding is added. Successful replies have a separate
`replied` audit event without their body. Native failures stop the chain and are
not retried.

Cloudflare additionally enforces valid incoming DMARC, matching reply addresses,
and a limit on References entries. See the
[Email Workers reply API](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/#reply-to-emails).
The builder overload is verified against the Wrangler-generated runtime types.

## Policies, nodes and templates

Rules and policies are the same concept. KV `policies:v1` stores up to 50 custom
policies. New version 2 policies configure only a name and condition. There are
no custom success/failure labels or failure reasons. Saving a library policy
removes that old metadata; embedded workflow snapshots remain unchanged.
Historical snapshots still parse their old outcome fields, including v1 actions
for explicit migration. Version 2 cannot contain delivery actions. The creation
templates include `from_trusted_domain`, `contain_warning`, and local-code
predicates. Sender-domain matching is not sender authentication.

An `evaluate` node composes embedded policy snapshots using AND / OR / NOT and
has one `next` edge. Its result object exposes `success: true | false | null`;
null means unavailable or incomplete input. Individual results include the
Policy name and success value for inspection. IF / Match can read
`current.parent.success` or `nodes.<id>.success` to select a route. Unknown
success takes IF's unknown or Match's default edge, never the false branch.
Incomplete content never proves absence; NOT preserves unknown results.
`status`, `matched`, `indeterminate`, and historical outcome arrays remain
readable for existing workflow references. New templates use `success`.

- IF (`condition`): `yes`, `no`, and `unknown` edges.
- Match: one to eight unique scalar cases compared by strict equality, plus a
  mandatory `default` edge. Ports are `case:<id>` and `default`. Incomplete
  inputs take default. A known Policy `status: "unknown"` can have its own case.
- Action: ordered `tag`, `keep`, `trash`, `forward`, `reply`, `deny`. Keep,
  trash, successful forward or reply accepts mail. Keep accepts optional
  literal/bound `retentionDays`; tags and legacy standalone retention do not
  accept mail. Finishing without a disposition rejects.
- Finish: optional `actions` use the same ordered Action executor and input
  bindings, then terminate with no outgoing edge. Empty actions preserve earlier
  disposition; if none exists, v2 rejects. Validation, checkpoints, trial
  simulation, forward deduplication, and the forward/deny conflict checks apply
  equally to finish actions.

The node library stores up to 40 presets in `nodes:v1`, including expandable
fragments of 1–16 nodes. Saved workflows embed snapshots: updating a policy or
preset does not silently change active mail processing. Apply its new revision
explicitly. Legacy presets with delivery-bearing policies are read-only until
converted.

Creation starts with **New**. The main area selects a node type; the optional
right sidebar selects preset values for that type. Templates and saved nodes are
list items, not alternative types or immediate create commands. Selecting or
clearing a preset does not replace the editor draft; only the explicit
Create/Add button does, respecting unsaved-change guards. Cancel changes
nothing. Workflow and Policy creation use the same layout without a type
selector. The sidebar stacks below the main area on small screens. Primary
actions use a heavier underline; cancel/back are muted; presets show a selection
check.

Both node editors offer AI, Policy, IF, Match, Action, Finish, and
data-processing types. The workflow picker also includes saved library nodes
under their type. Multi-node fragments are separate composition presets and
expand into ordinary nodes; they are not built-in node kinds. Blank drafts
cannot be saved until required fields are complete. The entry node is supplied
by a workflow and cannot be added independently.

**Extract verification codes locally** is an optional editable template:
candidate extraction → Policy filtering → source-validated output. Its
predicates check subject hints, candidate context and standalone lines. Output
accepts at most three codes that actually occur in the original subject/body.
Keywords alone do not establish a code. No automatic extraction occurs outside
configured nodes.

Saved workflows, policies and nodes start empty. Template catalogs are separate
from saved library items: loading or selecting one never persists a copy.
Creating from a template fills a draft, which must be saved explicitly. Deleting
the last custom item leaves a usable empty state.

Workflow templates start disabled. The verification template explicitly extracts
codes, keeps the message, then uses IF (no codes and available content) → AI →
IF (success) → source-validated code output. Other/unknown branches finish with
the earlier keep. AI has no hidden extraction, skip or delivery effects.
Classification uses AI → Match → explicit keep/tag actions. Blank contains only
entry → finish, so enabling it rejects everything until accepting actions are
added.

## Contract

- Version 2 is the sole active receipt engine. No saved graph, a disabled graph,
  or a legacy v1 graph rejects before alias creation, MIME parsing, raw storage,
  rule evaluation or AI. Address allowlisting/disabled-address checks still
  apply to active workflows.
- One entry, an acyclic graph of 2–32 nodes and at most eight AI nodes.
  Execution follows one route; reconverging branches are supported, parallel
  fan-out is not.
- AI has an owner-written prompt, input paths and bounded JSON Schema. Only
  configured inputs reach the model. Shared settings choose model and daily
  limit; credentials never enter graph configuration.
- Required references must exist on every incoming route. Optional paths may
  refer to skipped ancestors, never unrelated or downstream nodes. No arbitrary
  expressions or runtime-secret access. `email.codes` holds validated results.
- Admitted messages are stored before node execution. Native forwarding happens
  in the original email event. Reply uses the same event; arbitrary outbound
  email and replying later from the inbox are not implemented.
- New AI nodes (`resultFormat: "envelope"`) return `{success, data, error}`.
  Success has schema-validated data and null error; failure has null data and an
  allowlisted `{reason, message}`. IF / Match decides the next action. Use
  `nodes.ai.data?.field` / `nodes.ai.error?.reason` for nullable reads. Disabled
  AI and quota exhaustion do not call the provider. All batch members validate
  before any output is published; a failed batch returns failure for every
  member. Old snapshots without `resultFormat` keep their direct outputs and
  execution options. The inspector identifies their compatibility settings
  read-only.
- Ordinary storage, input-resolution or action failure stops execution and
  preserves a diagnostic and completed effects; it is never converted to an AI
  result. A failure before any accepting action returns a temporary delivery
  failure after saving the trace when possible. Once native forwarding or reply
  has been attempted, intake does not return an error that could replay that
  irreversible operation; later persistence failure emits only identifiers and
  the disposition in its diagnostic. AI shares a configurable wall-clock
  workflow budget (default 25 seconds), saved as `aiTimeoutSeconds` in KV and
  applied to intake and trials. Existing KV settings without it retain 25
  seconds. Longer waits such as 60 or 120 seconds are supported without
  clamping. Elapsed time since graph start is deducted before each request; the
  remaining budget governs both Gateway's first-response timeout and the
  full-response abort timer. The only numeric upper bound prevents signed 32-bit
  millisecond timer overflow, not CPU usage. Trials may call AI on explicit
  request, but never forward, reply, reject externally, or mutate messages.
- D1 stores execution revision, steps, outputs and final action; R2 stores raw
  mail. Rejection deletes temporary message/raw storage and records an audit.

## Optimizer

Compile and validate before execution. Eliminate unreachable nodes from the
plan. Adjacent independent AI nodes may share one request only when the owner
explicitly assigns the same batch group. Never cross a condition/action, merge
across an input dependency, or batch more than four nodes. Each output is
validated independently and all outputs must validate before proceeding. LLM
batching changes prompt context and is not mathematically equivalent; it is
opt-in, visible and reversible. The editor displays logical nodes and the
compiled plan, including call savings and reasons that adjacent nodes cannot be
merged. The original graph is retained.

Batch requests share input values: two nodes reading `email.text` send the body
only once. Each executed batch counts as one call against the daily AI limit.

## UI

**Settings → Receiving workflow**: node canvas with visible edges,
selection/dragging, node inspector, add/remove/connect controls, sample
templates, save/enable, optimizer plan and a side-effect-free trial using a
selected existing message. Keyboard-operable form controls offer the same
editing as pointer interaction. Mobile canvas scrolls within its container. No
branding or slogans. Each message exposes its run trace.

## Implementation and validation

Use existing TypeScript/Preact/Vite styles, no new runtime dependencies. New
domain code lives in `src/graph/`, UI in `src/ui/`, regression tests in
`tests/`. Keep configuration and runtime validation at boundaries. Example
reference: `{ "subject": "email.subject", "text": "email.text" }`.

Implement contracts/schema/compiler first, then runtime/Gateway and persistence,
then API/editor/trace. Validate cycles, invalid schemas, unavailable inputs,
optimizer dependencies/branch boundaries, failed AI, no duplicate forwarding,
trial isolation, D1 round trips, owner authentication and request-origin checks.

Commands: `deno task test`, `deno task check`, `deno task lint`,
`deno task test:worker`, `deno task ui:build`, `deno task deploy:check`. Verify
the editor in a real browser at desktop and mobile sizes.

Always preserve mail on graph failure and keep secrets out of logs. Do not send
new composed email, change credentials, automatically activate a saved disabled
draft, or merge before verification. Deployment/migration must be reported
separately from local completion.

## Migration and deployment

This change requires explicit activation of a v2 workflow after deployment.
Existing v1 workflows are not executed automatically. Until a new workflow is
saved and enabled, incoming mail is rejected. Prepare and review the migration
at deployment time; this implementation does not deploy or activate it remotely.

`GET /api/graph` returns the saved v2 graph, or `null` when absent or legacy.
The effective graph is `null` when inactive; the plan is `null` when no v2 graph
is saved. It also returns storage kind and migration sources:
`legacy: {rules: number, graph: boolean}`. `PUT /api/graph` accepts v2 only.

`POST /api/graph/migrate` with `{source: "rules" | "graph"}` returns
`{graph, warnings}`. It does not save, enable or execute the result. The editor
loads this disabled draft for review. Migration expands old rules into pure
Policy → IF → Action nodes, preserving priority, scope, stop and accumulated
metadata. Delivery is deferred until the final decision. Unmatched mail and
metadata-only rules reject. Ambiguous forwarding, unsupported graphs, or
expansion beyond graph limits fail explicitly without partial writes.

D1 legacy rules are retained. KV `graph:v1` remains the current configuration
key; before saving v2 over v1, storage copies the v1 configuration to
`graph:legacy:v1`. Migration remains available after saving v2. Original library
entries are retained. KV is eventually consistent, so simultaneous edits across
tabs are not transactional; use one editor at a time.

Apply all existing D1 migrations before updating the Worker, including
`0007_mail_graph.sql` and `0008_audit_history.sql` for persistent audit history.
Historical v1 readers and legacy rule APIs remain for inspection/trials and
migration, not as a live receipt fallback. Mail is never automatically replayed.

Policy API: `GET /api/policies`, `PUT /api/policies/:id`,
`DELETE /api/policies/:id`. Policy GET returns saved `policies` and a separate
`templates` catalog. Node-library GET similarly returns saved `presets` and
`templates`; neither GET populates storage. Writes require the owner session and
same-origin request header. PUT enforces pure v2 definitions and current
revision, returning 409 on ordinary stale edits. `builtin_` IDs are read-only.
Node-library PUT may include a `fragment`. Conditions and output schemas remain
bounded data, with no executable code or arbitrary regular expressions.
