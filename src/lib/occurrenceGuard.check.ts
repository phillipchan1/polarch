import type { Session, TrackedMeeting } from "../types";
import {
  applyOccurrence,
  resolveOccurrence,
  sameDateReuseFor,
} from "./occurrenceGuard";
import { FLAGS, setFlagForTests } from "./flags";

/** Run with `npm run test:guard`. Repro for issue #26, flag off then on. */

const fails: string[] = [];
let checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  if (!cond) fails.push(msg);
}

let n = 0;
const uid = () => `s${++n}`;

const weekly: TrackedMeeting = {
  id: "m-meghan",
  subjectKind: "person",
  subjectId: "p1",
  name: "Meghan 1:1",
  rhythm: "weekly",
  anchorWeekday: 4, // Thursday
};

const asNeeded: TrackedMeeting = {
  id: "m-flex",
  subjectKind: "team",
  subjectId: "t1",
  rhythm: "as_needed",
};

const session = (date: string, over: Partial<Session> = {}): Session => ({
  id: `have-${date}`,
  meetingId: weekly.id,
  date,
  ...over,
});

function book(
  sessions: Session[],
  date: string,
  guard: boolean,
  meeting: TrackedMeeting = weekly,
  extra = false,
  today = "2026-10-07"
) {
  return applyOccurrence(
    sessions,
    meeting,
    { meetingId: meeting.id, date, kind: extra ? "extra" : undefined },
    uid,
    { guard, today }
  );
}

/** The store's placement / captureTopics path: reuse any same-date row when the flag is off. */
function place(
  sessions: Session[],
  date: string,
  guard: boolean,
  meeting: TrackedMeeting = weekly,
  today = date
) {
  return applyOccurrence(
    sessions,
    meeting,
    { meetingId: meeting.id, date },
    uid,
    { guard, today, reuseSameDate: sameDateReuseFor("placement", guard) }
  );
}

function dates(sessions: Session[]): string[] {
  return sessions
    .filter((o) => o.kind !== "skipped")
    .map((o) => o.date)
    .sort();
}

function onDate(sessions: Session[], date: string): Session[] {
  return sessions.filter((o) => o.date === date);
}

// Restore whatever a previous check flipped.
setFlagForTests("singleOccurrenceGuard", undefined);
ok(FLAGS.singleOccurrenceGuard === false, "singleOccurrenceGuard defaults OFF so a master merge cannot change prod");

// ── same-date duplicates (two on Oct 23) ─────────────────────────────────
{
  n = 0;
  const first = book([], "2026-10-23", false, weekly, false, "2026-10-23");
  const twice = book(first.sessions, "2026-10-23", false, weekly, false, "2026-10-23");
  ok(
    twice.sessions.length === 2 && twice.sessionId !== first.sessionId,
    "flag off: addSession twice on Oct 23 creates two rows (the Meghan / Sunday Service bug)"
  );

  n = 0;
  const a = book([], "2026-10-23", true, weekly, false, "2026-10-23");
  const b = book(a.sessions, "2026-10-23", true, weekly, false, "2026-10-23");
  ok(b.sessions.length === 1 && b.sessionId === a.sessionId, "flag on: the second Oct 23 book folds into the first");
  ok(b.sessions === a.sessions, "flag on: folding does not allocate a new sessions array");
}

// ── consecutive-day run (Meghan Oct 6–10) ────────────────────────────────
{
  n = 0;
  // A weekly Thursday 1:1 already logged on Tuesday Oct 6 (the "book it today" path).
  const held = [session("2026-10-06")];
  const off = book(held, "2026-10-07", false);
  ok(
    dates(off.sessions).join() === "2026-10-06,2026-10-07",
    "flag off: booking Wednesday after Tuesday creates a consecutive-day run"
  );

  const on = book(held, "2026-10-07", true);
  const plan = resolveOccurrence({
    meeting: weekly,
    sessions: held,
    date: "2026-10-07",
    today: "2026-10-07",
    guard: true,
  });
  ok(plan.date === "2026-10-08" && !plan.reuseId, "flag on: off-rhythm today snaps to this week's Thursday");
  ok(
    on.sessions.length === 2 && dates(on.sessions).join() === "2026-10-06,2026-10-08",
    "flag on: Wednesday becomes Thursday instead of a consecutive-day row"
  );

  // Keep tapping Book through the week. Thursday reuses this week; Fri/Sat
  // snap onto this Thursday (nearest) rather than stacking consecutive days.
  let cur = on.sessions;
  for (const day of ["2026-10-08", "2026-10-09", "2026-10-10"]) {
    const next = book(cur, day, true, weekly, false, day);
    cur = next.sessions;
  }
  ok(!dates(cur).some((d) => d === "2026-10-07" || d === "2026-10-09" || d === "2026-10-10"), "flag on: Wed/Fri/Sat never become their own rows");
  ok(
    dates(cur).join() === "2026-10-06,2026-10-08",
    "flag on: leftover Tuesday + this Thursday, no consecutive-day run"
  );
}

// ── no history: first "today" starts the series; the next day snaps ──────
{
  n = 0;
  const unanchored: TrackedMeeting = { ...weekly, anchorWeekday: undefined };
  const day1 = book([], "2026-10-06", true, unanchored, false, "2026-10-06");
  ok(dates(day1.sessions).join() === "2026-10-06", "flag on: a weekly meeting with no history may still book today");
  const day2 = book(day1.sessions, "2026-10-07", true, unanchored, false, "2026-10-07");
  ok(
    dates(day2.sessions).join() === "2026-10-06" && day2.sessionId === day1.sessionId,
    "flag on: the next day's Book folds into yesterday instead of stacking Tuesday"
  );
}

// ── add_extra_occurrence still lands on the day it was asked for ─────────
{
  n = 0;
  const held = [session("2026-10-06")];
  const extra = book(held, "2026-10-07", true, weekly, true, "2026-10-07");
  ok(
    extra.sessions.length === 2 && extra.sessions.some((o) => o.date === "2026-10-07" && o.kind === "extra"),
    "flag on: add_extra_occurrence still creates a one-off on a consecutive day"
  );
  const again = book(extra.sessions, "2026-10-07", true, weekly, true, "2026-10-07");
  ok(again.sessionId === extra.sessionId && again.sessions.length === 2, "a second extra on that day reuses it");

  n = 0;
  const first = book([], "2026-10-07", false, weekly, true, "2026-10-07");
  const twice = book(first.sessions, "2026-10-07", false, weekly, true, "2026-10-07");
  ok(
    twice.sessions.length === 2 && twice.sessionId !== first.sessionId,
    "flag off: same-day extras do not merge"
  );
}

// ── as-needed meetings may still sit on consecutive days ─────────────────
{
  n = 0;
  const a = book([], "2026-10-06", true, asNeeded, false, "2026-10-06");
  const b = book(a.sessions, "2026-10-07", true, asNeeded, false, "2026-10-07");
  ok(
    dates(b.sessions).join() === "2026-10-06,2026-10-07",
    "flag on: as-needed meetings are allowed on consecutive days"
  );
}

// ── skipped weeks are not reused as a live meeting ───────────────────────
{
  n = 0;
  const skipped = [session("2026-10-08", { kind: "skipped", seriesDate: "2026-10-08" })];
  const plan = resolveOccurrence({
    meeting: weekly,
    sessions: skipped,
    date: "2026-10-08",
    today: "2026-10-07",
    guard: true,
  });
  ok(plan.reuseId === undefined, "a skipped Thursday is not a live session to fold into");
  ok(plan.date === "2026-10-15", "flag on: booking the skipped week snaps to the next Thursday");
}

// ── datetime leftovers still fold onto the calendar day ──────────────────
{
  n = 0;
  const messy: Session[] = [
    { id: "iso", meetingId: weekly.id, date: "2026-10-23T00:00:00.000Z" },
  ];
  const folded = book(messy, "2026-10-23", true, weekly, false, "2026-10-23");
  ok(folded.sessionId === "iso" && folded.sessions.length === 1, "flag on: a datetime date still matches YYYY-MM-DD");
}

// ── placement / captureTopics (QA: three same-day cases vs master) ───────
{
  const projected = "2026-11-12"; // Thursday

  n = 0;
  let drop: Session[] = [];
  for (let i = 0; i < 3; i++) drop = place(drop, projected, false).sessions;
  ok(
    onDate(drop, projected).length === 1,
    "flag off: placeTopicsAt dropping 3 topics on a projected week makes 1 meeting (master)"
  );

  n = 0;
  const have = [session(projected)];
  const stale = place(have, projected, false);
  ok(
    stale.sessions.length === 1 && stale.sessionId === have[0].id,
    "flag off: placeTopicAt on a date that already has a meeting reuses it (master)"
  );

  n = 0;
  const typed = place(have, projected, false);
  ok(
    typed.sessions.length === 1 && typed.sessionId === have[0].id,
    "flag off: captureTopics into a week that already has a meeting reuses it (master)"
  );

  n = 0;
  let dropOn: Session[] = [];
  for (let i = 0; i < 3; i++) dropOn = place(dropOn, projected, true).sessions;
  ok(onDate(dropOn, projected).length === 1, "flag on: placeTopicsAt of 3 topics still makes 1 meeting");

  n = 0;
  const staleOn = place(have, projected, true);
  ok(staleOn.sessions.length === 1 && staleOn.sessionId === have[0].id, "flag on: placeTopicAt reuses the existing meeting");

  n = 0;
  const typedOn = place(have, projected, true);
  ok(typedOn.sessions.length === 1 && typedOn.sessionId === have[0].id, "flag on: captureTopics reuses the existing meeting");
}

// ── logging a missed past week must not snap forward ─────────────────────
{
  n = 0;
  const last = [session("2026-10-22")];
  const missed = book(last, "2026-10-29", true, weekly, false, "2026-11-09");
  ok(
    dates(missed.sessions).join() === "2026-10-22,2026-10-29",
    "flag on: a past on-rhythm Thursday (Oct 29) stays Oct 29"
  );

  n = 0;
  const wed = book(last, "2026-10-28", true, weekly, false, "2026-11-09");
  ok(
    dates(wed.sessions).join() === "2026-10-22,2026-10-29" && !wed.sessions.some((o) => o.date > "2026-11-09"),
    "flag on: a past off-rhythm Wednesday snaps to that week's Thursday, never after today"
  );

  n = 0;
  const monday = book(last, "2026-11-09", true, weekly, false, "2026-11-09");
  ok(
    dates(monday.sessions).join() === "2026-10-22,2026-11-12",
    "flag on: off-rhythm today still snaps to this week's Thursday"
  );
}

if (fails.length) {
  console.error(`occurrenceGuard.check: ${fails.length}/${checks} failed`);
  for (const f of fails) console.error("  -", f);
  process.exit(1);
}
console.log(`occurrenceGuard.check: ${checks} checks passed`);
