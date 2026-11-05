/**
 * Across meetings: what's coming up, setting up a new meeting, and the
 * workspace's tags. The per-meeting views live in read.ts; these are the ones
 * an assistant runs a leader's week from.
 */
import { createMeeting, deleteTag, renameTag, updateTag } from "../../../../src/lib/agendaOps.ts";
import { effectiveSlotId } from "../../../../src/lib/topics.ts";
import { arcPlan } from "../../../../src/lib/arcs.ts";
import { date, enumOf, int, obj, opt, str } from "../schema.ts";
import { DELETES, READS, ToolError, WRITES, tool, type ToolDef } from "../server.ts";
import type { Workspace } from "../workspace.ts";
import { TODAY } from "./read.ts";
import { done } from "./topics.ts";
import {
  guarded,
  meetingHealth,
  mutate,
  planView,
  readWorkspace,
  resolveSubject,
  sharedNote,
  slotsOf,
  subjectName,
  titleOf,
  weekdayName,
  withName,
} from "./views.ts";

const TAG_COLORS = ["slate", "blue", "green", "amber", "rose", "violet"] as const;

function findTag(ws: Workspace, ref: string) {
  const q = ref.trim().toLowerCase();
  const hit = ws.agenda.tags.find((t) => t.id === ref.trim() || t.label.trim().toLowerCase() === q);
  if (!hit) throw new ToolError("tag_not_found", `No tag "${ref}".`, { tags: ws.agenda.tags.map((t) => t.label) });
  return hit;
}

export const meetingTools: ToolDef[] = [
  tool({
    name: "list_upcoming",
    title: "List upcoming meetings",
    description:
      "Every meeting occurrence in the next N days across all meetings, soonest first: the date, who it's with, whether it's booked, only projected or skipped, its point, how many topics are on it and which sections are still empty, the arc step it carries, and how ready the meeting is. Use it for 'what's my week look like' and to find what needs planning; then get_agenda for one.",
    scope: "agenda:read",
    annotations: READS,
    input: obj({
      days: opt(int({ min: 1, max: 90, description: "How far ahead to look. Default 14." })),
      meeting: opt(str({ min: 1, max: 100, description: "Only this meeting (id or name)." })),
      today: TODAY,
    }),
    run: async (input, ctx) =>
      guarded(async () => {
        const { ws, env } = await readWorkspace(ctx, input.today);
        const days = input.days ?? 14;
        const end = new Date(Date.parse(`${env.today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
        const q = input.meeting?.trim().toLowerCase();
        const meetings = q
          ? ws.agenda.meetings.filter((m) => m.id === input.meeting!.trim() || titleOf(ws, m).toLowerCase().includes(q))
          : ws.agenda.meetings;
        if (q && !meetings.length) throw new ToolError("not_found", `No meeting matches "${input.meeting}". Use list_meetings.`);
        const occurrences = meetings.flatMap((m) => {
          // Enough slots to cover the window for the fastest rhythm.
          const slots = slotsOf(ws, m, env.today, Math.max(2, Math.ceil(days / 7) + 2));
          const curriculum = m.curriculum ?? [];
          return slots
            .filter((s) => !s.past && s.date <= end)
            .map((s) => {
              const session = s.sessionId ? ws.agenda.sessions.find((o) => o.id === s.sessionId) : undefined;
              const here = s.sessionId ? ws.agenda.topics.filter((t) => t.sessionId === s.sessionId && t.status !== "dropped") : [];
              const empty = curriculum.filter((c) => !here.some((t) => effectiveSlotId(t, curriculum) === c.id)).map((c) => c.label);
              const steps = ws.arcs
                .filter((a) => a.meetingId === m.id && a.status === "active")
                .flatMap((a) => (arcPlan(a, slots).get(s.date) ?? []).map((p) => `${a.title}: ${p.step.label}`));
              return {
                date: s.date,
                weekday: weekdayName(s.date).slice(0, 3),
                meeting: withName(ws, m),
                with: subjectName(ws, m),
                status: s.projected ? "projected" : "booked",
                ...(s.sessionId ? { session_id: s.sessionId } : {}),
                ...(session?.point ? { point: session.point } : {}),
                topics: here.length,
                ...(here.some((t) => t.urgent) ? { urgent: here.filter((t) => t.urgent).map((t) => t.text) } : {}),
                ...(curriculum.length && empty.length ? { empty_sections: empty } : {}),
                ...(steps.length ? { arc_steps: steps } : {}),
                ...sharedNote(ws, m.id),
              };
            });
        });
        // A skipped week is part of the picture: "no 1:1 this Thursday" is news.
        const shown = new Set(meetings.map((m) => m.id));
        const skipped = ws.agenda.sessions
          .filter((o) => o.kind === "skipped" && shown.has(o.meetingId) && o.date >= env.today && o.date <= end)
          .map((o) => {
            const m = meetings.find((x) => x.id === o.meetingId)!;
            return { date: o.date, weekday: weekdayName(o.date).slice(0, 3), meeting: withName(ws, m), with: subjectName(ws, m), status: "skipped", session_id: o.id, topics: 0 };
          });
        occurrences.push(...(skipped as typeof occurrences));
        occurrences.sort((a, b) => a.date.localeCompare(b.date) || a.meeting.title.localeCompare(b.meeting.title));
        return {
          today: env.today,
          through: end,
          occurrences,
          meetings: meetings.map((m) => ({ ...withName(ws, m), ...meetingHealth(ws, m, env.today) })),
        };
      }),
  }),

  tool({
    name: "create_meeting",
    title: "Create a meeting",
    description:
      "Start tracking a new recurring meeting with a person, team or manager already in the workspace (find them with list_people). Always creates a new meeting, even if one with them exists — a 1:1 and a career check-in are two meetings. Set sections afterwards with set_sections.",
    scope: "agenda:write",
    annotations: WRITES,
    input: obj({
      with: str({ min: 1, max: 100, description: "Who it's with: a person, team or manager, by name or id." }),
      kind: opt(enumOf(["person", "team", "manager"] as const, { description: "Narrow `with` when a name is shared." })),
      name: opt(str({ min: 1, max: 80, description: "A name for the meeting, e.g. 'Career check-in'. Default: the person's or team's name." })),
      rhythm: opt(enumOf(["weekly", "biweekly", "monthly", "quarterly", "as_needed"] as const, { description: "Default weekly." })),
      weekday: opt(int({ min: 0, max: 6, description: "0 = Sunday … 6 = Saturday." })),
      next_date: opt(date({ description: "First meeting date." })),
      role: opt(enumOf(["convene", "attend"] as const, { description: "convene: the leader runs it (default); attend: someone else does." })),
      today: TODAY,
    }),
    run: async (input, ctx) => {
      const out = await mutate(ctx, "create_meeting", input.today, (ws, env) => {
        const subject = resolveSubject(ws, input.with, input.kind);
        const r = createMeeting(ws.agenda, env, {
          subjectKind: subject.kind,
          subjectId: subject.id,
          name: input.name,
          rhythm: input.rhythm,
          anchorWeekday: input.weekday,
          nextDate: input.next_date,
          role: input.role,
        });
        const after = { ...ws, agenda: r.state };
        return {
          edit: { agenda: r.state, arcs: ws.arcs, takeaways: ws.takeaways },
          summary: `Created the meeting ${titleOf(after, r.value)}`,
          value: { meeting: { ...withName(after, r.value), with: { kind: subject.kind, name: subject.name } }, plan: planView(after, r.value, env.today, 4) },
        };
      });
      return done(out.saved, out.summary, out.value);
    },
  }),

  tool({
    name: "update_tag",
    title: "Edit a tag",
    description: `Rename, recolour or reorder a tag. Colours: ${TAG_COLORS.map((c, i) => `${i} ${c}`).join(", ")}. Position is 0-based among the tags.`,
    scope: "agenda:write",
    annotations: WRITES,
    input: obj({
      tag: str({ min: 1, max: 40, description: "Tag id or current label." }),
      label: opt(str({ min: 1, max: 40 })),
      color: opt(int({ min: 0, max: 5 })),
      position: opt(int({ min: 0, max: 200 })),
    }),
    run: async (input, ctx) => {
      if (input.label === undefined && input.color === undefined && input.position === undefined) {
        throw new ToolError("invalid_arguments", "Pass `label`, `color` and/or `position`.");
      }
      const out = await mutate(ctx, "update_tag", undefined, (ws) => {
        const hit = findTag(ws, input.tag);
        let agenda = ws.agenda;
        if (input.label !== undefined) agenda = renameTag(agenda, hit.id, input.label).state;
        const r = updateTag(agenda, hit.id, { color: input.color, position: input.position });
        return {
          edit: { agenda: r.state, arcs: ws.arcs, takeaways: ws.takeaways },
          summary: `Edited the tag "${r.value.label}"`,
          value: { tag: { id: r.value.id, label: r.value.label, color: TAG_COLORS[r.value.color] ?? r.value.color } },
        };
      });
      return done(out.saved, out.summary, out.value);
    },
  }),

  tool({
    name: "delete_tag",
    title: "Delete a tag",
    description:
      "Remove a tag everywhere: off every topic (the topics stay), off any section that stamped it, and out of coverage targets. Undoable with undo_change.",
    scope: "agenda:write",
    annotations: DELETES,
    input: obj({ tag: str({ min: 1, max: 40, description: "Tag id or label." }) }),
    run: async (input, ctx) => {
      const out = await mutate(ctx, "delete_tag", undefined, (ws) => {
        const hit = findTag(ws, input.tag);
        const used = ws.agenda.topics.filter((t) => t.tagIds.includes(hit.id)).length;
        const r = deleteTag(ws.agenda, hit.id);
        return {
          edit: { agenda: r.state, arcs: ws.arcs, takeaways: ws.takeaways },
          summary: `Deleted the tag "${hit.label}"${used ? ` (was on ${used} topic${used === 1 ? "" : "s"})` : ""}`,
          value: { untagged_topics: used },
        };
      });
      return done(out.saved, out.summary, out.value);
    },
  }),
];
