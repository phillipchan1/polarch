/**
 * Normalized Worker persistence for Polarch.
 *
 * The zustand store keeps working entirely in memory with optimistic updates —
 * exactly as it did against localStorage. This module is the seam that turns
 * that in-memory `PersistedData` into rows across the normalized tables (and
 * back). It exposes three things the store needs:
 *
 *   loadAll(userId)      → read every table into a PersistedData (or null for a
 *                          brand-new user who has no profile row yet)
 *   writeAll(userId,d)   → insert a full PersistedData (seeding / first import)
 *   syncData(userId,d)   → persist only the collections that changed since the
 *                          last baseline (called, debounced, on every store
 *                          change)
 *
 * Each collection has a small mapper pair (row ⇄ app type). Sync writes only
 * the rows this device changed and deletes only the rows it removed — see
 * `diffRows`. Whole-table replacement is reserved for seeding (`writeAll`).
 * The Worker scopes every query to the signed-in session (`user_id`).
 */
import { apiDelete, apiGet, apiPatch, apiPut, readApiError } from "./api";
import type {
  Arc,
  ArcStep,
  Fixture,
  GlossaryTerm,
  KnowledgeItem,
  SharedNote,
  Takeaway,
  Action,
  Capacity,
  ChatMessage,
  CustomModality,
  Domain,
  Goal,
  Health,
  LeadUpProfile,
  Manager,
  Me,
  Note,
  Prayer,
  PrayerEntry,
  Session,
  Person,
  Team,
  Topic,
  TrackedMeeting,
  CoverageTarget,
  CurriculumSlot,
  FollowUp,
  Tag,
  TopicPoint,
  TeamAction,
  TeamGoal,
  TeamNote,
  Win,
} from "../types";

export type NodePosition = { x: number; y: number };

/** The full org document the store owns and persists. */
export type PersistedData = {
  me: Me;
  capacities: Capacity[];
  domains: Domain[];
  managers: Manager[];
  teams: Team[];
  people: Person[];
  /** @deprecated Superseded by `topics`. Round-tripped, never read. */
  actions: Action[];
  meetings: TrackedMeeting[];
  /** The workspace vocabulary topics are labelled with. */
  tags: Tag[];
  /** What there is to talk about. Unassigned topics are legal. */
  topics: Topic[];
  /** Commitments that outlive a single occurrence. */
  followUps: FollowUp[];
  sessions: Session[];
  goals: Goal[];
  notes: Note[];
  wins: Win[];
  /** The prayer log — entries for people, teams and managers alike. */
  prayers: PrayerEntry[];
  teamActions: TeamAction[];
  teamGoals: TeamGoal[];
  teamNotes: TeamNote[];
  chats: Record<string, ChatMessage[]>;
  nodePositions: Record<string, NodePosition>;
  /** Things worked through across a meeting, one step per occurrence. */
  arcs: Arc[];
  /** One line per chair per arc step. */
  takeaways: Takeaway[];
  /** Each chair's part of an occurrence's shared write-up. */
  sharedNotes: SharedNote[];
  /** Words the transcriber should get right, mostly learned from corrections. */
  glossary: GlossaryTerm[];
  /** The standing things each team (or person) does. */
  fixtures: Fixture[];
  /** What's known about each person and team: decisions, themes, facts. */
  knowledge: KnowledgeItem[];
};

// --- small helpers ----------------------------------------------------------
const nn = <T>(v: T | undefined | null): T | null => (v === undefined ? null : v);
const opt = <T>(v: T | null | undefined): T | undefined =>
  v === null || v === undefined ? undefined : v;

/**
 * A jsonb value as stored. Until the Worker stopped encoding json parameters
 * twice, a save stored them as a JSON *string* of the value; those rows arrive
 * here as strings, and reading them as "nothing" made a meeting's sections
 * vanish (and the next save erase them for good). Decode them instead.
 */
function fromJson(v: unknown): unknown {
  return typeof v === "string" ? safeJson(v) : v;
}

function parseCoverage(raw: unknown): CoverageTarget[] | undefined {
  const v = fromJson(raw);
  if (!Array.isArray(v)) return undefined;
  const out = v.filter(
    (t): t is CoverageTarget =>
      Boolean(t) &&
      typeof (t as CoverageTarget).tagId === "string" &&
      typeof (t as CoverageTarget).everyNOccurrences === "number"
  );
  return out.length ? out : undefined;
}

function parsePoints(raw: unknown): TopicPoint[] | undefined {
  const v = fromJson(raw);
  if (!Array.isArray(v)) return undefined;
  const out = v
    .filter((p): p is TopicPoint => Boolean(p) && typeof (p as TopicPoint).text === "string")
    .map((p) => ({ id: String(p.id), text: p.text, done: Boolean(p.done) }));
  return out.length ? out : undefined;
}

/** Postgres text[] arrives as an array; anything else is a row we can't trust. */
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * A jsonb array column. Some rows hold it double-encoded — a JSON string of the
 * array — which arrives here as a string; `.map` on that crashed the meeting.
 */
function jsonArray(v: unknown): unknown[] {
  const raw = fromJson(v);
  return Array.isArray(raw) ? raw : [];
}

function jsonStrArray(v: unknown): string[] {
  return strArray(jsonArray(v));
}

function parseSteps(v: unknown): ArcStep[] {
  const raw = fromJson(v);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object")
    .map((x) => ({
      id: String(x.id ?? ""),
      label: String(x.label ?? ""),
      read: typeof x.read === "string" && x.read ? x.read : undefined,
      prompts: Array.isArray(x.prompts)
        ? x.prompts.filter((p): p is string => typeof p === "string")
        : [],
      practice: typeof x.practice === "string" && x.practice ? x.practice : undefined,
      status: x.status === "done" ? ("done" as const) : ("upcoming" as const),
      coveredIn: Array.isArray(x.coveredIn)
        ? x.coveredIn.filter((p): p is string => typeof p === "string")
        : [],
      doneOn: typeof x.doneOn === "string" ? x.doneOn : undefined,
    }))
    .filter((x) => x.id);
}

function safeJson(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

export function parseCurriculum(raw: unknown): CurriculumSlot[] | undefined {
  const v = fromJson(raw);
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const slots: CurriculumSlot[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const row = item as { id?: unknown; label?: unknown; tagId?: unknown; minutes?: unknown };
    if (typeof row.id !== "string" || typeof row.label !== "string") continue;
    const label = row.label.trim();
    if (!label) continue;
    // `tagId` is what makes a section stamp its tag on arrival and count toward
    // coverage; `minutes` budgets its time. Dropping either on load would
    // silently erase them from the database on the next save.
    const slot: CurriculumSlot = { id: row.id, label };
    if (typeof row.tagId === "string" && row.tagId) slot.tagId = row.tagId;
    if (typeof row.minutes === "number" && Number.isFinite(row.minutes) && row.minutes > 0) {
      slot.minutes = row.minutes;
    }
    slots.push(slot);
  }
  return slots.length ? slots : undefined;
}

type Row = Record<string, unknown>;

/** Map a profiles row (or partial legacy me) into a full Me. */
export function meFromRow(r: {
  name?: string | null;
  title?: string | null;
  photo?: string | null;
  clifton_top5?: string[] | null;
  enneagram?: string | null;
  mbti?: string | null;
  strengths?: string[] | null;
  watch_outs?: string[] | null;
  how_to_lead?: string | null;
  custom_modalities?: CustomModality[] | null;
}): Me {
  const top5 = jsonStrArray(r.clifton_top5);
  const enneagram = opt(r.enneagram);
  const mbti = opt(r.mbti);
  const customModalities = jsonArray(r.custom_modalities) as CustomModality[];
  return {
    name: r.name ?? "",
    title: opt(r.title),
    photo: opt(r.photo),
    assessments: {
      ...(top5.length ? { cliftonTop5: top5 } : {}),
      ...(enneagram ? { enneagram } : {}),
      ...(mbti ? { mbti } : {}),
    },
    strengths: jsonStrArray(r.strengths),
    watchOuts: jsonStrArray(r.watch_outs),
    howToLead: opt(r.how_to_lead),
    ...(customModalities.length ? { customModalities } : {}),
  };
}

function meToRow(userId: string, me: Me): Row {
  return {
    user_id: userId,
    name: me.name,
    title: nn(me.title),
    photo: nn(me.photo),
    clifton_top5: me.assessments.cliftonTop5 ?? [],
    enneagram: nn(me.assessments.enneagram),
    mbti: nn(me.assessments.mbti),
    strengths: me.strengths ?? [],
    watch_outs: me.watchOuts ?? [],
    how_to_lead: nn(me.howToLead),
    custom_modalities: me.customModalities ?? [],
    updated_at: new Date().toISOString(),
  };
}

/** Empty Me used for blank/seed defaults before assessment fields are filled. */
export function emptyMe(partial: Partial<Me> & { name: string }): Me {
  return {
    name: partial.name,
    title: partial.title,
    photo: partial.photo,
    assessments: partial.assessments ?? {},
    strengths: partial.strengths ?? [],
    watchOuts: partial.watchOuts ?? [],
    howToLead: partial.howToLead,
    customModalities: partial.customModalities,
  };
}

type DataDoc = {
  profile: Row | null;
  tables: Record<string, Row[]>;
};

// --- mappers: app type ⇄ db row ---------------------------------------------
const map = {
  capacities: {
    table: "capacities",
    toRow: (u: string, c: Capacity): Row => ({
      user_id: u,
      id: c.id,
      label: c.label,
      color: c.color,
    }),
    fromRow: (r: Row): Capacity => ({
      id: r.id as string,
      label: r.label as string,
      color: r.color as string,
    }),
  },
  domains: {
    table: "domains",
    toRow: (u: string, d: Domain): Row => ({
      user_id: u,
      id: d.id,
      name: d.name,
      color: d.color,
    }),
    fromRow: (r: Row): Domain => ({
      id: r.id as string,
      name: r.name as string,
      color: r.color as string,
    }),
  },
  managers: {
    table: "managers",
    toRow: (u: string, m: Manager): Row => ({
      user_id: u,
      id: m.id,
      name: m.name,
      role: nn(m.role),
      domain_id: nn(m.domainId),
      photo: nn(m.photo),
      no_meeting: nn(m.noMeeting),
      prayer: nn(m.prayer ?? null),
      lead_up: nn(m.leadUp ?? null),
    }),
    fromRow: (r: Row): Manager => ({
      id: r.id as string,
      name: r.name as string,
      role: opt(r.role as string | null),
      domainId: opt(r.domain_id as string | null),
      photo: opt(r.photo as string | null),
      noMeeting: opt(r.no_meeting as boolean | null),
      prayer: opt(fromJson(r.prayer) as Prayer | null),
      leadUp: opt(fromJson(r.lead_up) as LeadUpProfile | null),
    }),
  },
  teams: {
    table: "teams",
    toRow: (u: string, t: Team): Row => ({
      user_id: u,
      id: t.id,
      name: t.name,
      capacity_id: t.capacityId,
      domain_id: nn(t.domainId),
      health: nn(t.health ?? null),
      prayer: nn(t.prayer ?? null),
      description: nn(t.description),
      purpose: nn(t.purpose),
      cadence: nn(t.cadence),
      last_met: nn(t.lastMet),
      no_meeting: nn(t.noMeeting),
      sort_order: t.order,
      direction: nn(t.direction),
      parent_id: nn(t.parentId),
      leader_id: nn(t.leaderId),
    }),
    fromRow: (r: Row): Team => ({
      id: r.id as string,
      name: r.name as string,
      capacityId: r.capacity_id as string,
      domainId: opt(r.domain_id as string | null),
      health: opt(fromJson(r.health) as Health | null),
      prayer: opt(fromJson(r.prayer) as Prayer | null),
      description: opt(r.description as string | null),
      purpose: opt(r.purpose as string | null),
      cadence: opt(r.cadence as string | null),
      lastMet: opt(r.last_met as string | null),
      noMeeting: opt(r.no_meeting as boolean | null),
      order: (r.sort_order as number) ?? 0,
      direction: opt(r.direction as "up" | "down" | null),
      parentId: opt(r.parent_id as string | null),
      leaderId: opt(r.leader_id as string | null),
    }),
  },
  people: {
    table: "people",
    toRow: (u: string, p: Person): Row => ({
      user_id: u,
      id: p.id,
      // Null = a direct report with no team.
      team_id: nn(p.teamId),
      domain_id: nn(p.domainId),
      name: p.name,
      role: nn(p.role),
      photo: nn(p.photo),
      health: nn(p.health ?? null),
      prayer: nn(p.prayer ?? null),
      relationship_type: nn(p.relationshipType),
      email: nn(p.email),
      no_meeting: nn(p.noMeeting),
      clifton_top5: p.assessments.cliftonTop5 ?? [],
      enneagram: nn(p.assessments.enneagram),
      mbti: nn(p.assessments.mbti),
      strengths: p.strengths ?? [],
      watch_outs: p.watchOuts ?? [],
      how_to_lead: nn(p.howToLead),
      custom_modalities: p.customModalities ?? [],
      lead_up: nn(p.leadUp ?? null),
    }),
    fromRow: (r: Row): Person => {
      const top5 = jsonStrArray(r.clifton_top5);
      const enneagram = opt(r.enneagram as string | null);
      const mbti = opt(r.mbti as string | null);
      const leadUp = opt(fromJson(r.lead_up) as LeadUpProfile | null);
      const customModalities = jsonArray(r.custom_modalities) as CustomModality[];
      return {
        id: r.id as string,
        teamId: opt(r.team_id as string | null),
        domainId: opt(r.domain_id as string | null),
        name: r.name as string,
        role: opt(r.role as string | null),
        photo: opt(r.photo as string | null),
        health: opt(fromJson(r.health) as Health | null),
        prayer: opt(fromJson(r.prayer) as Prayer | null),
        relationshipType: opt(r.relationship_type as string | null),
        email: opt(r.email as string | null),
        noMeeting: opt(r.no_meeting as boolean | null),
        assessments: {
          ...(top5.length ? { cliftonTop5: top5 } : {}),
          ...(enneagram ? { enneagram } : {}),
          ...(mbti ? { mbti } : {}),
        },
        strengths: jsonStrArray(r.strengths),
        watchOuts: jsonStrArray(r.watch_outs),
        howToLead: opt(r.how_to_lead as string | null),
        ...(customModalities.length ? { customModalities } : {}),
        ...(leadUp ? { leadUp } : {}),
      };
    },
  },
  actions: {
    table: "actions",
    toRow: (u: string, a: Action): Row => ({
      user_id: u,
      id: a.id,
      person_id: a.personId,
      text: a.text,
      done: a.done,
      due_date: nn(a.dueDate),
      board_column: a.column ?? (a.done ? "done" : "backlog"),
    }),
    fromRow: (r: Row): Action => ({
      id: r.id as string,
      personId: r.person_id as string,
      text: r.text as string,
      done: Boolean(r.done),
      dueDate: opt(r.due_date as string | null),
      column: (r.board_column as Action["column"]) ?? "backlog",
    }),
  },
  meetings: {
    table: "meetings",
    toRow: (u: string, m: TrackedMeeting): Row => ({
      user_id: u,
      id: m.id,
      subject_kind: m.subjectKind,
      subject_id: m.subjectId,
      name: nn(m.name),
      rhythm: m.rhythm,
      floor_days: nn(m.floorDays),
      next_date: nn(m.nextDate),
      anchor_weekday: nn(m.anchorWeekday),
      role: nn(m.role),
      tracker_url: nn(m.trackerUrl),
      tracker_name: nn(m.trackerName),
      curriculum: m.curriculum?.length ? m.curriculum : null,
      coverage_targets: m.coverageTargets?.length ? m.coverageTargets : null,
    }),
    fromRow: (r: Row): TrackedMeeting => ({
      id: r.id as string,
      subjectKind: r.subject_kind as TrackedMeeting["subjectKind"],
      subjectId: r.subject_id as string,
      name: opt(r.name as string | null),
      rhythm: (r.rhythm as TrackedMeeting["rhythm"]) ?? "as_needed",
      floorDays: opt(r.floor_days as number | null),
      nextDate: opt(r.next_date as string | null),
      anchorWeekday: opt(r.anchor_weekday as number | null),
      role: opt(r.role as TrackedMeeting["role"] | null),
      trackerUrl: opt(r.tracker_url as string | null),
      trackerName: opt(r.tracker_name as string | null),
      curriculum: parseCurriculum(r.curriculum),
      coverageTargets: parseCoverage(r.coverage_targets),
    }),
  },
  topics: {
    table: "topics",
    toRow: (u: string, t: Topic): Row => ({
      user_id: u,
      id: t.id,
      meeting_id: nn(t.meetingId),
      text: t.text,
      detail: nn(t.detail),
      tag_ids: t.tagIds,
      urgent: Boolean(t.urgent),
      points: t.points?.length ? t.points : null,
      returned_on: nn(t.returnedOn),
      returned_from_date: nn(t.returnedFromDate),
      carried_from: t.carriedFrom,
      status: t.status,
      lane: t.lane,
      session_id: nn(t.sessionId),
      carried: t.carried,
      due_date: nn(t.dueDate),
      created_on: t.createdOn,
      closed_on: nn(t.closedOn),
      sort_order: t.order,
      slot_id: nn(t.slotId),
      is_private: Boolean(t.private),
      is_shared: Boolean(t.shared),
      raised_by: nn(t.raisedBy),
    }),
    fromRow: (r: Row): Topic => ({
      id: r.id as string,
      meetingId: opt(r.meeting_id as string | null),
      text: r.text as string,
      detail: opt(r.detail as string | null),
      tagIds: strArray(r.tag_ids),
      urgent: r.urgent ? true : undefined,
      points: parsePoints(r.points),
      returnedOn: opt(r.returned_on as string | null),
      returnedFromDate: opt(r.returned_from_date as string | null),
      carriedFrom: strArray(r.carried_from),
      status: (r.status as Topic["status"]) ?? "open",
      lane: (r.lane as Topic["lane"]) ?? "backlog",
      sessionId: opt(r.session_id as string | null),
      slotId: opt(r.slot_id as string | null),
      carried: (r.carried as number) ?? 0,
      dueDate: opt(r.due_date as string | null),
      // Backfilled rows have no creation date — the old table never kept one.
      createdOn: (r.created_on as string | null) ?? "",
      closedOn: opt(r.closed_on as string | null),
      order: (r.sort_order as number) ?? 0,
      private: r.is_private ? true : undefined,
      shared: r.is_shared ? true : undefined,
      raisedBy: opt(r.raised_by as string | null),
    }),
  },
  tags: {
    table: "tags",
    toRow: (u: string, t: Tag): Row => ({
      user_id: u,
      id: t.id,
      label: t.label,
      color: t.color,
      sort_order: t.order,
    }),
    fromRow: (r: Row): Tag => ({
      id: r.id as string,
      label: (r.label as string) ?? "",
      color: (r.color as number) ?? 0,
      order: (r.sort_order as number) ?? 0,
    }),
  },
  followUps: {
    table: "follow_ups",
    toRow: (u: string, f: FollowUp): Row => ({
      user_id: u,
      id: f.id,
      subject_kind: f.subjectKind,
      subject_id: f.subjectId,
      meeting_id: nn(f.meetingId),
      text: f.text,
      status: f.status,
      opened_on: f.openedOn,
      closed_on: nn(f.closedOn),
      source_session_id: nn(f.sourceSessionId),
      sort_order: f.order,
      owner: nn(f.owner),
      is_private: Boolean(f.private),
    }),
    fromRow: (r: Row): FollowUp => ({
      id: r.id as string,
      subjectKind: r.subject_kind as FollowUp["subjectKind"],
      subjectId: r.subject_id as string,
      meetingId: opt(r.meeting_id as string | null),
      text: (r.text as string) ?? "",
      status: (r.status as FollowUp["status"]) ?? "open",
      openedOn: (r.opened_on as string | null) ?? "",
      closedOn: opt(r.closed_on as string | null),
      sourceSessionId: opt(r.source_session_id as string | null),
      order: (r.sort_order as number) ?? 0,
      owner: opt(r.owner as string | null),
      private: r.is_private ? true : undefined,
    }),
  },
  sessions: {
    // Still the one_on_ones table — it was always a meeting occurrence, it just
    // used to hardcode its subject. Migration 0007 backfills meeting_id.
    // Rows go through sessionRows(), which also fills the legacy person_id
    // column prod still requires (see migration 0016).
    table: "one_on_ones",
    toRow: (u: string, o: Session): Row => ({
      user_id: u,
      id: o.id,
      meeting_id: o.meetingId,
      date: o.date,
      uncovered: o.uncovered?.length ? o.uncovered : null,
      point: nn(o.point),
      notes: nn(o.notes),
      next_date: nn(o.nextDate),
      transcript: nn(o.transcript),
      series_date: nn(o.seriesDate),
      occurrence_kind: nn(o.kind),
    }),
    fromRow: (r: Row): Session => ({
      id: r.id as string,
      meetingId: (r.meeting_id as string | null) ?? "",
      date: r.date as string,
      point: opt(r.point as string | null),
      notes: opt(r.notes as string | null),
      nextDate: opt(r.next_date as string | null),
      transcript: opt(r.transcript as string | null),
      uncovered: strArray(r.uncovered).length ? strArray(r.uncovered) : undefined,
      seriesDate: opt(r.series_date as string | null),
      kind: opt(r.occurrence_kind as Session["kind"] | null),
    }),
  },
  goals: {
    table: "goals",
    toRow: (u: string, g: Goal): Row => ({
      user_id: u,
      id: g.id,
      person_id: g.personId,
      title: g.title,
      progress: g.progress,
      target_date: nn(g.targetDate),
    }),
    fromRow: (r: Row): Goal => ({
      id: r.id as string,
      personId: r.person_id as string,
      title: r.title as string,
      progress: (r.progress as number) ?? 0,
      targetDate: opt(r.target_date as string | null),
    }),
  },
  notes: {
    table: "notes",
    toRow: (u: string, n: Note): Row => ({
      user_id: u,
      id: n.id,
      person_id: n.personId,
      date: n.date,
      body: n.body,
    }),
    fromRow: (r: Row): Note => ({
      id: r.id as string,
      personId: r.person_id as string,
      date: r.date as string,
      body: r.body as string,
    }),
  },
  wins: {
    table: "wins",
    toRow: (u: string, w: Win): Row => ({
      user_id: u,
      id: w.id,
      person_id: w.personId,
      date: w.date,
      text: w.text,
      impact: nn(w.impact),
    }),
    fromRow: (r: Row): Win => ({
      id: r.id as string,
      personId: r.person_id as string,
      date: r.date as string,
      text: r.text as string,
      impact: opt(r.impact as string | null),
    }),
  },
  prayers: {
    table: "prayers",
    toRow: (u: string, e: PrayerEntry): Row => ({
      user_id: u,
      id: e.id,
      subject_kind: e.subjectKind,
      subject_id: e.subjectId,
      date: e.date,
      kind: e.kind,
      text: e.text,
      answered_on: nn(e.answeredOn),
      answer_note: nn(e.answerNote),
    }),
    fromRow: (r: Row): PrayerEntry => ({
      id: r.id as string,
      subjectKind: r.subject_kind as PrayerEntry["subjectKind"],
      subjectId: r.subject_id as string,
      date: r.date as string,
      kind: r.kind as PrayerEntry["kind"],
      text: r.text as string,
      answeredOn: opt(r.answered_on as string | null),
      answerNote: opt(r.answer_note as string | null),
    }),
  },
  teamActions: {
    table: "team_actions",
    toRow: (u: string, a: TeamAction): Row => ({
      user_id: u,
      id: a.id,
      team_id: a.teamId,
      text: a.text,
      done: a.done,
      due_date: nn(a.dueDate),
    }),
    fromRow: (r: Row): TeamAction => ({
      id: r.id as string,
      teamId: r.team_id as string,
      text: r.text as string,
      done: Boolean(r.done),
      dueDate: opt(r.due_date as string | null),
    }),
  },
  teamGoals: {
    table: "team_goals",
    toRow: (u: string, g: TeamGoal): Row => ({
      user_id: u,
      id: g.id,
      team_id: g.teamId,
      title: g.title,
      progress: g.progress,
      target_date: nn(g.targetDate),
    }),
    fromRow: (r: Row): TeamGoal => ({
      id: r.id as string,
      teamId: r.team_id as string,
      title: r.title as string,
      progress: (r.progress as number) ?? 0,
      targetDate: opt(r.target_date as string | null),
    }),
  },
  teamNotes: {
    table: "team_notes",
    toRow: (u: string, n: TeamNote): Row => ({
      user_id: u,
      id: n.id,
      team_id: n.teamId,
      date: n.date,
      body: n.body,
    }),
    fromRow: (r: Row): TeamNote => ({
      id: r.id as string,
      teamId: r.team_id as string,
      date: r.date as string,
      body: r.body as string,
    }),
  },
  arcs: {
    table: "arcs",
    toRow: (u: string, a: Arc): Row => ({
      user_id: u,
      id: a.id,
      meeting_id: a.meetingId,
      title: a.title,
      author: nn(a.author),
      cover: nn(a.cover),
      cover_url: nn(a.coverUrl),
      slot_id: nn(a.slotId),
      pace_every: Math.max(1, Math.round(a.every || 1)),
      starts_on: a.startsOn,
      status: a.status,
      steps: a.steps,
      passed_in: a.passedIn ?? [],
      created_on: a.createdOn,
      closed_on: nn(a.closedOn),
      sort_order: a.order,
    }),
    fromRow: (r: Row): Arc => ({
      id: r.id as string,
      meetingId: r.meeting_id as string,
      title: (r.title as string) ?? "",
      author: opt(r.author as string | null),
      cover: opt(r.cover as number | null),
      coverUrl: opt(r.cover_url as string | null),
      slotId: opt(r.slot_id as string | null),
      every: Math.max(1, (r.pace_every as number) ?? 1),
      startsOn: (r.starts_on as string) ?? "",
      status: (r.status as Arc["status"]) ?? "active",
      steps: parseSteps(r.steps),
      passedIn: strArray(r.passed_in).length ? strArray(r.passed_in) : undefined,
      createdOn: (r.created_on as string | null) ?? "",
      closedOn: opt(r.closed_on as string | null),
      order: (r.sort_order as number) ?? 0,
    }),
  },
  takeaways: {
    table: "arc_takeaways",
    toRow: (u: string, t: Takeaway): Row => ({
      user_id: u,
      id: t.id,
      arc_id: t.arcId,
      step_id: t.stepId,
      by_member: t.by,
      text: t.text,
      taken_on: t.on,
    }),
    fromRow: (r: Row): Takeaway => ({
      id: r.id as string,
      arcId: r.arc_id as string,
      stepId: r.step_id as string,
      by: (r.by_member as string) ?? "owner",
      text: (r.text as string) ?? "",
      on: (r.taken_on as string | null) ?? "",
    }),
  },
  sharedNotes: {
    table: "shared_notes",
    toRow: (u: string, n: SharedNote): Row => ({
      user_id: u,
      id: n.id,
      meeting_id: n.meetingId,
      session_id: n.sessionId,
      by_member: n.by,
      body: n.body,
      updated_on: n.updatedOn,
    }),
    fromRow: (r: Row): SharedNote => ({
      id: r.id as string,
      meetingId: r.meeting_id as string,
      sessionId: r.session_id as string,
      by: (r.by_member as string) ?? "owner",
      body: (r.body as string) ?? "",
      updatedOn: (r.updated_on as string | null) ?? "",
    }),
  },
  glossary: {
    table: "glossary",
    toRow: (u: string, g: GlossaryTerm): Row => ({
      user_id: u,
      id: g.id,
      heard: nn(g.heard),
      meant: g.meant,
      created_on: g.createdOn,
    }),
    fromRow: (r: Row): GlossaryTerm => ({
      id: r.id as string,
      heard: opt(r.heard as string | null),
      meant: (r.meant as string) ?? "",
      createdOn: (r.created_on as string | null) ?? "",
    }),
  },
  fixtures: {
    table: "fixtures",
    toRow: (u: string, f: Fixture): Row => ({
      user_id: u,
      id: f.id,
      subject_kind: f.subjectKind,
      subject_id: f.subjectId,
      title: f.title,
      owner: nn(f.owner),
      cadence: f.cadence,
      notes: nn(f.notes),
      last_touched_on: nn(f.lastTouchedOn),
      created_on: f.createdOn,
      sort_order: f.order,
    }),
    fromRow: (r: Row): Fixture => ({
      id: r.id as string,
      subjectKind: r.subject_kind as Fixture["subjectKind"],
      subjectId: r.subject_id as string,
      title: (r.title as string) ?? "",
      owner: opt(r.owner as string | null),
      cadence: (r.cadence as Fixture["cadence"]) ?? "monthly",
      notes: opt(r.notes as string | null),
      lastTouchedOn: opt(r.last_touched_on as string | null),
      createdOn: (r.created_on as string | null) ?? "",
      order: (r.sort_order as number) ?? 0,
    }),
  },
  knowledge: {
    table: "knowledge",
    toRow: (u: string, k: KnowledgeItem): Row => ({
      user_id: u,
      id: k.id,
      subject_kind: k.subjectKind,
      subject_id: k.subjectId,
      kind: k.kind,
      text: k.text,
      session_id: nn(k.sessionId),
      noted_on: k.notedOn,
      pinned: Boolean(k.pinned),
    }),
    fromRow: (r: Row): KnowledgeItem => ({
      id: r.id as string,
      subjectKind: r.subject_kind as KnowledgeItem["subjectKind"],
      subjectId: r.subject_id as string,
      kind: (r.kind as KnowledgeItem["kind"]) ?? "fact",
      text: (r.text as string) ?? "",
      sessionId: opt(r.session_id as string | null),
      notedOn: (r.noted_on as string | null) ?? "",
      pinned: r.pinned ? true : undefined,
    }),
  },
} as const;

/** Collections that map 1:1 to an id-keyed table. */
type CollKey = keyof typeof map;
const COLLECTIONS = Object.keys(map) as CollKey[];

/**
 * Build one_on_ones rows for sync/write.
 *
 * The app keys sessions by `meeting_id` only. Prod still has
 * `one_on_ones.person_id NOT NULL` from before 0007 — migration 0016 drops that
 * constraint, but until it is applied every upsert must send a non-null value
 * or the whole cloud sync fails. Denormalize the meeting's subject id into the
 * legacy column (person, team, or manager — the old name lied for managers
 * already). Prefer that over writing null and taking down every save.
 */
function sessionRows(
  userId: string,
  sessions: Session[],
  meetings: TrackedMeeting[]
): Row[] {
  const subjectByMeeting = new Map(
    meetings.map((m) => [m.id, m.subjectId] as const)
  );
  return sessions.map((o) => ({
    ...map.sessions.toRow(userId, o),
    // Fallback to meetingId so a dangling session still satisfies NOT NULL
    // rather than aborting the entire document write.
    person_id: subjectByMeeting.get(o.meetingId) ?? o.meetingId,
  }));
}

/** Map one collection to rows, with the sessions special-case above. */
function collectionRows(
  userId: string,
  k: CollKey,
  d: PersistedData,
  items: unknown[]
): Row[] {
  if (k === "sessions") {
    return sessionRows(userId, items as Session[], d.meetings ?? []);
  }
  const m = map[k];
  return items.map((item) =>
    (m.toRow as (u: string, item: unknown) => Row)(userId, item)
  );
}

// --- chats & node positions (key-value shaped) ------------------------------
function chatRows(userId: string, chats: PersistedData["chats"]): Row[] {
  return Object.entries(chats).map(([chat_key, messages]) => ({
    user_id: userId,
    chat_key,
    messages,
  }));
}
function posRows(userId: string, pos: PersistedData["nodePositions"]): Row[] {
  return Object.entries(pos).map(([node_id, p]) => ({
    user_id: userId,
    node_id,
    x: p.x,
    y: p.y,
  }));
}

// --- baseline tracking for incremental sync ---------------------------------
let baseline: PersistedData | null = null;

/** Record the current data as the "already persisted" reference. */
export function setBaseline(data: PersistedData): void {
  baseline = data;
}

/** Forget the baseline (on sign-out) so nothing syncs until the next load. */
export function clearBaseline(): void {
  baseline = null;
}

/** True once a baseline exists (i.e. we've loaded or seeded). */
export function hasBaseline(): boolean {
  return baseline !== null;
}

/** The document the server is believed to hold, as of the last load or write. */
export function getBaseline(): PersistedData | null {
  return baseline;
}

// --- public API -------------------------------------------------------------

/**
 * Read the whole org for a user. Returns null when the user has no profile row
 * yet (a brand-new account that still needs seeding).
 */
export async function loadAll(userId: string): Promise<PersistedData | null> {
  void userId;
  const res = await apiGet("/api/data");
  if (!res.ok) await readApiError(res, "load");
  const doc = (await res.json()) as DataDoc;
  const prof = doc.profile;
  if (!prof) return null; // fresh user

  const grab = (table: string): Row[] => (doc.tables?.[table] ?? []) as Row[];

  const capacities = grab("capacities");
  const domains = grab("domains");
  const managers = grab("managers");
  const teams = grab("teams");
  const people = grab("people");
  const actions = grab("actions");
  const meetings = grab("meetings");
  const tags = grab("tags");
  const topics = grab("topics");
  const followUps = grab("follow_ups");
  const sessions = grab("one_on_ones");
  const goals = grab("goals");
  const notes = grab("notes");
  const wins = grab("wins");
  const prayers = grab("prayers");
  const teamActions = grab("team_actions");
  const teamGoals = grab("team_goals");
  const teamNotes = grab("team_notes");
  const chats = grab("chats");
  const positions = grab("node_positions");
  const arcs = grab("arcs");
  const takeaways = grab("arc_takeaways");
  const sharedNotes = grab("shared_notes");
  const glossary = grab("glossary");
  const fixtures = grab("fixtures");
  const knowledge = grab("knowledge");

  const data: PersistedData = {
    me: meFromRow(prof as Parameters<typeof meFromRow>[0]),
    capacities: capacities.map(map.capacities.fromRow),
    domains: domains.map(map.domains.fromRow),
    managers: managers.map(map.managers.fromRow),
    teams: teams.map(map.teams.fromRow).sort((a, b) => a.order - b.order),
    people: people.map(map.people.fromRow),
    actions: actions.map(map.actions.fromRow),
    meetings: meetings.map(map.meetings.fromRow),
    tags: tags.map(map.tags.fromRow).sort((a, b) => a.order - b.order),
    topics: topics.map(map.topics.fromRow).sort((a, b) => a.order - b.order),
    followUps: followUps.map(map.followUps.fromRow).sort((a, b) => a.order - b.order),
    sessions: sessions.map(map.sessions.fromRow),
    goals: goals.map(map.goals.fromRow),
    notes: notes.map(map.notes.fromRow),
    wins: wins.map(map.wins.fromRow),
    prayers: prayers.map(map.prayers.fromRow),
    teamActions: teamActions.map(map.teamActions.fromRow),
    teamGoals: teamGoals.map(map.teamGoals.fromRow),
    teamNotes: teamNotes.map(map.teamNotes.fromRow),
    chats: Object.fromEntries(
      chats.map((r) => [r.chat_key as string, (jsonArray(r.messages) as ChatMessage[])])
    ),
    nodePositions: Object.fromEntries(
      positions.map((r) => [
        r.node_id as string,
        { x: r.x as number, y: r.y as number },
      ])
    ),
    arcs: arcs.map(map.arcs.fromRow).sort((a, b) => a.order - b.order),
    takeaways: takeaways.map(map.takeaways.fromRow),
    sharedNotes: sharedNotes.map(map.sharedNotes.fromRow),
    glossary: glossary.map(map.glossary.fromRow),
    fixtures: fixtures.map(map.fixtures.fromRow).sort((a, b) => a.order - b.order),
    knowledge: knowledge.map(map.knowledge.fromRow),
  };
  return data;
}

/** Insert a full document for a user (first-time seed or import). */
export async function writeAll(userId: string, d: PersistedData): Promise<void> {
  const upserts: Record<string, Row[]> = {};
  for (const k of COLLECTIONS) {
    const items = d[k] as unknown[] | undefined;
    if (!Array.isArray(items)) {
      throw new Error(
        `writeAll: missing collection "${k}" — refusing to wipe the table`
      );
    }
    upserts[map[k].table] = collectionRows(userId, k, d, items);
  }
  upserts.chats = chatRows(userId, d.chats);
  upserts.node_positions = posRows(userId, d.nodePositions);

  const res = await apiPut("/api/data", {
    profile: meToRow(userId, d.me),
    upserts,
  });
  if (!res.ok) await readApiError(res, "write");

  setBaseline(d);
}

/**
 * Row-level difference between two versions of an id-keyed collection.
 *
 * Only rows whose object identity changed are written, and only rows that were
 * in `before` and are gone from `after` are deleted. The store never mutates a
 * row in place — every edit replaces the object — so identity is an exact and
 * free change marker.
 *
 * This is what makes a stale device harmless. Sync used to be "upsert every
 * row I hold, delete every server row I don't", which is only correct when one
 * device is the whole truth. A laptop tab left open for a week is not: the
 * first edit it made deleted everything captured on the phone since. Now a
 * device can only ever delete a row it has seen and the user removed here.
 */
function diffRows<T>(
  before: T[] | undefined,
  after: T[],
  idOf: (item: T) => string
): { changed: T[]; removed: string[] } {
  if (!before) return { changed: after, removed: [] };
  const prev = new Map(before.map((x) => [idOf(x), x] as const));
  const changed = after.filter((x) => prev.get(idOf(x)) !== x);
  const keep = new Set(after.map(idOf));
  const removed = before.map(idOf).filter((id) => !keep.has(id));
  return { changed, removed };
}

function diffRecord<V>(
  before: Record<string, V> | undefined,
  after: Record<string, V>
): { changed: Record<string, V>; removed: string[] } {
  if (!before) return { changed: after, removed: [] };
  const changed: Record<string, V> = {};
  for (const [k, v] of Object.entries(after)) {
    if (before[k] !== v) changed[k] = v;
  }
  const removed = Object.keys(before).filter((k) => !(k in after));
  return { changed, removed };
}

type SyncPayload = {
  profile?: Row;
  upserts: Record<string, Row[]>;
  deletes: Record<string, string[]>;
};

function addUpserts(payload: SyncPayload, table: string, rows: Row[]): void {
  if (!rows.length) return;
  payload.upserts[table] = rows;
}

function addDeletes(payload: SyncPayload, table: string, keys: string[]): void {
  if (!keys.length) return;
  payload.deletes[table] = keys;
}

/**
 * Persist what this device changed since the last baseline — row by row.
 *
 * With no baseline (a cached document holding offline edits, whose server
 * state is unknown) every row is upserted and nothing is deleted: resurrecting
 * a row is recoverable, deleting one is not.
 */
export async function syncData(userId: string, d: PersistedData): Promise<void> {
  const base = baseline;
  const payload: SyncPayload = { upserts: {}, deletes: {} };

  if (!base || base.me !== d.me) {
    payload.profile = meToRow(userId, d.me);
  }

  for (const k of COLLECTIONS) {
    if (base && base[k] === d[k]) continue;
    const items = d[k] as { id: string }[] | undefined;
    // Skip a missing slice rather than mapping undefined (which threw in prod
    // and blocked every save). With row diffs it could no longer wipe a table,
    // but it would still read as "every row was deleted".
    if (!Array.isArray(items)) {
      console.error(`Polarch: sync skipped missing collection "${k}"`);
      continue;
    }
    const { changed, removed } = diffRows(
      base?.[k] as { id: string }[] | undefined,
      items,
      (x) => x.id
    );
    const table = map[k].table;
    addUpserts(payload, table, collectionRows(userId, k, d, changed));
    addDeletes(payload, table, removed);
  }

  if (!base || base.chats !== d.chats) {
    if (d.chats && typeof d.chats === "object") {
      const { changed, removed } = diffRecord(base?.chats, d.chats);
      addUpserts(payload, "chats", chatRows(userId, changed));
      addDeletes(payload, "chats", removed);
    } else {
      console.error('Polarch: sync skipped missing collection "chats"');
    }
  }
  if (!base || base.nodePositions !== d.nodePositions) {
    if (d.nodePositions && typeof d.nodePositions === "object") {
      const { changed, removed } = diffRecord(base?.nodePositions, d.nodePositions);
      addUpserts(payload, "node_positions", posRows(userId, changed));
      addDeletes(payload, "node_positions", removed);
    } else {
      console.error('Polarch: sync skipped missing collection "nodePositions"');
    }
  }

  if (
    !payload.profile &&
    Object.keys(payload.upserts).length === 0 &&
    Object.keys(payload.deletes).length === 0
  ) {
    setBaseline(d);
    return;
  }

  const res = await apiPatch("/api/data", payload);
  if (!res.ok) await readApiError(res, "sync");
  setBaseline(d);
}

/** Delete every row this user owns (used by the cloud "reset to seed"). */
export async function wipeUser(userId: string): Promise<void> {
  void userId;
  const res = await apiDelete("/api/data");
  if (!res.ok) await readApiError(res, "wipe");
  baseline = null;
}
