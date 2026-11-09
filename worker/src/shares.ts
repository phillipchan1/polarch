import type { Session, TrackedMeeting } from "../../src/types.ts";
import { resolveOccurrence } from "../../src/lib/occurrenceGuard.ts";
import type { Sql } from "./db.ts";

/**
 * Shared meetings.
 *
 * The owner shares one meeting — never a team, never the workspace — with
 * someone by email, and gets back a link that carries a token. Whoever holds
 * the link sees that meeting's agenda and can add to it. Nothing else.
 *
 * ── Why a separate module and not a filter on /api/data ───────────────────
 * The guest path is written against an explicit list of fields, selected by
 * name. A private column (health, prayer, assessments, my notes, a locked
 * topic) is never selected here, so no client bug and no future column can
 * leak through it. Adding something to the shared page means adding it here,
 * on purpose.
 *
 * Writes from the guest land in the owner's own tables (a topic they raised,
 * the occurrence it booked) or in rows only they write (their takeaway, their
 * part of the shared notes). The owner's client picks them up through its
 * ordinary three-way refresh.
 */

export type Row = Record<string, unknown>;

export class ShareError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_MEMBERS_PER_MEETING = 50;
const MAX_GUEST_TOPICS_PER_DAY = 40;
const MAX_TOPIC_CHARS = 500;
const MAX_TAKEAWAY_CHARS = 1000;
const MAX_NOTE_CHARS = 20_000;
/** Done follow-ups stay on the shared page this long, so a tick is seen. */
const DONE_VISIBLE_DAYS = 21;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;

export function todayUTC(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function addDaysISO(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 32 random bytes, base64url. The token *is* the key to the shared page. */
export function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function isToken(value: string): boolean {
  return TOKEN_RE.test(value);
}

function iso(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function parseJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// ── Owner ─────────────────────────────────────────────────────────────────

export type ShareOut = {
  id: string;
  meetingId: string;
  email: string;
  name?: string;
  personId?: string;
  token: string;
  invitedOn: string;
  joinedOn?: string;
  lastSeenOn?: string;
};

function shareOut(r: Row): ShareOut {
  return {
    id: r.id as string,
    meetingId: r.meeting_id as string,
    email: r.email as string,
    name: (r.name as string | null) ?? undefined,
    personId: (r.person_id as string | null) ?? undefined,
    token: r.token as string,
    invitedOn: iso(r.invited_on) ?? "",
    joinedOn: iso(r.joined_on),
    lastSeenOn: iso(r.last_seen_on),
  };
}

export async function listShares(sql: Sql, userId: string): Promise<ShareOut[]> {
  const rows = await sql.unsafe(
    `SELECT id, meeting_id, email, name, person_id, token, invited_on, joined_on, last_seen_on
       FROM meeting_members
      WHERE user_id = $1 AND revoked_on IS NULL
      ORDER BY invited_on`,
    [userId],
  );
  return (rows as unknown as Row[]).map(shareOut);
}

export async function createShare(
  sql: Sql,
  userId: string,
  input: { meetingId?: unknown; email?: unknown; name?: unknown; personId?: unknown },
): Promise<ShareOut> {
  const meetingId = typeof input.meetingId === "string" ? input.meetingId.trim() : "";
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const name =
    typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 80) : null;
  const personId =
    typeof input.personId === "string" && input.personId.trim() ? input.personId.trim() : null;
  if (!meetingId) throw new ShareError(400, "meetingId is required");
  if (!EMAIL_RE.test(email) || email.length > 254) throw new ShareError(400, "a valid email is required");

  const meeting = await sql.unsafe(
    `SELECT id FROM meetings WHERE user_id = $1 AND id = $2 LIMIT 1`,
    [userId, meetingId],
  );
  if (!meeting.length) throw new ShareError(404, "meeting not found");

  const existing = (await sql.unsafe(
    `SELECT id, revoked_on FROM meeting_members
      WHERE user_id = $1 AND meeting_id = $2 AND lower(email) = $3
      LIMIT 1`,
    [userId, meetingId, email],
  )) as unknown as Row[];

  if (existing[0]) {
    // Re-inviting someone whose access was revoked gets a fresh link: the old
    // one stays dead.
    const rows = await sql.unsafe(
      `UPDATE meeting_members
          SET name = COALESCE($3, name),
              person_id = COALESCE($4, person_id),
              token = CASE WHEN revoked_on IS NULL THEN token ELSE $5 END,
              invited_on = CASE WHEN revoked_on IS NULL THEN invited_on ELSE now() END,
              revoked_on = NULL
        WHERE user_id = $1 AND id = $2
        RETURNING id, meeting_id, email, name, person_id, token, invited_on, joined_on, last_seen_on`,
      [userId, existing[0].id as string, name, personId, newToken()],
    );
    return shareOut((rows as unknown as Row[])[0]);
  }

  const count = (await sql.unsafe(
    `SELECT count(*)::int AS n FROM meeting_members
      WHERE user_id = $1 AND meeting_id = $2 AND revoked_on IS NULL`,
    [userId, meetingId],
  )) as unknown as { n: number }[];
  if ((count[0]?.n ?? 0) >= MAX_MEMBERS_PER_MEETING) {
    throw new ShareError(400, "this meeting is shared with as many people as it can be");
  }

  const rows = await sql.unsafe(
    `INSERT INTO meeting_members (id, user_id, meeting_id, email, name, person_id, token)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, meeting_id, email, name, person_id, token, invited_on, joined_on, last_seen_on`,
    [crypto.randomUUID(), userId, meetingId, email, name, personId, newToken()],
  );
  return shareOut((rows as unknown as Row[])[0]);
}

/**
 * Revoke rather than delete: their name still has to label what they raised.
 * The token is rotated so the link they hold stops working at once.
 */
export async function revokeShare(sql: Sql, userId: string, id: string): Promise<boolean> {
  const rows = await sql.unsafe(
    `UPDATE meeting_members
        SET revoked_on = now(), token = $3
      WHERE user_id = $1 AND id = $2 AND revoked_on IS NULL
      RETURNING id`,
    [userId, id, `revoked_${newToken()}`],
  );
  return rows.length > 0;
}

/** Meetings shared with this email, for their own workspace's sidebar. */
export async function sharedWithMe(
  sql: Sql,
  email: string | null | undefined,
): Promise<{ token: string; meetingName: string; ownerName: string }[]> {
  const e = email?.trim().toLowerCase();
  if (!e) return [];
  const rows = (await sql.unsafe(
    `SELECT mm.token, m.name AS meeting_name, m.subject_kind, p.name AS owner_name,
            t.name AS team_name
       FROM meeting_members mm
       JOIN meetings m ON m.user_id = mm.user_id AND m.id = mm.meeting_id
       LEFT JOIN profiles p ON p.user_id = mm.user_id
       LEFT JOIN teams t ON m.subject_kind = 'team' AND t.user_id = m.user_id AND t.id = m.subject_id
      WHERE lower(mm.email) = $1 AND mm.revoked_on IS NULL
      ORDER BY mm.invited_on`,
    [e],
  )) as unknown as Row[];
  return rows.map((r) => {
    const owner = (r.owner_name as string | null)?.trim() || "your leader";
    const named = (r.meeting_name as string | null)?.trim();
    const meetingName =
      named || (r.subject_kind === "team" ? ((r.team_name as string | null) ?? "Team meeting") : `1:1 with ${owner}`);
    return { token: r.token as string, meetingName, ownerName: owner };
  });
}

// ── Guest ─────────────────────────────────────────────────────────────────

export type Member = {
  id: string;
  ownerId: string;
  meetingId: string;
  email: string;
  name?: string;
};

export async function memberByToken(sql: Sql, token: string): Promise<Member | null> {
  if (!isToken(token)) return null;
  const rows = (await sql.unsafe(
    `SELECT id, user_id, meeting_id, email, name FROM meeting_members
      WHERE token = $1 AND revoked_on IS NULL LIMIT 1`,
    [token],
  )) as unknown as Row[];
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id as string,
    ownerId: String(r.user_id),
    meetingId: r.meeting_id as string,
    email: r.email as string,
    name: (r.name as string | null) ?? undefined,
  };
}

type CurriculumSlot = { id: string; label: string; tagId?: string; minutes?: number };

function parseCurriculum(v: unknown): CurriculumSlot[] {
  const raw = parseJson(v);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object")
    .map((x) => ({
      id: String(x.id ?? ""),
      label: String(x.label ?? ""),
      tagId: typeof x.tagId === "string" ? x.tagId : undefined,
      minutes: typeof x.minutes === "number" ? x.minutes : undefined,
    }))
    .filter((x) => x.id);
}

async function meetingRow(sql: Sql, m: Member): Promise<Row> {
  const rows = (await sql.unsafe(
    `SELECT id, name, subject_kind, subject_id, rhythm, floor_days, next_date,
            anchor_weekday, curriculum
       FROM meetings WHERE user_id = $1 AND id = $2 LIMIT 1`,
    [m.ownerId, m.meetingId],
  )) as unknown as Row[];
  if (!rows[0]) throw new ShareError(404, "this meeting no longer exists");
  return rows[0];
}

/**
 * Everything the shared page shows, and nothing else. Read this function as
 * the definition of "the room" in docs/arcs-and-sharing.md.
 */
export async function loadShared(sql: Sql, m: Member, now = new Date()): Promise<Row> {
  const today = todayUTC(now);
  const meeting = await meetingRow(sql, m);
  const owner = m.ownerId;

  const subjectTable =
    meeting.subject_kind === "team" ? "teams" : meeting.subject_kind === "manager" ? "managers" : "people";
  const [profile, subject, members, sessions, topics, followUps, arcs, takeaways, notes] =
    await Promise.all([
      sql.unsafe(`SELECT name FROM profiles WHERE user_id = $1 LIMIT 1`, [owner]),
      sql.unsafe(`SELECT name FROM ${subjectTable} WHERE user_id = $1 AND id = $2 LIMIT 1`, [
        owner,
        meeting.subject_id as string,
      ]),
      sql.unsafe(
        `SELECT id, name, email FROM meeting_members
          WHERE user_id = $1 AND meeting_id = $2 AND revoked_on IS NULL ORDER BY invited_on`,
        [owner, m.meetingId],
      ),
      sql.unsafe(
        `SELECT id, date, series_date, occurrence_kind, next_date
           FROM one_on_ones WHERE user_id = $1 AND meeting_id = $2 ORDER BY date`,
        [owner, m.meetingId],
      ),
      // Placing is sharing: topics on a week, never one the owner locked. Of
      // the ideas tray, only what was shared on purpose — the guest's own
      // ideas, and the owner's they chose to share — and only while open.
      sql.unsafe(
        `SELECT id, text, slot_id, session_id, status, raised_by, sort_order, created_on
           FROM topics
          WHERE user_id = $1 AND meeting_id = $2 AND is_private = false
            AND (
              (session_id IS NOT NULL AND status <> 'dropped')
              OR (session_id IS NULL AND status = 'open' AND (is_shared OR raised_by IS NOT NULL))
            )
          ORDER BY sort_order`,
        [owner, m.meetingId],
      ),
      sql.unsafe(
        `SELECT id, text, status, owner, opened_on, closed_on, source_session_id, sort_order
           FROM follow_ups
          WHERE user_id = $1 AND meeting_id = $2 AND is_private = false
            AND (status = 'open' OR closed_on >= $3)
          ORDER BY sort_order`,
        [owner, m.meetingId, addDaysISO(today, -DONE_VISIBLE_DAYS)],
      ),
      sql.unsafe(
        `SELECT id, title, author, cover, cover_url, slot_id, pace_every, starts_on, status, steps,
                passed_in, created_on, closed_on, sort_order
           FROM arcs WHERE user_id = $1 AND meeting_id = $2 AND status <> 'paused'
          ORDER BY sort_order`,
        [owner, m.meetingId],
      ),
      sql.unsafe(
        `SELECT t.id, t.arc_id, t.step_id, t.by_member, t.text, t.taken_on
           FROM arc_takeaways t
           JOIN arcs a ON a.user_id = t.user_id AND a.id = t.arc_id
          WHERE t.user_id = $1 AND a.meeting_id = $2`,
        [owner, m.meetingId],
      ),
      sql.unsafe(
        `SELECT id, session_id, by_member, body, updated_on
           FROM shared_notes WHERE user_id = $1 AND meeting_id = $2`,
        [owner, m.meetingId],
      ),
    ]);

  // A guest's own visit is the only thing this path ever records about them.
  await sql.unsafe(
    `UPDATE meeting_members SET last_seen_on = now(), joined_on = COALESCE(joined_on, now())
      WHERE id = $1`,
    [m.id],
  );

  const curriculum = parseCurriculum(meeting.curriculum);
  return {
    me: { id: m.id, name: m.name ?? m.email.split("@")[0] },
    owner: { name: ((profile as unknown as Row[])[0]?.name as string | undefined) ?? "" },
    meeting: {
      id: meeting.id,
      name: meeting.name ?? undefined,
      subjectKind: meeting.subject_kind,
      subjectId: meeting.subject_id,
      subjectName: ((subject as unknown as Row[])[0]?.name as string | undefined) ?? "",
      rhythm: meeting.rhythm ?? "as_needed",
      floorDays: meeting.floor_days ?? undefined,
      nextDate: meeting.next_date ?? undefined,
      anchorWeekday: meeting.anchor_weekday ?? undefined,
      // Labels and minutes only — tag ids are workspace vocabulary.
      curriculum: curriculum.map(({ id, label, minutes }) => ({ id, label, minutes })),
    },
    members: (members as unknown as Row[]).map((r) => ({
      id: r.id,
      name: (r.name as string | null) ?? String(r.email).split("@")[0],
    })),
    sessions: (sessions as unknown as Row[]).map((r) => ({
      id: r.id,
      meetingId: m.meetingId,
      date: r.date,
      seriesDate: iso(r.series_date)?.slice(0, 10),
      kind: r.occurrence_kind ?? undefined,
      nextDate: r.next_date ?? undefined,
    })),
    topics: (topics as unknown as Row[]).map((r) => ({
      id: r.id,
      meetingId: m.meetingId,
      text: r.text,
      slotId: r.slot_id ?? undefined,
      sessionId: r.session_id ?? undefined,
      status: r.status,
      raisedBy: r.raised_by ?? undefined,
      order: r.sort_order ?? 0,
      createdOn: r.created_on ?? "",
      tagIds: [],
      lane: "backlog",
      carried: 0,
      carriedFrom: [],
    })),
    followUps: (followUps as unknown as Row[]).map((r) => ({
      id: r.id,
      text: r.text,
      status: r.status,
      owner: r.owner ?? undefined,
      openedOn: r.opened_on ?? "",
      closedOn: r.closed_on ?? undefined,
      sourceSessionId: r.source_session_id ?? undefined,
    })),
    arcs: (arcs as unknown as Row[]).map((r) => ({
      id: r.id,
      meetingId: m.meetingId,
      title: r.title,
      author: r.author ?? undefined,
      cover: r.cover ?? undefined,
      coverUrl: r.cover_url ?? undefined,
      slotId: r.slot_id ?? undefined,
      every: r.pace_every ?? 1,
      startsOn: r.starts_on,
      status: r.status,
      steps: Array.isArray(parseJson(r.steps)) ? parseJson(r.steps) : [],
      passedIn: strArray(r.passed_in),
      createdOn: r.created_on ?? "",
      closedOn: r.closed_on ?? undefined,
      order: r.sort_order ?? 0,
    })),
    takeaways: (takeaways as unknown as Row[]).map((r) => ({
      id: r.id,
      arcId: r.arc_id,
      stepId: r.step_id,
      by: r.by_member,
      text: r.text,
      on: r.taken_on ?? "",
    })),
    sharedNotes: (notes as unknown as Row[]).map((r) => ({
      id: r.id,
      meetingId: m.meetingId,
      sessionId: r.session_id,
      by: r.by_member,
      body: r.body,
      updatedOn: r.updated_on ?? "",
    })),
    today,
  };
}

/**
 * The guest adds something to an occurrence. The first thing put into a
 * projected week books it — the same rule the owner's planner follows. With
 * no date it's an idea for later: it lands in the owner's tray, still theirs.
 */
export async function guestAddTopic(
  sql: Sql,
  m: Member,
  input: { text?: unknown; date?: unknown; slotId?: unknown },
  now = new Date(),
  opts?: { guard?: boolean },
): Promise<{ id: string; sessionId: string | null }> {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  const date = typeof input.date === "string" ? input.date : "";
  const later = input.date === undefined || input.date === null || date === "";
  if (!text) throw new ShareError(400, "say what you'd like to raise");
  if (text.length > MAX_TOPIC_CHARS) throw new ShareError(400, "that's a bit long for an agenda item");
  if (!later && !ISO_DATE_RE.test(date)) throw new ShareError(400, "pick a meeting");
  const today = todayUTC(now);
  if (!later && (date < addDaysISO(today, -1) || date > addDaysISO(today, 400))) {
    throw new ShareError(400, "pick an upcoming meeting");
  }

  const meeting = await meetingRow(sql, m);
  const slots = parseCurriculum(meeting.curriculum);
  const slot =
    typeof input.slotId === "string" ? slots.find((s) => s.id === input.slotId) : undefined;

  const raised = (await sql.unsafe(
    `SELECT count(*)::int AS n FROM topics
      WHERE user_id = $1 AND raised_by = $2 AND created_on = $3`,
    [m.ownerId, m.id, today],
  )) as unknown as { n: number }[];
  if ((raised[0]?.n ?? 0) >= MAX_GUEST_TOPICS_PER_DAY) {
    throw new ShareError(429, "that's a lot for one day — try again tomorrow");
  }

  const sessionId = later ? null : await bookedOn(sql, m, meeting, date, today, opts?.guard === true);

  const order = (await sql.unsafe(
    `SELECT COALESCE(max(sort_order), -1)::int + 1 AS n FROM topics WHERE user_id = $1 AND meeting_id = $2`,
    [m.ownerId, m.meetingId],
  )) as unknown as { n: number }[];
  const id = crypto.randomUUID();
  await sql.unsafe(
    `INSERT INTO topics (user_id, id, meeting_id, text, tag_ids, status, lane, session_id,
                         carried, carried_from, created_on, sort_order, slot_id, is_private, raised_by)
     VALUES ($1, $2, $3, $4, $5::text[], 'open', 'backlog', $6, 0, '{}', $7, $8, $9, false, $10)`,
    [
      m.ownerId,
      id,
      m.meetingId,
      text,
      slot?.tagId ? [slot.tagId] : [],
      sessionId,
      today,
      order[0]?.n ?? 0,
      slot?.id ?? null,
      m.id,
    ],
  );
  return { id, sessionId };
}

/** The occurrence on that date, booking it if it was only projected. */
async function bookedOn(
  sql: Sql,
  m: Member,
  meeting: Row,
  date: string,
  today: string,
  guard: boolean,
): Promise<string> {
  const onDay = (await sql.unsafe(
    `SELECT id, occurrence_kind FROM one_on_ones
      WHERE user_id = $1 AND meeting_id = $2 AND (date = $3 OR series_date = $3::date)`,
    [m.ownerId, m.meetingId, date],
  )) as unknown as Row[];
  const held = onDay.find((r) => r.occurrence_kind !== "skipped");
  if (held) return held.id as string;
  if (onDay.some((r) => r.occurrence_kind === "skipped")) {
    throw new ShareError(409, "that week is skipped");
  }
  if (guard) {
    const rows = (await sql.unsafe(
      `SELECT id, date, series_date, occurrence_kind FROM one_on_ones
        WHERE user_id = $1 AND meeting_id = $2`,
      [m.ownerId, m.meetingId],
    )) as unknown as Row[];
    const dayOf = (v: unknown): string =>
      v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
    const sessions: Session[] = rows.map((r) => ({
      id: r.id as string,
      meetingId: m.meetingId,
      date: dayOf(r.date),
      seriesDate: r.series_date ? dayOf(r.series_date) : undefined,
      kind: (r.occurrence_kind as Session["kind"] | null) ?? undefined,
    }));
    const tracked: TrackedMeeting = {
      id: m.meetingId,
      subjectKind: (meeting.subject_kind as TrackedMeeting["subjectKind"]) ?? "person",
      subjectId: (meeting.subject_id as string) ?? "",
      rhythm: (meeting.rhythm as TrackedMeeting["rhythm"]) ?? "weekly",
      floorDays: (meeting.floor_days as number | null) ?? undefined,
      nextDate: meeting.next_date ? String(meeting.next_date).slice(0, 10) : undefined,
      anchorWeekday: (meeting.anchor_weekday as number | null) ?? undefined,
    };
    const plan = resolveOccurrence({
      meeting: tracked,
      sessions,
      date,
      today,
      guard: true,
    });
    if (plan.reuseId) return plan.reuseId;
    date = plan.date;
    const snapped = (await sql.unsafe(
      `SELECT id, occurrence_kind FROM one_on_ones
        WHERE user_id = $1 AND meeting_id = $2 AND (date = $3 OR series_date = $3::date)`,
      [m.ownerId, m.meetingId, date],
    )) as unknown as Row[];
    const live = snapped.find((r) => r.occurrence_kind !== "skipped");
    if (live) return live.id as string;
    if (snapped.some((r) => r.occurrence_kind === "skipped")) {
      throw new ShareError(409, "that week is skipped");
    }
  }
  const sessionId = crypto.randomUUID();
  await sql.unsafe(
    `INSERT INTO one_on_ones (user_id, id, person_id, meeting_id, date)
     VALUES ($1, $2, $3, $4, $5)`,
    [m.ownerId, sessionId, meeting.subject_id as string, m.meetingId, date],
  );
  return sessionId;
}

/** Only the guest's own topics can be taken back, and only while still open. */
export async function guestRemoveTopic(sql: Sql, m: Member, topicId: string): Promise<void> {
  const rows = await sql.unsafe(
    `DELETE FROM topics
      WHERE user_id = $1 AND meeting_id = $2 AND id = $3 AND raised_by = $4 AND status = 'open'
      RETURNING id`,
    [m.ownerId, m.meetingId, topicId, m.id],
  );
  if (!rows.length) throw new ShareError(404, "nothing to remove");
}

/** Tick off what's theirs or ours. What the owner owes stays the owner's to tick. */
export async function guestSetFollowUp(
  sql: Sql,
  m: Member,
  followUpId: string,
  done: unknown,
  now = new Date(),
): Promise<void> {
  const isDone = done === true;
  const rows = await sql.unsafe(
    `UPDATE follow_ups
        SET status = $5, closed_on = $6
      WHERE user_id = $1 AND meeting_id = $2 AND id = $3
        AND is_private = false AND owner IN ($4, 'both')
      RETURNING id`,
    [m.ownerId, m.meetingId, followUpId, m.id, isDone ? "done" : "open", isDone ? todayUTC(now) : null],
  );
  if (!rows.length) throw new ShareError(403, "that one isn't yours to tick");
}

export async function guestSetTakeaway(
  sql: Sql,
  m: Member,
  stepId: string,
  input: { text?: unknown },
  now = new Date(),
): Promise<void> {
  const text = typeof input.text === "string" ? input.text : "";
  if (text.length > MAX_TAKEAWAY_CHARS) throw new ShareError(400, "keep it to a line or two");
  const arcs = (await sql.unsafe(
    `SELECT id, steps FROM arcs WHERE user_id = $1 AND meeting_id = $2 AND status <> 'paused'`,
    [m.ownerId, m.meetingId],
  )) as unknown as Row[];
  const arc = arcs.find((a) => {
    const steps = parseJson(a.steps);
    return Array.isArray(steps) && steps.some((s) => s && (s as Row).id === stepId);
  });
  if (!arc) throw new ShareError(404, "no such step");
  const id = `${stepId}:${m.id}`;
  if (!text.trim()) {
    await sql.unsafe(`DELETE FROM arc_takeaways WHERE user_id = $1 AND id = $2`, [m.ownerId, id]);
    return;
  }
  await sql.unsafe(
    `INSERT INTO arc_takeaways (user_id, id, arc_id, step_id, by_member, text, taken_on)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, id) DO UPDATE SET text = EXCLUDED.text, taken_on = EXCLUDED.taken_on`,
    [m.ownerId, id, arc.id as string, stepId, m.id, text, todayUTC(now)],
  );
}

export async function guestSetNote(
  sql: Sql,
  m: Member,
  sessionId: string,
  input: { body?: unknown },
  now = new Date(),
): Promise<void> {
  const body = typeof input.body === "string" ? input.body : "";
  if (body.length > MAX_NOTE_CHARS) throw new ShareError(400, "that note is too long");
  const session = await sql.unsafe(
    `SELECT id FROM one_on_ones WHERE user_id = $1 AND meeting_id = $2 AND id = $3 LIMIT 1`,
    [m.ownerId, m.meetingId, sessionId],
  );
  if (!session.length) throw new ShareError(404, "no such meeting");
  const id = `${sessionId}:${m.id}`;
  if (!body.trim()) {
    await sql.unsafe(`DELETE FROM shared_notes WHERE user_id = $1 AND id = $2`, [m.ownerId, id]);
    return;
  }
  await sql.unsafe(
    `INSERT INTO shared_notes (user_id, id, meeting_id, session_id, by_member, body, updated_on)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, id) DO UPDATE SET body = EXCLUDED.body, updated_on = EXCLUDED.updated_on`,
    [m.ownerId, id, m.meetingId, sessionId, m.id, body, todayUTC(now)],
  );
}
