/**
 * The seam between the OAuth server and the MCP endpoint, through the real
 * Worker `app` (so route order and middleware are the production ones): sign in,
 * register a client the way Claude does, approve on the consent page, trade the
 * code for a token with PKCE, and use that token on `/mcp`.
 *
 * Bundled with esbuild like mcp.check.ts: `npm run test:mcp`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import { createAuth, handleAuthRequest, type AuthDatabase } from "../auth.ts";
import type { Env } from "../env.ts";
import { app as realApp } from "../index.ts";
import { randomSecret, sha256Base64url } from "../oauth/crypto.ts";
import { pgliteAsSql } from "../pgliteSql.ts";
import type { WorkerVars } from "../request.ts";
import { applySync } from "../store.ts";

const fails: string[] = [];
let checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  if (!cond) fails.push(msg);
}

const origin = "http://localhost:8787";
const mailed: string[] = [];
const env = {
  BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long",
  BETTER_AUTH_URL: origin,
  ENVIRONMENT: "local" as const,
  ALLOWED_EMAILS: "phil@example.com,pat@example.com",
  EMAIL: {
    async send(message: { text?: string }) {
      const m = /(http\S+magic-link\/verify\S+)/.exec(message.text ?? "");
      if (m) mailed.push(m[1]);
      return { messageId: "m1" };
    },
  } as unknown as SendEmail,
  ASSETS: { fetch: async () => new Response("<!doctype html><title>spa</title>", { status: 200, headers: { "content-type": "text/html" } }) },
} as unknown as Env;
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

const db = new PGlite();
const schemaDir = join(process.cwd(), "worker/schema");
for (const f of readdirSync(schemaDir).filter((x) => x.endsWith(".sql")).sort()) await db.exec(readFileSync(join(schemaDir, f), "utf8"));
const realSql = pgliteAsSql(db);
// The real app closes its SQL client after every request; the test's database must outlive that.
const sql = new Proxy(realSql, { get: (t, p) => (p === "end" ? async () => undefined : (t as never)[p as never]) });

const authDb: AuthDatabase = {
  async connect() {
    return {
      async query(text: string, parameters: readonly unknown[] = []) {
        const r = await db.query(text, parameters as never[]);
        return { command: "SELECT", rowCount: r.affectedRows ?? r.rows.length, rows: r.rows };
      },
      release() {},
    };
  },
  async end() {},
  options: {},
};
const auth = createAuth(env, authDb);

const app = new Hono<{ Bindings: Env; Variables: WorkerVars }>();
app.use("*", async (c, next) => {
  c.set("sql", sql as never);
  c.set("auth", auth);
  await next();
});
app.route("/", realApp);

let ipSeq = 0;
const ip = () => `198.51.100.${++ipSeq}`;
const cookieOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

async function signIn(email: string): Promise<string> {
  const addr = ip();
  const before = mailed.length;
  await handleAuthRequest(
    auth,
    new Request(`${origin}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: { origin, "content-type": "application/json", "cf-connecting-ip": addr },
      body: JSON.stringify({ email, callbackURL: `${origin}/signin` }),
    }),
  );
  for (let i = 0; i < 100 && mailed.length === before; i++) await new Promise((r) => setTimeout(r, 20));
  const verify = await handleAuthRequest(auth, new Request(mailed[before], { headers: { origin, "cf-connecting-ip": addr } }));
  return cookieOf(verify);
}

async function req(path: string, o: { method?: string; headers?: Record<string, string>; body?: string; cookie?: string } = {}) {
  return app.request(
    path,
    { method: o.method ?? "GET", headers: { "cf-connecting-ip": ip(), ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.headers ?? {}) }, body: o.body, redirect: "manual" },
    env,
    ctx,
  );
}
const form = (p: Record<string, string>) => new URLSearchParams(p).toString();
const FORM = { "content-type": "application/x-www-form-urlencoded" };

async function mcp(token: string | null, method: string, params?: unknown) {
  const res = await req("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { res, body: (await res.json().catch(() => ({}))) as any };
}
async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
  const { body } = await mcp(token, "tools/call", { name, arguments: args });
  let parsed: any = {};
  try {
    parsed = JSON.parse(body.result?.content?.[0]?.text ?? "{}");
  } catch {
    /* empty */
  }
  return { ...parsed, _isError: Boolean(body.result?.isError) };
}

function hidden(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const un = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) out[un(m[1])] = un(m[2]);
  return out;
}

const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";

/** Everything Claude does to connect: register, consent, code, token. */
async function connect(cookie: string, opts: { grantWrite?: boolean; grantPeople?: boolean } = {}) {
  const reg = await req("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [CLAUDE_CB], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  const client = (await reg.json()) as { client_id: string };
  const verifier = randomSecret("", 32);
  const authorize = `/oauth/authorize?${form({
    client_id: client.client_id,
    redirect_uri: CLAUDE_CB,
    response_type: "code",
    code_challenge: await sha256Base64url(verifier),
    code_challenge_method: "S256",
    state: "st-1",
    scope: "agenda:read agenda:write",
    resource: `${origin}/mcp`,
  })}`;
  const page = await req(authorize, { cookie });
  const fields = hidden(await page.text());
  const approved = await req("/oauth/authorize", {
    method: "POST",
    cookie,
    headers: { ...FORM, accept: "application/json" },
    body: form({ ...fields, decision: "approve", ...(opts.grantWrite === false ? { grant_write: "0" } : {}), ...(opts.grantPeople ? { grant_people: "1" } : {}) }),
  });
  const to = new URL(((await approved.json()) as { redirect_to: string }).redirect_to);
  const tokens = await req("/oauth/token", {
    method: "POST",
    headers: FORM,
    body: form({ grant_type: "authorization_code", client_id: client.client_id, code: to.searchParams.get("code") ?? "", code_verifier: verifier, redirect_uri: CLAUDE_CB, resource: `${origin}/mcp` }),
  });
  return { clientId: client.client_id, state: to.searchParams.get("state"), tokens: (await tokens.json()) as { access_token: string; refresh_token: string; scope: string } };
}

// ── Sign in, seed, connect ────────────────────────────────────────────────
const phil = await signIn("phil@example.com");
const philId = ((await db.query(`SELECT id FROM "user" WHERE email = 'phil@example.com'`)).rows[0] as { id: string }).id;
await applySync(sql as never, philId, {
  profile: { name: "Phil" },
  upserts: {
    people: [{ id: "p1", name: "Meghan Lee" }],
    tags: [{ id: "tg", label: "Growth", color: 0, sort_order: 0 }],
    meetings: [{ id: "m1", subject_kind: "person", subject_id: "p1", rhythm: "weekly", anchor_weekday: 4 }],
    topics: [{ id: "t1", meeting_id: "m1", text: "Her workload", status: "open", lane: "backlog", tag_ids: [], carried: 0, carried_from: [], created_on: "2026-10-20", sort_order: 0, urgent: false }],
  },
});

// Discovery agrees with where the endpoint actually is.
const prm = (await (await req("/.well-known/oauth-protected-resource")).json()) as { resource: string; authorization_servers: string[]; scopes_supported: string[] };
ok(prm.resource === `${origin}/mcp`, "the protected-resource metadata names the real /mcp URL");
ok(prm.authorization_servers[0] === origin && prm.scopes_supported.includes("agenda:write"), "…and the authorization server and scopes");
const asm = (await (await req("/.well-known/oauth-authorization-server")).json()) as { registration_endpoint: string; code_challenge_methods_supported: string[] };
ok(asm.registration_endpoint === `${origin}/oauth/register` && asm.code_challenge_methods_supported.join() === "S256", "the authorization-server metadata points at the real endpoints");

const anon = await mcp(null, "tools/list");
ok(anon.res.status === 401, "/mcp without a token is 401 through the real app");
ok((anon.res.headers.get("www-authenticate") ?? "").includes(`${origin}/.well-known/oauth-protected-resource`), "…and the challenge points at that metadata");
ok((await req("/mcp", { method: "GET" })).status !== 200 && !(await (await req("/mcp", { method: "GET" })).text()).includes("<title>spa</title>"), "GET /mcp is not swallowed by the SPA fallback");
ok((await mcp("pla_notarealtoken", "tools/list")).res.status === 401, "a made-up token is 401");

const conn = await connect(phil);
ok(Boolean(conn.tokens.access_token) && conn.tokens.access_token.startsWith("pla_") && conn.state === "st-1", "the whole OAuth dance yields an access token");
ok(conn.tokens.scope === "agenda:read agenda:write", "with the scopes the user approved");
const tok = conn.tokens.access_token;

const init = await mcp(tok, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude", version: "1" } });
ok(init.res.status === 200 && init.body.result.serverInfo.name === "polarch", "initialize works with the issued token");
const list = await mcp(tok, "tools/list");
ok(list.body.result.tools.length > 30, "the full tool set is offered");

const plan = await tool(tok, "get_plan", { meeting: "Meghan", today: "2026-10-27" });
ok(plan.meeting?.title === "1:1 with Meghan Lee" && plan.ideas?.[0]?.text === "Her workload", "a real read through OAuth → MCP → the user's rows");
const moved = await tool(tok, "move_topics", { topics: ["t1"], date: "2026-11-05", meeting: "m1", today: "2026-10-27" });
ok(moved.ok === true && moved.change_id, "a real write through the whole stack");
const row = ((await db.query(`SELECT session_id FROM topics WHERE user_id = $1 AND id = 't1'`, [philId])).rows[0] as { session_id: string | null });
ok(Boolean(row.session_id), "…and it's in the database");
const changes = await tool(tok, "list_changes");
ok(changes.changes?.[0]?.client === conn.clientId, "the change is attributed to the connected client");
ok((await tool(tok, "undo_change", { change_id: moved.change_id })).ok === true, "and undoes");

// A connection the user narrowed to read-only can read but not write.
const ro = await connect(phil, { grantWrite: false });
ok(ro.tokens.scope === "agenda:read", "consent can be narrowed to read-only");
ok((await tool(ro.tokens.access_token, "get_plan", { meeting: "m1", today: "2026-10-27" })).weeks !== undefined, "a read-only token reads");
const denied = await tool(ro.tokens.access_token, "move_topics", { topics: ["t1"], to: "parked" });
ok(denied._isError && denied.code === "insufficient_scope", "a read-only token can't write");
ok(!((await mcp(ro.tokens.access_token, "tools/list")).body.result.tools as { name: string }[]).some((t) => t.name === "move_topics"), "and isn't even shown the write tools");
ok(((await db.query(`SELECT session_id FROM topics WHERE user_id = $1 AND id = 't1'`, [philId])).rows[0] as { session_id: string | null }).session_id === null, "nothing changed");

// Refresh keeps a connection alive without another consent.
const refreshed = (await (
  await req("/oauth/token", { method: "POST", headers: FORM, body: form({ grant_type: "refresh_token", client_id: conn.clientId, refresh_token: conn.tokens.refresh_token }) })
).json()) as { access_token: string };
ok(Boolean(refreshed.access_token) && (await mcp(refreshed.access_token, "ping")).res.status === 200, "a refreshed token works");

// Disconnecting from Settings cuts the connection at once.
const listed = (await (await req("/api/mcp/connections", { cookie: phil })).json()) as { connections: { clientId: string }[] };
ok(listed.connections.some((c) => c.clientId === conn.clientId), "Settings lists the connection");
const revoke = await req(`/api/mcp/connections/${conn.clientId}`, { method: "DELETE", cookie: phil, headers: { origin } });
ok(revoke.status === 200, "Settings can disconnect it");
ok((await mcp(tok, "ping")).res.status === 401 && (await mcp(refreshed.access_token, "ping")).res.status === 401, "every token of that connection stops working immediately");

// The people records only come with the box ticked.
ok(!((list.body.result.tools as { name: string }[]).some((t) => t.name === "get_person")), "an ordinary connection isn't offered the people tools");
const consent = await (await req(`/oauth/authorize?${form({ client_id: conn.clientId, redirect_uri: CLAUDE_CB, response_type: "code", code_challenge: "x".repeat(43), code_challenge_method: "S256", state: "s", resource: `${origin}/mcp` })}`, { cookie: phil })).text();
ok(consent.includes('id="people"') && !consent.includes('id="people" checked'), "the consent page offers the people records, unticked");
const withPeople = await connect(phil, { grantPeople: true });
ok(withPeople.tokens.scope === "agenda:read agenda:write people:read people:write", `ticking the box grants the people records (${withPeople.tokens.scope})`);
const pp = await tool(withPeople.tokens.access_token, "get_person", { who: "Meghan" });
ok(pp.kind === "person" && pp.name === "Meghan Lee", "…and they can be read");
const roPeople = await connect(phil, { grantWrite: false, grantPeople: true });
ok(roPeople.tokens.scope === "agenda:read people:read", "read-only with the box ticked reads people, writes nothing");

// Personal access tokens, for a bot that can't do OAuth.
const mk = (body: unknown, o: { cookie?: string; origin?: string } = {}) =>
  req("/api/mcp/tokens", { method: "POST", cookie: o.cookie, headers: { "content-type": "application/json", origin: o.origin ?? origin }, body: JSON.stringify(body) });
ok((await mk({ name: "Grokbot" })).status === 401, "making a token needs a signed-in session");
ok((await mk({ name: "Grokbot" }, { cookie: phil, origin: "https://evil.example" })).status === 403, "…from Polarch itself");
ok((await mk({ name: "" }, { cookie: phil })).status === 400, "…and a name");
const made = await mk({ name: "Grokbot", people: true }, { cookie: phil });
const pat = (await made.json()) as { token: string; clientId: string; scopes: string[]; url: string; expiresAt: string };
ok(made.status === 201 && pat.token.startsWith("pla_") && pat.url === `${origin}/mcp`, "a personal token is made, with the URL to use it at");
ok(pat.scopes.join(" ") === "agenda:read agenda:write people:read people:write", "…with the scopes asked for");
ok(Date.parse(pat.expiresAt) - Date.now() > 300 * 86_400_000, "…lasting about a year");
ok(((await db.query(`SELECT count(*)::int AS n FROM oauth_tokens WHERE token_hash = $1`, [pat.token])).rows[0] as { n: number }).n === 0, "only its hash is stored");
const patTools = (await mcp(pat.token, "tools/list")).body.result.tools as { name: string }[];
ok(patTools.some((t) => t.name === "list_upcoming") && patTools.some((t) => t.name === "update_person"), "the token sees every tool it was given");
const upcoming = await tool(pat.token, "list_upcoming", { today: "2026-10-27" });
ok(upcoming.occurrences?.[0]?.meeting?.id === "m1", "and reads the user's upcoming meetings");
const added = await tool(pat.token, "add_topics", { topics: [{ meeting: "Meghan", text: "From the bot" }], today: "2026-10-27" });
ok(added.ok === true && (await tool(pat.token, "list_changes")).changes?.[0]?.client === pat.clientId, "its writes are attributed to the token");
const listedPat = (await (await req("/api/mcp/connections", { cookie: phil })).json()) as { connections: { clientId: string; clientName: string; kind: string }[] };
ok(listedPat.connections.some((c) => c.clientId === pat.clientId && c.clientName === "Grokbot" && c.kind === "token"), "Settings lists it as a token, by name");
const roPat = (await (await mk({ name: "Reader", access: "read" }, { cookie: phil })).json()) as { token: string; scopes: string[] };
ok(roPat.scopes.join(" ") === "agenda:read", "a read-only token without people is just the agenda, read");
ok((await tool(roPat.token, "add_topics", { topics: [{ text: "x" }] })).code === "insufficient_scope", "…and can't write");
ok((await tool(roPat.token, "get_person", { who: "Meghan" })).code === "insufficient_scope", "…or read the people records");
const authorizeWithPat = await req(`/oauth/authorize?${form({ client_id: pat.clientId, redirect_uri: CLAUDE_CB, response_type: "code", code_challenge: "x".repeat(43), code_challenge_method: "S256", state: "s" })}`, { cookie: phil });
ok(authorizeWithPat.status >= 400 || !(await authorizeWithPat.text()).includes('id="approve"'), "a token's client can never start an authorization");
ok((await req(`/api/mcp/connections/${pat.clientId}`, { method: "DELETE", cookie: phil, headers: { origin } })).status === 200, "a token can be deleted from Settings");
ok((await mcp(pat.token, "ping")).res.status === 401, "…and stops working at once");

// Removing someone from the allowlist cuts MCP access too.
const again = await connect(phil);
ok((await mcp(again.tokens.access_token, "ping")).res.status === 200, "a new connection works");
const shrunk = { ...env, ALLOWED_EMAILS: "pat@example.com" } as unknown as Env;
const cut = await app.request("/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${again.tokens.access_token}`, "cf-connecting-ip": ip() }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) }, shrunk, ctx);
ok(cut.status === 401, "a user no longer on the allowlist is locked out of MCP on the next call");

// Resetting the workspace clears the journal that holds copies of its rows.
const t2 = await connect(phil);
await tool(t2.tokens.access_token, "create_tag", { label: "Journaled" });
ok(((await db.query(`SELECT count(*)::int AS n FROM mcp_changes WHERE user_id = $1`, [philId])).rows[0] as { n: number }).n > 0, "the journal has entries");
const wipe = await req("/api/data", { method: "DELETE", cookie: phil, headers: { origin } });
ok(wipe.status === 200, "the workspace can be wiped");
ok(((await db.query(`SELECT count(*)::int AS n FROM mcp_changes WHERE user_id = $1`, [philId])).rows[0] as { n: number }).n === 0, "…and takes the change journal with it");
ok(((await db.query(`SELECT count(*)::int AS n FROM oauth_grants WHERE user_id = $1 AND revoked_at IS NULL`, [philId])).rows[0] as { n: number }).n > 0, "(connections survive a data reset — they belong to the account)");

if (fails.length) {
  console.error(`connect.check: ${fails.length}/${checks} failed`);
  for (const f of fails) console.error("  -", f);
  process.exit(1);
}
console.log(`connect.check: ${checks} checks passed`);
