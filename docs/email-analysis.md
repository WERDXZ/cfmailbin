# Optional AI analysis

Verification-code extraction is an optional workflow template. Without an
enabled current receiving workflow, incoming mail is rejected and no model is
called. The **Verification mail** template extracts codes locally, explicitly
keeps the message, then uses IF to decide whether to call AI. A successful
result passes through an output node that validates codes against the source
text. Live inbox updates show the result in the list and expanded message.

The AI switch only permits model calls; it does not add receiving behavior.
Custom workflows can change nodes, input mappings, output schemas and execution
order. See the [workflow reference](mail-graph.md) for generic AI nodes and
branching on their results.

The application supports DeepSeek V4.1 Flash (`deepseek-flash`, the default) and
OpenAI GPT-5.6 Luna (`gpt-5.6-luna`). It calls provider-native HTTP endpoints
through Cloudflare AI Gateway without an extra SDK: DeepSeek uses Chat
Completions and OpenAI uses Responses, without a protocol compatibility layer.

## Gateway costs

The project's pricing check on September 29, 2026, recorded AI Gateway's core
analytics, caching and rate limiting as free on all plans. Model inference was
still billed by DeepSeek or OpenAI. This integration uses BYOK, billed directly
by the provider, rather than Cloudflare's unified credits. The recorded credit
purchase fee was 5%.

That check also recorded separate logging terms: customers creating their first
Gateway from September 24, 2026, used Workers Logs pricing and retention. Each
app request disables Gateway request logging, caching and automatic retries, and
sets `cf-aig-no-wholesale: true` to prevent fallback to Cloudflare prepaid
credits when BYOK is unavailable. These settings do not change Worker, D1 or R2
billing.

These are dated setup notes, not a current price guarantee. Check
[AI Gateway pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/)
and the
[credential and billing controls](https://developers.cloudflare.com/ai-gateway/glossary/)
before enabling paid calls.

## Model price snapshot

The following standard prices were recorded on September 29, 2026, in USD per
million tokens, with uncached input:

| Model                         | Input | Output | Example cost per 1,000 messages |
| ----------------------------- | ----- | ------ | ------------------------------- |
| DeepSeek V4.1 Flash, off-peak | $0.15 | $0.60  | $0.21                           |
| DeepSeek V4.1 Flash, peak     | $0.30 | $1.20  | $0.42                           |
| GPT-5.6 Luna, short context   | $0.20 | $1.20  | $0.32                           |

The example assumes 1,000 input tokens and 100 output tokens per message. It is
not a usage guarantee and excludes cache discounts and Cloudflare charges.
Actual usage depends on message length and model tokenization.

The recorded DeepSeek peak periods were Monday through Friday, excluding Chinese
public holidays, 09:00–12:00 and 14:00–18:00 China Standard Time. Other times
were off-peak. Under those prices and the example workload, DeepSeek was cheaper
off-peak and Luna was cheaper during peak periods with uncached input. DeepSeek
is the default for the project's expected off-peak use, not because it is always
cheapest. The app does not switch providers by time of day.

Check current prices at
[DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/),
[DeepSeek CNY pricing and billing periods](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)
and [OpenAI pricing](https://developers.openai.com/api/docs/pricing).

## Setup

1. Apply all pending D1 migrations, including `0005_email_analysis.sql`. It adds
   nullable analysis fields and a daily call-count table without changing
   existing message contents or rules. The application needs these migrations
   even when AI is disabled. Follow the [deployment guide](deploy.md).
2. Create an AI Gateway in Cloudflare, for example `cfmailbin`. Enable
   **Authenticated Gateway** and create a token with **AI Gateway Run**
   permission. Save the selected provider's API key in the Gateway's BYOK
   configuration under the `default` alias. Use a DeepSeek key for DeepSeek or
   an OpenAI key for OpenAI.
3. Configure Worker variables. The Account ID is your Cloudflare account ID, not
   the Zone ID:

   ```toml
   CFMAILBIN_AI_ENABLED = "true"
   CFMAILBIN_AI_PROVIDER = "deepseek"
   CFMAILBIN_AI_DAILY_LIMIT = "100"
   CFMAILBIN_AI_GATEWAY_ACCOUNT_ID = "your-32-character-cloudflare-account-id"
   CFMAILBIN_AI_GATEWAY_ID = "cfmailbin"
   ```

4. Enter the Gateway token interactively and deploy:

   ```sh
   deno task wrangler secret put CF_AIG_TOKEN
   deno task deploy
   ```

   Do not put secrets in command arguments, `wrangler.toml`, frontend variables
   or version control. Alternatively, the provider key can be a Worker Secret
   named `DEEPSEEK_API_KEY` or `OPENAI_API_KEY`; that key takes precedence over
   Gateway BYOK. Both options still route requests through the Gateway.
5. Disable response caching and logging in Gateway settings as well; the app's
   request headers also disable them. In **Settings → AI**, enable calls, choose
   a model and review the quota and timeout. Saved KV preferences override
   environment defaults. Add an AI node to an enabled workflow, or use the
   verification template, then test a representative message.

The configuration status only confirms that required local configuration is
present. It does not make a paid request to validate the token or remotely
stored BYOK key. Failures distinguish authentication, billing, rate limits,
timeouts, rejected requests, service errors, network failures and invalid
responses. Available diagnostics include HTTP status; that status alone cannot
determine whether authentication failed at the Gateway or the provider. The app
never bypasses the Gateway to call a provider directly.

The Gateway token and provider key are separate credentials. The token is sent
to Cloudflare in `cf-aig-authorization`. A provider key configured on the Worker
uses `Authorization`. With Gateway-stored BYOK, `Authorization` is omitted
rather than filled with a placeholder that could override the stored key.

References:
[Gateway authentication](https://developers.cloudflare.com/ai-gateway/configuration/authentication/),
[BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/).

For local development, put variables and secrets in the Git-ignored `.dev.vars`
file, then run:

```sh
deno run --env-file=.dev.vars --watch --allow-env --allow-net src/main.ts
```

The local HTTP server does not receive real Cloudflare email. Viewing historical
messages alone does not call AI.

## Cost and execution limits

- The application's unconfigured default is AI off. The checked-in deployment
  variables belong to the maintainer's instance and explicitly enable it;
  replace those values for your deployment. Calls require enabled AI, a
  configured Gateway and provider credentials.
- The shared daily limit defaults to 100 and supports 0–1,000. Zero pauses
  calls. D1 reserves quota atomically by UTC date, and failed provider requests
  still consume a reserved call. Local in-memory counts reset on restart. An
  optimized batch of independent AI nodes counts as one call.
- Each delivery runs the workflow once. Refreshing the list, opening a body and
  legacy-rule previews do not call AI. Explicit workflow trials may call AI and
  consume quota, but do not forward, reply, reject or modify mail. Failed
  requests are not automatically retried, and historical mail is not backfilled.
  Separate duplicate deliveries can still produce separate records.
- The verification preset maps at most 500 subject characters and 12,000 body
  characters. It does not send attachments or raw MIME. Custom AI nodes send
  their configured inputs, which can include addresses or upstream outputs.
  Inputs may contain codes and other private information, sent through
  Cloudflare to the selected provider. `cf-aig-collect-log: false` disables
  Gateway request logging and `cf-aig-skip-cache: true` bypasses Gateway
  caching; neither promises zero retention by the provider.
- Both providers are requested with thinking disabled. AI nodes share a
  configurable waiting budget, defaulting to 25 seconds and allowing longer
  values such as 60 or 120. It starts when the workflow begins. Each request
  uses the remaining budget for both Gateway first-response timeout and the
  full-response abort timer. This is an application deadline, not a CPU limit;
  network waiting does not count toward
  [Workers CPU time](https://developers.cloudflare.com/workers/platform/limits/#cpu-time).
  Requests and responses are bounded; responses are limited to 64 KiB. OpenAI
  Responses uses `store: false`, which does not disable all provider logging.
- Email content is untrusted data. The model has no tools and does not visit
  links. Results pass schema type and enum validation. Before a code reaches the
  inbox, it must occur in the source text; case and leading zeros are preserved,
  while display spaces and hyphens may be joined. This rejects invented codes
  but cannot guarantee that an order number will never be mistaken for a code.
- The verification template calls AI only when no local code was found and a
  subject or body is available. A negative result from truncated text remains
  unknown; failure to find a code does not prove that none exists. The template
  explicitly keeps mail before AI, so model failure or quota exhaustion leaves
  the message and local results available to read. Custom workflows choose their
  own acceptance and failure behavior.

## Results and failures

New AI nodes return an envelope:

```json
{
  "success": true,
  "data": { "category": "other" },
  "error": null
}
```

`data` follows the node's configured schema. On failure, `success` is `false`,
`data` is `null` and `error` contains an allowlisted `reason` and `message`. IF
or Match can read `current.parent.success`, `nodes.ai.data?.field` or
`nodes.ai.error?.reason` to choose the next action. Disabled AI, missing Gateway
configuration and exhausted quota do not call the provider. Ordinary storage,
input-resolution and action errors still stop execution; they are not model
results.

The verification template checks success before passing codes to its output
node. Validated codes are persisted in `verification_codes`. Custom workflows
can pass other AI outputs into Policies or Actions. Completed actions are saved
separately, so a later AI failure does not erase a forwarding record.

Older AI snapshots without `resultFormat: "envelope"` retain their compatibility
behavior: ordinary AI failures stop execution, while optional nodes record the
failure and continue. Legacy verification analysis is stored in
`messages.analysis_json`, with available failure category, HTTP status, request
phase and duration. Legacy failure warnings contain node ID, provider and those
diagnostic fields, not mail contents, keys or raw upstream error bodies. Errors
whose details were discarded by older versions cannot be reconstructed and show
**Analysis failed (reason not recorded)**.

Turning off AI affects subsequent calls, not requests already in flight.
Platform interruptions do not trigger automatic retries. Inspect the workflow
trace and [audit log](usage.md#see-what-happened) to see the path actually
taken.

Protocol references:
[DeepSeek API introduction](https://api-docs.deepseek.com/zh-cn/),
[DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/),
[Luna model](https://developers.openai.com/api/docs/models/gpt-5.6-luna),
[OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

Gateway references:
[DeepSeek native endpoint](https://developers.cloudflare.com/ai-gateway/usage/providers/deepseek/),
[OpenAI native endpoint](https://developers.cloudflare.com/ai-gateway/usage/providers/openai/),
[Request controls](https://developers.cloudflare.com/ai-gateway/configuration/request-handling/),
[Logging](https://developers.cloudflare.com/ai-gateway/observability/logging/),
[Caching](https://developers.cloudflare.com/ai-gateway/features/caching/).

## Validation scope

Automated tests cover both provider protocols, source validation, leading zeros,
truncated results, timeouts, response-size limits, provider failures, workflow
intake, concurrent daily quotas, D1 persistence, deletion races and keeping
secrets out of API responses. Gateway tests cover URLs, both credential modes,
headers disabling cache/logging/unified billing/retries, incomplete or invalid
configuration and the absence of direct-provider fallback.

`deno task test:worker` uses the deployment toolchain's real workerd runtime
with a mock upstream. It verifies that both provider requests can be sent and
redirects do not forward mail or credentials. Requests use `redirect: "manual"`
and reject non-success responses; the tested workerd runtime does not accept
`redirect: "error"`.

Browser checks use isolated synthetic mailboxes and mocked model responses to
verify display and copying. This test coverage does not measure real-model
accuracy, latency or cost with production keys. Sample your own typical messages
before relying on the results.
