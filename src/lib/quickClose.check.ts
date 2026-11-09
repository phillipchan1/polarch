/**
 * Run with `npm run test:quick-close`.
 *
 * Quick close (issue #25): with the flag on, a Loose-end meeting files and
 * its topics end up covered, rolled or parked. With the flag off, nothing
 * is offered.
 */
import type { Session, Topic, TrackedMeeting } from "../types";
import { FLAG_DEFAULTS, flagOn, flagsFromQuery } from "./flags";
import {
  applyQuickClose,
  closeRecord,
  DEFAULT_DISPOSITION,
  lastHeldSession,
  quickCloseAvailable,
  quickCloseCommands,
  quickCloseTopics,
  type TopicDisposition,
} from "./quickClose";
import { readinessOf } from "./readiness";
import type { AgendaState, OpEnv } from "./agendaOps";

const fails: string[] = [];
let checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  if (!cond) fails.push(msg);
}

const TODAY = "2026-11-09";
let n = 0;
const env = (): OpEnv => ({ uid: () => `id${++n}`, today: TODAY });

const meeting: TrackedMeeting = {
  id: "m-staff",
  name: "Frontier Staff",
  subjectKind: "team",
  subjectId: "t1",
  rhythm: "weekly",
  anchorWeekday: 4,
};

const last: Session = { id: "o-last", meetingId: "m-staff", date: "2026-11-05" };

const topic = (id: string, text: string, over: Partial<Topic> = {}): Topic => ({
  id,
  meetingId: "m-staff",
  text,
  status: "open",
  lane: "backlog",
  tagIds: [],
  sessionId: last.id,
  carried: 0,
  carriedFrom: [],
  createdOn: "2026-10-01",
  order: 0,
  ...over,
});

function state(over: Partial<AgendaState> = {}): AgendaState {
  return {
    meetings: [meeting],
    sessions: [last],
    topics: [
      topic("t-cover", "WhenIWork", { order: 0 }),
      topic("t-roll", "Budget", { order: 1 }),
      topic("t-park", "Parking lot", { order: 2 }),
    ],
    followUps: [],
    tags: [],
    ...over,
  };
}

const reading = (s: AgendaState) =>
  readinessOf(meeting, { meetings: s.meetings, sessions: s.sessions, topics: s.topics }, TODAY);

const dispositions: Record<string, TopicDisposition> = {
  "t-cover": "covered",
  "t-roll": "next_week",
  "t-park": "park",
};

// ── Flag defaults off, in every environment ──────────────────────────────
ok(FLAG_DEFAULTS.quickClose === false, "quickClose defaults off");
ok(flagOn("quickClose") === false, "flagOn() is off with no override (Node / prod default)");
ok(flagOn("quickClose", { quickClose: false }) === false, "an explicit off override stays off");
ok(flagOn("quickClose", { quickClose: true }) === true, "an explicit on override is on");
ok(
  JSON.stringify(flagsFromQuery("")) === "{}",
  "an empty query enables nothing",
);
ok(
  flagsFromQuery("?flag=quickClose").quickClose === true,
  "?flag=quickClose is the QA override",
);
ok(
  flagsFromQuery("?tab=today").quickClose === undefined,
  "an unrelated query does not enable the flag",
);

// ── Flag off: no entry points, even when a meeting is a Loose end ────────
{
  const s0 = state();
  const r = reading(s0);
  ok(r.state === "loose_end", "fixture starts as Loose end (no notes on last occurrence)");
  ok(quickCloseAvailable(false, r) === null, "flag off: Today does not offer Quick close");
  ok(
    quickCloseCommands(false, [{ meetingId: meeting.id, title: "Frontier Staff", readiness: r }]).length === 0,
    "flag off: ⌘K has no Quick close command",
  );
  ok(
    quickCloseAvailable(false, r) === quickCloseAvailable(false, reading(applyQuickClose(s0, env(), { sessionId: last.id, dispositions }))),
    "flag off: availability stays null even after a close (UI never offered it)",
  );
}

// ── Flag on: Loose end is offered; other states are not ──────────────────
{
  const s0 = state();
  const r = reading(s0);
  ok(quickCloseAvailable(true, r) === last.id, "flag on: Loose end offers the unwritten occurrence");
  const cmds = quickCloseCommands(true, [
    { meetingId: meeting.id, title: "Frontier Staff", readiness: r },
  ]);
  ok(cmds.length === 1 && cmds[0].sessionId === last.id, "flag on: ⌘K lists Quick close for that meeting");
  ok(cmds[0].title === "Frontier Staff", "⌘K names the meeting");

  const written = { ...s0, sessions: [{ ...last, notes: "Already filed." }] };
  ok(
    quickCloseAvailable(true, reading(written)) === null,
    "flag on: a meeting that is already written up is not offered",
  );
}

// ── Topics Quick close asks about ────────────────────────────────────────
{
  const s0 = state();
  const asked = quickCloseTopics(s0.topics, last.id);
  ok(asked.map((t) => t.id).join() === "t-cover,t-roll,t-park", "open topics on the occurrence are asked");

  const alreadyRolled: Topic = topic("t-rolled", "Already next week", {
    sessionId: "o-next",
    carriedFrom: [last.id],
    order: 3,
  });
  ok(
    quickCloseTopics([...s0.topics, alreadyRolled], last.id).some((t) => t.id === "t-rolled"),
    "a topic sweep-on-load already rolled out of this occurrence is still asked",
  );
  ok(
    quickCloseTopics(s0.topics, last.id).every((t) => t.status === "open"),
    "covered or dropped topics are not asked",
  );
}

// ── Applying dispositions clears Loose end ───────────────────────────────
{
  n = 0;
  const s0 = state();
  ok(reading(s0).state === "loose_end", "before: Loose end");
  const closed = applyQuickClose(s0, env(), { sessionId: last.id, dispositions });
  const after = reading(closed);
  ok(after.state !== "loose_end", "after: the meeting is no longer Loose end");
  ok(
    after.checks.find((c) => c.id === "writeUp")?.done === true,
    "after: the write-up check passes",
  );

  const covered = closed.topics.find((t) => t.id === "t-cover")!;
  ok(covered.status === "covered" && covered.closedOn === TODAY, "Covered marks the topic covered today");

  const rolled = closed.topics.find((t) => t.id === "t-roll")!;
  ok(rolled.status === "open", "Next week keeps the topic open");
  ok(rolled.sessionId !== last.id, "Next week moves it off the closed occurrence");
  ok((rolled.carried ?? 0) >= 1, "Next week counts as a carry");
  const dest = closed.sessions.find((o) => o.id === rolled.sessionId);
  ok(Boolean(dest && dest.date > last.date), "Next week lands on a later occurrence");

  const parked = closed.topics.find((t) => t.id === "t-park")!;
  ok(parked.lane === "parked" && !parked.sessionId, "Park sets the lane and clears the occurrence");

  ok(Boolean(closed.sessions.find((o) => o.id === last.id)?.notes?.trim()), "the occurrence now has notes");
  ok(
    (closed.sessions.find((o) => o.id === last.id)?.notes ?? "").includes("WhenIWork"),
    "the write-up names what was covered",
  );
}

// ── Next week on an already-rolled topic does not skip another week ──────
{
  n = 0;
  const nextSess: Session = { id: "o-next", meetingId: "m-staff", date: "2026-11-12" };
  const rolled = topic("t-rolled", "WhenIWork", {
    sessionId: nextSess.id,
    carriedFrom: [last.id],
    carried: 1,
  });
  const s0 = state({ sessions: [last, nextSess], topics: [rolled] });
  const closed = applyQuickClose(s0, env(), {
    sessionId: last.id,
    dispositions: { "t-rolled": "next_week" },
  });
  ok(
    closed.topics[0].sessionId === nextSess.id && closed.topics[0].carried === 1,
    "Next week on an already-rolled topic leaves it on that week",
  );
}

// ── Own notes are kept, and a meeting with no topics still clears ────────
{
  n = 0;
  const empty = state({ topics: [] });
  const closed = applyQuickClose(empty, env(), {
    sessionId: last.id,
    dispositions: {},
    notes: "Staff notes went into Polarch today.",
  });
  ok(
    closed.sessions[0].notes === "Staff notes went into Polarch today.",
    "the leader's notes are the write-up when there is nothing to disposition",
  );
  ok(reading(closed).state !== "loose_end", "a no-topic close still leaves Loose end");

  const withBoth = closeRecord(
    [topic("a", "WhenIWork")],
    { a: "covered" },
    "Talked through the schedule.",
  );
  ok(
    withBoth.startsWith("Talked through the schedule.") && withBoth.includes("WhenIWork"),
    "own notes sit above the disposition ledger",
  );
  ok(DEFAULT_DISPOSITION === "next_week", "unrecorded topics default to next week, not covered");
}

ok(lastHeldSession(state().sessions, "m-staff", TODAY)?.id === last.id, "lastHeldSession is the unwritten occurrence");

if (fails.length) {
  console.error(`quickClose.check: ${fails.length}/${checks} failed`);
  for (const f of fails) console.error("  -", f);
  process.exit(1);
}
console.log(`quickClose.check: ${checks} checks passed`);
