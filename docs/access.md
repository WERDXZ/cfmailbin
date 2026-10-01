# Cloudflare Access

cfmailbin is a private, single-owner inbox. Cloudflare Access handles account
sign-in, and the Worker independently checks each API request's signed Access
token and owner email. No registration, password database, or manual bearer
token is needed. The
[Access Free plan](https://www.cloudflare.com/plans/zero-trust-services/)
currently covers up to 50 users; this app only needs one. Workers, D1, and R2
have separate usage limits and billing.

## Set up production

For a new Worker, follow [the deployment guide](deploy.md) to create resources
and perform the initial upload before configuring Worker-level Access below.
Without Access settings the API denies requests; connect inbound email only
after the protected dashboard works. For an existing Worker, keep its Access
protection enabled throughout the update.

1. Enable Cloudflare Zero Trust on your account and select its Free plan.
2. Configure
   [Cloudflare as the identity provider](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/cloudflare/).
   Use your existing Cloudflare account and its multi-factor authentication.
3. In Workers & Pages, select **cfmailbin**, open **Access**, and choose
   **Protect this Worker behind Access**. Select **All traffic**, covering
   production and previews. This protects routes, custom domains, `workers.dev`,
   and static assets. See
   [Worker Access configuration](https://developers.cloudflare.com/workers/configuration/cloudflare-access/).
4. In Zero Trust, edit the resulting Access application. Restrict its login
   method to Cloudflare, and use an Allow policy with **Emails** set to your
   exact account email. Remove broader Allow or Bypass policies for this
   application. Account membership alone also allows other account members; an
   email-domain rule also allows other users of that domain.
5. Copy the application's Audience (AUD) tag and your Zero Trust team hostname.
   Uncomment and fill these variables in `wrangler.toml`:

   ```toml
   CFMAILBIN_OWNER_EMAIL = "you@example.com"
   CFMAILBIN_ACCESS_TEAM_DOMAIN = "your-team.cloudflareaccess.com"
   CFMAILBIN_ACCESS_AUD = "your-access-application-audience-tag"
   ```

   The team domain is a hostname, without `https://` or a path. AUD identifies
   this Access application, not your Cloudflare account ID. These are
   configuration values, not API keys. Use the same exact owner address in the
   policy and Worker.
6. Build and deploy the updated Worker using the project's existing deployment
   process. Enable Access before exposing the deployment. Missing authentication
   settings make API requests fail closed with `503`.
7. Visit the dashboard and sign in. The sidebar displays the authenticated
   email.

The repository's D1 ID and R2 configuration must also point to your resources.
Changing `wrangler.toml` does not create the Access application or its policy.

## Request verification

Workers with Static Assets currently do not receive `ctx.access` through the
internal asset router. This implementation therefore uses Cloudflare's
documented
[JWT verification approach](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/):

- Read `Cf-Access-Jwt-Assertion` and verify its RS256 signature with the
  configured team's public keys from `/cdn-cgi/access/certs` using `jose`.
- Check issuer, application audience, expiry, and a nonempty owner email. Email
  comparison is case-insensitive. Cache public signing keys between requests.
- Reject plain email headers, legacy bearer tokens, and unsigned or invalid
  JWTs. A forged header alone cannot authenticate a request.
- Return `401` for absent/invalid sessions, `403` for another authenticated
  user, and `503` for missing configuration or unavailable signing keys. Do not
  expose token contents or upstream error details.
- Require `X-Cfmailbin-Request: 1` for writes, reject foreign `Origin` values
  and cross-site requests, and send `Cache-Control: no-store` for API responses.

Every hostname must remain protected by Access. If more-specific hostname/path
applications exist, review their policies too: they can take precedence over the
Worker-level application. The API accepts only the configured application's AUD.

## Sessions and logout

The UI reads `/api/session` on startup and uses the browser's Access cookie on
same-origin requests. It discards any old `cfmailbin.token` browser-storage
entry. Access redirects or expired sessions show a sign-in screen instead of a
JSON parsing error or a downloaded login page.

**Sign in with Cloudflare** reloads the protected application to start or resume
the Access login flow. **Sign out** and **Use another account** visit
`/cdn-cgi/access/logout`. Cloudflare documents this as revoking the Access
session across applications, not only cfmailbin; it does not log you out of your
identity provider. See
[Access session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/).

## Local development

Run `deno task dev` and `deno task ui:dev`, then open `http://127.0.0.1:5173`.
The API listens only on loopback and rejects non-local Host values. It injects a
development identity (configured owner email or `developer@localhost`) and uses
in-memory storage. The UI labels this session **Local development** and omits
logout because it is not a real Access session.

This behavior exists only in `src/main.ts`. The production entrypoint,
`src/entry.ts` (delegating to `src/worker.ts`), always verifies Access JWTs and
does not honor a development authentication flag. Use a protected deployed
preview to verify actual Cloudflare sign-in; `access.dev` alone cannot exercise
this JWT verifier.

## Verify and roll back

Dependency update on 2026-09-29: Vite 8.3.1, Preact 10.29.8 and
`@preact/preset-vite` 2.10.6 replace the older frontend tooling. The lockfile
also updates the affected transitive build dependencies. On 2026-09-30, Wrangler
was updated to 4.144.0 to pick up Miniflare's undici 7.29.1 security patch.
These are local development/deployment tools, not modules in the deployed
Worker. Run `deno audit` before each deployment; historical results are not a
substitute for a current check.

Run `deno task check`, `deno task lint`, `deno task test`, and
`deno task ui:build`. The authentication tests sign real test JWTs and replace
only the public-key HTTP endpoint, covering wrong signatures, expiry, issuer,
audience, owner and failures.

On a protected deployment, verify:

1. A private browser window is prompted to sign in before seeing the dashboard.
2. Your account loads `/api/session`, aliases, messages, and raw downloads.
3. Another account is denied; all production and preview hostnames are covered.
4. Expiry prompts reauthentication, and logout ends the Access session.
5. The separate inbound email and scheduled retention handlers still work.

There is no destructive database migration. Historical `tokens` rows remain but
are unused. If a deployment must be rolled back, keep Access enabled and restore
the previous Worker version and corresponding UI. The old UI may require its
previous bearer token in addition to passing Access.
