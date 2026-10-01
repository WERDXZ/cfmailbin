import {
  auditApiMutation,
  recordAudit,
  workflowAuditMetadata,
  workflowEventType,
} from "./services/audit.ts";
import {
  auditCursor,
  AuditQueryError,
  parseAuditQuery,
} from "./domain/audit.ts";
import { authenticateAccess, AuthenticationError } from "./auth.ts";
import type { Session } from "./auth.ts";
import type { CfMailBinConfig } from "./config.ts";
import type { CodedError, ErrorParams } from "./domain/errors.ts";
import {
  parseRuleInput,
  RuleValidationError,
} from "./domain/rule-validation.ts";
import { previewRule } from "./services/rule-preview.ts";
import { generateAliasAddress } from "./domain/aliases.ts";
import { findVerificationCodes, readMessageContent } from "./email/content.ts";
import { analysisModels } from "./domain/analysis.ts";
import { deleteMessages } from "./services/retention.ts";
import type {
  CreateAliasInput,
  MessageStatus,
  RuleAction,
} from "./domain/models.ts";
import type { AppStore, BlobStore } from "./storage/types.ts";
import {
  parseSettings,
  SettingsError,
  settingsFromConfig,
  type SettingsStore,
} from "./settings.ts";
import { eventStreamHeaders, notifyInbox, type Realtime } from "./realtime.ts";
import { compileGraph, parseGraph } from "./graph/compile.ts";
import { migrateGraph, migrateRules } from "./graph/migrate.ts";
import {
  builtInPolicies,
  parsePolicyLibrary,
  purePolicy,
} from "./graph/policies.ts";
import { builtInPresets, parseLibrary } from "./graph/library.ts";
import { resolveMessageAction } from "./domain/rules.ts";
import { withContent } from "./email/rule-context.ts";
import type { MessageContent } from "./domain/models.ts";
import { GraphError, type GraphStore } from "./graph/types.ts";
import { runGraph } from "./graph/run.ts";
import { graphAi } from "./graph/ai.ts";
import { graphEmail } from "./graph/process.ts";

interface RouteDescription {
  description: string;
  method: string;
  path: string;
}

export interface AppSnapshot {
  description: string;
  endpoints: RouteDescription[];
  features: string[];
  name: string;
  storage: string[];
}

export interface Backend {
  graph?: GraphStore;
  blobStore: BlobStore;
  config: CfMailBinConfig;
  store: AppStore;
  settings?: SettingsStore;
  loadConfig?: () => Promise<CfMailBinConfig>;
  events?: Realtime;
  // Injected only by the loopback development server and tests, never from HTTP.
  developmentSession?: Session;
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly params?: ErrorParams,
  ) {
    super(message);
  }
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init);
}

function errorResponse(
  status: number,
  message: string,
  code?: string,
  params?: ErrorParams,
): Response {
  return jsonResponse({
    error: message,
    ...(code ? { code } : {}),
    ...(params ? { params } : {}),
  }, { status });
}

async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new RequestError(
        400,
        "Expected a JSON object body",
        "errors.expectedJsonObject",
      );
    }

    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RequestError) {
      throw error;
    }

    throw new RequestError(400, "Invalid JSON body", "errors.invalidJsonBody");
  }
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];

  if (typeof value !== "string" || value.trim() === "") {
    throw new RequestError(
      400,
      `${field} must be a non-empty string`,
      "errors.nonEmptyStringRequired",
      { field },
    );
  }

  return value.trim();
}

function optionalString(
  body: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = body[field];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new RequestError(
      400,
      `${field} must be a string`,
      "errors.stringRequired",
      { field },
    );
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalNullableString(
  body: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = body[field];

  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new RequestError(
      400,
      `${field} must be a string or null`,
      "errors.nullableStringRequired",
      { field },
    );
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalBoolean(
  body: Record<string, unknown>,
  field: string,
): boolean | undefined {
  const value = body[field];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new RequestError(
      400,
      `${field} must be a boolean`,
      "errors.booleanFieldRequired",
      { field },
    );
  }

  return value;
}

function optionalPositiveInteger(
  body: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = body[field];

  if (value === undefined) {
    return undefined;
  }

  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new RequestError(
      400,
      `${field} must be a positive integer`,
      "errors.positiveIntegerRequired",
      { field },
    );
  }

  return Number(value);
}

function optionalStringArray(
  body: Record<string, unknown>,
  field: string,
): string[] | undefined {
  const value = body[field];

  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new RequestError(
      400,
      `${field} must be an array of strings`,
      "errors.stringArrayRequired",
      { field },
    );
  }

  return value;
}

function parseRuleAction(value: unknown, field: string): RuleAction {
  if (
    value === "keep" ||
    value === "forward" ||
    value === "trash" ||
    value === "block"
  ) {
    return value;
  }

  throw new RequestError(
    400,
    `${field} must be keep, forward, trash, or block`,
    "errors.invalidRuleAction",
    { field },
  );
}

function parseMessageStatus(value: unknown, field: string): MessageStatus {
  if (
    value === "inbox" ||
    value === "forwarded" ||
    value === "trashed" ||
    value === "blocked"
  ) {
    return value;
  }

  throw new RequestError(
    400,
    `${field} must be inbox, forwarded, trashed, or blocked`,
    "errors.invalidMessageStatus",
    { field },
  );
}

function parseLimit(url: URL): number {
  const limit = url.searchParams.get("limit");

  if (!limit) {
    return 50;
  }

  const parsed = Number(limit);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new RequestError(
      400,
      "limit must be a positive integer",
      "errors.positiveIntegerRequired",
      { field: "limit" },
    );
  }

  return Math.min(parsed, 100);
}

export function buildAppSnapshot(config: CfMailBinConfig): AppSnapshot {
  return {
    description:
      "Disposable email aliases on Cloudflare with a single-worker backend, forwarding, retention, and a lightweight inbox API.",
    endpoints: [
      {
        description: "Backend summary and route map.",
        method: "GET",
        path: "/",
      },
      {
        description: "Health check for local development and deployments.",
        method: "GET",
        path: "/health",
      },
      {
        description: "Read the authenticated Cloudflare Access session.",
        method: "GET",
        path: "/api/session",
      },
      {
        description:
          "List aliases, rules, and tags for the dashboard bootstrap.",
        method: "GET",
        path: "/api/bootstrap",
      },
      {
        description: "List or create aliases.",
        method: "GET|POST",
        path: "/api/aliases",
      },
      {
        description:
          "Generate an ordinary registration address labelled with a website name.",
        method: "POST",
        path: "/api/aliases/generate",
      },
      {
        description: "Patch an alias.",
        method: "PATCH",
        path: "/api/aliases/:id",
      },
      {
        description: "List or create rules.",
        method: "GET|POST",
        path: "/api/rules",
      },
      {
        description:
          "Trial a draft against recent mail without modifying or forwarding it.",
        method: "POST",
        path: "/api/rules/preview",
      },
      {
        description: "Atomically reorder the complete rule list.",
        method: "POST",
        path: "/api/rules/reorder",
      },
      {
        description: "Patch a rule.",
        method: "PATCH",
        path: "/api/rules/:id",
      },
      {
        description: "List messages with basic filters.",
        method: "GET",
        path: "/api/messages",
      },
      {
        description:
          "List inbox messages, remembered addresses and receipt history.",
        method: "GET",
        path: "/api/inbox",
      },
      {
        description: "Read or patch a message.",
        method: "GET|PATCH",
        path: "/api/messages/:id",
      },
      {
        description: "Delete a batch of messages and their raw MIME blobs.",
        method: "POST",
        path: "/api/messages/batch-delete",
      },
      {
        description: "Replace a message tag set.",
        method: "PUT",
        path: "/api/messages/:id/tags",
      },
      {
        description:
          "Read plaintext, verification-code candidates and explicit HTTP(S) links.",
        method: "GET",
        path: "/api/messages/:id/content",
      },
      {
        description: "Fetch raw MIME for a stored message.",
        method: "GET",
        path: "/api/messages/:id/raw",
      },
      {
        description: "List all known tags.",
        method: "GET",
        path: "/api/tags",
      },
      {
        description: "Read or save editable dashboard preferences.",
        method: "GET|PUT",
        path: "/api/settings",
      },
      {
        description: "Stream inbox change notifications using SSE.",
        method: "GET",
        path: "/api/events",
      },
      {
        description:
          "Search and paginate mail and configuration audit history.",
        method: "GET",
        path: "/api/audit",
      },
      {
        description: "List recent metadata-only audit events.",
        method: "GET",
        path: "/api/audit-events",
      },
    ],
    features: [
      "Alias-based disposable inboxes",
      config.allowCatchAll ? "Optional catch-all mode" : "Explicit alias mode",
      "Forward, keep, trash, or block actions",
      "Temporary message retention",
      "Search, tags, and filters",
    ],
    name: config.appName,
    storage: ["D1", "R2"],
  };
}

async function handleApiRequest(
  request: Request,
  backend: Backend,
  url: URL,
): Promise<Response> {
  const session = backend.developmentSession ??
    await authenticateAccess(request, backend.config);

  if (!["GET", "HEAD"].includes(request.method)) {
    const origin = request.headers.get("origin");
    if (
      request.headers.get("x-cfmailbin-request") !== "1" ||
      (origin !== null && origin !== url.origin) ||
      request.headers.get("sec-fetch-site") === "cross-site"
    ) {
      return errorResponse(
        403,
        "Cross-origin request denied",
        "errors.crossOriginRequestDenied",
      );
    }
  }

  const response = await routeApiRequest(request, backend, url, session);
  await auditApiMutation(
    backend.store,
    request.method,
    url.pathname,
    response,
    session.email,
  );
  return response;
}

async function routeApiRequest(
  request: Request,
  backend: Backend,
  url: URL,
  session: Session,
): Promise<Response> {
  const segments = url.pathname.split("/").filter(Boolean);

  if (request.method === "GET" && url.pathname === "/api/session") {
    return jsonResponse({ ok: true, ...session });
  }

  if (request.method === "GET" && url.pathname === "/api/events") {
    if (!backend.events) {
      return errorResponse(
        503,
        "Realtime updates are unavailable",
        "errors.realtimeUnavailable",
      );
    }
    return new Response(await backend.events.subscribe(), {
      headers: eventStreamHeaders,
    });
  }

  if (url.pathname === "/api/settings" && request.method === "PUT") {
    if (!backend.settings) {
      throw new SettingsError(
        503,
        "尚未绑定设置存储 SETTINGS",
        "errors.settingsStorageUnavailable",
      );
    }
    const settings = parseSettings(await readJsonObject(request));
    await backend.settings.put(settings);
    return jsonResponse({ settings, storage: backend.settings.kind });
  }

  if (backend.loadConfig) {
    backend = { ...backend, config: await backend.loadConfig() };
  }
  if (url.pathname === "/api/policies" && request.method === "GET") {
    return jsonResponse({
      policies: await backend.graph?.getPolicies() ?? [],
      templates: builtInPolicies,
      storage: backend.graph?.kind ?? "unavailable",
    });
  }
  const policyMatch = url.pathname.match(
    /^\/api\/policies\/([a-zA-Z0-9_-]{1,80})$/,
  );
  if (policyMatch && ["PUT", "DELETE"].includes(request.method)) {
    if (!backend.graph) {
      throw new SettingsError(
        503,
        "尚未绑定 Policy 库设置存储",
        "errors.policyStorageUnavailable",
      );
    }
    const id = policyMatch[1];
    if (id.startsWith("builtin_")) {
      throw new RequestError(
        400,
        "预设请另存为自己的 Policy",
        "errors.builtInPolicyRequiresCopy",
      );
    }
    const library = await backend.graph.getPolicies();
    if (request.method === "DELETE") {
      await backend.graph.putPolicies(library.filter((p) => p.id !== id));
      return jsonResponse({ deleted: true });
    }
    const body = await readJsonObject(request);
    const previous = library.find((p) => p.id === id);
    if (previous && body.revision !== previous.revision) {
      throw new RequestError(
        409,
        "Policy 已更新，请重新加载再保存",
        "errors.policyRevisionConflict",
      );
    }
    const policy = purePolicy(
      parsePolicyLibrary([{
        ...body,
        id,
        version: 2,
        revision: crypto.randomUUID(),
      }])[0],
    );
    await backend.graph.putPolicies([
      ...library.filter((p) => p.id !== id),
      policy,
    ]);
    return jsonResponse(policy);
  }
  if (url.pathname === "/api/node-library" && request.method === "GET") {
    return jsonResponse({
      presets: await backend.graph?.getLibrary() ?? [],
      templates: builtInPresets,
      storage: backend.graph?.kind ?? "unavailable",
    });
  }
  const libraryMatch = url.pathname.match(
    /^\/api\/node-library\/([a-zA-Z0-9_-]{1,80})$/,
  );
  if (libraryMatch && ["PUT", "DELETE"].includes(request.method)) {
    if (!backend.graph) {
      throw new SettingsError(
        503,
        "尚未绑定节点库设置存储",
        "errors.nodeLibraryStorageUnavailable",
      );
    }
    const id = libraryMatch[1];
    if (id.startsWith("builtin_")) {
      throw new RequestError(
        400,
        "内置预设请另存为自己的节点",
        "errors.builtInNodeRequiresCopy",
      );
    }
    const library = await backend.graph.getLibrary();
    if (request.method === "DELETE") {
      await backend.graph.putLibrary(
        library.filter((preset) => preset.id !== id),
      );
      return jsonResponse({ deleted: true });
    }
    const body = await readJsonObject(request);
    const previous = library.find((p) => p.id === id);
    if (previous && body.revision !== previous.revision) {
      throw new RequestError(
        409,
        "节点已更新，请重新加载再保存",
        "errors.nodeRevisionConflict",
      );
    }
    const preset = parseLibrary([{
      id,
      revision: crypto.randomUUID(),
      node: body.node,
      fragment: body.fragment,
    }])[0];
    if (previous && previous.node.kind !== preset.node.kind) {
      throw new RequestError(
        400,
        "更换节点类型请另存为新节点",
        "errors.nodeKindChangeRequiresCopy",
      );
    }
    await backend.graph.putLibrary([
      ...library.filter((p) => p.id !== id),
      preset,
    ]);
    return jsonResponse(preset);
  }
  if (url.pathname === "/api/graph/migrate" && request.method === "POST") {
    const body = await readJsonObject(request);
    if (body.source !== "rules" && body.source !== "graph") {
      throw new RequestError(
        400,
        "请选择要导入的旧规则或流程",
        "errors.migrationSourceRequired",
      );
    }
    const rules = await backend.store.listRules();
    const aliases = await backend.store.listAliases();
    if (body.source === "rules") {
      return jsonResponse(
        migrateRules(rules, aliases, backend.config.defaultForwardTo),
      );
    }
    const legacy = await backend.graph?.getLegacy();
    if (!legacy) {
      throw new RequestError(
        404,
        "没有可导入的旧流程",
        "errors.legacyWorkflowNotFound",
      );
    }
    return jsonResponse(
      migrateGraph(legacy, rules, aliases, backend.config.defaultForwardTo),
    );
  }
  if (
    url.pathname === "/api/graph" && ["GET", "PUT"].includes(request.method)
  ) {
    let saved;
    if (request.method === "PUT") {
      if (!backend.graph) {
        throw new SettingsError(
          503,
          "尚未绑定流程设置存储",
          "errors.workflowStorageUnavailable",
        );
      }
      saved = parseGraph(await readJsonObject(request));
      if (saved.version !== 2) {
        throw new RequestError(
          400,
          "请先将旧流程导入为新版草稿",
          "errors.importLegacyWorkflowFirst",
        );
      }
      saved.revision = crypto.randomUUID();
      await backend.graph.put(saved);
    } else {
      saved = await backend.graph?.get();
    }
    const graph = saved?.version === 2 ? saved : null;
    return jsonResponse({
      graph,
      effectiveGraph: graph?.enabled ? graph : null,
      plan: graph ? compileGraph(graph) : null,
      storage: backend.graph?.kind ?? "unavailable",
      legacy: {
        rules: (await backend.store.listRules()).length,
        graph: !!await backend.graph?.getLegacy(),
      },
    });
  }
  if (url.pathname === "/api/graph/preview" && request.method === "POST") {
    const body = await readJsonObject(request);
    const graph = parseGraph(body.graph);
    let email;
    let content: MessageContent;
    if (typeof body.messageId === "string" && body.messageId) {
      const message = await backend.store.getMessage(body.messageId);
      const blob = message?.rawKey
        ? await backend.blobStore.get(message.rawKey)
        : null;
      if (!message || !blob) {
        throw new RequestError(
          404,
          "邮件原文不存在",
          "errors.rawMessageNotFound",
        );
      }
      content = await readMessageContent(blob.body);
      email = graphEmail(
        content,
        message.from,
        message.aliasAddress,
      );
    } else {
      const sample = body.sample as Record<string, unknown> | undefined;
      if (
        !sample || typeof sample.subject !== "string" ||
        sample.subject.length > 500 || typeof sample.text !== "string" ||
        sample.text.length > 12000
      ) {
        throw new RequestError(
          400,
          "请提供测试主题和正文（最多 12,000 字符）",
          "errors.invalidWorkflowSample",
          { max: 12000 },
        );
      }
      content = {
        subject: sample.subject,
        text: sample.text,
        codes: [],
        links: [],
        truncated: false,
      };
      email = graphEmail(
        content,
        "sample@example.com",
        "inbox@example.com",
      );
    }
    const alias = await backend.store.findAliasByAddress(String(email.to)) ?? {
      id: "sample",
      address: String(email.to),
      enabled: true,
      defaultAction: backend.config.defaultForwardTo
        ? "forward" as const
        : "keep" as const,
      forwardTo: backend.config.defaultForwardTo,
      retentionDays: backend.config.defaultRetentionDays,
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const run = await runGraph(graph, email, {
      trial: true,
      ai: graphAi(backend.config, backend.store),
      aiEnabled: !!backend.config.ai?.enabled && !!backend.config.ai.gateway,
      aiTimeoutMs: (backend.config.ai?.timeoutSeconds ?? 25) * 1000,
      provider: backend.config.ai?.provider,
      rules: async (codes) => {
        const decision = resolveMessageAction(
          alias,
          await backend.store.listRulesForAlias(alias.id),
          withContent({
            alias: alias.address,
            from: String(email.from),
            subject: content.subject,
            receivedAt: new Date().toISOString(),
          }, { ...content, codes }),
        );
        if (decision.action === "forward") {
          decision.forwardTo ??= backend.config.defaultForwardTo;
        }
        return decision;
      },
    });
    await recordAudit(backend.store, {
      eventType: workflowEventType(run),
      actor: session.email,
      aliasAddress: String(email.to),
      messageId: typeof body.messageId === "string"
        ? body.messageId
        : undefined,
      reason: run.error,
      metadata: { workflow: workflowAuditMetadata(graph, run) },
    });
    return jsonResponse(run);
  }
  if (url.pathname === "/api/settings" && request.method === "GET") {
    return jsonResponse({
      settings: settingsFromConfig(backend.config),
      storage: backend.settings?.kind ?? "unavailable",
    });
  }

  if (request.method === "GET" && url.pathname === "/api/inbox") {
    const status = url.searchParams.get("status");
    const [messages, aliases, delivery] = await Promise.all([
      backend.store.listMessages({
        aliasId: url.searchParams.get("aliasId") ?? undefined,
        limit: parseLimit(url),
        q: url.searchParams.get("q") ?? undefined,
        status: status ? parseMessageStatus(status, "status") : undefined,
      }),
      backend.store.listAliases(),
      backend.store.getDeliveryStatus(backend.config.emailDomain),
    ]);
    return jsonResponse({
      messages: messages.map((message) => ({
        ...message,
        // Older records have no stored extraction. Never read R2 on each poll.
        verificationCodes: message.verificationCodes ??
          findVerificationCodes(message.preview ?? "", message.subject),
      })),
      aliases,
      delivery,
    });
  }

  if (request.method === "GET" && url.pathname === "/api/bootstrap") {
    const [aliases, rules, tags] = await Promise.all([
      backend.store.listAliases(),
      backend.store.listRules(),
      backend.store.listTags(),
    ]);

    return jsonResponse({
      aliases,
      config: {
        locale: backend.config.locale ?? "auto",
        emailDomain: backend.config.emailDomain,
        allowCatchAll: backend.config.allowCatchAll,
        autoCreateAliasTag: backend.config.autoCreateAliasTag,
        defaultRetentionDays: backend.config.defaultRetentionDays,
        forwardingConfigured: Boolean(backend.config.defaultForwardTo),
        analysis: {
          enabled: Boolean(backend.config.ai?.enabled),
          configured: Boolean(backend.config.ai?.gateway),
          model: analysisModels[backend.config.ai?.provider ?? "deepseek"],
          dailyLimit: backend.config.ai?.dailyLimit ?? 100,
        },
      },
      rules,
      tags,
    });
  }

  if (segments[1] === "aliases") {
    if (
      segments.length === 3 && segments[2] === "generate" &&
      request.method === "POST"
    ) {
      const body = await readJsonObject(request);
      const label = requiredString(body, "label");
      if (label.length > 120) {
        throw new RequestError(
          400,
          "网站名称不能超过 120 个字符",
          "errors.siteNameTooLong",
          { max: 120 },
        );
      }
      const domain = backend.config.emailDomain ??
        optionalString(body, "domain") ?? "";
      let address: string;
      try {
        address = generateAliasAddress(label, domain);
      } catch (error) {
        throw new RequestError(
          400,
          (error as Error).message,
          "errors.invalidAliasAddress",
        );
      }
      if (await backend.store.findAliasByAddress(address)) {
        throw new RequestError(
          409,
          "地址已存在，请重新生成",
          "errors.aliasAlreadyExists",
        );
      }
      return jsonResponse(
        await backend.store.createAlias({
          address,
          description: label,
          defaultAction: "keep",
          retentionDays: backend.config.defaultRetentionDays,
        }),
        { status: 201 },
      );
    }
    if (segments.length === 2 && request.method === "GET") {
      return jsonResponse(await backend.store.listAliases());
    }

    if (segments.length === 2 && request.method === "POST") {
      const body = await readJsonObject(request);
      const input: CreateAliasInput = {
        address: requiredString(body, "address"),
        defaultAction: body.defaultAction === undefined
          ? backend.config.defaultForwardTo ? "forward" : "keep"
          : parseRuleAction(body.defaultAction, "defaultAction"),
        description: optionalNullableString(body, "description"),
        enabled: optionalBoolean(body, "enabled"),
        forwardTo: optionalNullableString(body, "forwardTo"),
        retentionDays: optionalPositiveInteger(body, "retentionDays") ??
          backend.config.defaultRetentionDays,
        tags: optionalStringArray(body, "tags"),
      };
      const alias = await backend.store.createAlias(input);
      return jsonResponse(alias, { status: 201 });
    }

    if (segments.length === 3 && request.method === "PATCH") {
      const body = await readJsonObject(request);
      const alias = await backend.store.updateAlias(segments[2], {
        address: optionalString(body, "address"),
        defaultAction: body.defaultAction === undefined
          ? undefined
          : parseRuleAction(body.defaultAction, "defaultAction"),
        description: body.description === undefined
          ? undefined
          : optionalNullableString(body, "description") ?? "",
        enabled: optionalBoolean(body, "enabled"),
        forwardTo: optionalNullableString(body, "forwardTo"),
        retentionDays: optionalPositiveInteger(body, "retentionDays"),
      });

      if (!alias) {
        return errorResponse(404, "Alias not found", "errors.aliasNotFound");
      }

      return jsonResponse(alias);
    }
  }

  if (segments[1] === "rules") {
    if (segments.length === 2 && request.method === "GET") {
      return jsonResponse(await backend.store.listRules());
    }
    if (
      segments.length === 3 && segments[2] === "reorder" &&
      request.method === "POST"
    ) {
      const body = await readJsonObject(request);
      const ids = optionalStringArray(body, "ids");
      const rules = await backend.store.listRules();
      if (
        !ids || ids.length !== rules.length ||
        new Set(ids).size !== ids.length || ids.some((id) =>
          !rules.some((rule) => rule.id === id)
        )
      ) {
        throw new RequestError(
          409,
          "规则列表已改变，请刷新后重新排序",
          "errors.ruleOrderConflict",
        );
      }
      return jsonResponse(await backend.store.reorderRules(ids));
    }
    if (
      segments.length === 3 && segments[2] === "preview" &&
      request.method === "POST"
    ) {
      const body = await readJsonObject(request);
      const input = parseRuleInput(body.draft);
      const ruleId = optionalString(body, "ruleId");
      if (
        ruleId &&
        !(await backend.store.listRules()).some((rule) => rule.id === ruleId)
      ) throw new RequestError(404, "Rule not found", "errors.ruleNotFound");
      if (
        input.aliasId && !(await backend.store.findAliasById(input.aliasId))
      ) {
        throw new RequestError(
          400,
          "aliasId does not exist",
          "errors.aliasIdNotFound",
        );
      }
      return jsonResponse(
        await previewRule(
          backend.store,
          backend.blobStore,
          input,
          ruleId,
          backend.config.defaultForwardTo,
        ),
      );
    }
    if (
      (segments.length === 2 && request.method === "POST") ||
      (segments.length === 3 && request.method === "PATCH")
    ) {
      const partial = request.method === "PATCH";
      const input = parseRuleInput(await readJsonObject(request), partial);
      if (
        input.aliasId && !(await backend.store.findAliasById(input.aliasId))
      ) {
        throw new RequestError(
          400,
          "aliasId does not exist",
          "errors.aliasIdNotFound",
        );
      }
      const rule = partial
        ? await backend.store.updateRule(segments[2], input)
        : await backend.store.createRule(input);
      if (!rule) {
        return errorResponse(404, "Rule not found", "errors.ruleNotFound");
      }
      return jsonResponse(rule, { status: partial ? 200 : 201 });
    }
  }

  if (segments[1] === "messages") {
    if (
      segments.length === 3 && segments[2] === "batch-delete" &&
      request.method === "POST"
    ) {
      const body = await readJsonObject(request);
      const ids = optionalStringArray(body, "ids");

      if (!ids || ids.length === 0) {
        throw new RequestError(
          400,
          "ids must be a non-empty array of strings",
          "errors.nonEmptyStringArrayRequired",
          { field: "ids" },
        );
      }

      return jsonResponse(
        await deleteMessages(
          backend.store,
          backend.blobStore,
          ids,
          session.email,
        ),
      );
    }

    if (segments.length === 2 && request.method === "GET") {
      const status = url.searchParams.get("status");

      return jsonResponse(
        await backend.store.listMessages({
          aliasId: url.searchParams.get("aliasId") ?? undefined,
          limit: parseLimit(url),
          q: url.searchParams.get("q") ?? undefined,
          status: status ? parseMessageStatus(status, "status") : undefined,
        }),
      );
    }

    if (segments.length === 3 && request.method === "GET") {
      const message = await backend.store.getMessage(segments[2]);

      if (!message) {
        return errorResponse(
          404,
          "Message not found",
          "errors.messageNotFound",
        );
      }

      return jsonResponse(message);
    }

    if (segments.length === 3 && request.method === "PATCH") {
      const body = await readJsonObject(request);
      const message = await backend.store.updateMessage(segments[2], {
        status: body.status === undefined
          ? undefined
          : parseMessageStatus(body.status, "status"),
      });

      if (!message) {
        return errorResponse(
          404,
          "Message not found",
          "errors.messageNotFound",
        );
      }

      return jsonResponse(message);
    }

    if (
      segments.length === 4 && segments[3] === "tags" &&
      request.method === "PUT"
    ) {
      const body = await readJsonObject(request);
      const tags = optionalStringArray(body, "tags") ?? [];
      const message = await backend.store.getMessage(segments[2]);

      if (!message) {
        return errorResponse(
          404,
          "Message not found",
          "errors.messageNotFound",
        );
      }

      const nextTags = await backend.store.replaceMessageTags(
        segments[2],
        tags,
      );
      return jsonResponse({ messageId: segments[2], tags: nextTags });
    }

    if (
      segments.length === 4 && segments[3] === "content" &&
      request.method === "GET"
    ) {
      const message = await backend.store.getMessage(segments[2]);
      if (!message?.rawKey) {
        return errorResponse(
          404,
          "Raw message not found",
          "errors.rawMessageNotFound",
        );
      }
      const blob = await backend.blobStore.get(message.rawKey);
      if (!blob) {
        return errorResponse(
          404,
          "Raw message not found",
          "errors.rawMessageNotFound",
        );
      }
      const content = await readMessageContent(blob.body);
      if (message.verificationCodes === undefined) {
        content.codes = findVerificationCodes(content.text, content.subject);
        await backend.store.updateMessage(message.id, {
          verificationCodes: content.codes,
        });
      }
      return jsonResponse({
        ...content,
        codes: message.verificationCodes ?? content.codes,
      });
    }

    if (
      segments.length === 4 && segments[3] === "raw" && request.method === "GET"
    ) {
      const message = await backend.store.getMessage(segments[2]);

      if (!message?.rawKey) {
        return errorResponse(
          404,
          "Raw message not found",
          "errors.rawMessageNotFound",
        );
      }

      const blob = await backend.blobStore.get(message.rawKey);

      if (!blob) {
        return errorResponse(
          404,
          "Raw message not found",
          "errors.rawMessageNotFound",
        );
      }

      return new Response(blob.body, {
        headers: {
          "content-disposition": `attachment; filename="${message.id}.eml"`,
          "content-type": blob.contentType ?? "message/rfc822",
        },
      });
    }
  }

  if (
    segments[1] === "tags" && segments.length === 2 && request.method === "GET"
  ) {
    return jsonResponse(await backend.store.listTags());
  }

  if (url.pathname === "/api/audit" && request.method === "GET") {
    const { limit, filters } = parseAuditQuery(url.searchParams);
    const rows = await backend.store.listAuditEvents(limit + 1, filters);
    const events = rows.slice(0, limit);
    return jsonResponse({
      events,
      nextCursor: rows.length > limit
        ? auditCursor(events[events.length - 1])
        : null,
    });
  }

  if (
    segments[1] === "audit-events" && segments.length === 2 &&
    request.method === "GET"
  ) {
    return jsonResponse(await backend.store.listAuditEvents(parseLimit(url)));
  }

  return new Response("Not Found", { status: 404 });
}

export async function handleRequest(
  request: Request,
  backend: Backend,
): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === "/") {
    return jsonResponse(buildAppSnapshot(backend.config));
  }

  if (pathname === "/health") {
    return jsonResponse({ name: backend.config.appName, ok: true });
  }

  if (!pathname.startsWith("/api/")) {
    return new Response("Not Found", { status: 404 });
  }

  try {
    const response = await handleApiRequest(
      request,
      backend,
      new URL(request.url),
    );
    if (!response.headers.has("cache-control")) {
      response.headers.set("cache-control", "no-store");
    }
    if (response.ok && !["GET", "HEAD"].includes(request.method)) {
      await notifyInbox(backend.events);
    }
    return response;
  } catch (error) {
    if (
      error instanceof RequestError || error instanceof AuditQueryError ||
      error instanceof AuthenticationError ||
      error instanceof RuleValidationError || error instanceof SettingsError ||
      error instanceof GraphError
    ) {
      const coded = error as Error & CodedError;
      const response = errorResponse(
        error.status,
        error.message,
        coded.code,
        coded.params,
      );
      response.headers.set("cache-control", "no-store");
      return response;
    }

    console.error(error);
    const response = errorResponse(500, "Internal Server Error");
    response.headers.set("cache-control", "no-store");
    return response;
  }
}
