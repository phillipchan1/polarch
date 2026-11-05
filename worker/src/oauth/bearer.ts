/**
 * The MCP endpoint's door: turn `Authorization: Bearer pla_…` into a principal,
 * or say why not. The only place an access token is ever looked at.
 */
import { isAllowedEmail } from "../auth.ts";
import { resolveAuthBaseURL } from "../authUrl.ts";
import { API_SECURITY } from "../cors.ts";
import type { Sql } from "../db.ts";
import type { Env } from "../env.ts";
import type { McpPrincipal } from "../mcp/principal.ts";
import { ACCESS_PREFIX, TOUCH_INTERVAL_MS } from "./constants.ts";
import { sha256Hex } from "./crypto.ts";
import { scopesFromText } from "./redirect.ts";
import { findToken, touchGrant } from "./store.ts";

/** Longest token we will even hash. Ours are ~47 characters. */
const MAX_TOKEN_LENGTH = 200;

/** The bearer token on a request, or null. Scheme is case-insensitive (RFC 7235). */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer[ \t]+([^\s]+)$/i.exec(header.trim());
  const token = match?.[1];
  return token && token.length <= MAX_TOKEN_LENGTH ? token : null;
}

/**
 * Null for anything but a live access token: missing, malformed, unknown,
 * expired, revoked (the token or its whole grant), or a user who is no longer
 * on ALLOWED_EMAILS — removing someone from the allowlist cuts their MCP
 * access on the next call, not at token expiry.
 */
export async function authenticateBearer(
  sql: Sql,
  env: Env,
  req: Request,
  now: Date = new Date(),
): Promise<McpPrincipal | null> {
  const token = bearerToken(req);
  if (!token || !token.startsWith(ACCESS_PREFIX)) return null;
  const row = await findToken(sql, await sha256Hex(token));
  if (!row || row.kind !== "access") return null;
  if (row.revokedAt || row.grantRevokedAt) return null;
  if (row.expiresAt.getTime() <= now.getTime()) return null;
  if (!isAllowedEmail(env, row.email)) return null;

  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= TOUCH_INTERVAL_MS) {
    // Best effort: a failed bookkeeping write must not fail the call.
    await touchGrant(sql, row.grantId, now).catch(() => undefined);
  }
  return {
    userId: row.userId,
    clientId: row.clientId,
    scopes: scopesFromText(row.scope),
    tokenId: row.id,
  };
}

/**
 * 401 (no/invalid token) or 403 (valid token, missing scope) with the
 * RFC 9728 pointer a client follows to discover how to sign in. Browser-based
 * clients (the MCP Inspector) need to read the header, hence the CORS bits:
 * a bearer token is never an ambient credential, so `*` is safe here.
 */
export function unauthorizedResponse(
  env: Env,
  _req: Request,
  opts: { error?: "invalid_token" | "insufficient_scope"; scope?: string } = {},
): Response {
  const parts = ['realm="polarch"'];
  try {
    parts.push(`resource_metadata="${resolveAuthBaseURL(env)}/.well-known/oauth-protected-resource"`);
  } catch {
    // Misconfigured origin: still answer 401 rather than throw from the door.
  }
  if (opts.error) parts.push(`error="${opts.error}"`);
  if (opts.scope) parts.push(`scope="${opts.scope.replace(/["\\]/g, "")}"`);
  return new Response(
    JSON.stringify({
      error: opts.error ?? "unauthorized",
      error_description:
        opts.error === "insufficient_scope"
          ? "this connection was not granted the scope the tool needs"
          : "a valid access token is required",
    }),
    {
      status: opts.error === "insufficient_scope" ? 403 : 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer ${parts.join(", ")}`,
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "WWW-Authenticate",
        ...API_SECURITY,
      },
    },
  );
}
