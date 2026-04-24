import type { AppStore } from "./storage/types.ts";

export function readBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization")?.trim();

  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice("Bearer ".length).trim();
  return token || null;
}

export async function isAuthorizedRequest(
  request: Request,
  store: AppStore,
): Promise<boolean> {
  const token = readBearerToken(request);
  return token ? await store.validateToken(token) : false;
}
