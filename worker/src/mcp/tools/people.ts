/**
 * The rest of the workspace: the people the leader leads and answers to, and
 * everything kept about them — health, prayer, assessments, notes, wins,
 * goals, the prayer log, what's known, fixtures, past write-ups, transcripts.
 *
 * Every tool here needs a `people:*` scope, which no connection gets unless the
 * leader ticked it on the consent page or made a personal token with it. A
 * connection without it is never even shown these tools.
 */
import { RecordBatch, present, readOne, readRows, type RecordTable } from "../records.ts";
import { arr, bool, date, enumOf, int, nullable, obj, opt, str } from "../schema.ts";
import { DELETES, READS, ToolError, WRITES, tool, type ToolDef } from "../server.ts";
import type { Row } from "../../store.ts";
import type { Workspace } from "../workspace.ts";
import { MEETING, TODAY } from "./read.ts";
import { done } from "./topics.ts";
import { followUpView, guarded, opEnv, readWorkspace, resolveMeeting, resolveSubject, withName } from "./views.ts";
import { meetingsFor } from "../../../../src/lib/readiness.ts";

type Kind = "person" | "team" | "manager";

const KIND = opt(enumOf(["person", "team", "manager"] as const, { description: "Narrow `who` when a name is shared." }));
const WHO = str({
  min: 1,
  max: 100,
  description: "A person, team or manager (someone the leader reports to), by name or id. 'me' is the leader's own profile where noted.",
});

const PROFILE_TABLE: Record<Kind, RecordTable> = { person: "people", team: "teams", manager: "managers" };

function subjectOf(ws: Workspace, who: string, kind?: Kind) {
  return resolveSubject(ws, who, kind);
}

/** Notes, goals and actions are per-person tables and per-team tables. */
function tablesFor(kind: Kind) {
  return kind === "team"
    ? { notes: "team_notes" as const, goals: "team_goals" as const, key: "team_id" }
    : { notes: "notes" as const, goals: "goals" as const, key: "person_id" };
}

const HEALTH = obj({
  level: enumOf(["thriving", "solid", "watch", "strained", "critical"] as const),
  note: opt(str({ max: 300, description: "The one line of evidence behind the call." })),
});

export const peopleTools: ToolDef[] = [
  tool({
    name: "get_person",
    title: "Get everything about a person or team",
    description:
      "The full record for a person, team or manager: their profile (role, health rating, whether the leader is carrying them in prayer, assessments — CliftonStrengths, Enneagram, MBTI, strengths, watch-outs, how to lead them, leading-up notes), recent notes, wins, goals, the prayer log, what's known (decisions, themes, facts), fixtures, their meetings and open follow-ups. Pass who:'me' for the leader's own profile.",
    scope: "people:read",
    annotations: READS,
    input: obj({ who: WHO, kind: KIND, notes_limit: opt(int({ min: 0, max: 50, description: "How many recent notes. Default 10." })) }),
    run: async (input, ctx) =>
      guarded(async () => {
        const { sql } = ctx;
        const uid = ctx.principal.userId;
        if (input.who.trim().toLowerCase() === "me") {
          const rows = (await sql.unsafe(
            `SELECT name, title, clifton_top5, enneagram, mbti, strengths, watch_outs, how_to_lead, custom_modalities FROM "profiles" WHERE user_id = $1`,
            [uid],
          )) as unknown as Row[];
          return { me: rows[0] ? present(rows[0]) : null };
        }
        const { ws } = await readWorkspace(ctx);
        const s = subjectOf(ws, input.who, input.kind);
        const t = tablesFor(s.kind);
        const subject = { subject_kind: s.kind, subject_id: s.id };
        const [profile, notes, goals, prayers, knowledge, fixtures, wins, actions, members] = await Promise.all([
          readOne(sql, uid, PROFILE_TABLE[s.kind], s.id),
          readRows(sql, uid, t.notes, { [t.key]: s.id }, { orderBy: "date", limit: input.notes_limit ?? 10 }),
          readRows(sql, uid, t.goals, { [t.key]: s.id }),
          readRows(sql, uid, "prayers", subject, { orderBy: "date" }),
          readRows(sql, uid, "knowledge", subject, { orderBy: "noted_on" }),
          readRows(sql, uid, "fixtures", subject),
          s.kind === "team" ? Promise.resolve([]) : readRows(sql, uid, "wins", { person_id: s.id }, { orderBy: "date" }),
          s.kind === "team" ? readRows(sql, uid, "team_actions", { team_id: s.id }) : Promise.resolve([]),
          s.kind === "team" ? readRows(sql, uid, "people", { team_id: s.id }, { columns: ["id", "name", "role", "health"] }) : Promise.resolve([]),
        ]);
        const meetings = meetingsFor(ws.agenda.meetings, s.kind, s.id);
        const ids = new Set(meetings.map((m) => m.id));
        return {
          kind: s.kind,
          ...(profile ? present(profile) : { id: s.id, name: s.name }),
          ...(members.length ? { members: members.map(present) } : {}),
          meetings: meetings.map((m) => withName(ws, m)),
          open_follow_ups: ws.agenda.followUps.filter((f) => f.status === "open" && f.meetingId && ids.has(f.meetingId)).map((f) => followUpView(ws, f)),
          notes: notes.map(present),
          ...(wins.length ? { wins: wins.map(present) } : {}),
          ...(goals.length ? { goals: goals.map(present) } : {}),
          ...(actions.length ? { actions: actions.map(present) } : {}),
          ...(prayers.length ? { prayer_log: prayers.map(present) } : {}),
          ...(knowledge.length ? { known: knowledge.map(present) } : {}),
          ...(fixtures.length ? { fixtures: fixtures.map(present) } : {}),
        };
      }),
  }),

  tool({
    name: "get_session",
    title: "Get a meeting's write-up",
    description:
      "Everything written about one occurrence of a meeting: its point, the leader's notes (prep or write-up), what was covered and not, each chair's shared notes, what was learned from it, and — if you ask — the full transcript. Defaults to the most recent past occurrence.",
    scope: "people:read",
    annotations: READS,
    input: obj({
      meeting: MEETING,
      date: opt(date({ description: "The occurrence date. Default: the latest one that has happened." })),
      include_transcript: opt(bool({ description: "Include the recorded transcript. Can be long." })),
      today: TODAY,
    }),
    run: async (input, ctx) =>
      guarded(async () => {
        const { ws, env } = await readWorkspace(ctx, input.today);
        const m = resolveMeeting(ws, input.meeting);
        const mine = ws.agenda.sessions.filter((s) => s.meetingId === m.id && s.kind !== "skipped");
        const session = input.date
          ? mine.find((s) => s.date === input.date)
          : mine.filter((s) => s.date <= env.today).sort((a, b) => b.date.localeCompare(a.date))[0];
        if (!session) {
          throw new ToolError("no_such_occurrence", input.date ? `Nothing was booked or held on ${input.date}.` : "This meeting hasn't met yet.", {
            dates: mine.map((s) => s.date).sort().slice(-12),
          });
        }
        const uid = ctx.principal.userId;
        const [transcript, shared, learned] = await Promise.all([
          input.include_transcript
            ? readRows(ctx.sql, uid, "one_on_ones", { id: session.id }, { columns: ["transcript"] })
            : Promise.resolve([] as Row[]),
          readRows(ctx.sql, uid, "shared_notes", { session_id: session.id }),
          readRows(ctx.sql, uid, "knowledge", { session_id: session.id }),
        ]);
        const here = ws.agenda.topics.filter((t) => t.sessionId === session.id);
        return {
          meeting: withName(ws, m),
          date: session.date,
          session_id: session.id,
          ...(session.point ? { point: session.point } : {}),
          ...(session.notes ? { notes: session.notes } : {}),
          covered: here.filter((t) => t.status === "covered").map((t) => t.text),
          ...(here.some((t) => t.status === "open") ? { still_open: here.filter((t) => t.status === "open").map((t) => t.text) } : {}),
          ...(session.uncovered?.length ? { not_covered: session.uncovered } : {}),
          ...(shared.length ? { shared_notes: shared.map((r) => ({ by: r.by_member === "owner" ? "the leader" : "the other chair", body: r.body })) } : {}),
          ...(learned.length ? { learned: learned.map(present) } : {}),
          ...(typeof transcript[0]?.transcript === "string" && transcript[0].transcript ? { transcript: transcript[0].transcript } : {}),
        };
      }),
  }),

  tool({
    name: "list_prayers",
    title: "List prayer",
    description:
      "Who the leader is carrying in prayer (since when, the focus, when last prayed) and the prayer log: burdens and scriptures written down for each, answered or not.",
    scope: "people:read",
    annotations: READS,
    input: obj({ include_answered: opt(bool({ description: "Include answered requests. Default false." })) }),
    run: async (input, ctx) => {
      const uid = ctx.principal.userId;
      const [people, teams, managers, log] = await Promise.all([
        readRows(ctx.sql, uid, "people", {}, { columns: ["id", "name", "prayer"] }),
        readRows(ctx.sql, uid, "teams", {}, { columns: ["id", "name", "prayer"] }),
        readRows(ctx.sql, uid, "managers", {}, { columns: ["id", "name", "prayer"] }),
        readRows(ctx.sql, uid, "prayers", {}, { orderBy: "date" }),
      ]);
      const names = new Map<string, string>();
      const carrying: Row[] = [];
      for (const [kind, rows] of [["person", people], ["team", teams], ["manager", managers]] as const) {
        for (const r of rows) {
          names.set(`${kind}:${r.id}`, String(r.name ?? ""));
          const p = present(r);
          if (p.prayer) carrying.push({ kind, id: r.id, name: r.name, ...(p.prayer as Row) });
        }
      }
      return {
        carrying,
        log: log
          .filter((e) => input.include_answered || !e.answered_on)
          .map((e) => ({ ...present(e), for: names.get(`${e.subject_kind}:${e.subject_id}`) ?? null })),
      };
    },
  }),

  tool({
    name: "list_glossary",
    title: "List the transcription glossary",
    description: "Words the transcriber has been taught: names and terms it should spell right, and what it used to mishear them as.",
    scope: "people:read",
    annotations: READS,
    input: obj({}),
    run: async (_input, ctx) => ({ terms: (await readRows(ctx.sql, ctx.principal.userId, "glossary")).map(present) }),
  }),

  tool({
    name: "create_person",
    title: "Add a person, team or manager",
    description:
      "Add someone to the workspace: a person the leader leads (optionally on a team), a team, or a manager the leader reports to. Then create_meeting to start meeting with them.",
    scope: "people:write",
    annotations: WRITES,
    input: obj({
      kind: enumOf(["person", "team", "manager"] as const),
      name: str({ min: 1, max: 80 }),
      role: opt(str({ max: 80, description: "Person or manager." })),
      team: opt(str({ min: 1, max: 100, description: "For a person: the team they sit on, by name or id." })),
      email: opt(str({ max: 200, description: "For a person: where a shared meeting's link goes." })),
      description: opt(str({ max: 2000, description: "For a team." })),
    }),
    run: async (input, ctx) =>
      guarded(async () => {
        const { ws } = await readWorkspace(ctx);
        const batch = new RecordBatch(ctx);
        let id: string;
        if (input.kind === "team") {
          const caps = await readRows(ctx.sql, ctx.principal.userId, "teams", {}, { columns: ["capacity_id", "sort_order"] });
          const capacity = (caps.find((c) => c.capacity_id)?.capacity_id as string | undefined) ?? "default";
          id = batch.insert("teams", { name: input.name.trim(), capacity_id: capacity, description: input.description ?? null, sort_order: caps.length });
        } else if (input.kind === "manager") {
          id = batch.insert("managers", { name: input.name.trim(), role: input.role ?? null });
        } else {
          const team = input.team ? resolveSubject(ws, input.team, "team") : undefined;
          id = batch.insert("people", {
            name: input.name.trim(),
            role: input.role ?? null,
            team_id: team?.id ?? null,
            email: input.email ?? null,
            clifton_top5: [],
            strengths: [],
            watch_outs: [],
            custom_modalities: [],
          });
        }
        const saved = await batch.commit("create_person", `Added ${input.kind === "person" ? "" : `the ${input.kind} `}${input.name.trim()}`);
        return done(saved, `Added ${input.name.trim()}`, { id, kind: input.kind });
      }),
  }),

  tool({
    name: "update_person",
    title: "Update a person's or team's profile",
    description:
      "Change a person's, team's or manager's profile: name, role, team, email; the leader's health read; prayer (start or stop carrying them, set the focus, mark prayed today); assessments (clifton_top5 in order, enneagram, mbti), strengths, watch-outs, how to lead them, leading-up notes; a team's description, purpose and cadence. Only the fields you pass change; null clears.",
    scope: "people:write",
    annotations: WRITES,
    input: obj({
      who: WHO,
      kind: KIND,
      name: opt(str({ min: 1, max: 80 })),
      role: opt(nullable(str({ max: 80 }))),
      team: opt(nullable(str({ min: 1, max: 100, description: "A person's team, by name or id." }))),
      email: opt(nullable(str({ max: 200 }))),
      relationship_type: opt(nullable(str({ max: 60 }))),
      no_meeting: opt(bool({ description: "true: the leader deliberately doesn't meet with them." })),
      health: opt(nullable(HEALTH)),
      carrying_in_prayer: opt(bool({ description: "Start (true) or stop (false) carrying them in prayer." })),
      prayer_focus: opt(nullable(str({ max: 300, description: "The burden in a sentence. Setting it starts carrying them." }))),
      prayed_today: opt(bool({ description: "Mark that the leader prayed for them today." })),
      clifton_top5: opt(arr(str({ min: 1, max: 40 }), { max: 5 })),
      enneagram: opt(nullable(str({ max: 10 }))),
      mbti: opt(nullable(str({ max: 10 }))),
      strengths: opt(arr(str({ min: 1, max: 200 }), { max: 20 })),
      watch_outs: opt(arr(str({ min: 1, max: 200 }), { max: 20 })),
      how_to_lead: opt(nullable(str({ max: 4000 }))),
      lead_up: opt(
        nullable(
          obj({
            archetype: opt(str({ max: 300 })),
            wins_like: opt(str({ max: 1000 })),
            anxieties: opt(str({ max: 1000 })),
            currency: opt(str({ max: 1000 })),
            comms: opt(str({ max: 1000 })),
            their_scorecard: opt(str({ max: 1000 })),
          }, { description: "For someone the leader reports to: how to succeed with them." }),
        ),
      ),
      description: opt(nullable(str({ max: 2000 }))),
      purpose: opt(nullable(str({ max: 2000 }))),
      cadence: opt(nullable(str({ max: 60 }))),
      today: TODAY,
    }),
    run: async (input, ctx) =>
      guarded(async () => {
        const { ws } = await readWorkspace(ctx, input.today);
        const env = opEnv(input.today);
        const s = subjectOf(ws, input.who, input.kind);
        const table = PROFILE_TABLE[s.kind];
        const allowed: Record<Kind, string[]> = {
          person: ["name", "role", "team", "email", "relationship_type", "no_meeting", "health", "clifton_top5", "enneagram", "mbti", "strengths", "watch_outs", "how_to_lead", "lead_up"],
          team: ["name", "no_meeting", "health", "description", "purpose", "cadence"],
          manager: ["name", "role", "no_meeting", "lead_up"],
        };
        const given = Object.entries(input).filter(([k, v]) => v !== undefined && !["who", "kind", "today", "carrying_in_prayer", "prayer_focus", "prayed_today"].includes(k)).map(([k]) => k);
        const wrong = given.filter((k) => !allowed[s.kind].includes(k));
        if (wrong.length) throw new ToolError("invalid_arguments", `A ${s.kind} has no ${wrong.join(", ")}.`, { fields: allowed[s.kind] });

        const current = await readOne(ctx.sql, ctx.principal.userId, table, s.id);
        if (!current) throw new ToolError("not_found", `No ${s.kind} with id "${s.id}".`);
        const parse = (v: unknown) => (typeof v === "string" ? (() => { try { return JSON.parse(v); } catch { return null; } })() : v);
        const patch: Row = {};
        if (input.name !== undefined) patch.name = input.name.trim();
        if (input.role !== undefined) patch.role = input.role?.trim() || null;
        if (input.team !== undefined) patch.team_id = input.team === null ? null : resolveSubject(ws, input.team, "team").id;
        if (input.email !== undefined) patch.email = input.email?.trim() || null;
        if (input.relationship_type !== undefined) patch.relationship_type = input.relationship_type?.trim() || null;
        if (input.no_meeting !== undefined) patch.no_meeting = input.no_meeting || null;
        if (input.health !== undefined) {
          patch.health = input.health === null ? null : { level: input.health.level, ...(input.health.note ? { note: input.health.note } : {}), ratedOn: env.today };
        }
        if (input.clifton_top5 !== undefined) patch.clifton_top5 = input.clifton_top5;
        if (input.enneagram !== undefined) patch.enneagram = input.enneagram?.trim() || null;
        if (input.mbti !== undefined) patch.mbti = input.mbti?.trim().toUpperCase() || null;
        if (input.strengths !== undefined) patch.strengths = input.strengths;
        if (input.watch_outs !== undefined) patch.watch_outs = input.watch_outs;
        if (input.how_to_lead !== undefined) patch.how_to_lead = input.how_to_lead?.trim() || null;
        if (input.lead_up !== undefined) {
          const l = input.lead_up;
          patch.lead_up = l === null ? null : {
            ...((parse(current.lead_up) as Row | null) ?? {}),
            ...(l.archetype !== undefined ? { archetype: l.archetype } : {}),
            ...(l.wins_like !== undefined ? { winsLike: l.wins_like } : {}),
            ...(l.anxieties !== undefined ? { anxieties: l.anxieties } : {}),
            ...(l.currency !== undefined ? { currency: l.currency } : {}),
            ...(l.comms !== undefined ? { comms: l.comms } : {}),
            ...(l.their_scorecard !== undefined ? { theirScorecard: l.their_scorecard } : {}),
          };
        }
        if (input.description !== undefined) patch.description = input.description?.trim() || null;
        if (input.purpose !== undefined) patch.purpose = input.purpose?.trim() || null;
        if (input.cadence !== undefined) patch.cadence = input.cadence?.trim() || null;

        // Prayer mirrors the app: writing a focus or marking a prayer takes them up;
        // taking them up again never resets "since".
        if (input.carrying_in_prayer !== undefined || input.prayer_focus !== undefined || input.prayed_today) {
          let prayer = (parse(current.prayer) as Row | null) ?? null;
          if (input.carrying_in_prayer === false) prayer = null;
          else {
            if (input.carrying_in_prayer || input.prayer_focus !== undefined || input.prayed_today) prayer = prayer ?? { since: env.today };
            if (prayer && input.prayer_focus !== undefined) {
              const { focus: _drop, ...rest } = prayer;
              prayer = input.prayer_focus?.trim() ? { ...rest, focus: input.prayer_focus.trim() } : rest;
            }
            if (prayer && input.prayed_today && prayer.lastPrayedOn !== env.today) {
              prayer = { ...prayer, lastPrayedOn: env.today, times: Number(prayer.times ?? 0) + 1 };
            }
          }
          patch.prayer = prayer;
        }
        if (!Object.keys(patch).length) throw new ToolError("invalid_arguments", "Pass at least one field to change.");
        const batch = new RecordBatch(ctx);
        const after = await batch.update(table, s.id, patch);
        const saved = await batch.commit("update_person", `Updated ${s.name}`);
        return done(saved, `Updated ${s.name}`, { [s.kind]: present(after) });
      }),
  }),

  tool({
    name: "add_note",
    title: "Write a note about someone",
    description: "Add a dated note to a person's, manager's or team's Notes — the leader's own running record, not a meeting's write-up (for that, update_occurrence).",
    scope: "people:write",
    annotations: WRITES,
    input: obj({ who: WHO, kind: KIND, body: str({ min: 1, max: 10000 }), date: opt(date()), today: TODAY }),
    run: async (input, ctx) =>
      guarded(async () => {
        const { ws, env } = await readWorkspace(ctx, input.today);
        const s = subjectOf(ws, input.who, input.kind);
        const t = tablesFor(s.kind);
        const batch = new RecordBatch(ctx);
        const id = batch.insert(t.notes, { [t.key]: s.id, date: input.date ?? env.today, body: input.body.trim() });
        return done(await batch.commit("add_note", `Added a note about ${s.name}`), `Added a note about ${s.name}`, { id });
      }),
  }),

  tool({
    name: "save_record",
    title: "Add or edit a record about someone",
    description:
      "Add (no `id`) or edit (with `id`) one record about a person, team or manager. `type`: win (text, impact — banked with someone the leader reports to), goal (title, progress 0–100, target_date), action (a team to-do: text, done, due_date), prayer (text, prayer_kind burden|scripture; answered:true with answer_note marks it answered, answered:false reopens), known (what's known: text, known_kind decision|theme|fact, pinned), fixture (something a team does over and over: title, owner, cadence, notes, touched:true marks it talked about today), glossary (meant, heard — a term the transcriber should get right; no `who`). Ids come from get_person or list_glossary.",
    scope: "people:write",
    annotations: WRITES,
    input: obj({
      type: enumOf(["win", "goal", "action", "prayer", "known", "fixture", "glossary"] as const),
      id: opt(str({ min: 1, max: 40, description: "Edit this record instead of adding one." })),
      who: opt(WHO),
      kind: KIND,
      text: opt(str({ min: 1, max: 4000 })),
      title: opt(str({ min: 1, max: 200 })),
      impact: opt(nullable(str({ max: 1000 }))),
      progress: opt(int({ min: 0, max: 100 })),
      target_date: opt(nullable(date())),
      done: opt(bool()),
      due_date: opt(nullable(date())),
      prayer_kind: opt(enumOf(["burden", "scripture"] as const)),
      answered: opt(bool()),
      answer_note: opt(nullable(str({ max: 2000 }))),
      known_kind: opt(enumOf(["decision", "theme", "fact"] as const)),
      pinned: opt(bool()),
      owner: opt(nullable(str({ max: 80 }))),
      cadence: opt(enumOf(["weekly", "monthly", "quarterly", "yearly", "as_needed"] as const)),
      notes: opt(nullable(str({ max: 4000 }))),
      touched: opt(bool()),
      meant: opt(str({ min: 1, max: 100 })),
      heard: opt(nullable(str({ max: 100 }))),
      date: opt(date({ description: "When it happened. Default today." })),
      today: TODAY,
    }),
    run: async (input, ctx) =>
      guarded(async () => {
        const { ws, env } = await readWorkspace(ctx, input.today);
        const batch = new RecordBatch(ctx);
        const editing = input.id !== undefined;
        const s = input.who ? subjectOf(ws, input.who, input.kind) : undefined;
        if (!editing && input.type !== "glossary" && !s) throw new ToolError("invalid_arguments", "Say who it's about with `who`.");
        const need = (v: unknown, field: string) => {
          if (!editing && (v === undefined || v === null)) throw new ToolError("invalid_arguments", `A new ${input.type} needs \`${field}\`.`);
        };
        const subject = s ? { subject_kind: s.kind, subject_id: s.id } : {};
        let table: RecordTable;
        let row: Row;
        switch (input.type) {
          case "win":
            if (s?.kind === "team") throw new ToolError("invalid_arguments", "Wins are banked with a person or manager, not a team.");
            need(input.text, "text");
            table = "wins";
            row = { ...(s ? { person_id: s.id } : {}), text: input.text, impact: input.impact, date: input.date ?? (editing ? undefined : env.today) };
            break;
          case "goal": {
            need(input.title, "title");
            const team = s ? s.kind === "team" : (await readOne(ctx.sql, ctx.principal.userId, "team_goals", input.id!)) !== null;
            table = team ? "team_goals" : "goals";
            row = { ...(s ? { [team ? "team_id" : "person_id"]: s.id } : {}), title: input.title, progress: input.progress ?? (editing ? undefined : 0), target_date: input.target_date };
            break;
          }
          case "action":
            if (s && s.kind !== "team") throw new ToolError("invalid_arguments", "Actions are a team's to-dos. For a person, add a follow-up or a topic.");
            need(input.text, "text");
            table = "team_actions";
            row = { ...(s ? { team_id: s.id } : {}), text: input.text, done: input.done ?? (editing ? undefined : false), due_date: input.due_date };
            break;
          case "prayer":
            need(input.text, "text");
            table = "prayers";
            row = {
              ...subject,
              text: input.text,
              kind: input.prayer_kind ?? (editing ? undefined : "burden"),
              date: input.date ?? (editing ? undefined : env.today),
              ...(input.answered === true ? { answered_on: env.today, answer_note: input.answer_note ?? undefined } : {}),
              ...(input.answered === false ? { answered_on: null, answer_note: null } : {}),
              ...(input.answered === undefined && input.answer_note !== undefined ? { answer_note: input.answer_note } : {}),
            };
            break;
          case "known":
            need(input.text, "text");
            table = "knowledge";
            row = { ...subject, text: input.text, kind: input.known_kind ?? (editing ? undefined : "fact"), pinned: input.pinned, noted_on: editing ? undefined : (input.date ?? env.today) };
            break;
          case "fixture":
            need(input.title, "title");
            table = "fixtures";
            row = {
              ...subject,
              title: input.title,
              owner: input.owner,
              cadence: input.cadence ?? (editing ? undefined : "monthly"),
              notes: input.notes,
              ...(input.touched ? { last_touched_on: env.today } : {}),
              ...(editing ? {} : { created_on: env.today, sort_order: 0 }),
            };
            break;
          case "glossary":
            need(input.meant, "meant");
            table = "glossary";
            row = { meant: input.meant, heard: input.heard, ...(editing ? {} : { created_on: env.today }) };
            break;
        }
        const clean = Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined));
        const what = `${input.type}${s ? ` for ${s.name}` : ""}`;
        if (editing) {
          const after = await batch.update(table, input.id!, clean);
          return done(await batch.commit("save_record", `Edited a ${what}`), `Edited a ${what}`, { record: present(after) });
        }
        // A prayer request starts carrying them, as writing one down does in the app.
        if (input.type === "prayer" && s) {
          const prof = await readOne(ctx.sql, ctx.principal.userId, PROFILE_TABLE[s.kind], s.id);
          if (prof && !prof.prayer) await batch.update(PROFILE_TABLE[s.kind], s.id, { prayer: { since: env.today } });
        }
        const id = batch.insert(table, clean);
        return done(await batch.commit("save_record", `Added a ${what}`), `Added a ${what}`, { id });
      }),
  }),

  tool({
    name: "delete_record",
    title: "Delete a record about someone",
    description: "Delete one note, win, goal, team action, prayer entry, known item, fixture or glossary term by id. Undoable with undo_change. (People, teams and meetings themselves can't be deleted from here.)",
    scope: "people:write",
    annotations: DELETES,
    input: obj({
      type: enumOf(["note", "team_note", "win", "goal", "team_goal", "action", "prayer", "known", "fixture", "glossary"] as const),
      id: str({ min: 1, max: 40 }),
    }),
    run: async (input, ctx) =>
      guarded(async () => {
        const table: RecordTable = (
          {
            note: "notes",
            team_note: "team_notes",
            win: "wins",
            goal: "goals",
            team_goal: "team_goals",
            action: "team_actions",
            prayer: "prayers",
            known: "knowledge",
            fixture: "fixtures",
            glossary: "glossary",
          } as const
        )[input.type];
        const batch = new RecordBatch(ctx);
        const was = await batch.remove(table, input.id);
        const label = String(was.text ?? was.title ?? was.body ?? was.meant ?? "").slice(0, 60);
        return done(await batch.commit("delete_record", `Deleted a ${input.type}: "${label}"`), `Deleted a ${input.type}`, { deleted: present(was) });
      }),
  }),
];
