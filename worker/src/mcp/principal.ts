/**
 * Who is calling the MCP server, and what they may do.
 *
 * The seam between the OAuth server (`worker/src/oauth/`) and the MCP tools
 * (`worker/src/mcp/`): OAuth turns a bearer token into one of these, and every
 * tool call is checked against `scopes` before it touches a row.
 */

/**
 * Granted per connection on the consent screen (or when a personal token is
 * made). `write` implies nothing about `read`.
 *
 * `agenda:*` is meetings, topics, tags, follow-ups and arcs. `people:*` is the
 * rest of the workspace: how the leader rates, prays for and assesses people,
 * their notes, wins, goals, past write-ups and transcripts. It is never part of
 * the default, so an app connected without asking for it can't see any of it.
 */
export const MCP_SCOPES = ["agenda:read", "agenda:write", "people:read", "people:write"] as const;
export const AGENDA_SCOPES = ["agenda:read", "agenda:write"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

/** Path of the MCP endpoint — also the OAuth `resource` the tokens are bound to. */
export const MCP_RESOURCE_PATH = "/mcp";

export type McpPrincipal = {
  /** Polarch user id (uuid). Every query is scoped to it. */
  userId: string;
  /** OAuth client the user approved. */
  clientId: string;
  scopes: McpScope[];
  /** Access token row id, for the change journal. Never the token itself. */
  tokenId: string;
};

export function isMcpScope(value: string): value is McpScope {
  return (MCP_SCOPES as readonly string[]).includes(value);
}

export function hasScope(principal: Pick<McpPrincipal, "scopes">, scope: McpScope): boolean {
  return principal.scopes.includes(scope);
}
