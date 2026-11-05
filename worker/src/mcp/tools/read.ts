/**
 * Read-only tools. Everything an assistant needs to understand a leader's
 * meetings before it touches them — and, deliberately, nothing about how the
 * leader rates, prays for or assesses the people in them (see workspace.ts).
 * The one exception is list_people's health and prayer line, shown only to a
 * connection holding `people:read`; the rest of that lives in people.ts.
 */
import { arcPlan } from "../../../../src/lib/arcs.ts";
import { meetingsFor } from "../../../../src/lib/readiness.ts";
import { bool, date, enumOf, int, obj, opt, str } from "../schema.ts";
import { READS, ToolError, tool, type ToolDef } from "../server.ts";
import { hasScope } from "../principal.ts";
import { peopleHealth } from "../records.ts";
import {
  WEEKDAYS,
  agendaView,
  arcSummary,
  followUpView,
  guarded,
  meetingHealth,
  planView,
  readWorkspace,
  resolveMeeting,
  sharedNote,
  slotsOf,
  subjectName,
  titleOf,
  topicView,
  withName,
} from "./views.ts";
import type { Workspace } from "../workspace.ts";
import type { Topic } from "../../../../src/types";

export const TODAY = opt(
  date({ description: "The user's local date today. Pass it whenever you know it; the default is today in UTC." }),
);
export const MEETING = str({
  min: 1,
  max: 100,
  description: "A meeting's id, or a name as you'd say it: 'Meghan', 'Staff meeting'. Ambiguous names are rejected with the candidates.",
});

const ideasOf = (ws: Workspace, meetingId?: string): Topic[] =>
  ws.agenda.topics
    .filter((t) => t.status === "open" && !t.sessionId && (meetingId === undefined || t.meetingId === meetingId))
    .sort((a, b) => a.order - b.order);

export const readTools: ToolDef[] = [
  tool({
    name: "list_meetings",
    title: "List meetings",
    description:
      "Every recurring meeting (1:1s and team meetings) with who it's with, its rhythm, its next occurrence, how ready it is and how many meetings ahead it's planned, and counts of waiting ideas, open follow-ups and live arcs. Start here to find a meeting's id; for dates across all meetings use list_upcoming.",
    scope: "agenda:read",
    annotations: READS,
    input: obj({ today: TODAY }),
    run: async (input, ctx) => {
      const { ws, env } = await readWorkspace(ctx, input.today);
      return {
        today: env.today,
        meetings: ws.agenda.meetings.map((m) => {
          const next = slotsOf(ws, m, env.today, 2).find((s) => !s.past);
          return {
            ...withName(ws, m),
            with: { kind: m.subjectKind, name: subjectName(ws, m) },
            rhythm: m.rhythm,
            ...(m.anchorWeekday !== undefined ? { weekday: WEEKDAYS[m.anchorWeekday] } : {}),
            next: next ? { date: next.date, status: next.projected ? "projected" : "booked", session_id: next.sessionId } : null,
            ideas_waiting: ideasOf(ws, m.id).length,
            open_follow_ups: ws.agenda.followUps.filter((f) => f.meetingId === m.id && f.status === "open").length,
            arcs: ws.arcs.filter((a) => a.meetingId === m.id && a.status !== "done").map((a) => arcSummary(ws, a)),
            ...meetingHealth(ws, m, env.today),
            ...sharedNote(ws, m.id),
          };
        }),
        unassigned_ideas: ideasOf(ws).filter((t) => !t.meetingId).length,
      };
    },
  }),

  tool({
    name: "get_meeting",
    title: "Get a meeting's setup",
    description:
      "One meeting's standing setup: its sections (the standing agenda rows like Check-in or Prayer, each with an id), coverage targets, rhythm and weekday, where its notes live, and its arcs.",
    scope: "agenda:read",
    annotations: READS,
    input: obj({ meeting: MEETING, today: TODAY }),
    run: async (input, ctx) =>
      guarded(async () => {
        const { ws } = await readWorkspace(ctx, input.today);
        const m = resolveMeeting(ws, input.meeting);
        const tag = (id: string) => ws.agenda.tags.find((t) => t.id === id)?.label ?? id;
        return {
          ...withName(ws, m),
          with: meetingSubjectLabel(ws, m),
          rhythm: m.rhythm,
          ...(m.anchorWeekday !== undefined ? { weekday: WEEKDAYS[m.anchorWeekday] } : {}),
          ...(m.floorDays ? { as_needed_floor_days: m.floorDays } : {}),
          ...(m.nextDate ? { booked_next_date: m.nextDate } : {}),
          role: m.role ?? "convene",
          sections: (m.curriculum ?? []).map((c) => ({ id: c.id, label: c.label, ...(c.minutes ? { minutes: c.minutes } : {}), ...(c.tagId ? { tag: tag(c.tagId) } : {}) })),
          ...(m.coverageTargets?.length
            ? { coverage_targets: m.coverageTargets.map((c) => ({ tag: tag(c.tagId), every_n_occurrences: c.everyNOccurrences })) }
            : {}),
          ...(m.trackerUrl ? { notes_live_at: { url: m.trackerUrl, ...(m.trackerName ? { name: m.trackerName } : {}) } } : {}),
          arcs: ws.arcs.filter((a) => a.meetingId === m.id).map((a) => arcSummary(ws, a)),
          ...sharedNote(ws, m.id),
        };
      }),
  }),

  tool({
    name: "get_agenda",
    title: "Get one meeting's agenda",
    description:
      "The running order for one occurrence of a meeting, by section: topics, the arc step due, follow-ups to open with ('since last time'), topics that came back from earlier weeks, prep notes, and what the previous meeting didn't cover. Defaults to the next occurrence.",
    scope: "agenda:read",
    annotations: READS,
    input: obj({ meeting: MEETING, date: opt(date({ description: "An occurrence date. Omit for the next one." })), today: TODAY }),
    run: async (input, ctx) =>
      guarded(async () => {
        const { ws, env } = await readWorkspace(ctx, input.today);
        return agendaView(ws, resolveMeeting(ws, input.meeting), input.date, env.today);
      }),
  }),

  tool({
    name: "get_plan",
    title: "Get the plan-ahead board",
    description:
      "The planning board for a meeting: its upcoming weeks (booked or only projected from the rhythm), what's placed in each by section, the arc step each week carries, the idea tray, parked topics, skipped weeks, and coverage of its targets. Read this before moving things around.",
    scope: "agenda:read",
    annotations: READS,
    input: obj({
      meeting: MEETING,
      weeks: opt(int({ min: 1, max: 26, description: "How many upcoming occurrences to show. Default 6." })),
      today: TODAY,
    }),
    run: async (input, ctx) =>
      guarded(async () => {
        const { ws, env } = await readWorkspace(ctx, input.today);
        return planView(ws, resolveMeeting(ws, input.meeting), env.today, input.weeks ?? 6);
      }),
  }),

  tool({
    name: "list_ideas",
    title: "List ideas not yet on an agenda",
    description:
      "Topics that aren't placed on any occurrence: the inbox (no meeting yet) and each meeting's idea tray, optionally with parked ones. This is the Ideas page.",
    scope: "agenda:read",
    annotations: READS,
    input: obj({
      meeting: opt(MEETING),
      tag: opt(str({ min: 1, max: 40, description: "Only topics with this tag (by label)." })),
      include_parked: opt(bool({ description: "Include parked topics. Default false." })),
      limit: opt(int({ min: 1, max: 200, description: "Default 100." })),
    }),
    run: async (input, ctx) =>
      guarded(async () => {
        const { ws } = await readWorkspace(ctx);
        const meeting = input.meeting ? resolveMeeting(ws, input.meeting) : undefined;
        const tagId = input.tag
          ? ws.agenda.tags.find((t) => t.label.trim().toLowerCase() === input.tag!.trim().toLowerCase())?.id
          : undefined;
        if (input.tag && !tagId) throw new ToolError("tag_not_found", `No tag "${input.tag}".`, { tags: ws.agenda.tags.map((t) => t.label) });
        let list = ideasOf(ws, meeting?.id).filter((t) => input.include_parked || t.lane === "backlog");
        if (tagId) list = list.filter((t) => t.tagIds.includes(tagId));
        const limit = input.limit ?? 100;
        const groups = new Map<string | null, Topic[]>();
        for (const t of list.slice(0, limit)) groups.set(t.meetingId ?? null, [...(groups.get(t.meetingId ?? null) ?? []), t]);
        return {
          total: list.length,
          ...(list.length > limit ? { truncated: true } : {}),
          groups: [...groups.entries()]
            .sort(([a], [b]) => (a === null ? -1 : b === null ? 1 : 0))
            .map(([id, topics]) => ({
              meeting: id ? withName(ws, ws.agenda.meetings.find((m) => m.id === id)!) : null,
              ideas: topics.map((t) => ({ ...topicView(ws, t), ...(t.lane === "parked" ? { parked: true } : {}) })),
            })),
        };
      }),
  }),

  tool({
    name: "list_follow_ups",
    title: "List follow-ups",
    description:
      "Commitments that outlive a single meeting ('send her the article'). Open ones open the next meeting as 'since last time'.",
    scope: "agenda:read",
    annotations: READS,
    input: obj({
      meeting: opt(MEETING),
      status: opt(enumOf(["open", "done", "all"] as const, { description: "Default open." })),
      limit: opt(int({ min: 1, max: 200 })),
    }),
    run: async (input, ctx) =>
      guarded(async () => {
        const { ws } = await readWorkspace(ctx);
        const meeting = input.meeting ? resolveMeeting(ws, input.meeting) : undefined;
        const status = input.status ?? "open";
        const list = ws.agenda.followUps
          .filter((f) => (!meeting || f.meetingId === meeting.id) && (status === "all" || f.status === status))
          .sort((a, b) => a.openedOn.localeCompare(b.openedOn));
        return { total: list.length, follow_ups: list.slice(0, input.limit ?? 100).map((f) => followUpView(ws, f)) };
      }),
  }),

  tool({
    name: "list_sessions",
    title: "List past meetings",
    description:
      "A meeting's history, newest first: the date, its one-line point, what was covered, and what wasn't. Use it to see where you left off. Written-up notes are left out unless you ask for them.",
    scope: "agenda:read",
    annotations: READS,
    input: obj({
      meeting: MEETING,
      limit: opt(int({ min: 1, max: 30, description: "Default 8." })),
      include_notes: opt(bool({ description: "Include the written notes of each meeting. They can be private reflections; ask for them only when you need them." })),
      today: TODAY,
    }),
    run: async (input, ctx) =>
      guarded(async () => {
        const { ws, env } = await readWorkspace(ctx, input.today);
        const m = resolveMeeting(ws, input.meeting);
        const past = ws.agenda.sessions
          .filter((s) => s.meetingId === m.id && s.kind !== "skipped" && s.date < env.today)
          .sort((a, b) => b.date.localeCompare(a.date))
          .slice(0, input.limit ?? 8);
        return {
          meeting: withName(ws, m),
          sessions: past.map((s) => ({
            date: s.date,
            session_id: s.id,
            ...(s.point ? { point: s.point } : {}),
            covered: ws.agenda.topics.filter((t) => t.sessionId === s.id && t.status === "covered").map((t) => t.text),
            ...(s.uncovered?.length ? { not_covered: s.uncovered } : {}),
            ...(input.include_notes && s.notes ? { notes: s.notes } : {}),
            ...(s.kind === "extra" ? { one_off: true } : {}),
          })),
        };
      }),
  }),

  tool({
    name: "list_people",
    title: "List people and teams",
    description:
      "Who the leader leads and answers to, by name and role, and which meetings each is in. Use it to map a name to a meeting id. With the people records allowed, each also shows the leader's health read and whether they're carried in prayer; get_person has the rest.",
    scope: "agenda:read",
    annotations: READS,
    input: obj({ query: opt(str({ min: 1, max: 60, description: "Filter by name." })) }),
    run: async (input, ctx) => {
      const { ws } = await readWorkspace(ctx);
      // Only a connection granted the people records sees how they're doing.
      const extra = hasScope(ctx.principal, "people:read") ? await peopleHealth(ctx) : new Map<string, Record<string, unknown>>();
      const q = input.query?.trim().toLowerCase();
      const match = (name: string) => !q || name.toLowerCase().includes(q);
      const meetingList = (kind: "person" | "team" | "manager", id: string) =>
        meetingsFor(ws.agenda.meetings, kind, id).map((m) => withName(ws, m));
      return {
        people: ws.dir.people.filter((p) => match(p.name)).map((p) => ({
          id: p.id,
          name: p.name,
          ...(p.role ? { role: p.role } : {}),
          ...(p.teamId ? { team: ws.dir.teams.find((t) => t.id === p.teamId)?.name } : {}),
          ...extra.get(p.id),
          meetings: meetingList("person", p.id),
        })),
        teams: ws.dir.teams.filter((t) => match(t.name)).map((t) => ({ id: t.id, name: t.name, ...extra.get(t.id), meetings: meetingList("team", t.id) })),
        managers: ws.dir.managers.filter((x) => match(x.name)).map((x) => ({
          id: x.id,
          name: x.name,
          ...(x.role ? { role: x.role } : {}),
          ...extra.get(x.id),
          meetings: meetingList("manager", x.id),
        })),
      };
    },
  }),

  tool({
    name: "list_tags",
    title: "List tags",
    description: "The workspace's topic tags. Tags are shared across all meetings; sections of a meeting usually carry one.",
    scope: "agenda:read",
    annotations: READS,
    input: obj({}),
    run: async (_input, ctx) => {
      const { ws } = await readWorkspace(ctx);
      return {
        tags: ws.agenda.tags.map((t) => ({
          id: t.id,
          label: t.label,
          topics: ws.agenda.topics.filter((x) => x.status === "open" && x.tagIds.includes(t.id)).length,
        })),
      };
    },
  }),

  // `search` and `fetch` are the pair ChatGPT's connector mode looks for by name.
  tool({
    name: "search",
    title: "Search Polarch",
    description:
      "Search topics, follow-ups, meetings, arcs and people by words. Returns ids to pass to `fetch`. For structured browsing prefer list_meetings, get_plan or list_ideas.",
    scope: "agenda:read",
    annotations: READS,
    input: obj({ query: str({ min: 1, max: 200 }) }),
    run: async (input, ctx) => {
      const { ws } = await readWorkspace(ctx);
      const words = input.query.toLowerCase().split(/\s+/).filter(Boolean);
      const hits: { id: string; title: string; url: string; text: string; score: number }[] = [];
      const consider = (id: string, title: string, body: string, url: string, boost = 0) => {
        const hay = `${title} ${body}`.toLowerCase();
        if (!words.every((w) => hay.includes(w))) return;
        hits.push({ id, title, url, text: body.slice(0, 200), score: boost + words.filter((w) => title.toLowerCase().includes(w)).length });
      };
      for (const m of ws.agenda.meetings) consider(`meeting:${m.id}`, titleOf(ws, m), `A ${m.rhythm} meeting`, `${ctx.baseUrl}/meeting/${m.id}`, 2);
      for (const t of ws.agenda.topics) {
        const m = ws.agenda.meetings.find((x) => x.id === t.meetingId);
        consider(`topic:${t.id}`, t.text, `${t.detail ?? ""} ${t.status}`, m ? `${ctx.baseUrl}/meeting/${m.id}` : ctx.baseUrl);
      }
      for (const f of ws.agenda.followUps) consider(`followup:${f.id}`, f.text, `Follow-up (${f.status})`, ctx.baseUrl);
      for (const a of ws.arcs) {
        consider(`arc:${a.id}`, a.title, `${a.author ?? ""} ${a.steps.map((s) => s.label).join(" ")}`, `${ctx.baseUrl}/meeting/${a.meetingId}`, 1);
      }
      for (const p of ws.dir.people) consider(`person:${p.id}`, p.name, p.role ?? "", ctx.baseUrl);
      hits.sort((a, b) => b.score - a.score);
      return { results: hits.slice(0, 20).map(({ id, title, url, text }) => ({ id, title, url, text })) };
    },
  }),

  tool({
    name: "fetch",
    title: "Fetch a Polarch item",
    description: "Full detail for an id returned by `search` (topic:, followup:, meeting:, arc:, person:).",
    scope: "agenda:read",
    annotations: READS,
    input: obj({ id: str({ min: 3, max: 80 }) }),
    run: async (input, ctx) =>
      guarded(async () => {
        const { ws, env } = await readWorkspace(ctx);
        const [kind, id] = [input.id.slice(0, input.id.indexOf(":")), input.id.slice(input.id.indexOf(":") + 1)];
        const found = (title: string, body: unknown, url = ctx.baseUrl) => ({
          id: input.id,
          title,
          text: JSON.stringify(body),
          url,
          metadata: { type: kind },
        });
        if (kind === "meeting") {
          const m = ws.agenda.meetings.find((x) => x.id === id);
          if (m) return found(titleOf(ws, m), agendaView(ws, m, undefined, env.today), `${ctx.baseUrl}/meeting/${m.id}`);
        } else if (kind === "topic") {
          const t = ws.agenda.topics.find((x) => x.id === id);
          if (t) return found(t.text, topicView(ws, t, { meeting: true }));
        } else if (kind === "followup") {
          const f = ws.agenda.followUps.find((x) => x.id === id);
          if (f) return found(f.text, followUpView(ws, f));
        } else if (kind === "arc") {
          const a = ws.arcs.find((x) => x.id === id);
          if (a) return found(a.title, arcDetail(ws, a, env.today));
        } else if (kind === "person") {
          const p = ws.dir.people.find((x) => x.id === id);
          if (p) return found(p.name, { name: p.name, role: p.role ?? null });
        }
        throw new ToolError("not_found", `Nothing found for "${input.id}".`);
      }),
  }),
];

function meetingSubjectLabel(ws: Workspace, m: { subjectKind: "person" | "team" | "manager"; subjectId: string }) {
  return { kind: m.subjectKind, name: subjectName(ws, m) };
}

/** An arc with every step and, for live ones, which upcoming meeting carries which. */
export function arcDetail(ws: Workspace, arc: Workspace["arcs"][number], today: string) {
  const meeting = ws.agenda.meetings.find((m) => m.id === arc.meetingId);
  const slots = meeting ? slotsOf(ws, meeting, today, 12) : [];
  const plan = meeting && arc.status === "active" ? arcPlan(arc, slots) : new Map();
  const dateOf = new Map<string, string>();
  for (const [d, list] of plan) for (const p of list) if (p.state === "now" || p.state === "later") dateOf.set(p.step.id, d);
  const sessionDate = (id: string) => ws.agenda.sessions.find((s) => s.id === id)?.date;
  const takeaways = ws.takeaways.filter((t) => t.arcId === arc.id);
  return {
    ...arcSummary(ws, arc),
    ...(arc.slotId ? { section: meeting?.curriculum?.find((c) => c.id === arc.slotId)?.label } : {}),
    steps: arc.steps.map((s, i) => ({
      id: s.id,
      n: i + 1,
      label: s.label,
      status: s.status,
      ...(s.read ? { read: s.read } : {}),
      ...(s.prompts.length ? { talk: s.prompts } : {}),
      ...(s.practice ? { try: s.practice } : {}),
      ...(s.coveredIn.length ? { talked_about_on: s.coveredIn.map(sessionDate).filter(Boolean) } : {}),
      ...(s.doneOn ? { done_on: s.doneOn } : {}),
      ...(dateOf.has(s.id) ? { lands_on: dateOf.get(s.id) } : {}),
      ...(takeaways.find((t) => t.stepId === s.id) ? { takeaway: takeaways.find((t) => t.stepId === s.id)!.text } : {}),
    })),
  };
}

