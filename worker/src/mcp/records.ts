/**
 * The people records — everything outside the agenda: profiles, health,
 * prayer, assessments, notes, wins, goals, the prayer log, what's known about
 * someone, fixtures, the glossary, past write-ups and transcripts.
 *
 * Only tools behind the `people:*` scopes come here. Unlike the agenda, these
 * are read and written as rows, column by column against the allowlist in
 * `tables.ts`, and every write goes through the same journal as the agenda so
 * `list_changes` and `undo_change` cover it too.
 */
import type { Sql } from "../db.ts";
import type { Row } from "../store.ts";
import { JSON_COLUMNS, TABLE_COLUMNS, type TableName } from "../tables.ts";
import { ToolError, type ToolContext } from "./server.ts";
import { commitPlan, newId, ownedColumns, stable, type ChangeEntry, type SaveResult } from "./workspace.ts";

/** Base64 images: never useful to a model, and large enough to crowd out everything else. */
const NEVER_READ = new Set(["user_id", "photo"]);

/** Tables a people tool may read or write, and nothing else. */
export type RecordTable =
  | "people"
  | "teams"
  | "managers"
  | "notes"
  | "wins"
  | "goals"
  | "prayers"
  | "team_goals"
  | "team_notes"
  | "team_actions"
  | "glossary"
  | "fixtures"
  | "knowledge"
  | "shared_notes";

function parseJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    // Some old rows hold plain text in a JSON column; it's still what the person wrote.
    return v;
  }
}

/** A row as a model should see it: no user id or photo, JSON parsed, empty values left out. */
export function present(row: Row): Row {
  const out: Row = {};
  for (const [k, raw] of Object.entries(row)) {
    if (NEVER_READ.has(k)) continue;
    const v = JSON_COLUMNS.has(k) ? parseJson(raw) : raw instanceof Date ? raw.toISOString().slice(0, 10) : raw;
    if (v === null || v === undefined || v === "" || v === false) continue;
    if (Array.isArray(v) && !v.length) continue;
    out[k] = v;
  }
  return out;
}

function readable(table: TableName, extra: readonly string[] = []): string[] {
  return [...TABLE_COLUMNS[table].filter((c) => !NEVER_READ.has(c)), ...extra];
}

/** Rows of one table matching `where` (column = value), every readable column. */
export async function readRows(
  sql: Sql,
  userId: string,
  table: RecordTable | "one_on_ones",
  where: Record<string, string> = {},
  opts: { columns?: readonly string[]; orderBy?: string; limit?: number } = {},
): Promise<Row[]> {
  const allowed = new Set(TABLE_COLUMNS[table]);
  const cols = (opts.columns ?? readable(table)).filter((c) => allowed.has(c) && c !== "user_id");
  const keys = Object.keys(where);
  for (const k of keys) if (!allowed.has(k)) throw new Error(`${table}: unknown column ${k}`);
  if (opts.orderBy && !allowed.has(opts.orderBy)) throw new Error(`${table}: unknown column ${opts.orderBy}`);
  const filter = keys.map((k, i) => ` AND "${k}" = $${i + 2}`).join("");
  const order = opts.orderBy ? ` ORDER BY "${opts.orderBy}" DESC NULLS LAST` : "";
  const limit = opts.limit ? ` LIMIT ${Math.max(1, Math.floor(opts.limit))}` : "";
  return (await sql.unsafe(
    `SELECT ${cols.map((c) => `"${c}"`).join(", ")} FROM "${table}" WHERE user_id = $1${filter}${order}${limit}`,
    [userId, ...keys.map((k) => where[k])],
  )) as unknown as Row[];
}

export async function readOne(sql: Sql, userId: string, table: RecordTable, id: string): Promise<Row | null> {
  return (await readRows(sql, userId, table, { id }))[0] ?? null;
}

/**
 * A batch of row changes, built up by a tool and then committed as one
 * journaled change. Updates are diffed against the stored row, so only the
 * columns that really change are written (and journaled).
 */
export class RecordBatch {
  readonly ctx: ToolContext;
  readonly plan: ChangeEntry[] = [];
  constructor(ctx: ToolContext) {
    this.ctx = ctx;
  }

  insert(table: RecordTable, row: Row): string {
    const id = typeof row.id === "string" && row.id ? row.id : newId();
    const allowed = new Set(TABLE_COLUMNS[table]);
    const clean: Row = {};
    for (const [k, v] of Object.entries(row)) if (allowed.has(k) && k !== "user_id") clean[k] = v;
    this.plan.push({ op: "insert", table, id, row: { ...clean, id } });
    return id;
  }

  /** Returns the row as it will be, or throws not_found. A patch that changes nothing adds nothing. */
  async update(table: RecordTable, id: string, patch: Row): Promise<Row> {
    const current = await readRows(this.ctx.sql, this.ctx.principal.userId, table, { id }, { columns: ownedColumns(table) });
    const was = current[0];
    if (!was) throw new ToolError("not_found", `No ${table.replace(/_/g, " ").replace(/s$/, "")} with id "${id}".`);
    const allowed = new Set(TABLE_COLUMNS[table]);
    const before: Row = {};
    const after: Row = {};
    for (const [k, v] of Object.entries(patch)) {
      if (!allowed.has(k) || k === "user_id" || k === "id" || v === undefined) continue;
      const old = JSON_COLUMNS.has(k) ? parseJson(was[k]) : was[k];
      if (stable(old) === stable(v)) continue;
      before[k] = was[k] ?? null;
      after[k] = v;
    }
    if (Object.keys(after).length) this.plan.push({ op: "update", table, id, before, after });
    return { ...was, ...after };
  }

  async remove(table: RecordTable, id: string): Promise<Row> {
    const was = await readOne(this.ctx.sql, this.ctx.principal.userId, table, id);
    if (!was) throw new ToolError("not_found", `No ${table.replace(/_/g, " ").replace(/s$/, "")} with id "${id}".`);
    this.plan.push({ op: "delete", table, id, row: {} });
    return was;
  }

  async commit(tool: string, summary: string): Promise<SaveResult> {
    return commitPlan(this.ctx.sql, this.ctx.principal.userId, this.plan, {
      tool,
      clientId: this.ctx.principal.clientId,
      summary,
    });
  }
}

/** list_people's extra columns for a connection that may see the people records. */
export async function peopleHealth(ctx: { sql: Sql; principal: { userId: string } }) {
  const uid = ctx.principal.userId;
  const [people, teams, managers] = await Promise.all([
    readRows(ctx.sql, uid, "people", {}, { columns: ["id", "health", "prayer"] }),
    readRows(ctx.sql, uid, "teams", {}, { columns: ["id", "health", "prayer"] }),
    readRows(ctx.sql, uid, "managers", {}, { columns: ["id", "prayer"] }),
  ]);
  const map = new Map<string, Row>();
  for (const r of [...people, ...teams, ...managers]) {
    const p = present(r);
    const health = p.health as Row | undefined;
    map.set(String(r.id), {
      ...(health?.level ? { health: health.level } : {}),
      ...(p.prayer ? { carrying_in_prayer: true } : {}),
    });
  }
  return map;
}
