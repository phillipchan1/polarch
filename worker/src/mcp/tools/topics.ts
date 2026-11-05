/**
 * Tools that add, rearrange and close topics and follow-ups.
 *
 * The one tool that does most of the "move things around" work is
 * `move_topics`. It takes the destination the way a person says it — a date, or
 * "ideas" / "parked" — and the ops underneath do what dropping a card there
 * does: book a projected week, stamp the section's tag, renumber the row.
 */
import {
  addFollowUp,
  addTopics,
  createTag,
  deleteFollowUp,
  deleteTopics,
  placeTopics,
  promoteToFollowUp,
  rollTopicsForward,
  setTopicsCovered,
  updateFollowUp,
  updateTopic,
  type NewTopic,
  type Target,
} from "../../../../src/lib/agendaOps.ts";
import { arr, bool, date, enumOf, int, nullable, obj, opt, str } from "../schema.ts";
import { DELETES, ToolError, WRITES, tool, type ToolDef } from "../server.ts";
import type { Workspace } from "../workspace.ts";
import { MEETING, TODAY } from "./read.ts";
import { followUpView, resolveMeeting, resolveSection, titleOf, topicView, visibilityWarnings, mutate, weekdayName } from "./views.ts";

const TOPIC_IDS = (what: string) =>
  arr(str({ min: 1, max: 40 }), { min: 1, max: 100, description: `Topic ids (from get_plan, get_agenda or list_ideas) ${what}` });

const SECTION = str({
  min: 1,
  max: 60,
  description: "A section of the meeting's standing agenda, by label or id (see get_meeting). Placing into a section also applies its tag.",
});

/** `{ok, change_id, summary, …}` — the change id is what `undo_change` takes. */
export function done(saved: { changeId: string | null }, summary: string, extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    ...(saved.changeId ? { change_id: saved.changeId } : { nothing_changed: true }),
    summary,
    ...extra,
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function where(ws: Workspace, meetingId: string | undefined, date?: string) {
  const m = meetingId ? ws.agenda.meetings.find((x) => x.id === meetingId) : undefined;
  return m ? `${titleOf(ws, m)}${date ? `, ${weekdayName(date).slice(0, 3)} ${date}` : ""}` : "the inbox";
}

export const topicTools: ToolDef[] = [
  tool({
    name: "add_topics",
    title: "Add topics",
    description:
      "Add one or more topics (things to discuss). With no `date` they land in the meeting's idea tray (or the inbox if no meeting). With a `date` they're placed on that occurrence, booking it if it was only projected. A meeting shared with someone shows placed topics to them unless `private` is true.",
    scope: "agenda:write",
    annotations: WRITES,
    input: obj({
      topics: arr(
        obj({
          meeting: opt(MEETING),
          text: str({ min: 1, max: 500, description: "The one-line topic." }),
          detail: opt(str({ max: 4000, description: "Longer notes behind the one-liner." })),
          section: opt(SECTION),
          tags: opt(arr(str({ min: 1, max: 40 }), { max: 10, description: "Tag labels. Unknown labels are created." })),
          urgent: opt(bool()),
          due: opt(date({ description: "A due date for the topic." })),
          date: opt(date({ description: "Place on this occurrence (an upcoming date of the meeting)." })),
          parked: opt(bool({ description: "Park it: set aside, not for the next meeting." })),
          private: opt(bool({ description: "Keep it to the leader even if the meeting is shared." })),
          shared: opt(bool({ description: "On a shared meeting, show this idea to the other person while it's still in the tray (placing it on a week shares it anyway)." })),
          points: opt(arr(str({ min: 1, max: 300 }), { max: 30, description: "Talking points: what the topic breaks down into." })),
        }),
        { min: 1, max: 50 },
      ),
      today: TODAY,
    }),
    run: async (input, ctx) => {
      const out = await mutate(ctx, "add_topics", input.today, (ws, env) => {
        let agenda = ws.agenda;
        const items: NewTopic[] = input.topics.map((item) => {
          const meeting = item.meeting ? resolveMeeting(ws, item.meeting) : undefined;
          if (item.section && !meeting) throw new ToolError("invalid", "A section needs a meeting.");
          const tagIds: string[] = [];
          for (const label of item.tags ?? []) {
            const hit = agenda.tags.find((t) => t.id === label || t.label.trim().toLowerCase() === label.trim().toLowerCase());
            if (hit) tagIds.push(hit.id);
            else {
              const made = createTag(agenda, env, label);
              agenda = made.state;
              tagIds.push(made.value.id);
            }
          }
          return {
            meetingId: meeting?.id,
            text: item.text,
            detail: item.detail,
            tagIds,
            urgent: item.urgent,
            dueDate: item.due,
            slotId: item.section && meeting ? resolveSection(meeting, item.section) : undefined,
            private: item.private,
            shared: item.shared,
            points: item.points,
            date: item.date,
            parked: item.parked,
          };
        });
        const r = addTopics(agenda, env, items);
        const after = { ...ws, agenda: r.state };
        const first = items[0];
        const summary = `Added ${plural(items.length, "topic")} to ${where(ws, first.meetingId, first.date)}`;
        return {
          edit: { agenda: r.state, arcs: ws.arcs, takeaways: ws.takeaways },
          summary,
          value: {
            added: r.value.topics.map((t) => topicView(after, t, { meeting: true })),
            ...(r.value.booked.length ? { booked_occurrences: r.value.booked.map((s) => s.date) } : {}),
            warnings: visibilityWarnings(after, r.value.topics),
          },
        };
      });
      return done(out.saved, out.summary, out.value);
    },
  }),

  tool({
    name: "update_topic",
    title: "Edit a topic",
    description: "Change a topic's wording, notes, talking points, urgency, due date, tags, privacy or sharing. Only the fields you pass change; pass null to clear `detail` or `due`. To move it, use move_topics; to tag many at once, use tag_topics.",
    scope: "agenda:write",
    annotations: WRITES,
    input: obj({
      topic: str({ min: 1, max: 40, description: "Topic id." }),
      text: opt(str({ min: 1, max: 500 })),
      detail: opt(nullable(str({ max: 4000 }))),
      urgent: opt(bool()),
      due: opt(nullable(date())),
      tags: opt(arr(str({ min: 1, max: 40 }), { max: 10, description: "Replaces the topic's tags. Labels or ids; unknown labels are created." })),
      private: opt(bool({ description: "Keep it to the leader even on a shared meeting. Turns sharing off." })),
      shared: opt(bool({ description: "Show this idea on a shared meeting's page while it's still in the tray. Turns private off." })),
      points: opt(
        arr(obj({ text: str({ min: 1, max: 300 }), done: opt(bool()) }), { max: 30, description: "Replaces the talking points, in order. [] clears them." }),
      ),
      today: TODAY,
    }),
    run: async (input, ctx) => {
      const out = await mutate(ctx, "update_topic", input.today, (ws, env) => {
        let agenda = ws.agenda;
        let tagIds: string[] | undefined;
        if (input.tags) {
          tagIds = [];
          for (const label of input.tags) {
            const hit = agenda.tags.find((t) => t.id === label || t.label.trim().toLowerCase() === label.trim().toLowerCase());
            if (hit) tagIds.push(hit.id);
            else {
              const made = createTag(agenda, env, label);
              agenda = made.state;
              tagIds.push(made.value.id);
            }
          }
        }
        const r = updateTopic(agenda, input.topic, {
          text: input.text,
          detail: input.detail,
          urgent: input.urgent,
          dueDate: input.due,
          tagIds,
          private: input.private,
          shared: input.shared,
          points: input.points,
        }, env);
        const after = { ...ws, agenda: r.state };
        return {
          edit: { agenda: r.state, arcs: ws.arcs, takeaways: ws.takeaways },
          summary: `Edited a topic: "${r.value.text.slice(0, 60)}"`,
          value: { topic: topicView(after, r.value, { meeting: true }), warnings: visibilityWarnings(after, [r.value]) },
        };
      });
      return done(out.saved, out.summary, out.value);
    },
  }),

  tool({
    name: "tag_topics",
    title: "Tag or untag topics",
    description:
      "Add and/or remove tags on many topics at once, leaving their other tags alone. Labels or ids; unknown labels in `add` are created. Tags are how coverage targets count and how sections recognise their topics.",
    scope: "agenda:write",
    annotations: WRITES,
    input: obj({
      topics: TOPIC_IDS("to tag."),
      add: opt(arr(str({ min: 1, max: 40 }), { max: 10 })),
      remove: opt(arr(str({ min: 1, max: 40 }), { max: 10 })),
      today: TODAY,
    }),
    run: async (input, ctx) => {
      if (!input.add?.length && !input.remove?.length) throw new ToolError("invalid_arguments", "Pass `add` and/or `remove`.");
      const out = await mutate(ctx, "tag_topics", input.today, (ws, env) => {
        let agenda = ws.agenda;
        const addIds: string[] = [];
        for (const label of input.add ?? []) {
          const hit = agenda.tags.find((t) => t.id === label || t.label.trim().toLowerCase() === label.trim().toLowerCase());
          if (hit) addIds.push(hit.id);
          else {
            const made = createTag(agenda, env, label);
            agenda = made.state;
            addIds.push(made.value.id);
          }
        }
        const removeIds = (input.remove ?? []).map((label) => {
          const hit = agenda.tags.find((t) => t.id === label || t.label.trim().toLowerCase() === label.trim().toLowerCase());
          if (!hit) throw new ToolError("tag_not_found", `No tag "${label}".`, { tags: agenda.tags.map((t) => t.label) });
          return hit.id;
        });
        const changed = [];
        for (const id of input.topics) {
          const t = agenda.topics.find((x) => x.id === id);
          if (!t) throw new ToolError("not_found", `No topic with id "${id}". Find ids with get_plan, get_agenda or list_ideas.`);
          const tagIds = [...new Set([...t.tagIds.filter((x) => !removeIds.includes(x)), ...addIds])];
          const r = updateTopic(agenda, id, { tagIds });
          agenda = r.state;
          changed.push(r.value);
        }
        const after = { ...ws, agenda };
        return {
          edit: { agenda, arcs: ws.arcs, takeaways: ws.takeaways },
          summary: `Retagged ${plural(changed.length, "topic")}`,
          value: { topics: changed.map((t) => topicView(after, t, { meeting: true })) },
        };
      });
      return done(out.saved, out.summary, out.value);
    },
  }),

  tool({
    name: "move_topics",
    title: "Move topics",
    description:
      "Move topics to another week, back to the idea tray, to parked, or to another meeting. Give exactly one destination: `date` (an upcoming occurrence of the target meeting; booked if only projected) or `to` ('ideas' or 'parked'). Topics keep their section unless you pass `section` (a label/id, or 'none'). `position` is the 0-based place in the destination (default: the end). Read get_plan first; dates must be real occurrences.",
    scope: "agenda:write",
    annotations: WRITES,
    input: obj({
      topics: TOPIC_IDS("to move, landing together in this order."),
      date: opt(date({ description: "Destination occurrence." })),
      to: opt(enumOf(["ideas", "parked"] as const, { description: "Destination other than a week." })),
      meeting: opt(str({ min: 1, max: 100, description: "Move to this meeting (id or name). Defaults to the topics' own meeting." })),
      section: opt(str({ min: 1, max: 60, description: "Section label/id in the destination meeting, or 'none' to clear it." })),
      position: opt(int({ min: 0, max: 200 })),
      today: TODAY,
    }),
    run: async (input, ctx) => {
      if ((input.date === undefined) === (input.to === undefined)) {
        throw new ToolError("invalid_arguments", "Give exactly one destination: `date` or `to`.");
      }
      const out = await mutate(ctx, "move_topics", input.today, (ws, env) => {
        const moving = input.topics.map((id) => {
          const t = ws.agenda.topics.find((x) => x.id === id);
          if (!t) throw new ToolError("not_found", `No topic with id "${id}". Find ids with get_plan, get_agenda or list_ideas.`);
          return t;
        });
        const targetMeeting = input.meeting
          ? resolveMeeting(ws, input.meeting)
          : (() => {
              const ids = [...new Set(moving.map((t) => t.meetingId))];
              if (ids.length === 1 && ids[0]) return ws.agenda.meetings.find((m) => m.id === ids[0]);
              if (input.date !== undefined) {
                throw new ToolError("invalid_arguments", "These topics aren't all in one meeting, so say which one to place them in with `meeting`.");
              }
              return undefined;
            })();
        let slotId: string | undefined;
        if (input.section && input.section.trim().toLowerCase() !== "none") {
          if (!targetMeeting) throw new ToolError("invalid_arguments", "A section needs a meeting.");
          slotId = resolveSection(targetMeeting, input.section);
        }
        const explicitNone = input.section?.trim().toLowerCase() === "none";
        const target: Target =
          input.date !== undefined
            ? { kind: "date", meetingId: targetMeeting!.id, date: input.date, slotId }
            : { kind: "lane", lane: input.to === "parked" ? "parked" : "backlog", meetingId: input.meeting ? targetMeeting?.id : undefined, slotId };
        const r = placeTopics(ws.agenda, env, input.topics, target, input.position, !explicitNone && slotId === undefined);
        const after = { ...ws, agenda: r.state };
        const dest = input.date !== undefined ? where(ws, targetMeeting!.id, input.date) : input.to === "parked" ? "parked" : "the idea tray";
        return {
          edit: { agenda: r.state, arcs: ws.arcs, takeaways: ws.takeaways },
          summary: `Moved ${plural(moving.length, "topic")} to ${dest}`,
          value: {
            moved: r.value.topics.map((t) => topicView(after, t, { meeting: true })),
            ...(r.value.booked.length ? { booked_occurrences: r.value.booked.map((s) => s.date) } : {}),
            warnings: visibilityWarnings(after, r.value.topics),
          },
        };
      });
      return done(out.saved, out.summary, out.value);
    },
  }),

  tool({
    name: "set_topics_covered",
    title: "Mark topics covered or reopen them",
    description: "Tick topics off as covered in their meeting (covered: true), or reopen them (covered: false). A reopened topic stays where it was.",
    scope: "agenda:write",
    annotations: WRITES,
    input: obj({ topics: TOPIC_IDS("to change."), covered: bool(), today: TODAY }),
    run: async (input, ctx) => {
      const out = await mutate(ctx, "set_topics_covered", input.today, (ws, env) => {
        const r = setTopicsCovered(ws.agenda, env, input.topics, input.covered);
        const after = { ...ws, agenda: r.state };
        return {
          edit: { agenda: r.state, arcs: ws.arcs, takeaways: ws.takeaways },
          summary: `${input.covered ? "Marked" : "Reopened"} ${plural(input.topics.length, "topic")}${input.covered ? " covered" : ""}`,
          value: { topics: r.value.map((t) => topicView(after, t)) },
        };
      });
      return done(out.saved, out.summary, out.value);
    },
  }),

  tool({
    name: "roll_topics_forward",
    title: "Roll topics to the next meeting",
    description:
      "Push open topics that are on an occurrence into the next one (or a date you name). The meeting they leave records that it didn't cover them, and each topic's 'carried' count goes up — the honest signal that something keeps slipping. Topics not on an occurrence can't be rolled; use move_topics.",
    scope: "agenda:write",
    annotations: WRITES,
    input: obj({ topics: TOPIC_IDS("to roll."), date: opt(date({ description: "Roll to this occurrence instead of the next." })), today: TODAY }),
    run: async (input, ctx) => {
      const out = await mutate(ctx, "roll_topics_forward", input.today, (ws, env) => {
        const r = rollTopicsForward(ws.agenda, env, input.topics, input.date);
        const after = { ...ws, agenda: r.state };
        return {
          edit: { agenda: r.state, arcs: ws.arcs, takeaways: ws.takeaways },
          summary: `Rolled ${plural(input.topics.length, "topic")} forward`,
          value: {
            rolled: r.value.topics.map((t) => ({
              ...topicView(after, t),
              now_on: after.agenda.sessions.find((s) => s.id === t.sessionId)?.date ?? "the idea tray (no later occurrence)",
            })),
            ...(r.value.booked.length ? { booked_occurrences: r.value.booked.map((s) => s.date) } : {}),
            warnings: visibilityWarnings(after, r.value.topics),
          },
        };
      });
      return done(out.saved, out.summary, out.value);
    },
  }),

  tool({
    name: "promote_topic_to_follow_up",
    title: "Turn a topic into a follow-up",
    description: "A topic that keeps getting pushed is usually a commitment in disguise. This closes the topic and opens a follow-up on the same meeting.",
    scope: "agenda:write",
    annotations: WRITES,
    input: obj({ topic: str({ min: 1, max: 40 }), today: TODAY }),
    run: async (input, ctx) => {
      const out = await mutate(ctx, "promote_topic_to_follow_up", input.today, (ws, env) => {
        const r = promoteToFollowUp(ws.agenda, env, input.topic);
        const after = { ...ws, agenda: r.state };
        return {
          edit: { agenda: r.state, arcs: ws.arcs, takeaways: ws.takeaways },
          summary: `Turned a topic into a follow-up: "${r.value.text.slice(0, 60)}"`,
          value: { follow_up: followUpView(after, r.value) },
        };
      });
      return done(out.saved, out.summary, out.value);
    },
  }),

  tool({
    name: "delete_topics",
    title: "Delete topics",
    description: "Permanently remove topics. Prefer set_topics_covered, parking, or move_topics unless the user clearly wants them gone. Undoable with undo_change.",
    scope: "agenda:write",
    annotations: DELETES,
    input: obj({ topics: TOPIC_IDS("to delete."), today: TODAY }),
    run: async (input, ctx) => {
      const out = await mutate(ctx, "delete_topics", input.today, (ws) => {
        const r = deleteTopics(ws.agenda, input.topics);
        return {
          edit: { agenda: r.state, arcs: ws.arcs, takeaways: ws.takeaways },
          summary: `Deleted ${plural(r.value.length, "topic")}`,
          value: { deleted: r.value.map((t) => ({ id: t.id, text: t.text })) },
        };
      });
      return done(out.saved, out.summary, out.value);
    },
  }),

  tool({
    name: "add_follow_up",
    title: "Add a follow-up",
    description: "Record something the leader said they'd do. It belongs to the meeting's subject and opens the next meeting as 'since last time'.",
    scope: "agenda:write",
    annotations: WRITES,
    input: obj({ meeting: MEETING, text: str({ min: 1, max: 500 }), private: opt(bool({ description: "Keep off any shared page." })), today: TODAY }),
    run: async (input, ctx) => {
      const out = await mutate(ctx, "add_follow_up", input.today, (ws, env) => {
        const meeting = resolveMeeting(ws, input.meeting);
        const r = addFollowUp(ws.agenda, env, { meetingId: meeting.id, text: input.text, private: input.private });
        const after = { ...ws, agenda: r.state };
        return {
          edit: { agenda: r.state, arcs: ws.arcs, takeaways: ws.takeaways },
          summary: `Added a follow-up to ${titleOf(ws, meeting)}: "${r.value.text.slice(0, 60)}"`,
          value: { follow_up: followUpView(after, r.value) },
        };
      });
      return done(out.saved, out.summary, out.value);
    },
  }),

  tool({
    name: "update_follow_up",
    title: "Edit or tick off a follow-up",
    description: "Reword a follow-up, or mark it done (done: true) or open again (done: false).",
    scope: "agenda:write",
    annotations: WRITES,
    input: obj({ follow_up: str({ min: 1, max: 40 }), text: opt(str({ min: 1, max: 500 })), done: opt(bool()), today: TODAY }),
    run: async (input, ctx) => {
      const out = await mutate(ctx, "update_follow_up", input.today, (ws, env) => {
        const r = updateFollowUp(ws.agenda, env, input.follow_up, { text: input.text, done: input.done });
        const after = { ...ws, agenda: r.state };
        return {
          edit: { agenda: r.state, arcs: ws.arcs, takeaways: ws.takeaways },
          summary: `${input.done === true ? "Completed" : input.done === false ? "Reopened" : "Edited"} a follow-up: "${r.value.text.slice(0, 60)}"`,
          value: { follow_up: followUpView(after, r.value) },
        };
      });
      return done(out.saved, out.summary, out.value);
    },
  }),

  tool({
    name: "delete_follow_up",
    title: "Delete a follow-up",
    description: "Permanently remove a follow-up. Prefer marking it done. Undoable with undo_change.",
    scope: "agenda:write",
    annotations: DELETES,
    input: obj({ follow_up: str({ min: 1, max: 40 }), today: TODAY }),
    run: async (input, ctx) => {
      const out = await mutate(ctx, "delete_follow_up", input.today, (ws) => {
        const r = deleteFollowUp(ws.agenda, input.follow_up);
        return {
          edit: { agenda: r.state, arcs: ws.arcs, takeaways: ws.takeaways },
          summary: `Deleted a follow-up: "${r.value.text.slice(0, 60)}"`,
          value: { deleted: { id: r.value.id, text: r.value.text } },
        };
      });
      return done(out.saved, out.summary, out.value);
    },
  }),
];
