import { isAuthorizedRequest } from "./auth.ts";
import type { CfMailBinConfig } from "./config.ts";
import type {
  CreateAliasInput,
  CreateRuleInput,
  MessageStatus,
  RuleAction,
  RuleField,
} from "./domain/models.ts";
import type { AppStore, BlobStore } from "./storage/types.ts";

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
  blobStore: BlobStore;
  config: CfMailBinConfig;
  store: AppStore;
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init);
}

function errorResponse(status: number, message: string): Response {
  return jsonResponse({ error: message }, { status });
}

async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new RequestError(400, "Expected a JSON object body");
    }

    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RequestError) {
      throw error;
    }

    throw new RequestError(400, "Invalid JSON body");
  }
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];

  if (typeof value !== "string" || value.trim() === "") {
    throw new RequestError(400, `${field} must be a non-empty string`);
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
    throw new RequestError(400, `${field} must be a string`);
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
    throw new RequestError(400, `${field} must be a string or null`);
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
    throw new RequestError(400, `${field} must be a boolean`);
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
    throw new RequestError(400, `${field} must be a positive integer`);
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
    throw new RequestError(400, `${field} must be an array of strings`);
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
  );
}

function parseRuleField(value: unknown, field: string): RuleField {
  if (value === "alias" || value === "from" || value === "subject") {
    return value;
  }

  throw new RequestError(400, `${field} must be alias, from, or subject`);
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
  );
}

function parseLimit(url: URL): number {
  const limit = url.searchParams.get("limit");

  if (!limit) {
    return 50;
  }

  const parsed = Number(limit);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new RequestError(400, "limit must be a positive integer");
  }

  return Math.min(parsed, 100);
}

function clearableAliasId(
  body: Record<string, unknown>,
  field: string,
): string | null | undefined {
  const value = body[field];

  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== "string" || value.trim() === "") {
    throw new RequestError(400, `${field} must be a string or null`);
  }

  return value.trim();
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
        description: "Validate the current bearer token.",
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
        description: "Read or patch a message.",
        method: "GET|PATCH",
        path: "/api/messages/:id",
      },
      {
        description: "Replace a message tag set.",
        method: "PUT",
        path: "/api/messages/:id/tags",
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
  if (!(await isAuthorizedRequest(request, backend.store))) {
    return errorResponse(401, "Unauthorized");
  }

  const segments = url.pathname.split("/").filter(Boolean);

  if (request.method === "GET" && url.pathname === "/api/session") {
    return jsonResponse({ ok: true });
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
        allowCatchAll: backend.config.allowCatchAll,
        autoCreateAliasTag: backend.config.autoCreateAliasTag,
        defaultRetentionDays: backend.config.defaultRetentionDays,
        forwardingConfigured: Boolean(backend.config.defaultForwardTo),
      },
      rules,
      tags,
    });
  }

  if (segments[1] === "aliases") {
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
        description: optionalNullableString(body, "description"),
        enabled: optionalBoolean(body, "enabled"),
        forwardTo: optionalNullableString(body, "forwardTo"),
        retentionDays: optionalPositiveInteger(body, "retentionDays"),
      });

      if (!alias) {
        return errorResponse(404, "Alias not found");
      }

      return jsonResponse(alias);
    }
  }

  if (segments[1] === "rules") {
    if (segments.length === 2 && request.method === "GET") {
      return jsonResponse(await backend.store.listRules());
    }

    if (segments.length === 2 && request.method === "POST") {
      const body = await readJsonObject(request);
      const aliasId = clearableAliasId(body, "aliasId") ?? null;

      if (aliasId && !(await backend.store.findAliasById(aliasId))) {
        return errorResponse(400, "aliasId does not exist");
      }

      const input: CreateRuleInput = {
        action: parseRuleAction(body.action, "action"),
        aliasId,
        enabled: optionalBoolean(body, "enabled"),
        field: parseRuleField(body.field, "field"),
        pattern: requiredString(body, "pattern"),
      };
      const rule = await backend.store.createRule(input);
      return jsonResponse(rule, { status: 201 });
    }

    if (segments.length === 3 && request.method === "PATCH") {
      const body = await readJsonObject(request);
      const aliasId = clearableAliasId(body, "aliasId");

      if (aliasId && !(await backend.store.findAliasById(aliasId))) {
        return errorResponse(400, "aliasId does not exist");
      }

      const rule = await backend.store.updateRule(segments[2], {
        action: body.action === undefined
          ? undefined
          : parseRuleAction(body.action, "action"),
        aliasId,
        enabled: optionalBoolean(body, "enabled"),
        field: body.field === undefined
          ? undefined
          : parseRuleField(body.field, "field"),
        pattern: optionalString(body, "pattern"),
      });

      if (!rule) {
        return errorResponse(404, "Rule not found");
      }

      return jsonResponse(rule);
    }
  }

  if (segments[1] === "messages") {
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
        return errorResponse(404, "Message not found");
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
        return errorResponse(404, "Message not found");
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
        return errorResponse(404, "Message not found");
      }

      const nextTags = await backend.store.replaceMessageTags(
        segments[2],
        tags,
      );
      return jsonResponse({ messageId: segments[2], tags: nextTags });
    }

    if (
      segments.length === 4 && segments[3] === "raw" && request.method === "GET"
    ) {
      const message = await backend.store.getMessage(segments[2]);

      if (!message?.rawKey) {
        return errorResponse(404, "Raw message not found");
      }

      const blob = await backend.blobStore.get(message.rawKey);

      if (!blob) {
        return errorResponse(404, "Raw message not found");
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
    return await handleApiRequest(request, backend, new URL(request.url));
  } catch (error) {
    if (error instanceof RequestError) {
      return errorResponse(error.status, error.message);
    }

    console.error(error);
    return errorResponse(500, "Internal Server Error");
  }
}
