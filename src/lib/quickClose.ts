/**
 * Quick close: file a meeting that wasn't recorded, without an AI wrap-up.
 *
 * The wrap-up (`src/lib/wrapUp.ts`) needs a transcript or notes. This is the
 * 30-second path when there aren't any: each open topic is Covered, rolled
 * to next week, or Parked, and the occurrence gets a short write-up so it
 * leaves Loose end. Reuses the agenda ops the store already runs — no schema
 * change, no model call.
 *
 * The UI is gated by the `quickClose` flag (`src/lib/flags.ts`). This module
 * is the behaviour; it does not read the flag itself so tests can pin both
 * sides.
 */

import type { Session, Topic } from "../types";
import {
  placeTopics,
  rollTopicsForward,
  setTopicsCovered,
  type AgendaState,
  type OpEnv,
} from "./agendaOps";
import { heldSessions, sessionsFor, type Readiness } from "./readiness";

export type TopicDisposition = "covered" | "next_week" | "park";

export const DISPOSITIONS: { id: TopicDisposition; label: string }[] = [
  { id: "covered", label: "Covered" },
  { id: "next_week", label: "Next week" },
  { id: "park", label: "Park" },
];

/** Default: we didn't record it, so don't claim it was covered. */
export const DEFAULT_DISPOSITION: TopicDisposition = "next_week";

export type QuickCloseTarget = {
  meetingId: string;
  sessionId: string;
  date: string;
  title: string;
};

/**
 * The occurrence a Loose-end meeting needs written up, or null. Flag-off
 * callers pass `false` and always get null — that's how Today, ⌘K and the
 * Meetings row stay identical with the flag down.
 */
export function quickCloseAvailable(
  flag: boolean,
  reading: Readiness,
): string | null {
  if (!flag) return null;
  if (reading.state !== "loose_end") return null;
  return reading.checks.find((c) => c.id === "writeUp" && !c.done)?.sessionId ?? null;
}

/** ⌘K rows for Loose-end meetings. Empty when the flag is off. */
export function quickCloseCommands(
  flag: boolean,
  rows: { meetingId: string; title: string; readiness: Readiness }[],
): QuickCloseTarget[] {
  if (!flag) return [];
  const out: QuickCloseTarget[] = [];
  for (const row of rows) {
    const sessionId = quickCloseAvailable(true, row.readiness);
    if (!sessionId) continue;
    out.push({
      meetingId: row.meetingId,
      sessionId,
      date: row.readiness.lastMet ?? "",
      title: row.title,
    });
  }
  return out;
}

/**
 * Open topics Quick close should ask about: still on this occurrence, or
 * already rolled out of it (sweep-on-load) and still open.
 */
export function quickCloseTopics(topics: Topic[], sessionId: string): Topic[] {
  return topics
    .filter(
      (t) =>
        t.status === "open" &&
        (t.sessionId === sessionId || (t.carriedFrom ?? []).includes(sessionId)),
    )
    .sort((a, b) => a.order - b.order);
}

/** The last held occurrence of a meeting, if any. */
export function lastHeldSession(
  sessions: Session[],
  meetingId: string,
  today: string,
): Session | null {
  const past = heldSessions(sessionsFor(meetingId, sessions)).filter((s) => s.date <= today);
  return past.length ? past[past.length - 1] : null;
}

export type QuickCloseInput = {
  sessionId: string;
  dispositions: Record<string, TopicDisposition>;
  /** Leader's own notes, if any. Always kept; a ledger of dispositions is appended. */
  notes?: string;
};

/**
 * Apply Covered / Next week / Park and write the occurrence so it leaves
 * Loose end. Topics already sitting on a later week are left there when
 * the choice is Next week — rolling them again would skip a week.
 */
export function applyQuickClose(
  state: AgendaState,
  env: OpEnv,
  input: QuickCloseInput,
): AgendaState {
  const session = state.sessions.find((o) => o.id === input.sessionId);
  if (!session) throw new Error(`No occurrence "${input.sessionId}" to close.`);

  const asked = quickCloseTopics(state.topics, input.sessionId);
  const covered: string[] = [];
  const roll: string[] = [];
  const park: string[] = [];
  for (const topic of asked) {
    const choice = input.dispositions[topic.id] ?? DEFAULT_DISPOSITION;
    if (choice === "covered") covered.push(topic.id);
    else if (choice === "park") park.push(topic.id);
    else if (topic.sessionId === input.sessionId) roll.push(topic.id);
  }

  let next = state;
  if (covered.length) next = setTopicsCovered(next, env, covered, true).state;
  if (roll.length) next = rollTopicsForward(next, env, roll).state;
  if (park.length) next = placeTopics(next, env, park, { kind: "lane", lane: "parked" }).state;

  const record = closeRecord(asked, input.dispositions, input.notes);
  return {
    ...next,
    sessions: next.sessions.map((o) => (o.id === input.sessionId ? { ...o, notes: record } : o)),
  };
}

/** The write-up Quick close files: the leader's notes, then what happened to each topic. */
export function closeRecord(
  topics: Topic[],
  dispositions: Record<string, TopicDisposition>,
  notes?: string,
): string {
  const groups: { label: string; ids: TopicDisposition }[] = [
    { label: "Covered", ids: "covered" },
    { label: "Next week", ids: "next_week" },
    { label: "Parked", ids: "park" },
  ];
  const lines: string[] = [];
  for (const g of groups) {
    const items = topics.filter((t) => (dispositions[t.id] ?? DEFAULT_DISPOSITION) === g.ids);
    if (!items.length) continue;
    lines.push(`## ${g.label}`, ...items.map((t) => `- ${t.text}`), "");
  }
  const ledger = lines.join("\n").trim();
  const own = notes?.trim() ?? "";
  if (own && ledger) return `${own}\n\n${ledger}`;
  if (own) return own;
  if (ledger) return `Closed without a recording.\n\n${ledger}`;
  return "Closed without a recording.";
}
