import "../lib/nodeDomShim.ts";
import type { Session, Topic, TrackedMeeting } from "../types";
import { setFlagForTests } from "../lib/flags";
import { todayISO } from "../lib/health";
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
      `flag on: addSession(${day}) with no Thursday this week creates next Thursday Nov 19`
    );
  }
}

{
  const thisWeek: Session[] = [
    { id: "nov5", meetingId: meeting.id, date: "2026-11-05" },
    { id: "nov12", meetingId: meeting.id, date: "2026-11-12" },
  ];
  for (const day of ["2026-11-13", "2026-11-14", "2026-11-15"] as const) {
    reset(thisWeek, []);
    const id = useStore.getState().addSession({ meetingId: meeting.id, date: day });
    const st = useStore.getState();
    ok(
      id === "nov12" && st.sessions.length === 2 && st.happenedTodaySessionId === null,
      `flag on: addSession(${day}) opens this week's existing Thursday instead of creating next week`
    );
  }
}

{
  reset(
    [
      { id: "nov5", meetingId: meeting.id, date: "2026-11-05" },
      { id: "nov19", meetingId: meeting.id, date: "2026-11-19" },
    ],
    []
  );
  useStore.setState({ happenedTodaySessionId: "nov19" });
  useStore.getState().logHappenedToday("nov19");
  const after = useStore.getState();
  const today = todayISO();
  ok(
    after.sessions.some((o) => o.id === "nov19" && o.date === today) &&
      !after.sessions.some((o) => o.date === "2026-11-19") &&
      after.happenedTodaySessionId === null,
    "flag on: logHappenedToday moves the created next-Thursday book onto today"
  );
}

{
  reset([{ id: "oct22", meetingId: meeting.id, date: "2026-10-22" }], []);
  useStore.getState().addSession({ meetingId: meeting.id, date: "2026-10-27" });
  ok(
    useStore.getState().sessions.map((o) => o.date).sort().join() === "2026-10-22,2026-10-27",
    "flag on: addSession of past off-rhythm Tue Oct 27 lands on Oct 27"
  );
}

{
  reset([{ id: "oct22", meetingId: meeting.id, date: "2026-10-22" }], []);
  useStore.getState().addSession({ meetingId: meeting.id, date: "2026-10-29" });
  ok(
    useStore.getState().sessions.map((o) => o.date).sort().join() === "2026-10-22,2026-10-29",
    "flag on: addSession of past on-rhythm Thu Oct 29 stays Oct 29"
  );
}

setFlagForTests("singleOccurrenceGuard", undefined);

{
  reset([{ id: "nov12", meetingId: meeting.id, date: PROJECTED }], []);
  const id = useStore.getState().addSession({ meetingId: meeting.id, date: "2026-11-13" });
  const st = useStore.getState();
  ok(
    st.sessions.length === 2 &&
      id !== "nov12" &&
      st.sessions.some((o) => o.date === "2026-11-13") &&
      st.happenedTodaySessionId === null,
    "flag off: addSession on Friday with Thursday existing inserts Friday (master)"
  );
}

{
  reset(
    [
      { id: "nov5", meetingId: meeting.id, date: "2026-11-05" },
      { id: "nov19", meetingId: meeting.id, date: "2026-11-19" },
    ],
    []
  );
  useStore.setState({ happenedTodaySessionId: "nov19" });
  useStore.getState().logHappenedToday("nov19");
  ok(
    useStore.getState().sessions.some((o) => o.id === "nov19" && o.date === "2026-11-19"),
    "flag off: logHappenedToday is a no-op"
  );
}

if (fails.length) {
  console.error(`occurrenceGuard.store.check: ${fails.length}/${checks} failed`);
  for (const f of fails) console.error("  -", f);
  process.exit(1);
}
console.log(`occurrenceGuard.store.check: ${checks} checks passed`);
// useStore starts a poller and a hanging auth fetch; don't keep the process alive.
process.exit(0);
