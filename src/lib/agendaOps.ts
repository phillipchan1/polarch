/**
 * Agenda operations as pure functions over plain state.
 *
 * The MCP server runs these against a user's rows; the store's actions
 * (`placeTopicAt`, `skipOccurrence`, `moveOccurrence`, `rollTopic`, …) are the
 * original of every rule here. Where the store quietly no-ops on bad input
 * (it is driven by clicks that can't be wrong), these throw an `OpError` with a
 * message an assistant can act on — "that week is skipped", "pick one of these
 * dates" — because a caller that can type anything needs to be told.
 *
 * Rows that aren't touched keep their object identity, so a caller can diff
 * `before` and `after` the way `repo.syncData` does and write only what moved.
 *
 * Nothing here reads a clock or makes an id: both arrive in `OpEnv`.
 */
import type {
  CoverageTarget,
  CurriculumSlot,
  FollowUp,
  MeetingRhythm,
  Session,
  Tag,
  Topic,
  TopicLane,
  TopicPoint,
  TrackedMeeting,
} from "../types";
import { reorderInto, reorderManyInto } from "./ideas.ts";
import { addDays, weekdayUTC } from "./readiness.ts";
import { effectiveSlotId, nextSlotAfter, plannedSlots, type Slot } from "./topics.ts";

export type AgendaState = {
  meetings: TrackedMeeting[];
  sessions: Session[];
  topics: Topic[];
  followUps: FollowUp[];
  tags: Tag[];
};

export type OpEnv = {
  /** A fresh id. The store uses 8 base-36 chars; anything unique works. */
  uid: () => string;
  /** The caller's "today", YYYY-MM-DD. */
  today: string;
};

export type OpResult<T> = { state: AgendaState; value: T };

export class OpError extends Error {
  readonly code: "not_found" | "invalid" | "conflict";
  readonly details?: Record<string, unknown>;
  constructor(
    code: OpError["code"],
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "OpError";
    this.code = code;
    this.details = details;
  }
}

const notFound = (what: string, id: string) =>
  new OpError("not_found", `No ${what} with id "${id}".`);
const invalid = (message: string, details?: Record<string, unknown>) =>
  new OpError("invalid", message, details);

// ── Dates ─────────────────────────────────────────────────────────────────

export function isISODate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function weekdayOf(iso: string): number {
  return weekdayUTC(iso);
}

/** How far ahead a date may be booked: the planner's longest horizon. */
const BOOKING_AHEAD = 26;

// ── Lookups ───────────────────────────────────────────────────────────────

export function meetingOf(state: AgendaState, id: string): TrackedMeeting {
  const meeting = state.meetings.find((m) => m.id === id);
  if (!meeting) throw notFound("meeting", id);
  return meeting;
}

function topicOf(state: AgendaState, id: string): Topic {
  const topic = state.topics.find((t) => t.id === id);
  if (!topic) throw notFound("topic", id);
  return topic;
}

function sectionOf(meeting: TrackedMeeting, slotId: string): CurriculumSlot {
  const slot = (meeting.curriculum ?? []).find((c) => c.id === slotId);
  if (!slot) {
    throw invalid(
      `This meeting has no section "${slotId}".`,
      { sections: (meeting.curriculum ?? []).map((c) => ({ id: c.id, label: c.label })) },
    );
  }
  return slot;
}

function liveOn(state: AgendaState, meetingId: string, date: string): Session | undefined {
  return state.sessions.find(
    (o) => o.meetingId === meetingId && o.date === date && o.kind !== "skipped",
  );
}

function skippedOn(state: AgendaState, meetingId: string, date: string): Session | undefined {
  return state.sessions.find(
    (o) => o.meetingId === meetingId && o.kind === "skipped" && (o.seriesDate ?? o.date) === date,
  );
}

function trimmed(value: string, label: string, max: number): string {
  const text = value.trim();
  if (!text) throw invalid(`${label} can't be empty.`);
  if (text.length > max) throw invalid(`${label} is too long (max ${max} characters).`);
  return text;
}

// ── Occurrences ───────────────────────────────────────────────────────────

/** Upcoming dates a meeting can be planned into: booked ones and projections. */
export function upcomingSlots(
  state: AgendaState,
  env: OpEnv,
  meeting: TrackedMeeting,
  ahead: number = BOOKING_AHEAD,
): Slot[] {
  return plannedSlots(meeting, state.sessions, state.topics, env.today, ahead).filter(
    (s) => !s.past,
  );
}

/**
 * The session on `date`, booked on the way if it's only a projection.
 *
 * Planning into a week is what makes it real — the same rule as dropping a card
 * on a projected column. Dates off the rhythm are refused: a session on an
 * arbitrary day would quietly drag the whole series with it. An off-rhythm day
 * is `addExtraOccurrence`; moving one week is `moveOccurrence`.
 */
export function ensureOccurrence(
  state: AgendaState,
  env: OpEnv,
  meetingId: string,
  date: string,
): { sessions: Session[]; sessionId: string; booked: boolean } {
  const meeting = meetingOf(state, meetingId);
  if (!isISODate(date)) throw invalid(`"${date}" isn't a date (use YYYY-MM-DD).`);
  const live = liveOn(state, meetingId, date);
  if (live) return { sessions: state.sessions, sessionId: live.id, booked: false };
  if (skippedOn(state, meetingId, date)) {
    throw new OpError(
      "conflict",
      `${date} is a skipped week of this meeting. Restore it first, or pick another date.`,
    );
  }
  if (date < env.today) {
    throw invalid(`${date} is in the past, and no meeting was held that day.`);
  }
  const slots = upcomingSlots(state, env, meeting);
  const onRhythm = slots.some((s) => s.date === date);
  const bookable =
    onRhythm ||
    // An as-needed meeting has no rhythm to stay on: any future day is a booking.
    (meeting.rhythm === "as_needed" && date >= env.today);
  if (!bookable) {
    throw invalid(
      `${date} isn't an occurrence of this meeting. Use one of the upcoming dates, or add a one-off meeting on that day.`,
      { upcoming: slots.slice(0, 12).map((s) => s.date) },
    );
  }
  const id = env.uid();
  return { sessions: [...state.sessions, { id, meetingId, date }], sessionId: id, booked: true };
}

/** Which session a date means for moving or skipping: a booked one, or a projection. */
function occurrenceRef(
  state: AgendaState,
  env: OpEnv,
  meetingId: string,
  date: string,
): { sessionId: string | null; date: string } {
  const meeting = meetingOf(state, meetingId);
  if (!isISODate(date)) throw invalid(`"${date}" isn't a date (use YYYY-MM-DD).`);
  const live = liveOn(state, meetingId, date);
  if (live) return { sessionId: live.id, date: live.date };
  if (skippedOn(state, meetingId, date)) {
    throw new OpError("conflict", `${date} is already skipped.`);
  }
  const slots = upcomingSlots(state, env, meeting);
  if (!slots.some((s) => s.date === date)) {
    throw invalid(`${date} isn't an upcoming occurrence of this meeting.`, {
      upcoming: slots.slice(0, 12).map((s) => s.date),
    });
  }
  return { sessionId: null, date };
}

// ── Tags ──────────────────────────────────────────────────────────────────

/**
 * A topic's tags after it lands in `slotId`, having left `fromSlotId`. The row a
 * card sits in *is* its tag on the planner, so moving between sections swaps
 * one tag for the other instead of accumulating them. (`slotTagIds` in the store.)
 */
export function slotTagIds(
  meetings: TrackedMeeting[],
  meetingId: string | undefined,
  tagIds: string[],
  slotId: string | undefined,
  fromSlotId?: string,
): string[] {
  const curriculum = meetings.find((m) => m.id === meetingId)?.curriculum ?? [];
  const fromRow =
    fromSlotId === undefined
      ? undefined
      : effectiveSlotId({ slotId: fromSlotId || undefined, tagIds } as Topic, curriculum);
  const from = curriculum.find((c) => c.id === fromRow)?.tagId;
  const to = curriculum.find((c) => c.id === slotId)?.tagId;
  let next = tagIds;
  if (from && from !== to) next = next.filter((x) => x !== from);
  if (to && !next.includes(to)) next = [...next, to];
  return next;
}

function checkTags(state: AgendaState, tagIds: string[]): string[] {
  const known = new Set(state.tags.map((t) => t.id));
  const unknown = tagIds.filter((id) => !known.has(id));
  if (unknown.length) {
    throw invalid(`Unknown tag id(s): ${unknown.join(", ")}.`, {
      tags: state.tags.map((t) => ({ id: t.id, label: t.label })),
    });
  }
  return [...new Set(tagIds)];
}

export function createTag(state: AgendaState, env: OpEnv, label: string): OpResult<Tag> {
  const text = trimmed(label, "Tag label", 40);
  const existing = state.tags.find((t) => t.label.trim().toLowerCase() === text.toLowerCase());
  if (existing) return { state, value: existing };
  const tag: Tag = { id: env.uid(), label: text, color: state.tags.length % 6, order: state.tags.length };
  return { state: { ...state, tags: [...state.tags, tag] }, value: tag };
}

export function renameTag(state: AgendaState, id: string, label: string): OpResult<Tag> {
  const tag = state.tags.find((t) => t.id === id);
  if (!tag) throw notFound("tag", id);
  const text = trimmed(label, "Tag label", 40);
  const clash = state.tags.find((t) => t.id !== id && t.label.trim().toLowerCase() === text.toLowerCase());
  if (clash) throw new OpError("conflict", `A tag called "${clash.label}" already exists.`);
  const next = { ...tag, label: text };
  return { state: { ...state, tags: state.tags.map((t) => (t.id === id ? next : t)) }, value: next };
}

/** Colour (an index into the six tag pigments) and/or position among the tags. */
export function updateTag(
  state: AgendaState,
  id: string,
  patch: { color?: number; position?: number },
): OpResult<Tag> {
  const tag = state.tags.find((t) => t.id === id);
  if (!tag) throw notFound("tag", id);
  let tags = state.tags;
  if (patch.color !== undefined) {
    if (!Number.isInteger(patch.color) || patch.color < 0 || patch.color > 5) throw invalid("Tag colour is 0–5.");
    tags = tags.map((t) => (t.id === id ? { ...t, color: patch.color! } : t));
  }
  if (patch.position !== undefined) {
    const sorted = [...tags].sort((a, b) => a.order - b.order).filter((t) => t.id !== id);
    sorted.splice(Math.max(0, Math.min(patch.position, sorted.length)), 0, tags.find((t) => t.id === id)!);
    const order = new Map(sorted.map((t, i) => [t.id, i] as const));
    tags = tags.map((t) => (t.order === order.get(t.id) ? t : { ...t, order: order.get(t.id)! }));
  }
  return { state: { ...state, tags }, value: tags.find((t) => t.id === id)! };
}

/**
 * Remove a tag everywhere, as the tag manager does: off every topic, off any
 * section that stamped it, and out of coverage targets (a target on a dead
 * tag would silently stop counting).
 */
export function deleteTag(state: AgendaState, id: string): OpResult<Tag> {
  const tag = state.tags.find((t) => t.id === id);
  if (!tag) throw notFound("tag", id);
  return {
    state: {
      ...state,
      tags: state.tags.filter((t) => t.id !== id),
      topics: state.topics.map((t) => (t.tagIds.includes(id) ? { ...t, tagIds: t.tagIds.filter((x) => x !== id) } : t)),
      meetings: state.meetings.map((m) => {
        const hits = m.curriculum?.some((c) => c.tagId === id) || m.coverageTargets?.some((c) => c.tagId === id);
        if (!hits) return m;
        const targets = m.coverageTargets?.filter((c) => c.tagId !== id);
        return {
          ...m,
          curriculum: m.curriculum?.map((c) => (c.tagId === id ? { ...c, tagId: undefined } : c)),
          coverageTargets: targets?.length ? targets : undefined,
        };
      }),
    },
    value: tag,
  };
}

// ── Topics ────────────────────────────────────────────────────────────────

/** Where a topic goes. `date` books the occurrence if it is only a projection. */
export type Target =
  | { kind: "lane"; lane: TopicLane; meetingId?: string; slotId?: string }
  | { kind: "session"; sessionId: string; slotId?: string }
  | { kind: "date"; meetingId: string; date: string; slotId?: string };

export type NewTopic = {
  meetingId?: string;
  text: string;
  detail?: string;
  tagIds?: string[];
  urgent?: boolean;
  dueDate?: string;
  slotId?: string;
  private?: boolean;
  /** Show an idea still in the tray on a shared meeting's page. Clears `private`. */
  shared?: boolean;
  /** Talking points: what the topic breaks down into. */
  points?: string[];
  /** Omit for the idea tray (or the meeting's backlog when `meetingId` is set). */
  date?: string;
  parked?: boolean;
};

export function addTopics(
  state: AgendaState,
  env: OpEnv,
  items: NewTopic[],
): OpResult<{ topics: Topic[]; booked: Session[] }> {
  if (!items.length) throw invalid("Nothing to add.");
  if (items.length > 50) throw invalid("Add at most 50 topics at a time.");
  let { sessions, topics } = state;
  const created: Topic[] = [];
  const booked: Session[] = [];

  for (const item of items) {
    const text = trimmed(item.text, "Topic text", 500);
    const meetingId = item.meetingId;
    if (meetingId) meetingOf(state, meetingId);
    if (!meetingId && (item.date || item.slotId)) {
      throw invalid("A date or section needs a meeting.");
    }
    if (item.slotId) sectionOf(meetingOf(state, meetingId!), item.slotId);
    if (item.dueDate !== undefined && !isISODate(item.dueDate)) {
      throw invalid(`Due date "${item.dueDate}" isn't a date (use YYYY-MM-DD).`);
    }
    if (item.date && item.parked) throw invalid("A topic can't be both on a date and parked.");

    let sessionId: string | undefined;
    if (item.date) {
      const at = ensureOccurrence({ ...state, sessions, topics }, env, meetingId!, item.date);
      sessionId = at.sessionId;
      if (at.booked) {
        sessions = at.sessions;
        booked.push(sessions[sessions.length - 1]);
      }
    }
    const tagIds = slotTagIds(
      state.meetings,
      meetingId,
      checkTags(state, item.tagIds ?? []),
      item.slotId,
    );
    const topic: Topic = {
      id: env.uid(),
      meetingId,
      text,
      detail: item.detail?.trim() || undefined,
      status: "open",
      lane: item.parked ? "parked" : "backlog",
      sessionId,
      slotId: item.slotId,
      tagIds,
      urgent: item.urgent || undefined,
      private: (item.private && !item.shared) || undefined,
      shared: item.shared || undefined,
      points: item.points?.length ? newPoints(env, item.points) : undefined,
      carried: 0,
      carriedFrom: [],
      dueDate: item.dueDate,
      createdOn: env.today,
      order: 0,
    };
    topics = reorderInto([...topics, topic], topic);
    created.push(topics.find((t) => t.id === topic.id)!);
  }
  return {
    state: { ...state, sessions, topics },
    value: { topics: created.map((c) => topics.find((t) => t.id === c.id)!), booked },
  };
}

export type TopicPatch = {
  text?: string;
  detail?: string | null;
  urgent?: boolean;
  dueDate?: string | null;
  tagIds?: string[];
  private?: boolean;
  /** Sharing an idea un-privates it, and keeping it private un-shares it — as the board's menu does. */
  shared?: boolean;
  /** Replaces the talking points. `done` keeps a point ticked. */
  points?: { text: string; done?: boolean }[];
};

function newPoints(env: OpEnv, points: (string | { text: string; done?: boolean })[]): TopicPoint[] {
  if (points.length > 30) throw invalid("A topic can hold at most 30 talking points.");
  return points.map((p) => {
    const text = trimmed(typeof p === "string" ? p : p.text, "Talking point", 300);
    return { id: env.uid(), text, done: typeof p === "string" ? false : Boolean(p.done) };
  });
}

export function updateTopic(state: AgendaState, id: string, patch: TopicPatch, env?: OpEnv): OpResult<Topic> {
  const topic = topicOf(state, id);
  const next: Topic = { ...topic };
  if (patch.text !== undefined) next.text = trimmed(patch.text, "Topic text", 500);
  if (patch.detail !== undefined) next.detail = patch.detail?.trim() || undefined;
  if (patch.urgent !== undefined) next.urgent = patch.urgent || undefined;
  if (patch.private !== undefined) {
    next.private = patch.private || undefined;
    if (patch.private) next.shared = undefined;
  }
  if (patch.shared !== undefined) {
    next.shared = patch.shared || undefined;
    if (patch.shared) next.private = undefined;
  }
  if (patch.points !== undefined) {
    if (!env) throw invalid("Talking points need an id source.");
    // Keep a point's id when its text is unchanged, so a tick in the app survives a rewrite.
    const old = topic.points ?? [];
    next.points = newPoints(env, patch.points).map((p) => {
      const same = old.find((o) => o.text === p.text);
      return same ? { ...p, id: same.id } : p;
    });
    if (!next.points.length) next.points = undefined;
  }
  if (patch.dueDate !== undefined) {
    if (patch.dueDate !== null && !isISODate(patch.dueDate)) {
      throw invalid(`Due date "${patch.dueDate}" isn't a date (use YYYY-MM-DD).`);
    }
    next.dueDate = patch.dueDate ?? undefined;
  }
  if (patch.tagIds !== undefined) next.tagIds = checkTags(state, patch.tagIds);
  return {
    state: { ...state, topics: state.topics.map((t) => (t.id === id ? next : t)) },
    value: next,
  };
}

/**
 * Where one topic lands, and the sessions after any booking the drop implies.
 * Pure, so the single and batch paths can't drift. (`placement` in the store.)
 */
function placeOne(
  s: AgendaState,
  env: OpEnv,
  id: string,
  target: Target,
  keepSection: boolean,
): { sessions: Session[]; moved: Topic; booked?: Session } {
  const topic = topicOf(s, id);
  let sessions = s.sessions;
  let booked: Session | undefined;
  let sessionId: string | undefined;
  let lane = topic.lane;
  let meetingId = "meetingId" in target && target.meetingId ? target.meetingId : topic.meetingId;

  if (target.kind === "session") {
    const owner = sessions.find((o) => o.id === target.sessionId);
    if (!owner) throw notFound("occurrence", target.sessionId);
    if (owner.kind === "skipped") {
      throw new OpError("conflict", "That occurrence is skipped; restore it first.");
    }
    sessionId = owner.id;
    meetingId = owner.meetingId;
  } else if (target.kind === "date") {
    const at = ensureOccurrence({ ...s, sessions }, env, target.meetingId, target.date);
    sessions = at.sessions;
    if (at.booked) booked = sessions[sessions.length - 1];
    sessionId = at.sessionId;
    meetingId = target.meetingId;
  } else {
    lane = target.lane;
    if (target.meetingId) meetingOf(s, target.meetingId);
  }
  if (sessionId) lane = "backlog";
  // A drop target always names its section (or none). Someone saying "move it
  // to the 12th" doesn't mean "and take it out of Prayer", so `keepSection`
  // carries each topic's own section along when the meeting stays the same.
  const slotId =
    target.slotId ?? (keepSection && topic.meetingId === meetingId ? topic.slotId : undefined);
  if (slotId) {
    if (!meetingId) throw invalid("A section needs a meeting.");
    sectionOf(meetingOf(s, meetingId), slotId);
  }

  // A section with a tag stamps it on arrival — what makes coverage trustworthy
  // without anyone tagging by hand.
  const tagIds = slotTagIds(
    s.meetings,
    meetingId,
    topic.tagIds,
    slotId,
    topic.meetingId === meetingId ? (topic.slotId ?? "") : undefined,
  );
  const moved: Topic = {
    ...topic,
    status: "open",
    closedOn: undefined,
    meetingId,
    sessionId,
    slotId,
    lane,
    tagIds,
    // Placing it by hand is a decision — it stops reading as "came back".
    returnedOn: undefined,
    returnedFromDate: undefined,
  };
  return { sessions, moved, booked };
}

/**
 * Put topics somewhere: a week, the idea tray, parked. Landing together and in
 * the order given; `index` is the position within the destination (default: end).
 */
export function placeTopics(
  state: AgendaState,
  env: OpEnv,
  ids: string[],
  target: Target,
  index?: number,
  keepSection = false,
): OpResult<{ topics: Topic[]; booked: Session[] }> {
  if (!ids.length) throw invalid("No topics given.");
  if (ids.length > 100) throw invalid("Move at most 100 topics at a time.");
  if (new Set(ids).size !== ids.length) throw invalid("Each topic id may appear once.");
  let sessions = state.sessions;
  const moved: Topic[] = [];
  const booked: Session[] = [];
  for (const id of ids) {
    const placed = placeOne({ ...state, sessions }, env, id, target, keepSection);
    sessions = placed.sessions;
    if (placed.booked) booked.push(placed.booked);
    moved.push(placed.moved);
  }
  const topics = reorderManyInto(state.topics, moved, index);
  return {
    state: { ...state, sessions, topics },
    value: {
      topics: ids.map((id) => topics.find((t) => t.id === id)!),
      booked,
    },
  };
}

export function setTopicsCovered(
  state: AgendaState,
  env: OpEnv,
  ids: string[],
  covered: boolean,
): OpResult<Topic[]> {
  if (!ids.length) throw invalid("No topics given.");
  const set = new Set(ids);
  for (const id of set) topicOf(state, id);
  const topics = state.topics.map((t) =>
    !set.has(t.id)
      ? t
      : covered
        ? t.status === "covered"
          ? t
          : { ...t, status: "covered" as const, closedOn: env.today }
        : t.status === "open"
          ? t
          : { ...t, status: "open" as const, closedOn: undefined },
  );
  return { state: { ...state, topics }, value: ids.map((id) => topics.find((t) => t.id === id)!) };
}

export function deleteTopics(state: AgendaState, ids: string[]): OpResult<Topic[]> {
  if (!ids.length) throw invalid("No topics given.");
  const set = new Set(ids);
  const gone = [...set].map((id) => topicOf(state, id));
  return { state: { ...state, topics: state.topics.filter((t) => !set.has(t.id)) }, value: gone };
}

/**
 * Push open topics out of their occurrence into the next one (or a date you
 * name). The occurrence they leave keeps an honest ledger of what it didn't
 * cover, the count on the card goes up, and it says where it came from.
 * (`rollTopic` + `sweepReturns` in the store.)
 */
export function rollTopicsForward(
  state: AgendaState,
  env: OpEnv,
  ids: string[],
  toDate?: string,
): OpResult<{ topics: Topic[]; booked: Session[] }> {
  if (!ids.length) throw invalid("No topics given.");
  let cur = state;
  const booked: Session[] = [];
  for (const id of new Set(ids)) {
    const topic = topicOf(cur, id);
    if (topic.status !== "open") throw invalid(`"${topic.text}" is already ${topic.status}.`);
    // Rolling is leaving an occurrence behind. A topic still in the tray hasn't
    // been passed over, so counting it as carried would be a lie.
    const from = topic.sessionId ? cur.sessions.find((o) => o.id === topic.sessionId) : undefined;
    if (!from) {
      throw invalid(`"${topic.text}" isn't on an occurrence. Use move_topics to place it.`);
    }
    const meeting = cur.meetings.find((m) => m.id === from.meetingId);
    let nextSessionId: string | undefined;
    let sessions = cur.sessions;
    if (toDate) {
      if (!meeting) throw invalid("That topic isn't on a meeting, so it has no date to move to.");
      const at = ensureOccurrence(cur, env, meeting.id, toDate);
      sessions = at.sessions;
      if (at.booked) booked.push(sessions[sessions.length - 1]);
      nextSessionId = at.sessionId;
    } else if (meeting) {
      const slots = plannedSlots(meeting, cur.sessions, cur.topics, env.today);
      const next = nextSlotAfter(slots, topic.sessionId);
      if (next) {
        if (next.sessionId) nextSessionId = next.sessionId;
        else {
          nextSessionId = env.uid();
          sessions = [...sessions, { id: nextSessionId, meetingId: meeting.id, date: next.date }];
          booked.push(sessions[sessions.length - 1]);
        }
      }
    }
    sessions = sessions.map((o) =>
      o.id === from.id
        ? { ...o, uncovered: [...new Set([...(o.uncovered ?? []), topic.text])] }
        : o,
    );
    const rolled: Topic = {
      ...topic,
      status: "open",
      closedOn: undefined,
      sessionId: nextSessionId,
      // The count is the honest signal: a topic pushed three times is telling
      // you something a due date never would.
      carried: topic.carried + 1,
      carriedFrom: [...(topic.carriedFrom ?? []), from.id],
      returnedOn: env.today,
      returnedFromDate: from.date,
    };
    cur = { ...cur, sessions, topics: cur.topics.map((t) => (t.id === id ? rolled : t)) };
  }
  return {
    state: cur,
    value: { topics: ids.map((id) => cur.topics.find((t) => t.id === id)!), booked },
  };
}

/** A topic that keeps getting pushed is a commitment in disguise. */
export function promoteToFollowUp(
  state: AgendaState,
  env: OpEnv,
  topicId: string,
): OpResult<FollowUp> {
  const topic = topicOf(state, topicId);
  const meeting = topic.meetingId ? state.meetings.find((m) => m.id === topic.meetingId) : undefined;
  if (!meeting) throw invalid("That topic isn't on a meeting, so a follow-up has nothing to belong to.");
  const followUp: FollowUp = {
    id: env.uid(),
    subjectKind: meeting.subjectKind,
    subjectId: meeting.subjectId,
    meetingId: meeting.id,
    text: topic.text,
    status: "open",
    openedOn: env.today,
    sourceSessionId: topic.sessionId,
    order: state.followUps.length,
  };
  return {
    state: {
      ...state,
      followUps: [...state.followUps, followUp],
      topics: state.topics.map((t) =>
        t.id === topicId ? { ...t, status: "dropped" as const, closedOn: env.today } : t,
      ),
    },
    value: followUp,
  };
}

// ── Follow-ups ────────────────────────────────────────────────────────────

export function addFollowUp(
  state: AgendaState,
  env: OpEnv,
  input: { meetingId: string; text: string; private?: boolean },
): OpResult<FollowUp> {
  const meeting = meetingOf(state, input.meetingId);
  const followUp: FollowUp = {
    id: env.uid(),
    subjectKind: meeting.subjectKind,
    subjectId: meeting.subjectId,
    meetingId: meeting.id,
    text: trimmed(input.text, "Follow-up text", 500),
    status: "open",
    openedOn: env.today,
    order: state.followUps.length,
    private: input.private || undefined,
  };
  return { state: { ...state, followUps: [...state.followUps, followUp] }, value: followUp };
}

export function updateFollowUp(
  state: AgendaState,
  env: OpEnv,
  id: string,
  patch: { text?: string; done?: boolean },
): OpResult<FollowUp> {
  const f = state.followUps.find((x) => x.id === id);
  if (!f) throw notFound("follow-up", id);
  let next = f;
  if (patch.text !== undefined) next = { ...next, text: trimmed(patch.text, "Follow-up text", 500) };
  if (patch.done !== undefined && patch.done !== (f.status === "done")) {
    next = patch.done
      ? { ...next, status: "done", closedOn: env.today }
      : { ...next, status: "open", closedOn: undefined };
  }
  return {
    state: { ...state, followUps: state.followUps.map((x) => (x.id === id ? next : x)) },
    value: next,
  };
}

export function deleteFollowUp(state: AgendaState, id: string): OpResult<FollowUp> {
  const f = state.followUps.find((x) => x.id === id);
  if (!f) throw notFound("follow-up", id);
  return { state: { ...state, followUps: state.followUps.filter((x) => x.id !== id) }, value: f };
}

// ── Occurrences ───────────────────────────────────────────────────────────

/**
 * Re-anchor a meeting's weekday. Booked upcoming weeks move within their own
 * week (folding into a day that's already booked), exceptions follow the series,
 * and a stale one-off booking on the old day is dropped. (`setMeetingWeekday`.)
 */
export function setMeetingWeekday(
  state: AgendaState,
  env: OpEnv,
  meetingId: string,
  weekday: number | undefined,
): AgendaState {
  const meeting = meetingOf(state, meetingId);
  if (weekday !== undefined && !(Number.isInteger(weekday) && weekday >= 0 && weekday <= 6)) {
    throw invalid("Weekday is 0 (Sunday) to 6 (Saturday).");
  }
  const today = env.today;
  // A one-off booking on the old day would keep overriding the new one.
  const nextDate =
    weekday !== undefined &&
    meeting.nextDate &&
    meeting.nextDate >= today &&
    weekdayOf(meeting.nextDate) !== weekday
      ? undefined
      : meeting.nextDate;
  const meetings = state.meetings.map((m) =>
    m.id === meetingId ? { ...m, anchorWeekday: weekday, nextDate } : m,
  );
  if (weekday === undefined) return { ...state, meetings };

  // Only upcoming occurrences; a past meeting happened on the day it did. Moved
  // one-offs and extras are deliberate exceptions and stay put.
  const movable = state.sessions.filter(
    (o) =>
      o.meetingId === meetingId &&
      o.date >= today &&
      !o.kind &&
      !o.seriesDate &&
      weekdayOf(o.date) !== weekday,
  );
  const shift = (d: string) => {
    let next = addDays(d, weekday - weekdayOf(d));
    if (next < today) next = addDays(next, 7);
    return next;
  };
  // Exceptions name a series date; the series just moved, so follow it — a
  // skipped Monday becomes a skipped Tuesday, not a stray Tuesday meeting.
  let sessions = state.sessions.map((o) => {
    if (o.meetingId !== meetingId || !o.seriesDate || o.seriesDate < today) return o;
    const seriesDate = shift(o.seriesDate);
    if (seriesDate === o.seriesDate) return o;
    return o.kind === "skipped"
      ? { ...o, date: seriesDate, seriesDate }
      : { ...o, seriesDate: seriesDate === o.date ? undefined : seriesDate };
  });
  let topics = state.topics;
  for (const o of movable) {
    const date = shift(o.date);
    const clash = sessions.find((x) => x.meetingId === meetingId && x.id !== o.id && x.date === date);
    if (clash) {
      topics = topics.map((t) => (t.sessionId === o.id ? { ...t, sessionId: clash.id } : t));
      const extra = o.notes?.trim();
      sessions = sessions
        .filter((x) => x.id !== o.id)
        .map((x) =>
          x.id === clash.id && extra && extra !== x.notes?.trim()
            ? { ...x, notes: [x.notes?.trim(), extra].filter(Boolean).join("\n\n") }
            : x,
        );
    } else {
      sessions = sessions.map((x) => (x.id === o.id ? { ...x, date } : x));
    }
  }
  return { ...state, meetings, sessions, topics };
}

/**
 * Move one occurrence to another day (`this`), or move the whole series to the
 * weekday of `to` (`series`). Topics ride along; landing on a day that already
 * has a meeting folds the two together. (`moveOccurrence` in the store.)
 */
export function moveOccurrence(
  state: AgendaState,
  env: OpEnv,
  meetingId: string,
  fromDate: string,
  to: string,
  scope: "this" | "series",
): OpResult<{ sessionId: string; folded: boolean }> {
  meetingOf(state, meetingId);
  if (!isISODate(to)) throw invalid(`"${to}" isn't a date (use YYYY-MM-DD).`);
  if (fromDate < env.today) throw invalid("That occurrence already happened, so it can't be moved.");
  if (to < env.today) throw invalid(`${to} is in the past.`);
  if (skippedOn(state, meetingId, to)) {
    throw new OpError("conflict", `${to} is a skipped week. Restore it first, or pick another date.`);
  }
  let from = occurrenceRef(state, env, meetingId, fromDate);
  let cur = state;

  if (scope === "series") {
    const weekday = weekdayOf(to);
    cur = setMeetingWeekday(cur, env, meetingId, weekday);
    // Re-anchoring carries booked weeks along within their week. When that
    // already put this occurrence on the requested day, we're done.
    const landed = cur.sessions.find(
      (o) => o.meetingId === meetingId && o.date === to && o.kind !== "skipped",
    );
    if (landed) return { state: cur, value: { sessionId: landed.id, folded: false } };
    let sameWeek = addDays(from.date, weekday - weekdayOf(from.date));
    if (sameWeek < env.today) sameWeek = addDays(sameWeek, 7);
    if (!from.sessionId && sameWeek === to) {
      // The new rhythm draws this date itself; just make it real.
      const id = env.uid();
      return {
        state: { ...cur, sessions: [...cur.sessions, { id, meetingId, date: to }] },
        value: { sessionId: id, folded: false },
      };
    }
    // Otherwise it was asked to go to a different week as well: fall through
    // and move this one on top of the new rhythm.
    if (from.sessionId) {
      const moved = cur.sessions.find((o) => o.id === from.sessionId);
      if (moved) from = { sessionId: moved.id, date: moved.date };
    } else {
      from = { sessionId: null, date: sameWeek };
    }
  }

  let { sessions, topics } = cur;
  const current = from.sessionId
    ? sessions.find((o) => o.id === from.sessionId)
    : sessions.find((o) => o.meetingId === meetingId && o.date === from.date && o.kind !== "skipped");
  const seriesDate =
    current?.kind === "extra" ? undefined : (current?.seriesDate ?? current?.date ?? from.date);
  const clash = sessions.find(
    (o) => o.meetingId === meetingId && o.date === to && o.kind !== "skipped" && o.id !== current?.id,
  );
  if (clash) {
    // Something is already on that day: the two become one meeting.
    if (current) {
      topics = topics.map((t) => (t.sessionId === current.id ? { ...t, sessionId: clash.id } : t));
      // Keep any prep written on the one being folded in.
      const extra = current.notes?.trim();
      sessions = sessions
        .filter((o) => o.id !== current.id)
        .map((o) =>
          o.id === clash.id && extra && extra !== o.notes?.trim()
            ? { ...o, notes: [o.notes?.trim(), extra].filter(Boolean).join("\n\n") }
            : o,
        );
    }
    return { state: { ...cur, sessions, topics }, value: { sessionId: clash.id, folded: Boolean(current) } };
  }
  const fields = { date: to, seriesDate: seriesDate && seriesDate !== to ? seriesDate : undefined };
  let sessionId: string;
  if (current) {
    sessions = sessions.map((o) => (o.id === current.id ? { ...o, ...fields } : o));
    sessionId = current.id;
  } else {
    sessionId = env.uid();
    sessions = [...sessions, { id: sessionId, meetingId, ...fields }];
  }
  return { state: { ...cur, sessions, topics }, value: { sessionId, folded: false } };
}

/**
 * This week isn't happening. Anything planned for it goes back to the backlog
 * (not lost), and the series date stays held so the rhythm doesn't redraw it.
 * A one-off simply disappears. (`skipOccurrence`.)
 */
export function skipOccurrence(
  state: AgendaState,
  env: OpEnv,
  meetingId: string,
  date: string,
): OpResult<{ returnedToBacklog: Topic[] }> {
  const from = occurrenceRef(state, env, meetingId, date);
  const current = from.sessionId ? state.sessions.find((o) => o.id === from.sessionId) : undefined;
  // A past meeting that was written up happened. Nothing to skip.
  if (current?.notes?.trim() && current.date < env.today) {
    throw invalid("That meeting already happened and was written up, so it can't be skipped.");
  }
  const bumped = current ? state.topics.filter((t) => t.sessionId === current.id) : [];
  const topics = current
    ? state.topics.map((t) =>
        t.sessionId === current.id ? { ...t, sessionId: undefined, lane: "backlog" as const } : t,
      )
    : state.topics;
  if (current?.kind === "extra") {
    return {
      state: { ...state, topics, sessions: state.sessions.filter((o) => o.id !== current.id) },
      value: { returnedToBacklog: bumped },
    };
  }
  const seriesDate = current?.seriesDate ?? current?.date ?? from.date;
  const skipped = { date: seriesDate, seriesDate, kind: "skipped" as const };
  return {
    state: {
      ...state,
      topics,
      sessions: current
        ? state.sessions.map((o) => (o.id === current.id ? { ...o, ...skipped } : o))
        : [...state.sessions, { id: env.uid(), meetingId, ...skipped }],
    },
    value: { returnedToBacklog: bumped },
  };
}

/** Undo a skip, or send a moved meeting back to its place in the series. */
export function restoreOccurrence(
  state: AgendaState,
  meetingId: string,
  date: string,
): OpResult<{ restored: "skip" | "move" }> {
  const o = state.sessions.find(
    (x) =>
      x.meetingId === meetingId &&
      (x.date === date || (x.kind === "skipped" && (x.seriesDate ?? x.date) === date)),
  );
  if (!o) throw new OpError("not_found", `This meeting has no occurrence on ${date}.`);
  if (o.kind === "skipped") {
    return { state: { ...state, sessions: state.sessions.filter((x) => x.id !== o.id) }, value: { restored: "skip" } };
  }
  if (!o.seriesDate) throw invalid("That occurrence is on its normal day; nothing to restore.");
  const clash = state.sessions.find(
    (x) => x.meetingId === o.meetingId && x.date === o.seriesDate && x.id !== o.id,
  );
  if (clash) throw new OpError("conflict", `Its normal day (${o.seriesDate}) already has a meeting.`);
  return {
    state: {
      ...state,
      sessions: state.sessions.map((x) =>
        x.id === o.id ? { ...x, date: o.seriesDate!, seriesDate: undefined } : x,
      ),
    },
    value: { restored: "move" },
  };
}

/** A one-off meeting outside the rhythm. */
export function addExtraOccurrence(
  state: AgendaState,
  env: OpEnv,
  meetingId: string,
  date: string,
): OpResult<{ sessionId: string; created: boolean }> {
  meetingOf(state, meetingId);
  if (!isISODate(date)) throw invalid(`"${date}" isn't a date (use YYYY-MM-DD).`);
  if (date < env.today) throw invalid(`${date} is in the past.`);
  const existing = liveOn(state, meetingId, date);
  if (existing) return { state, value: { sessionId: existing.id, created: false } };
  const id = env.uid();
  return {
    state: { ...state, sessions: [...state.sessions, { id, meetingId, date, kind: "extra" }] },
    value: { sessionId: id, created: true },
  };
}

/** Set the occurrence's one-line purpose, and/or append to its prep notes. */
export function updateOccurrence(
  state: AgendaState,
  env: OpEnv,
  meetingId: string,
  date: string,
  patch: { point?: string | null; appendNotes?: string },
): OpResult<Session> {
  const at = ensureOccurrence(state, env, meetingId, date);
  const base = at.sessions.find((o) => o.id === at.sessionId)!;
  let next = base;
  if (patch.point !== undefined) {
    next = { ...next, point: patch.point === null ? undefined : trimmed(patch.point, "Point", 300) };
  }
  if (patch.appendNotes !== undefined) {
    const add = trimmed(patch.appendNotes, "Notes", 5000);
    next = { ...next, notes: [next.notes?.trim(), add].filter(Boolean).join("\n\n") };
  }
  return {
    state: { ...state, sessions: at.sessions.map((o) => (o.id === next.id ? next : o)) },
    value: next,
  };
}

// ── Meetings ──────────────────────────────────────────────────────────────

export type MeetingPatch = {
  name?: string | null;
  rhythm?: MeetingRhythm;
  floorDays?: number | null;
  anchorWeekday?: number | null;
  nextDate?: string | null;
  trackerUrl?: string | null;
  trackerName?: string | null;
  coverageTargets?: CoverageTarget[];
};

const RHYTHMS: MeetingRhythm[] = ["weekly", "biweekly", "monthly", "quarterly", "as_needed"];

export function updateMeeting(
  state: AgendaState,
  env: OpEnv,
  id: string,
  patch: MeetingPatch,
): OpResult<TrackedMeeting> {
  let cur = state;
  meetingOf(cur, id);
  if (patch.rhythm !== undefined && !RHYTHMS.includes(patch.rhythm)) {
    throw invalid(`Rhythm must be one of ${RHYTHMS.join(", ")}.`);
  }
  if (patch.floorDays != null && !(Number.isInteger(patch.floorDays) && patch.floorDays > 0)) {
    throw invalid("floorDays must be a positive whole number of days.");
  }
  if (patch.nextDate != null) {
    if (!isISODate(patch.nextDate)) throw invalid(`"${patch.nextDate}" isn't a date (use YYYY-MM-DD).`);
    if (patch.nextDate < env.today) throw invalid("The next meeting can't be in the past.");
  }
  if (patch.coverageTargets) {
    const tags = new Set(cur.tags.map((t) => t.id));
    for (const c of patch.coverageTargets) {
      if (!tags.has(c.tagId)) throw invalid(`Unknown tag id "${c.tagId}" in coverage targets.`);
      if (!(Number.isInteger(c.everyNOccurrences) && c.everyNOccurrences > 0)) {
        throw invalid("Coverage targets need a positive whole 'every N occurrences'.");
      }
    }
  }
  // Moving the weekday carries booked weeks with it; do that first so the
  // plain field updates below apply on top of the re-anchored meeting.
  if (patch.anchorWeekday !== undefined) {
    cur = setMeetingWeekday(cur, env, id, patch.anchorWeekday ?? undefined);
  }
  const before = meetingOf(cur, id);
  const next: TrackedMeeting = { ...before };
  if (patch.name !== undefined) next.name = patch.name?.trim() || undefined;
  if (patch.rhythm !== undefined) next.rhythm = patch.rhythm;
  if (patch.floorDays !== undefined) next.floorDays = patch.floorDays ?? undefined;
  if (patch.nextDate !== undefined) next.nextDate = patch.nextDate ?? undefined;
  if (patch.trackerUrl !== undefined) next.trackerUrl = patch.trackerUrl?.trim() || undefined;
  if (patch.trackerName !== undefined) next.trackerName = patch.trackerName?.trim() || undefined;
  if (patch.coverageTargets !== undefined) {
    next.coverageTargets = patch.coverageTargets.length ? patch.coverageTargets : undefined;
  }
  return {
    state: { ...cur, meetings: cur.meetings.map((m) => (m.id === id ? next : m)) },
    value: next,
  };
}

/**
 * A new meeting with someone already in the workspace. Always a new one: a 1:1
 * and a career check-in with the same person are two things to be ready for.
 */
export function createMeeting(
  state: AgendaState,
  env: OpEnv,
  input: {
    subjectKind: TrackedMeeting["subjectKind"];
    subjectId: string;
    name?: string;
    rhythm?: MeetingRhythm;
    anchorWeekday?: number;
    nextDate?: string;
    role?: TrackedMeeting["role"];
  },
): OpResult<TrackedMeeting> {
  if (input.anchorWeekday !== undefined && (!Number.isInteger(input.anchorWeekday) || input.anchorWeekday < 0 || input.anchorWeekday > 6)) {
    throw invalid("Weekday is 0 (Sunday) to 6 (Saturday).");
  }
  if (input.nextDate !== undefined && !isISODate(input.nextDate)) {
    throw invalid(`"${input.nextDate}" isn't a date (use YYYY-MM-DD).`);
  }
  const meeting: TrackedMeeting = {
    id: env.uid(),
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    rhythm: input.rhythm ?? "weekly",
    ...(input.name?.trim() ? { name: trimmed(input.name, "Meeting name", 80) } : {}),
    ...(input.anchorWeekday !== undefined ? { anchorWeekday: input.anchorWeekday } : {}),
    ...(input.nextDate ? { nextDate: input.nextDate } : {}),
    ...(input.role ? { role: input.role } : {}),
  };
  return { state: { ...state, meetings: [...state.meetings, meeting] }, value: meeting };
}

export type SectionInput = { id?: string; label: string; minutes?: number };

/**
 * Set a meeting's standing agenda (its sections) in one go, in order. Sections
 * that keep an id keep their tag and topics; new ones get a tag of the same
 * name (found, or made); dropped ones release their topics back to "untagged".
 * (`setCurriculum` + `addMeetingRow` in the store.)
 */
export function setSections(
  state: AgendaState,
  env: OpEnv,
  meetingId: string,
  sections: SectionInput[],
): OpResult<CurriculumSlot[]> {
  const meeting = meetingOf(state, meetingId);
  if (sections.length > 20) throw invalid("At most 20 sections.");
  const existing = new Map((meeting.curriculum ?? []).map((c) => [c.id, c] as const));
  let cur = state;
  const out: CurriculumSlot[] = [];
  const seen = new Set<string>();
  for (const input of sections) {
    const label = trimmed(input.label, "Section label", 60);
    if (input.minutes !== undefined && !(Number.isInteger(input.minutes) && input.minutes > 0 && input.minutes <= 480)) {
      throw invalid("Section minutes must be a whole number from 1 to 480.");
    }
    if (input.id) {
      const prev = existing.get(input.id);
      if (!prev) throw invalid(`This meeting has no section "${input.id}".`, { sections: [...existing.values()] });
      if (seen.has(input.id)) throw invalid(`Section "${input.id}" is listed twice.`);
      seen.add(input.id);
      out.push({ ...prev, label, minutes: input.minutes ?? prev.minutes });
      continue;
    }
    const lower = label.toLowerCase();
    if (out.some((s) => s.label.trim().toLowerCase() === lower)) {
      throw invalid(`There are two sections called "${label}".`);
    }
    const tag = createTag(cur, env, label);
    cur = tag.state;
    out.push({ id: env.uid(), label, tagId: tag.value.id, ...(input.minutes ? { minutes: input.minutes } : {}) });
  }
  const keep = new Set(out.map((s) => s.id));
  const fresh = out.filter((s) => !existing.has(s.id));
  const next: TrackedMeeting = { ...meeting, curriculum: out.length ? out : undefined };
  return {
    state: {
      ...cur,
      meetings: cur.meetings.map((m) => (m.id === meetingId ? next : m)),
      topics: cur.topics.map((t) => {
        if (t.meetingId !== meetingId) return t;
        if (t.slotId && !keep.has(t.slotId)) return { ...t, slotId: undefined };
        // Already tagged this? Then it already belongs in the new row.
        const home = !t.slotId && fresh.find((s) => s.tagId && t.tagIds.includes(s.tagId));
        return home ? { ...t, slotId: home.id } : t;
      }),
    },
    value: out,
  };
}
