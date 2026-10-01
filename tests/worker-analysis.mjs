import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Use the same pinned workerd and bundler as our deployment toolchain.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler"));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const { build } = wranglerRequire("esbuild");
const root = fileURLToPath(new URL("../", import.meta.url));

const bundle = await build({
  stdin: {
    resolveDir: root,
    contents: `
      import { analyzeEmail } from './tests/analysis_fixture.ts';
      import { graphTemplate } from './src/graph/templates.ts';
      import { receiptPolicy } from './tests/workflow_fixture.ts';
      import { graphAi } from './src/graph/ai.ts';
      import { runGraph } from './src/graph/run.ts';
      import { createMemoryStore } from './src/storage/memory.ts';
      export default { async fetch(request) {
        try {
          if (new URL(request.url).pathname === '/policy') {
            const events = [];
            const config = { ai: { enabled: true, provider: 'deepseek', dailyLimit: 1,
              gateway: { accountId: 'a'.repeat(32), id: 'test', token: 'synthetic-gateway-key' } } };
            const call = graphAi(config, createMemoryStore());
            const run = await runGraph(receiptPolicy([{ type: 'forward', to: 'owner@example.com' }]), { subject: 'Login', text: 'Enter 001234 to sign in.', codes: [], localCodes: [], truncated: false }, {
              aiEnabled: true, provider: 'deepseek',
              ai: async (...args) => { events.push('ai'); return call(...args); },
              rules: async () => { events.push('rules'); return { action: 'forward', forwardTo: 'owner@example.com', tags: [], retentionDays: 1, matchedRuleId: null, trace: [] }; },
              forward: async () => { events.push('forward'); },
            });
            return Response.json({ run, events });
          }
          if (new URL(request.url).pathname === '/graph') {
            const graph = graphTemplate('classification');
            const first = graph.nodes.find(n => n.kind === 'ai');
            first.batchGroup = 'mail';
            graph.nodes.push({ ...structuredClone(first), id: 'second' });
            graph.edges.find(e => e.from === first.id).to = 'second';
            graph.edges.push({ from: 'second', to: 'match', port: 'next' });
            const target = graph.nodes.find(n => n.id === 'important');
            target.actions.push({ type: 'forward', to: 'owner@example.com' });
            let forwarded = 0;
            const config = { ai: { enabled: true, provider: 'deepseek', dailyLimit: 1,
              gateway: { accountId: 'a'.repeat(32), id: 'test', token: 'synthetic-gateway-key' } } };
            const run = await runGraph(graph, { subject: 'Test', text: 'Synthetic email' }, {
              aiTimeoutMs: Number(new URL(request.url).searchParams.get('timeout')) || undefined,
              ai: graphAi(config, createMemoryStore()),
              forward: async () => { forwarded++; },
            });
            return Response.json({ run, forwarded });
          }
          return Response.json(await analyzeEmail({
            provider: new URL(request.url).pathname.slice(1),
            gateway: { accountId: 'a'.repeat(32), id: 'test', token: 'synthetic-gateway-key' },
            apiKey: 'synthetic-provider-key',
          }, { subject: 'Test', text: 'Hello', codes: [], links: [], truncated: false }));
        } catch (error) {
          return Response.json({ reason: error.reason, httpStatus: error.httpStatus }, { status: 502 });
        }
      }}
    `,
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
});

test("workerd sends AI requests and refuses redirects without forwarding credentials", async () => {
  const requests = [];
  let redirect = false;
  let delayMs = 0;
  const result = JSON.stringify({
    category: "other",
    hasCode: false,
    codes: [],
  });
  const mf = new Miniflare(convertV4MiniflareOptions({
    cf: false,
    workers: [{
      name: "analysis-test",
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-04-24",
      outboundService: async (request) => {
        requests.push(request.url);
        // Every request, including redirects, must remain on the original host.
        assert.equal(
          new URL(request.url).hostname,
          "gateway.ai.cloudflare.com",
        );
        assert.equal(
          request.headers.get("cf-aig-authorization"),
          "Bearer synthetic-gateway-key",
        );
        const input = await request.json();
        const isOpenAI = request.url.endsWith("/openai/responses");
        assert.equal(input.model, isOpenAI ? "gpt-5.6-luna" : "deepseek-flash");
        if (redirect) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://untrusted.example/" },
          });
        }
        if (delayMs) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        const tasks = !isOpenAI && JSON.parse(input.messages[1].content).tasks;
        const content = tasks?.enrich
          ? JSON.stringify({
            enrich: {
              category: "verification",
              hasCode: true,
              codes: [{ value: "001234", context: "Enter 001234 to sign in." }],
            },
          })
          : tasks
          ? JSON.stringify({
            classify: { category: "verification", summary: "test" },
            second: { category: "other", summary: "test" },
          })
          : result;
        return Response.json(
          isOpenAI
            ? {
              status: "completed",
              output: [{
                type: "message",
                content: [{ type: "output_text", text: content }],
              }],
            }
            : {
              choices: [{
                finish_reason: "stop",
                message: { content },
              }],
            },
        );
      },
    }],
  }));
  try {
    for (const provider of ["deepseek", "openai"]) {
      const response = await mf.dispatchFetch(`http://local.test/${provider}`);
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.analysis.status, "complete");
      assert.equal(body.analysis.codeStatus, "not_found");
    }
    assert.equal(requests.length, 2);
    // Real model responses can exceed the old eight-second application deadline.
    delayMs = 9_000;
    const delayed = await mf.dispatchFetch("http://local.test/deepseek");
    const delayedBody = await delayed.json();
    assert.equal(delayed.status, 200, JSON.stringify(delayedBody));
    assert.equal(delayedBody.analysis.status, "complete");
    delayMs = 0;
    redirect = true;
    const response = await mf.dispatchFetch("http://local.test/deepseek");
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      reason: "service_error",
      httpStatus: 302,
    });
    assert.equal(requests.length, 4);
    redirect = false;
    const graphResponse = await mf.dispatchFetch("http://local.test/graph");
    const graphBody = await graphResponse.json();
    assert.equal(graphBody.run.status, "complete", JSON.stringify(graphBody));
    assert.equal(graphBody.forwarded, 1);
    assert.equal(
      requests.length,
      5,
      "two AI tasks must use one upstream request",
    );
    assert.deepEqual(
      graphBody.run.steps.find((step) => step.nodeId === "second").batch,
      ["classify", "second"],
    );
    assert.equal(graphBody.run.retentionDays, 1);
    delayMs = 1500;
    const timed =
      await (await mf.dispatchFetch("http://local.test/graph?timeout=1000"))
        .json();
    assert.equal(timed.run.status, "complete", JSON.stringify(timed));
    assert.equal(timed.forwarded, 0);
    assert.equal(
      timed.run.steps.find((step) => step.nodeId === "classify").output.error
        .reason,
      "timeout",
    );
    assert.equal(timed.run.action, "keep");
    delayMs = 0;
    const policy = await (await mf.dispatchFetch("http://local.test/policy"))
      .json();
    assert.equal(policy.run.status, "complete", JSON.stringify(policy));
    assert.deepEqual(policy.events, ["forward", "ai"]);
    assert.deepEqual(policy.run.codes, ["001234"]);
    assert.equal(policy.run.analysis.status, "complete");
    assert.equal(requests.length, 7);
  } finally {
    await mf.dispose();
  }
});
