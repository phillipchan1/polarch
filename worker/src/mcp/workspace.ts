/**
 * A user's agenda as the MCP tools see it: loaded from rows, edited as plain
 * objects by the pure ops in `src/lib`, then written back as the smallest
 * change that makes the rows match — one transaction, journaled, undoable.
 *
 * It behaves like another device. The web app diffs rows against a baseline and
 * writes only what it changed; so does this. A tab left open picks up what an
 * assistant did the next time it refreshes, and the two merge the way two
 * devices already do.
 *
 * Three rules keep that honest:
 *  - Never `SELECT *`. What isn't loaded can't leak into a result, and the
 *    session transcript (the largest, most private column) is never read.
 *  - Updates write *only the changed columns*. A column this file doesn't know
 *    about (a future one, or `transcript`) is untouched by construction.
 *  - People, teams and managers are read for their names alone. Health,
 *    prayer and assessments are never selected.
 */
import type { Sql } from "../db.ts";
import { decodeJson, deleteKeys, upsertRows, type Row } from "../store.ts";
import { JSON_COLUMNS, TABLE_COLUMNS, TEXT_ARRAY_COLUMNS, type TableName } from "../tables.ts";
import type { AgendaState } from "../../../src/lib/agendaOps.ts";
import type {
  Arc,
  ArcStep,
  CoverageTarget,
  CurriculumSlot,
  FollowUp,
  Session,
  Tag,
  Takeaway,
  Topic,
  TopicPoint,
  TrackedMeeting,
} from "../../../src/types";

// ── Values ────────────────────────────────────────────────────────────────

const nn = <T>(v: T | undefined | null): T | null => (v === undefined ? null : v);
const opt = <T>(v: T | null | undefined): T | undefined => (v === null || v === undefined ? undefined : v);
const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Postgres `date` arrives as a JS Date; the rest of the app speaks "YYYY-MM-DD". */
export function dateOnly(v: unknown): string | undefined {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v.toISOString().slice(0, 10);
  return typeof v === "string" && v ? v.slice(0, 10) : undefined;
}

export function newId(): string {
  return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => (b % 36).toString(36)).join("");
}

function jsonColumn<T>(v: unknown): T | null {
  if (typeof v !== "string") return (v ?? null) as T | null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
}

// ── Row ⇄ object mappers ──────────────────────────────────────────────────
// Each lists the columns it reads. `toRow` returns the columns it owns and
// nothing else, with `null` rather than `undefined` so a cleared field clears.

type Collection<T extends { id: string }> = {
  table: TableName;
  /** Columns loaded. Always a subset of the table's allowlist. */
  columns: readonly string[];
  fromRow(r: Row): T;
  toRow(t: T): Row;
};

const meetings: Collection<TrackedMeeting> = {
  table: "meetings",
  columns: [
    "id", "subject_kind", "subject_id", "name", "rhythm", "floor_days", "next_date",
    "anchor_weekday", "role", "tracker_url", "tracker_name", "curriculum", "coverage_targets",
  ],
  fromRow: (r) => {
    const curriculum = jsonColumn<unknown[]>(r.curriculum);
    const coverage = jsonColumn<unknown[]>(r.coverage_targets);
    const slots = (Array.isArray(curriculum) ? curriculum : []).filter(
      (c): c is CurriculumSlot =>
        !!c && typeof (c as CurriculumSlot).id === "string" && typeof (c as CurriculumSlot).label === "string",
    );
    const targets = (Array.isArray(coverage) ? coverage : []).filter(
      (c): c is CoverageTarget =>
        !!c &&
        typeof (c as CoverageTarget).tagId === "string" &&
        typeof (c as CoverageTarget).everyNOccurrences === "number",
    );
    return {
      id: r.id as string,
      subjectKind: r.subject_kind as TrackedMeeting["subjectKind"],
      subjectId: r.subject_id as string,
      name: opt(r.name as string | null),
      rhythm: (r.rhythm as TrackedMeeting["rhythm"]) ?? "as_needed",
      floorDays: opt(r.floor_days as number | null),
      nextDate: opt(r.next_date as string | null),
      anchorWeekday: opt(r.anchor_weekday as number | null),
      role: opt(r.role as TrackedMeeting["role"] | null),
      trackerUrl: opt(r.tracker_url as string | null),
      trackerName: opt(r.tracker_name as string | null),
      // Whole slot objects, not just id and label: `tagId` and `minutes` are
      // what make a section stamp its tag and budget its time.
      curriculum: slots.length ? slots : undefined,
      coverageTargets: targets.length ? targets : undefined,
    };
  },
  toRow: (m) => ({
    subject_kind: m.subjectKind,
    subject_id: m.subjectId,
    name: nn(m.name),
    rhythm: m.rhythm,
    floor_days: nn(m.floorDays),
    next_date: nn(m.nextDate),
    anchor_weekday: nn(m.anchorWeekday),
    role: nn(m.role),
    tracker_url: nn(m.trackerUrl),
    tracker_name: nn(m.trackerName),
    curriculum: m.curriculum?.length ? m.curriculum : null,
    coverage_targets: m.coverageTargets?.length ? m.coverageTargets : null,
  }),
};

const sessions: Collection<Session> = {
  table: "one_on_ones",
  // `transcript` is deliberately absent.
  columns: ["id", "meeting_id", "date", "uncovered", "point", "notes", "next_date", "series_date", "occurrence_kind"],
  fromRow: (r) => ({
    id: r.id as string,
    meetingId: (r.meeting_id as string | null) ?? "",
    date: r.date as string,
    point: opt(r.point as string | null),
    notes: opt(r.notes as string | null),
    nextDate: opt(r.next_date as string | null),
    uncovered: strArray(r.uncovered).length ? strArray(r.uncovered) : undefined,
    seriesDate: dateOnly(r.series_date),
    kind: opt(r.occurrence_kind as Session["kind"] | null),
  }),
  toRow: (o) => ({
    meeting_id: o.meetingId,
    date: o.date,
    uncovered: o.uncovered?.length ? o.uncovered : null,
    point: nn(o.point),
    notes: nn(o.notes),
    next_date: nn(o.nextDate),
    series_date: nn(o.seriesDate),
    occurrence_kind: nn(o.kind),
  }),
};

function parsePoints(v: unknown): TopicPoint[] | undefined {
  const raw = jsonColumn<unknown[]>(v);
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .filter((p): p is TopicPoint => !!p && typeof (p as TopicPoint).text === "string")
    .map((p) => ({ id: String(p.id), text: p.text, done: Boolean(p.done) }));
  return out.length ? out : undefined;
}

const topics: Collection<Topic> = {
  table: "topics",
  columns: [
    "id", "meeting_id", "text", "detail", "tag_ids", "urgent", "points", "returned_on",
    "returned_from_date", "carried_from", "status", "lane", "session_id", "carried", "due_date",
    "created_on", "closed_on", "sort_order", "slot_id", "is_private", "raised_by", "is_shared",
  ],
  fromRow: (r) => ({
    id: r.id as string,
    meetingId: opt(r.meeting_id as string | null),
    text: r.text as string,
    detail: opt(r.detail as string | null),
    tagIds: strArray(r.tag_ids),
    urgent: r.urgent ? true : undefined,
    points: parsePoints(r.points),
    returnedOn: opt(r.returned_on as string | null),
    returnedFromDate: opt(r.returned_from_date as string | null),
    carriedFrom: strArray(r.carried_from),
    status: (r.status as Topic["status"]) ?? "open",
    lane: (r.lane as Topic["lane"]) ?? "backlog",
    sessionId: opt(r.session_id as string | null),
    slotId: opt(r.slot_id as string | null),
    carried: (r.carried as number) ?? 0,
    dueDate: opt(r.due_date as string | null),
    createdOn: (r.created_on as string | null) ?? "",
    closedOn: opt(r.closed_on as string | null),
    order: (r.sort_order as number) ?? 0,
    private: r.is_private ? true : undefined,
    shared: r.is_shared ? true : undefined,
    raisedBy: opt(r.raised_by as string | null),
  }),
  toRow: (t) => ({
    meeting_id: nn(t.meetingId),
    text: t.text,
    detail: nn(t.detail),
    tag_ids: t.tagIds,
    urgent: Boolean(t.urgent),
    points: t.points?.length ? t.points : null,
    returned_on: nn(t.returnedOn),
    returned_from_date: nn(t.returnedFromDate),
    carried_from: t.carriedFrom,
    status: t.status,
    lane: t.lane,
    session_id: nn(t.sessionId),
    carried: t.carried,
    due_date: nn(t.dueDate),
    created_on: t.createdOn,
    closed_on: nn(t.closedOn),
    sort_order: t.order,
    slot_id: nn(t.slotId),
    is_private: Boolean(t.private),
    is_shared: Boolean(t.shared),
    raised_by: nn(t.raisedBy),
  }),
};

const followUps: Collection<FollowUp> = {
  table: "follow_ups",
  columns: [
    "id", "subject_kind", "subject_id", "meeting_id", "text", "status", "opened_on", "closed_on",
    "source_session_id", "sort_order", "owner", "is_private",
  ],
  fromRow: (r) => ({
    id: r.id as string,
    subjectKind: r.subject_kind as FollowUp["subjectKind"],
    subjectId: r.subject_id as string,
    meetingId: opt(r.meeting_id as string | null),
    text: (r.text as string) ?? "",
    status: (r.status as FollowUp["status"]) ?? "open",
    openedOn: (r.opened_on as string | null) ?? "",
    closedOn: opt(r.closed_on as string | null),
    sourceSessionId: opt(r.source_session_id as string | null),
    order: (r.sort_order as number) ?? 0,
    owner: opt(r.owner as string | null),
    private: r.is_private ? true : undefined,
  }),
  toRow: (f) => ({
    subject_kind: f.subjectKind,
    subject_id: f.subjectId,
    meeting_id: nn(f.meetingId),
    text: f.text,
    status: f.status,
    opened_on: f.openedOn,
    closed_on: nn(f.closedOn),
    source_session_id: nn(f.sourceSessionId),
    sort_order: f.order,
    owner: nn(f.owner),
    is_private: Boolean(f.private),
  }),
};

const tags: Collection<Tag> = {
  table: "tags",
  columns: ["id", "label", "color", "sort_order"],
  fromRow: (r) => ({
    id: r.id as string,
    label: (r.label as string) ?? "",
    color: (r.color as number) ?? 0,
    order: (r.sort_order as number) ?? 0,
  }),
  toRow: (t) => ({ label: t.label, color: t.color, sort_order: t.order }),
};

function parseSteps(v: unknown): ArcStep[] {
  const raw = jsonColumn<unknown[]>(v);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => ({
      id: String(x.id ?? ""),
      label: String(x.label ?? ""),
      read: typeof x.read === "string" && x.read ? x.read : undefined,
      prompts: strArray(x.prompts),
      practice: typeof x.practice === "string" && x.practice ? x.practice : undefined,
      status: x.status === "done" ? ("done" as const) : ("upcoming" as const),
      coveredIn: strArray(x.coveredIn),
      doneOn: typeof x.doneOn === "string" ? x.doneOn : undefined,
    }))
    .filter((x) => x.id);
}

const arcs: Collection<Arc> = {
  table: "arcs",
  columns: [
    "id", "meeting_id", "title", "author", "cover", "cover_url", "slot_id", "pace_every", "starts_on", "status",
    "steps", "passed_in", "created_on", "closed_on", "sort_order",
  ],
  fromRow: (r) => ({
    id: r.id as string,
    meetingId: r.meeting_id as string,
    title: (r.title as string) ?? "",
    author: opt(r.author as string | null),
    cover: opt(r.cover as number | null),
    coverUrl: opt(r.cover_url as string | null),
    slotId: opt(r.slot_id as string | null),
    every: Math.max(1, (r.pace_every as number) ?? 1),
    startsOn: (r.starts_on as string) ?? "",
    status: (r.status as Arc["status"]) ?? "active",
    steps: parseSteps(r.steps),
    passedIn: strArray(r.passed_in).length ? strArray(r.passed_in) : undefined,
    createdOn: (r.created_on as string | null) ?? "",
    closedOn: opt(r.closed_on as string | null),
    order: (r.sort_order as number) ?? 0,
  }),
  toRow: (a) => ({
    meeting_id: a.meetingId,
    title: a.title,
    author: nn(a.author),
    cover: nn(a.cover),
    cover_url: nn(a.coverUrl),
    slot_id: nn(a.slotId),
    pace_every: Math.max(1, Math.round(a.every || 1)),
    starts_on: a.startsOn,
    status: a.status,
    steps: a.steps,
    passed_in: a.passedIn ?? [],
    created_on: a.createdOn,
    closed_on: nn(a.closedOn),
    sort_order: a.order,
  }),
};

const takeaways: Collection<Takeaway> = {
  table: "arc_takeaways",
  columns: ["id", "arc_id", "step_id", "by_member", "text", "taken_on"],
  fromRow: (r) => ({
    id: r.id as string,
    arcId: r.arc_id as string,
    stepId: r.step_id as string,
    by: (r.by_member as string) ?? "owner",
    text: (r.text as string) ?? "",
    on: (r.taken_on as string | null) ?? "",
  }),
  toRow: (t) => ({ arc_id: t.arcId, step_id: t.stepId, by_member: t.by, text: t.text, taken_on: t.on }),
};

/** What this module is allowed to read and write. Anything not here is invisible to it. */
const COLLECTIONS = [meetings, sessions, topics, followUps, tags, arcs, takeaways] as const;

/**
 * What each mapper loads, and the columns it knowingly leaves alone. The check
 * compares this against the table allowlist, so a column someone adds later
 * (as `is_private` was) fails a test until it is either mapped or listed here.
 */
export const MAPPED_TABLES: { table: TableName; columns: readonly string[] }[] = COLLECTIONS.map((c) => ({
  table: c.table,
  columns: c.columns,
}));

/**
 * The columns a change to `table` is judged by: what the agenda mapper owns,
 * or — for the people records, written as whole rows — every allowlisted
 * column. Undo compares exactly these, so an edit elsewhere to a column
 * nobody here wrote can't block it.
 */
export function ownedColumns(table: TableName): string[] {
  const mapped = MAPPED_TABLES.find((m) => m.table === table)?.columns;
  if (mapped) return [...mapped, ...(table === "one_on_ones" ? ["person_id"] : [])];
  return TABLE_COLUMNS[table].filter((c) => c !== "user_id");
}

export const DELIBERATELY_UNMAPPED: Partial<Record<TableName, readonly string[]>> = {
  // Never loaded: the largest and most private column. `person_id` is a legacy
  // NOT NULL that inserts fill in (see `saveWorkspace`).
  one_on_ones: ["transcript", "person_id"],
};

// ── The workspace ─────────────────────────────────────────────────────────

export type Directory = {
  people: { id: string; name: string; role?: string; teamId?: string }[];
  teams: { id: string; name: string }[];
  managers: { id: string; name: string; role?: string }[];
};

export type Edit = { agenda: AgendaState; arcs: Arc[]; takeaways: Takeaway[] };

export type Workspace = Edit & {
  dir: Directory;
  /** Names of the people each meeting is shared with (active shares only). */
  sharedWith: Map<string, string[]>;
};

async function select(sql: Sql, userId: string, c: Collection<{ id: string }>): Promise<Row[]> {
  const allowed = new Set(TABLE_COLUMNS[c.table]);
  const cols = c.columns.filter((col) => allowed.has(col));
  return (await sql.unsafe(
    `SELECT ${cols.map((x) => `"${x}"`).join(", ")} FROM "${c.table}" WHERE user_id = $1`,
    [userId],
  )) as unknown as Row[];
}

export async function loadWorkspace(sql: Sql, userId: string): Promise<Workspace> {
  const [m, s, t, f, g, a, k, people, teams, managers, members] = await Promise.all([
    select(sql, userId, meetings),
    select(sql, userId, sessions),
    select(sql, userId, topics),
    select(sql, userId, followUps),
    select(sql, userId, tags),
    select(sql, userId, arcs),
    select(sql, userId, takeaways),
    sql.unsafe(`SELECT id, name, role, team_id FROM "people" WHERE user_id = $1`, [userId]),
    sql.unsafe(`SELECT id, name FROM "teams" WHERE user_id = $1`, [userId]),
    sql.unsafe(`SELECT id, name, role FROM "managers" WHERE user_id = $1`, [userId]),
    // Sharing may not be deployed yet; an agenda with no guests is the right fallback.
    sql
      .unsafe(
        `SELECT meeting_id, name FROM "meeting_members" WHERE user_id = $1 AND revoked_on IS NULL`,
        [userId],
      )
      .catch(() => [] as never[]),
  ]);
  const sharedWith = new Map<string, string[]>();
  for (const row of members as unknown as Row[]) {
    const list = sharedWith.get(row.meeting_id as string) ?? [];
    list.push(((row.name as string | null) ?? "").trim() || "a guest");
    sharedWith.set(row.meeting_id as string, list);
  }
  const asRows = (v: unknown) => v as unknown as Row[];
  return {
    agenda: {
      meetings: m.map(meetings.fromRow),
      sessions: s.map(sessions.fromRow),
      topics: t.map(topics.fromRow).sort((x, y) => x.order - y.order),
      followUps: f.map(followUps.fromRow).sort((x, y) => x.order - y.order),
      tags: g.map(tags.fromRow).sort((x, y) => x.order - y.order),
    },
    arcs: a.map(arcs.fromRow),
    takeaways: k.map(takeaways.fromRow),
    dir: {
      people: asRows(people).map((r) => ({
        id: r.id as string,
        name: r.name as string,
        role: opt(r.role as string | null),
        teamId: opt(r.team_id as string | null),
      })),
      teams: asRows(teams).map((r) => ({ id: r.id as string, name: r.name as string })),
      managers: asRows(managers).map((r) => ({
        id: r.id as string,
        name: r.name as string,
        role: opt(r.role as string | null),
      })),
    },
    sharedWith,
  };
}

// ── Saving ────────────────────────────────────────────────────────────────

export type ChangeEntry =
  | { op: "update"; table: TableName; id: string; before: Row; after: Row }
  | { op: "insert"; table: TableName; id: string; row: Row }
  | { op: "delete"; table: TableName; id: string; row: Row };

export type SaveResult = {
  changeId: string | null;
  inserted: number;
  updated: number;
  deleted: number;
};

const CONFLICT = "That was changed somewhere else while this was being worked out. Nothing was saved; read the current state and try again.";

export class ConflictError extends Error {
  constructor(message = CONFLICT) {
    super(message);
    this.name = "ConflictError";
  }
}

/** A row as it will be stored in the journal: Postgres `date` values as plain "YYYY-MM-DD". */
function imageOf(row: Row): Row {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Date ? (dateOnly(v) ?? null) : v]));
}

/** Order-independent, Date-safe JSON for comparing two row values. */
export function stable(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (x instanceof Date) return dateOnly(x) ?? null;
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === "object") {
      return Object.fromEntries(
        Object.entries(x as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([k, val]) => [k, norm(val)]),
      );
    }
    return x === undefined ? null : x;
  };
  return JSON.stringify(norm(v));
}

function serializeValue(column: string, value: unknown): unknown {
  const v = value === undefined ? null : value;
  // postgres.js encodes json/jsonb parameters itself; text here was stored as a JSON string.
  if (JSON_COLUMNS.has(column)) return v === null ? null : decodeJson(v);
  if (TEXT_ARRAY_COLUMNS.has(column)) return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  if (column === "is_private" || column === "is_shared") return v === true;
  return v;
}

function diff<T extends { id: string }>(c: Collection<T>, before: T[], after: T[]): ChangeEntry[] {
  const prev = new Map(before.map((x) => [x.id, x] as const));
  const next = new Set(after.map((x) => x.id));
  const out: ChangeEntry[] = [];
  for (const item of after) {
    const old = prev.get(item.id);
    if (!old) {
      out.push({ op: "insert", table: c.table, id: item.id, row: c.toRow(item) });
      continue;
    }
    if (old === item) continue;
    const was = c.toRow(old);
    const now = c.toRow(item);
    const changed = Object.keys(now).filter((k) => stable(was[k]) !== stable(now[k]));
    if (!changed.length) continue;
    out.push({
      op: "update",
      table: c.table,
      id: item.id,
      before: Object.fromEntries(changed.map((k) => [k, was[k]])),
      after: Object.fromEntries(changed.map((k) => [k, now[k]])),
    });
  }
  for (const old of before) {
    if (!next.has(old.id)) out.push({ op: "delete", table: c.table, id: old.id, row: {} });
  }
  return out;
}

export function planChanges(before: Edit, after: Edit): ChangeEntry[] {
  return [
    ...diff(meetings, before.agenda.meetings, after.agenda.meetings),
    ...diff(tags, before.agenda.tags, after.agenda.tags),
    ...diff(sessions, before.agenda.sessions, after.agenda.sessions),
    ...diff(topics, before.agenda.topics, after.agenda.topics),
    ...diff(followUps, before.agenda.followUps, after.agenda.followUps),
    ...diff(arcs, before.arcs, after.arcs),
    ...diff(takeaways, before.takeaways, after.takeaways),
  ];
}

/** Rows by id. `columns` omitted means every column — only for rows about to be deleted, so they can come back whole. */
async function fullRows(
  tx: Sql,
  userId: string,
  table: TableName,
  ids: string[],
  columns?: readonly string[],
): Promise<Map<string, Row>> {
  if (!ids.length) return new Map();
  const list = columns ? columns.map((c) => `"${c}"`).join(", ") : "*";
  const rows = (await tx.unsafe(
    `SELECT ${list} FROM "${table}" WHERE user_id = $1 AND id = ANY($2::text[])`,
    [userId, ids],
  )) as unknown as Row[];
  return new Map(rows.map((r) => [r.id as string, r]));
}

async function updateColumns(tx: Sql, userId: string, table: TableName, id: string, values: Row): Promise<void> {
  const cols = Object.keys(values);
  if (!cols.length) return;
  const allowed = new Set(TABLE_COLUMNS[table]);
  for (const col of cols) if (!allowed.has(col)) throw new Error(`${table}: unknown column ${col}`);
  const set = cols.map((c, i) => `"${c}" = $${i + 3}`).join(", ");
  const hit = (await tx.unsafe(
    `UPDATE "${table}" SET ${set} WHERE user_id = $1 AND id = $2 RETURNING id`,
    [userId, id, ...cols.map((c) => serializeValue(c, values[c]))] as never[],
  )) as unknown as unknown[];
  if (!hit.length) throw new ConflictError();
}

type Tx = <T>(fn: (tx: Sql) => Promise<T>) => Promise<T>;

function beginOf(sql: Sql): Tx {
  const begin = (sql as unknown as { begin?: Tx }).begin;
  if (typeof begin !== "function") throw new Error("database client has no transaction support");
  return begin.bind(sql) as Tx;
}

export const JOURNAL_KEEP = 200;
export const JOURNAL_DAYS = 30;

export async function saveWorkspace(
  sql: Sql,
  userId: string,
  before: Edit,
  after: Edit,
  meta: { tool: string; clientId: string; summary: string },
): Promise<SaveResult> {
  // Legacy NOT NULL on prod until migration 0016: mirror what the client sends.
  const personIdOf = (row: Row) =>
    after.agenda.meetings.find((x) => x.id === (row.meeting_id as string))?.subjectId ?? (row.meeting_id as string);
  return commitPlan(sql, userId, planChanges(before, after), meta, personIdOf);
}

/**
 * Write a planned set of row changes in one transaction and journal it, so it
 * can be listed and undone. Shared by the agenda (diffed from objects) and the
 * people records (written as rows).
 */
export async function commitPlan(
  sql: Sql,
  userId: string,
  plan: ChangeEntry[],
  meta: { tool: string; clientId: string; summary: string },
  personIdOf?: (row: Row) => string,
): Promise<SaveResult> {
  const result: SaveResult = {
    changeId: null,
    inserted: plan.filter((p) => p.op === "insert").length,
    updated: plan.filter((p) => p.op === "update").length,
    deleted: plan.filter((p) => p.op === "delete").length,
  };
  if (!plan.length) return result;

  const changeId = newId() + newId();
  await beginOf(sql)(async (tx) => {
    const journal: ChangeEntry[] = [];
    // Inserts first, so rows that point at them never dangle for a moment; deletes last.
    for (const p of plan.filter((x) => x.op === "insert")) {
      if (p.op !== "insert") continue;
      const row: Row = { ...p.row, id: p.id, user_id: userId };
      if (p.table === "one_on_ones" && personIdOf) row.person_id = personIdOf(p.row);
      await upsertRows(tx, userId, p.table, [row]);
      journal.push({ op: "insert", table: p.table, id: p.id, row: {} });
    }
    for (const p of plan) {
      if (p.op !== "update") continue;
      await updateColumns(tx, userId, p.table, p.id, p.after);
      journal.push(p);
    }
    const doomed = new Map<TableName, string[]>();
    for (const p of plan) if (p.op === "delete") doomed.set(p.table, [...(doomed.get(p.table) ?? []), p.id]);
    for (const [table, ids] of doomed) {
      const rows = await fullRows(tx, userId, table, ids);
      // Gone already (the web app deleted it first)? Then there is nothing to undo.
      for (const id of ids) {
        const row = rows.get(id);
        if (row) journal.push({ op: "delete", table, id, row: imageOf(row) });
      }
      await deleteKeys(tx, userId, table, ids);
    }
    // Authoritative "after" images: what the database holds now, not what we meant.
    const touched = new Map<TableName, string[]>();
    for (const e of journal) if (e.op !== "delete") touched.set(e.table, [...(touched.get(e.table) ?? []), e.id]);
    for (const [table, ids] of touched) {
      const rows = await fullRows(tx, userId, table, ids, ownedColumns(table));
      for (const e of journal) {
        if (e.table !== table || e.op === "delete") continue;
        const row = rows.get(e.id);
        if (!row) continue;
        const image = imageOf(row);
        if (e.op === "insert") e.row = image;
        else e.after = Object.fromEntries(Object.keys(e.after).map((k) => [k, image[k]]));
      }
    }
    await tx.unsafe(
      `INSERT INTO "mcp_changes" (id, user_id, client_id, tool, summary, changes) VALUES ($1, $2, $3, $4, $5, $6)`,
      [changeId, userId, meta.clientId, meta.tool, meta.summary.slice(0, 300), journal as never],
    );
    await tx.unsafe(
      `DELETE FROM "mcp_changes" WHERE user_id = $1 AND (
         created_at < now() - make_interval(days => $2::int)
         OR id NOT IN (SELECT id FROM "mcp_changes" WHERE user_id = $1 ORDER BY created_at DESC LIMIT $3)
       )`,
      [userId, JOURNAL_DAYS, JOURNAL_KEEP],
    );
  });
  result.changeId = changeId;
  return result;
}

// ── Undo ──────────────────────────────────────────────────────────────────

export type ChangeSummary = {
  id: string;
  tool: string;
  summary: string;
  at: string;
  undone: boolean;
  client: string;
};

export async function listChanges(sql: Sql, userId: string, limit: number): Promise<ChangeSummary[]> {
  const rows = (await sql.unsafe(
    `SELECT id, tool, summary, client_id, created_at, undone_at FROM "mcp_changes"
     WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  )) as unknown as Row[];
  return rows.map((r) => ({
    id: r.id as string,
    tool: r.tool as string,
    summary: r.summary as string,
    at: new Date(r.created_at as string | Date).toISOString(),
    undone: r.undone_at != null,
    client: (r.client_id as string | null) ?? "",
  }));
}

export class UndoRefused extends Error {
  readonly details?: Record<string, unknown>;
  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "UndoRefused";
    this.details = details;
  }
}

/**
 * Put back what one change took. Refused — never forced — if anything it touched
 * has changed since, because undoing over someone's later edit would destroy it.
 * Changes undo newest-first for the same reason.
 */
export async function undoChange(
  sql: Sql,
  userId: string,
  changeId: string | undefined,
): Promise<{ id: string; summary: string; restored: number }> {
  return beginOf(sql)(async (tx) => {
    const rows = (await tx.unsafe(
      changeId
        ? `SELECT id, summary, changes, undone_at FROM "mcp_changes" WHERE user_id = $1 AND id = $2 FOR UPDATE`
        : `SELECT id, summary, changes, undone_at FROM "mcp_changes" WHERE user_id = $1 AND undone_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      (changeId ? [userId, changeId] : [userId]) as never[],
    )) as unknown as Row[];
    const row = rows[0];
    if (!row) throw new UndoRefused(changeId ? "No such change." : "There is nothing to undo.");
    if (row.undone_at != null) throw new UndoRefused("That change was already undone.");
    const id = row.id as string;
    const journal = jsonColumn<ChangeEntry[]>(row.changes) ?? [];

    // A later, still-standing change that touches the same rows has to go first.
    const newer = (await tx.unsafe(
      `SELECT id, summary, changes FROM "mcp_changes"
       WHERE user_id = $1 AND undone_at IS NULL AND created_at > (SELECT created_at FROM "mcp_changes" WHERE id = $2)`,
      [userId, id],
    )) as unknown as Row[];
    const mine = new Set(journal.map((e) => `${e.table}:${e.id}`));
    for (const n of newer) {
      const theirs = jsonColumn<ChangeEntry[]>(n.changes) ?? [];
      if (theirs.some((e) => mine.has(`${e.table}:${e.id}`))) {
        throw new UndoRefused(
          `A later change touched the same things: "${String(n.summary)}". Undo that one first.`,
          { change_id: n.id },
        );
      }
    }

    const byTable = new Map<TableName, string[]>();
    for (const e of journal) byTable.set(e.table, [...(byTable.get(e.table) ?? []), e.id]);
    const current = new Map<string, Map<string, Row>>();
    for (const [table, ids] of byTable) {
      current.set(table, await fullRows(tx, userId, table, ids, ownedColumns(table)));
    }

    // Verify first, apply second: all or nothing.
    for (const e of journal) {
      const live = current.get(e.table)?.get(e.id);
      if (e.op === "insert") {
        if (!live || stable(pick(live, Object.keys(e.row))) !== stable(e.row)) {
          throw new UndoRefused("Something that change created has since been edited or removed, so it can't be undone cleanly.", { table: e.table, id: e.id });
        }
      } else if (e.op === "update") {
        if (!live || stable(pick(live, Object.keys(e.after))) !== stable(e.after)) {
          throw new UndoRefused("Something that change edited has been changed again since, so it can't be undone cleanly.", { table: e.table, id: e.id });
        }
      } else if (live) {
        throw new UndoRefused("Something that change removed has been recreated since, so it can't be restored.", { table: e.table, id: e.id });
      }
    }
    let restored = 0;
    for (const e of journal) {
      if (e.op === "update") await updateColumns(tx, userId, e.table, e.id, e.before);
      else if (e.op === "insert") await deleteKeys(tx, userId, e.table, [e.id]);
      else await upsertRows(tx, userId, e.table, [{ ...e.row, user_id: userId, series_date: dateOnly(e.row.series_date) ?? null }]);
      restored += 1;
    }
    await tx.unsafe(`UPDATE "mcp_changes" SET undone_at = now() WHERE id = $1 AND user_id = $2`, [id, userId]);
    return { id, summary: row.summary as string, restored };
  });
}

function pick(row: Row, keys: string[]): Row {
  return Object.fromEntries(keys.map((k) => [k, row[k]]));
}

/** Drop a user's journal (used when their data is wiped or replaced). */
export async function clearJournal(sql: Sql, userId: string): Promise<void> {
  await sql.unsafe(`DELETE FROM "mcp_changes" WHERE user_id = $1`, [userId]);
}
