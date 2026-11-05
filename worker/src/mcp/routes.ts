/**
 * The MCP endpoint as mounted on the Worker: the protocol server, the tools,
 * and the OAuth bearer check, joined.
 */
import { authenticateBearer, unauthorizedResponse } from "../oauth/bearer.ts";
import { createMcpApp } from "./http.ts";
import { createMcpServer } from "./server.ts";
import { INSTRUCTIONS, PROMPTS, TOOLS } from "./tools/index.ts";

export const mcpServer = createMcpServer({
  name: "polarch",
  title: "Polarch",
  version: "1.0.0",
  instructions: INSTRUCTIONS,
  tools: TOOLS,
  prompts: PROMPTS,
  // Name and SQLSTATE only: a database error's message can quote row values.
  onError: (tool, err) => {
    const e = err as { name?: string; code?: unknown };
    console.error(`mcp: ${tool} failed`, e?.name ?? typeof err, typeof e?.code === "string" ? e.code : "");
  },
});

export const mcpApp = createMcpApp({
  server: mcpServer,
  authenticate: authenticateBearer,
  unauthorized: (env, req) => unauthorizedResponse(env, req),
});
