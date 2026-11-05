/**
 * Tools that shape a meeting's calendar and standing setup: move or skip a
 * week, add a one-off, rename the sections of the standing agenda — and the
 * change log with undo that makes all of it safe to delegate.
 */
import {
  addExtraOccurrence,
  createTag,
  moveOccurrence,
  renameTag,
  restoreOccurrence,
  setSections,
  skipOccurrence,
  updateMeeting,
  updateOccurrence,
  type MeetingPatch,
} from "../../../../src/lib/agendaOps.ts";
import { arr, date, enumOf, int, nullable, obj, opt, str } from "../schema.ts";
import { DELETES, READS, ToolError, WRITES, tool, type ToolDef } from "../server.ts";
import { UndoRefused, listChanges, undoChange } from "../workspace.ts";
import { MEETING, TODAY } from "./read.ts";
import { done } from "./topics.ts";
import { WEEKDAYS, guarded, mutate, planView, resolveMeeting, titleOf, topicView, weekdayName } from "./views.ts";

const dayLabel = (d: string) => `${weekdayName(d).slice(0, 3)} ${d}`;

export const scheduleTools: ToolDef[] = [
  tool({
    name: "reschedule_occurrence",
    title: "Move a meeting to another day",
    description:
      "Move one occurrence of a meeting to another date (scope 'this': just that week; the series keeps its day), or move the whole series to the weekday of the new date (scope 'series'). Its topics ride along. Moving onto a day that already has a meeting folds the two together. Past meetings can't move. Returns the next few weeks so you can check the result.",
    scope: "agenda:write",
    annotations: WRITES,
    input: obj({
      meeting: MEETING,
      from_date: date({ description: "The occurrence's current date (see get_plan)." }),
      to_date: date({ description: "Where it should go." }),
      scope: opt(enumOf(["this", "series"] as const, { description: "Default 'this'." })),
      today: TODAY,
    }),
    run: async (input, ctx) => {
      const out = await mutate(ctx, "reschedule_occurrence", input.today, (ws, env) => {
        const m = resolveMeeting(ws, input.meeting);
        const r = moveOccurrence(ws.agenda, env, m.id, input.from_date, input.to_date, input.scope ?? "this");
        const after = { ...ws, agenda: r.state };
        return {
          edit: { agenda: r.state, arcs: ws.arcs, takeaways: ws.takeaways },
          summary:
            input.scope === "series"
              ? `Moved ${titleOf(ws, m)} to ${WEEKDAYS[new Date(`${input.to_date}T00:00:00Z`).getUTCDay()]}s`
              : `Moved ${titleOf(ws, m)} from ${dayLabel(input.from_date)} to ${dayLabel(input.to_date)}`,
          value: {
            session_id: r.value.sessionId,
            ...(r.value.folded ? { folded_into_existing_meeting: true } : {}),
            plan: planView(after, m, env.today, 5),
          },
        };
      });
      return done(out.saved, out.summary, out.value);
    },
  }),

  tool({
    name: "skip_occurrence",
    title: "Skip a week",
    description:
      "This week isn't happening. Topics planned for it return to the idea tray (nothing is lost), the date stays held so the rhythm doesn't redraw it, and any arc simply slides to the next meeting. A one-off meeting just disappears. A meeting that already happened and was written up can't be skipped.",
    scope: "agenda:write",
    annotations: WRITES,
    input: obj({ meeting: MEETING, date: date({ description: "The occurrence to skip." }), today: TODAY }),
    run: async (input, ctx) => {
      const out = await mutate(ctx, "skip_occurrence", input.today, (ws, env) => {
        const m = resolveMeeting(ws, input.meeting);
        const r = skipOccurrence(ws.agenda, env, m.id, input.date);
        const after = { ...ws, agenda: r.state };
        return {
          edit: { agenda: r.state, arcs: ws.arcs, takeaways: ws.takeaways },
          summary: `Skipped ${titleOf(ws, m)} on ${dayLabel(input.date)}`,
          value: {
            returned_to_idea_tray: r.value.returnedToBacklog.map((t) => topicView(after, after.agenda.topics.find((x) => x.id === t.id) ?? t)),
            plan: planView(after, m, env.today, 5),
          },
        };
      });
      return done(out.saved, out.summary, out.value);
    },
  }),

  tool({
    name: "restore_occurrence",
    title: "Restore a skipped or moved week",
    description: "Undo a skip (the week comes back), or send a one-off-moved meeting back to its normal day in the series. For anything else use undo_change.",
    scope: "agenda:write",
    annotations: WRITES,
    input: obj({ meeting: MEETING, date: date({ description: "The skipped week's date, or the moved meeting's current date." }), today: TODAY }),
    run: async (input, ctx) => {
      const out = await mutate(ctx, "restore_occurrence", input.today, (ws, env) => {
        const m = resolveMeeting(ws, input.meeting);
        const r = restoreOccurrence(ws.agenda, m.id, input.date);
        const after = { ...ws, agenda: r.state };
        return {
          edit: { agenda: r.state, arcs: ws.arcs, takeaways: ws.takeaways },
          summary: `Restored ${titleOf(ws, m)} on ${dayLabel(input.date)}`,
          value: { restored: r.value.restored, plan: planView(after, m, env.today, 5) },
        };
      });
      return done(out.saved, out.summary, out.value);
    },
  }),

  tool({
    name: "add_extra_occurrence",
    title: "Add a one-off meeting",
    description: "Add a single extra meeting on a date outside the rhythm. It doesn't change the series.",
    scope: "agenda:write",
    annotations: WRITES,
    input: obj({ meeting: MEETING, date: date({ description: "Today or later." }), today: TODAY }),
    run: async (input, ctx) => {
      const out = await mutate(ctx, "add_extra_occurrence", input.today, (ws, env) => {
        const m = resolveMeeting(ws, input.meeting);
        const r = addExtraOccurrence(ws.agenda, env, m.id, input.date);
        return {
          edit: { agenda: r.state, arcs: ws.arcs, takeaways: ws.takeaways },
          summary: `Added a one-off ${titleOf(ws, m)} on ${dayLabel(input.date)}`,
          value: { session_id: r.value.sessionId, created: r.value.created },
        };
      });
      return done(out.saved, out.summary, out.value);
    },
  }),

  tool({
    name: "update_occurrence",
    title: "Set an occurrence's point or prep notes",
    description:
      "Set the one-line purpose of an occurrence ('Decide the Q1 plan') and/or append to its prep notes. Notes are only ever appended, never replaced — they may hold the leader's own writing. A projected week is booked by this.",
    scope: "agenda:write",
    annotations: WRITES,
    input: obj({
      meeting: MEETING,
      date: date({ description: "An upcoming occurrence (or an existing booked one)." }),
      point: opt(nullable(str({ min: 1, max: 300 }))),
      add_notes: opt(str({ min: 1, max: 5000 })),
      today: TODAY,
    }),
    run: async (input, ctx) => {
      if (input.point === undefined && input.add_notes === undefined) {
        throw new ToolError("invalid_arguments", "Pass `point` and/or `add_notes`.");
      }
      const out = await mutate(ctx, "update_occurrence", input.today, (ws, env) => {
        const m = resolveMeeting(ws, input.meeting);
        const r = updateOccurrence(ws.agenda, env, m.id, input.date, { point: input.point, appendNotes: input.add_notes });
        return {
          edit: { agenda: r.state, arcs: ws.arcs, takeaways: ws.takeaways },
          summary: `Updated ${titleOf(ws, m)} on ${dayLabel(input.date)}`,
          value: { session_id: r.value.id, ...(r.value.point ? { point: r.value.point } : {}), ...(r.value.notes ? { prep_notes: r.value.notes } : {}) },
        };
      });
      return done(out.saved, out.summary, out.value);
    },
  }),

  tool({
    name: "update_meeting",
    title: "Change a meeting's setup",
    description:
      "Rename a meeting, change its rhythm or weekday (booked upcoming weeks move within their own week), set an explicit next date, point it at where its notes live, or set coverage targets ('Prayer at least every 4 meetings'). Only the fields you pass change; null clears.",
    scope: "agenda:write",
    annotations: WRITES,
    input: obj({
      meeting: MEETING,
      name: opt(nullable(str({ min: 1, max: 80 }))),
      rhythm: opt(enumOf(["weekly", "biweekly", "monthly", "quarterly", "as_needed"] as const)),
      weekday: opt(nullable(int({ min: 0, max: 6, description: "0 = Sunday … 6 = Saturday." }))),
      next_date: opt(nullable(date({ description: "An explicit booking for the next meeting." }))),
      as_needed_floor_days: opt(nullable(int({ min: 1, max: 365, description: "For as-needed meetings: how many days of silence is too many." }))),
      notes_url: opt(nullable(str({ min: 1, max: 500, description: "Where the notes live outside Polarch." }))),
      notes_service: opt(nullable(str({ min: 1, max: 40 }))),
      coverage_targets: opt(
        arr(obj({ tag: str({ min: 1, max: 40, description: "An existing tag label." }), every_n_occurrences: int({ min: 1, max: 52 }) }), { max: 10, description: "Replaces the meeting's targets." }),
      ),
      today: TODAY,
    }),
    run: async (input, ctx) => {
      const out = await mutate(ctx, "update_meeting", input.today, (ws, env) => {
        const m = resolveMeeting(ws, input.meeting);
        const patch: MeetingPatch = {
          name: input.name,
          rhythm: input.rhythm,
          anchorWeekday: input.weekday,
          nextDate: input.next_date,
          floorDays: input.as_needed_floor_days,
          trackerUrl: input.notes_url,
          trackerName: input.notes_service,
          coverageTargets: input.coverage_targets?.map((c) => {
            const tag = ws.agenda.tags.find((t) => t.label.trim().toLowerCase() === c.tag.trim().toLowerCase() || t.id === c.tag);
            if (!tag) throw new ToolError("tag_not_found", `No tag "${c.tag}". Create it first with create_tag.`, { tags: ws.agenda.tags.map((t) => t.label) });
            return { tagId: tag.id, everyNOccurrences: c.every_n_occurrences };
          }),
        };
        const r = updateMeeting(ws.agenda, env, m.id, patch);
        const after = { ...ws, agenda: r.state };
        return {
          edit: { agenda: r.state, arcs: ws.arcs, takeaways: ws.takeaways },
          summary: `Updated ${titleOf(ws, m)}`,
          value: { plan: planView(after, r.value, env.today, 4) },
        };
      });
      return done(out.saved, out.summary, out.value);
    },
  }),

  tool({
    name: "set_sections",
    title: "Set a meeting's sections",
    description:
      "Set the sections of a meeting's standing agenda (the rows like Check-in, Training, Prayer) in order. Pass an existing section's `id` to keep it (and its topics and tag) while renaming or re-timing it; sections without an id are new and get a tag of the same name; sections you leave out are removed, and their topics become unsectioned (not deleted). Pass the full list every time.",
    scope: "agenda:write",
    annotations: WRITES,
    input: obj({
      meeting: MEETING,
      sections: arr(obj({ id: opt(str({ min: 1, max: 40 })), label: str({ min: 1, max: 60 }), minutes: opt(int({ min: 1, max: 480 })) }), { max: 20 }),
      today: TODAY,
    }),
    run: async (input, ctx) => {
      const out = await mutate(ctx, "set_sections", input.today, (ws, env) => {
        const m = resolveMeeting(ws, input.meeting);
        const r = setSections(ws.agenda, env, m.id, input.sections);
        return {
          edit: { agenda: r.state, arcs: ws.arcs, takeaways: ws.takeaways },
          summary: `Set ${r.value.length} sections on ${titleOf(ws, m)}`,
          value: { sections: r.value.map((s) => ({ id: s.id, label: s.label, ...(s.minutes ? { minutes: s.minutes } : {}) })) },
        };
      });
      return done(out.saved, out.summary, out.value);
    },
  }),

  tool({
    name: "create_tag",
    title: "Create a tag",
    description: "Create a topic tag (or return the existing one with that label). Tags are shared across all meetings.",
    scope: "agenda:write",
    annotations: WRITES,
    input: obj({ label: str({ min: 1, max: 40 }) }),
    run: async (input, ctx) => {
      const out = await mutate(ctx, "create_tag", undefined, (ws, env) => {
        const r = createTag(ws.agenda, env, input.label);
        return {
          edit: { agenda: r.state, arcs: ws.arcs, takeaways: ws.takeaways },
          summary: `Created the tag "${r.value.label}"`,
          value: { tag: { id: r.value.id, label: r.value.label } },
        };
      });
      return done(out.saved, out.summary, out.value);
    },
  }),

  tool({
    name: "rename_tag",
    title: "Rename a tag",
    description: "Change a tag's label everywhere it's used.",
    scope: "agenda:write",
    annotations: WRITES,
    input: obj({ tag: str({ min: 1, max: 40, description: "Tag id or current label." }), label: str({ min: 1, max: 40 }) }),
    run: async (input, ctx) => {
      const out = await mutate(ctx, "rename_tag", undefined, (ws) => {
        const hit = ws.agenda.tags.find((t) => t.id === input.tag || t.label.trim().toLowerCase() === input.tag.trim().toLowerCase());
        if (!hit) throw new ToolError("tag_not_found", `No tag "${input.tag}".`, { tags: ws.agenda.tags.map((t) => t.label) });
        const r = renameTag(ws.agenda, hit.id, input.label);
        return {
          edit: { agenda: r.state, arcs: ws.arcs, takeaways: ws.takeaways },
          summary: `Renamed the tag "${hit.label}" to "${r.value.label}"`,
          value: { tag: { id: r.value.id, label: r.value.label } },
        };
      });
      return done(out.saved, out.summary, out.value);
    },
  }),

  tool({
    name: "list_changes",
    title: "List recent changes",
    description: "What assistants have changed in this workspace, newest first, with a change id for each. Use it to see what was done or to find something to undo.",
    scope: "agenda:read",
    annotations: READS,
    input: obj({ limit: opt(int({ min: 1, max: 50, description: "Default 15." })) }),
    run: async (input, ctx) => ({ changes: await listChanges(ctx.sql, ctx.principal.userId, input.limit ?? 15) }),
  }),

  tool({
    name: "undo_change",
    title: "Undo a change",
    description:
      "Reverse a recent change made through this connector. With no id, undoes the latest one that hasn't been undone. Refused (never forced) if anything it touched has been edited since — including by the user in the app — or if a later change touched the same things; undo that one first.",
    scope: "agenda:write",
    annotations: DELETES,
    input: obj({ change_id: opt(str({ min: 1, max: 40, description: "From a write tool's result or list_changes." })) }),
    run: async (input, ctx) =>
      guarded(async () => {
        try {
          const r = await undoChange(ctx.sql, ctx.principal.userId, input.change_id);
          return { ok: true, undone: r.summary, change_id: r.id, rows_restored: r.restored };
        } catch (err) {
          if (err instanceof UndoRefused) throw new ToolError("undo_refused", err.message, err.details);
          throw err;
        }
      }),
  }),
];
