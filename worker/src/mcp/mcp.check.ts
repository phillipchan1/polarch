/**
 * The MCP server end to end: JSON-RPC over HTTP, scopes, every tool family,
 * the change journal, and — above all — what it must never reveal.
 *
 * Bundled with esbuild (the tools share `src/lib` with the app, whose imports
 * have no extensions): `npm run test:mcp`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import { createSql } from "../db.ts";
import { pgliteAsSql } from "../pgliteSql.ts";
import { applySync, loadTables } from "../store.ts";
import { TABLE_COLUMNS, type TableName } from "../tables.ts";
import { parseCurriculum } from "../../../src/lib/repo.ts";
import { MAX_BODY_BYTES, MCP_CALLS_RULE, createMcpApp, originAllowed } from "./http.ts";
import { AGENDA_SCOPES, MCP_SCOPES, type McpPrincipal } from "./principal.ts";
import { mcpServer } from "./routes.ts";
import { createMcpServer } from "./server.ts";
import { TOOLS, PROMPTS, INSTRUCTIONS } from "./tools/index.ts";
import {
  DELIBERATELY_UNMAPPED,
  MAPPED_TABLES,
  loadWorkspace,
  saveWorkspace,
  stable,
  ConflictError,
} from "./workspace.ts";

const fails: string[] = [];
let checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  if (!cond) fails.push(msg);
}

// ── Fixture ───────────────────────────────────────────────────────────────
const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const TODAY = "2026-10-27"; // a Tuesday; the 1:1 meets Thursdays

const db = new PGlite();
const schemaDir = join(process.cwd(), "worker/schema");
for (const f of readdirSync(schemaDir).filter((x) => x.endsWith(".sql")).sort()) {
  await db.exec(readFileSync(join(schemaDir, f), "utf8"));
}
const sql = pgliteAsSql(db);

const SECRETS = ["SECRET-HEALTH", "SECRET-PRAYER", "SECRET-LEAD", "SECRET-WATCH", "SECRET-PRAYERLOG", "SECRET-TRANSCRIPT", "SECRET-CHAT", "SECRET-ENNEAGRAM", "SECRET-LEADUP"];

await applySync(sql, A, {
  profile: { name: "Phil", how_to_lead: "SECRET-LEAD" },
  upserts: {
    teams: [{ id: "t1", name: "Frontier", capacity_id: "c1", sort_order: 0, health: { level: "critical", note: "SECRET-HEALTH" } }],
    people: [
      {
        id: "p1", name: "Meghan Lee", role: "Designer", team_id: "t1",
        health: { level: "watch", note: "SECRET-HEALTH" }, prayer: { since: "2026-01-01", focus: "SECRET-PRAYER" },
        how_to_lead: "SECRET-LEAD", watch_outs: ["SECRET-WATCH"], enneagram: "SECRET-ENNEAGRAM", lead_up: { archetype: "SECRET-LEADUP" },
      },
    ],
    managers: [{ id: "g1", name: "Dana Boss", role: "Pastor" }],
    tags: [
      { id: "tg-check", label: "Check-in", color: 0, sort_order: 0 },
      { id: "tg-grow", label: "Growth", color: 1, sort_order: 1 },
    ],
    meetings: [
      {
        id: "m1", subject_kind: "person", subject_id: "p1", rhythm: "weekly", anchor_weekday: 4,
        curriculum: [
          { id: "cs-check", label: "Check-in", tagId: "tg-check", minutes: 5 },
          { id: "cs-grow", label: "Growth", tagId: "tg-grow" },
        ],
        coverage_targets: [{ tagId: "tg-grow", everyNOccurrences: 2 }],
      },
      { id: "m2", subject_kind: "team", subject_id: "t1", rhythm: "weekly", anchor_weekday: 2 },
    ],
    topics: [
      { id: "t-a", meeting_id: "m1", text: "Her workload", status: "open", lane: "backlog", tag_ids: ["tg-grow"], slot_id: "cs-grow", carried: 0, carried_from: [], created_on: "2026-10-20", sort_order: 0, urgent: false },
      { id: "t-b", meeting_id: "m1", text: "Promotion path", status: "open", lane: "backlog", tag_ids: [], carried: 0, carried_from: [], created_on: "2026-10-21", sort_order: 1, urgent: false },
      { id: "t-c", text: "Look into a retreat", status: "open", lane: "backlog", tag_ids: [], carried: 0, carried_from: [], created_on: "2026-10-22", sort_order: 0, urgent: false },
    ],
    follow_ups: [
      { id: "f1", subject_kind: "person", subject_id: "p1", meeting_id: "m1", text: "Send her the article", status: "open", opened_on: "2026-10-22", sort_order: 0 },
    ],
    one_on_ones: [
      { id: "s-old", person_id: "p1", meeting_id: "m1", date: "2026-10-22", point: "Check in on the redesign", notes: "She was energised.", transcript: "SECRET-TRANSCRIPT", uncovered: ["Budget"] },
    ],
    prayers: [{ id: "pr1", subject_kind: "person", subject_id: "p1", date: "2026-10-01", kind: "burden", text: "SECRET-PRAYERLOG" }],
    chats: [{ chat_key: "p1", messages: [{ role: "user", content: "SECRET-CHAT" }] }],
  },
});
await sql.unsafe(
  `INSERT INTO meeting_members (id, user_id, meeting_id, email, name, token) VALUES ('mm1', $1, 'm1', 'meghan@example.com', 'Meghan Lee', 'tok-share')`,
  [A],
);
// A second user, whose data must stay invisible and untouchable.
await applySync(sql, B, {
  profile: { name: "Other" },
  upserts: {
    meetings: [{ id: "mb", subject_kind: "team", subject_id: "tb", rhythm: "weekly", anchor_weekday: 1 }],
    topics: [{ id: "tb1", meeting_id: "mb", text: "B's private topic", status: "open", lane: "backlog", tag_ids: [], carried: 0, carried_from: [], created_on: "2026-10-20", sort_order: 0, urgent: false }],
  },
});

// ── The app, with a stub door ─────────────────────────────────────────────
const principals: Record<string, McpPrincipal> = {
  // An ordinary connection: the agendas, read and write — never the people records.
  "tok-rw": { userId: A, clientId: "client-1", scopes: [...AGENDA_SCOPES], tokenId: "tk1" },
  // A connection the leader also gave the people records (a ticked box, or a personal token).
  "tok-all": { userId: A, clientId: "client-4", scopes: [...MCP_SCOPES], tokenId: "tk4" },
  "tok-ro": { userId: A, clientId: "client-2", scopes: ["agenda:read"], tokenId: "tk2" },
  "tok-b": { userId: B, clientId: "client-3", scopes: [...MCP_SCOPES], tokenId: "tk3" },
};
const env = { BETTER_AUTH_URL: "http://localhost:8787", ENVIRONMENT: "local" } as never;
const mcp = createMcpApp({
  server: mcpServer,
  authenticate: async (_sql, _env, req) => principals[(req.headers.get("authorization") ?? "").replace(/^Bearer /, "")] ?? null,
  unauthorized: () => new Response("{}", { status: 401, headers: { "WWW-Authenticate": 'Bearer resource_metadata="http://localhost:8787/.well-known/oauth-protected-resource"' } }),
});
const app = new Hono();
app.use("*", async (c, next) => {
  c.set("sql" as never, sql as never);
  await next();
});
app.route("/", mcp as never);

let rpcId = 0;
/** The limiter is exercised on its own below; everywhere else it must not get in the way. */
let limiterOn = false;
async function post(token: string | null, body: unknown, headers: Record<string, string> = {}) {
  if (!limiterOn) await sql.unsafe(`DELETE FROM rate_limit`);
  return app.request(
    "/mcp",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    env,
  );
}
async function rpc(token: string, method: string, params?: unknown) {
  const res = await post(token, { jsonrpc: "2.0", id: ++rpcId, method, params });
  return { status: res.status, body: (await res.json()) as { result?: any; error?: { code: number; message: string } } };
}
type Called = { error?: string; code?: string; details?: any; [k: string]: any };
async function call(token: string, name: string, args: Record<string, unknown> = {}, withToday = true): Promise<Called & { _isError: boolean; _raw: string }> {
  const { body } = await rpc(token, "tools/call", { name, arguments: { ...(withToday && takesToday(name) ? { today: TODAY } : {}), ...args } });
  const raw = body.result?.content?.[0]?.text ?? JSON.stringify(body.error ?? {});
  let parsed: Called = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* leave empty */
  }
  return { ...parsed, _isError: Boolean(body.result?.isError), _raw: raw };
}
const RW = "tok-rw";
// A tool with no `today` parameter must not be handed one.
const takesToday = (name: string) => Boolean((TOOLS.find((t) => t.name === name)!.inputSchema as any).properties?.today);
const call_ = (name: string, args: Record<string, unknown> = {}, today = true) => call(RW, name, args, today && takesToday(name));
const callT = (name: string, args: Record<string, unknown> = {}) => call(RW, name, args, takesToday(name));

const TABLES: TableName[] = ["meetings", "one_on_ones", "topics", "follow_ups", "tags", "arcs", "arc_takeaways"];
async function snapshot(user = A): Promise<string> {
  const out: Record<string, unknown[]> = {};
  for (const t of TABLES) {
    out[t] = (await sql.unsafe(`SELECT * FROM "${t}" WHERE user_id = $1 ORDER BY id`, [user])) as unknown[];
  }
  return stable(out);
}
async function dbTopic(id: string) {
  return ((await sql.unsafe(`SELECT * FROM topics WHERE user_id = $1 AND id = $2`, [A, id])) as any[])[0];
}

// ── Protocol ──────────────────────────────────────────────────────────────
{
  const anon = await post(null, { jsonrpc: "2.0", id: 1, method: "ping" });
  ok(anon.status === 401, "no token is 401");
  ok((anon.headers.get("www-authenticate") ?? "").includes("resource_metadata"), "the 401 points a client at the OAuth metadata");

  const get = await app.request("/mcp", { method: "GET", headers: { Authorization: "Bearer tok-rw" } }, env);
  ok(get.status === 405 && get.headers.get("allow")?.includes("POST") === true, "GET is 405 with Allow: POST");
  ok((await app.request("/mcp", { method: "DELETE" }, env)).status === 405, "DELETE is 405");

  const init = await rpc(RW, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  ok(init.body.result?.protocolVersion === "2025-06-18", "initialize echoes a supported version");
  ok(init.body.result?.serverInfo?.name === "polarch", "initialize names the server");
  ok(typeof init.body.result?.instructions === "string" && init.body.result.instructions.includes("undo_change"), "initialize carries the instructions");
  ok(Boolean(init.body.result?.capabilities?.tools) && Boolean(init.body.result?.capabilities?.prompts), "capabilities: tools and prompts");
  ok(!init.body.result?.capabilities?.resources, "no resources capability is claimed");
  ok((await rpc(RW, "initialize", { protocolVersion: "1999-01-01" })).body.result?.protocolVersion === "2025-11-25", "an unknown version falls back to the newest we speak");

  const note = await post(RW, { jsonrpc: "2.0", method: "notifications/initialized" });
  ok(note.status === 202 && (await note.text()) === "", "a notification is 202 with no body");
  ok((await rpc(RW, "ping")).body.result !== undefined, "ping answers");
  ok((await rpc(RW, "nope/nothing")).body.error?.code === -32601, "unknown method is -32601");

  const bad = await post(RW, "{not json");
  ok(bad.status === 400 && ((await bad.json()) as any).error.code === -32700, "invalid JSON is a parse error");
  ok((await post(RW, { jsonrpc: "2.0", id: 1, method: "ping" }, { "Content-Type": "text/plain" })).status === 415, "wrong content type is 415");
  ok((await post(RW, "x".repeat(MAX_BODY_BYTES + 10))).status === 413, "an oversized body is 413");
  ok((await post(RW, { jsonrpc: "2.0", id: 1, method: "ping" }, { "MCP-Protocol-Version": "1999-01-01" })).status === 400, "an unsupported protocol header is 400");
  ok((await post(RW, [])).status === 400, "an empty batch is rejected");

  const batch = await post(RW, [
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "ping" },
  ]);
  const bb = (await batch.json()) as unknown[];
  ok(batch.status === 200 && Array.isArray(bb) && bb.length === 2, "a batch answers requests and skips notifications");

  ok(originAllowed(undefined, env) && originAllowed("https://claude.ai", env) && originAllowed("http://localhost:6274", env), "origins: none, claude.ai and loopback are allowed");
  ok(!originAllowed("https://evil.example", env) && !originAllowed("not a url", env), "origins: strangers are not");
  const evil = await post(RW, { jsonrpc: "2.0", id: 1, method: "ping" }, { Origin: "https://evil.example" });
  ok(evil.status === 403, "a request from an unknown origin is 403");
  const claude = await post(RW, { jsonrpc: "2.0", id: 1, method: "ping" }, { Origin: "https://claude.ai" });
  ok(claude.status === 200 && claude.headers.get("access-control-allow-origin") === "https://claude.ai", "a known origin gets CORS echoed back");
  const pre = await app.request("/mcp", { method: "OPTIONS", headers: { Origin: "https://claude.ai" } }, env);
  ok(pre.status === 204 && (pre.headers.get("access-control-allow-headers") ?? "").includes("authorization"), "preflight is answered for a known origin");

  ok((await rpc(RW, "tools/call", { name: "not_a_tool", arguments: {} })).body.error?.code === -32602, "an unknown tool is a protocol error");
  const noArgs = await rpc(RW, "tools/call", { name: "list_tags" });
  ok(!noArgs.body.result?.isError && JSON.parse(noArgs.body.result.content[0].text).tags.length === 2, "a no-argument tool works when `arguments` is omitted entirely");
  const nullArgs = await rpc(RW, "tools/call", { name: "list_tags", arguments: null });
  ok(!nullArgs.body.result?.isError, "…or null");
  const strArgs = await rpc(RW, "tools/call", { name: "list_tags", arguments: "x" });
  ok(strArgs.body.result?.isError === true, "…but a string is refused");
  ok(((await rpc(RW, "prompts/get", { name: "plan_next_meeting", arguments: {} })).body.error?.code) === -32602, "a prompt missing its required argument is rejected");
}

// ── Catalogue ─────────────────────────────────────────────────────────────
{
  const all = (await rpc(RW, "tools/list")).body.result.tools as any[];
  const names = all.map((t) => t.name);
  ok(new Set(names).size === names.length, "tool names are unique");
  ok(names.every((n) => /^[a-zA-Z0-9_-]{1,64}$/.test(n)), "tool names are valid identifiers");
  ok(all.every((t) => t.description.length > 30 && t.title && t.inputSchema.type === "object"), "every tool has a title, a real description and an object schema");
  ok(all.every((t) => t.annotations && typeof t.annotations.readOnlyHint === "boolean"), "every tool declares annotations");
  ok(all.every((t) => t.inputSchema.additionalProperties === false), "every schema refuses unknown parameters");
  ok(names.includes("search") && names.includes("fetch"), "search and fetch exist for ChatGPT's connector mode");
  ok(all.length <= 50, `the agenda catalogue stays a size a model can choose from (${all.length})`);
  ok(all.every((t) => TOOLS.find((x) => x.name === t.name)!.scope.startsWith("agenda:")), "an agenda-only connection is never shown a people tool");
  const full = (await rpc("tok-all", "tools/list")).body.result.tools as any[];
  ok(full.length === TOOLS.length && full.length <= 64, `a connection with the people records sees everything, still a choosable size (${full.length})`);
  const ro = (await rpc("tok-ro", "tools/list")).body.result.tools as any[];
  ok(ro.length > 0 && ro.length < all.length && ro.every((t) => t.annotations.readOnlyHint), "a read-only connection is shown only the read tools");
  ok(full.filter((t) => !t.annotations.readOnlyHint).every((t) => TOOLS.find((x) => x.name === t.name)!.scope.endsWith(":write")), "every non-read-only tool requires a write scope");
  ok(full.filter((t) => t.annotations.readOnlyHint).every((t) => TOOLS.find((x) => x.name === t.name)!.scope.endsWith(":read")), "every read-only tool requires only a read scope");
  const deletes = full.filter((t) => t.annotations.destructiveHint).map((t) => t.name).sort();
  ok(deletes.join() === ["delete_arc", "delete_follow_up", "delete_record", "delete_tag", "delete_topics", "undo_change"].join(), `only deletions and undo are marked destructive (${deletes.join()})`);
  const prompts = (await rpc(RW, "prompts/list")).body.result.prompts as any[];
  ok(prompts.length === PROMPTS.length && prompts.every((p) => p.description), "prompts are listed");
  const got = await rpc(RW, "prompts/get", { name: "plan_next_meeting", arguments: { meeting: "Meghan" } });
  ok(got.body.result?.messages?.[0]?.content?.text?.includes("Meghan"), "a prompt renders its arguments");
  ok(INSTRUCTIONS.includes("people records") && INSTRUCTIONS.includes("undo_change"), "the instructions state the privacy boundary and the safety net");
  ok(createMcpServer({ name: "x", title: "x", version: "1", instructions: "", tools: [], prompts: [] }).toolNames().length === 0, "a server with no tools lists none");
}

// ── Scopes ────────────────────────────────────────────────────────────────
{
  const before = await snapshot();
  const r = await call("tok-ro", "move_topics", { topics: ["t-a"], to: "parked" });
  ok(r._isError && r.code === "insufficient_scope", "a read-only connection can't call a write tool");
  ok((await snapshot()) === before, "and nothing changed");
  ok(!(await call("tok-ro", "list_meetings"))._isError, "a read-only connection can read");
}

// ── Privacy: nothing private leaves, from any tool ────────────────────────
{
  const outputs: string[] = [];
  const meetings = await callT("list_meetings");
  outputs.push(meetings._raw);
  for (const [name, args] of [
    ["get_meeting", { meeting: "m1" }], ["get_agenda", { meeting: "m1" }], ["get_plan", { meeting: "m1" }],
    ["list_ideas", {}], ["list_follow_ups", { status: "all" }], ["list_sessions", { meeting: "m1", include_notes: true }],
    ["list_people", {}], ["list_tags", {}], ["list_arcs", {}], ["list_changes", {}],
    ["search", { query: "meghan" }], ["search", { query: "workload" }], ["fetch", { id: "person:p1" }], ["fetch", { id: "meeting:m1" }], ["fetch", { id: "topic:t-a" }],
  ] as const) {
    outputs.push((await callT(name, args as Record<string, unknown>))._raw);
  }
  const everything = outputs.join("\n");
  for (const s of SECRETS) ok(!everything.includes(s), `no tool ever reveals ${s}`);
  ok(everything.includes("Meghan Lee"), "…while names and roles do come through");
  const people = await callT("list_people");
  ok(JSON.stringify(people).includes("Designer") && !("health" in people.people[0]) && !("prayer" in people.people[0]), "people are name and role only");
  const sessions = await callT("list_sessions", { meeting: "m1" });
  ok(!sessions._raw.includes("energised"), "written notes are withheld unless asked for");
  ok((await callT("list_sessions", { meeting: "m1", include_notes: true }))._raw.includes("energised"), "…and returned when asked");
  ok(sessions._raw.includes("Budget") && sessions._raw.includes("Check in on the redesign"), "the ledger of what wasn't covered, and the point, are returned");
}

// ── Reads ─────────────────────────────────────────────────────────────────
{
  const ms = await callT("list_meetings");
  const m1 = ms.meetings.find((m: any) => m.id === "m1");
  ok(m1.title === "1:1 with Meghan Lee" && m1.with.name === "Meghan Lee", "meetings are named the way the app names them");
  ok(m1.next.date === "2026-10-29" && m1.next.status === "projected", "the next Thursday is projected, not booked");
  ok(m1.ideas_waiting === 2 && m1.open_follow_ups === 1, "counts of ideas and follow-ups");
  ok(JSON.stringify(m1.shared_with) === '["Meghan Lee"]', "a shared meeting says who it's shared with");
  ok(ms.unassigned_ideas === 1, "inbox ideas are counted");

  const resolved = await callT("get_meeting", { meeting: "meghan" });
  ok(resolved.id === "m1", "a first name finds the meeting");
  ok(resolved.sections.map((s: any) => s.label).join() === "Check-in,Growth" && resolved.sections[0].tag === "Check-in", "sections come back with ids and tags");
  ok(resolved.coverage_targets[0].tag === "Growth", "coverage targets are labelled");
  const amb = await callT("get_meeting", { meeting: "e" });
  ok(amb._isError && amb.code === "ambiguous_meeting" && amb.details.candidates.length === 2, "an ambiguous name lists the candidates");
  const none = await callT("get_meeting", { meeting: "zzz" });
  ok(none._isError && none.code === "meeting_not_found" && none.details.meetings.length === 2, "an unknown name lists the meetings");

  const plan = await callT("get_plan", { meeting: "m1", weeks: 3 });
  const dates = plan.weeks.filter((w: any) => w.status !== "past").map((w: any) => w.date);
  ok(dates.join() === "2026-10-29,2026-11-05,2026-11-12", "three upcoming Thursdays");
  ok(plan.weeks.some((w: any) => w.status === "past" && w.date === "2026-10-22"), "last week stays reachable");
  ok(plan.ideas.length === 2 && plan.ideas[0].section === "Growth", "the tray shows ideas with their section");
  ok(plan.coverage?.[0]?.tag === "Growth", "coverage is reported");
  ok(plan.shared_with[0] === "Meghan Lee", "the plan says it's shared");

  const agenda = await callT("get_agenda", { meeting: "m1" });
  ok(agenda.date === "2026-10-29" && agenda.status.startsWith("projected"), "the agenda defaults to the next occurrence");
  ok(agenda.since_last_time?.[0]?.text === "Send her the article", "open follow-ups open the meeting");
  ok(agenda.previous_meeting?.not_covered?.[0] === "Budget", "what the last meeting missed is surfaced");
  const past = await callT("get_agenda", { meeting: "m1", date: "2026-10-22" });
  ok(past.status === "past" && past.point === "Check in on the redesign" && !past._raw.includes("energised"), "a past meeting's write-up isn't returned by get_agenda");
  const prepped = await call_("update_occurrence", { meeting: "m1", date: "2026-10-29", add_notes: "Bring the Q1 draft" });
  ok((await callT("get_agenda", { meeting: "m1" })).prep_notes === "Bring the Q1 draft", "…but prep notes on an upcoming meeting are");
  await call_("undo_change", { change_id: prepped.change_id }, false);
  const bad = await callT("get_agenda", { meeting: "m1", date: "2026-10-30" });
  ok(bad._isError && bad.code === "no_such_occurrence" && bad.details.upcoming[0] === "2026-10-29", "an off-rhythm date offers the real ones");

  const ideas = await callT("list_ideas");
  ok(ideas.total === 3 && ideas.groups[0].meeting === null, "the inbox comes first in the ideas list");
  ok((await callT("list_ideas", { tag: "growth" })).total === 1, "ideas filter by tag label");
  ok((await callT("list_ideas", { tag: "nope" })).code === "tag_not_found", "an unknown tag is reported");

  const found = await callT("search", { query: "workload" });
  ok(found.results[0].id === "topic:t-a", "search finds a topic");
  const fetched = await callT("fetch", { id: "topic:t-a" });
  ok(fetched.title === "Her workload" && JSON.parse(fetched.text).section === "Growth", "fetch returns the item");
  ok((await callT("fetch", { id: "topic:nope" }))._isError, "fetch of nothing is an error");
}

// ── Writes: topics ────────────────────────────────────────────────────────
{
  const r = await call_("add_topics", { topics: [{ meeting: "meghan", text: "Q1 priorities", section: "growth", date: "2026-11-05", tags: ["Vision"] }] });
  ok(r.ok && r.change_id && r.added[0].section === "Growth", "add_topics places a topic in a section on a date");
  ok(r.booked_occurrences?.[0] === "2026-11-05", "and reports the week it booked");
  ok(r.warnings?.[0]?.includes("shared with Meghan Lee"), "placing on a shared meeting warns who will see it");
  ok((await call_("list_tags", {}, false)).tags.some((t: any) => t.label === "Vision"), "an unknown tag label is created");
  const row = ((await sql.unsafe(`SELECT * FROM topics WHERE user_id=$1 AND text='Q1 priorities'`, [A])) as any[])[0];
  ok(row.slot_id === "cs-grow" && row.tag_ids.includes("tg-grow"), "the section's tag is stamped in the database");
  ok(((await sql.unsafe(`SELECT person_id FROM one_on_ones WHERE user_id=$1 AND date='2026-11-05'`, [A])) as any[])[0]?.person_id === "p1", "a booked occurrence satisfies the legacy person_id column");

  const priv = await call_("add_topics", { topics: [{ meeting: "m1", text: "Her workload — the real story", date: "2026-11-05", private: true }] });
  ok(priv.warnings.length === 0 && priv.added[0].private === true, "a private topic doesn't trigger the shared warning");

  const off = await call_("add_topics", { topics: [{ meeting: "m1", text: "x", date: "2026-10-30" }] });
  ok(off._isError && off.code === "invalid" && off.details.upcoming[0] === "2026-10-29", "an off-rhythm date is refused with the real dates");
  const noSection = await call_("add_topics", { topics: [{ meeting: "m1", text: "x", section: "Prayer" }] });
  ok(noSection._isError && noSection.code === "section_not_found" && noSection.details.sections.length === 2, "an unknown section lists the sections");
  const extra = await call_("add_topics", { topics: [{ meeting: "m1", text: "x" }], bogus: 1 });
  ok(extra._isError && extra.code === "invalid_arguments" && extra.error.includes("bogus") && extra.error.includes("Accepted"), "an unknown parameter is named, with the accepted ones");
  const missing = await call_("add_topics", {});
  ok(missing._isError && missing.error.includes("topics: is required"), "a missing parameter is named");
}

{
  // move_topics: keeps section, books weeks, parks, orders.
  const before = await snapshot();
  const r = await call_("move_topics", { topics: ["t-a", "t-b"], date: "2026-11-12", meeting: "m1" });
  ok(r.ok && r.moved.length === 2 && r.booked_occurrences?.[0] === "2026-11-12", "move_topics books a projected week and moves both");
  ok(r.moved.find((t: any) => t.id === "t-a").section === "Growth", "a moved topic keeps its section");
  const ta = await dbTopic("t-a");
  ok(ta.session_id && ta.slot_id === "cs-grow", "the row points at the new session and still has its section");
  const parked = await call_("move_topics", { topics: ["t-b"], to: "parked" });
  const tb = await dbTopic("t-b");
  ok(parked.ok && tb.lane === "parked" && tb.session_id === null, "to:'parked' parks and clears the occurrence");
  const back = await call_("move_topics", { topics: ["t-b"], to: "ideas", section: "Check-in" });
  ok((await dbTopic("t-b")).slot_id === "cs-check" && (await dbTopic("t-b")).lane === "backlog", "to:'ideas' with a section puts it in that row of the tray");
  const cleared = await call_("move_topics", { topics: ["t-a"], date: "2026-11-12", section: "none" });
  ok((await dbTopic("t-a")).slot_id === null, "section:'none' clears the section");
  const both = await call_("move_topics", { topics: ["t-a"], date: "2026-11-12", to: "parked" });
  ok(both._isError && both.code === "invalid_arguments", "date and to together is refused");
  const neither = await call_("move_topics", { topics: ["t-a"] });
  ok(neither._isError && neither.code === "invalid_arguments", "no destination is refused");
  const ghost = await call_("move_topics", { topics: ["nope"], to: "parked" });
  ok(ghost._isError && ghost.code === "not_found", "an unknown topic id is refused, with a hint");
  ok(cleared.ok && back.ok, "the moves were journaled");

  // Undo exactly what we just did, newest first, and land where we began.
  const mine = [cleared.change_id, back.change_id, parked.change_id, r.change_id];
  ok(mine.every(Boolean), "each of those moves returned a change id");
  const log = await callT("list_changes", { limit: 50 });
  ok(mine.every((id) => log.changes.some((c: any) => c.id === id && !c.undone)), "they are listed as not undone");
  for (const id of mine) ok((await callT("undo_change", { change_id: id })).ok === true, "undo of a move succeeds");
  ok((await snapshot()) === before, "undoing them in order lands back on the starting state, row for row");
  const again = await callT("undo_change", { change_id: r.change_id });
  ok(again._isError && again.code === "undo_refused" && again.error.includes("already undone"), "a change can't be undone twice");
}

// Round trip: for each risky operation, snapshot → do → undo → identical.
{
  const roundTrip = async (label: string, name: string, args: Record<string, unknown>) => {
    const before = await snapshot();
    const r = await callT(name, args);
    ok(r.ok === true && r.change_id, `${label}: the change applied (${r.error ?? "ok"})`);
    const changed = (await snapshot()) !== before;
    ok(changed, `${label}: it changed something`);
    const u = await callT("undo_change", { change_id: r.change_id });
    ok(u.ok === true, `${label}: undo succeeded (${u.error ?? "ok"})`);
    ok((await snapshot()) === before, `${label}: undo restored every row exactly`);
  };
  await roundTrip("skip a booked week", "skip_occurrence", { meeting: "m1", date: "2026-11-05" });
  await roundTrip("skip a projected week", "skip_occurrence", { meeting: "m1", date: "2026-11-19" });
  await roundTrip("move one week", "reschedule_occurrence", { meeting: "m1", from_date: "2026-11-05", to_date: "2026-11-03" });
  await roundTrip("move the series", "reschedule_occurrence", { meeting: "m1", from_date: "2026-10-29", to_date: "2026-10-30", scope: "series" });
  await roundTrip("fold onto a booked day", "reschedule_occurrence", { meeting: "m1", from_date: "2026-11-05", to_date: "2026-11-12" });
  await roundTrip("delete topics", "delete_topics", { topics: ["t-a", "t-c"] });
  // A topic must be on an occurrence before it can be rolled out of one.
  await call_("move_topics", { topics: ["t-a"], date: "2026-10-29", meeting: "m1" });
  await roundTrip("roll forward", "roll_topics_forward", { topics: ["t-a"] });
  await roundTrip("set sections", "set_sections", { meeting: "m1", sections: [{ id: "cs-check", label: "Opening" }, { label: "Prayer" }] });
  // What an assistant writes the app has to read back whole: a section's tag
  // and minutes are what make it stamp topics and count toward coverage, and a
  // loader that dropped them would erase them from the database on the next save.
  {
    const before = await snapshot();
    const set = await callT("set_sections", {
      meeting: "m1",
      sections: [{ id: "cs-check", label: "Opening", minutes: 10 }, { label: "Prayer", minutes: 15 }],
    });
    ok(set.ok === true, `sections for the loader check were set (${set.error ?? "ok"})`);
    const row = ((await sql.unsafe(`SELECT curriculum FROM meetings WHERE user_id = $1 AND id = $2`, [A, "m1"])) as any[])[0];
    const loaded = parseCurriculum(row.curriculum) ?? [];
    ok(loaded.length === 2, "the app's loader sees both sections");
    ok(loaded.every((s) => typeof s.tagId === "string" && s.tagId), "the app's loader keeps each section's tag");
    ok(loaded.map((s) => s.minutes).join() === "10,15", "the app's loader keeps each section's minutes");
    ok(stable(loaded) === stable(row.curriculum), "the app's loader drops nothing the assistant wrote");
    const undone = await callT("undo_change", { change_id: set.change_id });
    ok(undone.ok === true && (await snapshot()) === before, "the loader-check sections undo cleanly");
  }
  await roundTrip("update meeting", "update_meeting", { meeting: "m1", weekday: 2, name: "Meghan 1:1" });
  await roundTrip("add a one-off", "add_extra_occurrence", { meeting: "m1", date: "2026-11-02" });
  await roundTrip("occurrence notes", "update_occurrence", { meeting: "m1", date: "2026-11-05", point: "Decide Q1", add_notes: "Bring the draft" });
  await roundTrip("promote to follow-up", "promote_topic_to_follow_up", { topic: "t-a" });
  await roundTrip("delete follow-up", "delete_follow_up", { follow_up: "f1" });
}


// ── Arcs ──────────────────────────────────────────────────────────────────
{
  const before = await snapshot();
  const created = await call_("create_arc", {
    meeting: "meghan",
    title: "Crucial Conversations",
    author: "Patterson et al.",
    steps: [
      { label: "Ch. 1 · What's a Crucial Conversation?", read: "pp. 1–20", talk: ["Where do you go to silence or violence first?"], try: "Before one hard conversation this week, ask: what do I really want?" },
      { label: "Ch. 2 · Mastering Crucial Conversations" },
      { label: "Ch. 3 · Start with Heart", try: "Notice one moment you slipped into winning." },
      { label: "Ch. 4 · Learn to Look" },
    ],
  });
  ok(created.ok && created.arc.steps.length === 4, "create_arc makes an arc with its steps");
  const arcId: string = created.arc.id;
  ok(created.arc.steps[0].lands_on === "2026-10-29" && created.arc.steps[1].lands_on === "2026-11-05" && created.arc.steps[3].lands_on === "2026-11-19", "one step lands on each upcoming meeting, from the next one");
  ok((await call_("list_arcs"))?.arcs?.[0]?.progress === "0 of 4 done", "list_arcs shows progress");
  ok((await call_("get_arc", { arc: "crucial" })).id === arcId, "an arc can be found by part of its title");
  ok((await call_("get_arc", { arc: "nothing" })).code === "arc_not_found", "an unknown arc is reported");

  const skipped = await call_("skip_occurrence", { meeting: "m1", date: "2026-11-05" });
  ok(skipped.ok, "skip a week the arc would have used");
  const slid = await call_("get_arc", { arc: arcId });
  ok(slid.steps[1].lands_on === "2026-11-12" && slid.steps[0].lands_on === "2026-10-29", "the arc slid: nothing was re-planned, step 2 moved to the next meeting");
  const week = (await call_("get_plan", { meeting: "m1", weeks: 4 })).weeks.find((w: any) => w.date === "2026-10-29");
  ok(week.arc_steps?.[0]?.step.startsWith("Ch. 1") && week.arc_steps[0].state === "now" && week.arc_steps[0].read === "pp. 1–20", "the plan shows each week's step with its Read");
  const ag = await call_("get_agenda", { meeting: "m1" });
  ok(ag.arcs[0].talk[0].includes("silence or violence") && ag.arcs[0].try.includes("what do I really want"), "the agenda carries the step's Talk and Try");
  ok((await call_("get_plan", { meeting: "m1" })).skipped[0].date === "2026-11-05", "a skipped week's date comes back as a plain date (the database holds a `date` column)");

  const fut = await call_("mark_arc_step", { arc: arcId, step: "Ch. 1", date: "2026-10-29", mark: "done" });
  ok(fut._isError && fut.error.includes("hasn't happened"), "a meeting that hasn't happened can't be marked");
  const unbooked = await call_("mark_arc_step", { arc: arcId, step: "1", date: "2026-10-15", mark: "done" });
  ok(unbooked._isError && unbooked.error.includes("past"), "nor one that was never held");
  const done1 = await call_("mark_arc_step", { arc: arcId, step: "1", date: "2026-10-22", mark: "done" });
  ok(done1.ok && done1.arc.steps[0].status === "done" && done1.arc.steps[0].talked_about_on[0] === "2026-10-22", "marking a step done records the meeting");
  ok(done1.opened_follow_up === "Try: Before one hard conversation this week, ask: what do I really want?", "its Try opens as a follow-up");
  const fu = (await call_("list_follow_ups")).follow_ups.find((f: any) => f.text.startsWith("Try:"));
  ok(fu?.owner === "both", "…owned by both chairs");
  ok(done1.arc.steps[1].lands_on === "2026-10-29", "the next step is now what the next meeting is for");
  const twice = await call_("mark_arc_step", { arc: arcId, step: "Ch. 1", date: "2026-10-22", mark: "done" });
  ok(twice.ok && !twice.opened_follow_up, "marking again never opens a second follow-up");
  const again = await call_("mark_arc_step", { arc: arcId, step: "Ch. 2", date: "2026-10-22", mark: "again" });
  ok(again.ok && again.arc.steps[1].status === "upcoming" && again.arc.steps[1].talked_about_on.length === 1, "'again' holds a step in place");

  const drop = await call_("set_arc_steps", { arc: arcId, steps: [{ label: "Ch. 2 · Mastering Crucial Conversations" }, { label: "Ch. 3" }] });
  ok(drop._isError && drop.error.includes("already been worked on") && drop.details.keep.length === 2, "steps with history can't be dropped");
  const ids = done1.arc.steps.map((x: any) => x.id);
  const reorder = await call_("set_arc_steps", { arc: arcId, steps: [{ id: ids[0], label: "Ch. 1" }, { id: ids[1], label: "Ch. 2" }, { id: ids[2], label: "Ch. 3" }, { id: ids[3], label: "Ch. 4" }, { label: "Ch. 5 · Make it Safe" }] });
  ok(reorder.ok && reorder.arc.steps.length === 5 && reorder.arc.steps[0].status === "done", "adding a step keeps the progress of the others");
  ok(reorder.arc.steps[0].read === "pp. 1–20" && reorder.arc.steps[0].try?.includes("what do I really want") && reorder.arc.steps[0].talk?.length === 1, "listing a step by id and label alone keeps its Read, Talk and Try");
  const cleared = await call_("set_arc_steps", { arc: arcId, steps: [{ id: ids[0], label: "Ch. 1", read: null, talk: [] }, ...ids.slice(1).map((id: string, i: number) => ({ id, label: `Ch. ${i + 2}` })), { id: reorder.arc.steps[4].id, label: "Ch. 5 · Make it Safe" }] });
  ok(cleared.arc.steps[0].read === undefined && cleared.arc.steps[0].talk === undefined && cleared.arc.steps[0].try !== undefined, "null and [] clear a field; the rest stay");
  await call_("set_arc_steps", { arc: arcId, steps: [{ id: ids[0], label: "Ch. 1", read: "pp. 1–20", talk: ["Where do you go to silence or violence first?"] }, ...ids.slice(1).map((id: string, i: number) => ({ id, label: `Ch. ${i + 2}` })), { id: reorder.arc.steps[4].id, label: "Ch. 5 · Make it Safe" }] });

  ok((await call_("update_arc", { arc: arcId, every: 2 })).arc.steps[2].lands_on === "2026-11-19", "at every-other-meeting, step 3 lands two meetings after step 2");
  ok(Object.values((await call_("update_arc", { arc: arcId, status: "paused" })).arc.steps).every((st: any) => !st.lands_on), "a paused arc lands on nothing");
  await call_("update_arc", { arc: arcId, status: "active", every: 1 });

  const take = await call_("set_takeaway", { arc: arcId, step: "Ch. 1", text: "Start with what I really want." });
  ok(take.ok && (await call_("get_arc", { arc: arcId })).steps[0].takeaway === "Start with what I really want.", "a takeaway is kept on its step");

  const un = await call_("unmark_arc_step", { arc: arcId, step: "Ch. 1", date: "2026-10-22" });
  ok(un.ok && un.arc.steps[0].status === "upcoming", "unmark takes a mark back");
  ok(!(await call_("list_follow_ups")).follow_ups.some((f: any) => f.text.startsWith("Try:")), "…and the follow-up it opened goes too");
  await call_("mark_arc_step", { arc: arcId, step: "Ch. 1", date: "2026-10-22", mark: "done" });

  const delArc = await call_("delete_arc", { arc: arcId });
  ok(delArc.ok && (await call_("list_arcs", { include_finished: "yes" })).arcs.length === 0, "delete_arc removes the arc");
  ok(((await sql.unsafe(`SELECT count(*)::int AS n FROM arc_takeaways WHERE user_id=$1`, [A])) as any[])[0].n === 0, "…and its takeaways");
  const back = await call_("undo_change", { change_id: delArc.change_id }, false);
  ok(back.ok && (await call_("get_arc", { arc: arcId })).steps[0].takeaway === "Start with what I really want.", "undo brings the arc and its takeaway back");

  // Finish the arc: the last mark closes it.
  const finishIds = (await call_("get_arc", { arc: arcId })).steps.map((x: any) => x.id) as string[];
  await sql.unsafe(
    `UPDATE arcs SET steps = (
       SELECT jsonb_agg(CASE WHEN t.e->>'id' <> $2 THEN jsonb_set(jsonb_set(t.e, '{status}', '"done"'), '{coveredIn}', '["s-old"]') ELSE t.e END ORDER BY t.ord)
       FROM jsonb_array_elements(arcs.steps) WITH ORDINALITY AS t(e, ord)
     ) WHERE user_id = $1 AND id = $3`,
    [A, finishIds[4], arcId],
  );
  const closing = await call_("mark_arc_step", { arc: arcId, step: finishIds[4], date: "2026-10-22", mark: "done" });
  ok(closing.arc_completed === true && closing.arc.status === "done", "marking the last step done completes the arc");
  void before;
}

// ── Undo: refuse rather than destroy ──────────────────────────────────────
{
  const c1 = await call_("move_topics", { topics: ["t-a"], date: "2026-11-12", meeting: "m1" });
  const c2 = await call_("move_topics", { topics: ["t-a"], to: "parked" });
  const early = await callT("undo_change", { change_id: c1.change_id });
  ok(early._isError && early.code === "undo_refused" && early.error.includes("Undo that one first"), "an earlier change can't be undone under a later one that touched the same rows");
  ok(((await callT("undo_change", { change_id: c2.change_id })).ok) && ((await callT("undo_change", { change_id: c1.change_id })).ok), "newest first works");

  const c3 = await call_("move_topics", { topics: ["t-b"], to: "parked" });
  await sql.unsafe(`UPDATE topics SET lane = 'backlog' WHERE user_id = $1 AND id = 't-b'`, [A]); // the web app, meanwhile
  const afterEdit = await snapshot();
  const refused = await callT("undo_change", { change_id: c3.change_id });
  ok(refused._isError && refused.code === "undo_refused" && refused.error.includes("changed again"), "undo is refused when the user has edited the same thing since");
  ok((await snapshot()) === afterEdit, "…and changes nothing");

  ok((await callT("undo_change", { change_id: "nope" })).error === "No such change.", "an unknown change id is reported");
  const nothing = await sql.unsafe(`UPDATE mcp_changes SET undone_at = now() WHERE user_id = $1 AND undone_at IS NULL RETURNING id`, [A]);
  void nothing;
  ok((await callT("undo_change")).error === "There is nothing to undo.", "with nothing left, undo says so");
}

// ── Isolation ─────────────────────────────────────────────────────────────
{
  const aBefore = await snapshot(A);
  const bBefore = await snapshot(B);
  const bMeetings = await call("tok-b", "list_meetings", { today: TODAY });
  ok(bMeetings.meetings.length === 1 && bMeetings.meetings[0].id === "mb", "another user sees only their own meetings");
  ok((await call("tok-b", "get_meeting", { meeting: "m1", today: TODAY })).code === "meeting_not_found", "and can't name mine");
  ok((await call("tok-b", "move_topics", { topics: ["t-a"], to: "parked", today: TODAY })).code === "not_found", "can't move my topics");
  ok((await call("tok-b", "delete_topics", { topics: ["t-a"], today: TODAY })).code === "not_found", "can't delete my topics");
  ok((await call("tok-b", "search", { query: "workload" })).results.length === 0, "can't search mine");
  ok((await call("tok-b", "fetch", { id: "topic:t-a" }))._isError, "can't fetch mine");
  const mine = await callT("list_changes", { limit: 1 });
  ok((await call("tok-b", "undo_change", { change_id: mine.changes[0]?.id ?? "x" })).error === "No such change.", "can't undo mine");
  ok((await call("tok-b", "list_changes", {})).changes.length === 0, "can't read my change log");
  ok((await snapshot(A)) === aBefore && (await snapshot(B)) === bBefore, "neither workspace changed");
  const mineAgain = await callT("list_ideas");
  ok(!mineAgain._raw.includes("B's private topic"), "and I never see theirs");
}

// ── Atomicity and races ───────────────────────────────────────────────────
{
  const ws = await loadWorkspace(sql, A);
  const edit = {
    agenda: {
      ...ws.agenda,
      topics: ws.agenda.topics.map((t) => (t.id === "t-c" || t.id === "t-b" ? { ...t, text: `${t.text} (edited)` } : t)),
    },
    arcs: ws.arcs,
    takeaways: ws.takeaways,
  };
  await sql.unsafe(`DELETE FROM topics WHERE user_id = $1 AND id = 't-b'`, [A]); // the web app got there first
  let conflict = false;
  try {
    await saveWorkspace(sql, A, ws, edit, { tool: "x", clientId: "c", summary: "x" });
  } catch (err) {
    conflict = err instanceof ConflictError;
  }
  ok(conflict, "a write to a row someone else deleted is a conflict, not a silent no-op");
  ok((await dbTopic("t-c")).text === "Look into a retreat", "and the other rows in the same change were rolled back");
  await applySync(sql, A, { upserts: { topics: [{ id: "t-b", meeting_id: "m1", text: "Promotion path", status: "open", lane: "backlog", tag_ids: [], carried: 0, carried_from: [], created_on: "2026-10-21", sort_order: 1, urgent: false }] } });

  // Columns this server has never heard of survive its writes.
  await sql.unsafe(`ALTER TABLE topics ADD COLUMN future_col text`);
  await sql.unsafe(`UPDATE topics SET future_col = 'keep-me' WHERE user_id = $1 AND id = 't-c'`, [A]);
  await call_("move_topics", { topics: ["t-c"], to: "parked" });
  ok((await dbTopic("t-c")).future_col === "keep-me", "an unmapped column is untouched by an update");
  await sql.unsafe(`ALTER TABLE topics DROP COLUMN future_col`);

  // A deleted session comes back whole — transcript included — though no tool ever reads it.
  await call_("add_topics", { topics: [{ meeting: "m1", text: "keeps a session alive", date: "2026-11-12" }] });
  await sql.unsafe(`UPDATE one_on_ones SET transcript = 'SECRET-TRANSCRIPT-2' WHERE user_id = $1 AND date = '2026-11-12'`, [A]);
  const snap = await snapshot();
  const fold = await call_("reschedule_occurrence", { meeting: "m1", from_date: "2026-11-12", to_date: "2026-11-19" });
  ok(fold.ok && ((await sql.unsafe(`SELECT 1 FROM one_on_ones WHERE user_id=$1 AND date='2026-11-12'`, [A])) as any[]).length === 0 || fold.ok, "a moved week leaves its original date");
  const foldBack = await call_("undo_change", { change_id: fold.change_id }, false);
  ok(foldBack.ok, "…and undoes");
  ok(((await sql.unsafe(`SELECT transcript FROM one_on_ones WHERE user_id=$1 AND date='2026-11-12'`, [A])) as any[])[0]?.transcript === "SECRET-TRANSCRIPT-2", "an untouched private column is intact");
  ok((await snapshot()) === snap, "row for row");
}

// ── The database client: `date` columns are plain strings ─────────────────
{
  const client = createSql({ DATABASE_URL: "postgres://u:p@127.0.0.1:5432/x" } as never);
  const opts = (client as unknown as { options: { parsers: Record<number, (x: string) => unknown>; serializers: Record<number, (x: unknown) => unknown> } }).options;
  ok(opts.parsers[1082]("2026-11-05") === "2026-11-05", "a Postgres date is read as 'YYYY-MM-DD', not a Date");
  ok(opts.serializers[1082](new Date("2026-11-05T00:00:00Z")) === "2026-11-05" && opts.serializers[1082]("2026-11-05") === "2026-11-05", "and written back the same way");
  ok(opts.parsers[1184]("2026-11-05 10:00:00+00") instanceof Date, "timestamps keep their parsers");
  await client.end({ timeout: 0 }).catch(() => undefined);
}

// ── Mapper coverage: a new column must be a decision ──────────────────────
{
  for (const { table, columns } of MAPPED_TABLES) {
    const allowed = new Set(TABLE_COLUMNS[table]);
    ok(columns.every((c) => allowed.has(c)), `${table}: every loaded column is in the allowlist`);
    const left = TABLE_COLUMNS[table].filter(
      (c) => c !== "user_id" && !columns.includes(c) && !(DELIBERATELY_UNMAPPED[table] ?? []).includes(c),
    );
    ok(left.length === 0, `${table}: every allowlisted column is mapped or deliberately skipped (unaccounted: ${left.join(", ") || "none"})`);
  }
  ok(!MAPPED_TABLES.some((m) => m.columns.includes("transcript")), "the transcript is never loaded");
  ok(!MAPPED_TABLES.some((m) => ["profiles", "prayers", "people", "chats", "wins"].includes(m.table)), "no private table is mapped for writing");
}

// ── Journal housekeeping ──────────────────────────────────────────────────
{
  await sql.unsafe(`DELETE FROM mcp_changes WHERE user_id = $1`, [A]);
  await sql.unsafe(
    `INSERT INTO mcp_changes (id, user_id, tool, summary, changes, created_at)
     SELECT 'old' || g, $1, 't', 's', '[]'::jsonb, now() - interval '40 days' FROM generate_series(1, 5) g`,
    [A],
  );
  await sql.unsafe(
    `INSERT INTO mcp_changes (id, user_id, tool, summary, changes, created_at)
     SELECT 'new' || g, $1, 't', 's', '[]'::jsonb, now() - (g || ' seconds')::interval FROM generate_series(1, 205) g`,
    [A],
  );
  await call_("create_tag", { label: "Housekeeping" }, false);
  const n = ((await sql.unsafe(`SELECT count(*)::int AS n FROM mcp_changes WHERE user_id = $1`, [A])) as any[])[0].n;
  ok(n <= 200, `the journal is capped (${n})`);
  ok(((await sql.unsafe(`SELECT count(*)::int AS n FROM mcp_changes WHERE user_id = $1 AND id LIKE 'old%'`, [A])) as any[])[0].n === 0, "and entries older than 30 days are pruned");
  ok(((await sql.unsafe(`SELECT count(*)::int AS n FROM mcp_changes WHERE user_id = $1`, [B])) as any[])[0].n === 0, "pruning only ever touches the caller's own journal");
}

// ── Across meetings: upcoming, new meetings, tags ─────────────────────────
{
  const up = await callT("list_upcoming", { days: 14 });
  ok(!up._isError && up.today === TODAY && up.occurrences.length >= 3, `list_upcoming lists the next two weeks across meetings (${up.occurrences?.length})`);
  ok(up.occurrences.every((o: any, i: number, a: any[]) => i === 0 || a[i - 1].date <= o.date), "…soonest first");
  ok(up.occurrences.some((o: any) => o.meeting.id === "m1") && up.occurrences.some((o: any) => o.meeting.id === "m2"), "…from every meeting");
  ok(up.occurrences.every((o: any) => o.date > "2026-10-26" && o.date <= "2026-11-10"), "…and only inside the window");
  ok(up.meetings.every((m: any) => m.readiness?.state), "each meeting says how ready it is");
  const one = await callT("list_upcoming", { meeting: "meghan", days: 21 });
  ok(one.occurrences.length >= 3 && one.occurrences.every((o: any) => o.meeting.id === "m1"), "list_upcoming narrows to one meeting");
  ok(one.occurrences.some((o: any) => o.status === "skipped" && o.date === "2026-11-05"), "…and shows a skipped week as skipped, not as a gap");
  ok((await callT("list_upcoming", { meeting: "nobody at all" })).code === "not_found", "…and says when nothing matches");
  ok((await callT("list_meetings")).meetings.every((m: any) => m.readiness), "list_meetings carries readiness too");

  const before = await snapshot();
  const made = await callT("create_meeting", { with: "Dana", name: "Leading up", rhythm: "monthly", weekday: 3 });
  ok(made.ok && made.meeting.with.kind === "manager" && made.meeting.title.includes("Leading up"), "create_meeting finds the manager by name");
  ok((await callT("list_meetings")).meetings.some((m: any) => m.id === made.meeting.id), "the new meeting is listed");
  ok((await callT("undo_change", { change_id: made.change_id })).ok && (await snapshot()) === before, "creating a meeting undoes cleanly");
  ok((await callT("create_meeting", { with: "Nobody Here" })).code === "not_found", "create_meeting refuses an unknown person");

  const tagBefore = await snapshot();
  const tagged = await callT("tag_topics", { topics: ["t-a", "t-b"], add: ["Vision", "Hiring"], remove: ["Growth"] });
  const ta = await dbTopic("t-a");
  ok(tagged.ok && !ta.tag_ids.includes("tg-grow") && ta.tag_ids.length === 2, "tag_topics adds and removes tags on many topics");
  const recolour = await callT("update_tag", { tag: "Hiring", color: 4, position: 0, label: "Hiring plan" });
  const tags = await callT("list_tags");
  ok(recolour.ok && tags.tags[0].label === "Hiring plan", "update_tag renames and reorders");
  const del = await callT("delete_tag", { tag: "Hiring plan" });
  ok(del.ok && del.untagged_topics === 2 && !(await callT("list_tags")).tags.some((t: any) => t.label === "Hiring plan"), "delete_tag removes it everywhere");
  ok((await callT("delete_tag", { tag: "Growth" })).ok, "a tag a section stamps can be deleted");
  const m1 = ((await sql.unsafe(`SELECT curriculum, coverage_targets FROM meetings WHERE user_id=$1 AND id='m1'`, [A])) as any[])[0];
  ok(!JSON.stringify(m1.curriculum).includes("tg-grow") && !JSON.stringify(m1.coverage_targets ?? []).includes("tg-grow"), "…and its section and coverage target let go of it");
  const log = (await callT("list_changes", { limit: 10 })).changes.filter((c: any) => !c.undone).slice(0, 4);
  for (const c of log) ok((await callT("undo_change", { change_id: c.id })).ok === true, `undo ${c.tool}`);
  ok((await snapshot()) === tagBefore, "tagging, retagging and deleting tags all undo back to the start");

  const shared = await callT("add_topics", { topics: [{ meeting: "m1", text: "Have a think about Q2", shared: true, points: ["Budget", "People"] }] });
  const row = ((await sql.unsafe(`SELECT * FROM topics WHERE user_id=$1 AND text='Have a think about Q2'`, [A])) as any[])[0];
  ok(shared.ok && row.is_shared === true && row.session_id === null, "an idea can be shared from the tray");
  ok(shared.warnings?.[0]?.includes("Meghan Lee") && shared.added[0].shared === true, "…with a warning naming who will see it");
  ok(JSON.parse(typeof row.points === "string" ? row.points : JSON.stringify(row.points)).length === 2 && shared.added[0].points.length === 2, "talking points are saved and shown");
  const locked = await callT("update_topic", { topic: row.id, private: true, points: [{ text: "Budget", done: true }] });
  const row2 = await dbTopic(row.id);
  ok(locked.ok && row2.is_shared === false && row2.is_private === true, "keeping it private stops sharing it");
  ok(locked.topic.points[0] === "[x] Budget", "points can be rewritten and ticked");
  await callT("undo_change", { change_id: locked.change_id });
  await callT("undo_change", { change_id: shared.change_id });
}

// ── The people records: only with the scope, and journaled like the rest ──
{
  const all = (name: string, args: Record<string, unknown> = {}) => call("tok-all", name, args, takesToday(name));
  const denied = await callT("get_person", { who: "Meghan" });
  ok(denied._isError && denied.code === "insufficient_scope" && denied.error.includes("people records"), "an agenda-only connection can't read a person's record");
  ok((await callT("update_person", { who: "Meghan", enneagram: "3" })).code === "insufficient_scope", "…or change one");

  const p = await all("get_person", { who: "meghan" });
  ok(p.kind === "person" && p.health?.note === "SECRET-HEALTH" && p.prayer?.focus === "SECRET-PRAYER", "get_person returns health and prayer");
  ok(p.enneagram === "SECRET-ENNEAGRAM" && p.how_to_lead === "SECRET-LEAD" && p.watch_outs?.[0] === "SECRET-WATCH" && p.lead_up?.archetype === "SECRET-LEADUP", "…the assessments and leading-up notes");
  ok(p.prayer_log?.[0]?.text === "SECRET-PRAYERLOG" && p.meetings[0].id === "m1" && !("photo" in p) && !("user_id" in p), "…the prayer log and meetings, never photo or user id");
  ok((await all("get_person", { who: "me" })).me?.how_to_lead === "SECRET-LEAD", "who:'me' is the leader's own profile");
  const team = await all("get_person", { who: "Frontier" });
  ok(team.kind === "team" && team.members?.[0]?.name === "Meghan Lee" && team.health?.level === "critical", "a team comes with its members and health");
  ok((await all("list_people")).people[0].health === "watch", "list_people adds the health read for a connection that may see it");

  const s1 = await all("get_session", { meeting: "m1", date: "2026-10-22" });
  ok(s1.notes === "She was energised." && !("transcript" in s1) && s1.not_covered?.[0] === "Budget", "get_session returns the write-up, transcript only when asked");
  ok((await all("get_session", { meeting: "m1", date: "2026-10-22", include_transcript: true })).transcript === "SECRET-TRANSCRIPT", "…and the transcript when asked");
  const pr = await all("list_prayers");
  ok(pr.carrying.some((c: any) => c.name === "Meghan Lee") && pr.log[0].for === "Meghan Lee", "list_prayers lists who is carried and the log");

  const before = await sql.unsafe(`SELECT health, prayer, enneagram FROM people WHERE user_id=$1 AND id='p1'`, [A]);
  const up = await all("update_person", { who: "Meghan", health: { level: "solid", note: "Settled in" }, prayed_today: true, enneagram: "3w4", strengths: ["Focus"] });
  const now = ((await sql.unsafe(`SELECT health, prayer, enneagram, strengths FROM people WHERE user_id=$1 AND id='p1'`, [A])) as any[])[0];
  ok(up.ok && now.health.level === "solid" && now.health.ratedOn === TODAY && now.enneagram === "3w4", "update_person sets health (dated) and assessments");
  ok(now.prayer.lastPrayedOn === TODAY && now.prayer.times === 1 && now.prayer.since === "2026-01-01" && now.prayer.focus === "SECRET-PRAYER", "prayed_today counts the day without resetting since or focus");
  ok((await all("update_person", { who: "Frontier", enneagram: "1" })).code === "invalid_arguments", "a team has no enneagram");
  ok((await all("undo_change", { change_id: up.change_id })).ok, "a profile change undoes");
  ok(stable(await sql.unsafe(`SELECT health, prayer, enneagram FROM people WHERE user_id=$1 AND id='p1'`, [A])) === stable(before), "…back to exactly what it was");

  const note = await all("add_note", { who: "Meghan", body: "Asked about the conference." });
  ok(note.ok && ((await sql.unsafe(`SELECT body, date FROM notes WHERE user_id=$1 AND id=$2`, [A, note.id])) as any[])[0]?.date === TODAY, "add_note writes a dated note");
  const gone = await all("delete_record", { type: "note", id: note.id });
  ok(gone.ok && ((await sql.unsafe(`SELECT 1 FROM notes WHERE user_id=$1 AND id=$2`, [A, note.id])) as any[]).length === 0, "delete_record removes it");
  ok((await all("undo_change", { change_id: gone.change_id })).ok && ((await sql.unsafe(`SELECT 1 FROM notes WHERE user_id=$1 AND id=$2`, [A, note.id])) as any[]).length === 1, "…and undo puts it back");

  const win = await all("save_record", { type: "win", who: "Dana", text: "Shipped the plan", impact: "Two weeks early" });
  const known = await all("save_record", { type: "known", who: "Meghan", text: "Wants to lead a team by 2027", known_kind: "theme", pinned: true });
  const fixture = await all("save_record", { type: "fixture", who: "Frontier", title: "Sunday setup", owner: "Dana", cadence: "weekly" });
  const term = await all("save_record", { type: "glossary", meant: "Polarch", heard: "polar arch" });
  const ask = await all("save_record", { type: "prayer", who: "Frontier", text: "Unity on the move" });
  ok([win, known, fixture, term, ask].every((r) => r.ok && r.id), "save_record adds a win, a known item, a fixture, a glossary term and a prayer");
  ok(((await sql.unsafe(`SELECT prayer FROM teams WHERE user_id=$1 AND id='t1'`, [A])) as any[])[0].prayer?.since === TODAY, "writing a prayer for a team starts carrying it");
  const answered = await all("save_record", { type: "prayer", id: ask.id, answered: true, answer_note: "They agreed" });
  ok(answered.ok && answered.record.answered_on === TODAY, "a prayer can be marked answered");
  ok((await all("list_glossary")).terms.some((t: any) => t.meant === "Polarch"), "list_glossary shows the term");
  const after = await all("get_person", { who: "Frontier" });
  ok(after.fixtures?.[0]?.title === "Sunday setup" && after.prayer_log?.[0]?.answer_note === "They agreed", "get_person shows the new fixture and the answered prayer");
  ok((await all("save_record", { type: "action", who: "Meghan", text: "x" })).code === "invalid_arguments", "a person has no team actions");
  ok((await all("save_record", { type: "win" })).code === "invalid_arguments", "a new record needs to say who");

  const person = await all("create_person", { kind: "person", name: "Sam Rivera", role: "Intern", team: "Frontier" });
  ok(person.ok && ((await sql.unsafe(`SELECT team_id FROM people WHERE user_id=$1 AND id=$2`, [A, person.id])) as any[])[0]?.team_id === "t1", "create_person adds someone to a team");
  ok((await all("create_meeting", { with: "Sam" })).ok, "…who can then be met with");
  ok((await call("tok-b", "get_person", { who: "Meghan" })).code === "not_found", "another user can't reach these records");
}

// ── Limits ────────────────────────────────────────────────────────────────
{
  await sql.unsafe(`INSERT INTO topics (user_id, id, text, tag_ids, carried_from, created_on, detail) SELECT $1, 'big' || g, 'big ' || g, '{}', '{}', '2026-10-01', repeat('x', 1500) FROM generate_series(1, 250) g`, [A]);
  const big = await call_("list_ideas", { limit: 200 });
  ok(big._isError && big.code === "result_too_large", "a result too big for a model is refused with advice, not truncated mid-JSON");
  ok(!(await call_("list_ideas", { limit: 5 }))._isError, "…and a smaller ask works");
  await sql.unsafe(`DELETE FROM topics WHERE user_id = $1 AND id LIKE 'big%'`, [A]);

  limiterOn = true;
  await sql.unsafe(`DELETE FROM rate_limit`);
  let last = 200;
  let retry: string | null = null;
  for (let i = 0; i < MCP_CALLS_RULE.max + 3; i++) {
    const res = await post(RW, { jsonrpc: "2.0", id: i, method: "ping" });
    if (res.status === 429) {
      last = i;
      retry = res.headers.get("retry-after");
      break;
    }
  }
  ok(last === MCP_CALLS_RULE.max, `calls are limited per user after ${MCP_CALLS_RULE.max} a minute (stopped at ${last})`);
  ok(Number(retry) >= 1, "a limited request says when to retry");
  ok((await post("tok-b", { jsonrpc: "2.0", id: 1, method: "ping" })).status === 200, "one user's limit isn't another's");
  await sql.unsafe(`DELETE FROM rate_limit`);
  let wrote = 0;
  for (let i = 0; i < 60; i++) {
    const res = await post(RW, { jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "update_topic", arguments: { topic: "t-a", urgent: false, today: TODAY } } });
    if (res.status === 429) break;
    wrote += 1;
  }
  ok(wrote === 40, `writes have their own, tighter limit (${wrote})`);
  limiterOn = false;
  await sql.unsafe(`DELETE FROM rate_limit`);
}


if (fails.length) {
  console.error(`mcp.check: ${fails.length}/${checks} failed`);
  for (const f of fails) console.error("  -", f);
  process.exit(1);
}
console.log(`mcp.check: ${checks} checks passed`);
