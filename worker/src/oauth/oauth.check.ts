/**
 * Prove the OAuth server for MCP, end to end against PGlite with real Better
 * Auth sessions (magic link, mail mocked):
 *  - discovery documents, dynamic client registration (good and hostile),
 *  - the authorize endpoint refuses to redirect on a bad client/redirect_uri,
 *    reports everything else to the registered redirect_uri, and requires PKCE S256,
 *  - sign-in and consent pages: CSP/framing headers, escaped client names, CSRF
 *    binding, deny, read-only narrowing,
 *  - code -> token with PKCE, code replay, refresh rotation and reuse detection,
 *  - revocation, expiry, allowlist removal, scope hygiene on the bearer check,
 *  - the Settings connections API (cross-user isolation),
 *  - rate limits, the registration cap, and that no secret is stored in the clear.
 */
import { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import { createAuth, handleAuthRequest, type AuthDatabase } from "../auth.ts";
import type { Env } from "../env.ts";
import { applySchema } from "../isolationDb.ts";
import { pgliteAsSql } from "../pgliteSql.ts";
import type { WorkerVars } from "../request.ts";
import { ALL_TABLES } from "../tables.ts";
import { authenticateBearer, bearerToken, unauthorizedResponse } from "./bearer.ts";
import { randomSecret, sha256Base64url, sha256Hex } from "./crypto.ts";
import {
  cleanClientName,
  issueConsentToken,
  oauthApp,
  readBoundedText,
  verifyConsentToken,
} from "./oauth.ts";
import { escapeHtml } from "./pages.ts";
import {
  parseScope,
  redirectLabel,
  redirectUriMatches,
  scopeString,
  scopesFromText,
  validateRedirectUri,
} from "./redirect.ts";
import { registerClient } from "./store.ts";

const fails: string[] = [];
let checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  if (!cond) fails.push(msg);
}

function pgliteAsPool(db: PGlite): AuthDatabase {
  return {
    async connect() {
      return {
        async query(sql: string, parameters: readonly unknown[] = []) {
          const result = await db.query(sql, parameters as never[]);
          return {
            command: "SELECT",
            rowCount: result.affectedRows ?? result.rows.length,
            rows: result.rows,
          };
        },
        release() {},
      };
    },
    async end() {},
    options: {},
  };
}

const origin = "http://localhost:8787";
const env = {
  BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long",
  BETTER_AUTH_URL: origin,
  ENVIRONMENT: "local" as const,
  ALLOWED_EMAILS: "phil@example.com,pat@example.com",
  RESEND_API_KEY: "re_test",
  AUTH_EMAIL_FROM: "login@polarch.day",
} as unknown as Env;
const googleEnv = {
  ...env,
  GOOGLE_CLIENT_ID: "test.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-google-secret",
} as unknown as Env;
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

const db = new PGlite();
await applySchema(db);
const sql = pgliteAsSql(db);
const auth = createAuth(env, pgliteAsPool(db));

const app = new Hono<{ Bindings: Env; Variables: WorkerVars }>();
app.use("*", async (c, next) => {
  c.set("sql", sql);
  c.set("auth", auth);
  await next();
});
app.route("/", oauthApp);

// ── Mail mock: capture the magic link instead of sending it ──────────────
const mailedUrls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("api.resend.com")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
    const m = /(http\S+magic-link\/verify\S+)/.exec(body.text ?? "");
    if (m) mailedUrls.push(m[1]);
    return new Response(JSON.stringify({ id: "email_test" }), { status: 200 });
  }
  return realFetch(input as never, init);
}) as typeof fetch;

function cookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

let ipSeq = 0;
const freshIp = () => `198.51.100.${++ipSeq}`;

async function signIn(email: string): Promise<string> {
  const ip = freshIp();
  const before = mailedUrls.length;
  await handleAuthRequest(
    auth,
    new Request(`${origin}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: { origin, "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify({ email, callbackURL: `${origin}/signin` }),
    }),
  );
  for (let i = 0; i < 100 && mailedUrls.length === before; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const link = mailedUrls[before];
  if (!link) throw new Error(`no magic link mailed for ${email}`);
  const verify = await handleAuthRequest(
    auth,
    new Request(link, { headers: { origin, "cf-connecting-ip": ip } }),
  );
  return cookieHeader(verify);
}

const phil = await signIn("phil@example.com");
const pat = await signIn("pat@example.com");
const philId = (await db.query<{ id: string }>(`SELECT id FROM "user" WHERE email = $1`, ["phil@example.com"])).rows[0].id;
const patId = (await db.query<{ id: string }>(`SELECT id FROM "user" WHERE email = $1`, ["pat@example.com"])).rows[0].id;
ok(Boolean(phil) && Boolean(pat) && philId !== patId, "two distinct signed-in users");

type CallOpts = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  cookie?: string;
  ip?: string;
  e?: Env;
};
async function call(path: string, o: CallOpts = {}): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": o.ip ?? freshIp(), ...(o.headers ?? {}) };
  if (o.cookie) headers.cookie = o.cookie;
  return app.request(path, { method: o.method ?? "GET", headers, body: o.body, redirect: "manual" }, o.e ?? env, ctx);
}
const form = (params: Record<string, string>) => new URLSearchParams(params).toString();
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const JSON_H = { "content-type": "application/json" };

async function one<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T | undefined> {
  return (await db.query<T>(text, params as never[])).rows[0];
}
async function n(text: string, params: unknown[] = []): Promise<number> {
  return Number((await one<{ n: number }>(`SELECT count(*)::int AS n FROM ${text}`, params))?.n ?? 0);
}

async function register(body: Record<string, unknown>, ip = freshIp()): Promise<Response> {
  return call("/oauth/register", { method: "POST", headers: JSON_H, body: JSON.stringify(body), ip });
}
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";
async function newClient(extra: Record<string, unknown> = {}): Promise<string> {
  const res = await register({ client_name: "Claude", redirect_uris: [CLAUDE_CB], ...extra });
  return ((await res.json()) as { client_id: string }).client_id;
}

const newVerifier = () => randomSecret("", 32);

type Authz = {
  clientId: string;
  redirectUri?: string;
  verifier?: string;
  state?: string;
  scope?: string;
  resource?: string;
  extra?: Record<string, string>;
  drop?: string[];
};
async function authzUrl(a: Authz): Promise<string> {
  const verifier = a.verifier ?? newVerifier();
  const p: Record<string, string> = {
    client_id: a.clientId,
    redirect_uri: a.redirectUri ?? CLAUDE_CB,
    response_type: "code",
    code_challenge: await sha256Base64url(verifier),
    code_challenge_method: "S256",
    state: a.state ?? "st-123",
    ...(a.scope !== undefined ? { scope: a.scope } : {}),
    ...(a.resource !== undefined ? { resource: a.resource } : {}),
    ...(a.extra ?? {}),
  };
  for (const k of a.drop ?? []) delete p[k];
  return `/oauth/authorize?${form(p)}`;
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
function hiddenFields(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    out[unescapeHtml(m[1])] = unescapeHtml(m[2]);
  }
  return out;
}

/** GET the consent page and POST the decision the way the page's script does. */
async function consent(
  cookie: string,
  a: Authz,
  decision: "approve" | "deny",
  opts: { grantWrite?: string; json?: boolean; tweak?: (f: Record<string, string>) => void; headers?: Record<string, string> } = {},
): Promise<{ page: Response; html: string; fields: Record<string, string>; res: Response; verifier: string }> {
  const verifier = a.verifier ?? newVerifier();
  const page = await call(await authzUrl({ ...a, verifier }), { cookie });
  const html = await page.text();
  const fields = hiddenFields(html);
  opts.tweak?.(fields);
  const res = await call("/oauth/authorize", {
    method: "POST",
    cookie,
    headers: { ...FORM, ...(opts.json === false ? {} : { accept: "application/json" }), ...(opts.headers ?? {}) },
    body: form({ ...fields, decision, ...(opts.grantWrite !== undefined ? { grant_write: opts.grantWrite } : {}) }),
  });
  return { page, html, fields, res, verifier };
}

async function redirectOf(res: Response): Promise<URL | null> {
  if (res.status === 302) {
    const loc = res.headers.get("location");
    return loc ? new URL(loc) : null;
  }
  try {
    const body = (await res.clone().json()) as { redirect_to?: string };
    return body.redirect_to ? new URL(body.redirect_to) : null;
  } catch {
    return null;
  }
}

async function getCode(cookie: string, a: Authz, opts: Parameters<typeof consent>[3] = {}) {
  const r = await consent(cookie, a, "approve", opts);
  const url = await redirectOf(r.res);
  return { code: url?.searchParams.get("code") ?? "", url, verifier: r.verifier };
}

type TokenBody = { access_token?: string; refresh_token?: string; scope?: string; expires_in?: number; token_type?: string; error?: string; error_description?: string };
async function token(params: Record<string, string>, ip = freshIp(), asJson = false): Promise<{ res: Response; body: TokenBody }> {
  const res = await call("/oauth/token", {
    method: "POST",
    ip,
    headers: asJson ? JSON_H : FORM,
    body: asJson ? JSON.stringify(params) : form(params),
  });
  return { res, body: (await res.json()) as TokenBody };
}
async function exchange(clientId: string, code: string, verifier: string, redirectUri = CLAUDE_CB, extra: Record<string, string> = {}) {
  return token({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, ...extra });
}
async function connect(cookie: string, clientId: string, a: Partial<Authz> = {}, opts: Parameters<typeof consent>[3] = {}) {
  const { code, verifier } = await getCode(cookie, { clientId, ...a }, opts);
  const t = await exchange(clientId, code, verifier, a.redirectUri ?? CLAUDE_CB);
  return t.body;
}
function bearerReq(tok: string | null, scheme = "Bearer"): Request {
  return new Request("http://localhost/mcp", { headers: tok ? { authorization: `${scheme} ${tok}` } : {} });
}

// ── redirect / scope / pkce / csrf units ─────────────────────────────────
for (const good of [
  CLAUDE_CB,
  "http://localhost:6274/oauth/callback",
  "http://127.0.0.1:33418/cb",
  "http://[::1]:5000/cb",
  "cursor://anysphere.cursor-retrieval/oauth/user-polarch/callback",
  "com.example.app:/oauth2redirect",
]) {
  ok(validateRedirectUri(good).ok, `redirect_uri accepted: ${good}`);
}
for (const bad of [
  "http://evil.example/cb",
  "http://localhost.evil.example/cb",
  "http://127.0.0.1.evil.example/cb",
  "javascript:alert(1)",
  "data:text/html,hi",
  "file:///etc/passwd",
  "https://claude.ai/cb#frag",
  "https://user:pw@claude.ai/cb",
  "/relative/path",
  "https://claude.ai/cb white",
  "https://claude.ai/" + "a".repeat(600),
  "",
]) {
  ok(!validateRedirectUri(bad).ok, `redirect_uri refused: ${bad.slice(0, 40)}`);
}
ok(!validateRedirectUri(42).ok && !validateRedirectUri(null).ok, "non-string redirect_uri refused");
ok(redirectUriMatches([CLAUDE_CB], CLAUDE_CB), "exact redirect_uri matches");
ok(!redirectUriMatches([CLAUDE_CB], CLAUDE_CB + "/"), "trailing slash is a different redirect_uri");
ok(!redirectUriMatches([CLAUDE_CB], "https://claude.ai/api/mcp/auth_callback?x=1"), "extra query is a different redirect_uri");
ok(redirectUriMatches(["http://127.0.0.1:1111/cb"], "http://127.0.0.1:54321/cb"), "loopback http matches on any port");
ok(!redirectUriMatches(["http://127.0.0.1:1111/cb"], "http://127.0.0.1:54321/other"), "loopback port flexibility keeps the path");
ok(!redirectUriMatches(["http://127.0.0.1:1111/cb"], "http://localhost:1111/cb"), "loopback host must match exactly");
ok(!redirectUriMatches([CLAUDE_CB], "https://claude.ai:8443/api/mcp/auth_callback"), "https port is not flexible");
ok(!redirectUriMatches(["cursor://a/b"], "cursor://a/c"), "custom scheme is exact");
ok(redirectLabel(CLAUDE_CB) === "claude.ai", "label for https is the host");
ok(redirectLabel("http://127.0.0.1:3000/cb").includes("this computer"), "label for loopback says this computer");
ok(redirectLabel("cursor://x/y").includes("cursor://"), "label for a custom scheme names it");

ok(scopeString(["agenda:write", "agenda:read"]) === "agenda:read agenda:write", "scopeString is canonical order");
const dflt = parseScope(undefined);
ok(dflt.ok && dflt.scopes.length === 2, "omitted scope defaults to read+write");
ok(parseScope("agenda:read").ok, "single known scope parses");
ok(!parseScope("agenda:read health:read").ok, "unknown scope refused");
ok(scopesFromText("agenda:read evil agenda:read").length === 1, "stored scope text drops unknown and duplicate scopes");

ok(
  (await sha256Base64url("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")) === "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  "S256 matches the RFC 7636 appendix B vector",
);
ok(escapeHtml(`<a href="x">&'`) === "&lt;a href=&quot;x&quot;&gt;&amp;&#39;", "escapeHtml escapes the five characters");
ok(cleanClientName("Evil‮App\n\u0007 ") === "EvilApp", "client name loses control and bidi characters");
ok(bearerToken(bearerReq("pla_x", "bearer")) === "pla_x", "bearer scheme is case-insensitive");
ok(bearerToken(bearerReq("pla_x", "Basic")) === null, "non-Bearer scheme is not a token");
ok(bearerToken(bearerReq("x".repeat(300))) === null, "oversized token is not even read");
ok((await readBoundedText(new Request("http://x/", { method: "POST", body: "a".repeat(100) }), 50)) === null, "bounded reader stops at the limit");
ok((await readBoundedText(new Request("http://x/", { method: "POST", body: "abc" }), 50)) === "abc", "bounded reader reads small bodies");

{
  const req = {
    client: { clientId: "cl_x", clientName: "X", redirectUris: [CLAUDE_CB] },
    redirectUri: CLAUDE_CB,
    challenge: "c".repeat(43),
    scopes: ["agenda:read" as const],
    state: "s",
    resource: `${origin}/mcp`,
  };
  const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
  const tok = await issueConsentToken(env.BETTER_AUTH_SECRET!, "u1", req, t0);
  ok(await verifyConsentToken(env.BETTER_AUTH_SECRET!, "u1", req, tok, t0 + 60_000), "consent token verifies for the same user and request");
  ok(!(await verifyConsentToken(env.BETTER_AUTH_SECRET!, "u2", req, tok, t0)), "consent token is bound to the user");
  ok(!(await verifyConsentToken(env.BETTER_AUTH_SECRET!, "u1", { ...req, state: "other" }, tok, t0)), "consent token is bound to state");
  ok(!(await verifyConsentToken(env.BETTER_AUTH_SECRET!, "u1", { ...req, scopes: ["agenda:read", "agenda:write"] }, tok, t0)), "consent token is bound to scope");
  ok(!(await verifyConsentToken(env.BETTER_AUTH_SECRET!, "u1", req, tok, t0 + 25 * 60_000)), "consent token expires");
  ok(!(await verifyConsentToken("another-secret-another-secret-123456", "u1", req, tok, t0)), "consent token needs the server secret");
  ok(!(await verifyConsentToken(env.BETTER_AUTH_SECRET!, "u1", req, "garbage", t0)), "garbage consent token refused");
}

ok(!ALL_TABLES.some((t) => t.startsWith("oauth_")), "OAuth tables are not in the synced data allowlist");

// ── Discovery ────────────────────────────────────────────────────────────
{
  const res = await call("/.well-known/oauth-protected-resource");
  const doc = (await res.json()) as { resource: string; authorization_servers: string[]; scopes_supported: string[]; bearer_methods_supported: string[] };
  ok(res.status === 200, "protected-resource metadata is 200");
  ok(doc.resource === `${origin}/mcp`, "resource is <base>/mcp");
  ok(doc.authorization_servers.length === 1 && doc.authorization_servers[0] === origin, "authorization server is the issuer");
  ok(doc.scopes_supported.includes("agenda:read") && doc.scopes_supported.includes("agenda:write"), "scopes advertised");
  ok(doc.bearer_methods_supported[0] === "header", "bearer via header only");
  ok(res.headers.get("access-control-allow-origin") === "*", "discovery is CORS-readable");
  const alt = await call("/.well-known/oauth-protected-resource/mcp");
  ok(alt.status === 200 && ((await alt.json()) as { resource: string }).resource === `${origin}/mcp`, "path-suffixed protected-resource metadata also served");

  const as = await call("/.well-known/oauth-authorization-server");
  const m = (await as.json()) as Record<string, unknown>;
  ok(as.status === 200 && m.issuer === origin, "authorization-server metadata issuer");
  ok(m.authorization_endpoint === `${origin}/oauth/authorize`, "authorization_endpoint");
  ok(m.token_endpoint === `${origin}/oauth/token`, "token_endpoint");
  ok(m.registration_endpoint === `${origin}/oauth/register`, "registration_endpoint");
  ok(m.revocation_endpoint === `${origin}/oauth/revoke`, "revocation_endpoint");
  ok(JSON.stringify(m.code_challenge_methods_supported) === '["S256"]', "S256 only");
  ok(JSON.stringify(m.token_endpoint_auth_methods_supported) === '["none"]', "public clients only");
  ok(JSON.stringify(m.grant_types_supported) === '["authorization_code","refresh_token"]', "grant types");
  ok(m.authorization_response_iss_parameter_supported === true, "iss parameter advertised");
  const pre = await call("/oauth/token", { method: "OPTIONS" });
  ok(pre.status === 204 && pre.headers.get("access-control-allow-origin") === "*", "token endpoint answers CORS preflight");
  const noBase = await app.request("/.well-known/oauth-authorization-server", {}, { ...env, BETTER_AUTH_URL: undefined, ENVIRONMENT: "production" } as unknown as Env, ctx);
  ok(noBase.status === 500, "unconfigured origin fails closed instead of guessing from Host");
}

// ── Dynamic client registration ──────────────────────────────────────────
{
  const good = await register({ client_name: "Claude", redirect_uris: [CLAUDE_CB], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
  const body = (await good.json()) as Record<string, unknown>;
  ok(good.status === 201, `registration is 201 (got ${good.status})`);
  ok(typeof body.client_id === "string" && (body.client_id as string).startsWith("cl_"), "client_id issued");
  ok(!("client_secret" in body), "no client secret for a public client");
  ok(body.token_endpoint_auth_method === "none", "auth method echoed as none");
  ok((await register({ redirect_uris: ["http://127.0.0.1:6274/cb"] })).status === 201, "loopback redirect registers");
  ok((await register({ redirect_uris: ["cursor://anysphere.cursor-retrieval/oauth/x/callback"] })).status === 201, "custom-scheme redirect registers");
  const unnamed = await register({ redirect_uris: [CLAUDE_CB] });
  ok(await one(`SELECT 1 AS x FROM oauth_clients WHERE client_id = $1 AND client_name = 'Unnamed app'`, [((await unnamed.json()) as { client_id: string }).client_id]) !== undefined, "missing name becomes Unnamed app");
  const spoof = await register({ client_name: "Polarch‮ Admin\n", redirect_uris: [CLAUDE_CB] });
  const spoofId = ((await spoof.json()) as { client_id: string }).client_id;
  ok((await one<{ client_name: string }>(`SELECT client_name FROM oauth_clients WHERE client_id = $1`, [spoofId]))?.client_name === "Polarch Admin", "stored client name is sanitized");

  const expect400 = async (what: string, b: Record<string, unknown> | string, code?: string) => {
    const res = await register(b as never);
    const text = (await res.json().catch(() => ({}))) as { error?: string };
    ok(res.status === 400 || res.status === 413, `${what} is refused (got ${res.status})`);
    if (code) ok(text.error === code, `${what} -> ${code} (got ${text.error})`);
  };
  await expect400("plain-http redirect", { redirect_uris: ["http://evil.example/cb"] }, "invalid_redirect_uri");
  await expect400("javascript: redirect", { redirect_uris: ["javascript:alert(1)"] }, "invalid_redirect_uri");
  await expect400("fragment redirect", { redirect_uris: ["https://a.example/cb#x"] }, "invalid_redirect_uri");
  await expect400("six redirects", { redirect_uris: Array.from({ length: 6 }, (_, i) => `https://a.example/${i}`) }, "invalid_redirect_uri");
  await expect400("no redirects", { redirect_uris: [] }, "invalid_redirect_uri");
  await expect400("redirect_uris missing", { client_name: "x" }, "invalid_redirect_uri");
  await expect400("non-string redirect", { redirect_uris: [5] }, "invalid_redirect_uri");
  await expect400("confidential client", { redirect_uris: [CLAUDE_CB], token_endpoint_auth_method: "client_secret_basic" }, "invalid_client_metadata");
  await expect400("implicit grant", { redirect_uris: [CLAUDE_CB], grant_types: ["implicit"] }, "invalid_client_metadata");
  await expect400("token response type", { redirect_uris: [CLAUDE_CB], response_types: ["token"] }, "invalid_client_metadata");
  await expect400("101-char name", { redirect_uris: [CLAUDE_CB], client_name: "n".repeat(101) }, "invalid_client_metadata");
  await expect400("non-string name", { redirect_uris: [CLAUDE_CB], client_name: { a: 1 } }, "invalid_client_metadata");
  await expect400("not JSON", "not json", "invalid_client_metadata");
  await expect400("JSON array", "[]", "invalid_client_metadata");
  const big = await call("/oauth/register", { method: "POST", headers: JSON_H, body: JSON.stringify({ redirect_uris: [CLAUDE_CB], pad: "p".repeat(20_000) }) });
  ok(big.status === 413, `oversized registration body is 413 (got ${big.status})`);
  ok((await call("/oauth/register", { method: "GET" })).status === 404, "registration is POST only");
}

// registration cap and pruning (own database, so the cap is exact)
{
  const capDb = new PGlite();
  await applySchema(capDb);
  const capSql = pgliteAsSql(capDb);
  const mk = (i: number) => ({ clientId: `cl_cap_${i}_xxxxxxxx`, clientName: `c${i}`, redirectUris: [CLAUDE_CB] });
  const t0 = new Date();
  ok(await registerClient(capSql, mk(1), 3, t0), "first client registers under the cap");
  ok(await registerClient(capSql, mk(2), 3, t0), "second client registers under the cap");
  ok(await registerClient(capSql, mk(3), 3, t0), "third client fills the cap");
  ok(!(await registerClient(capSql, mk(4), 3, t0)), "registration is refused at the cap");
  await capDb.query(`UPDATE oauth_clients SET created_at = now() - interval '2 days' WHERE client_id = 'cl_cap_1_xxxxxxxx'`);
  ok(await registerClient(capSql, mk(5), 3, new Date()), "a stale never-approved client is pruned to make room");
  const left = (await capDb.query<{ client_id: string }>(`SELECT client_id FROM oauth_clients`)).rows.map((r) => r.client_id);
  ok(left.length === 3 && !left.includes("cl_cap_1_xxxxxxxx"), "only the stale client was pruned");
  await capDb.query(`INSERT INTO oauth_grants (id, user_id, client_id, scope) VALUES ('gr_x', 'u', 'cl_cap_2_xxxxxxxx', 'agenda:read')`);
  await capDb.query(`UPDATE oauth_clients SET created_at = now() - interval '2 days'`);
  ok(await registerClient(capSql, mk(6), 3, new Date()), "pruning frees room again");
  const kept = (await capDb.query<{ client_id: string }>(`SELECT client_id FROM oauth_clients`)).rows.map((r) => r.client_id);
  ok(kept.includes("cl_cap_2_xxxxxxxx"), "a client with a grant is never pruned");
  await capDb.close();
}

// ── Authorize: refusals ──────────────────────────────────────────────────
const clientId = await newClient();
{
  const unknown = await call(await authzUrl({ clientId: "cl_doesnotexist_123" }), { cookie: phil });
  ok(unknown.status === 400 && !unknown.headers.get("location"), "unknown client: page, no redirect");
  ok((await unknown.text()).includes("recognise"), "unknown client page explains");
  const wrongRedirect = await call(await authzUrl({ clientId, redirectUri: "https://evil.example/cb" }), { cookie: phil });
  ok(wrongRedirect.status === 400 && !wrongRedirect.headers.get("location"), "unregistered redirect_uri: page, never a redirect");
  const noRedirect = await call(await authzUrl({ clientId, drop: ["redirect_uri"] }), { cookie: phil });
  ok(noRedirect.status === 400 && !noRedirect.headers.get("location"), "missing redirect_uri: page, no redirect");
  const dupClient = await call(`${await authzUrl({ clientId })}&client_id=${clientId}`, { cookie: phil });
  ok(dupClient.status === 400 && !dupClient.headers.get("location"), "repeated client_id refused without redirect");

  const redirected = async (what: string, a: Authz, code: string, signedIn = true) => {
    const res = await call(await authzUrl(a), signedIn ? { cookie: phil } : {});
    const to = await redirectOf(res);
    ok(res.status === 302 && !!to, `${what}: redirected to the client (got ${res.status})`);
    ok(to?.origin === "https://claude.ai" && to?.pathname === "/api/mcp/auth_callback", `${what}: goes to the registered redirect_uri`);
    ok(to?.searchParams.get("error") === code, `${what}: error=${code} (got ${to?.searchParams.get("error")})`);
    ok(to?.searchParams.get("state") === (a.state ?? "st-123"), `${what}: state returned`);
    ok(to?.searchParams.get("iss") === origin, `${what}: iss returned`);
    ok(!to?.searchParams.has("code"), `${what}: no code`);
  };
  await redirected("missing PKCE challenge", { clientId, drop: ["code_challenge"] }, "invalid_request");
  await redirected("plain PKCE", { clientId, extra: { code_challenge_method: "plain" } }, "invalid_request");
  await redirected("missing PKCE method", { clientId, drop: ["code_challenge_method"] }, "invalid_request");
  await redirected("short challenge", { clientId, extra: { code_challenge: "abc" } }, "invalid_request");
  await redirected("unknown scope", { clientId, scope: "agenda:read health:read" }, "invalid_scope");
  await redirected("wrong resource", { clientId, resource: "https://evil.example/mcp" }, "invalid_target");
  await redirected("implicit flow", { clientId, extra: { response_type: "token" } }, "unsupported_response_type");
  await redirected("refusal reaches the client before sign-in too", { clientId, drop: ["code_challenge"] }, "invalid_request", false);
  const ok1 = await call(await authzUrl({ clientId, resource: `${origin}/mcp` }), { cookie: phil });
  ok(ok1.status === 200, "the canonical resource parameter is accepted");
}

// ── Sign-in page ─────────────────────────────────────────────────────────
{
  const res = await call(await authzUrl({ clientId }));
  const html = await res.text();
  ok(res.status === 200 && (res.headers.get("content-type") ?? "").startsWith("text/html"), "signed-out authorize is the sign-in page");
  const csp = res.headers.get("content-security-policy") ?? "";
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
  ok(Boolean(nonce) && html.includes(`<script nonce="${nonce}">`), "sign-in script carries the CSP nonce");
  ok(csp.includes("frame-ancestors 'none'") && csp.includes("default-src 'none'"), "CSP forbids framing and everything not listed");
  ok(!csp.includes("unsafe-inline") && !csp.includes("unsafe-eval"), "CSP has no unsafe-inline/eval");
  ok(csp.includes("form-action 'none'"), "forms cannot submit anywhere (the pages use fetch)");
  ok(res.headers.get("x-frame-options") === "DENY", "X-Frame-Options DENY");
  ok(res.headers.get("referrer-policy") === "no-referrer", "Referrer-Policy no-referrer");
  ok((res.headers.get("cache-control") ?? "").includes("no-store"), "sign-in page is no-store");
  ok(res.headers.getSetCookie().length === 0, "sign-in page sets no cookie");
  ok(!/\sstyle="/.test(html) && !/\son[a-z]+="/i.test(html), "no inline style attributes or event-handler attributes (CSP would block them)");
  const cb = /data-callback="([^"]+)"/.exec(html)?.[1] ?? "";
  const cbUrl = new URL(unescapeHtml(cb));
  ok(cbUrl.origin === origin && cbUrl.pathname === "/oauth/authorize", "magic link returns to /oauth/authorize");
  ok(cbUrl.searchParams.get("client_id") === clientId && cbUrl.searchParams.get("redirect_uri") === CLAUDE_CB, "return URL keeps the validated request");
  ok(cbUrl.searchParams.get("code_challenge_method") === "S256" && cbUrl.searchParams.get("state") === "st-123", "return URL keeps PKCE and state");
  ok(!html.includes('id="google"'), "no Google button when Google is not configured");
  const withGoogle = await call(await authzUrl({ clientId }), { e: googleEnv });
  ok((await withGoogle.text()).includes('id="google"'), "Google button appears when configured");
  for (const m of html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)) {
    let parsed = true;
    try {
      new Function(m[1]);
    } catch {
      parsed = false;
    }
    ok(parsed, "sign-in script is syntactically valid");
  }
}

// The round trip the sign-in page relies on: a magic link whose callbackURL is the
// authorize URL must come back to exactly that URL with a session, and that
// session must be enough to reach the consent page.
{
  const target = `${origin}${await authzUrl({ clientId, state: "round trip" })}`;
  const ip = freshIp();
  const before = mailedUrls.length;
  const sent = await handleAuthRequest(
    auth,
    new Request(`${origin}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: { origin, "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify({ email: "phil@example.com", callbackURL: target }),
    }),
  );
  for (let i = 0; i < 100 && mailedUrls.length === before; i++) await new Promise((r) => setTimeout(r, 20));
  ok(sent.status === 200 && mailedUrls.length === before + 1, "Better Auth accepts the authorize URL as a magic-link callbackURL");
  if (mailedUrls[before]) {
    const back = await handleAuthRequest(
      auth,
      new Request(mailedUrls[before], { headers: { origin, "cf-connecting-ip": ip }, redirect: "manual" }),
    );
    ok(back.status === 302 && back.headers.get("location") === target, `the link returns to the authorize URL (got ${back.status} ${back.headers.get("location")})`);
    const resumed = await call(new URL(target).pathname + new URL(target).search, { cookie: cookieHeader(back) });
    const resumedHtml = await resumed.text();
    ok(resumed.status === 200 && resumedHtml.includes('id="approve"'), "the new session lands on the consent page, not the sign-in page");
  }
}

// ── Consent page ─────────────────────────────────────────────────────────
const hostileId = await newClient({ client_name: `<img src=x onerror=alert(1)>"'&` });
{
  const page = await call(await authzUrl({ clientId: hostileId, state: `<script>alert(1)</script>"x` }), { cookie: phil });
  const html = await page.text();
  ok(page.status === 200, "signed-in authorize is the consent page");
  ok(!html.includes("<img src=x") && html.includes("&lt;img src=x onerror=alert(1)&gt;"), "hostile client name is escaped");
  ok(!html.includes("<script>alert(1)</script>"), "hostile state is escaped in hidden fields");
  const fields = hiddenFields(html);
  ok(fields.state === `<script>alert(1)</script>"x`, "state survives escaping round trip");
  ok(Boolean(fields.csrf) && fields.client_id === hostileId && fields.redirect_uri === CLAUDE_CB, "consent form carries the request and a CSRF token");
  ok(html.includes("phil@example.com"), "consent shows who is signed in");
  ok(html.includes("claude.ai"), "consent shows where the user is sent");
  ok(html.includes("not verified") || html.includes("has not verified"), "consent says the name is unverified");
  ok(html.includes("health ratings, prayer, assessments"), "consent states what is never shared");
  ok(html.includes('id="write"'), "consent offers the read-only choice");
  const csp = page.headers.get("content-security-policy") ?? "";
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
  ok(Boolean(nonce) && html.includes(`<style nonce="${nonce}">`) && html.includes(`<script nonce="${nonce}">`), "consent script and style carry the nonce");
  ok(csp.includes("frame-ancestors 'none'") && page.headers.get("x-frame-options") === "DENY", "consent cannot be framed");
  ok(!/\sstyle="/.test(html) && !/\son[a-z]+="/i.test(html), "consent has no inline style/event attributes");
  for (const m of html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)) {
    let parsed = true;
    try {
      new Function(m[1]);
    } catch {
      parsed = false;
    }
    ok(parsed, "consent script is syntactically valid");
  }
  const readOnly = await call(await authzUrl({ clientId, scope: "agenda:read" }), { cookie: phil });
  ok(!(await readOnly.text()).includes('id="write"'), "no write checkbox when only read was requested");
}

// ── Consent decisions ────────────────────────────────────────────────────
{
  const codesBefore = await n("oauth_codes");
  const noCsrf = await consent(phil, { clientId }, "approve", { tweak: (f) => delete f.csrf });
  ok(noCsrf.res.status === 403, `approve without CSRF token is 403 (got ${noCsrf.res.status})`);
  const badCsrf = await consent(phil, { clientId }, "approve", { tweak: (f) => (f.csrf = f.csrf.replace(/.$/, (c) => (c === "0" ? "1" : "0"))) });
  ok(badCsrf.res.status === 403, "approve with a corrupted CSRF token is 403");
  const otherUser = await call(await authzUrl({ clientId }), { cookie: pat });
  const patFields = hiddenFields(await otherUser.text());
  const crossUser = await consent(phil, { clientId }, "approve", { tweak: (f) => (f.csrf = patFields.csrf) });
  ok(crossUser.res.status === 403, "another user's CSRF token does not work");
  const widen = await consent(phil, { clientId, scope: "agenda:read" }, "approve", { tweak: (f) => (f.scope = "agenda:read agenda:write") });
  ok(widen.res.status === 403, "scope cannot be widened after the token was issued");
  const swapState = await consent(phil, { clientId }, "approve", { tweak: (f) => (f.state = "attacker") });
  ok(swapState.res.status === 403, "state cannot be swapped");
  const twoUris = await newClient({ redirect_uris: [CLAUDE_CB, "https://chatgpt.com/connector_platform_oauth_redirect"] });
  const swapUri = await consent(phil, { clientId: twoUris }, "approve", { tweak: (f) => (f.redirect_uri = "https://chatgpt.com/connector_platform_oauth_redirect") });
  ok(swapUri.res.status === 403, "redirect_uri cannot be swapped for another registered one");
  const swapChallenge = await consent(phil, { clientId }, "approve", { tweak: (f) => (f.code_challenge = "A".repeat(43)) });
  ok(swapChallenge.res.status === 403, "PKCE challenge cannot be swapped");
  const crossOrigin = await consent(phil, { clientId }, "approve", { headers: { origin: "https://evil.example" } });
  ok(crossOrigin.res.status === 403, "cross-origin approve is 403");
  const noSessionPost = await call("/oauth/authorize", { method: "POST", headers: { ...FORM, accept: "application/json" }, body: form({ ...hiddenFields(await (await call(await authzUrl({ clientId }), { cookie: phil })).text()), decision: "approve" }) });
  ok(noSessionPost.status === 401, "approve POST without a session is 401");
  const control = await consent(phil, { clientId }, "approve");
  ok(control.res.status === 200, "a well-formed approve is accepted (control)");
  const weird = await call("/oauth/authorize", { method: "POST", cookie: phil, headers: { ...FORM, accept: "application/json" }, body: form({ ...hiddenFields(await (await call(await authzUrl({ clientId }), { cookie: phil })).text()), decision: "maybe" }) });
  ok(weird.status === 400, "unknown decision is 400");
  ok((await n("oauth_codes")) === codesBefore + 1, "only the one valid approval issued a code");

  const denied = await consent(phil, { clientId, state: "deny-state" }, "deny");
  const deniedTo = await redirectOf(denied.res);
  ok(deniedTo?.searchParams.get("error") === "access_denied" && deniedTo.searchParams.get("state") === "deny-state", "deny redirects with access_denied and state");
  ok(!deniedTo?.searchParams.has("code"), "deny issues no code");
  ok(deniedTo?.searchParams.get("iss") === origin, "deny carries iss");
  const denyPlain = await consent(phil, { clientId }, "deny", { json: false });
  ok(denyPlain.res.status === 302 && !!denyPlain.res.headers.get("location"), "non-JSON clients get a plain 302");

  const approved = await consent(phil, { clientId, state: "approve-state" }, "approve");
  const to = await redirectOf(approved.res);
  const code = to?.searchParams.get("code") ?? "";
  ok(code.startsWith("plk_") && code.length >= 40, "approve issues a plk_ code");
  ok(to?.searchParams.get("state") === "approve-state" && to?.searchParams.get("iss") === origin, "approve returns state and iss");
  ok(to?.origin === "https://claude.ai", "approve redirects to the registered redirect_uri");
  const stored = await one<{ code_hash: string; scope: string; resource: string; user_id: string }>(`SELECT * FROM oauth_codes WHERE code_hash = $1`, [await sha256Hex(code)]);
  ok(Boolean(stored) && stored!.code_hash !== code, "only the hash of the code is stored");
  ok(stored?.scope === "agenda:read agenda:write" && stored?.resource === `${origin}/mcp` && stored?.user_id === philId, "code is bound to scope, resource and user");
  ok((await n("oauth_codes WHERE code_hash = $1", [code])) === 0, "the code itself is nowhere in the table");

  const readOnly = await getCode(phil, { clientId }, { grantWrite: "0" });
  const readTok = await exchange(clientId, readOnly.code, readOnly.verifier);
  ok(readTok.body.scope === "agenda:read", `unchecking write grants read only (got ${readTok.body.scope})`);
  const onlyWrite = await consent(phil, { clientId, scope: "agenda:write" }, "approve", { grantWrite: "0" });
  ok((await redirectOf(onlyWrite.res))?.searchParams.get("error") === "access_denied", "narrowing to nothing is a denial");
}

// ── Token endpoint ───────────────────────────────────────────────────────
{
  const clientId = await newClient();
  const { code, verifier } = await getCode(phil, { clientId });
  const t = await exchange(clientId, code, verifier);
  ok(t.res.status === 200, `code exchange is 200 (got ${t.res.status}: ${t.body.error})`);
  ok(t.body.token_type === "Bearer" && t.body.expires_in === 3600, "bearer, one hour");
  ok(Boolean(t.body.access_token?.startsWith("pla_")) && Boolean(t.body.refresh_token?.startsWith("plr_")), "pla_ access and plr_ refresh tokens");
  ok(t.body.scope === "agenda:read agenda:write", "granted scope returned");
  ok((t.res.headers.get("cache-control") ?? "").includes("no-store") && t.res.headers.get("pragma") === "no-cache", "token response is no-store");
  const hashes = (await db.query<{ token_hash: string }>(`SELECT token_hash FROM oauth_tokens`)).rows.map((r) => r.token_hash);
  ok(hashes.every((h) => /^[0-9a-f]{64}$/.test(h)), "tokens are stored only as SHA-256 hashes");
  ok(!hashes.includes(t.body.access_token!) && !hashes.includes(t.body.refresh_token!), "no token is stored in the clear");

  const principal = await authenticateBearer(sql, env, bearerReq(t.body.access_token!));
  ok(principal?.userId === philId && principal.clientId === clientId, "bearer resolves to the approving user and client");
  ok(JSON.stringify(principal?.scopes) === '["agenda:read","agenda:write"]', "bearer scopes");
  ok(Boolean(principal?.tokenId) && principal?.tokenId !== t.body.access_token, "principal carries a token row id, never the token");

  // a JSON body works too
  const j = await getCode(phil, { clientId });
  const viaJson = await token({ grant_type: "authorization_code", client_id: clientId, code: j.code, code_verifier: j.verifier, redirect_uri: CLAUDE_CB }, freshIp(), true);
  ok(viaJson.res.status === 200, "JSON token request is accepted");

  // every way to get the exchange wrong
  const fresh = async () => getCode(phil, { clientId });
  {
    const c = await fresh();
    const wrong = await exchange(clientId, c.code, newVerifier());
    ok(wrong.res.status === 400 && wrong.body.error === "invalid_grant", "wrong code_verifier is invalid_grant");
    const retry = await exchange(clientId, c.code, c.verifier);
    ok(retry.res.status === 200, "a wrong verifier does not burn the code");
  }
  {
    const c = await fresh();
    const r = await exchange(clientId, c.code, c.verifier, "https://claude.ai/api/mcp/other");
    ok(r.body.error === "invalid_grant", "redirect_uri mismatch at /token is invalid_grant");
    const none = await token({ grant_type: "authorization_code", client_id: clientId, code: c.code, code_verifier: c.verifier });
    ok(none.body.error === "invalid_grant", "missing redirect_uri at /token is invalid_grant");
  }
  {
    const c = await fresh();
    const other = await newClient();
    const r = await exchange(other, c.code, c.verifier);
    ok(r.body.error === "invalid_grant", "a code cannot be redeemed by a different client");
  }
  {
    const c = await fresh();
    await db.query(`UPDATE oauth_codes SET expires_at = now() - interval '1 second' WHERE code_hash = $1`, [await sha256Hex(c.code)]);
    ok((await exchange(clientId, c.code, c.verifier)).body.error === "invalid_grant", "an expired code is invalid_grant");
  }
  {
    const c = await fresh();
    const r = await exchange(clientId, c.code, c.verifier, CLAUDE_CB, { resource: "https://evil.example/mcp" });
    ok(r.body.error === "invalid_target", "resource mismatch at /token is invalid_target");
  }
  {
    const c = await fresh();
    const short = await exchange(clientId, c.code, "short");
    ok(short.body.error === "invalid_grant", "a too-short verifier is refused");
  }
  ok((await exchange(clientId, "plk_nope", newVerifier())).body.error === "invalid_grant", "unknown code is invalid_grant");
  ok((await token({ grant_type: "authorization_code", code: "x" })).body.error === "invalid_client", "missing client_id is invalid_client");
  ok((await token({ grant_type: "authorization_code", client_id: "cl_unknown_client" })).body.error === "invalid_client", "unknown client is invalid_client");
  ok((await token({ grant_type: "password", client_id: clientId })).body.error === "unsupported_grant_type", "password grant is unsupported");
  const dup = await call("/oauth/token", { method: "POST", headers: FORM, body: `grant_type=refresh_token&client_id=${clientId}&client_id=${clientId}` });
  ok(dup.status === 400 && ((await dup.json()) as TokenBody).error === "invalid_request", "a repeated parameter is invalid_request");
  const bigBody = await call("/oauth/token", { method: "POST", headers: FORM, body: `grant_type=x&junk=${"a".repeat(20_000)}` });
  ok(bigBody.status === 400, "oversized token request is refused");

  // replay: the second use of a code takes back everything the first bought
  {
    const c = await fresh();
    const first = await exchange(clientId, c.code, c.verifier);
    ok(first.res.status === 200, "first redemption succeeds");
    ok(Boolean(await authenticateBearer(sql, env, bearerReq(first.body.access_token!))), "its access token works");
    const second = await exchange(clientId, c.code, c.verifier);
    ok(second.res.status === 400 && second.body.error === "invalid_grant", "second redemption of a code is invalid_grant");
    ok((await authenticateBearer(sql, env, bearerReq(first.body.access_token!))) === null, "replay revokes the access token it issued");
    const viaRefresh = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: first.body.refresh_token! });
    ok(viaRefresh.body.error === "invalid_grant", "replay revokes the refresh token it issued");
  }
  // a code used before its grant exists must not leave a grant behind on failure paths
  ok((await n("oauth_grants g WHERE NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.grant_id = g.id)")) === 0, "no grant exists without tokens");
}

// ── Refresh rotation ─────────────────────────────────────────────────────
{
  const clientId = await newClient();
  const t = await connect(phil, clientId);
  const r1 = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: t.refresh_token! });
  ok(r1.res.status === 200 && r1.body.access_token !== t.access_token && r1.body.refresh_token !== t.refresh_token, "refresh issues a new pair");
  ok(r1.body.scope === "agenda:read agenda:write", "refresh keeps the scope");
  ok(Boolean(await authenticateBearer(sql, env, bearerReq(r1.body.access_token!))), "the rotated access token works");
  const reuse = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: t.refresh_token! });
  ok(reuse.res.status === 400 && reuse.body.error === "invalid_grant", "reusing a rotated refresh token is invalid_grant");
  ok((await authenticateBearer(sql, env, bearerReq(r1.body.access_token!))) === null, "reuse revokes the family's access tokens");
  const after = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: r1.body.refresh_token! });
  ok(after.body.error === "invalid_grant", "reuse revokes the family's refresh tokens");
}
{
  const clientId = await newClient();
  const t = await connect(phil, clientId);
  const narrowed = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: t.refresh_token!, scope: "agenda:read" });
  ok(narrowed.body.scope === "agenda:read", "refresh may narrow scope");
  const p = await authenticateBearer(sql, env, bearerReq(narrowed.body.access_token!));
  ok(JSON.stringify(p?.scopes) === '["agenda:read"]', "narrowed access token carries the narrower scope");
  const again = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: narrowed.body.refresh_token! });
  ok(again.body.scope === "agenda:read agenda:write", "the refresh token keeps the original scope");
  const readOnly = await connect(phil, clientId, {}, { grantWrite: "0" });
  const widen = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: readOnly.refresh_token!, scope: "agenda:read agenda:write" });
  ok(widen.body.error === "invalid_scope", "refresh cannot widen scope");
}
{
  const clientId = await newClient();
  const t = await connect(phil, clientId);
  const other = await newClient();
  const stolen = await token({ grant_type: "refresh_token", client_id: other, refresh_token: t.refresh_token! });
  ok(stolen.body.error === "invalid_grant", "a refresh token is useless to another client");
  ok(Boolean(await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: t.refresh_token! }).then((r) => r.body.access_token)), "…and the rightful client can still refresh");
  const t2 = await connect(phil, clientId);
  await db.query(`UPDATE oauth_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, [await sha256Hex(t2.refresh_token!)]);
  ok((await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: t2.refresh_token! })).body.error === "invalid_grant", "an expired refresh token is invalid_grant");
  const t3 = await connect(phil, clientId);
  await db.query(`UPDATE oauth_grants SET created_at = now() - interval '200 days' WHERE id = (SELECT grant_id FROM oauth_tokens WHERE token_hash = $1)`, [await sha256Hex(t3.refresh_token!)]);
  ok((await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: t3.refresh_token! })).body.error === "invalid_grant", "a grant past its absolute age cap cannot refresh");
  ok((await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: "pla_wrongkind" })).body.error === "invalid_grant", "garbage refresh token is invalid_grant");
  const t4 = await connect(phil, clientId);
  ok((await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: t4.access_token! })).body.error === "invalid_grant", "an access token is not a refresh token");
}

// ── Revocation ───────────────────────────────────────────────────────────
{
  const clientId = await newClient();
  const t = await connect(phil, clientId);
  const rev = await call("/oauth/revoke", { method: "POST", headers: FORM, body: form({ token: t.access_token!, client_id: clientId }) });
  ok(rev.status === 200, "revoke is 200");
  ok((await authenticateBearer(sql, env, bearerReq(t.access_token!))) === null, "revoking the access token disables it");
  ok((await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: t.refresh_token! })).body.error === "invalid_grant", "…and its refresh token (the whole grant)");
  ok((await call("/oauth/revoke", { method: "POST", headers: FORM, body: form({ token: "plr_garbage" }) })).status === 200, "revoking garbage is still 200");
  const u = await connect(phil, clientId);
  const wrongClient = await newClient();
  await call("/oauth/revoke", { method: "POST", headers: FORM, body: form({ token: u.refresh_token!, client_id: wrongClient }) });
  ok(Boolean(await authenticateBearer(sql, env, bearerReq(u.access_token!))), "another client cannot revoke this grant");
  await call("/oauth/revoke", { method: "POST", headers: FORM, body: form({ token: u.refresh_token! }) });
  ok((await authenticateBearer(sql, env, bearerReq(u.access_token!))) === null, "revoking the refresh token disables the access token too");
}

// ── Bearer check ─────────────────────────────────────────────────────────
{
  const clientId = await newClient();
  const t = await connect(phil, clientId);
  const tok = t.access_token!;
  ok((await authenticateBearer(sql, env, bearerReq(null))) === null, "no header: null");
  ok((await authenticateBearer(sql, env, bearerReq("plr_x"))) === null, "wrong prefix: null");
  ok((await authenticateBearer(sql, env, bearerReq(tok, "Basic"))) === null, "wrong scheme: null");
  ok((await authenticateBearer(sql, env, bearerReq(tok.slice(0, -1) + "x"))) === null, "altered token: null");
  ok(Boolean(await authenticateBearer(sql, env, bearerReq(tok, "bearer"))), "lowercase scheme works");
  ok((await authenticateBearer(sql, { ...env, ALLOWED_EMAILS: "pat@example.com" } as unknown as Env, bearerReq(tok))) === null, "removing the user from ALLOWED_EMAILS cuts access immediately");
  ok(Boolean(await authenticateBearer(sql, env, bearerReq(tok))), "…and restoring them restores it");

  // last_used_at: written once, then at most every few minutes
  const grantOf = async () => one<{ last_used_at: Date | null }>(`SELECT last_used_at FROM oauth_grants WHERE id = (SELECT grant_id FROM oauth_tokens WHERE token_hash = $1)`, [await sha256Hex(tok)]);
  const g1 = (await grantOf())!.last_used_at;
  ok(g1 !== null, "first use records last_used_at");
  await authenticateBearer(sql, env, bearerReq(tok));
  const g2 = (await grantOf())!.last_used_at;
  ok(g1 !== null && g2 !== null && new Date(g1).getTime() === new Date(g2).getTime(), "a second use inside the window does not write");
  await db.query(`UPDATE oauth_grants SET last_used_at = now() - interval '10 minutes' WHERE id = (SELECT grant_id FROM oauth_tokens WHERE token_hash = $1)`, [await sha256Hex(tok)]);
  await authenticateBearer(sql, env, bearerReq(tok));
  const g3 = (await grantOf())!.last_used_at;
  ok(g3 !== null && Date.now() - new Date(g3).getTime() < 60_000, "a use after the window refreshes it");

  await db.query(`UPDATE oauth_tokens SET scope = 'agenda:read evil:scope' WHERE token_hash = $1`, [await sha256Hex(tok)]);
  const hygiene = await authenticateBearer(sql, env, bearerReq(tok));
  ok(JSON.stringify(hygiene?.scopes) === '["agenda:read"]', "unknown scopes in storage are dropped from the principal");

  await db.query(`UPDATE oauth_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, [await sha256Hex(tok)]);
  ok((await authenticateBearer(sql, env, bearerReq(tok))) === null, "an expired access token is rejected");

  const un = unauthorizedResponse(env, bearerReq(null));
  ok(un.status === 401, "unauthorizedResponse is 401");
  const wa = un.headers.get("www-authenticate") ?? "";
  ok(wa.startsWith("Bearer ") && wa.includes(`resource_metadata="${origin}/.well-known/oauth-protected-resource"`), "WWW-Authenticate points at the protected-resource metadata");
  ok(!wa.includes("error="), "no error code when no token was presented");
  ok(un.headers.get("access-control-expose-headers") === "WWW-Authenticate", "browser clients may read WWW-Authenticate");
  ok(((await un.json()) as { error: string }).error === "unauthorized", "401 body is JSON");
  const bad = unauthorizedResponse(env, bearerReq("x"), { error: "invalid_token" });
  ok((bad.headers.get("www-authenticate") ?? "").includes('error="invalid_token"'), "invalid_token is signalled");
  const scope = unauthorizedResponse(env, bearerReq("x"), { error: "insufficient_scope", scope: "agenda:write" });
  ok(scope.status === 403 && (scope.headers.get("www-authenticate") ?? "").includes('scope="agenda:write"'), "insufficient_scope is 403 with the needed scope");
  ok(scope.headers.get("x-content-type-options") === "nosniff", "API security headers present");
  const unconfigured = unauthorizedResponse({ ...env, BETTER_AUTH_URL: undefined, ENVIRONMENT: "production" } as unknown as Env, bearerReq(null));
  ok(unconfigured.status === 401 && !(unconfigured.headers.get("www-authenticate") ?? "").includes("resource_metadata"), "a misconfigured origin still answers 401 without guessing a URL");

  // allowlist also gates the token endpoint
  const c = await getCode(phil, { clientId });
  const blocked = await app.request("/oauth/token", { method: "POST", headers: { ...FORM, "cf-connecting-ip": freshIp() }, body: form({ grant_type: "authorization_code", client_id: clientId, code: c.code, code_verifier: c.verifier, redirect_uri: CLAUDE_CB }) }, { ...env, ALLOWED_EMAILS: "pat@example.com" } as unknown as Env, ctx);
  ok(blocked.status === 400 && ((await blocked.json()) as TokenBody).error === "invalid_grant", "a user off the allowlist cannot redeem a code");
  const rt = await connect(phil, clientId);
  const blockedRefresh = await app.request("/oauth/token", { method: "POST", headers: { ...FORM, "cf-connecting-ip": freshIp() }, body: form({ grant_type: "refresh_token", client_id: clientId, refresh_token: rt.refresh_token! }) }, { ...env, ALLOWED_EMAILS: "pat@example.com" } as unknown as Env, ctx);
  ok(((await blockedRefresh.json()) as TokenBody).error === "invalid_grant", "a user off the allowlist cannot refresh");
  ok((await authenticateBearer(sql, env, bearerReq(rt.access_token!))) === null, "…and that attempt revoked the grant");
}

// ── Connected apps (Settings) ────────────────────────────────────────────
{
  await db.query(`DELETE FROM oauth_grants`);
  const phils = await newClient({ client_name: "Phil's Claude" });
  const pats = await newClient({ client_name: "Pat's ChatGPT" });
  const pt = await connect(phil, phils);
  const qt = await connect(pat, pats);
  ok(Boolean(pt.access_token) && Boolean(qt.access_token), "both users connected an app");

  ok((await call("/api/mcp/connections")).status === 401, "connections list needs a session");
  const list = (await (await call("/api/mcp/connections", { cookie: phil })).json()) as { connections: { clientId: string; clientName: string; scopes: string[]; redirectHost: string; connectedAt: string }[] };
  ok(list.connections.length === 1 && list.connections[0].clientId === phils, "a user sees only their own connections");
  ok(list.connections[0].clientName === "Phil's Claude" && list.connections[0].redirectHost === "claude.ai", "name and host shown");
  ok(list.connections[0].scopes.length === 2 && !!list.connections[0].connectedAt, "scopes and connected time shown");
  const patList = (await (await call("/api/mcp/connections", { cookie: pat })).json()) as { connections: { clientId: string }[] };
  ok(patList.connections.length === 1 && patList.connections[0].clientId === pats, "the other user sees theirs");
  ok(!JSON.stringify(list).includes("pla_") && !JSON.stringify(list).includes("plr_"), "the list never contains a token");

  ok((await call(`/api/mcp/connections/${phils}`, { method: "DELETE" })).status === 401, "revoke needs a session");
  const cross = await call(`/api/mcp/connections/${phils}`, { method: "DELETE", cookie: pat });
  ok(((await cross.json()) as { revoked: number }).revoked === 0, "another user's revoke does nothing");
  ok(Boolean(await authenticateBearer(sql, env, bearerReq(pt.access_token!))), "…the connection still works");
  const csrf = await call(`/api/mcp/connections/${phils}`, { method: "DELETE", cookie: phil, headers: { origin: "https://evil.example" } });
  ok(csrf.status === 403, "cross-origin revoke is 403");
  ok(Boolean(await authenticateBearer(sql, env, bearerReq(pt.access_token!))), "…and did nothing");
  ok((await call("/api/mcp/connections/not a client", { method: "DELETE", cookie: phil })).status === 404, "malformed client id is 404");
  const del = await call(`/api/mcp/connections/${phils}`, { method: "DELETE", cookie: phil, headers: { origin } });
  ok(((await del.json()) as { revoked: number }).revoked === 1, "the owner's revoke revokes the grant");
  ok((await authenticateBearer(sql, env, bearerReq(pt.access_token!))) === null, "revoked access token no longer works");
  ok((await token({ grant_type: "refresh_token", client_id: phils, refresh_token: pt.refresh_token! })).body.error === "invalid_grant", "revoked refresh token no longer works");
  const empty = (await (await call("/api/mcp/connections", { cookie: phil })).json()) as { connections: unknown[] };
  ok(empty.connections.length === 0, "revoked connection leaves the list");
  ok(Boolean(await authenticateBearer(sql, env, bearerReq(qt.access_token!))), "the other user's connection is untouched");
}

// ── Rate limits (each on its own IP so they don't share a bucket) ─────────
{
  const ip = "203.0.113.77";
  let last = 0;
  for (let i = 0; i < 61; i++) {
    last = (await token({ grant_type: "password", client_id: "cl_x_xxxxxxxx" }, ip)).res.status;
  }
  ok(last === 429, `the 61st token request in a minute from one IP is 429 (got ${last})`);
  const limited = await token({ grant_type: "password", client_id: "cl_x_xxxxxxxx" }, ip);
  ok(limited.res.headers.has("retry-after") && limited.body.error === "temporarily_unavailable", "429 carries Retry-After and an OAuth error body");

  const rip = "203.0.113.78";
  let regLast = 0;
  for (let i = 0; i < 21; i++) regLast = (await register({ redirect_uris: [CLAUDE_CB] }, rip)).status;
  ok(regLast === 429, `the 21st registration in an hour from one IP is 429 (got ${regLast})`);

  const aip = "203.0.113.79";
  let aLast = 0;
  for (let i = 0; i < 61; i++) aLast = (await call(await authzUrl({ clientId: "cl_none_xxxxxxxx" }), { ip: aip })).status;
  ok(aLast === 429, `the 61st authorize request in a minute from one IP is 429 (got ${aLast})`);

  const cid = await newClient();
  let cLast = 0;
  for (let i = 0; i < 61; i++) cLast = (await token({ grant_type: "password", client_id: cid }, freshIp())).res.status;
  ok(cLast === 429, `the 61st token request for one client in a minute is 429 even across IPs (got ${cLast})`);
}

if (fails.length) {
  console.error(`oauth.check: ${fails.length}/${checks} failed`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`oauth.check: ${checks} checks ok`);
process.exit(0);
