import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { bearer, magicLink } from "better-auth/plugins";
import { Pool } from "pg";
import {
  authCookieSecure,
  isLocalAuthRuntime,
  resolveAuthBaseURL,
  resolveAuthCookieDomain,
  resolveTrustedOrigins,
} from "./authUrl.ts";
import { clientConnection, poolSsl } from "./db.ts";
import { databaseUrl, type Env } from "./env.ts";
import { logMagicLinkSendFailure, logMagicLinkSoftCapSkip, sendMagicLinkEmail } from "./mail.ts";
import {
  authRateLimitCustomRules,
  consumeEmailMagicLinkLimit,
  consumeEmailMagicLinkSoftCap,
  createDatabaseRateLimitStorage,
  rateLimitDeniedResponse,
} from "./rateLimit.ts";

export type AuthInstance = ReturnType<typeof createAuth>;

const ownedPools = new WeakMap<object, { end(): Promise<void> }>();
const pendingBackground = new WeakMap<object, Set<Promise<unknown>>>();
const authDatabases = new WeakMap<object, AuthDatabase>();
const authEnvs = new WeakMap<object, Env>();

/**
 * Neon / PGlite columns are snake_case. Better Auth's default identifiers are
 * camelCase (`emailVerified`, `expiresAt`, `userId`, …). Without this map the
 * adapter emits `column "emailVerified" does not exist`.
 */
export const authModels = {
  user: {
    modelName: "user",
    fields: {
      emailVerified: "email_verified",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  session: {
    modelName: "session",
    fields: {
      expiresAt: "expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
      ipAddress: "ip_address",
      userAgent: "user_agent",
      userId: "user_id",
    },
  },
  account: {
    modelName: "account",
    fields: {
      accountId: "account_id",
      providerId: "provider_id",
      userId: "user_id",
      accessToken: "access_token",
      refreshToken: "refresh_token",
      idToken: "id_token",
      accessTokenExpiresAt: "access_token_expires_at",
      refreshTokenExpiresAt: "refresh_token_expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  verification: {
    modelName: "verification",
    fields: {
      expiresAt: "expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
} as const;

export function allowedEmails(env: Pick<Env, "ALLOWED_EMAILS">): Set<string> {
  return new Set(
    (env.ALLOWED_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAllowedEmail(
  env: Pick<Env, "ALLOWED_EMAILS">,
  email: string | null | undefined,
): boolean {
  if (!email || typeof email !== "string") return false;
  const trimmed = email.trim().toLowerCase();
  if (!trimmed) return false;
  return allowedEmails(env).has(trimmed);
}

/**
 * Google is on only when both Worker secrets are set. Otherwise
 * `/api/auth/sign-in/social` answers "provider not found" and the Login
 * screen hides the button; the magic link is unaffected either way.
 */
export function googleConfigured(
  env: Pick<Env, "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET">,
): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim());
}

export function googleSocialProviders(env: Pick<Env, "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET">) {
  if (!googleConfigured(env)) return undefined;
  return {
    google: {
      clientId: env.GOOGLE_CLIENT_ID!.trim(),
      clientSecret: env.GOOGLE_CLIENT_SECRET!.trim(),
      prompt: "select_account" as const,
      // Better Auth lowercases the email before validateUserInfo sees it, and
      // toLowerCase folds look-alikes (U+212A KELVIN SIGN -> "k"). Judge the
      // raw Google email here: anything but plain printable ASCII is treated
      // as unverified, which validateUserInfo then refuses.
      mapProfileToUser: (profile: { email?: unknown }) =>
        emailShapeOk(profile.email) ? {} : { emailVerified: false },
    },
  };
}

/**
 * Link Google to the existing user by email. `google` is trusted so Better
 * Auth will link it, but `validateUserInfo` still refuses any OAuth profile
 * whose email Google has not verified (see `oauthEmailMustBeVerified`), and
 * the local user must be verified too (`requireLocalEmailVerified`). Same
 * email only. Existing users land on their own row; no duplicate is made.
 */
export const ACCOUNT_LINKING = {
  enabled: true,
  trustedProviders: ["google"] as string[],
  requireLocalEmailVerified: true,
  allowDifferentEmails: false,
};

/**
 * Stored emails must be exactly what the allowlist compares: no padding
 * (isAllowedEmail trims, Better Auth stores as-is, so " phil@x " would become
 * a second user) and printable ASCII only (toLowerCase folds U+212A KELVIN
 * SIGN to "k", so a Unicode look-alike could pass the allowlist).
 */
export const EMAIL_ASCII = /^[\x21-\x7e]+$/;
export function emailShapeOk(email: unknown): email is string {
  return typeof email === "string" && email === email.trim() && EMAIL_ASCII.test(email);
}

/** Better Auth's id-token link path skips validateUserInfo; Polarch links by redirect only. */
export const LINK_SOCIAL_ID_TOKEN_BLOCKED = "link_social_id_token_disabled";

/** OAuth (Google) must carry a provider-verified email to create, link or sign in. */
export function oauthEmailMustBeVerified(
  user: { emailVerified?: unknown },
  source: { method?: string },
): boolean {
  if (source.method !== "oauth") return true;
  return user.emailVerified === true;
}

/** Prod keys rate limits on CF-Connecting-IP only so XFF/X-Real-IP cannot spoof. */
export const PROD_AUTH_IP_HEADERS = ["cf-connecting-ip"] as const;
export const LOCAL_AUTH_IP_HEADERS = [
  "cf-connecting-ip",
  "x-real-ip",
  "x-forwarded-for",
] as const;

export function authIpAddressHeaders(env: Pick<Env, "ENVIRONMENT">): string[] {
  return isLocalAuthRuntime(env) ? [...LOCAL_AUTH_IP_HEADERS] : [...PROD_AUTH_IP_HEADERS];
}

/** Same header order Better Auth uses for the per-IP limiter. */
export function clientAuthIp(headers: Headers, env: Pick<Env, "ENVIRONMENT">): string {
  for (const name of authIpAddressHeaders(env)) {
    const value = headers.get(name);
    if (!value) continue;
    const first = value.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}

/**
 * Better Auth magic-link verify looks up `user` by lowercased email and
 * only creates a row when none exists. A migrated Supabase user (same
 * UUID + email) is therefore the first-sign-in target.
 */
export function existingUserForMagicLinkEmail(
  users: readonly { id: string; email: string }[],
  email: string,
): { id: string; email: string } | null {
  const want = email.trim().toLowerCase();
  if (!want) return null;
  return users.find((u) => u.email.trim().toLowerCase() === want) ?? null;
}

/** `pg.Pool` or a PGlite stand-in with the same connect/query/end surface. */
export type AuthDatabase =
  | Pool
  | {
      connect(): Promise<{
        query(
          sql: string,
          parameters: readonly unknown[],
        ): Promise<{ command: string; rowCount: number; rows: unknown[] }>;
        release(): void;
      }>;
      end(): Promise<void>;
      options: object;
    };

export type CreateAuthOptions = {
  /** Workers: `ctx.waitUntil`. Mail is scheduled here so the HTTP response stays fast. */
  waitUntil?: (task: Promise<unknown>) => void;
  /**
   * When true, `closeAuth` calls `end()` on the provided database. Used by
   * Worker-owned Pools (the default) and by tests that reproduce the
   * close-vs-background race.
   */
  closeDatabase?: boolean;
};

/**
 * Same dispatch for a real send and a soft-cap skip log. Never awaited —
 * Cloudflare Email and the console log both run on this path only. DB work for the
 * cap (including the first-skip log key) is already done on the request.
 */
export function scheduleAuthBackground(
  waitUntil: ((task: Promise<unknown>) => void) | undefined,
  task: Promise<unknown>,
  pending?: Set<Promise<unknown>>,
): void {
  const safe = task.catch(logMagicLinkSendFailure);
  pending?.add(safe);
  safe.finally(() => pending?.delete(safe));
  waitUntil?.(safe);
}

/** Real Cloudflare Email send, or the soft-cap no-op (console log only — no DB). */
export function deliverMagicLinkOrSkip(
  env: Env,
  opts: { email: string; url: string; token: string; send: boolean; firstSkip?: boolean },
): Promise<unknown> {
  if (!opts.send) {
    return Promise.resolve()
      .then(() => {
        if (opts.firstSkip) logMagicLinkSoftCapSkip();
      })
      .catch((err) => {
        logMagicLinkSendFailure(err);
      });
  }
  return sendMagicLinkEmail(env, {
    email: opts.email,
    url: opts.url,
    token: opts.token,
  }).catch((err) => {
    logMagicLinkSendFailure(err);
  });
}

export function createAuth(env: Env, database?: AuthDatabase, options?: CreateAuthOptions) {
  const url = databaseUrl(env);
  if (!database && !url) {
    throw new Error("database is not configured (HYPERDRIVE or DATABASE_URL)");
  }
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is not set");
  const baseURL = resolveAuthBaseURL(env);
  const cookieDomain = resolveAuthCookieDomain(env);
  let owned: Pool | undefined;
  const opts = url ? clientConnection(env, url) : null;
  const db =
    database ??
    (owned = new Pool({
      connectionString: opts!.connectionString,
      max: 1,
      ssl: poolSsl(opts!.ssl),
    }));
  const pending = new Set<Promise<unknown>>();
  const auth = betterAuth({
    secret,
    baseURL,
    basePath: "/api/auth",
    database: db as Pool,
    emailAndPassword: { enabled: false },
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "rate_limit",
      fields: { lastRequest: "last_request" },
      window: 60,
      max: 60,
      customRules: authRateLimitCustomRules(),
      customStorage: createDatabaseRateLimitStorage(db),
    },
    user: {
      ...authModels.user,
      validateUserInfo: ({ user, source }) => {
        if (
          source.action !== "create-user" &&
          source.action !== "link-account" &&
          source.action !== "sign-in"
        ) {
          return;
        }
        if (!emailShapeOk(user.email)) {
          return {
            error: "invalid_email",
            errorDescription: "this account is not allowed",
          };
        }
        if (!oauthEmailMustBeVerified(user, source)) {
          return {
            error: "email_not_verified",
            errorDescription: "this account is not allowed",
          };
        }
        if (isAllowedEmail(env, typeof user.email === "string" ? user.email : null)) {
          return;
        }
        return {
          error: "not_allowed",
          errorDescription: "this account is not allowed",
        };
      },
    },
    socialProviders: googleSocialProviders(env),
    // OAuth failures (bad state, no code, refused profile) land on the Login
    // screen as /signin?error=<code>, never Better Auth's bare /error page.
    onAPIError: { errorURL: baseURL ? `${baseURL}/signin` : "/signin" },
    hooks: {
      // POST /link-social with an idToken bypasses validateUserInfo (and, with
      // google trusted, the email_verified check). Refuse it outright.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/link-social") return;
        const body = ctx.body as { idToken?: unknown } | undefined;
        if (body && body.idToken !== undefined && body.idToken !== null) {
          throw new APIError("FORBIDDEN", {
            code: LINK_SOCIAL_ID_TOKEN_BLOCKED,
            message: "Link Google with the Continue with Google button.",
          });
        }
      }),
    },
    session: authModels.session,
    account: {
      ...authModels.account,
      accountLinking: ACCOUNT_LINKING,
    },
    verification: authModels.verification,
    trustedOrigins: resolveTrustedOrigins(env),
    advanced: {
      database: {
        generateId: () => crypto.randomUUID(),
      },
      ...(cookieDomain
        ? { crossSubDomainCookies: { enabled: true, domain: cookieDomain } }
        : {}),
      defaultCookieAttributes: {
        sameSite: "lax",
        secure: authCookieSecure(baseURL),
        httpOnly: true,
        path: "/",
        ...(cookieDomain ? { domain: cookieDomain } : {}),
      },
      ipAddress: {
        ipAddressHeaders: authIpAddressHeaders(env),
      },
    },
    plugins: [
      bearer({ requireSignature: true }),
      magicLink({
        expiresIn: 60 * 10,
        sendMagicLink: async ({ email, url, token }) => {
          if (!isAllowedEmail(env, email)) return;
          const soft = await consumeEmailMagicLinkSoftCap(db, email);
          scheduleAuthBackground(
            options?.waitUntil,
            deliverMagicLinkOrSkip(env, {
              email,
              url,
              token,
              send: soft.allowed,
              firstSkip: soft.firstSkip,
            }),
            pending,
          );
        },
      }),
    ],
  });
  if (owned) ownedPools.set(auth, owned);
  else if (options?.closeDatabase && database) ownedPools.set(auth, database);
  pendingBackground.set(auth, pending);
  authDatabases.set(auth, db);
  authEnvs.set(auth, env);
  return auth;
}

/** Per-request Better Auth. Not cached — Workers cannot reuse the Pool. */
export function getAuth(env: Env): AuthInstance {
  return createAuth(env);
}

const CLOSE_AUTH_DRAIN_MS = 5000;

export async function closeAuth(auth: AuthInstance): Promise<void> {
  const pending = pendingBackground.get(auth);
  if (pending?.size) {
    await Promise.race([
      Promise.allSettled([...pending]),
      new Promise<void>((resolve) => {
        setTimeout(resolve, CLOSE_AUTH_DRAIN_MS);
      }),
    ]);
  }
  const pool = ownedPools.get(auth);
  if (pool) await pool.end();
}

/**
 * Better Auth handler plus the extra email buckets.
 * Built-in limiter is IP + path only; this adds 3/min per email+IP,
 * then 10/hr per email+IP-prefix (/24 or /48). A 200/hr per-email soft
 * cap is applied in sendMagicLink (await both key consumes, then skip
 * send or log on the same waitUntil path), not here.
 */
export async function handleAuthRequest(auth: AuthInstance, req: Request): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (req.method === "POST" && path.endsWith("/sign-in/magic-link")) {
    const db = authDatabases.get(auth);
    if (db) {
      let email = "";
      try {
        const body = (await req.clone().json()) as { email?: unknown };
        if (typeof body.email === "string") email = body.email;
      } catch {
        /* Better Auth answers invalid JSON */
      }
      const gate = authEnvs.get(auth);
      if (email && gate && isAllowedEmail(gate, email)) {
        const result = await consumeEmailMagicLinkLimit(db, email, clientAuthIp(req.headers, gate));
        if (!result.allowed) return rateLimitDeniedResponse(result.retryAfter ?? 60);
      }
    }
  }
  return auth.handler(req);
}

export async function sessionUser(
  auth: AuthInstance,
  req: Request,
): Promise<{ id: string; email?: string | null } | null> {
  try {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session?.user?.id) return null;
    return { id: session.user.id, email: session.user.email };
  } catch {
    return null;
  }
}
