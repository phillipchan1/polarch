/**
 * Readiness — am I prepared for the next occurrence of a meeting I've opted
 * into being ready for?
 *
 * Deliberately separate from `derive.ts`, which answers the *other* question:
 * "do I know them" (Depth — slow-moving, built from the profile). This file is
 * Prep — fast-moving, resets after every occurrence, and only matters relative
 * to when the next one lands.
 *
 * ── Why the meeting is the unit ───────────────────────────────────────────
 * A 1:1, a staff meeting, a practice session and a check-in with my boss all
 * prep the same way, so they're all `TrackedMeeting`s pointing at different
 * subjects. The same team can have a standing meeting *and* 1:1s with its
 * members; those are separate things to be ready for.
 *
 * ── Why rhythm and not a calendar ─────────────────────────────────────────
 * You don't book every meeting, but you do have a rhythm. The rhythm projects
 * the next date from the last one. An explicit `nextDate` always wins; the
 * projection is the fallback that makes this work with zero scheduling — which
 * is why `Readiness.projected` exists, so the UI can say "~Tue" not "Tue".
 *
 * ── Why opting in is the whole design ─────────────────────────────────────
 * Most relationships have no meeting to track, and a dashboard that can never
 * be clean gets ignored — taking the one real alarm with it. So nothing is
 * measured until you say so. The cost is that you could go green by opting out
 * of the hard things, which `triage()` answers: it counts only the subjects you
 * haven't *decided* about, and that count empties.
 */
import type {
  Cadence,
  MeetingRhythm,
  MeetingSubjectKind,
  Session,
  Topic,
  TrackedMeeting,
} from "../types";
import { trackerName } from "./tracker.ts";

export type ReadinessState =
  /** Tracked, but nothing is expected and nothing is booked. No guilt. */
  | "dormant"
  /** Met recently, prep window hasn't opened. Nothing is owed. */
  | "resting"
  /** Window open, checklist clear. */
  | "ready"
  /** Window open, something's missing. */
  | "prep_due"
  /** It happened and was never written up. Paperwork debt. */
  | "loose_end"
  /** Past the rhythm (or the floor) with nothing next. Relationship debt. */
  | "drifting";

/** Worst-first. Roll-ups and sorting both read from this order. */
export const STATE_ORDER: ReadinessState[] = [
  "drifting",
  "loose_end",
  "prep_due",
  "ready",
  "resting",
  "dormant",
];

export const STATE_LABEL: Record<ReadinessState, string> = {
  dormant: "Dormant",
  resting: "Resting",
  ready: "Ready",
  prep_due: "Prep due",
  loose_end: "Loose end",
  drifting: "Drifting",
};

/** Canvas needs raw hex (inline styles on React Flow nodes). */
export const STATE_COLOR: Record<ReadinessState, string> = {
  dormant: "#C8D4D4",
  resting: "#7DAD7E",
  ready: "#247E56",
  prep_due: "#F1A048",
  loose_end: "#D36340",
  drifting: "#C13B42",
};

/** States that mean you owe something before you walk in. */
export function isBehind(state: ReadinessState): boolean {
  return state === "prep_due" || state === "loose_end" || state === "drifting";
}

export const CADENCE_DAYS: Record<Cadence, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
  quarterly: 90,
};

export const RHYTHM_LABEL: Record<MeetingRhythm, string> = {
  weekly: "Weekly",
  biweekly: "Every other week",
  monthly: "Monthly",
  quarterly: "Quarterly",
  as_needed: "As needed",
};

/** Mid-sentence noun. Same word everywhere — the gathering, not the relationship. */
export const MEETING_LABEL: Record<MeetingSubjectKind, string> = {
  person: "meeting",
  team: "meeting",
  manager: "meeting",
};

export const RHYTHM_OPTIONS: MeetingRhythm[] = [
  "weekly",
  "biweekly",
  "monthly",
  "quarterly",
  "as_needed",
];

/** Prep runway for an as-needed meeting, which has no rhythm to scale from. */
const AS_NEEDED_WINDOW_DAYS = 3;

/**
 * Agenda input, normalized so the engine doesn't care what produced it.
 */
export type AgendaItem = {
  id: string;
  text: string;
  done: boolean;
  dueDate?: string;
  /** Explicitly planned into the next occurrence. */
  queued: boolean;
  /**
   * Planned into an occurrence that has already been and gone, and never
   * closed. The thing this whole board exists to stop happening.
   */
  loose?: boolean;
};

/** What a failing check offers to do about itself. */
export type CheckFix =
  | "book" // log or schedule the next one
  | "writeUp" // open the specific session that has no notes
  | "agenda" // queue something to talk about
  | "commitments"; // deal with what's past due

export type Check = {
  id: "rhythm" | "writeUp" | "agenda" | "commitments";
  label: string;
  done: boolean;
  /** Shown when the check fails — the specific reason, not the generic rule. */
  detail?: string;
  fix: CheckFix;
  /** Session this check points at, when it points at one. */
  sessionId?: string;
};

export type Readiness = {
  state: ReadinessState;
  /** Explicit or projected date of the next occurrence. Null when unknowable. */
  nextDate: string | null;
  /** True when nextDate came from the rhythm rather than a booking. */
  projected: boolean;
  /** Negative = overdue. Null when nextDate is null. */
  daysUntil: number | null;
  /** ISO date of the most recent logged session. */
  lastMet: string | null;
  /** Days since the last session. Null when there's never been one. */
  daysSince: number | null;
  /** True once we're close enough that prep actually matters. */
  windowOpen: boolean;
  checks: Check[];
  /** One line for the card / panel header. */
  headline: string;
};

const DAY = 86_400_000;

function toUTC(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

export function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addDays(iso: string, days: number): string {
  return new Date(toUTC(iso) + days * DAY).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((toUTC(to) - toUTC(from)) / DAY);
}

/** UTC weekday (0 = Sun … 6 = Sat). */
export function weekdayUTC(iso: string): number {
  return new Date(toUTC(iso)).getUTCDay();
}

/** First date on or after `from` whose UTC weekday equals `day`. */
export function onOrAfterWeekday(from: string, day: number): string {
  let cursor = from;
  for (let i = 0; i < 7; i++) {
    if (weekdayUTC(cursor) === day) return cursor;
    cursor = addDays(cursor, 1);
  }
  return cursor;
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export const ANCHOR_WEEKDAY_OPTIONS = WEEKDAY_LABELS.map((label, value) => ({
  label,
  value: String(value),
}));

/**
 * Next occurrence after `lastMet`, honoring rhythm and optional anchor weekday.
 * Used by readiness and the topic-board slot projector — one source of truth.
 *
 * Weekly-on-Friday means the next Friday after the last meeting — even when
 * that Friday is tomorrow. A minimum-gap skip used to push it another week
 * whenever lastMet wasn't itself a Friday (including "no history, seed from
 * today"), which hid this week's occurrence.
 */
export function projectFromLast(
  meeting: TrackedMeeting,
  lastMet: string
): string {
  const { rhythm } = meeting;
  if (rhythm === "as_needed") {
    return addDays(lastMet, meeting.floorDays ?? 14);
  }
  const step = CADENCE_DAYS[rhythm];
  const anchor = meeting.anchorWeekday;

  if (anchor === undefined) return addDays(lastMet, step);

  if (rhythm === "weekly") {
    return onOrAfterWeekday(addDays(lastMet, 1), anchor);
  }
  if (rhythm === "biweekly") {
    let d = onOrAfterWeekday(addDays(lastMet, 1), anchor);
    if (daysBetween(lastMet, d) < 14) d = addDays(d, 14);
    return d;
  }
  return onOrAfterWeekday(addDays(lastMet, step), anchor);
}

/**
 * Next occurrence on or after `today`. Walks the rhythm forward from the last
 * meeting so a missed week doesn't leave "next" in the past; with no history,
 * snaps to the anchor weekday (this Friday, not next-next Friday).
 */
export function upcomingRhythmDate(
  meeting: TrackedMeeting,
  lastMet: string | null,
  today: string = todayISO()
): string | null {
  if (meeting.rhythm === "as_needed") return null;
  if (lastMet) {
    let d = projectFromLast(meeting, lastMet);
    while (d < today) d = projectFromLast(meeting, d);
    return d;
  }
  if (meeting.anchorWeekday === undefined) return null;
  return onOrAfterWeekday(today, meeting.anchorWeekday);
}

// ── Exceptions to the series ─────────────────────────────────────────────
// A calendar lets you move one event of a series without moving the series.
// Here an occurrence records the rhythm date it stands in for (`seriesDate`),
// and the projection treats that date as taken. Extras sit outside the rhythm
// entirely; skipped weeks hold their date without being a meeting.

/** The date an occurrence occupies in the series, or null for an extra. */
export function rhythmDateOf(s: Session): string | null {
  if (s.kind === "extra") return null;
  return s.seriesDate ?? s.date;
}

/** Series dates the projection must not draw: moved away from, or skipped. */
export function takenSeriesDates(mine: Session[]): Set<string> {
  const taken = new Set<string>();
  for (const s of mine) {
    if (s.kind === "skipped") taken.add(s.seriesDate ?? s.date);
    else if (s.seriesDate && s.seriesDate !== s.date) taken.add(s.seriesDate);
  }
  return taken;
}

/** Sessions that are (or will be) actual meetings — not skipped weeks. */
export function heldSessions(mine: Session[]): Session[] {
  return mine.some((s) => s.kind === "skipped")
    ? mine.filter((s) => s.kind !== "skipped")
    : mine;
}

/** Latest series position on or before `today` — where the rhythm continues from. */
export function lastRhythmDate(mine: Session[], today: string): string | null {
  let last: string | null = null;
  for (const s of mine) {
    const d = rhythmDateOf(s);
    if (d && d <= today && (!last || d > last)) last = d;
  }
  return last;
}

/** Next projected series date on or after `today`, stepping over taken ones. */
export function nextOpenRhythmDate(
  meeting: TrackedMeeting,
  mine: Session[],
  today: string
): string | null {
  const taken = takenSeriesDates(mine);
  let d = upcomingRhythmDate(meeting, lastRhythmDate(mine, today), today);
  for (let i = 0; d && taken.has(d) && i < 60; i++) d = projectFromLast(meeting, d);
  return d;
}

/**
 * How far ahead prep starts mattering. Two days minimum, longer for slower
 * rhythms — a monthly meeting deserves more than 48 hours of runway.
 */
export function prepWindowDays(rhythm: MeetingRhythm): number {
  if (rhythm === "as_needed") return AS_NEEDED_WINDOW_DAYS;
  return Math.max(2, Math.round(CADENCE_DAYS[rhythm] * 0.25));
}

/** Grace before "nothing next" becomes drifting, so a day late isn't red. */
function driftGraceDays(rhythm: MeetingRhythm, floorDays?: number): number | null {
  if (rhythm === "as_needed") return floorDays ?? null;
  return Math.round(CADENCE_DAYS[rhythm] * 1.5);
}

/** "Mon, Oct 12" — a date as a sentence says it, not as the data stores it. */
export function dayName(iso: string): string {
  return new Date(toUTC(iso)).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Short human form: "Tue · 2d", "~Tue · 5d", "3d late". */
export function formatCountdown(r: Readiness): string {
  if (r.daysUntil === null) {
    return r.daysSince === null ? "never met" : `${r.daysSince}d ago`;
  }
  if (r.daysUntil < 0) return `${Math.abs(r.daysUntil)}d late`;
  const weekday = new Date(toUTC(r.nextDate!)).toLocaleDateString(undefined, {
    weekday: "short",
    timeZone: "UTC",
  });
  const when = r.daysUntil === 0 ? "today" : `${r.daysUntil}d`;
  return `${r.projected ? "~" : ""}${weekday} · ${when}`;
}

/**
 * One `sessions` array in, a meeting-id → sessions index out — cached against
 * the array's identity.
 *
 * `sessionsFor` used to filter and sort *every session in the org* on each
 * call, and it is called several times per readiness read: once in
 * `meetingReadiness`, once in `meetingAgenda`, once in `explicitNextDate`. The
 * canvas then reads readiness per node, per render. With a year of sessions
 * that is O(nodes × sessions log sessions) for a single keystroke.
 *
 * The store hands out a fresh array only when sessions actually change, so
 * identity is exactly the right cache key: one pass builds the whole index and
 * every meeting reads its own slice for free. A single entry is enough — the
 * app only ever holds one sessions array at a time, and keeping the previous
 * one alive would pin a document in memory for no gain.
 */
let sessionIndexKey: Session[] | null = null;
let sessionIndex: Map<string, Session[]> = new Map();

/** Shared empty result, so a meeting with no sessions doesn't allocate. */
const EMPTY_SESSIONS: Session[] = [];

function indexOf(sessions: Session[]): Map<string, Session[]> {
  if (sessionIndexKey === sessions) return sessionIndex;
  const next = new Map<string, Session[]>();
  for (const s of sessions) {
    const bucket = next.get(s.meetingId);
    if (bucket) bucket.push(s);
    else next.set(s.meetingId, [s]);
  }
  for (const bucket of next.values()) {
    bucket.sort((a, b) => a.date.localeCompare(b.date));
  }
  sessionIndexKey = sessions;
  sessionIndex = next;
  return next;
}

/**
 * Sessions belonging to a meeting, oldest first.
 *
 * Returns a shared array — callers read it, they must not mutate or sort it in
 * place. Every existing caller only filters, finds and maps.
 */
export function sessionsFor(meetingId: string, sessions: Session[]): Session[] {
  return indexOf(sessions).get(meetingId) ?? EMPTY_SESSIONS;
}

/**
 * The next explicitly booked occurrence. `meeting.nextDate` wins when set —
 * that's the user's current plan in Settings. Per-session `nextDate` fields are
 * only fallbacks from individual write-ups.
 *
 * A session that exists on a future date is not a booking. Opening a projected
 * week materializes an empty row; treating that as "next" used to skip the
 * Friday that's actually coming up.
 */
export function explicitNextDate(
  meeting: TrackedMeeting,
  sessions: Session[],
  today: string = todayISO()
): string | null {
  if (meeting.nextDate && meeting.nextDate >= today) {
    return meeting.nextDate;
  }

  const mine = sessionsFor(meeting.id, sessions);
  const fromSessions = mine
    .map((s) => s.nextDate)
    .filter((d): d is string => typeof d === "string" && d >= today)
    .sort()[0];

  return fromSessions ?? null;
}

/** Latest booking hint on record — for missed-date detection. */
function latestBookingHint(
  meeting: TrackedMeeting,
  sessions: Session[]
): string | null {
  const dates = [
    meeting.nextDate,
    ...sessionsFor(meeting.id, sessions).map((s) => s.nextDate),
  ].filter((d): d is string => Boolean(d));
  return dates.length ? dates.sort().pop()! : null;
}

/**
 * The readiness read for one tracked meeting.
 *
 * `sessions` and `agenda` may be the full unfiltered collections for the
 * subject — this filters sessions by meeting itself.
 */
export function meetingReadiness(
  meeting: TrackedMeeting,
  sessions: Session[],
  agenda: AgendaItem[],
  today: string = todayISO()
): Readiness {
  const { rhythm } = meeting;
  const asNeeded = rhythm === "as_needed";
  const all = sessionsFor(meeting.id, sessions);
  const mine = heldSessions(all);

  const past = mine.filter((s) => s.date <= today);
  const lastSession = past.length ? past[past.length - 1] : null;
  const lastMet = lastSession?.date ?? null;
  const daysSince = lastMet ? daysBetween(lastMet, today) : null;

  // A booking beats a projection. Meeting-level nextDate is the user's plan.
  const explicit = explicitNextDate(meeting, sessions, today);
  const booked = latestBookingHint(meeting, sessions);

  // As-needed makes no promise about a next date, so it projects nothing.
  const projectedDate = nextOpenRhythmDate(meeting, all, today);
  // A moved occurrence or a one-off is a real booking, and may come first.
  const exception = mine.find(
    (s) => s.date >= today && (s.kind === "extra" || (s.seriesDate && s.seriesDate !== s.date))
  )?.date;
  // A meeting dated today is still ahead of you until the day is over. It has
  // a session as soon as anything is planned into it, and the projection reads
  // that session as "last met" and steps a week past it — so a Monday meeting
  // read as "in 7 days" on the Monday itself.
  const heldToday = mine.some((s) => s.date === today) ? today : null;
  const nextDate =
    [explicit, exception, explicit ? null : projectedDate, heldToday]
      .filter((d): d is string => Boolean(d))
      .sort()[0] ?? null;
  const onTheBooks = Boolean(
    nextDate && mine.some((s) => s.date === nextDate)
  );
  const projected =
    nextDate === projectedDate && !explicit && Boolean(projectedDate) && !onTheBooks;
  const daysUntil = nextDate ? daysBetween(today, nextDate) : null;

  const windowOpen =
    daysUntil !== null && daysUntil <= prepWindowDays(rhythm);

  // ── Checks ──────────────────────────────────────────────────────────────
  // A booking that came and went with nothing logged for it.
  const missed =
    booked && booked < today && (!lastMet || booked > lastMet) ? booked : null;

  const grace = driftGraceDays(rhythm, meeting.floorDays);
  const overdue =
    grace !== null && daysSince !== null && daysSince > grace;

  // Drifting needs evidence of a broken promise — a last meeting that has aged
  // out, or a booking that came and went. A meeting you just started tracking
  // has no history to be late against, so it sits dormant rather than greeting
  // you in red.
  const rhythmOnTrack = Boolean(explicit) || (!missed && !overdue);

  // The write-up is the one check an external tracker takes over. Polarch
  // can't read a Notion page or a Word doc, and a check that can never pass
  // would park everyone who uses one in Loose end forever — which is exactly
  // how a dashboard stops being read. So it stops asserting instead of
  // guessing, and says where the notes went.
  const trackerUrl = meeting.trackerUrl?.trim();
  const notesHere = !lastSession || Boolean(lastSession.notes?.trim());
  const writtenUp = notesHere || Boolean(trackerUrl);
  const notesElsewhere = Boolean(trackerUrl) && !notesHere;

  const open = agenda.filter((a) => !a.done);
  const queued = open.filter((a) => a.queued);
  const pastDue = open.filter((a) => a.dueDate && a.dueDate < today);
  // Planned into a meeting that has already happened and never closed out.
  // Reported ahead of a past due date because it's the sharper failure: a due
  // date slipping is a guess going wrong, a loose topic is one you sat in the
  // room with and dropped.
  const loose = open.filter((a) => a.loose);

  const checks: Check[] = [
    {
      id: "rhythm",
      label: explicit
        ? "Next one booked"
        : asNeeded
          ? "Nothing overdue"
          : `${RHYTHM_LABEL[rhythm]} rhythm on track`,
      done: rhythmOnTrack,
      detail: missed
        ? `${dayName(missed)} came and went unlogged`
        : overdue
          ? `${daysSince} days since the last one`
          : undefined,
      fix: "book",
    },
    {
      id: "writeUp",
      label: notesElsewhere
        ? `Written up in ${meeting.trackerName?.trim() || trackerName(trackerUrl!)}`
        : "Last one written up",
      done: writtenUp,
      detail: notesElsewhere
        ? "Kept outside Polarch — not checked here"
        : writtenUp
          ? undefined
          : `${dayName(lastSession!.date)} has no notes`,
      fix: "writeUp",
      sessionId: lastSession?.id,
    },
    {
      id: "agenda",
      label: "Agenda has something",
      done: queued.length > 0,
      detail: queued.length > 0 ? undefined : "Nothing queued to talk about",
      fix: "agenda",
    },
    {
      id: "commitments",
      label: "Nothing left hanging",
      done: pastDue.length === 0 && loose.length === 0,
      detail: loose.length
        ? `${loose.length} planned and never covered — ${loose[0].text}`
        : pastDue.length
          ? `${pastDue.length} past due — ${pastDue[0].text}`
          : undefined,
      fix: "commitments",
    },
  ];

  // ── State ───────────────────────────────────────────────────────────────
  // Precedence is the opinion: not having met beats not having filed the
  // notes, and both beat an unfinished agenda.
  let state: ReadinessState;
  if (!rhythmOnTrack) state = "drifting";
  else if (!writtenUp) state = "loose_end";
  else if (daysUntil === null) state = "dormant";
  else if (!windowOpen) state = "resting";
  else if (checks.every((c) => c.done)) state = "ready";
  else state = "prep_due";

  const failing = checks.filter((c) => !c.done);
  const headline =
    state === "drifting"
      ? (checks[0].detail ?? "Nothing next on the books")
      : state === "loose_end"
        ? (checks[1].detail ?? "The last one was never written up")
        : state === "dormant"
          ? lastMet
            ? `Nothing booked — last met ${daysSince} days ago`
            : "Nothing booked yet"
          : state === "resting"
            ? `Nothing owed yet — next ${projected ? "one lands in about" : "in"} ${daysUntil} day${daysUntil === 1 ? "" : "s"}`
            : state === "ready"
              ? "Ready — show up"
              : failing.length === 1
                ? (failing[0].detail ?? failing[0].label)
                : `${failing.length} things before you sit down`;

  return {
    state,
    nextDate,
    projected,
    daysUntil,
    lastMet,
    daysSince,
    windowOpen,
    checks,
    headline,
  };
}

export type RollUp = {
  /** Worst state among tracked meetings — never an average. */
  state: ReadinessState | null;
  counts: Record<ReadinessState, number>;
  tracked: number;
  ready: number;
  behind: number;
};

/**
 * Roll a set of readings up to a card. Worst-of, deliberately: nine Readys and
 * one Drifting is not "90% ready", it's a group where someone is being dropped.
 */
export function rollUp(readings: Readiness[]): RollUp {
  const counts = Object.fromEntries(
    STATE_ORDER.map((s) => [s, 0])
  ) as Record<ReadinessState, number>;
  for (const r of readings) counts[r.state]++;

  return {
    state: STATE_ORDER.find((s) => counts[s] > 0) ?? null,
    counts,
    tracked: readings.length,
    ready: readings.filter((r) => !isBehind(r.state)).length,
    behind: readings.filter((r) => isBehind(r.state)).length,
  };
}

/** Segments for the distribution bar on a card, worst-first. */
export function distribution(
  roll: RollUp
): { state: ReadinessState; count: number; color: string }[] {
  return STATE_ORDER.filter((s) => roll.counts[s] > 0).map((s) => ({
    state: s,
    count: roll.counts[s],
    color: STATE_COLOR[s],
  }));
}

// ── Triage ────────────────────────────────────────────────────────────────

export type TriageState = "tracked" | "no_meeting" | "undecided";

/**
 * Where a subject sits on the opt-in question. "no_meeting" is a decision and
 * is never counted at you — only `undecided` is, and only until you decide.
 */
export function triageState(
  subject: { id: string; noMeeting?: boolean },
  meetings: TrackedMeeting[],
  kind: MeetingSubjectKind
): TriageState {
  if (meetings.some((m) => m.subjectKind === kind && m.subjectId === subject.id))
    return "tracked";
  return subject.noMeeting ? "no_meeting" : "undecided";
}

/**
 * One meeting's topic board as agenda.
 *
 * `queued` is what's planned into the *next* occurrence specifically — not
 * "anything on the board", or the check would pass the moment you'd ever
 * thought of something. `loose` is the occurrence that already went by.
 */
export function meetingAgenda(
  topics: Topic[],
  sessions: Session[],
  meetingId: string,
  today: string = todayISO()
): AgendaItem[] {
  const mine = sessionsFor(meetingId, sessions);
  const nextSession = mine.find((s) => s.date >= today);
  const passed = new Set(mine.filter((s) => s.date < today).map((s) => s.id));

  return topics
    .filter((t) => t.meetingId === meetingId)
    .map((t) => ({
      id: t.id,
      text: t.text,
      done: t.status !== "open",
      dueDate: t.dueDate,
      queued: Boolean(nextSession && t.sessionId === nextSession.id),
      loose: Boolean(t.sessionId && passed.has(t.sessionId)),
    }));
}

/** Everything the engine needs, straight off the store. */
export type ReadinessData = {
  meetings: TrackedMeeting[];
  sessions: Session[];
  topics: Topic[];
};

/** The readiness read for one meeting, straight off the store. */
export function readinessOf(
  meeting: TrackedMeeting,
  data: ReadinessData,
  today: string = todayISO()
): Readiness {
  return meetingReadiness(
    meeting,
    data.sessions,
    meetingAgenda(data.topics, data.sessions, meeting.id, today),
    today
  );
}

/** Every reading for a subject — one per meeting, in tracking order. */
export function readingsFor(
  kind: MeetingSubjectKind,
  subjectId: string,
  data: ReadinessData,
  today: string = todayISO()
): Readiness[] {
  return meetingsFor(data.meetings, kind, subjectId).map((m) =>
    readinessOf(m, data, today)
  );
}

/**
 * One reading for a subject that has several meetings, or null when it has
 * none. Worst-of, deliberately — the same opinion `rollUp` encodes: a person
 * whose 1:1 is Ready and whose career check-in is Drifting is not "mostly
 * fine", they're someone being dropped in one of the two places that matter.
 *
 * Every surface that draws a single dot per subject reads this, which is why
 * it kept the old `readinessFor` name: the canvas, the org table and the
 * people table all get many-meetings behaviour without changing a line.
 */
export function readinessFor(
  kind: MeetingSubjectKind,
  subjectId: string,
  data: ReadinessData,
  today: string = todayISO()
): Readiness | null {
  const readings = readingsFor(kind, subjectId, data, today);
  if (!readings.length) return null;
  return (
    STATE_ORDER.map((state) => readings.find((r) => r.state === state)).find(
      Boolean
    ) ?? readings[0]
  );
}

/** Every meeting tracked for a subject. A person can have more than one. */
export function meetingsFor(
  meetings: TrackedMeeting[],
  kind: MeetingSubjectKind,
  subjectId: string
): TrackedMeeting[] {
  return meetings.filter(
    (m) => m.subjectKind === kind && m.subjectId === subjectId
  );
}

/**
 * The subject's primary meeting — the first one tracked. Only for the surfaces
 * that genuinely have room for one (a profile summary, the AI brief); anything
 * showing the full picture should map over `meetingsFor`.
 */
export function meetingFor(
  meetings: TrackedMeeting[],
  kind: MeetingSubjectKind,
  subjectId: string
): TrackedMeeting | undefined {
  return meetingsFor(meetings, kind, subjectId)[0];
}

/** What to call a meeting: its own name, or a neutral fallback. */
export function meetingTitle(
  meeting: TrackedMeeting,
  subjectName?: string
): string {
  const name = meeting.name?.trim();
  if (name) return name;
  if (!subjectName) return "Meeting";
  // Said the way you'd say it: "1:1 with Sarah", "Frontier Staff meeting".
  return meeting.subjectKind === "team"
    ? `${subjectName} meeting`
    : `1:1 with ${subjectName}`;
}

/** Who or what a meeting is with. Named things only — the id is never shown. */
export function meetingSubjectName(
  meeting: TrackedMeeting,
  src: {
    people: { id: string; name: string }[];
    teams: { id: string; name: string }[];
    managers: { id: string; name: string }[];
  }
): string | undefined {
  const pool =
    meeting.subjectKind === "person"
      ? src.people
      : meeting.subjectKind === "team"
        ? src.teams
        : src.managers;
  return pool.find((x) => x.id === meeting.subjectId)?.name;
}
