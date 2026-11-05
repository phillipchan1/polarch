/**
 * The Model Context Protocol, tools and prompts only, over stateless JSON-RPC.
 *
 * No session: every request carries its own bearer token and everything a tool
 * needs is in the database, so a Worker isolate can answer any call and a
 * client reconnecting after a deploy loses nothing. No resources, no
 * sampling, no server-initiated messages — nothing here needs them, and each
 * would be one more thing an unattended connection could do.
 */
import type { Sql } from "../db.ts";
import type { Env } from "../env.ts";
import { hasScope, type McpPrincipal, type McpScope } from "./principal.ts";
import { ArgError, parseArgs, type JsonSchema, type Parser } from "./schema.ts";

export const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const LATEST_VERSION = SUPPORTED_VERSIONS[0];

/** A tool result bigger than this is more than a model can use; ask it to narrow instead. */
export const MAX_RESULT_CHARS = 60_000;

export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

type RpcId = string | number | null;
export type RpcResponse = {
  jsonrpc: "2.0";
  id: RpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

/** A failure the caller should see and can act on — shown to the model, not logged. */
export class ToolError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.details = details;
  }
}

export type ToolContext = {
  principal: McpPrincipal;
  sql: Sql;
  env: Env;
  /** `https://polarch.day` — for links in results. */
  baseUrl: string;
};

export type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: false;
};

export const READS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
/** Changes the agenda, additively or by rearranging. Undoable. */
export const WRITES: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
/** Removes something. */
export const DELETES: ToolAnnotations = { ...WRITES, destructiveHint: true };

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  scope: McpScope;
  annotations: ToolAnnotations;
  inputSchema: JsonSchema;
  call(rawArgs: unknown, ctx: ToolContext): Promise<unknown>;
}

export function tool<I>(def: {
  name: string;
  title: string;
  description: string;
  scope: McpScope;
  annotations: ToolAnnotations;
  input: Parser<I, boolean>;
  run(input: I, ctx: ToolContext): Promise<unknown>;
}): ToolDef {
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    scope: def.scope,
    annotations: def.annotations,
    inputSchema: def.input.json,
    call: (raw, ctx) => def.run(parseArgs(def.input, raw), ctx),
  };
}

export interface PromptDef {
  name: string;
  title: string;
  description: string;
  arguments: { name: string; description: string; required?: boolean }[];
  render(args: Record<string, string>): string;
}

export type McpServerOptions = {
  name: string;
  title: string;
  version: string;
  instructions: string;
  tools: ToolDef[];
  prompts: PromptDef[];
  /** Log an unexpected failure. Never receives a message that could carry row data. */
  onError?: (tool: string, err: unknown) => void;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const rpcError = (id: RpcId, code: number, message: string, data?: unknown): RpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(data !== undefined ? { data } : {}) },
});

const ok = (id: RpcId, result: unknown): RpcResponse => ({ jsonrpc: "2.0", id, result });

export function createMcpServer(opts: McpServerOptions) {
  const tools = new Map(opts.tools.map((t) => [t.name, t] as const));
  const prompts = new Map(opts.prompts.map((p) => [p.name, p] as const));

  function negotiate(requested: unknown): string {
    return typeof requested === "string" && (SUPPORTED_VERSIONS as readonly string[]).includes(requested)
      ? requested
      : LATEST_VERSION;
  }

  async function callTool(
    params: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<{ content: { type: "text"; text: string }[]; isError?: true }> {
    const name = params.name;
    const def = typeof name === "string" ? tools.get(name) : undefined;
    const fail = (payload: Record<string, unknown>) => ({
      content: [{ type: "text" as const, text: JSON.stringify(payload) }],
      isError: true as const,
    });
    if (!def) throw new ToolError("unknown_tool", `Unknown tool "${String(name)}".`);
    if (!hasScope(ctx.principal, def.scope)) {
      return fail({
        error:
          def.scope === "agenda:write"
            ? "This connection is read-only, so it can't change the agenda. Reconnect Polarch and allow changes."
            : def.scope.startsWith("people:")
              ? "This connection wasn't given the people records (health, prayer, assessments, notes). Reconnect Polarch and tick the box for them, or make a personal token that includes them."
              : "This connection isn't allowed to read the agenda.",
        code: "insufficient_scope",
      });
    }
    try {
      const result = await def.call(params.arguments, ctx);
      const text = JSON.stringify(result ?? { ok: true });
      if (text.length > MAX_RESULT_CHARS) {
        return fail({
          error: `That result is too large (${text.length.toLocaleString("en-US")} characters). Ask for less: add a filter or lower the limit.`,
          code: "result_too_large",
        });
      }
      return { content: [{ type: "text", text }] };
    } catch (err) {
      if (err instanceof ArgError) return fail({ error: err.message, code: "invalid_arguments" });
      if (err instanceof ToolError) {
        return fail({ error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) });
      }
      opts.onError?.(def.name, err);
      return fail({ error: "Something went wrong on our side. Nothing was changed.", code: "internal_error" });
    }
  }

  /** Answer one JSON-RPC message. `null` means "nothing to send back" (a notification). */
  async function handle(message: unknown, ctx: ToolContext): Promise<RpcResponse | null> {
    if (!isRecord(message) || message.jsonrpc !== "2.0") {
      return rpcError(null, RPC.INVALID_REQUEST, "Not a JSON-RPC 2.0 message.");
    }
    const hasId = "id" in message && (typeof message.id === "string" || typeof message.id === "number");
    // A response to something we never asked, or a notification: nothing to say.
    if (typeof message.method !== "string") {
      return hasId ? rpcError(message.id as RpcId, RPC.INVALID_REQUEST, "Missing method.") : null;
    }
    if (!hasId) return null;
    const id = message.id as RpcId;
    const params = isRecord(message.params) ? message.params : {};

    switch (message.method) {
      case "initialize":
        return ok(id, {
          protocolVersion: negotiate(params.protocolVersion),
          capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: { name: opts.name, title: opts.title, version: opts.version },
          instructions: opts.instructions,
        });
      case "ping":
        return ok(id, {});
      case "tools/list":
        return ok(id, {
          tools: opts.tools
            .filter((t) => hasScope(ctx.principal, t.scope))
            .map((t) => ({
              name: t.name,
              title: t.title,
              description: t.description,
              inputSchema: t.inputSchema,
              annotations: { title: t.title, ...t.annotations },
            })),
        });
      case "tools/call":
        try {
          return ok(id, await callTool(params, ctx));
        } catch (err) {
          if (err instanceof ToolError) return rpcError(id, RPC.INVALID_PARAMS, err.message);
          opts.onError?.("tools/call", err);
          return rpcError(id, RPC.INTERNAL_ERROR, "Internal error.");
        }
      case "prompts/list":
        return ok(id, {
          prompts: opts.prompts.map((p) => ({
            name: p.name,
            title: p.title,
            description: p.description,
            arguments: p.arguments,
          })),
        });
      case "prompts/get": {
        const prompt = typeof params.name === "string" ? prompts.get(params.name) : undefined;
        if (!prompt) return rpcError(id, RPC.INVALID_PARAMS, `Unknown prompt "${String(params.name)}".`);
        const given = isRecord(params.arguments) ? params.arguments : {};
        const args: Record<string, string> = {};
        for (const a of prompt.arguments) {
          const v = given[a.name];
          if (typeof v === "string" && v.trim()) args[a.name] = v.trim().slice(0, 500);
          else if (a.required) return rpcError(id, RPC.INVALID_PARAMS, `Missing argument "${a.name}".`);
        }
        return ok(id, {
          description: prompt.description,
          messages: [{ role: "user", content: { type: "text", text: prompt.render(args) } }],
        });
      }
      default:
        return rpcError(id, RPC.METHOD_NOT_FOUND, `Method not found: ${message.method}`);
    }
  }

  return {
    handle,
    scopeOf: (name: string): McpScope | undefined => tools.get(name)?.scope,
    toolNames: () => [...tools.keys()],
  };
}
