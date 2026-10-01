# Deploy to Cloudflare

The frontend and API deploy together to one Worker. D1 stores message metadata,
addresses and audit history; R2 stores raw mail; KV stores preferences and
workflow configuration. Cloudflare Access protects the dashboard, and Email
Routing passes incoming mail to the Worker. AI Gateway is optional.

Each deployment is a single-owner inbox. For independent inboxes, deploy a
separate instance for each owner. The steps below describe a new installation;
for an existing instance, see
[Update an existing deployment](#update-an-existing-deployment).

`main` contains a portable `wrangler.toml`: resource IDs are zero placeholders,
identity and Gateway fields are commented examples, and catch-all/AI defaults
are off. Configure your own Worker, account, resources and identity before
running remote commands. Keep the binding names used by the code: `DB`,
`RAW_EMAILS`, `SETTINGS` and `INBOX_EVENTS`.

## Keep deployment configuration separate

Keep application changes on `main`. Create a local `deploy` branch with only
your instance configuration and optional deployment notes. A separate worktree
lets both branches stay checked out:

```sh
# From the main checkout, once. Pick an unused sibling directory.
git worktree add ../cfmailbin-deploy -b deploy main
cd ../cfmailbin-deploy
```

Complete the setup below in that directory, then commit `wrangler.toml` on
`deploy`. Keep tokens and provider keys in Worker Secrets; `.dev.vars` and
`.env*` are ignored. Do not merge `deploy` into `main`.

For later updates, start with a clean deployment worktree:

```sh
# Update the main checkout first, then run in the deploy worktree.
git rebase main
deno install --frozen --allow-scripts=npm:esbuild,npm:workerd
deno task deploy:check
# Review and apply pending migrations as described below, then:
deno task deploy
```

If `wrangler.toml` conflicts, keep your resource IDs and identity while adopting
new bindings or migrations from `main`. Rebase keeps the deployment branch as a
small configuration commit on top of current application code. Review the diff
with `git diff main -- wrangler.toml` before deploying.

A local branch does not need an upstream remote. Pushing `deploy` to a public
repository publishes its configuration too; use a private remote if you want a
remote copy without publishing it.

## 1. Install tools and sign in

Install Deno 2 and Node.js (24 LTS is recommended). The project pins Wrangler in
`deno.json`; Deno installs the dependencies and Node.js runs the CLI. A global
Wrangler installation is not needed.

From the repository root, run:

```sh
deno install --frozen --allow-scripts=npm:esbuild,npm:workerd
deno task wrangler login
deno task wrangler whoami
```

Login opens a browser. Confirm that the selected Cloudflare account hosts your
receiving domain. If you have multiple accounts, set the top-level
`account_id = "your-cloudflare-account-id"` in `wrangler.toml` so resource
creation and deployment use the same account.

Reference:
[Install Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/).

## 2. Create storage

Enable R2 in the Cloudflare dashboard, then create the D1 database and private
R2 bucket:

```sh
deno task wrangler d1 create cfmailbin --update-config=false
deno task wrangler r2 bucket create cfmailbin-raw-emails --update-config=false
```

Replace `database_name` and `database_id` in the existing `[[d1_databases]]`
block with your database name and the returned ID. Keep the binding name `DB`.
Set `bucket_name` to your R2 bucket name and keep its binding name `RAW_EMAILS`.
If those resources already exist in your account, check their purpose before
reusing them. An existing deployment should keep its current database and
bucket.

Production uses `bucket_name`. The optional `preview_bucket_name` is for
Wrangler remote development; you do not need to create that bucket for a
production upload. Create a separate preview bucket before using remote
development. Raw mail is read through authenticated Worker endpoints, so the R2
bucket stays private.

Create a settings KV namespace:

```sh
deno task wrangler kv namespace create cfmailbin-settings --binding SETTINGS
```

Replace the ID in the existing `SETTINGS` binding with the returned namespace
ID. Reuse the existing ID when updating an instance. Deployment creates the
`INBOX_EVENTS` Durable Object through the `inbox-events-v1` SQLite class
migration. Keep that migration entry on later deployments. The object
distributes refresh notifications; mail remains in D1 and R2.

Receiving and AI variables in `[vars]` supply initial defaults. Preferences
saved at `/settings` live in KV and take precedence without redeployment. Access
identity, Gateway identifiers and secrets remain deployment configuration.

References:
[D1 commands](https://developers.cloudflare.com/d1/wrangler-commands/),
[Create an R2 bucket](https://developers.cloudflare.com/r2/buckets/create-buckets/).

## 3. Configure defaults and upload the Worker

Replace the values in the existing `[vars]` block with your own:

```toml
CFMAILBIN_EMAIL_DOMAIN = "example.com"
CFMAILBIN_OWNER_EMAIL = "owner@example.net"
CFMAILBIN_ALLOW_CATCH_ALL = "true"
CFMAILBIN_DEFAULT_RETENTION_DAYS = "7"
CFMAILBIN_AI_ENABLED = "false"
```

Use your actual receiving domain and an existing mailbox for the owner's
sign-in. The dashboard can use the `cfmailbin.<your-subdomain>.workers.dev` URL
returned by deployment; its hostname need not match the email domain. Leave the
example Access and AI Gateway fields commented until you configure your own in
the following steps. Keep AI off for this initial setup.

```sh
deno task wrangler d1 migrations list DB --remote
deno task wrangler d1 migrations apply DB --remote
deno task deploy:check
deno task deploy
```

Apply all pending migrations from `0001` through `0008` to the remote database,
even if AI is disabled. The application needs the analysis columns from `0005`;
the audit page needs `0008_audit_history.sql`, which preserves existing records.
Do not manually repeat `ALTER TABLE` statements from migrations already applied.

`deploy:check` builds the frontend, bundles the Worker and checks configuration.
It does not upload or verify that remote resources exist. `deploy` builds again
and uploads both frontend and backend. No separate Pages project is needed.

The initial upload creates the Worker so you can configure Access. Without valid
Access configuration, the API refuses access. Complete the next step before
using the dashboard or directing mail to this Worker.

References:
[Deployment commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/),
[D1 migrations](https://developers.cloudflare.com/d1/wrangler-commands/#d1-migrations-apply).

## 4. Restrict dashboard access to the owner

1. Enable Zero Trust and configure Cloudflare as an identity provider so you can
   sign in with your existing Cloudflare account.
2. Open **Workers & Pages → your Worker → Access → Protect this Worker behind
   Access**, and select **All traffic**.
3. In the associated Access application, select Cloudflare as a login method.
   Limit the Allow policy's Emails selector to your exact owner address. Remove
   broader Allow or Bypass policies from this application.
4. Copy the application's AUD and your Zero Trust team domain into `[vars]`:

   ```toml
   CFMAILBIN_ACCESS_TEAM_DOMAIN = "your-team.cloudflareaccess.com"
   CFMAILBIN_ACCESS_AUD = "your-access-application-aud"
   ```

   The team domain has no `https://` prefix. The AUD is not the Cloudflare
   Account ID. `CFMAILBIN_OWNER_EMAIL` must match the email allowed to sign in.
5. Run `deno task deploy` again to publish these variables.
6. Open the deployment URL in a private browser window. It should require
   sign-in before showing the inbox; after sign-in, the sidebar shows your
   email.

Worker-level Access protection also covers custom domains added to this Worker.
It protects HTTP traffic; senders do not need to sign in before delivering mail.
See the [Access setup guide](access.md) for details.

References:
[Worker Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/),
[Cloudflare identity provider](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/cloudflare/).

## 5. Connect incoming mail

1. In Cloudflare's **Email Service → Email Routing**, enable the receiving
   domain, configure the required MX/TXT records and verify any forwarding
   destinations. If the domain already uses another mail service, check its MX
   records before changing the receiving system.
2. In cfmailbin, open **Settings → Receiving workflow → New workflow**, select
   **Verification mail**, review the draft, then save and enable it. Mail is
   rejected by default until a current workflow is enabled.
3. In Cloudflare's **Routing Rules**, enable **Catch-all**, choose **Send to a
   Worker**, and select your Worker. Changing an existing catch-all changes
   where those messages go.
4. Send a test message from another mailbox to `test@example.com`, using your
   receiving domain. A suitable body is `Your verification code is 001234.`
5. Confirm that the message and address appear in the dashboard, that `001234`
   can be copied, and that the body opens. **Settings → Receiving → Receiving
   status** should show the latest receipt.

You can now register on websites using addresses such as `github@example.com` or
`notion@example.com` without creating them in the app first. Exact-address
Cloudflare routes take precedence over catch-all; mail routed elsewhere will not
appear in cfmailbin. The app does not create or read Cloudflare routing rules.

The setup notes recorded on September 30, 2026, used root-domain catch-all:
Email Routing subdomains required individual address rules. Check Cloudflare's
current subdomain documentation before choosing a subdomain for arbitrary
addresses.

References:
[Routing rules](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/),
[Rule precedence](https://developers.cloudflare.com/email-service/concepts/email-lifecycle/),
[Subdomain support](https://developers.cloudflare.com/email-service/configuration/subdomains/).

## 6. Enable AI Gateway (optional)

First verify delivery and local code extraction. Then follow the
[AI setup guide](email-analysis.md) to create an authenticated Gateway and store
a provider key under its BYOK `default` alias. Configure `[vars]`:

```toml
CFMAILBIN_AI_ENABLED = "true"
CFMAILBIN_AI_PROVIDER = "deepseek"
CFMAILBIN_AI_DAILY_LIMIT = "100"
CFMAILBIN_AI_GATEWAY_ACCOUNT_ID = "your-32-character-cloudflare-account-id"
CFMAILBIN_AI_GATEWAY_ID = "cfmailbin"
```

Enter a token with **AI Gateway Run** permission interactively:

```sh
deno task wrangler secret put CF_AIG_TOKEN
deno task deploy
```

`secret put` updates the deployed Worker's secret and publishes a version; the
subsequent `deploy` publishes local code and variables. With BYOK saved in the
Gateway, a provider key does not also need to be uploaded to the Worker. Keep
secrets out of configuration files and chat. Local `.dev.vars` files are not
uploaded automatically.

If preferences have already been saved, enable AI in **Settings → AI**, since KV
preferences override environment defaults. Check the configuration status, then
test with a message that local extraction does not recognize. With the
verification template, codes already found locally do not trigger AI. A
configured status alone does not verify credentials or provider connectivity.

## Update an existing deployment

When upgrading from the legacy receiving engine, absent, disabled and v1
workflows reject mail by default. Open **Settings → Receiving workflow**, import
the old configuration or start from a template, review it, then save and enable
a v2 workflow. Incoming mail is rejected until that step is complete. Legacy
rules and workflow copies remain available; importing does not automatically
enable a workflow or replay old mail.

Keep the existing Worker name, account, D1 ID, R2 bucket, KV namespace and
Access application. Before deploying, copy any non-secret variables configured
in the Cloudflare dashboard into `wrangler.toml` so deployment does not replace
them with stale values. Updating code does not require a new empty database.

```sh
deno install --frozen --allow-scripts=npm:esbuild,npm:workerd
deno task wrangler whoami
deno task wrangler d1 migrations list DB --remote
deno task check
deno task lint
deno task test
deno task test:worker
deno task deploy:check
deno task wrangler d1 migrations apply DB --remote
deno task deploy
```

Review pending migrations before applying them and deploying. After deployment,
verify Access sign-in and a real mail delivery, and confirm that Email Routing
still points to this Worker. Use `deno task wrangler tail` to inspect runtime
errors.

To pause model calls, turn off AI in **Settings → AI**. The verification
template keeps local extraction and mail storage; custom workflows determine
their own failure paths, so review those branches. Saved KV preferences override
matching environment defaults.

For code regressions, use Cloudflare's Deployments page to roll back to a
previous version. A code rollback does not undo D1 migrations, restore deleted
mail or restore KV settings. Check that saved settings and workflows are
compatible with the older code. Keep Access and routing configuration in place.

References:
[Secrets](https://developers.cloudflare.com/workers/configuration/secrets/),
[Rollback limits](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).
