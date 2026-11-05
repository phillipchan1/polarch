/**
 * `POST /mcp` — MCP's Streamable HTTP transport, the stateless half of it.
 *
 * The bearer check is injected (`authenticate` / `unauthorized`) so the OAuth
 * server and the protocol can be built and tested apart. Everything else a
 * public endpoint owes a caller lives here: an Origin check, a body limit, rate
 * limits, JSON-RPC framing, and headers that keep a proxy from caching answers.
 */
import { Hono } from "hono";
import { isLoopbackHostname, resolveAuthBaseURL, resolveTrustedOrigins } from "../authUrl.ts";
import { API_SECURITY } from "../cors.ts";
import type { Sql } from "../db.ts";
import type { Env } from "../env.ts";
import { consumeRateLimitKey, type RateLimitRule } from "../rateLimit.ts";
import { sqlOf, type WorkerContext, type WorkerVars } from "../request.ts";
import type { McpPrincipal } from "./principal.ts";
import {
  RPC,
  SUPPORTED_VERSIONS,
  type RpcResponse,
  type ToolContext,
} from "./server.ts";

/** Reads: plenty for a model working through a planning session. */
export const MCP_CALLS_RULE: RateLimitRule = { window: 60, max: 120 };
/** Writes are the ones that can make a mess, so they get a tighter bucket. */
export const MCP_WRITES_RULE: RateLimitRule = { window: 60, max: 40 };

export const MAX_BODY_BYTES = 256 * 1024;
const MAX_BATCH = 20;

/** Web hosts of the assistants that connect from a browser. Server-side callers send no Origin. */
const ASSISTANT_ORIGINS = new Set([
  "https://claude.ai",
  "https://www.claude.ai",
  "https://chatgpt.com",
  "https://www.chatgpt.com",
  "https://chat.openai.com",
  "https://platform.openai.com",
]);

type Dispatcher = {
  handle(message: unknown, ctx: ToolContext): Promise<RpcResponse | null>;
  /** The scope a tool needs, or undefined if there is no such tool. */
  scopeOf(tool: string): string | undefined;
};

export type McpHttpDeps = {
  server: Dispatcher;
  authenticate(sql: Sql, env: Env, req: Request): Promise<McpPrincipal | null>;
  unauthorized(env: Env, req: Request): Response;
};

/**
 * DNS-rebinding guard from the transport spec: a request that names an Origin
 * must name one we know. No Origin at all (a server talking to a server) is fine —
 * the bearer token is what authenticates, and a browser can't attach it unasked.
 */
export function originAllowed(origin: string | null | undefined, env: Env): boolean {
  if (!origin) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (isLoopbackHostname(url.hostname)) return true;
  if (ASSISTANT_ORIGINS.has(url.origin)) return true;
  try {
    return resolveTrustedOrigins(env).includes(url.origin);
  } catch {
    return false;
  }
}

function baseUrlOf(env: Env, req: Request): string {
  try {
    return resolveAuthBaseURL(env);
  } catch {
    return new URL(req.url).origin;
  }
}

function sqlRateLimitDb(sql: Sql) {
  return {
    async connect() {
      return {
        async query(text: string, params: readonly unknown[]) {
          const rows = (await sql.unsafe(text, params as never[])) as unknown as unknown[];
          return { rows, rowCount: rows.length };
        },
        release() {},
      };
    },
  };
}

function corsFor(origin: string | null, env: Env): Record<string, string> {
  if (!origin || !originAllowed(origin, env)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, content-type, accept, mcp-protocol-version, mcp-session-id",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Expose-Headers": "www-authenticate",
    Vary: "Origin",
  };
}

function reply(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      "Cache-Control": "no-store",
      ...API_SECURITY,
      ...extra,
    },
  });
}

const rpcFail = (code: number, message: string): RpcResponse => ({
  jsonrpc: "2.0",
  id: null,
  error: { code, message },
});

export function createMcpApp(deps: McpHttpDeps) {
  const app = new Hono<{ Bindings: Env; Variables: WorkerVars }>();

  app.options("/mcp", (c) => {
    const origin = c.req.header("Origin") ?? null;
    if (!originAllowed(origin, c.env)) return reply(undefined, 403);
    return new Response(null, { status: 204, headers: { ...corsFor(origin, c.env), ...API_SECURITY } });
  });

  // No server-initiated stream and no session to terminate: say so, rather than 404.
  for (const method of ["get", "delete"] as const) {
    app[method]("/mcp", () =>
      reply({ error: "This MCP server only accepts POST." }, 405, { Allow: "POST, OPTIONS" }),
    );
  }

  app.post("/mcp", async (c: WorkerContext) => {
    const origin = c.req.header("Origin") ?? null;
    if (!originAllowed(origin, c.env)) return reply({ error: "origin not allowed" }, 403);
    const cors = corsFor(origin, c.env);

    const sql = sqlOf(c);
    const principal = await deps.authenticate(sql, c.env, c.req.raw);
    if (!principal) {
      const res = deps.unauthorized(c.env, c.req.raw);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    }

    const version = c.req.header("MCP-Protocol-Version");
    if (version && !(SUPPORTED_VERSIONS as readonly string[]).includes(version)) {
      return reply(rpcFail(RPC.INVALID_REQUEST, `Unsupported MCP-Protocol-Version "${version.slice(0, 40)}".`), 400, cors);
    }
    if (!(c.req.header("Content-Type") ?? "").toLowerCase().includes("application/json")) {
      return reply(rpcFail(RPC.INVALID_REQUEST, "Content-Type must be application/json."), 415, cors);
    }
    const declared = Number(c.req.header("Content-Length") ?? 0);
    if (declared > MAX_BODY_BYTES) {
      return reply(rpcFail(RPC.INVALID_REQUEST, "Request too large."), 413, cors);
    }
    const text = await c.req.text();
    if (text.length > MAX_BODY_BYTES) {
      return reply(rpcFail(RPC.INVALID_REQUEST, "Request too large."), 413, cors);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return reply(rpcFail(RPC.PARSE_ERROR, "Parse error."), 400, cors);
    }
    const batch = Array.isArray(body);
    const messages: unknown[] = Array.isArray(body) ? body : [body];
    if (!messages.length || messages.length > MAX_BATCH) {
      return reply(rpcFail(RPC.INVALID_REQUEST, `Send between 1 and ${MAX_BATCH} messages.`), 400, cors);
    }

    // Count what this request will do before doing any of it.
    let calls = 0;
    let writes = 0;
    for (const m of messages) {
      if (typeof m !== "object" || m === null) continue;
      const msg = m as { method?: unknown; id?: unknown; params?: { name?: unknown } };
      if (msg.method !== "tools/call" || msg.id === undefined) continue;
      calls += 1;
      const scope = typeof msg.params?.name === "string" ? deps.server.scopeOf(msg.params.name) : undefined;
      if (scope?.endsWith(":write")) writes += 1;
    }
    const limitDb = sqlRateLimitDb(sql);
    const buckets: [string, RateLimitRule, number][] = [
      [`mcp:calls:${principal.userId}`, MCP_CALLS_RULE, Math.max(1, calls)],
      [`mcp:writes:${principal.userId}`, MCP_WRITES_RULE, writes],
    ];
    for (const [key, rule, cost] of buckets) {
      for (let i = 0; i < cost; i++) {
        const r = await consumeRateLimitKey(limitDb, key, rule);
        if (!r.allowed) {
          return reply(
            { error: "Too many requests. Slow down and retry shortly." },
            429,
            { ...cors, "Retry-After": String(r.retryAfter ?? 60) },
          );
        }
      }
    }

    const ctx: ToolContext = { principal, sql, env: c.env, baseUrl: baseUrlOf(c.env, c.req.raw) };
    const out: RpcResponse[] = [];
    for (const message of messages) {
      const res = await deps.server.handle(message, ctx);
      if (res) out.push(res);
    }
    // Only notifications and responses went in: the transport answers 202 with no body.
    if (!out.length) return reply(undefined, 202, cors);
    return reply(batch ? out : out[0], 200, cors);
  });

  return app;
}
