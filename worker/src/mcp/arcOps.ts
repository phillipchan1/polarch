/**
 * Arc operations for the MCP tools. Pure over an `Edit`, like `agendaOps`.
 *
 * The arithmetic of an arc — what's current, how a mark closes it, what a
 * step's practice is called — lives in `src/lib/arcs.ts` and is used as is.
 * What lives here is what the store does around it (opening the "Try"
 * follow-up when a step is done, cascading a delete) and the validation an
 * assistant needs that a screen doesn't.
 */
import {
  OpError,
  ensureOccurrence,
  isISODate,
  meetingOf,
  upcomingSlots,
  type OpEnv,
} from "../../../src/lib/agendaOps.ts";
import { markStep, practiceText, takeawayId, unmarkStep, type StepMark } from "../../../src/lib/arcs.ts";
import type { Arc, ArcStep, FollowUp, Takeaway } from "../../../src/types";
import type { Edit } from "./workspace.ts";

/**
 * `undefined` leaves a field alone on an existing step (and means "none" on a new
 * one); `null` or an empty list clears it. Listing a step by id and label alone
 * must never wipe its Read, Talk and Try.
 */
export type StepInput = {
  id?: string;
  label: string;
  read?: string | null;
  prompts?: string[];
  practice?: string | null;
};

const invalid = (m: string, d?: Record<string, unknown>) => new OpError("invalid", m, d);

function arcOf(edit: Edit, id: string): Arc {
  const arc = edit.arcs.find((a) => a.id === id);
  if (!arc) throw new OpError("not_found", `No arc with id "${id}".`);
  return arc;
}

function stepOf(arc: Arc, id: string): ArcStep {
  const step = arc.steps.find((s) => s.id === id);
  if (!step) {
    throw new OpError("not_found", `"${arc.title}" has no step "${id}".`, {
      steps: arc.steps.map((s) => ({ id: s.id, label: s.label, status: s.status })),
    });
  }
  return step;
}

function clean(text: string | undefined, label: string, max: number): string | undefined {
  const t = text?.trim();
  if (!t) return undefined;
  if (t.length > max) throw invalid(`${label} is too long (max ${max} characters).`);
  return t;
}

function buildStep(input: StepInput, uid: () => string, prev?: ArcStep): ArcStep {
  const label = clean(input.label, "A step's label", 140);
  if (!label) throw invalid("Every step needs a label.");
  const text = (given: string | null | undefined, kept: string | undefined, name: string, max: number) =>
    given === undefined ? kept : given === null ? undefined : clean(given, name, max);
  const prompts =
    input.prompts === undefined
      ? (prev?.prompts ?? [])
      : input.prompts.map((p) => clean(p, "A talking prompt", 300)).filter((p): p is string => Boolean(p));
  if (prompts.length > 5) throw invalid("At most 5 talking prompts per step.");
  return {
    id: prev?.id ?? uid(),
    label,
    read: text(input.read, prev?.read, "'read'", 140),
    prompts,
    practice: text(input.practice, prev?.practice, "'try'", 300),
    status: prev?.status ?? "upcoming",
    coveredIn: prev?.coveredIn ?? [],
    doneOn: prev?.doneOn,
  };
}

function replaceArc(edit: Edit, next: Arc): Edit {
  return { ...edit, arcs: edit.arcs.map((a) => (a.id === next.id ? next : a)) };
}

const finished = (steps: ArcStep[]) => steps.length > 0 && steps.every((s) => s.status === "done");

export function createArc(
  edit: Edit,
  env: OpEnv,
  input: {
    meetingId: string;
    title: string;
    author?: string;
    steps: StepInput[];
    every?: number;
    startsOn?: string;
    slotId?: string;
  },
): { edit: Edit; value: Arc } {
  const meeting = meetingOf(edit.agenda, input.meetingId);
  const title = clean(input.title, "Title", 120);
  if (!title) throw invalid("An arc needs a title.");
  if (!input.steps.length) throw invalid("An arc needs at least one step.");
  if (input.steps.length > 60) throw invalid("At most 60 steps.");
  const every = input.every ?? 1;
  if (!(Number.isInteger(every) && every >= 1 && every <= 12)) throw invalid("'every' is a whole number of meetings, 1 to 12.");
  if (input.startsOn !== undefined && !isISODate(input.startsOn)) throw invalid(`"${input.startsOn}" isn't a date (use YYYY-MM-DD).`);
  if (input.slotId && !(meeting.curriculum ?? []).some((c) => c.id === input.slotId)) {
    throw invalid(`This meeting has no section "${input.slotId}".`);
  }
  // Starts at the next meeting unless told otherwise — the arc follows the pace, not the calendar.
  const startsOn = input.startsOn ?? upcomingSlots(edit.agenda, env, meeting, 2)[0]?.date ?? env.today;
  const arc: Arc = {
    id: env.uid(),
    meetingId: meeting.id,
    title,
    author: clean(input.author, "Author", 120),
    slotId: input.slotId,
    every,
    startsOn,
    status: "active",
    steps: input.steps.map((s) => buildStep({ ...s, id: undefined }, env.uid)),
    createdOn: env.today,
    order: edit.arcs.filter((a) => a.meetingId === meeting.id).length,
  };
  return { edit: { ...edit, arcs: [...edit.arcs, arc] }, value: arc };
}

export function updateArc(
  edit: Edit,
  arcId: string,
  patch: { title?: string; author?: string | null; every?: number; startsOn?: string; status?: "active" | "paused"; slotId?: string | null },
): { edit: Edit; value: Arc } {
  const arc = arcOf(edit, arcId);
  const next: Arc = { ...arc };
  if (patch.title !== undefined) {
    const t = clean(patch.title, "Title", 120);
    if (!t) throw invalid("An arc needs a title.");
    next.title = t;
  }
  if (patch.author !== undefined) next.author = patch.author === null ? undefined : clean(patch.author, "Author", 120);
  if (patch.every !== undefined) {
    if (!(Number.isInteger(patch.every) && patch.every >= 1 && patch.every <= 12)) throw invalid("'every' is a whole number of meetings, 1 to 12.");
    next.every = patch.every;
  }
  if (patch.startsOn !== undefined) {
    if (!isISODate(patch.startsOn)) throw invalid(`"${patch.startsOn}" isn't a date (use YYYY-MM-DD).`);
    next.startsOn = patch.startsOn;
  }
  if (patch.status !== undefined) {
    if (arc.status === "done") {
      throw invalid("A finished arc stays finished. Add steps with set_arc_steps to carry on.");
    }
    next.status = patch.status;
  }
  if (patch.slotId !== undefined) {
    if (patch.slotId !== null) {
      const m = meetingOf(edit.agenda, arc.meetingId);
      if (!(m.curriculum ?? []).some((c) => c.id === patch.slotId)) throw invalid(`This meeting has no section "${patch.slotId}".`);
    }
    next.slotId = patch.slotId ?? undefined;
  }
  return { edit: replaceArc(edit, next), value: next };
}

/**
 * Replace the step list, in the order given. A step that keeps its id keeps its
 * progress; a step with history can't be dropped, because the closing page is
 * made of that history.
 */
export function setArcSteps(
  edit: Edit,
  env: OpEnv,
  arcId: string,
  inputs: StepInput[],
): { edit: Edit; value: Arc } {
  const arc = arcOf(edit, arcId);
  if (!inputs.length) throw invalid("An arc needs at least one step.");
  if (inputs.length > 60) throw invalid("At most 60 steps.");
  const existing = new Map(arc.steps.map((s) => [s.id, s] as const));
  const seen = new Set<string>();
  const steps = inputs.map((input) => {
    if (!input.id) return buildStep(input, env.uid);
    const prev = existing.get(input.id);
    if (!prev) throw new OpError("not_found", `"${arc.title}" has no step "${input.id}".`);
    if (seen.has(input.id)) throw invalid(`Step "${input.id}" is listed twice.`);
    seen.add(input.id);
    return buildStep(input, env.uid, prev);
  });
  const dropped = arc.steps.filter((s) => !seen.has(s.id) && (s.status === "done" || s.coveredIn.length > 0));
  if (dropped.length) {
    throw invalid(
      `Can't remove steps that have already been worked on: ${dropped.map((s) => `"${s.label}"`).join(", ")}. Keep them in the list.`,
      { keep: dropped.map((s) => s.id) },
    );
  }
  const done = finished(steps);
  const next: Arc = {
    ...arc,
    steps,
    status: done ? "done" : arc.status === "done" ? "active" : arc.status,
    closedOn: done ? (arc.closedOn ?? env.today) : undefined,
  };
  return { edit: replaceArc(edit, next), value: next };
}

/**
 * Record what happened to a step in one meeting. Done opens the step's "Try" as
 * a follow-up owned by both chairs (once), so it comes back as "Since last time".
 */
export function markArcStep(
  edit: Edit,
  env: OpEnv,
  arcId: string,
  stepId: string,
  date: string,
  mark: StepMark,
): { edit: Edit; value: { arc: Arc; followUp?: FollowUp; booked: boolean } } {
  const arc = arcOf(edit, arcId);
  const step = stepOf(arc, stepId);
  if (!isISODate(date)) throw invalid(`"${date}" isn't a date (use YYYY-MM-DD).`);
  if (date > env.today) throw invalid("That meeting hasn't happened yet. Mark a step once it has been talked about.");
  const meeting = meetingOf(edit.agenda, arc.meetingId);
  const at = ensureOccurrence(edit.agenda, env, meeting.id, date);
  const sessionId = at.sessionId;
  const next = markStep(arc, stepId, sessionId, mark, env.today);

  const text = practiceText(step);
  let followUp: FollowUp | undefined;
  if (mark === "done" && step.practice && !edit.agenda.followUps.some((f) => f.meetingId === meeting.id && f.text === text)) {
    followUp = {
      id: env.uid(),
      subjectKind: meeting.subjectKind,
      subjectId: meeting.subjectId,
      meetingId: meeting.id,
      text,
      status: "open",
      openedOn: env.today,
      sourceSessionId: sessionId,
      order: edit.agenda.followUps.length,
      owner: "both",
    };
  }
  return {
    edit: {
      ...edit,
      agenda: {
        ...edit.agenda,
        sessions: at.sessions,
        ...(followUp ? { followUps: [...edit.agenda.followUps, followUp] } : {}),
      },
      arcs: edit.arcs.map((a) => (a.id === arcId ? next : a)),
    },
    value: { arc: next, followUp, booked: at.booked },
  };
}

/** Take back a mark. The practice it opened goes too, unless it was already ticked off. */
export function unmarkArcStep(
  edit: Edit,
  arcId: string,
  stepId: string,
  date: string,
): { edit: Edit; value: Arc } {
  const arc = arcOf(edit, arcId);
  const step = stepOf(arc, stepId);
  const session = edit.agenda.sessions.find((o) => o.meetingId === arc.meetingId && o.date === date && o.kind !== "skipped");
  if (!session || !step.coveredIn.includes(session.id)) {
    throw invalid(`"${step.label}" wasn't marked in the ${date} meeting.`);
  }
  const text = practiceText(step);
  const next = unmarkStep(arc, stepId, session.id);
  return {
    edit: {
      ...edit,
      agenda: {
        ...edit.agenda,
        followUps: edit.agenda.followUps.filter(
          (f) => !(f.meetingId === arc.meetingId && f.text === text && f.sourceSessionId === session.id && f.status === "open"),
        ),
      },
      arcs: edit.arcs.map((a) => (a.id === arcId ? next : a)),
    },
    value: next,
  };
}

/** "We chose not to touch the arc that week" — stops the did-you-cover-it prompt for it. */
export function passArc(edit: Edit, arcId: string, date: string): { edit: Edit; value: Arc } {
  const arc = arcOf(edit, arcId);
  const session = edit.agenda.sessions.find((o) => o.meetingId === arc.meetingId && o.date === date && o.kind !== "skipped");
  if (!session) throw invalid(`There was no meeting on ${date}.`);
  const next = arc.passedIn?.includes(session.id) ? arc : { ...arc, passedIn: [...(arc.passedIn ?? []), session.id] };
  return { edit: replaceArc(edit, next), value: next };
}

/** The owner's one-line takeaway for a step. Empty text removes it. */
export function setTakeaway(
  edit: Edit,
  env: OpEnv,
  arcId: string,
  stepId: string,
  text: string,
): { edit: Edit; value: Takeaway | null } {
  const arc = arcOf(edit, arcId);
  stepOf(arc, stepId);
  const id = takeawayId(stepId, "owner");
  const body = text.trim();
  if (body.length > 500) throw invalid("A takeaway is one line (max 500 characters).");
  const rest = edit.takeaways.filter((t) => t.id !== id);
  if (!body) return { edit: { ...edit, takeaways: rest }, value: null };
  const takeaway: Takeaway = { id, arcId, stepId, by: "owner", text: body, on: env.today };
  return { edit: { ...edit, takeaways: [...rest, takeaway] }, value: takeaway };
}

export function deleteArc(edit: Edit, arcId: string): { edit: Edit; value: Arc } {
  const arc = arcOf(edit, arcId);
  return {
    edit: {
      ...edit,
      arcs: edit.arcs.filter((a) => a.id !== arcId),
      takeaways: edit.takeaways.filter((t) => t.arcId !== arcId),
    },
    value: arc,
  };
}
