/**
 * OAuth 2.1 authorization server for the MCP endpoint (`/mcp`), the way the MCP
 * authorization spec wants it: protected-resource metadata (RFC 9728), server
 * metadata (RFC 8414), dynamic client registration (RFC 7591), authorization
 * code + PKCE S256 only, rotating refresh tokens, revocation (RFC 7009).
 *
 * Mounted at the root by index.ts: `app.route("/", oauthApp)`.
 *
 * Who is who:
 *  - The *user* proves who they are with their ordinary Polarch session cookie
 *    (magic link / Google). Allowlisting is therefore inherited, and re-checked
 *    whenever a token is used.
 *  - The *client* (Claude, ChatGPT, …) is anonymous and self-registered. It
 *    gets nothing until a signed-in user approves it on the consent page, and
 *    what it can do is the scope that user granted.
 */
import { Hono } from "hono";
import { clientAuthIp, googleConfigured, isAllowedEmail, sessionUser } from "../auth.ts";
import { resolveAuthBaseURL, resolveTrustedOrigins } from "../authUrl.ts";
import { API_SECURITY, json } from "../cors.ts";
import type { Env } from "../env.ts";
import { MCP_RESOURCE_PATH, MCP_SCOPES, type McpScope } from "../mcp/principal.ts";
import { consumeRateLimitKey, type RateLimitRule } from "../rateLimit.ts";
import { authOf, sqlOf, type WorkerContext, type WorkerVars } from "../request.ts";
import {
  ACCESS_PREFIX,
  ACCESS_TTL_SEC,
  CLIENT_CAP,
  CLIENT_PREFIX,
  CODE_PREFIX,
  CODE_TTL_SEC,
  MAX_GRANT_AGE_MS,
  OAUTH_RATE,
  PERSONAL_CLIENT_PREFIX,
  PERSONAL_TOKEN_CAP,
  PERSONAL_TOKEN_TTL_SEC,
  REFRESH_PREFIX,
  REFRESH_TTL_SEC,
} from "./constants.ts";
import {
  CODE_CHALLENGE_S256,
  hmacHex,
  pkceS256Matches,
  randomId,
  randomSecret,
  sha256Hex,
  timingSafeEqual,
} from "./crypto.ts";
import { consentPage, errorPage, newNonce, pageResponse, signInPage } from "./pages.ts";
import {
  MAX_REDIRECT_URIS,
  parseScope,
  redirectLabel,
  redirectUriMatches,
  scopeString,
  scopesFromText,
  validateRedirectUri,
} from "./redirect.ts";
import {
  CLIENT_ID_SHAPE,
  findCode,
  findToken,
  getClient,
  insertCode,
  issuePersonalToken,
  listConnections,
  prune,
  rateLimitDb,
  redeemCode,
  registerClient,
  revokeGrant,
  revokeUserClient,
  rotateRefresh,
  touchGrant,
  type Client,
  type IssuedToken,
} from "./store.ts";

export const oauthApp = new Hono<{ Bindings: Env; Variables: WorkerVars }>();

// ── Shared plumbing ──────────────────────────────────────────────────────

/** Token, registration, revocation and discovery carry no cookies: `*` is safe on them. */
const PUBLIC_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, mcp-protocol-version",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "600",
};
const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };

function baseOf(env: Env): string | null {
  try {
    return resolveAuthBaseURL(env);
  } catch {
    return null;
  }
}

function oauthError(
  error: string,
  description: string,
  status = 400,
  extra: Record<string, string> = {},
): Response {
  return json({ error, error_description: description }, status, {
    ...PUBLIC_CORS,
    ...NO_STORE,
    ...extra,
  });
}

function notConfigured(): Response {
  return oauthError("server_error", "authentication is not configured", 500);
}

function tooMany(retryAfter: number): Response {
  return oauthError("temporarily_unavailable", "too many requests, slow down", 429, {
    "Retry-After": String(Math.max(1, retryAfter)),
  });
}

/** A rate-limit response when `key` is over `rule`, else null. */
async function limited(
  c: WorkerContext,
  key: string,
  rule: RateLimitRule,
): Promise<Response | null> {
  const result = await consumeRateLimitKey(rateLimitDb(sqlOf(c)), key, rule);
  return result.allowed ? null : tooMany(result.retryAfter ?? rule.window);
}

const ipOf = (c: WorkerContext) => clientAuthIp(c.req.raw.headers, c.env);

/** Read at most `max` bytes: these endpoints are open to the internet. */
export async function readBoundedText(req: Request, max: number): Promise<string | null> {
  if (Number(req.headers.get("content-length") ?? "0") > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

const BODY_LIMIT = 16 * 1024;

type ParamsResult = { ok: true; params: Record<string, string> } | { ok: false; why: string };

/** Form-encoded (the spec) or JSON (what some clients send). A repeated parameter is an error. */
export async function readParams(req: Request): Promise<ParamsResult> {
  const text = await readBoundedText(req, BODY_LIMIT);
  if (text === null) return { ok: false, why: "request body too large" };
  const params: Record<string, string> = {};
  if ((req.headers.get("content-type") ?? "").includes("application/json")) {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, why: "invalid JSON" };
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { ok: false, why: "expected a JSON object" };
    }
    for (const [k, v] of Object.entries(body)) if (typeof v === "string") params[k] = v;
    return { ok: true, params };
  }
  const usp = new URLSearchParams(text);
  for (const key of new Set(usp.keys())) {
    const all = usp.getAll(key);
    if (all.length > 1) return { ok: false, why: `parameter "${key}" repeated` };
    params[key] = all[0] ?? "";
  }
  return { ok: true, params };
}

// ── Discovery ────────────────────────────────────────────────────────────

const DISCOVERY_CACHE = { "Cache-Control": "public, max-age=300" };

oauthApp.options("/.well-known/*", () => new Response(null, { status: 204, headers: PUBLIC_CORS }));
oauthApp.options("/oauth/token", () => new Response(null, { status: 204, headers: PUBLIC_CORS }));
oauthApp.options("/oauth/register", () => new Response(null, { status: 204, headers: PUBLIC_CORS }));
oauthApp.options("/oauth/revoke", () => new Response(null, { status: 204, headers: PUBLIC_CORS }));

function protectedResource(c: WorkerContext): Response {
  const base = baseOf(c.env);
  if (!base) return notConfigured();
  return json(
    {
      resource: `${base}${MCP_RESOURCE_PATH}`,
      authorization_servers: [base],
      scopes_supported: [...MCP_SCOPES],
      bearer_methods_supported: ["header"],
      resource_name: "Polarch",
    },
    200,
    { ...PUBLIC_CORS, ...DISCOVERY_CACHE },
  );
}
oauthApp.get("/.well-known/oauth-protected-resource", (c) => protectedResource(c));
oauthApp.get(`/.well-known/oauth-protected-resource${MCP_RESOURCE_PATH}`, (c) => protectedResource(c));

oauthApp.get("/.well-known/oauth-authorization-server", (c) => {
  const base = baseOf(c.env);
  if (!base) return notConfigured();
  return json(
    {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [...MCP_SCOPES],
      authorization_response_iss_parameter_supported: true,
    },
    200,
    { ...PUBLIC_CORS, ...DISCOVERY_CACHE },
  );
});

// ── Dynamic client registration (RFC 7591) ───────────────────────────────

const CLIENT_GRANTS = ["authorization_code", "refresh_token"];
/**
 * Strip control characters, line separators and bidi overrides: the name is
 * shown on the consent screen, so it must not be able to spoof or reflow it.
 */
export function cleanClientName(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const n = ch.codePointAt(0) ?? 0;
    const unsafe =
      n < 0x20 ||
      (n >= 0x7f && n <= 0x9f) ||
      n === 0x2028 ||
      n === 0x2029 ||
      (n >= 0x202a && n <= 0x202e) ||
      (n >= 0x2066 && n <= 0x2069);
    if (!unsafe) out += ch;
  }
  return out.trim();
}

function registrationError(error: string, description: string, status = 400): Response {
  return oauthError(error, description, status);
}

oauthApp.post("/oauth/register", async (c) => {
  if (!baseOf(c.env)) return notConfigured();
  const slow = await limited(c, `oauth|register|${ipOf(c)}`, OAUTH_RATE.register);
  if (slow) return slow;

  const text = await readBoundedText(c.req.raw, BODY_LIMIT);
  if (text === null) return registrationError("invalid_client_metadata", "request body too large", 413);
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return registrationError("invalid_client_metadata", "expected a JSON object");
  }

  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    return registrationError(
      "invalid_redirect_uri",
      `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URIs`,
    );
  }
  const redirectUris: string[] = [];
  for (const uri of uris) {
    const check = validateRedirectUri(uri);
    if (!check.ok) return registrationError("invalid_redirect_uri", `redirect_uri ${check.reason}`);
    if (!redirectUris.includes(uri as string)) redirectUris.push(uri as string);
  }

  const method = body.token_endpoint_auth_method;
  if (method !== undefined && method !== "none") {
    return registrationError("invalid_client_metadata", 'only token_endpoint_auth_method "none" is supported');
  }
  const stringList = (value: unknown, allowed: string[]): string[] | null => {
    if (value === undefined) return allowed;
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !allowed.includes(v))) {
      return null;
    }
    return value as string[];
  };
  const grants = stringList(body.grant_types, CLIENT_GRANTS);
  if (!grants || !grants.includes("authorization_code")) {
    return registrationError(
      "invalid_client_metadata",
      "grant_types must be authorization_code and optionally refresh_token",
    );
  }
  if (!stringList(body.response_types, ["code"])) {
    return registrationError("invalid_client_metadata", 'response_types must be ["code"]');
  }

  let name = "Unnamed app";
  if (body.client_name !== undefined) {
    if (typeof body.client_name !== "string") {
      return registrationError("invalid_client_metadata", "client_name must be a string");
    }
    const cleaned = cleanClientName(body.client_name);
    if (cleaned.length > 100) {
      return registrationError("invalid_client_metadata", "client_name is longer than 100 characters");
    }
    if (cleaned) name = cleaned;
  }

  const now = new Date();
  const client: Client = { clientId: randomId(CLIENT_PREFIX), clientName: name, redirectUris };
  if (!(await registerClient(sqlOf(c), client, CLIENT_CAP, now))) {
    return oauthError("temporarily_unavailable", "too many registered clients, try again later", 503);
  }
  return json(
    {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(now.getTime() / 1000),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: grants,
      response_types: ["code"],
    },
    201,
    { ...PUBLIC_CORS, ...NO_STORE },
  );
});

// ── Authorization (the pages a person sees) ──────────────────────────────

type AuthzRequest = {
  client: Client;
  redirectUri: string;
  challenge: string;
  scopes: McpScope[];
  state: string | null;
  /** Always the canonical resource; an absent param means "the only one there is". */
  resource: string;
};

type AuthzCheck =
  | { kind: "page"; status: number; title: string; message: string }
  | { kind: "redirect"; redirectUri: string; state: string | null; error: string; description: string }
  | { kind: "ok"; req: AuthzRequest };

const MAX_STATE = 1024;

/**
 * RFC 6749 §4.1.2.1: if the client or redirect_uri can't be trusted, say so on a
 * page and NEVER redirect (that would be an open redirector). Once both check
 * out, every other problem is reported to the client at its redirect_uri.
 */
async function validateAuthz(
  c: WorkerContext,
  base: string,
  get: (name: string) => string[],
): Promise<AuthzCheck> {
  const once = (name: string) => (get(name).length > 1 ? false : true);
  const bad = (message: string): AuthzCheck => ({
    kind: "page",
    status: 400,
    title: "This app can't be connected",
    message,
  });
  if (!once("client_id") || !once("redirect_uri")) return bad("The request was malformed.");
  const clientId = get("client_id")[0] ?? "";
  const requested = get("redirect_uri")[0] ?? "";
  if (!CLIENT_ID_SHAPE.test(clientId)) return bad("The app did not identify itself properly.");
  const client = await getClient(sqlOf(c), clientId);
  if (!client) return bad("Polarch doesn't recognise this app. Start the connection again from the app.");
  if (!requested || !redirectUriMatches(client.redirectUris, requested) || !validateRedirectUri(requested).ok) {
    return bad("The app asked to be sent somewhere it did not register, so Polarch won't continue.");
  }

  const state = get("state")[0] ?? null;
  const fail = (error: string, description: string): AuthzCheck => ({
    kind: "redirect",
    redirectUri: requested,
    state: state && state.length <= MAX_STATE ? state : null,
    error,
    description,
  });
  for (const name of ["state", "response_type", "code_challenge", "code_challenge_method", "scope"]) {
    if (!once(name)) return fail("invalid_request", `parameter "${name}" repeated`);
  }
  if (state !== null && state.length > MAX_STATE) return fail("invalid_request", "state is too long");
  if ((get("response_type")[0] ?? "") !== "code") {
    return fail("unsupported_response_type", "only response_type=code is supported");
  }
  const challenge = get("code_challenge")[0] ?? "";
  if (!CODE_CHALLENGE_S256.test(challenge)) {
    return fail("invalid_request", "a PKCE code_challenge (S256) is required");
  }
  if ((get("code_challenge_method")[0] ?? "") !== "S256") {
    return fail("invalid_request", "code_challenge_method must be S256");
  }
  const scope = parseScope(get("scope")[0]);
  if (!scope.ok) return fail("invalid_scope", "unknown scope requested");
  const resource = `${base}${MCP_RESOURCE_PATH}`;
  const resources = get("resource");
  if (resources.length > 1 || (resources.length === 1 && resources[0] !== resource)) {
    return fail("invalid_target", "resource must be the Polarch MCP endpoint");
  }
  return {
    kind: "ok",
    req: { client, redirectUri: requested, challenge, scopes: scope.scopes, state, resource },
  };
}

/** The parameters that define a request, normalised, for the sign-in return trip and the CSRF binding. */
function canonicalParams(req: AuthzRequest): Record<string, string> {
  const out: Record<string, string> = {
    client_id: req.client.clientId,
    redirect_uri: req.redirectUri,
    response_type: "code",
    code_challenge: req.challenge,
    code_challenge_method: "S256",
    scope: scopeString(req.scopes),
    resource: req.resource,
  };
  if (req.state !== null) out.state = req.state;
  return out;
}

const CSRF_BUCKET_MS = 10 * 60 * 1000;

function csrfMessage(userId: string, req: AuthzRequest, bucket: number): string {
  // JSON, not a delimiter: `state` is attacker-chosen and may contain anything.
  return JSON.stringify([
    "polarch-oauth-consent-v1",
    userId,
    req.client.clientId,
    req.redirectUri,
    req.challenge,
    scopeString(req.scopes),
    req.state ?? "",
    req.resource,
    bucket,
  ]);
}

/** `bucket.hmac`, bound to this user and exactly this request; good for 10 to 20 minutes. */
export async function issueConsentToken(
  secret: string,
  userId: string,
  req: AuthzRequest,
  now: number = Date.now(),
): Promise<string> {
  const bucket = Math.floor(now / CSRF_BUCKET_MS);
  return `${bucket}.${await hmacHex(secret, csrfMessage(userId, req, bucket))}`;
}

export async function verifyConsentToken(
  secret: string,
  userId: string,
  req: AuthzRequest,
  token: string,
  now: number = Date.now(),
): Promise<boolean> {
  const [bucketText, mac] = token.split(".");
  const bucket = Number(bucketText);
  if (!mac || !Number.isInteger(bucket)) return false;
  const current = Math.floor(now / CSRF_BUCKET_MS);
  if (bucket !== current && bucket !== current - 1) return false;
  return timingSafeEqual(mac, await hmacHex(secret, csrfMessage(userId, req, bucket)));
}

function redirectWith(base: string, redirectUri: string, params: Record<string, string | null>): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.set(k, v);
  url.searchParams.set("iss", base);
  return url.toString();
}

/**
 * The page's script asks for JSON and navigates itself (a form POST's redirect
 * would be subject to `form-action`); anything else gets a plain 302.
 */
function deliver(c: WorkerContext, url: string): Response {
  if ((c.req.header("accept") ?? "").includes("application/json")) {
    return json({ redirect_to: url }, 200, NO_STORE);
  }
  return new Response(null, {
    status: 302,
    headers: { Location: url, "Referrer-Policy": "no-referrer", ...NO_STORE, ...API_SECURITY },
  });
}

function wantsJson(c: WorkerContext): boolean {
  return (c.req.header("accept") ?? "").includes("application/json");
}

/** An authorize-time refusal: JSON for the page's fetch(), an HTML page for everyone else. */
function refuse(c: WorkerContext, status: number, title: string, message: string): Response {
  if (wantsJson(c)) return json({ error: "access_denied", error_description: message }, status, NO_STORE);
  const nonce = newNonce();
  return pageResponse(errorPage(nonce, { title, message }), nonce, status);
}

async function authorize(c: WorkerContext, method: "GET" | "POST"): Promise<Response> {
  const base = baseOf(c.env);
  const secret = c.env.BETTER_AUTH_SECRET;
  if (!base || !secret) return refuse(c, 500, "Not available", "Connecting apps isn't configured on this server.");
  const slow = await limited(c, `oauth|authorize|${ipOf(c)}`, OAUTH_RATE.authorize);
  if (slow) return refuse(c, 429, "Slow down", "Too many attempts. Wait a minute and try again.");

  let form: Record<string, string> = {};
  let get: (name: string) => string[];
  if (method === "GET") {
    const usp = new URL(c.req.url).searchParams;
    get = (name) => usp.getAll(name);
  } else {
    const read = await readParams(c.req.raw);
    if (!read.ok) return refuse(c, 400, "Can't continue", "The request was malformed.");
    form = read.params;
    get = (name) => (name in form ? [form[name] as string] : []);
  }

  const check = await validateAuthz(c, base, get);
  if (check.kind === "page") return refuse(c, check.status, check.title, check.message);
  if (check.kind === "redirect") {
    return deliver(
      c,
      redirectWith(base, check.redirectUri, {
        error: check.error,
        error_description: check.description,
        state: check.state,
      }),
    );
  }
  const req = check.req;

  const user = await sessionUser(authOf(c), c.req.raw);
  if (!user) {
    if (method === "POST") {
      return refuse(c, 401, "Signed out", "Your session ended. Start the connection again from the app.");
    }
    const callback = `${base}/oauth/authorize?${new URLSearchParams(canonicalParams(req)).toString()}`;
    const nonce = newNonce();
    return pageResponse(
      signInPage(nonce, {
        clientName: req.client.clientName,
        callbackUrl: callback,
        errorCallbackUrl: `${base}/signin`,
        google: googleConfigured(c.env),
      }),
      nonce,
    );
  }
  if (!isAllowedEmail(c.env, user.email)) {
    return refuse(c, 403, "Not allowed", "This account can't connect apps to Polarch.");
  }

  if (method === "GET") {
    const nonce = newNonce();
    return pageResponse(
      consentPage(nonce, {
        clientName: req.client.clientName,
        redirectLabel: redirectLabel(req.redirectUri),
        email: user.email ?? "",
        scopes: req.scopes,
        fields: { ...canonicalParams(req), csrf: await issueConsentToken(secret, user.id, req) },
      }),
      nonce,
    );
  }

  // POST: an approval is a state change made with a cookie, so it must come from
  // our own page (Origin) and carry a token only that page could have been given.
  const origin = c.req.header("origin");
  if (origin && !resolveTrustedOrigins(c.env).includes(origin)) {
    return refuse(c, 403, "Can't continue", "This approval did not come from Polarch.");
  }
  if (!(await verifyConsentToken(secret, user.id, req, form.csrf ?? ""))) {
    return refuse(
      c,
      403,
      "This approval expired",
      "Go back to the app and start the connection again.",
    );
  }

  const deny = () =>
    deliver(
      c,
      redirectWith(base, req.redirectUri, {
        error: "access_denied",
        error_description: "the user did not approve the connection",
        state: req.state,
      }),
    );
  if (form.decision === "deny") return deny();
  if (form.decision !== "approve") return refuse(c, 400, "Can't continue", "The request was malformed.");

  // The person may narrow what was asked for (read-only). The one thing they
  // may add is the people records, by ticking the box themselves: no app can
  // get them by asking for nothing.
  const canWrite = form.grant_write !== "0";
  const agenda = req.scopes.filter((s) => s.startsWith("agenda:") && (canWrite || s !== "agenda:write"));
  const people: McpScope[] =
    form.grant_people === "1"
      ? canWrite && (req.scopes.includes("agenda:write") || req.scopes.includes("people:write"))
        ? ["people:read", "people:write"]
        : ["people:read"]
      : [];
  const granted = [...agenda, ...people];
  if (!granted.length) return deny();

  const now = new Date();
  const code = randomSecret(CODE_PREFIX);
  await insertCode(
    sqlOf(c),
    {
      codeHash: await sha256Hex(code),
      clientId: req.client.clientId,
      userId: user.id,
      grantId: randomId("gr_"),
      redirectUri: req.redirectUri,
      challenge: req.challenge,
      scope: scopeString(granted),
      resource: req.resource,
      expiresAt: new Date(now.getTime() + CODE_TTL_SEC * 1000),
    },
    now,
  );
  await prune(sqlOf(c), now).catch(() => undefined);
  return deliver(c, redirectWith(base, req.redirectUri, { code, state: req.state }));
}

oauthApp.get("/oauth/authorize", (c) => authorize(c, "GET"));
oauthApp.post("/oauth/authorize", (c) => authorize(c, "POST"));

// ── Token endpoint ───────────────────────────────────────────────────────

async function mintPair(now: Date): Promise<{
  accessSecret: string;
  refreshSecret: string;
  access: IssuedToken;
  refresh: IssuedToken;
}> {
  const accessSecret = randomSecret(ACCESS_PREFIX);
  const refreshSecret = randomSecret(REFRESH_PREFIX);
  return {
    accessSecret,
    refreshSecret,
    access: {
      id: randomId("tk_"),
      hash: await sha256Hex(accessSecret),
      expiresAt: new Date(now.getTime() + ACCESS_TTL_SEC * 1000),
    },
    refresh: {
      id: randomId("tk_"),
      hash: await sha256Hex(refreshSecret),
      expiresAt: new Date(now.getTime() + REFRESH_TTL_SEC * 1000),
    },
  };
}

function tokenResponse(accessToken: string, refreshToken: string, scope: string): Response {
  return json(
    {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SEC,
      refresh_token: refreshToken,
      scope,
    },
    200,
    { ...PUBLIC_CORS, ...NO_STORE },
  );
}

oauthApp.post("/oauth/token", async (c) => {
  const base = baseOf(c.env);
  if (!base) return notConfigured();
  const slow = await limited(c, `oauth|token|${ipOf(c)}`, OAUTH_RATE.token);
  if (slow) return slow;

  const read = await readParams(c.req.raw);
  if (!read.ok) return oauthError("invalid_request", read.why);
  const p = read.params;
  const wwwAuth: Record<string, string> = c.req.header("authorization")
    ? { "WWW-Authenticate": 'Basic realm="polarch"' }
    : {};

  const client = await getClient(sqlOf(c), p.client_id ?? "");
  if (!client) {
    return oauthError("invalid_client", "unknown client_id", c.req.header("authorization") ? 401 : 400, wwwAuth);
  }
  const slowClient = await limited(c, `oauth|token-client|${client.clientId}`, OAUTH_RATE.tokenClient);
  if (slowClient) return slowClient;

  const sql = sqlOf(c);
  const now = new Date();
  const resource = `${base}${MCP_RESOURCE_PATH}`;

  if (p.grant_type === "authorization_code") {
    const code = p.code ?? "";
    if (!code || code.length > 200) return oauthError("invalid_grant", "invalid authorization code");
    const row = await findCode(sql, await sha256Hex(code));
    if (!row || row.clientId !== client.clientId) {
      return oauthError("invalid_grant", "invalid authorization code");
    }
    if (row.usedAt) {
      // A code is single use. Seeing it twice means it leaked: take back what it bought.
      await revokeGrant(sql, row.grantId, now);
      return oauthError("invalid_grant", "authorization code already used");
    }
    if (row.expiresAt.getTime() <= now.getTime()) {
      return oauthError("invalid_grant", "authorization code expired");
    }
    if ((p.redirect_uri ?? "") !== row.redirectUri) {
      return oauthError("invalid_grant", "redirect_uri does not match the authorization request");
    }
    if (!(await pkceS256Matches(p.code_verifier ?? "", row.challenge))) {
      return oauthError("invalid_grant", "PKCE verification failed");
    }
    if (p.resource !== undefined && p.resource !== (row.resource ?? resource)) {
      return oauthError("invalid_target", "resource does not match the authorization request");
    }
    if (!isAllowedEmail(c.env, row.email)) {
      return oauthError("invalid_grant", "this account can't connect apps");
    }
    const pair = await mintPair(now);
    if (!(await redeemCode(sql, row.codeHash, pair.access, pair.refresh, now))) {
      // Lost a race to a second redemption of the same code.
      await revokeGrant(sql, row.grantId, now);
      return oauthError("invalid_grant", "authorization code already used");
    }
    return tokenResponse(pair.accessSecret, pair.refreshSecret, row.scope);
  }

  if (p.grant_type === "refresh_token") {
    const presented = p.refresh_token ?? "";
    if (!presented || presented.length > 200 || !presented.startsWith(REFRESH_PREFIX)) {
      return oauthError("invalid_grant", "invalid refresh token");
    }
    const row = await findToken(sql, await sha256Hex(presented));
    if (!row || row.kind !== "refresh" || row.clientId !== client.clientId) {
      return oauthError("invalid_grant", "invalid refresh token");
    }
    if (row.grantRevokedAt) return oauthError("invalid_grant", "this connection was revoked");
    if (row.revokedAt) {
      // A rotated token showing up again: either the client or a thief holds the
      // old one. Cut the whole family so neither side keeps working.
      await revokeGrant(sql, row.grantId, now);
      return oauthError("invalid_grant", "refresh token already used; reconnect the app");
    }
    if (
      row.expiresAt.getTime() <= now.getTime() ||
      now.getTime() - row.grantCreatedAt.getTime() > MAX_GRANT_AGE_MS
    ) {
      return oauthError("invalid_grant", "refresh token expired; reconnect the app");
    }
    if (!isAllowedEmail(c.env, row.email)) {
      await revokeGrant(sql, row.grantId, now);
      return oauthError("invalid_grant", "this account can't connect apps");
    }

    const original = scopesFromText(row.scope);
    let accessScope = original;
    if (p.scope) {
      const asked = parseScope(p.scope);
      if (!asked.ok || !asked.scopes.every((s) => original.includes(s))) {
        return oauthError("invalid_scope", "scope exceeds what was originally granted");
      }
      accessScope = asked.scopes;
    }
    const pair = await mintPair(now);
    if (!(await rotateRefresh(sql, row.id, pair.access, pair.refresh, scopeString(accessScope), now))) {
      await revokeGrant(sql, row.grantId, now);
      return oauthError("invalid_grant", "refresh token already used; reconnect the app");
    }
    await touchGrant(sql, row.grantId, now).catch(() => undefined);
    return tokenResponse(pair.accessSecret, pair.refreshSecret, scopeString(accessScope));
  }

  return oauthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
});

// ── Revocation (RFC 7009) ────────────────────────────────────────────────

oauthApp.post("/oauth/revoke", async (c) => {
  if (!baseOf(c.env)) return notConfigured();
  const slow = await limited(c, `oauth|revoke|${ipOf(c)}`, OAUTH_RATE.revoke);
  if (slow) return slow;
  const read = await readParams(c.req.raw);
  if (!read.ok) return oauthError("invalid_request", read.why);
  const token = read.params.token ?? "";
  // Always 200 once the request is well formed: the caller learns nothing about which tokens exist.
  if (token && token.length <= 200) {
    const row = await findToken(sqlOf(c), await sha256Hex(token));
    const clientId = read.params.client_id;
    if (row && (!clientId || clientId === row.clientId)) {
      await revokeGrant(sqlOf(c), row.grantId, new Date());
    }
  }
  return json({}, 200, { ...PUBLIC_CORS, ...NO_STORE });
});

// ── Connected apps (cookie session, same origin, for Settings) ───────────

function originAllowed(c: WorkerContext): boolean {
  const origin = c.req.header("origin");
  return !origin || resolveTrustedOrigins(c.env).includes(origin);
}

oauthApp.get("/api/mcp/connections", async (c) => {
  const user = await sessionUser(authOf(c), c.req.raw);
  if (!user) return json({ error: "not authenticated" }, 401, NO_STORE);
  const rows = await listConnections(sqlOf(c), user.id, new Date());
  return json(
    {
      connections: rows.map((r) => ({
        clientId: r.clientId,
        clientName: r.clientName,
        scopes: scopesFromText(r.scopes),
        connectedAt: r.connectedAt.toISOString(),
        lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
        redirectHost: r.redirectUris[0] ? redirectLabel(r.redirectUris[0]) : "",
        kind: r.clientId.startsWith(PERSONAL_CLIENT_PREFIX) ? "token" : "app",
      })),
    },
    200,
    NO_STORE,
  );
});

oauthApp.delete("/api/mcp/connections/:clientId", async (c) => {
  const user = await sessionUser(authOf(c), c.req.raw);
  if (!user) return json({ error: "not authenticated" }, 401, NO_STORE);
  if (!originAllowed(c)) return json({ error: "forbidden" }, 403, NO_STORE);
  const clientId = c.req.param("clientId");
  if (!CLIENT_ID_SHAPE.test(clientId)) return json({ error: "not found" }, 404, NO_STORE);
  const revoked = await revokeUserClient(sqlOf(c), user.id, clientId, new Date());
  return json({ ok: true, revoked }, 200, NO_STORE);
});

// ── Personal access tokens (cookie session, same origin, for Settings) ────

/**
 * Make a token for a bot that can't do OAuth: it is shown once, here, and only
 * its hash is kept. The caller picks read-only or read-and-change, and whether
 * the people records come with it. It lists and disconnects like an app.
 */
oauthApp.post("/api/mcp/tokens", async (c) => {
  const user = await sessionUser(authOf(c), c.req.raw);
  if (!user) return json({ error: "not authenticated" }, 401, NO_STORE);
  if (!originAllowed(c)) return json({ error: "forbidden" }, 403, NO_STORE);
  if (!isAllowedEmail(c.env, user.email)) return json({ error: "forbidden" }, 403, NO_STORE);
  let body: Record<string, unknown>;
  try {
    const raw = await c.req.json();
    body = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return json({ error: "expected a JSON body" }, 400, NO_STORE);
  }
  const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
  if (!name || name.length > 60) return json({ error: "give the token a name of 1–60 characters" }, 400, NO_STORE);
  const write = body.access !== "read";
  const people = body.people === true;
  const scopes: McpScope[] = ["agenda:read", ...(write ? (["agenda:write"] as const) : []), ...(people ? (["people:read"] as const) : []), ...(people && write ? (["people:write"] as const) : [])];

  const sql = sqlOf(c);
  const now = new Date();
  const live = (await listConnections(sql, user.id, now)).filter((r) => r.clientId.startsWith(PERSONAL_CLIENT_PREFIX));
  if (live.length >= PERSONAL_TOKEN_CAP) {
    return json({ error: `you have ${PERSONAL_TOKEN_CAP} tokens already; delete one first` }, 409, NO_STORE);
  }
  const secret = randomSecret(ACCESS_PREFIX);
  const token = { id: randomId("tk_"), hash: await sha256Hex(secret), expiresAt: new Date(now.getTime() + PERSONAL_TOKEN_TTL_SEC * 1000) };
  const clientId = randomId(PERSONAL_CLIENT_PREFIX);
  const made = await issuePersonalToken(
    sql,
    { clientId, name, userId: user.id, grantId: randomId("gr_"), scope: scopeString(scopes), token },
    now,
  );
  if (!made) return json({ error: "could not make the token" }, 500, NO_STORE);
  return json(
    { token: secret, clientId, name, scopes, expiresAt: token.expiresAt.toISOString(), url: `${resolveAuthBaseURL(c.env)}${MCP_RESOURCE_PATH}` },
    201,
    NO_STORE,
  );
});
