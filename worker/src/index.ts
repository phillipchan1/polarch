import { Hono } from "hono";
import { googleConfigured, handleAuthRequest, sessionUser } from "./auth.ts";
import {
  API_CORS,
  API_SECURITY,
  applyAuthCors,
  beginAuthCors,
  json,
} from "./cors.ts";
import { assertNoClientKey, proxyOpenAI, sanitizeOpenAIBody } from "./openai.ts";
import {
  MAX_AUDIO_BYTES,
  readTranscribeForm,
  transcribe,
  transcribeConfigured,
} from "./transcribe.ts";
import type { Env } from "./env.ts";
import { flagFromEnv, flagOn } from "../../src/lib/flags.ts";
import { authOf, finishRequest, sqlOf, type WorkerContext, type WorkerVars } from "./request.ts";
import { mcpApp } from "./mcp/routes.ts";
import { clearJournal } from "./mcp/workspace.ts";
import { oauthApp } from "./oauth/oauth.ts";
import { stripGetSessionToken } from "./sessionBody.ts";
import { bookQuery, chaptersFor, searchBooks, workId } from "./books.ts";
import { applySync, loadTables, wipeUser } from "./store.ts";
import {
  ShareError,
  createShare,
  guestAddTopic,
  guestRemoveTopic,
  guestSetFollowUp,
  guestSetNote,
  guestSetTakeaway,
  listShares,
  loadShared,
  memberByToken,
  revokeShare,
  sharedWithMe,
  type Member,
} from "./shares.ts";

const app = new Hono<{ Bindings: Env; Variables: WorkerVars }>();

app.use("*", async (c, next) => {
  try {
    await next();
    const path = new URL(c.req.url).pathname;
    if (path.startsWith("/api/") || path.startsWith("/functions/")) {
      for (const [key, value] of Object.entries(API_SECURITY)) {
        c.res.headers.set(key, value);
      }
    }
  } finally {
    await finishRequest(c);
  }
});

function missingAsset(): Response {
  return new Response("Not found", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
      ...API_SECURITY,
    },
  });
}

async function requireUser(c: WorkerContext) {
  return sessionUser(authOf(c), c.req.raw);
}

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    service: "polarch",
    runtime: "cloudflare-workers",
    realtime: false,
  }),
);

// Which sign-in buttons to show. Booleans only; never ids or secrets.
app.get("/api/auth-providers", (c) =>
  c.json({ magicLink: true, google: googleConfigured(c.env) }, 200, {
    "cache-control": "no-store",
  }),
);

app.all("/api/auth/*", async (c) => {
  const started = beginAuthCors(c.req.header("Origin"), c.env);
  if (!started.ok) return started.response;
  const cors = started.cors;
  if (c.req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = authOf(c);
    const res = await stripGetSessionToken(
      await handleAuthRequest(auth, c.req.raw),
      new URL(c.req.url).pathname,
    );
    return new Response(res.body, {
      status: res.status,
      headers: applyAuthCors(res.headers, cors),
    });
  } catch {
    return new Response(JSON.stringify({ error: "authentication failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...cors },
    });
  }
});

app.options("/api/*", () => new Response("ok", { headers: API_CORS }));
app.options("/functions/*", () => new Response("ok", { headers: API_CORS }));

// The OAuth server and the MCP endpoint (RUNBOOK.md, "Connecting Claude and
// ChatGPT"). They own /.well-known/oauth-*, /oauth/*, /api/mcp/connections and
// /mcp, so they mount ahead of the /api/* and asset fallbacks below.
app.route("/", oauthApp);
app.route("/", mcpApp);

/**
 * What an assistant changed is journaled with copies of the rows it touched.
 * Wiping or replacing the workspace must not leave those behind. Best effort:
 * a missing table (schema 007 not applied yet) must never break a reset.
 */
async function forgetMcpChanges(c: WorkerContext, userId: string): Promise<void> {
  try {
    await clearJournal(sqlOf(c), userId);
  } catch (err) {
    console.error("mcp journal clear failed", err instanceof Error ? err.name : typeof err);
  }
}

app.get("/api/data", async (c) => {
  const user = await requireUser(c);
  if (!user) return json({ error: "not authenticated" }, 401);
  const doc = await loadTables(sqlOf(c), user.id);
  return json(doc);
});

app.put("/api/data", async (c) => {
  const user = await requireUser(c);
  if (!user) return json({ error: "not authenticated" }, 401);
  let body: { profile?: unknown; upserts?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  if (!body || typeof body !== "object") return json({ error: "invalid json" }, 400);
  try {
    await applySync(sqlOf(c), user.id, {
      profile: (body.profile ?? null) as Record<string, unknown> | null,
      upserts: body.upserts as Record<string, Record<string, unknown>[]> | undefined,
      replace: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "write failed";
    return json({ error: message }, 400);
  }
  await forgetMcpChanges(c, user.id);
  return json({ ok: true });
});

app.patch("/api/data", async (c) => {
  const user = await requireUser(c);
  if (!user) return json({ error: "not authenticated" }, 401);
  let body: { profile?: unknown; upserts?: unknown; deletes?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  if (!body || typeof body !== "object") return json({ error: "invalid json" }, 400);
  try {
    await applySync(sqlOf(c), user.id, {
      profile: (body.profile ?? undefined) as Record<string, unknown> | undefined,
      upserts: body.upserts as Record<string, Record<string, unknown>[]> | undefined,
      deletes: body.deletes as Record<string, string[]> | undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "sync failed";
    return json({ error: message }, 400);
  }
  return json({ ok: true });
});

app.delete("/api/data", async (c) => {
  const user = await requireUser(c);
  if (!user) return json({ error: "not authenticated" }, 401);
  await wipeUser(sqlOf(c), user.id, { shares: true });
  await forgetMcpChanges(c, user.id);
  return json({ ok: true });
});

async function handleOpenAI(c: WorkerContext): Promise<Response> {
  const user = await requireUser(c);
  if (!user) return json({ error: "not authenticated" }, 401);
  try {
    assertNoClientKey(c.req.raw.headers);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "bad request" }, 400);
  }
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  let body;
  try {
    body = sanitizeOpenAIBody(raw, c.env);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "invalid body" }, 400);
  }
  const res = await proxyOpenAI(c.env, body);
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(API_SECURITY)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

app.post("/api/openai", (c) => handleOpenAI(c));
app.post("/functions/v1/openai", (c) => handleOpenAI(c));

// Meeting audio, one segment at a time (worker/src/transcribe.ts). The GET
// tells Run which engine to listen with before it opens the mic.
app.get("/api/transcribe", async (c) => {
  const user = await requireUser(c);
  if (!user) return json({ error: "not authenticated" }, 401);
  return json({ available: transcribeConfigured(c.env) });
});

app.post("/api/transcribe", async (c) => {
  const user = await requireUser(c);
  if (!user) return json({ error: "not authenticated" }, 401);
  try {
    assertNoClientKey(c.req.raw.headers);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "bad request" }, 400);
  }
  // Refuse an oversized body before reading it; the form check catches a liar.
  if (Number(c.req.header("content-length") ?? 0) > MAX_AUDIO_BYTES + 64 * 1024) {
    return json({ error: "audio is too large" }, 413);
  }
  let input;
  try {
    input = readTranscribeForm(await c.req.raw.formData(), c.env);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "invalid form" }, 400);
  }
  const res = await transcribe(c.env, input);
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(API_SECURITY)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
});

// Covers for book arcs (worker/src/books.ts). Signed-in only: it is a
// convenience when starting an arc, not something a guest page needs.
app.get("/api/books", async (c) => {
  const user = await requireUser(c);
  if (!user) return json({ error: "not authenticated" }, 401);
  const q = bookQuery(c.req.query("q"));
  if (!q) return json({ books: [] });
  try {
    return json({ books: await searchBooks(q) });
  } catch (err) {
    console.error("book search failed", err instanceof Error ? err.name : typeof err);
    return json({ error: "book search unavailable" }, 502);
  }
});

app.get("/api/books/chapters", async (c) => {
  const user = await requireUser(c);
  if (!user) return json({ error: "not authenticated" }, 401);
  const work = workId(c.req.query("work"));
  if (!work) return json({ error: "unknown book" }, 400);
  try {
    return json((await chaptersFor(work)) ?? { chapters: [] });
  } catch (err) {
    console.error("chapter lookup failed", err instanceof Error ? err.name : typeof err);
    return json({ error: "chapter lookup unavailable" }, 502);
  }
});

function hasFileExtension(path: string): boolean {
  return /\.[A-Za-z0-9]{1,16}$/.test(path);
}

async function fromAssets(
  c: { env: Env; req: { raw: Request; url: string } },
  rewritePath?: string,
): Promise<Response> {
  const assets = c.env.ASSETS;
  if (!assets) return missingAsset();
  const req = rewritePath
    ? new Request(new URL(rewritePath, c.req.url), c.req.raw)
    : c.req.raw;
  const res = await assets.fetch(req);
  const path = new URL(rewritePath ? new URL(rewritePath, c.req.url).href : c.req.url).pathname;
  const contentType = res.headers.get("content-type") ?? "";
  if (hasFileExtension(path) && (res.status === 404 || contentType.includes("text/html"))) {
    return missingAsset();
  }
  if (res.status === 200 && path.startsWith("/assets/")) {
    const headers = new Headers(res.headers);
    headers.set("cache-control", "public, max-age=31536000, immutable");
    headers.set("x-content-type-options", "nosniff");
    return new Response(res.body, { status: res.status, headers });
  }
  return res;
}

// ── Shared meetings: the owner's side ─────────────────────────────────────

function shareFailure(err: unknown, fallback: string): Response {
  if (err instanceof ShareError) return json({ error: err.message }, err.status);
  console.error(fallback, err instanceof Error ? err.message : "unknown");
  return json({ error: fallback }, 500);
}

async function readBody(c: WorkerContext): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

app.get("/api/shares", async (c) => {
  const user = await requireUser(c);
  if (!user) return json({ error: "not authenticated" }, 401);
  try {
    return json({ shares: await listShares(sqlOf(c), user.id) });
  } catch (err) {
    return shareFailure(err, "could not list shares");
  }
});

app.post("/api/shares", async (c) => {
  const user = await requireUser(c);
  if (!user) return json({ error: "not authenticated" }, 401);
  const body = await readBody(c);
  if (!body) return json({ error: "invalid json" }, 400);
  try {
    return json({ share: await createShare(sqlOf(c), user.id, body) });
  } catch (err) {
    return shareFailure(err, "could not share");
  }
});

app.delete("/api/shares/:id", async (c) => {
  const user = await requireUser(c);
  if (!user) return json({ error: "not authenticated" }, 401);
  try {
    const ok = await revokeShare(sqlOf(c), user.id, c.req.param("id"));
    return ok ? json({ ok: true }) : json({ error: "not found" }, 404);
  } catch (err) {
    return shareFailure(err, "could not revoke");
  }
});

app.get("/api/shared-with-me", async (c) => {
  const user = await requireUser(c);
  if (!user) return json({ error: "not authenticated" }, 401);
  try {
    return json({ meetings: await sharedWithMe(sqlOf(c), user.email) });
  } catch (err) {
    return shareFailure(err, "could not list shared meetings");
  }
});

// ── Shared meetings: the guest's side ─────────────────────────────────────
// No session: the token in the path is the whole credential, and it opens
// exactly one meeting. Every handler resolves it first.

async function withMember(
  c: WorkerContext,
  run: (member: Member) => Promise<Response>,
): Promise<Response> {
  const res = await (async () => {
    try {
      const member = await memberByToken(sqlOf(c), c.req.param("token") ?? "");
      if (!member) return json({ error: "this link isn't active" }, 404);
      return await run(member);
    } catch (err) {
      return shareFailure(err, "shared meeting failed");
    }
  })();
  res.headers.set("cache-control", "no-store");
  res.headers.set("referrer-policy", "no-referrer");
  return res;
}

app.get("/api/with/:token", (c) =>
  withMember(c, async (m) => json(await loadShared(sqlOf(c), m))),
);

app.post("/api/with/:token/topics", (c) =>
  withMember(c, async (m) => {
    const body = await readBody(c);
    if (!body) return json({ error: "invalid json" }, 400);
    return json(
      await guestAddTopic(sqlOf(c), m, body, undefined, {
        guard: flagOn("singleOccurrenceGuard") || flagFromEnv(c.env.SINGLE_OCCURRENCE_GUARD),
      }),
    );
  }),
);

app.delete("/api/with/:token/topics/:id", (c) =>
  withMember(c, async (m) => {
    await guestRemoveTopic(sqlOf(c), m, c.req.param("id"));
    return json({ ok: true });
  }),
);

app.put("/api/with/:token/follow-ups/:id", (c) =>
  withMember(c, async (m) => {
    const body = await readBody(c);
    if (!body) return json({ error: "invalid json" }, 400);
    await guestSetFollowUp(sqlOf(c), m, c.req.param("id"), body.done);
    return json({ ok: true });
  }),
);

app.put("/api/with/:token/takeaways/:stepId", (c) =>
  withMember(c, async (m) => {
    const body = await readBody(c);
    if (!body) return json({ error: "invalid json" }, 400);
    await guestSetTakeaway(sqlOf(c), m, c.req.param("stepId"), body);
    return json({ ok: true });
  }),
);

app.put("/api/with/:token/notes/:sessionId", (c) =>
  withMember(c, async (m) => {
    const body = await readBody(c);
    if (!body) return json({ error: "invalid json" }, 400);
    await guestSetNote(sqlOf(c), m, c.req.param("sessionId"), body);
    return json({ ok: true });
  }),
);

/** Unknown API paths: JSON 404 (with API security headers), never the SPA or a 500. */
function apiNotFound(): Response {
  return json({ error: "not found" }, 404);
}

app.all("/api/*", () => apiNotFound());
app.all("/functions/*", () => apiNotFound());

app.all("/assets/*", (c) => fromAssets(c));
app.all("*", (c) => fromAssets(c));

export default {
  fetch: app.fetch,
};

export { app };
