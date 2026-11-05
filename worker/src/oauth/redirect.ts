/**
 * Pure validation for the two things an authorization request is allowed to
 * steer: where the code is sent (`redirect_uri`) and what it unlocks (`scope`).
 * Everything here fails closed — an unknown shape is a refusal, not a guess.
 */
import { isLoopbackHostname } from "../authUrl.ts";
import { AGENDA_SCOPES, isMcpScope, MCP_SCOPES, type McpScope } from "../mcp/principal.ts";

export const MAX_REDIRECT_URIS = 5;
export const MAX_REDIRECT_URI_LENGTH = 512;

/** Schemes that are never a legitimate app callback, whatever the client claims. */
const DENIED_SCHEMES = new Set([
  "javascript",
  "data",
  "file",
  "blob",
  "vbscript",
  "about",
  "ftp",
  "ws",
  "wss",
  "mailto",
  "tel",
  "sms",
  "view-source",
]);

const CUSTOM_SCHEME = /^[a-z][a-z0-9+.-]*$/;

function hasControlOrSpace(text: string): boolean {
  if (/\s/.test(text)) return true;
  for (let i = 0; i < text.length; i++) {
    const n = text.charCodeAt(i);
    if (n < 0x20 || n === 0x7f) return true;
  }
  return false;
}

export type RedirectCheck = { ok: true } | { ok: false; reason: string };

/**
 * https, or http on a loopback address (a desktop app listening on localhost),
 * or a private-use scheme (`cursor://…`, `com.example.app:/cb`). No fragments,
 * no embedded credentials.
 */
export function validateRedirectUri(raw: unknown): RedirectCheck {
  if (typeof raw !== "string" || !raw) return { ok: false, reason: "must be a non-empty string" };
  if (raw.length > MAX_REDIRECT_URI_LENGTH) return { ok: false, reason: "too long" };
  if (hasControlOrSpace(raw)) return { ok: false, reason: "must not contain whitespace" };
  if (raw.includes("#")) return { ok: false, reason: "must not contain a fragment" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not an absolute URI" };
  }
  if (url.username || url.password) return { ok: false, reason: "must not contain credentials" };
  const scheme = url.protocol.slice(0, -1);
  if (scheme === "https") {
    return url.hostname ? { ok: true } : { ok: false, reason: "missing host" };
  }
  if (scheme === "http") {
    return isLoopbackHostname(url.hostname)
      ? { ok: true }
      : { ok: false, reason: "http is only allowed for localhost" };
  }
  if (DENIED_SCHEMES.has(scheme) || !CUSTOM_SCHEME.test(scheme)) {
    return { ok: false, reason: "scheme not allowed" };
  }
  return { ok: true };
}

/**
 * Exact string match, except that a registered loopback `http` URI matches any
 * port on the same host and path (RFC 8252 §7.3: a desktop app picks a free
 * port at run time). Nothing else about it may differ.
 */
export function redirectUriMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let want: URL;
  try {
    want = new URL(requested);
  } catch {
    return false;
  }
  if (want.protocol !== "http:" || want.username || want.password || want.hash) return false;
  if (!isLoopbackHostname(want.hostname)) return false;
  for (const uri of registered) {
    let have: URL;
    try {
      have = new URL(uri);
    } catch {
      continue;
    }
    if (
      have.protocol === "http:" &&
      isLoopbackHostname(have.hostname) &&
      have.hostname === want.hostname &&
      have.pathname === want.pathname &&
      have.search === want.search
    ) {
      return true;
    }
  }
  return false;
}

/** What a person should read as "where this will send you", never a raw URL. */
export function redirectLabel(uri: string): string {
  try {
    const url = new URL(uri);
    if (url.protocol === "https:") return url.host;
    if (url.protocol === "http:") return "an app on this computer (localhost)";
    return `an app that opens ${url.protocol}//`;
  } catch {
    return "an unknown address";
  }
}

/** What an app gets when it asks for nothing in particular: the agendas, not the people. */
export const DEFAULT_SCOPES: readonly McpScope[] = AGENDA_SCOPES;

export type ScopeParse = { ok: true; scopes: McpScope[] } | { ok: false };

/** Space-separated; unknown scopes are an error, empty/omitted means the default. */
export function parseScope(raw: string | null | undefined): ScopeParse {
  const parts = (raw ?? "").split(/\s+/).filter(Boolean);
  if (!parts.length) return { ok: true, scopes: [...DEFAULT_SCOPES] };
  const scopes: McpScope[] = [];
  for (const part of parts) {
    if (!isMcpScope(part)) return { ok: false };
    if (!scopes.includes(part)) scopes.push(part);
  }
  return { ok: true, scopes };
}

export function scopeString(scopes: readonly string[]): string {
  return MCP_SCOPES.filter((s) => scopes.includes(s)).join(" ");
}

/** Stored scope text → known scopes only. Anything else in the column is dropped. */
export function scopesFromText(text: string | null | undefined): McpScope[] {
  const out: McpScope[] = [];
  for (const part of (text ?? "").split(/\s+/)) {
    if (isMcpScope(part) && !out.includes(part)) out.push(part);
  }
  return out;
}

export const SCOPE_LABEL: Record<McpScope, string> = {
  "agenda:read": "See your meetings, agendas, plan-ahead weeks, ideas, follow-ups and arcs",
  "agenda:write": "Add, move, reschedule, reorder and remove items on those agendas",
  "people:read": "See the people you lead: health ratings, prayer, assessments, notes, wins, goals, past write-ups and transcripts",
  "people:write": "Update those people records: notes, wins, goals, prayer, health, what you know about them",
};
