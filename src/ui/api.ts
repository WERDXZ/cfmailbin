import type {
  Alias,
  AuditEvent,
  BatchDeleteResponse,
  BootstrapResponse,
  CreateAliasInput,
  CreateRuleInput,
  InboxResponse,
  MessageContent,
  MessageFilters,
  MessageRecord,
  MessageStatus,
  Rule,
  RulePreview,
  SessionResponse,
  Tag,
  UpdateRuleInput,
} from "./types.ts";
import type { RuntimeSettings, SettingsResponse } from "../settings.ts";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function parseError(response: Response): Promise<never> {
  const isJson = response.headers.get("content-type")?.includes(
    "application/json",
  );

  if (isJson) {
    const payload = await response.json();
    throw new ApiError(response.status, payload.error ?? "Request failed");
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

  async previewRule(
    draft: CreateRuleInput,
    ruleId?: string,
    signal?: AbortSignal,
  ): Promise<RulePreview> {
    return await requestJson("/api/rules/preview", {
      method: "POST",
      ...createBody({ draft, ruleId }),
      signal,
    });
  },
  async reorderRules(ids: string[]): Promise<Rule[]> {
    return await requestJson("/api/rules/reorder", {
      method: "POST",
      ...createBody({ ids }),
    });
  },

  async createRule(input: CreateRuleInput): Promise<Rule> {
    const body = createBody(input);

    return await requestJson("/api/rules", {
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

  async patchRule(
    ruleId: string,
    patch: UpdateRuleInput,
  ): Promise<Rule> {
    const body = createBody(patch);

    return await requestJson(`/api/rules/${ruleId}`, {
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
