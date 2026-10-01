# Everyday use

## Receive a verification code

1. After connecting your domain's catch-all route and saving an enabled
   receiving workflow, use an ordinary address such as `github@example.com` when
   registering on a website. You do not need to create the address in cfmailbin
   first or use a `+` tag.
2. Open cfmailbin. Messages appear newest first, with detected codes beside each
   message. Click a code to copy it, and check the sender, recipient and time on
   the same row. If no code appears, open the message to read its body.
3. While the page is visible, SSE keeps the inbox up to date. It reconnects
   automatically and falls back to checking every 30 seconds if the connection
   fails. Returning to the tab or window triggers an immediate check; hidden
   pages pause updates. New mail does not replace the expanded message or
   overwrite your clipboard.
4. Used addresses stay in the sidebar. Search finds both mail and remembered
   addresses using website notes, addresses, senders, subjects and body
   previews. Use **Copy** beside an address to reuse it.
5. Save the registration address with the account in your password manager. Use
   the same address for future sign-ins and account recovery. Selecting an
   address in the sidebar filters its mail; there is no separate waiting mode.

The list shows up to 100 matching messages at a time. Search can find older
messages. Links are available after opening a message and are never visited
automatically. If clipboard access is denied, the app provides selectable text
for manual copying.

## Connect your domain

For a new installation, follow the [deployment guide](deploy.md) to create
storage, upload the Worker and protect the dashboard before connecting mail.

1. Enable your domain in Cloudflare Email Routing and configure its email DNS
   records.
2. Point the domain's catch-all route to the cfmailbin Worker. Check the purpose
   of an existing catch-all before replacing it. cfmailbin does not create or
   read Cloudflare routing rules, and does not change DNS.
3. Configure the initial defaults in `[vars]` in `wrangler.toml`:

   ```toml
   CFMAILBIN_EMAIL_DOMAIN = "example.com"
   CFMAILBIN_ALLOW_CATCH_ALL = "true"
   CFMAILBIN_DEFAULT_RETENTION_DAYS = "7"
   ```

   Cloudflare's catch-all delivers mail to the Worker. The app's
   `CFMAILBIN_ALLOW_CATCH_ALL` allows previously unknown addresses into the
   receiving workflow and remembers them when accepted. The enabled workflow
   decides whether to accept each message. Setting a domain variable alone does
   not create a route.
4. Connect your D1, R2 and KV resources and configure
   [Cloudflare Access](access.md). Before deploying, use Wrangler to apply all
   pending migrations in `src/db/migrations`, currently `0001` through `0008`.
   They preserve existing data while adding inbox metadata, rule traces, AI
   results, workflow records and audit history. Apply them even if AI is off;
   `0006_alias_tags_repair.sql` also repairs the missing alias-tag table in
   early installations.
5. Open **Settings → Receiving workflow → New workflow**, select **Verification
   mail**, review the draft, then save and enable it. An absent, disabled or
   legacy workflow rejects incoming mail by default. Send a test message from
   another mailbox to a new address on your domain. In **Settings → Receiving**,
   check **Receiving status** and confirm that the new address appears in the
   sidebar. Before the first successful receipt, the status is **No confirmed
   mail receipt**.

The checked-in deployment configuration allows unregistered addresses. If you
set `CFMAILBIN_ALLOW_CATCH_ALL` to `false`, first use **Register an address** in
**Settings → Receiving**; unknown addresses will otherwise be rejected. The
unconfigured local backend also defaults to `false`.

## Settings and retention

The settings page is available at `/settings`, with Receiving, Receiving
workflow, Rules (Policy), Node library, AI and Account sections. Receiving
preferences, the AI switch, model, quota and timeout can be saved without
changing code or redeploying.

Production preferences live in KV and may take about a minute or longer to
propagate between locations. Mail, legacy rule records and exact daily AI call
counts live in D1. Credentials and Access identity remain deployment settings.
Receiving and AI defaults come from deployment variables; once saved, KV
settings take precedence. Local settings reset when the development server
restarts.

**Settings → Account → Language** defaults to **Use browser language**. You can
instead select **Original (Simplified Chinese)** or **English**. Language
selection follows this order:

1. An explicit browser cookie preference.
2. An explicit account language.
3. The browser locale.
4. English if the browser locale is unavailable or unsupported.

Chinese (`zh`) locales and their regional variants use Simplified Chinese. Older
settings without a language use the same automatic default; an existing Chinese
or English choice is retained. Detection does not write preferences or change
URLs. A browser choice takes effect immediately and lasts one year; **Use
account default** removes that cookie. Saving an account language writes it to
KV for browsers without an override. Language changes affect interface text and
dates. Mail, AI inputs and outputs, prompts, custom names and historical audit
content stay in their original language.

**Addresses are long-lived; messages are temporary.** The default retention is
seven days, with hourly cleanup of expired messages and their raw originals.
Cleanup does not remove addresses or their last-received time. Select an address
and open **Address settings** to add a website/purpose note, change retention
for future mail or disable receiving. Retention changes do not alter existing
messages.

Disabling an address also rejects sign-in and account-recovery mail, so enable
it again before use. Settings contain workflow configuration and manual address
registration. Tags, message status, permanent deletion and `.eml` downloads are
available inside an expanded message.

## Policies, workflows and templates

**Settings → Rules (Policy)** defines conditions and their results, such as
whether the sender is from a trusted domain or the body contains warning terms.
Combine Policies with AND, OR and NOT in a node. A Policy returns
`success: true` or `false`, or `null` when the input is incomplete. The trace
records its name and result without requiring extra branch markers or failure
text. An IF or Match node can read `current.parent.success` to select the next
step; Actions then keep, forward, reject or tag the mail. Incomplete text cannot
establish that a term is absent, so that case follows the unknown or default
branch.

Click **New workflow** to start blank or choose a verification-mail or AI
classification template. Review, save and enable the resulting draft. **Add
node** and the node library's **New node** dialog select a type in the main area
and optional preset values in the right sidebar. Selecting a preset only changes
the preview; **Create** or **Add** creates the draft, and **Cancel** leaves
existing content alone.

AI, Policy, IF, Match, Action and Finish are node types. Local code extraction
is an editable composite template that expands into ordinary nodes. Saved nodes
are grouped by type; selecting or cancelling a template does not save anything.
A Finish node can run an action chain before ending. Without an acceptance
action earlier in the path or in Finish, the message is rejected.

The verification template combines candidate extraction, Policy filtering,
source validation, Keep, IF, AI and output nodes. Each can be edited. AI nodes
return `success`, `data` and `error`; branches determine what to do on failure.
Codes still pass source validation before appearing in the inbox. A path that
finishes without Keep, Trash, a successful Forward or a successful Reply rejects
the message. Forward destinations are explicit Action parameters; they are not
inherited from legacy address or global defaults.

Legacy rules and workflows can be imported as disabled drafts. Import preserves
the original configuration and does not process historical mail or send
anything. Unsupported conversions report a reason. Legacy rules do not remain
active as a second receiving engine. Trial runs show node results without
modifying mail, forwarding or replying; explicitly running a trial with AI nodes
may use the model quota.

**Keep** accepts a retention period as a fixed value or upstream output. Leaving
it unset uses the default. **Reply to sender** accepts plain text or upstream
output and uses the original subject. A message can receive at most one reply;
success appears in the audit log. A reply can be followed by forwarding or
tagging, but cannot be followed by rejection. See the
[workflow reference](mail-graph.md) for contracts and execution details.

## When mail does not arrive

- **Connection failed; retrying** means the browser could not fetch a fresh
  result. The visible list may be stale until automatic retries succeed.
- **No confirmed mail receipt** means the configured domain has no recorded
  successful receipt. It does not confirm that routing is configured.
- **Last received** comes from the app's persistent receipt history. It does not
  read Cloudflare configuration or guarantee future delivery. Deleting a message
  does not erase that receipt evidence.
- Receiving settings show the latest rejection and distinguish unknown
  addresses, disabled addresses and workflow rejection.
- Check the address entered on the website, domain DNS, Email Routing's Worker
  target, address status, acceptance of unknown addresses and the enabled
  receiving workflow. The inbox shows all message statuses by default so that
  trashed messages are not hidden.
- Some websites reject entire custom domains. Avoiding plus tags does not
  guarantee acceptance everywhere.

## Codes, AI and message bodies

Optional AI fallback uses Cloudflare AI Gateway with BYOK to call DeepSeek Flash
or GPT-5.6 Luna. Calls occur only when execution reaches an AI node in an
enabled workflow. The verification template calls AI only if local extraction
found no code, and results appear through live inbox updates. Merely enabling AI
in settings does not add nodes to a workflow.

The shared daily limit defaults to 100 calls. AI settings also configure a
workflow-wide waiting timeout in whole seconds: 25 by default, with longer
values such as 60 or 120 supported. KV stores this setting. The budget starts
when the workflow starts, and each AI request uses the remaining time. A timeout
returns `error.reason = "timeout"` for subsequent branches to handle. See
[AI setup and cost notes](email-analysis.md).

Code extraction uses surrounding context, including common English and Chinese
hints. It supports four-to-eight-digit numbers, mixed letters and numbers, and
grouped six-digit codes, with at most three candidates. Leading zeros and letter
case are preserved. **A displayed code is not a guarantee that it is still
valid.** Use the sending website's expiry window and the latest message.

New messages run only the extraction nodes configured in their workflow. Legacy
messages use saved subject/preview text in the list and supplement the result
when the full body is opened. Refreshing the list does not read raw MIME. Common
formats include plaintext, HTML, Base64 and Quoted-Printable. Bodies default to
plaintext; an optional isolated HTML preview does not load remote images or
execute scripts. Attachments remain in the `.eml` download.

Raw messages larger than 1 MiB are not parsed for the dashboard; malformed
messages also offer the original download. Displayed text is limited to 50,000
characters. Raw originals remain subject to message retention.

## Local development

Run `deno task dev` and `deno task ui:dev` in separate terminals, then open
`http://127.0.0.1:5173`. The local server stores data in memory and resets it on
restart. It does not receive Cloudflare email. Test real domain delivery and
Access sign-in against a configured deployment.

## See what happened

Open **Audit log** in the sidebar (`/audit`) to filter by event, time, address,
subject, reason or actor. Details show executed nodes, branches, duration,
failures and forwarding destinations. **Records for this receipt** groups a
single delivery; **All records for this email** includes later edits and
deletion. Successful replies have a separate **Replied** event. Trial runs have
their own event type and do not indicate actual forwarding or replies. Use
**Refresh** to load the latest records.

Successful changes to settings, workflows, Policies, library nodes and addresses
record the actor and resource identifiers. Audit history is stored separately in
D1, survives message cleanup and currently has no automatic expiry. It contains
addresses, subject previews and execution status, not a second copy of message
bodies, full AI outputs or credentials. Older events remain readable, but node
details that were never recorded cannot be recovered. This is operational
history, not a tamper-proof audit system.
