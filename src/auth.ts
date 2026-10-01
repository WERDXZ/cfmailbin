import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import type { CfMailBinConfig } from "./config.ts";

export interface Session {
  email: string;
  mode: "access" | "development";
}

export class AuthenticationError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// Cache public signing keys, never user credentials or request state.
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function authenticateAccess(
  request: Request,
  config: CfMailBinConfig,
): Promise<Session> {
  const { accessTeamDomain, accessAudience, ownerEmail } = config;
  if (
    !ownerEmail || !accessAudience || !accessTeamDomain ||
    !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(accessTeamDomain)
  ) {
    throw new AuthenticationError(503, "Authentication is not configured");
  }

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) {
    throw new AuthenticationError(401, "Sign in with Cloudflare Access");
  }

  const issuer = `https://${accessTeamDomain}`;
  let keys = keySets.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    keySets.set(issuer, keys);
  }

  let email: unknown;
  try {
    const { payload } = await jwtVerify(token, keys, {
      algorithms: ["RS256"],
      audience: accessAudience,
      issuer,
      requiredClaims: ["exp", "email"],
    });
    email = payload.email;
  } catch (error) {
    if (
      error instanceof errors.JWTClaimValidationFailed ||
      error instanceof errors.JWTExpired ||
      error instanceof errors.JWTInvalid ||
      error instanceof errors.JWSInvalid ||
      error instanceof errors.JWSSignatureVerificationFailed ||
      error instanceof errors.JOSEAlgNotAllowed ||
      error instanceof errors.JOSENotSupported ||
      error instanceof errors.JWKSNoMatchingKey
    ) {
      throw new AuthenticationError(401, "Invalid or expired Access session");
    }
    throw new AuthenticationError(503, "Authentication unavailable");
  }

  if (typeof email !== "string" || !email.trim()) {
    throw new AuthenticationError(401, "Access user identity is required");
  }
  if (email.trim().toLowerCase() !== ownerEmail) {
    throw new AuthenticationError(403, "This account cannot access this inbox");
  }

  return { email: ownerEmail, mode: "access" };
}
