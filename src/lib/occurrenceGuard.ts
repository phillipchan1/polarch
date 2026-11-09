/**
 * Guard for booking a meeting occurrence.
 *
 * Two bugs share a write path:
 *
 * 1. Same-date duplicates — `addSession` always inserts a new id. Nothing
 *    unique-keys `(meeting, date)`, so a double Start, a retried sync, or two
 *    surfaces booking the same projected week leave two rows on one day
 *    (Sunday Service Planning, twice on Oct 22; Meghan 1:1, twice on Oct 23).
 * 2. Consecutive-day runs — readiness "book" / profile "log it today" call
 *    `addSession({ date: todayISO() })` without asking the rhythm. A weekly
 *    1:1 then gains a session every day you tap Book (Meghan, Oct 6–10).
 *
 * Call sites keep their master reuse rule when the flag is off:
 *
 * - `addSession`: never reuse (the original bug still reproduces).
 * - placement / captureTopics: reuse any same-date row, including skipped,
 *   comparing the exact `o.date === date` string master used (a datetime
 *   leftover does not match `YYYY-MM-DD`, so a second row is inserted).
 * - extras: never reuse through this helper; `addExtraOccurrence` has its
 *   own live-same-date fold on the store path.
 *
 * Behind `singleOccurrenceGuard`: fold a live same-calendar-day session, keep
 * on-rhythm dates (including a missed past week), and snap only off-rhythm
 * dates forward onto the next rhythm day on or after both the requested day
 * and today — a booking never lands in the past. One-offs still land on the
 * day they were asked for.
 */
import type { Session, Topic, TrackedMeeting } from "../types";
import {
  addDays,
  lastRhythmDate,
  onOrAfterWeekday,
  projectFromLast,
  sessionsFor,
  takenSeriesDates,
  weekdayUTC,
} from "./readiness.ts";

export type OccurrenceMeeting = Pick<
  TrackedMeeting,
  "id" | "rhythm" | "anchorWeekday" | "floorDays" | "nextDate"
>;

export type SameDateReuse = "none" | "any" | "live";

export type OccurrenceSite = "addSession" | "placement" | "extra";

export type OccurrencePlan = {
  /** Reuse this session instead of inserting. */
  reuseId?: string;
  /** Date the new row should carry, when we are inserting. */
  date: string;
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}/;

/** Calendar day of a stored date, so a datetime leftover still matches "YYYY-MM-DD". */
export function occurrenceDay(value: string): string {
  return ISO_DAY.test(value) ? value.slice(0, 10) : value;
}

/** Master's reuse rule for a write path, given whether the guard is on. */
export function sameDateReuseFor(site: OccurrenceSite, guard: boolean): SameDateReuse {
  if (site === "placement") return guard ? "live" : "any";
  return guard ? "live" : "none";
}

function sessionOnDate(
  sessions: Session[],
  meetingId: string,
  date: string,
  includeSkipped: boolean,
  calendarDay: boolean
): Session | undefined {
  if (!calendarDay) {
    return sessions.find((o) => {
      if (o.meetingId !== meetingId || o.date !== date) return false;
      if (!includeSkipped && o.kind === "skipped") return false;
      return true;
    });
  }
  const day = occurrenceDay(date);
  return sessions.find((o) => {
    if (o.meetingId !== meetingId || occurrenceDay(o.date) !== day) return false;
    if (!includeSkipped && o.kind === "skipped") return false;
    return true;
  });
}

/** A real meeting on that day — not a skipped week. */
export function liveOnDate(
  sessions: Session[],
  meetingId: string,
  date: string
): Session | undefined {
  return sessionOnDate(sessions, meetingId, date, false, true);
}

function weekdaySpan(intended: string, anchor: number): { before: string; after: string } {
  const wd = weekdayUTC(intended);
  const fwd = (anchor - wd + 7) % 7;
  const back = (wd - anchor + 7) % 7;
  return {
    after: addDays(intended, fwd),
    before: addDays(intended, back === 0 ? 0 : -back),
  };
}

/**
 * The rhythm date on or before `intended`, and the next one on or after it.
 * Equal when `intended` itself is on the rhythm.
 */
function enclosingRhythm(
  meeting: OccurrenceMeeting,
  sessions: Session[],
  intended: string
): { before: string; after: string } | null {
  const m = meeting as TrackedMeeting;
  if (m.rhythm === "as_needed") return { before: intended, after: intended };

  const last = lastRhythmDate(sessionsFor(m.id, sessions), intended);
  const anchor = m.anchorWeekday;

  // Weekly-with-a-day: every that weekday is on the rhythm, history or not.
  if (m.rhythm === "weekly" && anchor !== undefined) {
    return weekdaySpan(intended, anchor);
  }

  if (last) {
    if (last === intended) return { before: intended, after: intended };
    return { before: last, after: projectFromLast(m, last) };
  }

  if (anchor !== undefined) return weekdaySpan(intended, anchor);
  return null;
}

function isOnRhythm(meeting: OccurrenceMeeting, sessions: Session[], intended: string): boolean {
  const span = enclosingRhythm(meeting, sessions, intended);
  return Boolean(span && (span.before === intended || span.after === intended));
}

/** Next rhythm date on or after `floor` (not yet stepping over skipped weeks). */
function nextRhythmOnOrAfter(
  meeting: OccurrenceMeeting,
  sessions: Session[],
  floor: string
): string {
  const m = meeting as TrackedMeeting;
  if (m.rhythm === "as_needed") return floor;

  const anchor = m.anchorWeekday;
  if (m.rhythm === "weekly" && anchor !== undefined) {
    return onOrAfterWeekday(floor, anchor);
  }

  const last = lastRhythmDate(sessionsFor(m.id, sessions), floor);
  if (last) {
    if (last === floor) return floor;
    let d = projectFromLast(m, last);
    for (let i = 0; i < 60 && d < floor; i++) d = projectFromLast(m, d);
    return d;
  }

  if (anchor !== undefined) return onOrAfterWeekday(floor, anchor);
  return floor;
}

/**
 * Next series date at or after `from` that isn't a skipped/moved-away week.
 * Dates before `today` are skipped unless they are the intended on-rhythm
 * stay-put (logging a missed week).
 */
function nextOpenFrom(
  meeting: OccurrenceMeeting,
  sessions: Session[],
  from: string,
  today: string,
  intended: string
): string | null {
  const taken = takenSeriesDates(sessionsFor(meeting.id, sessions));
  let d = from;
  for (let i = 0; i < 60; i++) {
    if (!taken.has(d) && (d >= today || d === intended)) return d;
    d = projectFromLast(meeting as TrackedMeeting, d);
  }
  return null;
}

/**
 * Where a new occurrence should land.
 *
 * `reuseSameDate` is the call site's master rule (defaults from `guard`):
 * - `none` — always insert (`addSession` with the flag off)
 * - `any`  — reuse any row on that date, including skipped (placement / capture)
 * - `live` — reuse a non-skipped row (flag-on books, extras with the flag on)
 *
 * Flag off compares the exact date string. Flag on compares calendar days.
 */
export function resolveOccurrence(args: {
  meeting: OccurrenceMeeting;
  sessions: Session[];
  date: string;
  today: string;
  extra?: boolean;
  guard: boolean;
  reuseSameDate?: SameDateReuse;
  topics?: Topic[];
}): OccurrencePlan {
  const reuse = args.reuseSameDate ?? sameDateReuseFor(args.extra ? "extra" : "addSession", args.guard);

  if (args.extra && !args.guard) return { date: args.date };

  if (reuse !== "none") {
    const hit = sessionOnDate(
      args.sessions,
      args.meeting.id,
      args.date,
      reuse === "any",
      args.guard
    );
    if (hit) return { reuseId: hit.id, date: args.guard ? occurrenceDay(args.date) : args.date };
  }

  if (args.extra) return { date: occurrenceDay(args.date) };
  if (!args.guard) return { date: args.date };

  const date = occurrenceDay(args.date);
  const snappedTo = isOnRhythm(args.meeting, args.sessions, date)
    ? date
    : nextRhythmOnOrAfter(
        args.meeting,
        args.sessions,
        date > args.today ? date : args.today
      );
  let snapped = snappedTo;
  if (!liveOnDate(args.sessions, args.meeting.id, snapped)) {
    const open = nextOpenFrom(args.meeting, args.sessions, snapped, args.today, date);
    if (open) snapped = open;
  }
  const there = liveOnDate(args.sessions, args.meeting.id, snapped);
  return there ? { reuseId: there.id, date: snapped } : { date: snapped };
}

export type ApplyOccurrenceOpts = {
  guard: boolean;
  today: string;
  topics?: Topic[];
  reuseSameDate?: SameDateReuse;
};

/** Apply {@link resolveOccurrence} to a sessions array. */
export function applyOccurrence(
  sessions: Session[],
  meeting: OccurrenceMeeting | undefined,
  spec: Omit<Session, "id">,
  uid: () => string,
  opts: ApplyOccurrenceOpts
): { sessions: Session[]; sessionId: string } {
  const extra = spec.kind === "extra";
  const reuse = opts.reuseSameDate ?? sameDateReuseFor(extra ? "extra" : "addSession", opts.guard);
  if (!meeting) {
    if (reuse !== "none") {
      const hit = sessionOnDate(sessions, spec.meetingId, spec.date, reuse === "any", opts.guard);
      if (hit) return { sessions, sessionId: hit.id };
    }
    const id = uid();
    return { sessions: [...sessions, { ...spec, id }], sessionId: id };
  }
  const plan = resolveOccurrence({
    meeting,
    sessions,
    date: spec.date,
    today: opts.today,
    extra,
    guard: opts.guard,
    reuseSameDate: reuse,
    topics: opts.topics,
  });
  if (plan.reuseId) return { sessions, sessionId: plan.reuseId };
  const id = uid();
  return {
    sessions: [...sessions, { ...spec, id, date: plan.date }],
    sessionId: id,
  };
}
