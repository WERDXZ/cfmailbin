import type {
  Alias,
  AuditEvent,
  AuditPage,
  BatchDeleteResponse,
  BootstrapResponse,
  CreateAliasInput,
  InboxResponse,
  MessageContent,
  MessageFilters,
  MessageRecord,
  MessageStatus,
  SessionResponse,
  Tag,
} from "./types.ts";
import type { RuntimeSettings, SettingsResponse } from "../settings.ts";
import type {
  GraphFragment,
  GraphNode,
  GraphPlan,
  GraphRun,
  MailGraph,
  NodePreset,
  PolicyDefinition,
} from "../graph/types.ts";

export interface GraphResponse {
  legacy: { rules: number; graph: boolean };
  effectiveGraph: MailGraph | null;
  graph: MailGraph | null;
  plan: GraphPlan | null;
  storage: "kv" | "memory" | "unavailable";
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly params?: Record<string, string | number>,
  ) {
    super(message);
  }
}

async function parseError(response: Response): Promise<never> {
  const isJson = response.headers.get("content-type")?.includes(
    "application/json",
  );

  if (isJson) {
    const payload = await response.json();
    throw new ApiError(
      response.status,
      payload.error ?? "Request failed",
      payload.code,
      payload.params,
    );
  }

  throw new ApiError(response.status, response.statusText || "Request failed");
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("x-cfmailbin-request", "1");
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    redirect: "manual",
    headers,
  });

  if (
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400) ||
    (response.ok && response.headers.get("content-type")?.includes("text/html"))
  ) {
    throw new ApiError(401, "Please sign in again");
  }
  if (!response.ok) {
    return parseError(response);
  }
  return response;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  return await (await request(path, init)).json() as T;
}

async function requestBlob(path: string): Promise<Blob> {
  return await (await request(path)).blob();
}

function createBody(body: unknown): { body: string; headers: Headers } {
  const headers = new Headers({ "content-type": "application/json" });

  return {
    body: JSON.stringify(body),
    headers,
  };
}

function buildMessageQuery(filters: MessageFilters): string {
  const params = new URLSearchParams();

  if (filters.aliasId) {
    params.set("aliasId", filters.aliasId);
  }

  if (filters.q) {
    params.set("q", filters.q);
  }

  if (filters.status) {
    params.set("status", filters.status);
  }

  params.set("limit", "100");
  const query = params.toString();
  return query ? `?${query}` : "";
}

export const api = {
  getPolicies(
    signal?: AbortSignal,
  ): Promise<
    {
      policies: PolicyDefinition[];
      templates: PolicyDefinition[];
      storage: string;
    }
  > {
    return requestJson("/api/policies", { signal });
  },
  savePolicy(policy: PolicyDefinition): Promise<PolicyDefinition> {
    return requestJson(`/api/policies/${encodeURIComponent(policy.id)}`, {
      method: "PUT",
      ...createBody(policy),
    });
  },
  deletePolicy(id: string): Promise<unknown> {
    return requestJson(`/api/policies/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },
  migrateGraph(
    source: "rules" | "graph",
  ): Promise<{ graph: MailGraph; warnings: string[] }> {
    return requestJson("/api/graph/migrate", {
      method: "POST",
      ...createBody({ source }),
    });
  },
  getGraph(signal?: AbortSignal): Promise<GraphResponse> {
    return requestJson("/api/graph", { signal });
  },
  getNodeLibrary(
    signal?: AbortSignal,
  ): Promise<
    { presets: NodePreset[]; templates: NodePreset[]; storage: string }
  > {
    return requestJson("/api/node-library", { signal });
  },
  saveNodePreset(
    id: string,
    node: GraphNode,
    revision?: string,
    fragment?: GraphFragment,
  ): Promise<NodePreset> {
    return requestJson(`/api/node-library/${encodeURIComponent(id)}`, {
      method: "PUT",
      ...createBody({ node, revision, fragment }),
    });
  },
  deleteNodePreset(id: string): Promise<unknown> {
    return requestJson(`/api/node-library/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },
  saveGraph(graph: MailGraph): Promise<GraphResponse> {
    return requestJson("/api/graph", { method: "PUT", ...createBody(graph) });
  },
  previewGraph(
    graph: MailGraph,
    input: { messageId?: string; sample?: { subject: string; text: string } },
  ): Promise<GraphRun> {
    return requestJson("/api/graph/preview", {
      method: "POST",
      ...createBody({ graph, ...input }),
    });
  },
  getSettings(signal?: AbortSignal): Promise<SettingsResponse> {
    return requestJson("/api/settings", { signal });
  },
  saveSettings(settings: RuntimeSettings): Promise<SettingsResponse> {
    return requestJson("/api/settings", {
      method: "PUT",
      ...createBody(settings),
    });
  },
  async getInbox(
    filters: MessageFilters,
    signal?: AbortSignal,
  ): Promise<InboxResponse> {
    return await requestJson(`/api/inbox${buildMessageQuery(filters)}`, {
      signal,
    });
  },
  async generateAlias(label: string, domain: string): Promise<Alias> {
    return await requestJson("/api/aliases/generate", {
      method: "POST",
      ...createBody({ label, domain }),
    });
  },

  async getMessageContent(
    id: string,
    signal?: AbortSignal,
  ): Promise<MessageContent> {
    return await requestJson(`/api/messages/${id}/content`, { signal });
  },
  async createAlias(input: CreateAliasInput): Promise<Alias> {
    const body = createBody(input);

    return await requestJson("/api/aliases", {
      body: body.body,
      headers: body.headers,
      method: "POST",
    });
  },

  async downloadRawMessage(messageId: string): Promise<Blob> {
    return await requestBlob(`/api/messages/${messageId}/raw`);
  },

  async deleteMessages(
    ids: string[],
  ): Promise<BatchDeleteResponse> {
    const body = createBody({ ids });

    return await requestJson("/api/messages/batch-delete", {
      body: body.body,
      headers: body.headers,
      method: "POST",
    });
  },

  async getBootstrap(signal?: AbortSignal): Promise<BootstrapResponse> {
    return await requestJson("/api/bootstrap", { signal });
  },

  async listMessages(
    filters: MessageFilters,
    signal?: AbortSignal,
  ): Promise<MessageRecord[]> {
    return await requestJson(
      `/api/messages${buildMessageQuery(filters)}`,
      { signal },
    );
  },

  async listTags(): Promise<Tag[]> {
    return await requestJson("/api/tags");
  },

  async getAuditPage(
    params: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<AuditPage> {
    return await requestJson(`/api/audit?${params}`, { signal });
  },

  async listAuditEvents(): Promise<AuditEvent[]> {
    return await requestJson("/api/audit-events?limit=100");
  },

  async patchAlias(
    aliasId: string,
    patch: Partial<Pick<Alias, "enabled" | "description" | "retentionDays">>,
  ): Promise<Alias> {
    const body = createBody(patch);

    return await requestJson(`/api/aliases/${aliasId}`, {
      body: body.body,
      headers: body.headers,
      method: "PATCH",
    });
  },

  async patchMessage(
    messageId: string,
    patch: { status: MessageStatus },
  ): Promise<MessageRecord> {
    const body = createBody(patch);

    return await requestJson(`/api/messages/${messageId}`, {
      body: body.body,
      headers: body.headers,
      method: "PATCH",
    });
  },

  async replaceMessageTags(
    messageId: string,
    tags: string[],
  ): Promise<{ messageId: string; tags: string[] }> {
    const body = createBody({ tags });

    return await requestJson(`/api/messages/${messageId}/tags`, {
      body: body.body,
      headers: body.headers,
      method: "PUT",
    });
  },

  async validateSession(): Promise<SessionResponse> {
    return await requestJson("/api/session");
  },
};
