# cfmailbin

A self-hosted email inbox for your own domain, built on Cloudflare. Use a
different address for each website, collect verification codes, and control how
incoming mail is handled. Each deployment is for one owner.

- Copy verification codes, search mail, and receive live inbox updates.
- Build workflows with policies, branches, forwarding, replies, and retention.
- Add optional AI nodes through Cloudflare AI Gateway.
- Inspect execution history in an English or Simplified Chinese dashboard.

Follow the [deployment guide](docs/deploy.md) to set up your own instance.
Incoming mail is rejected until you save and enable a receiving workflow.

## Local development

Requires Deno 2 and Node.js 24.

```sh
deno install --frozen --allow-scripts=npm:esbuild,npm:workerd
deno task dev      # Backend
```

In a second terminal, run `deno task ui:dev` and open
[localhost:5173](http://127.0.0.1:5173). The preview uses temporary in-memory
data and needs no Cloudflare credentials.

## Documentation

[Usage](docs/usage.md) · [Workflows](docs/mail-graph.md) ·
[AI setup](docs/email-analysis.md) · [Localization](docs/localization.md)
