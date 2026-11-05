/**
 * SQL for the OAuth tables (migration 006). Deliberately not routed through
 * `worker/src/store.ts`: these are not user-data tables and must never be
 * reachable from /api/data.
 *
 * The moves that must not tear — redeeming a code, rotating a refresh token —
 * are each ONE statement (a data-modifying CTE), so a crash or a lost race can
 * never burn a code without issuing tokens, or issue tokens twice. Callers
 * learn the outcome from the rows RETURNING hands back.
 */
import type { Sql } from "../db.ts";
import type { RateLimitDatabase } from "../rateLimit.ts";

type Row = Record<string, unknown>;

function run(sql: Sql, text: string, params: unknown[] = []): Promise<Row[]> {
  return sql.unsafe(text, params as never[]) as unknown as Promise<Row[]>;
}

const iso = (d: Date) => d.toISOString();
const asDate = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
const asDateOrNull = (v: unknown): Date | null => (v == null ? null : asDate(v));

/** rateLimit.ts speaks node-pg's connect/query; postgres.js `unsafe` has the same effect. */
export function rateLimitDb(sql: Sql): RateLimitDatabase {
  return {
    async connect() {
      return {
        async query(text: string, params: readonly unknown[]) {
          const rows = await run(sql, text, [...params]);
          return { rows, rowCount: rows.length };
        },
        release() {},
      };
    },
  };
}

// ── Clients ──────────────────────────────────────────────────────────────

export type Client = { clientId: string; clientName: string; redirectUris: string[] };

/** Ids we mint are 128-bit base64url with a prefix; refuse anything else before it reaches SQL. */
export const CLIENT_ID_SHAPE = /^[A-Za-z0-9_-]{8,64}$/;

function redirectUrisOf(value: unknown): string[] {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export async function getClient(sql: Sql, clientId: string): Promise<Client | null> {
  if (!CLIENT_ID_SHAPE.test(clientId)) return null;
  const rows = await run(
    sql,
    `SELECT client_id, client_name, redirect_uris FROM public.oauth_clients WHERE client_id = $1`,
    [clientId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    clientId: String(row.client_id),
    clientName: String(row.client_name),
    redirectUris: redirectUrisOf(row.redirect_uris),
  };
}

/**
 * Insert unless the table is at `cap`. Clients nobody ever approved and that are
 * more than a day old are dropped first, so an unauthenticated registration
 * flood can neither fill the table nor lock real registrations out for long.
 */
export async function registerClient(
  sql: Sql,
  client: Client,
  cap: number,
  now: Date,
): Promise<boolean> {
  const count = async () =>
    Number((await run(sql, `SELECT count(*)::int AS n FROM public.oauth_clients`))[0]?.n ?? 0);
  if ((await count()) >= cap) {
    await run(
      sql,
      `DELETE FROM public.oauth_clients c
        WHERE c.created_at < $1::timestamptz
          AND NOT EXISTS (SELECT 1 FROM public.oauth_grants g WHERE g.client_id = c.client_id)`,
      [iso(new Date(now.getTime() - 24 * 3600_000))],
    );
    if ((await count()) >= cap) return false;
  }
  await run(
    sql,
    `INSERT INTO public.oauth_clients (client_id, client_name, redirect_uris, created_at)
     VALUES ($1, $2, $3::jsonb, $4::timestamptz)`,
    [client.clientId, client.clientName, client.redirectUris, iso(now)],
  );
  return true;
}

// ── Authorization codes ──────────────────────────────────────────────────

export type NewCode = {
  codeHash: string;
  clientId: string;
  userId: string;
  grantId: string;
  redirectUri: string;
  challenge: string;
  scope: string;
  resource: string | null;
  expiresAt: Date;
};

export async function insertCode(sql: Sql, code: NewCode, now: Date): Promise<void> {
  await run(
    sql,
    `INSERT INTO public.oauth_codes
       (code_hash, client_id, user_id, grant_id, redirect_uri, code_challenge, scope, resource, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz)`,
    [
      code.codeHash,
      code.clientId,
      code.userId,
      code.grantId,
      code.redirectUri,
      code.challenge,
      code.scope,
      code.resource,
      iso(code.expiresAt),
      iso(now),
    ],
  );
}

export type CodeRow = NewCode & { usedAt: Date | null; email: string | null };

export async function findCode(sql: Sql, codeHash: string): Promise<CodeRow | null> {
  const rows = await run(
    sql,
    `SELECT c.*, u.email
       FROM public.oauth_codes c
       LEFT JOIN public."user" u ON u.id = c.user_id
      WHERE c.code_hash = $1`,
    [codeHash],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    codeHash: String(r.code_hash),
    clientId: String(r.client_id),
    userId: String(r.user_id),
    grantId: String(r.grant_id),
    redirectUri: String(r.redirect_uri),
    challenge: String(r.code_challenge),
    scope: String(r.scope),
    resource: r.resource == null ? null : String(r.resource),
    expiresAt: asDate(r.expires_at),
    usedAt: asDateOrNull(r.used_at),
    email: r.email == null ? null : String(r.email),
  };
}

export type IssuedToken = { id: string; hash: string; expiresAt: Date };

/**
 * Redeem a code: mark it used, create the grant and both tokens — or none of
 * them. False means the code was already used (a lost race or a replay).
 */
export async function redeemCode(
  sql: Sql,
  codeHash: string,
  access: IssuedToken,
  refresh: IssuedToken,
  now: Date,
): Promise<boolean> {
  const rows = await run(
    sql,
    `WITH used AS (
       UPDATE public.oauth_codes SET used_at = $1::timestamptz
        WHERE code_hash = $2 AND used_at IS NULL
        RETURNING user_id, client_id, grant_id, scope
     ), g AS (
       INSERT INTO public.oauth_grants (id, user_id, client_id, scope, created_at)
       SELECT grant_id, user_id, client_id, scope, $1::timestamptz FROM used
       RETURNING id, scope
     )
     INSERT INTO public.oauth_tokens (id, grant_id, kind, token_hash, scope, expires_at, created_at)
     SELECT v.id, g.id, v.kind, v.token_hash, g.scope, v.expires_at, $1::timestamptz
       FROM g,
            (VALUES ($3::text, 'access'::text, $4::text, $5::timestamptz),
                    ($6::text, 'refresh'::text, $7::text, $8::timestamptz))
            AS v(id, kind, token_hash, expires_at)
     RETURNING id`,
    [
      iso(now),
      codeHash,
      access.id,
      access.hash,
      iso(access.expiresAt),
      refresh.id,
      refresh.hash,
      iso(refresh.expiresAt),
    ],
  );
  return rows.length === 2;
}

/**
 * A personal access token: for a bot that takes a URL and a bearer token
 * instead of running the OAuth dance. It is its own client (no redirect URIs,
 * so it can never start an authorization), one grant and one long-lived access
 * token — so it lists, and disconnects, like any other connected app.
 * One statement, so a token never exists without its grant or vice versa.
 */
export async function issuePersonalToken(
  sql: Sql,
  t: { clientId: string; name: string; userId: string; grantId: string; scope: string; token: IssuedToken },
  now: Date,
): Promise<boolean> {
  const rows = await run(
    sql,
    `WITH c AS (
       INSERT INTO public.oauth_clients (client_id, client_name, redirect_uris, created_at)
       VALUES ($1, $2, '[]'::jsonb, $3::timestamptz)
       RETURNING client_id
     ), g AS (
       INSERT INTO public.oauth_grants (id, user_id, client_id, scope, created_at)
       SELECT $4, $5, c.client_id, $6, $3::timestamptz FROM c
       RETURNING id, scope
     )
     INSERT INTO public.oauth_tokens (id, grant_id, kind, token_hash, scope, expires_at, created_at)
     SELECT $7, g.id, 'access', $8, g.scope, $9::timestamptz, $3::timestamptz FROM g
     RETURNING id`,
    [t.clientId, t.name, iso(now), t.grantId, t.userId, t.scope, t.token.id, t.token.hash, iso(t.token.expiresAt)],
  );
  return rows.length === 1;
}

// ── Tokens and grants ────────────────────────────────────────────────────

export type TokenRow = {
  id: string;
  kind: "access" | "refresh";
  grantId: string;
  scope: string;
  expiresAt: Date;
  revokedAt: Date | null;
  userId: string;
  clientId: string;
  grantCreatedAt: Date;
  grantRevokedAt: Date | null;
  lastUsedAt: Date | null;
  email: string | null;
};

export async function findToken(sql: Sql, tokenHash: string): Promise<TokenRow | null> {
  const rows = await run(
    sql,
    `SELECT t.id, t.kind, t.grant_id, t.scope, t.expires_at, t.revoked_at,
            g.user_id, g.client_id, g.created_at AS grant_created_at,
            g.revoked_at AS grant_revoked_at, g.last_used_at, u.email
       FROM public.oauth_tokens t
       JOIN public.oauth_grants g ON g.id = t.grant_id
       LEFT JOIN public."user" u ON u.id = g.user_id
      WHERE t.token_hash = $1`,
    [tokenHash],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: String(r.id),
    kind: r.kind === "refresh" ? "refresh" : "access",
    grantId: String(r.grant_id),
    scope: String(r.scope),
    expiresAt: asDate(r.expires_at),
    revokedAt: asDateOrNull(r.revoked_at),
    userId: String(r.user_id),
    clientId: String(r.client_id),
    grantCreatedAt: asDate(r.grant_created_at),
    grantRevokedAt: asDateOrNull(r.grant_revoked_at),
    lastUsedAt: asDateOrNull(r.last_used_at),
    email: r.email == null ? null : String(r.email),
  };
}

/**
 * Rotate a refresh token: revoke it and issue a fresh pair, in one statement.
 * The new access token carries `accessScope` (a narrowing the client asked for);
 * the new refresh token always keeps the original scope. False means the old
 * token was already revoked — someone presented it twice.
 */
export async function rotateRefresh(
  sql: Sql,
  oldTokenId: string,
  access: IssuedToken,
  refresh: IssuedToken,
  accessScope: string,
  now: Date,
): Promise<boolean> {
  const rows = await run(
    sql,
    `WITH old AS (
       UPDATE public.oauth_tokens SET revoked_at = $1::timestamptz
        WHERE id = $2 AND kind = 'refresh' AND revoked_at IS NULL
        RETURNING grant_id, scope
     )
     INSERT INTO public.oauth_tokens (id, grant_id, kind, token_hash, scope, expires_at, created_at)
     SELECT v.id, old.grant_id, v.kind, v.token_hash,
            CASE WHEN v.kind = 'access' THEN $9::text ELSE old.scope END,
            v.expires_at, $1::timestamptz
       FROM old,
            (VALUES ($3::text, 'access'::text, $4::text, $5::timestamptz),
                    ($6::text, 'refresh'::text, $7::text, $8::timestamptz))
            AS v(id, kind, token_hash, expires_at)
     RETURNING id`,
    [
      iso(now),
      oldTokenId,
      access.id,
      access.hash,
      iso(access.expiresAt),
      refresh.id,
      refresh.hash,
      iso(refresh.expiresAt),
      accessScope,
    ],
  );
  return rows.length === 2;
}

/** Revoke a whole grant (the family). The grant row alone is enough for the bearer check. */
export async function revokeGrant(sql: Sql, grantId: string, now: Date): Promise<void> {
  await run(
    sql,
    `UPDATE public.oauth_grants SET revoked_at = COALESCE(revoked_at, $1::timestamptz) WHERE id = $2`,
    [iso(now), grantId],
  );
  await run(
    sql,
    `UPDATE public.oauth_tokens SET revoked_at = $1::timestamptz WHERE grant_id = $2 AND revoked_at IS NULL`,
    [iso(now), grantId],
  );
}

/** Every grant a user gave one client. Returns how many were live. */
export async function revokeUserClient(
  sql: Sql,
  userId: string,
  clientId: string,
  now: Date,
): Promise<number> {
  const revoked = await run(
    sql,
    `UPDATE public.oauth_grants SET revoked_at = $1::timestamptz
      WHERE user_id = $2 AND client_id = $3 AND revoked_at IS NULL
      RETURNING id`,
    [iso(now), userId, clientId],
  );
  await run(
    sql,
    `UPDATE public.oauth_tokens SET revoked_at = $1::timestamptz
      WHERE revoked_at IS NULL
        AND grant_id IN (SELECT id FROM public.oauth_grants WHERE user_id = $2 AND client_id = $3)`,
    [iso(now), userId, clientId],
  );
  return revoked.length;
}

export async function touchGrant(sql: Sql, grantId: string, now: Date): Promise<void> {
  await run(sql, `UPDATE public.oauth_grants SET last_used_at = $1::timestamptz WHERE id = $2`, [
    iso(now),
    grantId,
  ]);
}

export type Connection = {
  clientId: string;
  clientName: string;
  scopes: string;
  redirectUris: string[];
  connectedAt: Date;
  lastUsedAt: Date | null;
};

/** One row per client the user has a live grant with (a grant needs an unexpired, unrevoked token). */
export async function listConnections(sql: Sql, userId: string, now: Date): Promise<Connection[]> {
  const rows = await run(
    sql,
    `SELECT c.client_id, c.client_name, c.redirect_uris,
            string_agg(DISTINCT g.scope, ' ') AS scopes,
            min(g.created_at) AS connected_at,
            max(g.last_used_at) AS last_used_at
       FROM public.oauth_grants g
       JOIN public.oauth_clients c ON c.client_id = g.client_id
      WHERE g.user_id = $1
        AND g.revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM public.oauth_tokens t
                     WHERE t.grant_id = g.id AND t.revoked_at IS NULL AND t.expires_at > $2::timestamptz)
      GROUP BY c.client_id, c.client_name, c.redirect_uris
      ORDER BY max(COALESCE(g.last_used_at, g.created_at)) DESC`,
    [userId, iso(now)],
  );
  return rows.map((r) => ({
    clientId: String(r.client_id),
    clientName: String(r.client_name),
    scopes: String(r.scopes ?? ""),
    redirectUris: redirectUrisOf(r.redirect_uris),
    connectedAt: asDate(r.connected_at),
    lastUsedAt: asDateOrNull(r.last_used_at),
  }));
}

/**
 * Housekeeping, run when someone approves a connection (rare, already writing).
 * Rotated refresh tokens are kept until they would have expired anyway — that
 * is how reuse is recognized — plus a week.
 */
export async function prune(sql: Sql, now: Date): Promise<void> {
  const ago = (ms: number) => iso(new Date(now.getTime() - ms));
  const day = 24 * 3600_000;
  await run(sql, `DELETE FROM public.oauth_codes WHERE expires_at < $1::timestamptz`, [ago(day)]);
  await run(sql, `DELETE FROM public.oauth_tokens WHERE expires_at < $1::timestamptz`, [ago(7 * day)]);
  await run(
    sql,
    `DELETE FROM public.oauth_grants g
      WHERE g.created_at < $1::timestamptz
        AND NOT EXISTS (SELECT 1 FROM public.oauth_tokens t WHERE t.grant_id = g.id)`,
    [ago(30 * day)],
  );
}
