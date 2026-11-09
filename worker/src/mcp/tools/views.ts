/**
 * What the tools hand back to the model: the same facts the screens show,
 * labelled the way a person would say them, with the ids needed to act on each.
 *
 * Compact on purpose — a plan with forty topics must fit comfortably in a
 * context window — so empty and default fields are left out rather than
 * printed as null.
 */
import { OpError, type OpEnv } from "../../../../src/lib/agendaOps.ts";
import { flagFromEnv, flagOn } from "../../../../src/lib/flags.ts";
import { arcPlan, currentStep, progressOf, type PlannedStep } from "../../../../src/lib/arcs.ts";
import { coverageStats } from "../../../../src/lib/ideas.ts";
import { STATE_LABEL, meetingSubjectName, meetingTitle, readinessOf } from "../../../../src/lib/readiness.ts";
import { formatAhead, runwayOf } from "../../../../src/lib/runway.ts";
import { effectiveSlotId, plannedSlots, type Slot } from "../../../../src/lib/topics.ts";
import type { Arc, FollowUp, Session, Topic, TrackedMeeting } from "../../../../src/types";
import { newId, ConflictError, loadWorkspace, saveWorkspace, type Edit, type SaveResult, type Workspace } from "../workspace.ts";
import { ToolError, type ToolContext } from "../server.ts";

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** Which list of the directory a meeting's subject lives in. (Not `kind + "s"`: it's "people".) */
export const DIR_KEY = { person: "people", team: "teams", manager: "managers" } as const;

export function subjectName(
  ws: Workspace,
  m: { subjectKind: "person" | "team" | "manager"; subjectId: string },
): string | null {
  return (ws.dir[DIR_KEY[m.subjectKind]] as { id: string; name: string }[]).find((x) => x.id === m.subjectId)?.name ?? null;
}

export const utcToday = () => new Date().toISOString().slice(0, 10);

export function weekdayName(iso: string): string {
  return WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()];
}

export function opEnv(today?: string, env?: { SINGLE_OCCURRENCE_GUARD?: string }): OpEnv {
  return {
    uid: newId,
    today: today ?? utcToday(),
    singleOccurrenceGuard: flagOn("singleOccurrenceGuard") || flagFromEnv(env?.SINGLE_OCCURRENCE_GUARD),
  };
}

/** Ops and the data layer fail in their own vocabulary; the model hears one. */
export async function guarded<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof OpError) throw new ToolError(err.code, err.message, err.details);
    if (err instanceof ConflictError) throw new ToolError("conflict", err.message);
    throw err;
  }
}

export type Loaded = { ws: Workspace; env: OpEnv };

/** Load the user's workspace for a read. */
export async function readWorkspace(ctx: ToolContext, today?: string): Promise<Loaded> {
  return { ws: await loadWorkspace(ctx.sql, ctx.principal.userId), env: opEnv(today, ctx.env) };
}

export type Mutation<T> = { edit: Edit; value: T; summary: string };

/**
 * Load, change, save — one unit. Whatever `fn` throws leaves the rows exactly as
 * they were; whatever it returns is written in one transaction and journaled.
 */
export async function mutate<T>(
  ctx: ToolContext,
  tool: string,
  today: string | undefined,
  fn: (ws: Workspace, env: OpEnv) => Mutation<T>,
): Promise<{ value: T; saved: SaveResult; env: OpEnv; ws: Workspace; summary: string }> {
  return guarded(async () => {
    const ws = await loadWorkspace(ctx.sql, ctx.principal.userId);
    const env = opEnv(today, ctx.env);
    const out = fn(ws, env);
    const saved = await saveWorkspace(ctx.sql, ctx.principal.userId, ws, out.edit, {
      tool,
      clientId: ctx.principal.clientId,
      summary: out.summary,
    });
    return { value: out.value, saved, env, ws, summary: out.summary };
  });
}

// ── Naming ────────────────────────────────────────────────────────────────

export function titleOf(ws: Workspace, m: TrackedMeeting): string {
  return meetingTitle(m, meetingSubjectName(m, ws.dir));
}

export function withName(ws: Workspace, m: TrackedMeeting): { id: string; title: string } {
  return { id: m.id, title: titleOf(ws, m) };
}

/**
 * A meeting from whatever the model has: an id, or a name it heard — "Meghan",
 * "staff". Ambiguity is an error that lists the candidates, never a guess.
 */
export function resolveMeeting(ws: Workspace, query: string): TrackedMeeting {
  const meetings = ws.agenda.meetings;
  const q = query.trim().toLowerCase();
  const byId = meetings.find((m) => m.id === query.trim());
  if (byId) return byId;
  const labelled = meetings.map((m) => ({
    m,
    title: titleOf(ws, m).toLowerCase(),
    who: (meetingSubjectName(m, ws.dir) ?? "").toLowerCase(),
  }));
  const exact = labelled.filter((x) => x.title === q || x.who === q);
  const hits = exact.length ? exact : labelled.filter((x) => q && (x.title.includes(q) || x.who.includes(q)));
  if (hits.length === 1) return hits[0].m;
  const candidates = (hits.length ? hits : labelled).map((x) => ({ id: x.m.id, title: titleOf(ws, x.m) }));
  if (hits.length > 1) {
    throw new ToolError("ambiguous_meeting", `"${query}" matches more than one meeting. Use one of these ids.`, { candidates });
  }
  throw new ToolError("meeting_not_found", `No meeting matches "${query}".`, { meetings: candidates });
}

/** A section by id or by label ("Prayer"). */
export function resolveSection(m: TrackedMeeting, ref: string): string {
  const slots = m.curriculum ?? [];
  const q = ref.trim().toLowerCase();
  const hit = slots.find((s) => s.id === ref.trim()) ?? slots.find((s) => s.label.trim().toLowerCase() === q);
  if (!hit) {
    throw new ToolError("section_not_found", `This meeting has no section "${ref}".`, {
      sections: slots.map((s) => ({ id: s.id, label: s.label })),
    });
  }
  return hit.id;
}

// ── Views ─────────────────────────────────────────────────────────────────

const tagLabels = (ws: Workspace, ids: string[]) =>
  ids.map((id) => ws.agenda.tags.find((t) => t.id === id)?.label).filter((x): x is string => Boolean(x));

export function topicView(ws: Workspace, t: Topic, opts: { meeting?: boolean } = {}) {
  const meeting = t.meetingId ? ws.agenda.meetings.find((m) => m.id === t.meetingId) : undefined;
  const row = meeting ? effectiveSlotId(t, meeting.curriculum ?? []) : undefined;
  const section = row ? meeting?.curriculum?.find((c) => c.id === row)?.label : undefined;
  const tags = tagLabels(ws, t.tagIds).filter((l) => l !== section);
  return {
    id: t.id,
    text: t.text,
    ...(t.detail ? { detail: t.detail } : {}),
    ...(section ? { section } : {}),
    ...(tags.length ? { tags } : {}),
    ...(t.urgent ? { urgent: true } : {}),
    ...(t.private ? { private: true } : {}),
    ...(t.shared ? { shared: true } : {}),
    ...(t.points?.length ? { points: t.points.map((p) => (p.done ? `[x] ${p.text}` : p.text)) } : {}),
    ...(t.status !== "open" ? { status: t.status } : {}),
    ...(t.carried ? { carried: t.carried } : {}),
    ...(t.dueDate ? { due: t.dueDate } : {}),
    ...(t.returnedFromDate ? { came_back_from: t.returnedFromDate } : {}),
    ...(t.raisedBy ? { raised_by: "the other person" } : {}),
    ...(opts.meeting && meeting ? { meeting: withName(ws, meeting) } : {}),
  };
}

export function followUpView(ws: Workspace, f: FollowUp) {
  const meeting = f.meetingId ? ws.agenda.meetings.find((m) => m.id === f.meetingId) : undefined;
  return {
    id: f.id,
    text: f.text,
    status: f.status,
    opened: f.openedOn,
    ...(f.closedOn ? { closed: f.closedOn } : {}),
    ...(f.owner ? { owner: f.owner } : {}),
    ...(f.private ? { private: true } : {}),
    ...(meeting ? { meeting: withName(ws, meeting) } : {}),
  };
}

function exceptionOf(s: Session | undefined): string | undefined {
  if (!s) return undefined;
  if (s.kind === "extra") return "one-off";
  if (s.seriesDate && s.seriesDate !== s.date) return `moved from ${weekdayName(s.seriesDate).slice(0, 3)} ${s.seriesDate}`;
  return undefined;
}

export function stepView(arc: Arc, p: PlannedStep) {
  const s = p.step;
  return {
    arc_id: arc.id,
    arc: arc.title,
    step_id: s.id,
    step: s.label,
    state: p.state,
    ...(s.read ? { read: s.read } : {}),
    ...(s.prompts.length ? { talk: s.prompts } : {}),
    ...(s.practice ? { try: s.practice } : {}),
    position: `${p.index + 1} of ${arc.steps.length}`,
  };
}

export function arcSummary(ws: Workspace, arc: Arc) {
  const p = progressOf(arc);
  const m = ws.agenda.meetings.find((x) => x.id === arc.meetingId);
  const cur = currentStep(arc);
  return {
    id: arc.id,
    title: arc.title,
    ...(arc.author ? { author: arc.author } : {}),
    status: arc.status,
    progress: `${p.done} of ${p.total} done`,
    ...(cur ? { current_step: { id: cur.id, label: cur.label } } : {}),
    every: arc.every === 1 ? "every meeting" : `every ${arc.every} meetings`,
    starts_on: arc.startsOn,
    ...(m ? { meeting: withName(ws, m) } : {}),
  };
}

/** Slots of a meeting: booked, projected, and (one) recent past. */
export function slotsOf(ws: Workspace, m: TrackedMeeting, today: string, ahead: number): Slot[] {
  return plannedSlots(m, ws.agenda.sessions, ws.agenda.topics, today, ahead);
}

function sectionsOf(m: TrackedMeeting) {
  return (m.curriculum ?? []).map((c) => ({ id: c.id, label: c.label, ...(c.minutes ? { minutes: c.minutes } : {}) }));
}

function arcStepsOn(ws: Workspace, m: TrackedMeeting, slots: Slot[], date: string) {
  return ws.arcs
    .filter((a) => a.meetingId === m.id && a.status !== "done")
    .flatMap((a) => (arcPlan(a, slots).get(date) ?? []).map((p) => stepView(a, p)));
}

export function sharedNote(ws: Workspace, meetingId: string | undefined) {
  const who = meetingId ? ws.sharedWith.get(meetingId) : undefined;
  return who?.length ? { shared_with: who } : {};
}

/** Topics of one occurrence, in running order, grouped by section. */
function groupBySection(ws: Workspace, m: TrackedMeeting, list: Topic[]) {
  const curriculum = m.curriculum ?? [];
  const ordered = [...list].sort((a, b) => a.order - b.order);
  if (!curriculum.length) return { topics: ordered.map((t) => topicView(ws, t)) };
  const rows = curriculum.map((c) => ({
    id: c.id,
    label: c.label,
    ...(c.minutes ? { minutes: c.minutes } : {}),
    topics: ordered.filter((t) => effectiveSlotId(t, curriculum) === c.id).map((t) => topicView(ws, t)),
  }));
  const loose = ordered.filter((t) => !effectiveSlotId(t, curriculum));
  return { sections: [...rows, ...(loose.length ? [{ id: null, label: "Unsectioned", topics: loose.map((t) => topicView(ws, t)) }] : [])] };
}

export function agendaView(ws: Workspace, m: TrackedMeeting, date: string | undefined, today: string) {
  const slots = slotsOf(ws, m, today, 8);
  const slot = date ? slots.find((s) => s.date === date) : slots.find((s) => !s.past);
  if (!slot) {
    throw new ToolError(
      "no_such_occurrence",
      date ? `${date} isn't an occurrence of this meeting.` : "This meeting has no upcoming occurrence.",
      { upcoming: slots.filter((s) => !s.past).map((s) => s.date) },
    );
  }
  const session = slot.sessionId ? ws.agenda.sessions.find((s) => s.id === slot.sessionId) : undefined;
  const here = slot.sessionId
    ? ws.agenda.topics.filter((t) => t.sessionId === slot.sessionId && t.status !== "dropped")
    : [];
  const previous = ws.agenda.sessions
    .filter((s) => s.meetingId === m.id && s.kind !== "skipped" && s.date < slot.date)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  const followUps = ws.agenda.followUps.filter((f) => f.status === "open" && f.meetingId === m.id);
  const cameBack = ws.agenda.topics.filter(
    (t) => t.meetingId === m.id && t.status === "open" && !t.sessionId && t.lane === "backlog" && t.returnedOn,
  );
  return {
    meeting: withName(ws, m),
    date: slot.date,
    weekday: weekdayName(slot.date),
    status: slot.past ? "past" : slot.projected ? "projected (not booked yet — planning into it books it)" : "booked",
    session_id: slot.sessionId,
    ...(exceptionOf(session) ? { exception: exceptionOf(session) } : {}),
    ...(session?.point ? { point: session.point } : {}),
    // Notes on an upcoming meeting are prep, which is agenda. Notes on one that
    // already happened are the leader's write-up — list_sessions(include_notes)
    // is the deliberate way to ask for those.
    ...(session?.notes && !slot.past ? { prep_notes: session.notes } : {}),
    ...groupBySection(ws, m, here),
    ...(followUps.length ? { since_last_time: followUps.map((f) => followUpView(ws, f)) } : {}),
    ...(cameBack.length ? { came_back_from_earlier_weeks: cameBack.map((t) => topicView(ws, t)) } : {}),
    arcs: arcStepsOn(ws, m, slots, slot.date),
    ...(previous
      ? { previous_meeting: { date: previous.date, ...(previous.point ? { point: previous.point } : {}), ...(previous.uncovered?.length ? { not_covered: previous.uncovered } : {}) } }
      : {}),
    ...sharedNote(ws, m.id),
  };
}

export function planView(ws: Workspace, m: TrackedMeeting, today: string, weeks: number) {
  const slots = slotsOf(ws, m, today, weeks);
  const mine = ws.agenda.topics.filter((t) => t.meetingId === m.id);
  const open = mine.filter((t) => t.status === "open");
  const upcoming = slots.filter((s) => !s.past);
  const coverage = coverageStats(
    m,
    upcoming.map((s) => s.sessionId),
    ws.agenda.topics,
    ws.agenda.tags,
  );
  return {
    today,
    meeting: {
      ...withName(ws, m),
      rhythm: m.rhythm,
      ...(m.anchorWeekday !== undefined ? { weekday: WEEKDAYS[m.anchorWeekday] } : {}),
    },
    sections: sectionsOf(m),
    weeks: slots.map((s) => {
      const session = s.sessionId ? ws.agenda.sessions.find((o) => o.id === s.sessionId) : undefined;
      const here = s.sessionId ? mine.filter((t) => t.sessionId === s.sessionId && t.status !== "dropped") : [];
      return {
        date: s.date,
        weekday: weekdayName(s.date).slice(0, 3),
        status: s.past ? "past" : s.projected ? "projected" : "booked",
        session_id: s.sessionId,
        ...(exceptionOf(session) ? { exception: exceptionOf(session) } : {}),
        ...(session?.point ? { point: session.point } : {}),
        ...groupBySection(ws, m, here),
        ...(s.past ? {} : { arc_steps: arcStepsOn(ws, m, slots, s.date) }),
      };
    }),
    ideas: open.filter((t) => !t.sessionId && t.lane === "backlog").sort((a, b) => a.order - b.order).map((t) => topicView(ws, t)),
    parked: open.filter((t) => !t.sessionId && t.lane === "parked").sort((a, b) => a.order - b.order).map((t) => topicView(ws, t)),
    skipped: ws.agenda.sessions
      .filter((o) => o.meetingId === m.id && o.kind === "skipped" && o.date >= today)
      .map((o) => ({ date: o.date, session_id: o.id })),
    ...(coverage.length
      ? { coverage: coverage.map((c) => ({ tag: c.label, planned_in: c.filled, of_weeks: c.total, wanted: `at least once every ${c.everyN}`, thin: c.thin })) }
      : {}),
    ...sharedNote(ws, m.id),
  };
}

/** The line a model should read before it places something where someone else can see it. */
export function visibilityWarnings(ws: Workspace, topics: Topic[]): string[] {
  const seen = new Map<string, string[]>();
  for (const t of topics) {
    if (t.private || !t.meetingId || (!t.sessionId && !t.shared)) continue;
    const who = ws.sharedWith.get(t.meetingId);
    if (who?.length) seen.set(t.meetingId, who);
  }
  return [...seen.entries()].map(([id, who]) => {
    const m = ws.agenda.meetings.find((x) => x.id === id);
    return `${m ? titleOf(ws, m) : "That meeting"} is shared with ${who.join(", ")}. Topics placed on a week, and ideas marked shared, are visible to them unless marked private (update_topic private:true).`;
  });
}

/** Readiness and runway for one meeting, in the words the Meetings screen uses. */
export function meetingHealth(ws: Workspace, m: TrackedMeeting, today: string) {
  const r = readinessOf(m, ws.agenda, today);
  const runway = runwayOf(m, ws.agenda.sessions, ws.agenda.topics, today);
  return {
    readiness: { state: STATE_LABEL[r.state], headline: r.headline, ...(r.lastMet ? { last_met: r.lastMet } : {}) },
    ...(runway.level !== "none"
      ? {
          planned_ahead: {
            meetings: formatAhead(runway),
            ...(runway.through ? { through: runway.through } : {}),
            ...(runway.gap ? { first_empty: runway.gap } : {}),
            level: runway.level,
          },
        }
      : {}),
  };
}

/** A person, team or manager by name or id. Ambiguity lists the candidates, never a guess. */
export function resolveSubject(ws: Workspace, query: string, kind?: "person" | "team" | "manager") {
  const q = query.trim().toLowerCase();
  const kinds = kind ? [kind] : (["person", "team", "manager"] as const);
  const all = kinds.flatMap((k) =>
    (ws.dir[DIR_KEY[k]] as { id: string; name: string }[]).map((x) => ({ kind: k, id: x.id, name: x.name ?? "" })),
  );
  const byId = all.find((x) => x.id === query.trim());
  if (byId) return byId;
  const exact = all.filter((x) => x.name.trim().toLowerCase() === q);
  const hits = exact.length ? exact : all.filter((x) => x.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || x.name.toLowerCase().includes(q));
  if (hits.length === 1) return hits[0];
  if (!hits.length) {
    throw new ToolError("not_found", `Nobody called "${query}" in the workspace. Use list_people to see who's there.`);
  }
  throw new ToolError("ambiguous", `"${query}" matches more than one: say which (by id).`, {
    candidates: hits.slice(0, 10).map((h) => ({ id: h.id, name: h.name, kind: h.kind })),
  });
}
