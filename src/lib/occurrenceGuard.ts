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
 *   so dropping three cards on a projected week still books it once.
 * - extras: never reuse through this helper; `addExtraOccurrence` has its
 *   own live-same-date fold on the store path.
 *
 * Behind `singleOccurrenceGuard`: fold a live same-date session, keep
 * on-rhythm dates (including a missed past week), and snap only off-rhythm
 * dates onto the nearest rhythm day relative to the intended date — never
 * pulling a past log forward past today. One-offs still land on the day
 * they were asked for.
 */
import type { Session, Topic, TrackedMeeting } from "../types";
import {
  addDays,
  daysBetween,
  lastRhythmDate,
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
  includeSkipped: boolean
): Session | undefined {
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
  return sessionOnDate(sessions, meetingId, date, false);
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

function nearestRhythmDate(
  meeting: OccurrenceMeeting,
  sessions: Session[],
  intended: string,
  today: string
): string {
  const span = enclosingRhythm(meeting, sessions, intended);
  if (!span) return intended;
  if (span.before === intended || span.after === intended) return intended;

  const back = daysBetween(span.before, intended);
  const fwd = daysBetween(intended, span.after);
  let pick = fwd <= back ? span.after : span.before;
  // A missed week stays in the past. Never pull it forward onto next week's
  // upcoming occurrence just because plannedSlots starts at today.
  if (intended < today && pick > today) {
    if (span.before <= today) pick = span.before;
    else return intended;
  }
  return pick;
}

/** Next series date at or after `from` that isn't a skipped/moved-away week. */
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
    if (!taken.has(d)) {
      if (intended < today && d > today) return null;
      return d;
    }
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
  const date = occurrenceDay(args.date);
  const reuse = args.reuseSameDate ?? sameDateReuseFor(args.extra ? "extra" : "addSession", args.guard);

  if (args.extra && !args.guard) return { date };

  if (reuse !== "none") {
    const hit = sessionOnDate(args.sessions, args.meeting.id, date, reuse === "any");
    if (hit) return { reuseId: hit.id, date };
  }

  if (args.extra) return { date };
  if (!args.guard) return { date };

  let snapped = nearestRhythmDate(args.meeting, args.sessions, date, args.today);
  if (!liveOnDate(args.sessions, args.meeting.id, snapped)) {
    const open = nextOpenFrom(args.meeting, args.sessions, snapped, args.today, date);
    if (open) snapped = open;
  }
  if (snapped === date) {
    // Still on the intended day: only fold a live row (skipped already missed above).
    const live = liveOnDate(args.sessions, args.meeting.id, snapped);
    return live ? { reuseId: live.id, date: snapped } : { date: snapped };
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
      const hit = sessionOnDate(sessions, spec.meetingId, spec.date, reuse === "any");
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
