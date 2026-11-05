import type { Session, Tag, Topic, TrackedMeeting } from "../types";
import {
  addExtraOccurrence,
  addFollowUp,
  addTopics,
  createMeeting,
  createTag,
  deleteFollowUp,
  deleteTag,
  deleteTopics,
  ensureOccurrence,
  moveOccurrence,
  OpError,
  placeTopics,
  promoteToFollowUp,
  restoreOccurrence,
  rollTopicsForward,
  setSections,
  setTopicsCovered,
  skipOccurrence,
  updateFollowUp,
  updateMeeting,
  updateOccurrence,
  updateTag,
  updateTopic,
  type AgendaState,
  type OpEnv,
} from "./agendaOps";
import { plannedSlots } from "./topics";

/** Run with `npm run test:agenda`. The rules the store enforces, pinned. */

const fails: string[] = [];
let checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  if (!cond) fails.push(msg);
}
function throwsOp(fn: () => unknown, code: OpError["code"], msg: string, match?: RegExp) {
  checks++;
  try {
    fn();
    fails.push(`${msg} (did not throw)`);
  } catch (err) {
    if (!(err instanceof OpError)) fails.push(`${msg} (threw ${String(err)})`);
    else if (err.code !== code) fails.push(`${msg} (code ${err.code}, wanted ${code})`);
    else if (match && !match.test(err.message)) fails.push(`${msg} (message: ${err.message})`);
  }
}

let n = 0;
const env = (today = "2026-10-27"): OpEnv => ({ uid: () => `id${++n}`, today });
// 2026-10-27 is a Tuesday. The 1:1 meets Thursdays: 10-29, 11-05, 11-12, 11-19…
const TODAY = "2026-10-27";

const tags: Tag[] = [
  { id: "tg-check", label: "Check-in", color: 0, order: 0 },
  { id: "tg-grow", label: "Growth", color: 1, order: 1 },
  { id: "tg-misc", label: "Misc", color: 2, order: 2 },
];
const meeting: TrackedMeeting = {
  id: "m1",
  subjectKind: "person",
  subjectId: "p1",
  rhythm: "weekly",
  anchorWeekday: 4,
  curriculum: [
    { id: "sec-check", label: "Check-in", tagId: "tg-check" },
    { id: "sec-grow", label: "Growth", tagId: "tg-grow" },
  ],
};
const asNeeded: TrackedMeeting = { id: "m2", subjectKind: "team", subjectId: "t1", rhythm: "as_needed" };

const topic = (id: string, over: Partial<Topic> = {}): Topic => ({
  id,
  meetingId: "m1",
  text: id,
  status: "open",
  lane: "backlog",
  tagIds: [],
  carried: 0,
  carriedFrom: [],
  createdOn: "2026-10-01",
  order: 0,
  ...over,
});

function base(over: Partial<AgendaState> = {}): AgendaState {
  return { meetings: [meeting, asNeeded], sessions: [], topics: [], followUps: [], tags, ...over };
}
const dates = (s: AgendaState) =>
  plannedSlots(s.meetings[0], s.sessions, s.topics, TODAY, 5)
    .filter((x) => !x.past)
    .map((x) => x.date);

// ── addTopics ────────────────────────────────────────────────────────────
{
  const s0 = base();
  const r = addTopics(s0, env(), [{ meetingId: "m1", text: "  Her workload  ", urgent: true }]);
  const t = r.value.topics[0];
  ok(t.text === "Her workload", "addTopics trims the text");
  ok(t.lane === "backlog" && !t.sessionId, "addTopics with no date lands in the tray");
  ok(t.urgent === true, "addTopics keeps urgent");
  ok(t.createdOn === TODAY, "addTopics stamps today's date from env");
  ok(r.state.meetings === s0.meetings && r.state.tags === s0.tags, "addTopics leaves other collections identical");

  const inbox = addTopics(s0, env(), [{ text: "Something to raise someday" }]);
  ok(inbox.value.topics[0].meetingId === undefined, "addTopics without a meeting is an inbox idea");

  const sec = addTopics(s0, env(), [{ meetingId: "m1", text: "Promotion path", slotId: "sec-grow" }]);
  ok(sec.value.topics[0].tagIds.includes("tg-grow"), "a section's tag is stamped on arrival");

  const dated = addTopics(s0, env(), [
    { meetingId: "m1", text: "a", date: "2026-11-05" },
    { meetingId: "m1", text: "b", date: "2026-11-05" },
  ]);
  ok(dated.state.sessions.length === 1, "two topics on one projected week book it once");
  ok(dated.value.booked.length === 1 && dated.value.booked[0].date === "2026-11-05", "the booking is reported");
  ok(dated.value.topics.every((t) => t.sessionId === dated.state.sessions[0].id), "both are slotted into it");
  ok(dated.value.topics[0].order === 0 && dated.value.topics[1].order === 1, "topics keep the order given");

  throwsOp(() => addTopics(s0, env(), [{ meetingId: "m1", text: "x", date: "2026-10-30" }]), "invalid", "a Friday is off the Thursday rhythm", /isn't an occurrence/);
  throwsOp(() => addTopics(s0, env(), [{ meetingId: "m1", text: "x", date: "2026-10-22" }]), "invalid", "a past date is refused", /past/);
  throwsOp(() => addTopics(s0, env(), [{ meetingId: "m1", text: "x", date: "11/05/2026" }]), "invalid", "a malformed date is refused");
  throwsOp(() => addTopics(s0, env(), [{ meetingId: "nope", text: "x" }]), "not_found", "unknown meeting");
  throwsOp(() => addTopics(s0, env(), [{ meetingId: "m1", text: "x", slotId: "nope" }]), "invalid", "unknown section lists the sections", /no section/);
  throwsOp(() => addTopics(s0, env(), [{ meetingId: "m1", text: "x", tagIds: ["ghost"] }]), "invalid", "unknown tag");
  throwsOp(() => addTopics(s0, env(), [{ meetingId: "m1", text: "   " }]), "invalid", "blank text");
  throwsOp(() => addTopics(s0, env(), [{ text: "x", date: "2026-11-05" }]), "invalid", "a date needs a meeting");
  try {
    addTopics(s0, env(), [{ meetingId: "m1", text: "x", date: "2026-10-30" }]);
  } catch (e) {
    const up = (e as OpError).details?.upcoming as string[] | undefined;
    ok(Array.isArray(up) && up[0] === "2026-10-29", "the error offers the real upcoming dates");
  }

  const loose = addTopics(base({ meetings: [meeting, asNeeded] }), env(), [
    { meetingId: "m2", text: "when it's needed", date: "2026-12-14" },
  ]);
  ok(loose.state.sessions[0]?.date === "2026-12-14", "an as-needed meeting can be booked on any future day");
}

// ── placing and moving topics ────────────────────────────────────────────
{
  const s0 = base({
    topics: [topic("a"), topic("b", { order: 1 }), topic("c", { order: 2 })],
  });
  const week = placeTopics(s0, env(), ["a", "b"], { kind: "date", meetingId: "m1", date: "2026-11-05" });
  ok(week.state.sessions.length === 1, "placing on a projected week books it");
  const sid = week.state.sessions[0].id;
  ok(week.state.topics.filter((t) => t.sessionId === sid).length === 2, "both topics are in the week");
  ok(week.state.topics.find((t) => t.id === "c") === s0.topics[2], "an untouched topic keeps its identity");

  const sect = placeTopics(week.state, env(), ["a"], { kind: "session", sessionId: sid, slotId: "sec-check" });
  ok(sect.state.topics.find((t) => t.id === "a")!.tagIds.includes("tg-check"), "moving into a section stamps its tag");
  const swap = placeTopics(sect.state, env(), ["a"], { kind: "session", sessionId: sid, slotId: "sec-grow" });
  const swapped = swap.state.topics.find((t) => t.id === "a")!;
  ok(swapped.tagIds.includes("tg-grow") && !swapped.tagIds.includes("tg-check"), "moving between sections swaps the tag instead of piling them up");

  const back = placeTopics(swap.state, env(), ["a"], { kind: "lane", lane: "backlog" });
  ok(!back.state.topics.find((t) => t.id === "a")!.sessionId, "back to the tray clears the occurrence");

  const parked = placeTopics(week.state, env(), ["b"], { kind: "lane", lane: "parked" });
  const pb = parked.state.topics.find((t) => t.id === "b")!;
  ok(pb.lane === "parked" && !pb.sessionId, "parking clears the occurrence and sets the lane");

  const first = placeTopics(week.state, env(), ["c"], { kind: "session", sessionId: sid }, 0);
  const inWeek = first.state.topics.filter((t) => t.sessionId === sid).sort((x, y) => x.order - y.order);
  ok(inWeek[0].id === "c", "index 0 puts the topic first in the week");
  ok(inWeek.map((t) => t.order).join() === "0,1,2", "the bucket is renumbered");

  const covered = setTopicsCovered(week.state, env(), ["a"], true).state.topics.find((t) => t.id === "a")!;
  ok(covered.status === "covered" && covered.closedOn === TODAY, "covering stamps the closing date");
  const reopened = placeTopics(setTopicsCovered(week.state, env(), ["a"], true).state, env(), ["a"], { kind: "lane", lane: "backlog" });
  ok(reopened.state.topics.find((t) => t.id === "a")!.status === "open", "placing a covered topic reopens it");

  const other = placeTopics(s0, env(), ["a"], { kind: "date", meetingId: "m2", date: "2026-12-14" });
  ok(other.state.topics.find((t) => t.id === "a")!.meetingId === "m2", "a topic can move to another meeting");

  // Moving between weeks keeps the section unless told otherwise.
  const inGrow = placeTopics(week.state, env(), ["a"], { kind: "session", sessionId: sid, slotId: "sec-grow" }).state;
  const keep = placeTopics(inGrow, env(), ["a"], { kind: "date", meetingId: "m1", date: "2026-11-12" }, undefined, true);
  const kept = keep.state.topics.find((t) => t.id === "a")!;
  ok(kept.slotId === "sec-grow" && kept.tagIds.includes("tg-grow"), "keepSection carries the section to the new week");
  const drop = placeTopics(inGrow, env(), ["a"], { kind: "date", meetingId: "m1", date: "2026-11-12" });
  ok(drop.state.topics.find((t) => t.id === "a")!.slotId === undefined, "without keepSection a drop onto no section clears it (the board's behavior)");
  const crossKeep = placeTopics(inGrow, env(), ["a"], { kind: "date", meetingId: "m2", date: "2026-12-14" }, undefined, true);
  ok(crossKeep.state.topics.find((t) => t.id === "a")!.slotId === undefined, "keepSection never carries a section into a different meeting");

  throwsOp(() => placeTopics(s0, env(), ["a", "a"], { kind: "lane", lane: "parked" }), "invalid", "duplicate ids");
  throwsOp(() => placeTopics(s0, env(), ["ghost"], { kind: "lane", lane: "parked" }), "not_found", "unknown topic");
  throwsOp(() => placeTopics(s0, env(), ["a"], { kind: "session", sessionId: "ghost" }), "not_found", "unknown session");
  throwsOp(() => placeTopics(s0, env(), [], { kind: "lane", lane: "parked" }), "invalid", "no ids");

  const del = deleteTopics(s0, ["a"]);
  ok(del.state.topics.length === 2 && del.value[0].id === "a", "deleteTopics removes and reports");
  throwsOp(() => deleteTopics(s0, ["ghost"]), "not_found", "deleting an unknown topic");

  const upd = updateTopic(s0, "a", { text: "Renamed", urgent: true, dueDate: "2026-11-01", tagIds: ["tg-misc"] });
  ok(upd.value.text === "Renamed" && upd.value.urgent === true && upd.value.dueDate === "2026-11-01", "updateTopic patches fields");
  throwsOp(() => updateTopic(s0, "a", { dueDate: "soon" }), "invalid", "bad due date");
  ok(updateTopic(upd.state, "a", { dueDate: null }).value.dueDate === undefined, "null clears the due date");
}

// ── roll forward and follow-ups ──────────────────────────────────────────
{
  const sessions: Session[] = [{ id: "s-10-29", meetingId: "m1", date: "2026-10-29" }];
  const s0 = base({ sessions, topics: [topic("a", { sessionId: "s-10-29" }), topic("b")] });
  const r = rollTopicsForward(s0, env(), ["a"]);
  const a = r.state.topics.find((t) => t.id === "a")!;
  ok(a.carried === 1 && a.carriedFrom.join() === "s-10-29", "rolling counts the carry and remembers where it left");
  ok(a.returnedOn === TODAY && a.returnedFromDate === "2026-10-29", "rolling says when and from where it came back");
  const dest = r.state.sessions.find((o) => o.id === a.sessionId)!;
  ok(dest.date === "2026-11-05", "it lands on the next occurrence");
  ok(r.value.booked.length === 1, "the projected next week is booked on the way");
  ok(r.state.sessions.find((o) => o.id === "s-10-29")!.uncovered?.[0] === "a", "the week it left keeps a ledger of what it didn't cover");

  const to = rollTopicsForward(s0, env(), ["a"], "2026-11-12");
  ok(to.state.sessions.some((o) => o.date === "2026-11-12"), "an explicit date is honoured");
  throwsOp(() => rollTopicsForward(s0, env(), ["b"]), "invalid", "a tray topic has nothing to roll out of", /isn't on an occurrence/);
  throwsOp(() => rollTopicsForward(setTopicsCovered(s0, env(), ["a"], true).state, env(), ["a"]), "invalid", "a covered topic can't roll");

  const promoted = promoteToFollowUp(s0, env(), "a");
  ok(promoted.value.meetingId === "m1" && promoted.value.subjectId === "p1" && promoted.value.status === "open", "promote makes an open follow-up on the meeting's subject");
  ok(promoted.state.topics.find((t) => t.id === "a")!.status === "dropped", "promote drops the topic");
  throwsOp(() => promoteToFollowUp(base({ topics: [topic("x", { meetingId: undefined })] }), env(), "x"), "invalid", "an inbox topic has no meeting to follow up on");

  const f = addFollowUp(s0, env(), { meetingId: "m1", text: "Send the article" });
  const done = updateFollowUp(f.state, env(), f.value.id, { done: true });
  ok(done.value.status === "done" && done.value.closedOn === TODAY, "ticking a follow-up closes it today");
  const again = updateFollowUp(done.state, env(), f.value.id, { done: false });
  ok(again.value.status === "open" && again.value.closedOn === undefined, "unticking reopens it");
  ok(deleteFollowUp(f.state, f.value.id).state.followUps.length === 0, "deleteFollowUp removes it");
}

// ── skipping, moving, restoring ──────────────────────────────────────────
{
  const sessions: Session[] = [{ id: "s5", meetingId: "m1", date: "2026-11-05", notes: "prep" }];
  const s0 = base({ sessions, topics: [topic("a", { sessionId: "s5" }), topic("b", { sessionId: "s5" })] });

  const skip = skipOccurrence(s0, env(), "m1", "2026-11-05");
  const sk = skip.state.sessions.find((o) => o.id === "s5")!;
  ok(sk.kind === "skipped" && sk.seriesDate === "2026-11-05", "skipping holds the series date");
  ok(skip.state.topics.every((t) => !t.sessionId && t.lane === "backlog"), "topics planned for a skipped week return to the backlog");
  ok(skip.value.returnedToBacklog.length === 2, "the topics sent back are reported");
  ok(!dates(skip.state).includes("2026-11-05"), "the rhythm doesn't redraw a skipped week");
  ok(dates(skip.state)[0] === "2026-10-29" && dates(skip.state).includes("2026-11-12"), "the other weeks stay put");

  const projected = skipOccurrence(base(), env(), "m1", "2026-11-12");
  ok(projected.state.sessions.length === 1 && projected.state.sessions[0].kind === "skipped", "skipping a projected week records the skip");
  ok(!dates(projected.state).includes("2026-11-12"), "and the projection steps over it");

  throwsOp(() => skipOccurrence(skip.state, env(), "m1", "2026-11-05"), "conflict", "skipping twice", /already skipped/);
  throwsOp(() => skipOccurrence(base(), env(), "m1", "2026-10-30"), "invalid", "skipping a non-occurrence");

  const restored = restoreOccurrence(skip.state, "m1", "2026-11-05");
  ok(restored.value.restored === "skip", "restore reports what it undid");
  ok(!restored.state.sessions.some((o) => o.kind === "skipped"), "restoring a skip removes the skip");
  ok(dates(restored.state).includes("2026-11-05"), "and the week comes back");

  throwsOp(() => addTopics(skip.state, env(), [{ meetingId: "m1", text: "x", date: "2026-11-05" }]), "conflict", "can't plan into a skipped week", /skipped/);

  const extra = addExtraOccurrence(base(), env(), "m1", "2026-11-03");
  const ex = extra.state.sessions[0];
  ok(ex.kind === "extra" && ex.date === "2026-11-03", "an extra is a one-off on any day");
  const dropExtra = skipOccurrence({ ...extra.state, topics: [topic("z", { sessionId: ex.id })] }, env(), "m1", "2026-11-03");
  ok(dropExtra.state.sessions.length === 0, "skipping a one-off removes it");
  ok(dropExtra.state.topics[0].sessionId === undefined, "and returns its topics");
  ok(addExtraOccurrence(extra.state, env(), "m1", "2026-11-03").value.created === false, "an extra on an existing day reuses it");

  const past = base({ sessions: [{ id: "old", meetingId: "m1", date: "2026-10-22", notes: "we talked" }] });
  throwsOp(() => skipOccurrence(past, env(), "m1", "2026-10-22"), "invalid", "a written-up past meeting can't be skipped", /already happened/);
}

{
  const sessions: Session[] = [{ id: "s5", meetingId: "m1", date: "2026-11-05" }];
  const s0 = base({ sessions, topics: [topic("a", { sessionId: "s5" })] });

  const mv = moveOccurrence(s0, env(), "m1", "2026-11-05", "2026-11-03", "this");
  const moved = mv.state.sessions.find((o) => o.id === "s5")!;
  ok(moved.date === "2026-11-03" && moved.seriesDate === "2026-11-05", "moving one week remembers the series date it stands in for");
  ok(mv.state.topics[0].sessionId === "s5", "topics ride along with the meeting");
  ok(!dates(mv.state).includes("2026-11-05") && dates(mv.state).includes("2026-11-03"), "the rhythm draws the moved week once, not twice");

  const proj = moveOccurrence(base(), env(), "m1", "2026-11-12", "2026-11-13", "this");
  ok(proj.state.sessions[0].seriesDate === "2026-11-12" && proj.state.sessions[0].date === "2026-11-13", "moving a projected week books it, moved");

  const back = restoreOccurrence(mv.state, "m1", "2026-11-03");
  ok(back.value.restored === "move" && back.state.sessions[0].date === "2026-11-05" && !back.state.sessions[0].seriesDate, "restore sends a moved meeting home");

  const clash = base({
    sessions: [
      { id: "s5", meetingId: "m1", date: "2026-11-05", notes: "Prep A" },
      { id: "s12", meetingId: "m1", date: "2026-11-12", notes: "Prep B" },
    ],
    topics: [topic("a", { sessionId: "s5" }), topic("b", { sessionId: "s12" })],
  });
  const fold = moveOccurrence(clash, env(), "m1", "2026-11-05", "2026-11-12", "this");
  ok(fold.value.folded && fold.state.sessions.length === 1, "moving onto a booked day folds the two meetings into one");
  ok(fold.state.topics.every((t) => t.sessionId === "s12"), "the folded meeting's topics join the survivor");
  ok(fold.state.sessions[0].notes === "Prep B\n\nPrep A", "prep notes from both are kept");

  const series = moveOccurrence(s0, env(), "m1", "2026-11-05", "2026-11-06", "series");
  ok(series.state.meetings[0].anchorWeekday === 5, "a series move re-anchors the weekday");
  ok(series.state.sessions.find((o) => o.id === "s5")!.date === "2026-11-06", "and carries the booked week to the new weekday");
  ok(dates(series.state).every((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 5), "every upcoming occurrence is now a Friday");

  throwsOp(() => moveOccurrence(s0, env(), "m1", "2026-11-05", "2026-10-01", "this"), "invalid", "can't move into the past", /past/);
  throwsOp(() => moveOccurrence(s0, env(), "m1", "2026-10-22", "2026-11-03", "this"), "invalid", "can't move a meeting that already happened", /already happened/);
  throwsOp(() => moveOccurrence(s0, env(), "m1", "2026-11-05", "tuesday", "this"), "invalid", "bad target date");
  throwsOp(() => moveOccurrence(s0, env(), "m1", "2026-11-04", "2026-11-09", "this"), "invalid", "moving something that isn't an occurrence");
  const skipped = skipOccurrence(s0, env(), "m1", "2026-11-12").state;
  throwsOp(() => moveOccurrence(skipped, env(), "m1", "2026-11-05", "2026-11-12", "this"), "conflict", "can't move onto a skipped week", /skipped/);
}

// ── occurrence text ──────────────────────────────────────────────────────
{
  const s0 = base();
  const r = updateOccurrence(s0, env(), "m1", "2026-11-05", { point: "Decide the Q1 plan", appendNotes: "Bring the draft" });
  ok(r.state.sessions.length === 1 && r.value.point === "Decide the Q1 plan", "setting a point books a projected week");
  const r2 = updateOccurrence(r.state, env(), "m1", "2026-11-05", { appendNotes: "And the budget" });
  ok(r2.value.notes === "Bring the draft\n\nAnd the budget", "notes are appended, never replaced");
  ok(updateOccurrence(r2.state, env(), "m1", "2026-11-05", { point: null }).value.point === undefined, "a null point clears it");
  throwsOp(() => updateOccurrence(s0, env(), "m1", "2026-11-05", { appendNotes: "  " }), "invalid", "blank notes");
  ok(ensureOccurrence(r.state, env(), "m1", "2026-11-05").booked === false, "ensureOccurrence reuses a booked week");
}

// ── meetings, sections, tags ─────────────────────────────────────────────
{
  const s0 = base();
  const m = updateMeeting(s0, env(), "m1", { name: "Meghan 1:1", trackerUrl: "https://notion.so/x" });
  ok(m.value.name === "Meghan 1:1" && m.value.trackerUrl === "https://notion.so/x", "updateMeeting patches fields");
  ok(updateMeeting(m.state, env(), "m1", { name: null }).value.name === undefined, "null clears a field");
  throwsOp(() => updateMeeting(s0, env(), "m1", { nextDate: "2026-10-01" }), "invalid", "next date in the past");
  throwsOp(() => updateMeeting(s0, env(), "m1", { rhythm: "daily" as never }), "invalid", "unknown rhythm");
  throwsOp(() => updateMeeting(s0, env(), "m1", { coverageTargets: [{ tagId: "ghost", everyNOccurrences: 2 }] }), "invalid", "coverage target on an unknown tag");
  const wd = updateMeeting(base({ sessions: [{ id: "s5", meetingId: "m1", date: "2026-11-05" }] }), env(), "m1", { anchorWeekday: 2 });
  ok(wd.state.sessions[0].date === "2026-11-03", "changing the weekday moves booked weeks within their week");

  const tg = createTag(s0, env(), "Prayer");
  ok(tg.state.tags.length === 4 && tg.value.label === "Prayer", "createTag adds a tag");
  ok(createTag(tg.state, env(), "  prayer ").state === tg.state, "createTag finds an existing label instead of duplicating");

  const withTopics = base({
    topics: [topic("a", { slotId: "sec-grow", tagIds: ["tg-grow"] }), topic("b", { tagIds: ["tg-misc"] })],
  });
  const secs = setSections(withTopics, env(), "m1", [
    { id: "sec-check", label: "Check in" },
    { label: "Misc" },
  ]);
  const cur = secs.state.meetings[0].curriculum!;
  ok(cur.length === 2 && cur[0].id === "sec-check" && cur[0].tagId === "tg-check", "an existing section keeps its id and tag when renamed");
  ok(cur[0].label === "Check in", "and takes the new label");
  ok(cur[1].tagId === "tg-misc", "a new section reuses a tag of the same name");
  ok(secs.state.topics.find((t) => t.id === "a")!.slotId === undefined, "a removed section releases its topics");
  ok(secs.state.topics.find((t) => t.id === "b")!.slotId === cur[1].id, "a topic already carrying the tag joins the new section");
  throwsOp(() => setSections(s0, env(), "m1", [{ label: "X" }, { label: "x" }]), "invalid", "duplicate section labels");
  throwsOp(() => setSections(s0, env(), "m1", [{ id: "ghost", label: "X" }]), "invalid", "unknown section id");
  ok(setSections(s0, env(), "m1", []).state.meetings[0].curriculum === undefined, "an empty list clears the standing agenda");
}

// ── sharing, talking points, tags, new meetings ─────────────────────────
{
  const s0 = base({ topics: [topic("a", { tagIds: ["tg-grow", "tg-misc"], private: true })] });
  const shared = updateTopic(s0, "a", { shared: true }, env());
  ok(shared.value.shared === true && shared.value.private === undefined, "sharing an idea un-privates it");
  ok(updateTopic(shared.state, "a", { private: true }, env()).value.shared === undefined, "making it private un-shares it");
  const pts = updateTopic(s0, "a", { points: [{ text: "One" }, { text: "Two", done: true }] }, env());
  const again = updateTopic(pts.state, "a", { points: [{ text: "Two", done: true }, { text: "Three" }] }, env());
  ok(pts.value.points?.length === 2 && pts.value.points[1].done, "talking points are set, ticks kept");
  ok(again.value.points?.[0].id === pts.value.points?.[1].id, "a point with unchanged text keeps its id");
  ok(updateTopic(again.state, "a", { points: [] }, env()).value.points === undefined, "[] clears the points");
  throwsOp(() => updateTopic(s0, "a", { points: [{ text: "x" }] }), "invalid", "points need an id source");
  const added = addTopics(s0, env(), [{ meetingId: "m1", text: "Idea", shared: true, private: true, points: ["A", "B"] }]).value.topics[0];
  ok(added.shared === true && !added.private && added.points?.length === 2, "addTopics: shared wins over private, points are kept");

  const coloured = updateTag(s0, "tg-misc", { color: 5, position: 0 });
  ok(coloured.value.color === 5 && [...coloured.state.tags].sort((x, y) => x.order - y.order)[0].id === "tg-misc", "updateTag recolours and moves a tag");
  throwsOp(() => updateTag(s0, "tg-misc", { color: 9 }), "invalid", "a colour out of range");
  const withTarget = base({
    meetings: [{ ...meeting, coverageTargets: [{ tagId: "tg-grow", everyNOccurrences: 2 }] }, asNeeded],
    topics: s0.topics,
  });
  const gone = deleteTag(withTarget, "tg-grow");
  ok(!gone.state.tags.some((t) => t.id === "tg-grow") && gone.state.topics[0].tagIds.join() === "tg-misc", "deleteTag takes it off topics");
  ok(gone.state.meetings[0].curriculum?.[1].tagId === undefined && gone.state.meetings[0].coverageTargets === undefined, "…and off sections and coverage targets");
  throwsOp(() => deleteTag(s0, "ghost"), "not_found", "deleting an unknown tag");

  const made = createMeeting(s0, env(), { subjectKind: "team", subjectId: "t1", name: " Staff ", rhythm: "biweekly", anchorWeekday: 1 });
  ok(made.state.meetings.length === 3 && made.value.name === "Staff" && made.value.rhythm === "biweekly", "createMeeting adds a meeting");
  ok(createMeeting(s0, env(), { subjectKind: "person", subjectId: "p1" }).value.rhythm === "weekly", "…weekly by default");
  throwsOp(() => createMeeting(s0, env(), { subjectKind: "person", subjectId: "p1", anchorWeekday: 7 }), "invalid", "a weekday out of range");
}

if (fails.length) {
  console.error(`agendaOps.check: ${fails.length}/${checks} failed`);
  for (const f of fails) console.error("  -", f);
  process.exit(1);
}
console.log(`agendaOps.check: ${checks} checks passed`);
