import type {
  Alias,
  BootstrapResponse,
  CreateAliasInput,
  CreateRuleInput,
  MessageFilters,
  MessageRecord,
  MessageStatus,
  Rule,
  Tag,
} from "./types.ts";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function headersWithAuth(token: string, headers?: HeadersInit): Headers {
  const next = new Headers(headers);
  next.set("authorization", `Bearer ${token}`);
  return next;
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

async function requestJson<T>(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: headersWithAuth(token, init?.headers),
  });

  if (!response.ok) {
    return parseError(response);
  }

  return await response.json() as T;
}

async function requestBlob(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<Blob> {
  const response = await fetch(path, {
    ...init,
    headers: headersWithAuth(token, init?.headers),
  });

  if (!response.ok) {
    return parseError(response);
  }

  return await response.blob();
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
  async createAlias(token: string, input: CreateAliasInput): Promise<Alias> {
    const body = createBody(input);

    return await requestJson(token, "/api/aliases", {
      body: body.body,
      headers: body.headers,
      method: "POST",
    });
  },

  async createRule(token: string, input: CreateRuleInput): Promise<Rule> {
    const body = createBody(input);

    return await requestJson(token, "/api/rules", {
      body: body.body,
      headers: body.headers,
      method: "POST",
    });
  },

  async downloadRawMessage(token: string, messageId: string): Promise<Blob> {
    return await requestBlob(token, `/api/messages/${messageId}/raw`);
  },

  async getBootstrap(token: string): Promise<BootstrapResponse> {
    return await requestJson(token, "/api/bootstrap");
  },

  async listMessages(
    token: string,
    filters: MessageFilters,
  ): Promise<MessageRecord[]> {
    return await requestJson(
      token,
      `/api/messages${buildMessageQuery(filters)}`,
    );
  },

  async listTags(token: string): Promise<Tag[]> {
    return await requestJson(token, "/api/tags");
  },

  async patchAlias(
    token: string,
    aliasId: string,
    patch: Partial<Pick<Alias, "enabled">>,
  ): Promise<Alias> {
    const body = createBody(patch);

    return await requestJson(token, `/api/aliases/${aliasId}`, {
      body: body.body,
      headers: body.headers,
      method: "PATCH",
    });
  },

  async patchMessage(
    token: string,
    messageId: string,
    patch: { status: MessageStatus },
  ): Promise<MessageRecord> {
    const body = createBody(patch);

    return await requestJson(token, `/api/messages/${messageId}`, {
      body: body.body,
      headers: body.headers,
      method: "PATCH",
    });
  },

  async patchRule(
    token: string,
    ruleId: string,
    patch: Partial<Pick<Rule, "enabled">>,
  ): Promise<Rule> {
    const body = createBody(patch);

    return await requestJson(token, `/api/rules/${ruleId}`, {
      body: body.body,
      headers: body.headers,
      method: "PATCH",
    });
  },

  async replaceMessageTags(
    token: string,
    messageId: string,
    tags: string[],
  ): Promise<{ messageId: string; tags: string[] }> {
    const body = createBody({ tags });

    return await requestJson(token, `/api/messages/${messageId}/tags`, {
      body: body.body,
      headers: body.headers,
      method: "PUT",
    });
  },

  async validateSession(token: string): Promise<{ ok: boolean }> {
    return await requestJson(token, "/api/session");
  },
};
