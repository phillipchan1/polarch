/**
 * Arc tools: something worked through one step per meeting — a book, an
 * onboarding plan, a study.
 *
 * An arc holds a position and a pace, never a schedule. These tools therefore
 * never "place step 4 on the 12th": they set the steps and the pace, and the
 * plan you see (get_plan, get_arc) is drawn from where the arc stands against
 * the meeting's upcoming weeks. Skip a week and it slides by itself.
 */
import {
  createArc,
  deleteArc,
  markArcStep,
  setArcSteps,
  setTakeaway,
  unmarkArcStep,
  updateArc,
} from "../arcOps.ts";
import { arr, date, enumOf, int, nullable, obj, opt, str } from "../schema.ts";
import { DELETES, READS, ToolError, WRITES, tool, type ToolDef } from "../server.ts";
import type { Workspace } from "../workspace.ts";
import { MEETING, TODAY, arcDetail } from "./read.ts";
import { done } from "./topics.ts";
import { arcSummary, mutate, readWorkspace, guarded, resolveMeeting, resolveSection, titleOf } from "./views.ts";
import type { Arc, ArcStep } from "../../../../src/types";

const ARC = str({ min: 1, max: 100, description: "An arc's id or its title (see list_arcs)." });

function resolveArc(ws: Workspace, query: string): Arc {
  const q = query.trim().toLowerCase();
  const byId = ws.arcs.find((a) => a.id === query.trim());
  if (byId) return byId;
  const named = ws.arcs.filter((a) => a.title.trim().toLowerCase() === q);
  const hits = named.length ? named : ws.arcs.filter((a) => q && a.title.toLowerCase().includes(q));
  if (hits.length === 1) return hits[0];
  const candidates = (hits.length ? hits : ws.arcs).map((a) => ({ id: a.id, title: a.title }));
  throw new ToolError(hits.length ? "ambiguous_arc" : "arc_not_found", hits.length ? `"${query}" matches more than one arc.` : `No arc matches "${query}".`, { arcs: candidates });
}

/** A step by id, by its label ("Ch. 4"), or by its position ("4"). */
function resolveStep(arc: Arc, ref: string): ArcStep {
  const r = ref.trim();
  const q = r.toLowerCase();
  const hit =
    arc.steps.find((s) => s.id === r) ??
    arc.steps.find((s) => s.label.trim().toLowerCase() === q) ??
    (arc.steps.filter((s) => s.label.toLowerCase().startsWith(q)).length === 1
      ? arc.steps.find((s) => s.label.toLowerCase().startsWith(q))
      : undefined) ??
    (/^\d+$/.test(r) ? arc.steps[Number(r) - 1] : undefined);
  if (!hit) {
    throw new ToolError("step_not_found", `"${arc.title}" has no step "${ref}".`, {
      steps: arc.steps.map((s, i) => ({ id: s.id, n: i + 1, label: s.label, status: s.status })),
    });
  }
  return hit;
}

const STEP = obj({
  label: str({ min: 1, max: 140, description: "e.g. 'Ch. 4 · Start with Heart'." }),
  read: opt(str({ min: 1, max: 140, description: "What to do before the meeting, e.g. 'pp. 49–68'." })),
  talk: opt(arr(str({ min: 1, max: 300 }), { max: 5, description: "One or two open questions for the meeting itself." })),
  try: opt(str({ min: 1, max: 300, description: "One thing to practise before next time. Becomes a follow-up when the step is done." })),
});

const STEP_WITH_ID = obj({
  id: opt(str({ min: 1, max: 40, description: "An existing step's id, to keep its progress and content." })),
  label: str({ min: 1, max: 140 }),
  read: opt(nullable(str({ min: 1, max: 140, description: "Omit to keep an existing step's Read; null clears it." }))),
  talk: opt(arr(str({ min: 1, max: 300 }), { max: 5, description: "Omit to keep an existing step's prompts; [] clears them." })),
  try: opt(nullable(str({ min: 1, max: 300, description: "Omit to keep an existing step's Try; null clears it." }))),
});

type StepIn = { id?: string; label: string; read?: string | null; talk?: string[]; try?: string | null };
const toStep = (s: StepIn) => ({ id: s.id, label: s.label, read: s.read, prompts: s.talk, practice: s.try });

export const arcTools: ToolDef[] = [
  tool({
    name: "list_arcs",
    title: "List arcs",
    description: "Arcs — things worked through one step per meeting (a book, an onboarding plan) — with progress and the step each is on. Finished ones are included only if asked.",
    scope: "agenda:read",
    annotations: READS,
    input: obj({ meeting: opt(MEETING), include_finished: opt(enumOf(["yes", "no"] as const, { description: "Default no." })) }),
    run: async (input, ctx) =>
      guarded(async () => {
        const { ws } = await readWorkspace(ctx);
        const m = input.meeting ? resolveMeeting(ws, input.meeting) : undefined;
        const list = ws.arcs
          .filter((a) => (!m || a.meetingId === m.id) && (input.include_finished === "yes" || a.status !== "done"))
          .sort((a, b) => a.order - b.order);
        return { arcs: list.map((a) => arcSummary(ws, a)) };
      }),
  }),

  tool({
    name: "get_arc",
    title: "Get an arc",
    description: "One arc in full: every step with its Read / Talk / Try, status, the meetings it was talked about in, takeaways, and — for a live arc — which upcoming meeting each remaining step lands on at its pace.",
    scope: "agenda:read",
    annotations: READS,
    input: obj({ arc: ARC, today: TODAY }),
    run: async (input, ctx) =>
      guarded(async () => {
        const { ws, env } = await readWorkspace(ctx, input.today);
        return arcDetail(ws, resolveArc(ws, input.arc), env.today);
      }),
  }),

  tool({
    name: "create_arc",
    title: "Create an arc",
    description:
      "Start an arc on a meeting: a title, optional author, and an ordered list of steps (each can have a Read, up to a few Talk prompts, and a Try practice). It starts at the next meeting and takes one step per meeting unless `every` says otherwise. You write the steps — for a book, one per chapter; check chapter titles and page ranges you aren't sure of and say so rather than invent them. `section` puts the arc in a standing-agenda row.",
    scope: "agenda:write",
    annotations: WRITES,
    input: obj({
      meeting: MEETING,
      title: str({ min: 1, max: 120 }),
      author: opt(str({ min: 1, max: 120 })),
      steps: arr(STEP, { min: 1, max: 60 }),
      every: opt(int({ min: 1, max: 12, description: "One step every N meetings. Default 1." })),
      starts_on: opt(date({ description: "Nothing lands before this date. Default: the next meeting." })),
      section: opt(str({ min: 1, max: 60, description: "A section of the meeting to sit in (label or id)." })),
      today: TODAY,
    }),
    run: async (input, ctx) => {
      const out = await mutate(ctx, "create_arc", input.today, (ws, env) => {
        const m = resolveMeeting(ws, input.meeting);
        const r = createArc({ agenda: ws.agenda, arcs: ws.arcs, takeaways: ws.takeaways }, env, {
          meetingId: m.id,
          title: input.title,
          author: input.author,
          steps: input.steps.map(toStep),
          every: input.every,
          startsOn: input.starts_on,
          slotId: input.section ? resolveSection(m, input.section) : undefined,
        });
        return {
          edit: r.edit,
          summary: `Started the arc "${r.value.title}" on ${titleOf(ws, m)} (${r.value.steps.length} steps)`,
          value: { arc: arcDetail({ ...ws, ...r.edit }, r.value, env.today) },
        };
      });
      return done(out.saved, out.summary, out.value);
    },
  }),

  tool({
    name: "update_arc",
    title: "Change an arc",
    description: "Rename an arc, change its pace (`every`), when it starts, pause or resume it, or move it to another section. Pausing keeps its history and stops it landing on upcoming meetings.",
    scope: "agenda:write",
    annotations: WRITES,
    input: obj({
      arc: ARC,
      title: opt(str({ min: 1, max: 120 })),
      author: opt(nullable(str({ min: 1, max: 120 }))),
      every: opt(int({ min: 1, max: 12 })),
      starts_on: opt(date()),
      status: opt(enumOf(["active", "paused"] as const)),
      section: opt(nullable(str({ min: 1, max: 60, description: "Section label or id; null for the arc's own band." }))),
      today: TODAY,
    }),
    run: async (input, ctx) => {
      const out = await mutate(ctx, "update_arc", input.today, (ws, env) => {
        const arc = resolveArc(ws, input.arc);
        const m = ws.agenda.meetings.find((x) => x.id === arc.meetingId)!;
        const r = updateArc({ agenda: ws.agenda, arcs: ws.arcs, takeaways: ws.takeaways }, arc.id, {
          title: input.title,
          author: input.author,
          every: input.every,
          startsOn: input.starts_on,
          status: input.status,
          slotId: input.section === undefined ? undefined : input.section === null ? null : resolveSection(m, input.section),
        });
        return { edit: r.edit, summary: `Updated the arc "${r.value.title}"`, value: { arc: arcDetail({ ...ws, ...r.edit }, r.value, env.today) } };
      });
      return done(out.saved, out.summary, out.value);
    },
  }),

  tool({
    name: "set_arc_steps",
    title: "Set an arc's steps",
    description:
      "Replace an arc's step list, in order. Pass an existing step's `id` to keep its progress, and its Read/Talk/Try too unless you pass new values; steps without an id are new. Steps that were already worked on can't be removed. Use this to add, reorder, reword or drop upcoming steps. Pass the full list every time.",
    scope: "agenda:write",
    annotations: WRITES,
    input: obj({ arc: ARC, steps: arr(STEP_WITH_ID, { min: 1, max: 60 }), today: TODAY }),
    run: async (input, ctx) => {
      const out = await mutate(ctx, "set_arc_steps", input.today, (ws, env) => {
        const arc = resolveArc(ws, input.arc);
        const r = setArcSteps({ agenda: ws.agenda, arcs: ws.arcs, takeaways: ws.takeaways }, env, arc.id, input.steps.map(toStep));
        return { edit: r.edit, summary: `Set ${r.value.steps.length} steps on "${r.value.title}"`, value: { arc: arcDetail({ ...ws, ...r.edit }, r.value, env.today) } };
      });
      return done(out.saved, out.summary, out.value);
    },
  }),

  tool({
    name: "mark_arc_step",
    title: "Record what happened to an arc step",
    description:
      "After a meeting: mark a step 'done' (finished — the arc moves on, and the step's Try opens as a follow-up for next time) or 'again' (talked about but carrying on next meeting — it holds its place). `date` is the meeting it was talked about in — today or earlier, and it must be a meeting that was held or is today. Marking the last step done completes the arc.",
    scope: "agenda:write",
    annotations: WRITES,
    input: obj({
      arc: ARC,
      step: str({ min: 1, max: 100, description: "Step id, label ('Ch. 4'), or position ('4')." }),
      date: date({ description: "The meeting's date." }),
      mark: enumOf(["done", "again"] as const),
      today: TODAY,
    }),
    run: async (input, ctx) => {
      const out = await mutate(ctx, "mark_arc_step", input.today, (ws, env) => {
        const arc = resolveArc(ws, input.arc);
        const step = resolveStep(arc, input.step);
        const r = markArcStep({ agenda: ws.agenda, arcs: ws.arcs, takeaways: ws.takeaways }, env, arc.id, step.id, input.date, input.mark);
        const after = { ...ws, ...r.edit };
        return {
          edit: r.edit,
          summary: `Marked "${step.label}" ${input.mark === "done" ? "done" : "to carry on"} in "${arc.title}"`,
          value: {
            arc: arcDetail(after, r.value.arc, env.today),
            ...(r.value.followUp ? { opened_follow_up: r.value.followUp.text } : {}),
            ...(r.value.arc.status === "done" ? { arc_completed: true } : {}),
          },
        };
      });
      return done(out.saved, out.summary, out.value);
    },
  }),

  tool({
    name: "unmark_arc_step",
    title: "Take back an arc step mark",
    description: "Undo a mark made by mistake. The Try follow-up it opened is removed too, unless it was already ticked off.",
    scope: "agenda:write",
    annotations: WRITES,
    input: obj({ arc: ARC, step: str({ min: 1, max: 100 }), date: date({ description: "The meeting it was marked in." }), today: TODAY }),
    run: async (input, ctx) => {
      const out = await mutate(ctx, "unmark_arc_step", input.today, (ws, env) => {
        const arc = resolveArc(ws, input.arc);
        const step = resolveStep(arc, input.step);
        const r = unmarkArcStep({ agenda: ws.agenda, arcs: ws.arcs, takeaways: ws.takeaways }, arc.id, step.id, input.date);
        return { edit: r.edit, summary: `Unmarked "${step.label}" in "${arc.title}"`, value: { arc: arcDetail({ ...ws, ...r.edit }, r.value, env.today) } };
      });
      return done(out.saved, out.summary, out.value);
    },
  }),

  tool({
    name: "set_takeaway",
    title: "Set the leader's takeaway for a step",
    description: "The leader's one-line takeaway from an arc step — what the closing page is made of. An empty string removes it.",
    scope: "agenda:write",
    annotations: WRITES,
    input: obj({ arc: ARC, step: str({ min: 1, max: 100 }), text: str({ max: 500 }), today: TODAY }),
    run: async (input, ctx) => {
      const out = await mutate(ctx, "set_takeaway", input.today, (ws, env) => {
        const arc = resolveArc(ws, input.arc);
        const step = resolveStep(arc, input.step);
        const r = setTakeaway({ agenda: ws.agenda, arcs: ws.arcs, takeaways: ws.takeaways }, env, arc.id, step.id, input.text);
        return { edit: r.edit, summary: `${r.value ? "Set" : "Cleared"} the takeaway for "${step.label}"`, value: { takeaway: r.value?.text ?? null } };
      });
      return done(out.saved, out.summary, out.value);
    },
  }),

  tool({
    name: "delete_arc",
    title: "Delete an arc",
    description: "Permanently remove an arc and its takeaways. Prefer pausing it with update_arc. Undoable with undo_change.",
    scope: "agenda:write",
    annotations: DELETES,
    input: obj({ arc: ARC, today: TODAY }),
    run: async (input, ctx) => {
      const out = await mutate(ctx, "delete_arc", input.today, (ws) => {
        const arc = resolveArc(ws, input.arc);
        const r = deleteArc({ agenda: ws.agenda, arcs: ws.arcs, takeaways: ws.takeaways }, arc.id);
        return { edit: r.edit, summary: `Deleted the arc "${r.value.title}"`, value: { deleted: { id: r.value.id, title: r.value.title } } };
      });
      return done(out.saved, out.summary, out.value);
    },
  }),
];
