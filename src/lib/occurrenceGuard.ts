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
 * MCP `ensureOccurrence` already refuses off-rhythm dates and reuses a live
 * row on the same day. `addExtraOccurrence` already reuses same-date. The
 * store's `addSession` and the guest `bookedOn` insert did neither.
 *
 * Behind `singleOccurrenceGuard` (off by default): fold same-meeting
 * same-date sessions, and snap an off-rhythm non-extra booking onto the next
 * rhythm date. One-offs (`kind: "extra"` / `add_extra_occurrence`) still land
 * on the day they were asked for.
 */
import type { Session, Topic, TrackedMeeting } from "../types";
import { nextOpenRhythmDate, sessionsFor } from "./readiness.ts";
import { plannedSlots } from "./topics.ts";

export type OccurrenceMeeting = Pick<
  TrackedMeeting,
  "id" | "rhythm" | "anchorWeekday" | "floorDays" | "nextDate"
>;

export type OccurrencePlan = {
  /** Reuse this live session instead of inserting. */
  reuseId?: string;
  /** Date the new row should carry, when we are inserting. */
  date: string;
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}/;

/** Calendar day of a stored date, so a datetime leftover still matches "YYYY-MM-DD". */
export function occurrenceDay(value: string): string {
  return ISO_DAY.test(value) ? value.slice(0, 10) : value;
}

/** A real meeting on that day — not a skipped week. */
export function liveOnDate(
  sessions: Session[],
  meetingId: string,
  date: string
): Session | undefined {
  const day = occurrenceDay(date);
  return sessions.find(
    (o) => o.meetingId === meetingId && occurrenceDay(o.date) === day && o.kind !== "skipped"
  );
}

function isBookableDate(
  meeting: OccurrenceMeeting,
  sessions: Session[],
  topics: Topic[],
  date: string,
  today: string
): boolean {
  const day = occurrenceDay(date);
  if (meeting.rhythm === "as_needed") return day >= today;
  return plannedSlots(meeting as TrackedMeeting, sessions, topics, today, 26).some(
    (s) => s.date === day
  );
}

/**
 * Where a new occurrence should land.
 *
 * - extras: same-date fold always; any other day is allowed (the intentional
 *   one-off path).
 * - flag off, regular: always create on the requested day — historical
 *   `addSession` behaviour, including duplicates.
 * - flag on, regular: fold same-date; keep on-rhythm / as-needed days;
 *   otherwise snap to the next rhythm date (and fold if that day is already
 *   booked).
 */
export function resolveOccurrence(args: {
  meeting: OccurrenceMeeting;
  sessions: Session[];
  date: string;
  today: string;
  extra?: boolean;
  guard: boolean;
  topics?: Topic[];
}): OccurrencePlan {
  const date = occurrenceDay(args.date);
  const live = liveOnDate(args.sessions, args.meeting.id, date);

  if (args.extra) {
    return live ? { reuseId: live.id, date } : { date };
  }
  if (!args.guard) return { date };
  if (live) return { reuseId: live.id, date };

  const topics = args.topics ?? [];
  if (isBookableDate(args.meeting, args.sessions, topics, date, args.today)) {
    return { date };
  }

  const next = nextOpenRhythmDate(
    args.meeting as TrackedMeeting,
    sessionsFor(args.meeting.id, args.sessions),
    args.today
  );
  if (!next || next === date) return { date };
  const there = liveOnDate(args.sessions, args.meeting.id, next);
  return there ? { reuseId: there.id, date: next } : { date: next };
}

/** Apply {@link resolveOccurrence} to a sessions array. */
export function applyOccurrence(
  sessions: Session[],
  meeting: OccurrenceMeeting | undefined,
  spec: Omit<Session, "id">,
  uid: () => string,
  opts: { guard: boolean; today: string; topics?: Topic[] }
): { sessions: Session[]; sessionId: string } {
  const extra = spec.kind === "extra";
  if (!meeting) {
    if (opts.guard) {
      const live = liveOnDate(sessions, spec.meetingId, spec.date);
      if (live) return { sessions, sessionId: live.id };
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
    topics: opts.topics,
  });
  if (plan.reuseId) return { sessions, sessionId: plan.reuseId };
  const id = uid();
  return {
    sessions: [...sessions, { ...spec, id, date: plan.date }],
    sessionId: id,
  };
}
