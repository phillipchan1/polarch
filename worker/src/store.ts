import type { Sql } from "./db.ts";
import {
  ALL_TABLES,
  DATA_TABLES,
  JSON_COLUMNS,
  TABLE_COLUMNS,
  TABLE_KEY,
  TEXT_ARRAY_COLUMNS,
  isTableName,
  type TableName,
} from "./tables.ts";

export type Row = Record<string, unknown>;

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`invalid identifier: ${name}`);
  }
  return `"${name}"`;
}

const EMPTY_JSON_ARRAY_COLUMNS = new Set([
  "clifton_top5",
  "strengths",
  "watch_outs",
  "custom_modalities",
  "messages",
  "steps",
]);

/**
 * Columns added after clients already existed in the wild. A tab still running
 * the previous build upserts rows without them, and writing that absence as
 * null/false would quietly unlock a private topic or drop who raised it. When
 * the client didn't send one of these, the stored value is left alone.
 */
const PRESERVE_IF_ABSENT = new Set(["is_private", "is_shared", "raised_by", "owner", "email", "cover_url"]);

/**
 * The only covers an arc may show (Open Library's and Apple Books'). A shared
 * meeting renders the arc's cover on the guest's page, so anything else (a
 * tracking pixel, say) is dropped.
 */
const COVER_URL =
  /^https:\/\/(?:covers\.openlibrary\.org\/b\/id\/\d{1,12}-[SML]\.jpg|is\d{1,2}-ssl\.mzstatic\.com\/image\/thumb\/[A-Za-z0-9._\-/]{1,400}\/\d{2,4}x\d{2,4}bb\.(?:jpg|png))$/;

/**
 * The value a json/jsonb parameter should carry: the decoded value, never its
 * text. postgres.js JSON.stringifies every json/jsonb parameter itself, so
 * handing it text stored a JSON *string* — a meeting's sections came back as
 * one string the app could not read, and the next save wrote them away.
 *
 * Text that is JSON (an older tab sending back a row it read before this fix,
 * possibly encoded twice) is decoded until it is not.
 */
export function decodeJson(value: unknown): unknown {
  let v = value;
  for (let i = 0; i < 4 && typeof v === "string"; i++) {
    try {
      v = JSON.parse(v);
    } catch {
      break;
    }
  }
  return v;
}

function serialize(column: string, value: unknown): unknown {
  if (JSON_COLUMNS.has(column)) {
    if (value === undefined || value === null) {
      return EMPTY_JSON_ARRAY_COLUMNS.has(column) ? [] : null;
    }
    return decodeJson(value);
  }
  if (column === "is_private") return value === true;
  if (column === "cover_url") return typeof value === "string" && COVER_URL.test(value) ? value : null;
  if (TEXT_ARRAY_COLUMNS.has(column)) {
    return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
  }
  if (column === "updated_at" && (value === undefined || value === null)) {
    return new Date().toISOString();
  }
  return value === undefined ? null : value;
}

function scopedRow(userId: string, table: TableName, row: Row): Row {
  const allowed = TABLE_COLUMNS[table];
  const out: Row = {};
  for (const col of allowed) {
    if (col === "user_id") {
      out.user_id = userId;
      continue;
    }
    if (col in row) out[col] = row[col];
  }
  return out;
}


export async function loadTables(
  sql: Sql,
  userId: string,
): Promise<{ profile: Row | null; tables: Record<string, Row[]> }> {
  const profileRows = await sql.unsafe(
    `SELECT * FROM ${quoteIdent("profiles")} WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  const profile = (profileRows[0] as Row | undefined) ?? null;
  const tables: Record<string, Row[]> = {};
  await Promise.all(
    DATA_TABLES.map(async (table) => {
      const rows = await sql.unsafe(
        `SELECT * FROM ${quoteIdent(table)} WHERE user_id = $1`,
        [userId],
      );
      tables[table] = rows as unknown as Row[];
    }),
  );
  return { profile, tables };
}

export async function upsertRows(
  sql: Sql,
  userId: string,
  table: TableName,
  rows: Row[],
): Promise<void> {
  if (!rows.length) return;
  const allCols = TABLE_COLUMNS[table];
  const key = TABLE_KEY[table];
  const conflict =
    table === "profiles" ? quoteIdent("user_id") : `${quoteIdent("user_id")}, ${quoteIdent(key)}`;

  for (const raw of rows) {
    const row = scopedRow(userId, table, raw);
    if (table !== "profiles" && (row[key] == null || row[key] === "")) {
      throw new Error(`${table}: missing ${key}`);
    }
    const cols = allCols.filter((col) => !PRESERVE_IF_ABSENT.has(col) || col in row);
    const colList = cols.map(quoteIdent).join(", ");
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    const updates = cols
      .filter((col) => col !== "user_id" && col !== key)
      .map((col) => `${quoteIdent(col)} = EXCLUDED.${quoteIdent(col)}`);
    const setClause = updates.length ? updates.join(", ") : `${quoteIdent("user_id")} = EXCLUDED.${quoteIdent("user_id")}`;
    const values = cols.map((col) => serialize(col, row[col]));
    await sql.unsafe(
      `INSERT INTO ${quoteIdent(table)} (${colList}) VALUES (${placeholders})
       ON CONFLICT (${conflict}) DO UPDATE SET ${setClause}`,
      values as never[],
    );
  }
}

export async function deleteKeys(
  sql: Sql,
  userId: string,
  table: TableName,
  keys: string[],
): Promise<void> {
  if (!keys.length) return;
  if (table === "profiles") {
    await sql.unsafe(`DELETE FROM ${quoteIdent("profiles")} WHERE user_id = $1`, [userId]);
    return;
  }
  const key = TABLE_KEY[table];
  await sql.unsafe(
    `DELETE FROM ${quoteIdent(table)} WHERE user_id = $1 AND ${quoteIdent(key)} = ANY($2::text[])`,
    [userId, keys],
  );
}

export async function wipeUser(
  sql: Sql,
  userId: string,
  opts: { shares?: boolean } = {},
): Promise<void> {
  for (const table of ALL_TABLES) {
    await sql.unsafe(`DELETE FROM ${quoteIdent(table)} WHERE user_id = $1`, [userId]);
  }
  // Not a synced table, so a full-document replace (seed, import) leaves it
  // alone. Deleting the workspace must not leave live links pointing into it.
  if (opts.shares) {
    await sql.unsafe(`DELETE FROM ${quoteIdent("meeting_members")} WHERE user_id = $1`, [userId]);
  }
}

export async function applySync(
  sql: Sql,
  userId: string,
  body: {
    profile?: Row | null;
    upserts?: Record<string, Row[]>;
    deletes?: Record<string, string[]>;
    replace?: boolean;
  },
): Promise<void> {
  if (body.replace) {
    await wipeUser(sql, userId);
  }
  if (body.profile) {
    await upsertRows(sql, userId, "profiles", [body.profile]);
  }
  const upserts = body.upserts ?? {};
  for (const [table, rows] of Object.entries(upserts)) {
    if (!isTableName(table)) throw new Error(`unknown table: ${table}`);
    if (!Array.isArray(rows)) throw new Error(`${table}: rows must be an array`);
    await upsertRows(sql, userId, table, rows);
  }
  const deletes = body.deletes ?? {};
  for (const [table, keys] of Object.entries(deletes)) {
    if (!isTableName(table)) throw new Error(`unknown table: ${table}`);
    if (!Array.isArray(keys)) throw new Error(`${table}: keys must be an array`);
    await deleteKeys(sql, userId, table, keys.map(String));
  }
}
