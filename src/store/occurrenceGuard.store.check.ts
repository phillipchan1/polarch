import "../lib/nodeDomShim.ts";
import type { Session, Topic, TrackedMeeting } from "../types";
import { setFlagForTests } from "../lib/flags";
import { useStore } from "./useStore";

/**
 * Run with `npm run test:guard` (bundled after occurrenceGuard.check).
 * Drives the real Zustand store the way QA did: placeTopicsAt / placeTopicAt /
 * captureTopics with the flag off (master counts) and on (still 1 meeting).
 */

const fails: string[] = [];
let checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  if (!cond) fails.push(msg);
}

const meeting: TrackedMeeting = {
  id: "m1",
  subjectKind: "person",
  subjectId: "p1",
  name: "Meghan 1:1",
  rhythm: "weekly",
  anchorWeekday: 4,
};

const PROJECTED = "2026-11-12"; // Thursday

const topic = (id: string): Topic => ({
  id,
  meetingId: meeting.id,
  text: id,
  status: "open",
  lane: "backlog",
  tagIds: [],
  carried: 0,
  carriedFrom: [],
  createdOn: "2026-11-01",
  order: 0,
});

function reset(sessions: Session[] = [], topics: Topic[] = []) {
  useStore.setState({
    meetings: [meeting],
    sessions,
    topics,
    people: [{ id: "p1", name: "Meghan Lee", assessments: {}, strengths: [], watchOuts: [] }],
    tags: [],
  });
}

function sameDay(): Session[] {
  return useStore.getState().sessions.filter((o) => o.date === PROJECTED);
}

const projected = { kind: "projected" as const, date: PROJECTED, meetingId: meeting.id };

setFlagForTests("singleOccurrenceGuard", undefined);

{
  reset([], [topic("a"), topic("b"), topic("c")]);
  useStore.getState().placeTopicsAt(["a", "b", "c"], projected, 0);
  ok(sameDay().length === 1, "flag off: placeTopicsAt([a,b,c], projected) makes 1 meeting (master)");
}

{
  reset([{ id: "have", meetingId: meeting.id, date: PROJECTED }], [topic("a")]);
  useStore.getState().placeTopicAt("a", projected, 0);
  ok(sameDay().length === 1 && sameDay()[0].id === "have", "flag off: placeTopicAt onto an existing date reuses it (master)");
}

{
  reset([{ id: "have", meetingId: meeting.id, date: PROJECTED }], []);
  useStore.getState().captureTopics("one\ntwo", projected, 0);
  ok(sameDay().length === 1 && sameDay()[0].id === "have", "flag off: captureTopics into an existing week reuses it (master)");
}

{
  reset(
    [{ id: "iso", meetingId: meeting.id, date: "2026-11-12T00:00:00.000Z" }],
    [topic("a")]
  );
  useStore.getState().placeTopicAt("a", projected, 0);
  ok(
    useStore.getState().sessions.length === 2,
    "flag off: a datetime-stored week does not match YYYY-MM-DD, so placeTopicAt inserts (master)"
  );
}

setFlagForTests("singleOccurrenceGuard", true);

{
  reset([], [topic("a"), topic("b"), topic("c")]);
  useStore.getState().placeTopicsAt(["a", "b", "c"], projected, 0);
  ok(sameDay().length === 1, "flag on: placeTopicsAt([a,b,c], projected) makes 1 meeting");
}

{
  reset([{ id: "have", meetingId: meeting.id, date: PROJECTED }], [topic("a")]);
  useStore.getState().placeTopicAt("a", projected, 0);
  ok(sameDay().length === 1, "flag on: placeTopicAt onto an existing date makes 1 meeting");
}

{
  reset([{ id: "have", meetingId: meeting.id, date: PROJECTED }], []);
  useStore.getState().captureTopics("one\ntwo", projected, 0);
  ok(sameDay().length === 1, "flag on: captureTopics into an existing week makes 1 meeting");
}

{
  const last: Session = { id: "nov5", meetingId: meeting.id, date: "2026-11-05" };
  for (const day of ["2026-11-13", "2026-11-14", "2026-11-15"] as const) {
    reset([last], []);
    useStore.getState().addSession({ meetingId: meeting.id, date: day });
    const landed = useStore.getState().sessions.map((o) => o.date).sort();
    ok(
      landed.join() === "2026-11-05,2026-11-19",
      `flag on: addSession(${day}) snaps forward to Nov 19, not back to Nov 12`
    );
  }
}

setFlagForTests("singleOccurrenceGuard", undefined);

if (fails.length) {
  console.error(`occurrenceGuard.store.check: ${fails.length}/${checks} failed`);
  for (const f of fails) console.error("  -", f);
  process.exit(1);
}
console.log(`occurrenceGuard.store.check: ${checks} checks passed`);
// useStore starts a poller and a hanging auth fetch; don't keep the process alive.
process.exit(0);
