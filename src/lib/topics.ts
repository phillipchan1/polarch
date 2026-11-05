/**
 * Topics — what there is to talk about, and which meeting it lands in.
 *
 * Deliberately separate from `readiness.ts`, which answers "am I prepared for
 * the next one". This file answers the question before that: *what are we
 * actually going to cover, and when*. Readiness reads the answer; it doesn't
 * produce it.
 *
 * ── Why slots and not columns ─────────────────────────────────────────────
 * The old board had one queue column, `this_1on1`, which could only ever mean
 * "the next one". That queues, it doesn't plan. A planner needs to say budget
 * on the 17th and hiring on the 24th, so the columns *are* the occurrences —
 * real sessions where they exist, projected from the rhythm where they don't.
 *
 * ── Why a projected slot isn't a session yet ──────────────────────────────
 * Materializing three months of empty sessions the moment you open a board
 * would fill the history with meetings that never happened and hand readiness
 * a booking you never made. So a projection stays a projection until you drop
 * something on it — the act of planning is what makes the occurrence real.
 *
 * ── Loose is derived, never stored ────────────────────────────────────────
 * A topic is loose when it's still open and the occurrence it sits in has
 * already passed. That's the failure this whole feature exists to prevent — a
 * subject assigned to a meeting and quietly never finished — and it's one
 * comparison against today, so storing it would only be a second copy that
 * goes stale overnight, every night.
 */
import type {
  CurriculumSlot,
  MeetingSubjectKind,
  Session,
  Topic,
  TopicLane,
  TrackedMeeting,
} from "../types";
import { addDays, daysBetween, sessionsFor, todayISO, projectFromLast, explicitNextDate, weekdayUTC, CADENCE_DAYS, heldSessions, lastRhythmDate, nextOpenRhythmDate, takenSeriesDates } from "./readiness.ts";

/** How far the planner looks by default — a quarter of weekly meetings, not three weeks. */
export const SLOTS_AHEAD = 8;

export type Horizon = 4 | 8 | 12 | "all";
export const HORIZON_DEFAULT: Horizon = 8;

export function aheadForHorizon(horizon: Horizon): number {
  return horizon === "all" ? 26 : horizon;
}

/**
 * Standing skeleton offered when a meeting is created. Empty on purpose —
 * Check-in / Work / Develop is a 1:1 shape, Prayer / Training / Discussion
 * is a staff-meeting shape, and neither belongs to "who this is with".
 * Set the slots on the meeting, the way a named gathering does.
 */
export function defaultCurriculum(_kind?: MeetingSubjectKind): CurriculumSlot[] {
  return [];
}

export function curriculumOf(meeting: TrackedMeeting): CurriculumSlot[] {
  return meeting.curriculum ?? [];
}

/**
 * The planner row a topic sits in: its own slot when that slot still exists,
 * otherwise the first row whose tag it carries — so `#prayer` typed anywhere
 * lands in the Prayer row without being dragged there.
 */
export function effectiveSlotId(
  topic: Topic,
  curriculum: CurriculumSlot[]
): string | undefined {
  if (topic.slotId && curriculum.some((c) => c.id === topic.slotId)) {
    return topic.slotId;
  }
  return curriculum.find((c) => c.tagId && topic.tagIds?.includes(c.tagId))?.id;
}

export function slotLabelOf(
  curriculum: CurriculumSlot[],
  slotId?: string
): string | undefined {
  if (!slotId) return undefined;
  return curriculum.find((s) => s.id === slotId)?.label;
}

const SLOT_CHIP = [
  "bg-tag1-soft text-tag1-ink",
  "bg-tag2-soft text-tag2-ink",
  "bg-tag3-soft text-tag3-ink",
  "bg-tag4-soft text-tag4-ink",
  "bg-tag5-soft text-tag5-ink",
  "bg-tag6-soft text-tag6-ink",
] as const;

const SLOT_DOT = [
  "bg-tag1",
  "bg-tag2",
  "bg-tag3",
  "bg-tag4",
  "bg-tag5",
  "bg-tag6",
] as const;

/**
 * Which of the six tag colours a section wears.
 *
 * A section that carries a tag wears that tag's colour, so Prayer is the same
 * colour on the board, in the agenda and on the Ideas page. It used to be the
 * section's position in the list, which painted Prayer green in the staff
 * meeting and blue everywhere else. Untagged sections fall back to position.
 */
export function slotTone(
  curriculum: CurriculumSlot[],
  slotId?: string,
  tags?: { id: string; color: number }[]
): number {
  const i = curriculum.findIndex((s) => s.id === slotId);
  const tagId = i >= 0 ? curriculum[i].tagId : undefined;
  const tag = tagId ? tags?.find((t) => t.id === tagId) : undefined;
  if (tag) return tag.color % SLOT_DOT.length;
  return (i < 0 ? 0 : i) % SLOT_DOT.length;
}

export function slotChipClass(
  curriculum: CurriculumSlot[],
  slotId?: string,
  tags?: { id: string; color: number }[]
): string {
  return SLOT_CHIP[slotTone(curriculum, slotId, tags)];
}

export function slotDotClass(
  curriculum: CurriculumSlot[],
  slotId?: string,
  tags?: { id: string; color: number }[]
): string {
  return SLOT_DOT[slotTone(curriculum, slotId, tags)];
}

/** One occurrence on the planner — a real session, or a date we expect. */
export type Slot = {
  /** Null while it's still a projection nobody has planned into. */
  sessionId: string | null;
  date: string;
  /** True when the date came from the rhythm rather than a booking. */
  projected: boolean;
  /** It has already happened. Anything still open in here is loose. */
  past: boolean;
};

/**
 * Drop target for the drag engine and the "Move to…" select. Keys are strings
 * so they survive a round trip through `<select value>`.
 *
 * A `#slotId` suffix names the skeleton cell inside a week or the tagged
 * group inside the bucket. No suffix means untagged (or a meeting with no
 * curriculum).
 */
export type ColumnTarget =
  | { kind: "lane"; lane: TopicLane; slotId?: string }
  | { kind: "session"; sessionId: string; slotId?: string }
  | { kind: "projected"; date: string; slotId?: string };

export type BucketGroup = {
  key: string;
  label: string;
  lane: TopicLane;
  slotId?: string;
  topics: Topic[];
};

export type WeekCell = {
  key: string;
  slotId?: string;
  label: string;
  topics: Topic[];
};

export type WeekColumn = {
  key: string;
  label: string;
  /** "One-off", "Moved from Mon" — this column isn't the plain rhythm. */
  exception?: string;
  hint?: string;
  slot: Slot;
  cells: WeekCell[];
  topics: Topic[];
};

export type BoardLayout = {
  bucket: BucketGroup[];
  weeks: WeekColumn[];
};

export type SlotBalance = {
  slot: CurriculumSlot;
  filled: number;
  total: number;
};

// ── Keys ──────────────────────────────────────────────────────────────────

export function slotKey(slot: Slot): string {
  return slot.sessionId ? `s:${slot.sessionId}` : `p:${slot.date}`;
}

export function cellKey(occurrenceKey: string, slotId?: string): string {
  return slotId ? `${occurrenceKey}#${slotId}` : occurrenceKey;
}

export function parseColumnKey(key: string): ColumnTarget {
  const hash = key.indexOf("#");
  const base = hash >= 0 ? key.slice(0, hash) : key;
  const slotId = hash >= 0 ? key.slice(hash + 1) || undefined : undefined;

  if (base.startsWith("s:")) {
    return { kind: "session", sessionId: base.slice(2), slotId };
  }
  if (base.startsWith("p:")) {
    return { kind: "projected", date: base.slice(2), slotId };
  }
  return {
    kind: "lane",
    lane: base === "parked" ? "parked" : "backlog",
    slotId,
  };
}

/** Which drop target a topic currently sits in. */
export function columnKeyOf(topic: Topic): string {
  if (topic.sessionId) return cellKey(`s:${topic.sessionId}`, topic.slotId);
  if (topic.lane === "parked") return "parked";
  return cellKey("backlog", topic.slotId);
}

/** Materialize a projected occurrence so notes and topics can attach to it. */
export function ensureSessionId(
  meetingId: string,
  slot: Slot,
  sessions: Session[],
  addSession: (o: Omit<Session, "id">) => string
): string {
  if (slot.sessionId) return slot.sessionId;
  const existing = sessions.find(
    (s) => s.meetingId === meetingId && s.date === slot.date
  );
  if (existing) return existing.id;
  return addSession({ meetingId, date: slot.date });
}

// ── Reads ─────────────────────────────────────────────────────────────────

export function topicsFor(topics: Topic[], meetingId: string): Topic[] {
  return topics
    .filter((t) => t.meetingId === meetingId)
    .sort((a, b) => a.order - b.order);
}

/** Open topics slotted into an occurrence that has already been and gone. */
export function looseTopics(
  topics: Topic[],
  sessions: Session[],
  meetingId: string,
  today: string = todayISO()
): Topic[] {
  const passed = new Set(
    sessions
      .filter((s) => s.meetingId === meetingId && s.date < today)
      .map((s) => s.id)
  );
  return topicsFor(topics, meetingId).filter(
    (t) => t.status === "open" && t.sessionId && passed.has(t.sessionId)
  );
}

/** Loose topics across every meeting, for the roll-ups. */
export function allLooseTopics(
  topics: Topic[],
  sessions: Session[],
  today: string = todayISO()
): Topic[] {
  const passed = new Set(
    sessions.filter((s) => s.date < today).map((s) => s.id)
  );
  return topics.filter(
    (t) => t.status === "open" && t.sessionId && passed.has(t.sessionId)
  );
}

/**
 * The occurrences this board plans into: the most recent past meeting (so last
 * week stays reachable), any older one still holding something unfinished,
 * every future one on the books, then projections to fill out the runway.
 *
 * Full history lives in Write-ups; the board keeps one look back so a finished
 * week doesn't vanish the morning after.
 */
export function plannedSlots(
  meeting: TrackedMeeting,
  sessions: Session[],
  topics: Topic[],
  today: string = todayISO(),
  ahead: number = SLOTS_AHEAD
): Slot[] {
  const all = sessionsFor(meeting.id, sessions);
  const mine = heldSessions(all);
  const taken = takenSeriesDates(all);
  const openSlotted = new Set(
    topicsFor(topics, meeting.id)
      .filter((t) => t.status === "open" && t.sessionId)
      .map((t) => t.sessionId as string)
  );

  const byDate = new Map<string, Slot>();
  const pastSessions = mine.filter((s) => s.date < today);
  const lastPastSession = pastSessions[pastSessions.length - 1];

  for (const s of pastSessions.filter((s) => openSlotted.has(s.id))) {
    byDate.set(s.date, {
      sessionId: s.id,
      date: s.date,
      projected: false,
      past: true,
    });
  }

  if (lastPastSession && !byDate.has(lastPastSession.date)) {
    byDate.set(lastPastSession.date, {
      sessionId: lastPastSession.id,
      date: lastPastSession.date,
      projected: false,
      past: true,
    });
  }

  const booking = explicitNextDate(meeting, sessions, today);
  const lastPast = lastRhythmDate(all, today) ?? undefined;
  const target = meeting.rhythm === "as_needed" ? 1 : ahead;

  // Scaffold from the next rhythm date on or after today — never from a
  // session weeks out, or clicking that week would hide this Friday.
  let cursor =
    meeting.rhythm === "as_needed"
      ? (booking && booking >= today ? booking : lastPast && lastPast >= today ? lastPast : today)
      : (nextOpenRhythmDate(meeting, all, today) ?? today);

  if (meeting.rhythm !== "as_needed") {
    const step = CADENCE_DAYS[meeting.rhythm];
    const prev = addDays(cursor, -step);
    // Already showing a real meeting from that stretch — don't draw a second,
    // imaginary one next to it (e.g. after the weekday changed).
    const coveredByPast =
      lastPastSession && lastPastSession.date > addDays(prev, -step);
    if (prev < today && !byDate.has(prev) && !taken.has(prev) && !coveredByPast) {
      const existing = mine.find((s) => s.date === prev);
      byDate.set(prev, {
        sessionId: existing?.id ?? null,
        date: prev,
        projected: !existing,
        past: true,
      });
    }
  }

  for (let i = 0; i < target; i++) {
    if (i > 0) {
      cursor = projectFromLast(meeting, cursor);
      for (let j = 0; taken.has(cursor) && j < 60; j++) {
        cursor = projectFromLast(meeting, cursor);
      }
    }
    const existing = mine.find((s) => s.date === cursor);
    byDate.set(cursor, {
      sessionId: existing?.id ?? byDate.get(cursor)?.sessionId ?? null,
      date: cursor,
      projected: !existing,
      past: cursor < today,
    });
  }

  // Any other future session — usually from planning further out — still
  // deserves its own column even when it falls beyond the runway.
  for (const s of mine.filter((s) => s.date >= today)) {
    byDate.set(s.date, {
      sessionId: s.id,
      date: s.date,
      projected: false,
      past: false,
    });
  }

  if (booking && !byDate.has(booking)) {
    const existing = mine.find((s) => s.date === booking);
    byDate.set(booking, {
      sessionId: existing?.id ?? null,
      date: booking,
      projected: !existing,
      past: false,
    });
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** The next occurrence a topic can be pushed into, after the one it's in. */
export function nextSlotAfter(slots: Slot[], sessionId?: string): Slot | null {
  const upcoming = slots.filter((s) => !s.past);
  if (!sessionId) return upcoming[0] ?? null;
  const from = slots.find((s) => s.sessionId === sessionId);
  if (!from) return upcoming[0] ?? null;
  return upcoming.find((s) => s.date > from.date) ?? null;
}

// ── The board ─────────────────────────────────────────────────────────────

/** Short slot heading: "Tue Mar 17", with the `~` readiness already uses. */
export function slotLabel(slot: Slot): string {
  const label = new Date(`${slot.date}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return slot.projected ? `~${label}` : label;
}

function slotHint(slot: Slot, topics: Topic[], today: string): string {
  const openCount = topics.filter((t) => t.status === "open").length;
  if (slot.past) {
    if (openCount === 0) {
      return topics.length > 0 ? "all covered" : "";
    }
    return openCount === 1 ? "1 not covered" : `${openCount} not covered`;
  }
  const days = daysBetween(today, slot.date);
  const when =
    days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
  // Ticking topics off mid-meeting should show up somewhere above the cards.
  const done = topics.length - openCount;
  return done > 0 ? `${when} · ${done}/${topics.length} covered` : when;
}

/**
 * The scaffolder: a tagged idea bucket, then one column per upcoming
 * occurrence. Each week is the standing skeleton — empty cells stay visible
 * so an unbalanced meeting is obvious without opening anything.
 *
 * Covered is not a column. Marking a topic done is a checkbox on the card
 * (and on the write-up). Parked lives in the bucket, not beside the weeks.
 */
export function boardLayout(
  meeting: TrackedMeeting,
  sessions: Session[],
  topics: Topic[],
  today: string = todayISO(),
  opts: { ahead?: number } = {}
): BoardLayout {
  const mine = topicsFor(topics, meeting.id);
  const slots = plannedSlots(meeting, sessions, topics, today, opts.ahead);
  const open = mine.filter((t) => t.status === "open");
  const curriculum = curriculumOf(meeting);
  const rowOf = (t: Topic) => effectiveSlotId(t, curriculum);

  const unslotted = (lane: TopicLane) =>
    open.filter((t) => !t.sessionId && t.lane === lane);

  const backlog = unslotted("backlog");
  const parked = unslotted("parked");

  const bucket: BucketGroup[] = [];
  if (curriculum.length) {
    bucket.push({
      key: "backlog",
      label: "Untagged",
      lane: "backlog",
      topics: backlog.filter((t) => !rowOf(t)),
    });
    for (const slot of curriculum) {
      bucket.push({
        key: cellKey("backlog", slot.id),
        label: slot.label,
        lane: "backlog",
        slotId: slot.id,
        topics: backlog.filter((t) => rowOf(t) === slot.id),
      });
    }
  } else {
    bucket.push({
      key: "backlog",
      label: "Ideas",
      lane: "backlog",
      topics: backlog,
    });
  }
  bucket.push({
    key: "parked",
    label: "Parked",
    lane: "parked",
    topics: parked,
  });

  const weeks: WeekColumn[] = slots.map((slot) => {
    const inWeek = slot.sessionId
      ? mine.filter((t) => t.sessionId === slot.sessionId && t.status !== "dropped")
      : [];
    const occ = slotKey(slot);
    const cells: WeekCell[] = [];
    if (curriculum.length) {
      for (const cs of curriculum) {
        cells.push({
          key: cellKey(occ, cs.id),
          slotId: cs.id,
          label: cs.label,
          topics: inWeek.filter((t) => rowOf(t) === cs.id),
        });
      }
      // Always a drop target: not everything belongs to a row.
      cells.push({
        key: occ,
        label: "Untagged",
        topics: inWeek.filter((t) => !rowOf(t)),
      });
    } else {
      cells.push({ key: occ, label: "", topics: inWeek });
    }
    const session = slot.sessionId
      ? sessions.find((o) => o.id === slot.sessionId)
      : undefined;
    const exception =
      session?.kind === "extra"
        ? "One-off"
        : session?.seriesDate && session.seriesDate !== session.date
          ? `Moved from ${new Date(`${session.seriesDate}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" })}`
          : null;
    const when = slotHint(slot, inWeek, today);
    return {
      key: occ,
      label: slotLabel(slot),
      exception: exception ?? undefined,
      hint: when || undefined,
      slot,
      cells,
      topics: inWeek,
    };
  });

  return { bucket, weeks };
}

/** How many upcoming weeks already have something in each skeleton slot. */
export function curriculumBalance(weeks: WeekColumn[], curriculum: CurriculumSlot[]): SlotBalance[] {
  const upcoming = weeks.filter((w) => !w.slot.past);
  return curriculum.map((slot) => ({
    slot,
    filled: upcoming.filter((w) =>
      w.cells.some((c) => c.slotId === slot.id && c.topics.length > 0)
    ).length,
    total: upcoming.length,
  }));
}

// ── Calendar ──────────────────────────────────────────────────────────────

export type CalendarDay = {
  date: string;
  /** False for padding days from the previous/next month. */
  inMonth: boolean;
  slot?: Slot;
  topics: Topic[];
};

/** Last ISO date in a YYYY-MM month. */
export function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const next =
    m === 12
      ? `${y + 1}-01-01`
      : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return addDays(next, -1);
}

/** Project occurrences forward until `through` is covered. */
export function slotsThrough(
  meeting: TrackedMeeting,
  sessions: Session[],
  topics: Topic[],
  through: string,
  today: string = todayISO()
): Slot[] {
  const slots = [...plannedSlots(meeting, sessions, topics, today, SLOTS_AHEAD)];
  const seen = new Set(slots.map((s) => s.date));
  const taken = takenSeriesDates(sessionsFor(meeting.id, sessions));

  while (true) {
    const last = slots[slots.length - 1]?.date;
    if (!last || last >= through) break;
    let next = projectFromLast(meeting, last);
    for (let j = 0; taken.has(next) && j < 60; j++) next = projectFromLast(meeting, next);
    if (seen.has(next)) break;
    seen.add(next);
    slots.push({
      sessionId: null,
      date: next,
      projected: true,
      past: next < today,
    });
  }

  return slots.sort((a, b) => a.date.localeCompare(b.date));
}

/** Occurrences and slotted topics keyed by ISO date for one month. */
export function occurrencesInMonth(
  meeting: TrackedMeeting,
  sessions: Session[],
  topics: Topic[],
  month: string,
  today: string = todayISO()
): Map<string, { slot: Slot; topics: Topic[] }> {
  const start = `${month}-01`;
  const end = monthEnd(month);
  const slots = slotsThrough(meeting, sessions, topics, end, today);
  const mine = heldSessions(sessionsFor(meeting.id, sessions));
  const all = topicsFor(topics, meeting.id);
  const map = new Map<string, { slot: Slot; topics: Topic[] }>();

  for (const slot of slots) {
    if (slot.date < start || slot.date > end) continue;
    const inSlot = slot.sessionId
      ? all.filter((t) => t.sessionId === slot.sessionId && t.status !== "dropped")
      : [];
    map.set(slot.date, { slot, topics: inSlot });
  }

  for (const s of mine) {
    if (s.date < start || s.date > end || map.has(s.date)) continue;
    map.set(s.date, {
      slot: {
        sessionId: s.id,
        date: s.date,
        projected: false,
        past: s.date < today,
      },
      topics: all.filter((t) => t.sessionId === s.id && t.status !== "dropped"),
    });
  }

  return map;
}

/** Six-week grid (Sun–Sat) for a month, sharing the board's slot data. */
export function calendarGrid(
  month: string,
  meeting: TrackedMeeting,
  sessions: Session[],
  topics: Topic[],
  today: string = todayISO()
): CalendarDay[] {
  const start = `${month}-01`;
  const byDate = occurrencesInMonth(meeting, sessions, topics, month, today);

  let cursor = addDays(start, -weekdayUTC(start));
  const days: CalendarDay[] = [];

  for (let i = 0; i < 42; i++) {
    const entry = byDate.get(cursor);
    days.push({
      date: cursor,
      inMonth: cursor.startsWith(month),
      slot: entry?.slot,
      topics: entry?.topics ?? [],
    });
    cursor = addDays(cursor, 1);
  }

  return days;
}
