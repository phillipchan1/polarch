import { create } from "zustand";
import type {
  Action,
  ActionColumn,
  Arc,
  Fixture,
  FollowUp,
  GlossaryTerm,
  KnowledgeItem,
  KnowledgeKind,
  MeetingShare,
  ChatMessage,
  Domain,
  Goal,
  HealthLevel,
  Manager,
  Me,
  Note,
  Prayer,
  PrayerEntry,
  PrayerEntryKind,
  PrayerSubjectKind,
  Session,
  Person,
  Team,
  TeamAction,
  Tag,
  Topic,
  TopicLane,
  TrackedMeeting,
  MeetingRhythm,
  MeetingSubjectKind,
  TeamGoal,
  LeadUpProfile,
  Win,
} from "../types";
import { storage } from "../lib/storage";
import { todayISO, type HealthFilterValue } from "../lib/health";
import type { ColumnTarget } from "../lib/topics";
import {
  findMeeting,
  findTag,
  parseCapture,
  reorderInto,
  reorderManyInto,
  splitCaptureLines,
} from "../lib/ideas";
import type { PrayerFilterValue } from "../lib/prayer";
import type { TreeMode } from "../lib/treeMode";
import { isDescendant, personDomainId } from "../lib/teams";
import { getSession, hydrateAuth, onAuthChange, signOut as authSignOut } from "../lib/auth";
import * as repo from "../lib/repo";
import type { NodePosition, PersistedData } from "../lib/repo";
import { clearDoc, loadDoc, saveDoc } from "../lib/docCache";
import { clearIndex } from "../lib/search";
import { clearRecents } from "../lib/recents";
import { clearUndo } from "../lib/undo";
import { migratePigments } from "../lib/pigments";
import { toast } from "../lib/toasts";
import { emptyMe } from "../lib/repo";
import { DEMO, toThisWeek } from "../lib/demo";
import { pushBackPlan } from "../lib/pushBack";
import {
  liveArcs,
  markStep,
  practiceText,
  sharedNoteId,
  takeawayId,
  unmarkStep,
  type StepMark,
} from "../lib/arcs";
import * as sharesApi from "../lib/shares";
import { meetingSlugs, resolveMeetingKey } from "../lib/slugs";
import {
  defaultCurriculum,
  effectiveSlotId,
  nextSlotAfter,
  plannedSlots,
} from "../lib/topics";
import { flagFromEnv, flagOn } from "../lib/flags";
import { applyOccurrence, sameDateReuseFor } from "../lib/occurrenceGuard";
import {
  applyQuickClose,
  type TopicDisposition,
} from "../lib/quickClose";
import {
  capUp,
  seedActions,
  seedCapacities,
  seedFollowUps,
  seedArcs,
  seedTakeaways,
  seedFixtures,
  seedGlossary,
  seedKnowledge,
  seedMeetings,
  seedDomains,
  seedGoals,
  seedManagers,
  seedMe,
  seedNotes,
  seedPrayers,
  seedSessions,
  seedPeople,
  seedTags,
  seedTopics,
  seedTeamActions,
  seedTeamGoals,
  seedTeamNotes,
  seedTeams,
  seedWins,
} from "../data/seed";

import {
  DEFAULT_TAB,
  routePath,
  setMeetingSlugResolver,
  type Route,
  type Selection,
  type Tab,
} from "../lib/routes";

export type { Tab, Selection } from "../lib/routes";

import { NO_TRAIL, type Trail } from "../lib/navTrail";

/**
 * Selection lives in the URL, not in this store — the setters below navigate,
 * and `applyRoute` writes the result back. The router installs this at mount.
 */
export type Navigator = {
  go: (path: string, opts?: { replace?: boolean; opener?: boolean }) => void;
  /**
   * Leave by walking `steps` entries back through history. With none to walk
   * (or when popping can't be trusted) it replaces this entry with `to`.
   */
  pop: (steps: number, to: string) => void;
  /** Where the entry we're on was opened from. */
  trail: () => Trail;
};
let nav: Navigator | null = null;

export function setNavigate(next: Navigator | null) {
  nav = next;
}

function go(path: string, opts?: { replace?: boolean; opener?: boolean }) {
  // Before the router mounts (or in tests) fall back to a plain URL write so a
  // selection is never silently dropped.
  if (nav) nav.go(path, opts);
  else if (typeof window !== "undefined")
    window.history.replaceState({}, "", path);
}

export type { NodePosition, PersistedData } from "../lib/repo";

/** Auth/loading lifecycle for the whole app. */
/**
 * "anon" means *not signed in*. A failed load is "error" — conflating the two
 * signed people out whenever they went through a tunnel.
 */
export type Phase = "loading" | "anon" | "ready" | "error";

/** Whether the last write to the cloud landed. Surfaced in the app chrome. */
export type SyncStatus = "idle" | "saving" | "error";

export type ModalState =
  | { kind: "team"; team?: Team; parentId?: string; leaderId?: string }
  /** `teamId: null` = add them as a direct report, with no team at all. */
  | { kind: "person"; person?: Person; teamId?: string | null }
  | { kind: "manager"; manager?: Manager }
  | { kind: "domains" }
  | { kind: "triage" }
  /** Capture anywhere: a topic, or a person, team or leader. `draft` prefills
      the field — "@sarah " when capture starts from Sarah's meeting. */
  | { kind: "capture"; draft?: string }
  /** File an unrecorded occurrence. Only opened when `quickClose` is on. */
  | { kind: "quickClose"; sessionId: string }
  | null;

type UIState = {
  /** Auth/loading phase. UI renders the app only when "ready". */
  phase: Phase;
  /** Why the load failed, shown on the error screen. */
  loadError: string | null;
  /** Whether pending edits have reached the cloud. */
  syncStatus: SyncStatus;
  /** Signed-in user id (Supabase auth uid) — the RLS scope for all data. */
  userId: string | null;
  /** Signed-in user's email, for the account menu. */
  userEmail: string | null;
  tab: Tab;
  /** null = show every domain on one canvas; otherwise filter the tree. */
  treeDomainId: string | null;
  /**
   * Health levels being scanned for, shared by the canvas and the table —
   * that's what makes them two views of one question rather than two filters
   * to keep in sync. Empty = everything. The canvas dims what doesn't match
   * (the shape of the org is the point there); the table drops the rows.
   */
  healthScan: HealthFilterValue[];
  /**
   * The prayer scan, shared by the canvas and the table for the same reason
   * the health scan is. Empty = everything; otherwise the surfaces answer
   * "who am I carrying" the same way in both places.
   */
  prayerScan: PrayerFilterValue[];
  /**
   * What I came to the chart to do. The only card control there is — the layer
   * set, the scan bar and what dims all follow from it (see lib/treeMode.ts).
   */
  treeMode: TreeMode;
  selectedPersonId: string | null;
  selectedTeamId: string | null;
  /** Side panel open for a manager I report to (leading-up profile). */
  selectedManagerId: string | null;
  /** Open on one recurring meeting — its planner, notes or settings. */
  selectedMeetingId: string | null;
  /** Side panel open for the signed-in leader's own profile. */
  selectedMe: boolean;
  /** True when the selected entity is on its full-page focus route. */
  focused: boolean;
  /** Sub-page of the selected entity — a person's tab, a team's section. */
  section: string | null;
  /** Full-screen session editor — when set, SessionEditorView takes over. */
  sessionId: string | null;
  collapsedTeams: string[];
  dark: boolean;
  /** Entity panel width beside the canvas, as a percentage of the split. */
  panelPct: number;
  modal: ModalState;
  settingsOpen: boolean;
  /** ⌘K. Lives in the store so any surface can open it, and the palette itself
      can be reached from the ? panel and vice versa. */
  paletteOpen: boolean;
  /** The ? shortcuts sheet. */
  helpOpen: boolean;
  /**
   * Who my meetings are shared with. Held by the server, outside the synced
   * document — a share is a capability, not a row the client may write.
   */
  shares: MeetingShare[];
  /** Meetings other people have shared with me (by my email). */
  sharedWithMe: sharesApi.SharedWithMe[];
};

type Store = PersistedData &
  UIState & {
    // ui
    setTab: (tab: Tab) => void;
    /**
     * Go to a tab with nothing open. `setTab` keeps the open entity as a peek,
     * and `clearSelection()` then `setTab()` doesn't drop it: the first only
     * starts a navigation, so the second still reads the old selection and
     * puts it straight back.
     */
    goToTab: (tab: Tab) => void;
    setTreeDomainId: (id: string | null) => void;
    /** Add/remove one health level from the canvas scan. */
    toggleHealthScan: (value: HealthFilterValue) => void;
    /** Scan for a specific set of levels (or clear it with []). */
    setHealthScan: (values: HealthFilterValue[]) => void;
    /** Add/remove one prayer state from the canvas scan. */
    togglePrayerScan: (value: PrayerFilterValue) => void;
    /** Scan for a specific set of prayer states (or clear it with []). */
    setPrayerScan: (values: PrayerFilterValue[]) => void;
    setTreeMode: (mode: TreeMode) => void;
    /**
     * Open someone. The optional section lands you on one of their tabs — the
     * canvas uses it to send a prayer mark straight to the prayer tab rather
     * than to the top of a profile you then have to navigate.
     */
    selectPerson: (id: string | null, section?: string) => void;
    selectTeam: (id: string | null, section?: string) => void;
    selectManager: (id: string | null, section?: string) => void;
    /** Open one recurring meeting — the planner unless told otherwise. */
    selectMeeting: (id: string | null, section?: string) => void;
    selectMe: (open: boolean) => void;
    /** Open my own profile as a full page. */
    openMe: () => void;
    /**
     * Close whatever is open and return to the page it was opened from — the
     * same destination as Back, X and Esc, which all call this.
     */
    clearSelection: () => void;
    /** Page to a sibling of the same kind, keeping the section. */
    pageTo: (id: string) => void;
    /** Switch the selected entity's sub-page (person tab, team section). */
    setSection: (section: string | null) => void;
    /** Open the full-screen session editor (promotes to focus). */
    openSession: (sessionId: string) => void;
    /** Close the session editor, returning to the page it was opened from. */
    closeSession: () => void;
    /** Promote the current peek to its full-page focus route. */
    openFocus: () => void;
    /** Demote the focused entity back to a peek beside the canvas. */
    closeFocus: () => void;
    /** Write a parsed URL into selection state. Called only by the router. */
    applyRoute: (route: Route) => void;
    toggleTeamCollapsed: (teamId: string) => void;
    toggleDark: () => void;
    /** Resize the entity panel. Clamped and remembered across sessions. */
    setPanelPct: (pct: number) => void;
    setPaletteOpen: (open: boolean) => void;
    setHelpOpen: (open: boolean) => void;
    openModal: (modal: NonNullable<ModalState>) => void;
    closeModal: () => void;
    // canvas
    setNodePosition: (id: string, pos: NodePosition) => void;
    resetLayout: () => void;
    // me
    updateMe: (patch: Partial<Me>) => void;
    // domains (life areas)
    addDomain: (domain: Omit<Domain, "id">) => string;
    updateDomain: (id: string, patch: Partial<Domain>) => void;
    deleteDomain: (id: string) => void;
    // managers (people I report to, above me)
    addManager: (manager: Omit<Manager, "id">) => void;
    updateManager: (id: string, patch: Partial<Manager>) => void;
    /** Merge a patch into a manager's leading-up operating manual. */
    updateManagerLeadUp: (id: string, patch: Partial<LeadUpProfile>) => void;
    deleteManager: (id: string) => void;
    // health — my own read on a team or a person
    /** Set (or clear, with null) the health level. Stamps today's date. */
    setHealth: (
      kind: "team" | "person",
      id: string,
      level: HealthLevel | null
    ) => void;
    /** Edit the one-line evidence behind an existing health call. */
    setHealthNote: (kind: "team" | "person", id: string, note: string) => void;
    // prayer — who I'm carrying, and the log of what for
    /**
     * Take someone up in prayer, or lay them down. Taking up stamps the date
     * it started; laying down clears the mark but never the log — what you
     * prayed and what was answered outlives the season you prayed it in.
     */
    setPrayer: (
      kind: PrayerSubjectKind,
      id: string,
      carrying: boolean
    ) => void;
    /** The one line of what I'm holding for them. */
    setPrayerFocus: (
      kind: PrayerSubjectKind,
      id: string,
      focus: string
    ) => void;
    /** Mark that I prayed. Counts once a day — twice is still once. */
    markPrayed: (kind: PrayerSubjectKind, id: string) => void;
    /**
     * Write something down. Starts carrying the subject if they weren't
     * already: writing a burden for someone is the decision.
     */
    addPrayerEntry: (
      kind: PrayerSubjectKind,
      subjectId: string,
      text: string,
      entryKind?: PrayerEntryKind
    ) => string;
    updatePrayerEntry: (
      id: string,
      patch: Partial<Pick<PrayerEntry, "text" | "kind" | "date">>
    ) => void;
    /** Answered — a transition with a date, not a deletion. */
    answerPrayerEntry: (id: string, note?: string) => void;
    /** Reopen: it wasn't answered after all, or it's back. */
    reopenPrayerEntry: (id: string) => void;
    deletePrayerEntry: (id: string) => void;
    // teams
    addTeam: (team: Omit<Team, "id" | "order">) => void;
    updateTeam: (id: string, patch: Partial<Team>) => void;
    deleteTeam: (id: string) => void;
    // team-level records
    addTeamAction: (teamId: string, text: string, dueDate?: string) => void;
    updateTeamAction: (id: string, patch: Partial<Pick<TeamAction, "text" | "dueDate" | "done">>) => void;
    toggleTeamAction: (id: string) => void;
    deleteTeamAction: (id: string) => void;
    /**
     * Put a deleted record back exactly as it was, id and all — the other half
     * of an Undo toast (see `deleteWithUndo`).
     *
     * Deliberately not `add*`: those mint a new id and a fresh `order`, which
     * would break every reference to the record and move it in its list. Undo
     * has to mean "that didn't happen", not "here's a similar one".
     */
    restoreTeamAction: (action: TeamAction) => void;
    addTeamGoal: (teamId: string, title: string) => void;
    updateTeamGoal: (id: string, patch: Partial<TeamGoal>) => void;
    deleteTeamGoal: (id: string) => void;
    /** See `restoreTeamAction`. */
    restoreTeamGoal: (goal: TeamGoal) => void;
    addTeamNote: (teamId: string, body: string) => void;
    deleteTeamNote: (id: string) => void;
    // people
    addPerson: (person: Omit<Person, "id" | "assessments" | "strengths" | "watchOuts"> & Partial<Person>) => string;
    updatePerson: (id: string, patch: Partial<Person>) => void;
    /** Merge a patch into a person's leading-up operating manual. */
    updateLeadUp: (personId: string, patch: Partial<LeadUpProfile>) => void;
    deletePerson: (id: string) => void;
    /**
     * Reorg seam: move a person to another team (future drag-and-drop calls
     * this). Undefined pulls them out of every team — a direct report of mine.
     */
    movePerson: (personId: string, teamId?: string) => void;
    // per-person records
    addAction: (
      personId: string,
      text: string,
      dueDate?: string,
      column?: ActionColumn
    ) => void;
    updateAction: (
      id: string,
      patch: Partial<Pick<Action, "text" | "dueDate" | "done" | "column">>
    ) => void;
    setActionColumn: (id: string, column: ActionColumn) => void;
    toggleAction: (id: string) => void;
    deleteAction: (id: string) => void;
    // topic boards — what there is to talk about, keyed by meeting
    addTopic: (
      meetingId: string,
      text: string,
      opts?: {
        lane?: TopicLane;
        sessionId?: string;
        dueDate?: string;
        slotId?: string;
        tagIds?: string[];
      }
    ) => string;
    updateTopic: (
      id: string,
      patch: Partial<
        Pick<
          Topic,
          | "text"
          | "detail"
          | "dueDate"
          | "slotId"
          | "points"
          | "urgent"
          | "tagIds"
          | "meetingId"
          | "private"
          | "shared"
        >
      >
    ) => void;
    /**
     * Place a topic at a position inside a drop target, renumbering that
     * bucket. `placeTopic` answers "which column"; this answers "and where in
     * it", which is what a running order needs.
     */
    placeTopicAt: (
      id: string,
      target: ColumnTarget & { meetingId?: string },
      index?: number
    ) => void;
    /**
     * `placeTopicAt` for a selection: they land together, in the order given,
     * at `index` among the topics already there (not counting themselves).
     */
    placeTopicsAt: (
      ids: string[],
      target: ColumnTarget & { meetingId?: string },
      index?: number
    ) => void;
    /**
     * Put topics back exactly as they were — the way back for a bulk move.
     * Unlike `restoreTopic` this overwrites by id rather than adding.
     */
    revertTopics: (snapshot: Topic[]) => void;
    /**
     * Capture with the `#tag @meeting !` grammar. Unknown `#tags` are created
     * on the spot — being sent to a settings screen mid-thought is how a
     * capture box stops getting used. Returns the ids created.
     */
    captureTopics: (
      raw: string,
      target?: (ColumnTarget & { meetingId?: string }) | null,
      index?: number
    ) => string[];
    /** Hand one topic back to the backlog, noted against its occurrence. */
    returnTopic: (id: string) => void;
    /**
     * Sweep every occurrence whose date has passed. Returns how many came back
     * so the caller can say so. Idempotent — a topic only returns once.
     */
    sweepReturns: () => number;
    // the workspace vocabulary
    addTag: (label: string) => string;
    updateTag: (id: string, patch: Partial<Pick<Tag, "label" | "color">>) => void;
    /** Topics keep their text; slots and coverage targets are unwired. */
    deleteTag: (id: string) => void;
    // bulk operations — the reason a board beats a list
    tagTopics: (ids: string[], tagId: string, on: boolean) => void;
    assignTopics: (ids: string[], meetingId: string | null) => void;
    parkTopics: (ids: string[], parked: boolean) => void;
    deleteTopics: (ids: string[]) => void;
    // follow-ups — commitments that outlive one occurrence
    addFollowUp: (
      subjectKind: MeetingSubjectKind,
      subjectId: string,
      text: string,
      opts?: { meetingId?: string; sourceSessionId?: string }
    ) => string;
    toggleFollowUp: (id: string) => void;
    updateFollowUp: (
      id: string,
      patch: Partial<Pick<FollowUp, "text" | "owner" | "private">>
    ) => void;
    deleteFollowUp: (id: string) => void;
    // what Polarch learns — see the types for what each one is
    /** Learn a word. A second correction of the same mishearing replaces the first. */
    addGlossaryTerm: (meant: string, heard?: string) => string;
    deleteGlossaryTerm: (id: string) => void;
    addFixture: (
      subjectKind: MeetingSubjectKind,
      subjectId: string,
      title: string,
      opts?: Partial<Pick<Fixture, "owner" | "cadence" | "notes" | "lastTouchedOn">>
    ) => string;
    updateFixture: (
      id: string,
      patch: Partial<Pick<Fixture, "title" | "owner" | "cadence" | "notes" | "lastTouchedOn">>
    ) => void;
    deleteFixture: (id: string) => void;
    addKnowledge: (
      subjectKind: MeetingSubjectKind,
      subjectId: string,
      kind: KnowledgeKind,
      text: string,
      opts?: { sessionId?: string; notedOn?: string }
    ) => string;
    updateKnowledge: (id: string, patch: Partial<Pick<KnowledgeItem, "text" | "kind" | "pinned">>) => void;
    deleteKnowledge: (id: string) => void;
    // arcs — worked through one step per occurrence
    addArc: (
      arc: Omit<Arc, "id" | "order" | "createdOn" | "status"> & { status?: Arc["status"] }
    ) => string;
    updateArc: (id: string, patch: Partial<Omit<Arc, "id" | "meetingId">>) => void;
    deleteArc: (id: string) => void;
    /** Done, or again next time. A done step's practice becomes a follow-up. */
    markArcStep: (arcId: string, stepId: string, sessionId: string, mark: StepMark) => void;
    unmarkArcStep: (arcId: string, stepId: string, sessionId: string) => void;
    /** "We didn't touch it that week" — stop asking about that occurrence. */
    passArc: (arcId: string, sessionId: string) => void;
    /**
     * Move an arc's steps on the board: weeks in `wait` hold no step (booked
     * if they're only expected), weeks in `unwait` take steps again. Returns
     * an exact undo.
     */
    moveArcSteps: (
      arcId: string,
      wait: { sessionId: string | null; date: string }[],
      unwait: string[]
    ) => () => void;
    /** My one line from a step. Empty clears it. */
    setTakeaway: (arcId: string, stepId: string, text: string) => void;
    /** My part of an occurrence's shared write-up. */
    setSharedNote: (meetingId: string, sessionId: string, body: string) => void;
    // sharing
    loadShares: () => Promise<void>;
    createShare: (input: {
      meetingId: string;
      email: string;
      name?: string;
      personId?: string;
    }) => Promise<MeetingShare>;
    revokeShare: (id: string) => Promise<void>;
    /** A topic pushed three times is usually a commitment in disguise. */
    promoteToFollowUp: (topicId: string) => void;
    /** Move a topic into a lane or onto one occurrence. Reopens it if closed. */
    placeTopic: (
      id: string,
      target:
        | { lane: TopicLane; slotId?: string }
        | { sessionId: string; slotId?: string }
    ) => void;
    /** "We talked about it." Passing false puts it back on the board. */
    coverTopic: (id: string, covered?: boolean) => void;
    /**
     * File an unrecorded occurrence: Covered / Next week / Park per topic, and
     * a short write-up so the meeting leaves Loose end. The `quickClose` flag
     * gates the sheet that calls this; the action itself is the same ops.
     */
    quickCloseMeeting: (
      sessionId: string,
      dispositions: Record<string, TopicDisposition>,
      notes?: string
    ) => void;
    /**
     * Push a topic into a later occurrence and count it. Omit the session to
     * drop it back to the backlog — still a push, still counted.
     */
    rollTopic: (id: string, sessionId?: string) => void;
    deleteTopic: (id: string) => void;
    /** See `restoreTeamAction`. */
    restoreTopic: (topic: Topic) => void;
    /**
     * Move a topic one place up or down among the topics it is shown beside —
     * the same column on the board, the same agenda. Returns where it landed so
     * the caller can announce it, or `null` when it was already at the end.
     */
    moveTopic: (
      id: string,
      direction: -1 | 1
    ) => { index: number; total: number } | null;
    // tracked meetings — the unit readiness is measured against
    /**
     * Opt in to being ready for a meeting with this subject. Idempotent — it
     * answers the "is this tracked at all" question, so it adopts an existing
     * meeting rather than stacking a second one on it. Returns its id.
     */
    trackMeeting: (
      subjectKind: MeetingSubjectKind,
      subjectId: string,
      rhythm: MeetingRhythm,
      patch?: Partial<Omit<TrackedMeeting, "id" | "subjectKind" | "subjectId">>
    ) => string;
    /**
     * Add a meeting, always a new one. A 1:1 and a career check-in with the
     * same person are two different things to be ready for.
     */
    createMeeting: (
      subjectKind: MeetingSubjectKind,
      subjectId: string,
      patch?: Partial<Omit<TrackedMeeting, "id" | "subjectKind" | "subjectId">>
    ) => string;
    updateMeeting: (id: string, patch: Partial<Omit<TrackedMeeting, "id">>) => void;
    /**
     * Replace a meeting's standing skeleton. Topics pointing at a removed
     * slot become untagged rather than disappearing.
     */
    setCurriculum: (
      meetingId: string,
      curriculum: TrackedMeeting["curriculum"]
    ) => void;
    /**
     * "Every Monday." Sets the day and moves this meeting's future, unwritten
     * occurrences onto it, so a board already booked on the wrong day follows.
     */
    setMeetingWeekday: (meetingId: string, weekday: number | undefined) => void;
    /**
     * Add a row to the planner, backed by a workspace tag (found by name or
     * created). Topics already carrying that tag move into the row.
     */
    addMeetingRow: (meetingId: string, label: string) => string | undefined;
    /**
     * Move one occurrence, calendar-style. `from` is where it sits now (a
     * session, or a projected date). Returns the session id it ends up as.
     * "series" re-anchors the rhythm on the new weekday from now on.
     */
    moveOccurrence: (
      meetingId: string,
      from: { sessionId: string | null; date: string },
      to: string,
      scope: "one" | "series"
    ) => string;
    /** This week isn't happening. Its topics go back to Ideas (see `pushBack` to move them on instead). */
    skipOccurrence: (
      meetingId: string,
      from: { sessionId: string | null; date: string }
    ) => void;
    /** Undo a skip, or move a moved occurrence back onto its series date. */
    restoreOccurrence: (sessionId: string) => void;
    /**
     * Push back: this week's open items move to the next meeting and every
     * later week's move along one, in order. With `skip`, this week is also
     * skipped; without, it still happens and its arcs wait a week too.
     * Returns what moved and an exact undo, or null for an unknown meeting.
     */
    pushBack: (
      meetingId: string,
      from: { sessionId: string | null; date: string },
      opts: { skip: boolean }
    ) => { moved: number; weeks: number; arcs: number; undo: () => void } | null;
    /** A one-off meeting outside the rhythm. Reuses a session already on that date. */
    addExtraOccurrence: (meetingId: string, date: string) => string;
    /** Only offered when the meeting has no sessions — history is never dropped. */
    untrackMeeting: (id: string) => void;
    /** Record (or clear) the explicit "I don't sit down with them" decision. */
    setNoMeeting: (
      subjectKind: MeetingSubjectKind,
      subjectId: string,
      value: boolean
    ) => void;
    addSession: (o: Omit<Session, "id">) => string;
    updateSession: (id: string, patch: Partial<Omit<Session, "id">>) => void;
    deleteSession: (id: string) => void;
    addGoal: (g: Omit<Goal, "id">) => void;
    updateGoal: (id: string, patch: Partial<Goal>) => void;
    deleteGoal: (id: string) => void;
    /** See `restoreTeamAction`. */
    restoreGoal: (goal: Goal) => void;
    addNote: (personId: string, body: string) => string;
    updateNote: (id: string, patch: Partial<Pick<Note, "body" | "date">>) => void;
    deleteNote: (id: string) => void;
    // wins (leading up: value banked with a person I report to)
    addWin: (win: Omit<Win, "id" | "date"> & Partial<Pick<Win, "date">>) => void;
    updateWin: (id: string, patch: Partial<Pick<Win, "text" | "impact" | "date">>) => void;
    deleteWin: (id: string) => void;
    setSettingsOpen: (open: boolean) => void;
    // chat
    appendChat: (key: string, msg: ChatMessage) => void;
    clearChat: (key: string) => void;
    // auth / lifecycle
    bootstrap: () => Promise<void>;
    /** Re-run bootstrap after a load failure, resetting backoff. */
    retryBootstrap: () => Promise<void>;
    hydrate: (
      data: PersistedData,
      userId: string,
      email: string | null,
      opts?: {
        /** Skips re-writing the local cache when the doc came out of it. */
        fromCache?: boolean;
        /**
         * What the server is believed to hold, when that differs from `data` —
         * a refresh merged with local edits that still have to be written.
         * Must already be migrated, and share row objects with `data` for
         * every row that is the same.
         */
        baseline?: PersistedData;
        /** `data` has already been through migrateDoc/rescueOrphanTopics. */
        premigrated?: boolean;
      }
    ) => void;
    signOut: () => Promise<void>;
    // data management
    resetToSeed: () => Promise<void>;
  };

const DATA_KEY = "data";
const uid = () => Math.random().toString(36).slice(2, 10);

function occurrenceGuardOn(): boolean {
  return (
    flagOn("singleOccurrenceGuard") ||
    flagFromEnv(import.meta.env.VITE_SINGLE_OCCURRENCE_GUARD)
  );
}

function bookOccurrence(
  sessions: Session[],
  meeting: TrackedMeeting | undefined,
  spec: Omit<Session, "id">,
  topics: Topic[],
  site: "addSession" | "placement"
) {
  const guard = occurrenceGuardOn();
  return applyOccurrence(sessions, meeting, spec, uid, {
    guard,
    today: todayISO(),
    topics,
    reuseSameDate: sameDateReuseFor(site, guard),
  });
}

/**
 * A topic's tags after it lands in `slotId` of `meetingId`, having left
 * `fromSlotId`. The row a card sits in *is* its tag on the planner, so moving
 * from Prayer to Training swaps one for the other rather than accumulating.
 */
function weekdayOf(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

function addDaysISO(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function slotTagIds(
  meetings: TrackedMeeting[],
  meetingId: string | undefined,
  tagIds: string[],
  slotId: string | undefined,
  fromSlotId?: string
): string[] {
  const curriculum = meetings.find((m) => m.id === meetingId)?.curriculum ?? [];
  // The row it is leaving may be implied by a tag rather than stored.
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

/**
 * Where one topic lands when it is placed on a drop target — the topic as it
 * will be, and the sessions after any booking the drop implies. Pure, so the
 * single and the batch placement can't drift apart.
 */
function placement(
  s: { topics: Topic[]; sessions: Session[]; meetings: TrackedMeeting[] },
  id: string,
  target: ColumnTarget & { meetingId?: string }
): { sessions: Session[]; moved: Topic } | null {
  const topic = s.topics.find((t) => t.id === id);
  if (!topic) return null;

  let sessions = s.sessions;
  let sessionId: string | undefined;
  let slotId = target.slotId;
  let lane = topic.lane;
  let meetingId = target.meetingId ?? topic.meetingId;

  if (target.kind === "session") {
    sessionId = target.sessionId;
  } else if (target.kind === "projected") {
    // Dropping on a projected week books it on the way in — the plan is the
    // commitment, so it shouldn't need a separate "schedule this" step.
    if (meetingId) {
      const meeting = s.meetings.find((m) => m.id === meetingId);
      const booked = bookOccurrence(
        sessions,
        meeting,
        { meetingId, date: target.date },
        s.topics,
        "placement"
      );
      sessions = booked.sessions;
      sessionId = booked.sessionId;
    }
  } else {
    lane = target.lane;
  }

  if (sessionId) {
    const owner = sessions.find((o) => o.id === sessionId);
    if (owner) meetingId = owner.meetingId;
    lane = "backlog";
  }

  // A slot with a tag stamps it on arrival. This is what makes coverage
  // trustworthy without asking anyone to tag by hand.
  const tagIds = slotTagIds(
    s.meetings,
    meetingId,
    topic.tagIds,
    slotId,
    topic.meetingId === meetingId ? (topic.slotId ?? "") : undefined
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

  return { sessions, moved };
}

/**
 * The last topic removed, held outside state so it survives the re-render that
 * removed it without becoming a persisted field. One deep on purpose: this is
 * the undo for a mis-pressed Delete, not a history stack.
 */

/**
 * Tracking a meeting answers the opt-in question outright, so any lingering
 * "no meeting" decision on that subject is stale.
 */
function clearNoMeeting(
  s: Store,
  kind: MeetingSubjectKind,
  subjectId: string
): Partial<Store> {
  if (kind === "person") {
    return {
      people: s.people.map((p) =>
        p.id === subjectId && p.noMeeting ? { ...p, noMeeting: undefined } : p
      ),
    };
  }
  if (kind === "team") {
    return {
      teams: s.teams.map((t) =>
        t.id === subjectId && t.noMeeting ? { ...t, noMeeting: undefined } : t
      ),
    };
  }
  return {
    managers: s.managers.map((m) =>
      m.id === subjectId && m.noMeeting ? { ...m, noMeeting: undefined } : m
    ),
  };
}

/**
 * All three subject kinds carry the prayer mark on their own row, so every
 * prayer writer goes through this one patcher: praying for a team, for someone
 * on it and for the leader I answer to are the same act — only the row differs.
 */
function patchPrayer(
  s: Store,
  kind: PrayerSubjectKind,
  id: string,
  next: (prayer?: Prayer) => Prayer | undefined
): Partial<Store> {
  const apply = <T extends { id: string; prayer?: Prayer }>(x: T): T =>
    x.id === id ? { ...x, prayer: next(x.prayer) } : x;
  if (kind === "team") return { teams: s.teams.map(apply) };
  if (kind === "manager") return { managers: s.managers.map(apply) };
  return { people: s.people.map(apply) };
}

/** Meetings for a set of subjects, plus every session and topic under them. */
function withoutMeetingsFor(
  s: Store,
  kind: MeetingSubjectKind,
  subjectIds: Set<string>
): Pick<Store, "meetings" | "sessions" | "topics"> {
  const doomed = new Set(
    s.meetings
      .filter((m) => m.subjectKind === kind && subjectIds.has(m.subjectId))
      .map((m) => m.id)
  );
  return {
    meetings: s.meetings.filter((m) => !doomed.has(m.id)),
    sessions: s.sessions.filter((o) => !doomed.has(o.meetingId)),
    // An unassigned topic has no meeting to be doomed with — deleting a meeting
    // must not silently take the backlog with it.
    topics: s.topics.filter((t) => !(t.meetingId && doomed.has(t.meetingId))),
  };
}

function migrateActions(actions: Action[]): Action[] {
  return actions.map((a) => ({
    ...a,
    column: a.column ?? (a.done ? "done" : "backlog"),
  }));
}

/**
 * A document from the local cache was written by whatever version of the app
 * last ran in this browser, which may predate fields the current one assumes.
 *
 * Filling the gaps beats the alternatives: throwing the cache away makes every
 * upgrade a cold blank open, and trusting it crashes on the first `[...t.
 * carriedFrom]`. The server copy that arrives moments later has the real
 * values — this only has to survive the paint in between.
 */
function migrateDoc(doc: PersistedData): PersistedData {
  const topics = doc.topics ?? [];
  const needsFill = topics.some((t) => !t.tagIds || !t.carriedFrom);
  // Life areas and capacities still on the retired Tailwind defaults move to
  // the identity pigments. Hand-picked colors are left alone.
  const pigments = migratePigments(doc.domains ?? [], doc.capacities ?? []);
  return {
    ...doc,
    // Collections added after this cache may have been written.
    tags: doc.tags ?? [],
    followUps: doc.followUps ?? [],
    meetings: doc.meetings ?? [],
    sessions: doc.sessions ?? [],
    topics: needsFill
      ? topics.map((t) => ({
          ...t,
          tagIds: t.tagIds ?? [],
          carriedFrom: t.carriedFrom ?? [],
        }))
      : topics,
    people: doc.people ?? [],
    teams: doc.teams ?? [],
    managers: doc.managers ?? [],
    domains: pigments.domains,
    capacities: pigments.capacities,
    actions: doc.actions ?? [],
    goals: doc.goals ?? [],
    notes: doc.notes ?? [],
    wins: doc.wins ?? [],
    prayers: doc.prayers ?? [],
    teamActions: doc.teamActions ?? [],
    teamGoals: doc.teamGoals ?? [],
    teamNotes: doc.teamNotes ?? [],
    chats: doc.chats ?? {},
    nodePositions: doc.nodePositions ?? {},
    arcs: doc.arcs ?? [],
    takeaways: doc.takeaways ?? [],
    sharedNotes: doc.sharedNotes ?? [],
    glossary: doc.glossary ?? [],
    fixtures: doc.fixtures ?? [],
    knowledge: doc.knowledge ?? [],
  };
}

/**
 * Un-strand topics that point at an occurrence which isn't there.
 *
 * Every surface splits topics in two: `!sessionId` is the idea bucket, and a
 * `sessionId` matching a real session is a week column or a calendar day. A
 * topic naming a session that doesn't exist falls through both — it is in the
 * database, it syncs, it comes back on every load, and no screen in the app
 * will draw it. From the desk it is simply gone.
 *
 * That state is reachable whenever the session write and the topic write don't
 * land together: sessions and topics are separate upserts inside one
 * `Promise.all`, so one table can commit while the other 400s. Rather than
 * trusting those to never diverge, heal it on the way in — the topic goes back
 * to the backlog it came from, where it is visible and can be re-planned. Being
 * asked to schedule something twice is a nuisance; losing it is not.
 */
function rescueOrphanTopics(doc: PersistedData): PersistedData {
  const sessions = doc.sessions ?? [];
  const topics = doc.topics ?? [];
  const known = new Set(sessions.map((o) => o.id));
  const stranded = topics.filter((t) => t.sessionId && !known.has(t.sessionId));
  if (!stranded.length) return doc;

  console.warn(
    `Polarch: ${stranded.length} topic(s) pointed at a missing occurrence — returned to the backlog`,
    stranded.map((t) => t.text)
  );
  const lost = new Set(stranded.map((t) => t.id));
  return {
    ...doc,
    topics: topics.map((t) =>
      lost.has(t.id) ? { ...t, sessionId: undefined, lane: "backlog" as const } : t
    ),
  };
}

function migrateSessions(sessions: Session[]): Session[] {
  return sessions.map((o) => ({
    ...o,
    // Legacy schedule stubs used notes: "Scheduled"
    notes: o.notes === "Scheduled" ? undefined : o.notes,
  }));
}

/** Fresh seed document for a brand-new account. */
function seedData(): PersistedData {
  return {
    me: seedMe,
    capacities: seedCapacities,
    domains: seedDomains,
    managers: seedManagers,
    teams: seedTeams,
    people: seedPeople,
    actions: seedActions,
    meetings: seedMeetings,
    tags: seedTags,
    topics: seedTopics,
    followUps: seedFollowUps,
    sessions: seedSessions,
    goals: seedGoals,
    notes: seedNotes,
    wins: seedWins,
    prayers: seedPrayers,
    teamActions: seedTeamActions,
    teamGoals: seedTeamGoals,
    teamNotes: seedTeamNotes,
    chats: {},
    nodePositions: {},
    arcs: seedArcs,
    takeaways: seedTakeaways,
    sharedNotes: [],
    glossary: seedGlossary,
    fixtures: seedFixtures,
    knowledge: seedKnowledge,
  };
}

/** Empty placeholder used before the first cloud load resolves (never shown). */
function blankData(): PersistedData {
  return {
    me: { name: "", assessments: {}, strengths: [], watchOuts: [] },
    capacities: [],
    domains: [],
    managers: [],
    teams: [],
    people: [],
    actions: [],
    meetings: [],
    tags: [],
    topics: [],
    followUps: [],
    sessions: [],
    goals: [],
    notes: [],
    wins: [],
    prayers: [],
    teamActions: [],
    teamGoals: [],
    teamNotes: [],
    chats: {},
    nodePositions: {},
    arcs: [],
    takeaways: [],
    sharedNotes: [],
    glossary: [],
    fixtures: [],
    knowledge: [],
  };
}

/**
 * Every field the cloud write path must extract from the store. Kept next to
 * the document shape helpers so bootstrap can tell a complete cache from one
 * written by a buggy extract that omitted newer collections.
 */
const PERSISTED_KEYS: (keyof PersistedData)[] = [
  "me",
  "capacities",
  "domains",
  "managers",
  "teams",
  "people",
  "actions",
  "meetings",
  "tags",
  "topics",
  "followUps",
  "sessions",
  "goals",
  "notes",
  "wins",
  "prayers",
  "teamActions",
  "teamGoals",
  "teamNotes",
  "chats",
  "nodePositions",
  "arcs",
  "takeaways",
  "sharedNotes",
  "glossary",
  "fixtures",
  "knowledge",
];

/** True when a cached doc was serialized without one of the persisted slices. */
function isIncompletePersistedDoc(doc: Partial<PersistedData>): boolean {
  return PERSISTED_KEYS.some((k) => doc[k] === undefined);
}

/** The persisted slices that are arrays of `{ id }` — everything but these three. */
const ID_COLLECTIONS = PERSISTED_KEYS.filter(
  (k) => k !== "me" && k !== "chats" && k !== "nodePositions"
);

type Row = { id: string };

/** Rows the refresh found on this device, untouched here, that the server no longer has. */
export type MissingRows = Partial<Record<keyof PersistedData, Row[]>>;

/**
 * Three-way merge of a server read into the document on screen.
 *
 * `base` is what this device last believed the server held. Per row:
 *  - changed or created here (not identical to base) → keep the local version;
 *  - untouched here → take the server's version, which carries edits made on
 *    other devices; if the server no longer has it, it was deleted elsewhere;
 *  - deleted here (in base, not local) → stays deleted;
 *  - only on the server → comes across.
 *
 * The caller installs `server` as the new baseline, so the next sync writes
 * exactly the local changes and nothing else. With no base every local row
 * counts as changed: local wins, and nothing the server has is lost.
 */
function mergeServer(
  local: PersistedData,
  base: PersistedData | null,
  server: PersistedData
): { doc: PersistedData; missing: MissingRows; missingCount: number } {
  const doc: PersistedData = { ...server };
  const missing: MissingRows = {};
  let missingCount = 0;

  doc.me = base && local.me === base.me ? server.me : local.me;

  for (const k of ID_COLLECTIONS) {
    const mine = local[k] as Row[] | undefined;
    const theirs = server[k] as Row[] | undefined;
    if (!Array.isArray(mine)) continue;
    if (!Array.isArray(theirs)) {
      (doc as Record<string, unknown>)[k] = mine;
      continue;
    }
    const before = new Map(
      ((base?.[k] as Row[] | undefined) ?? []).map((x) => [x.id, x] as const)
    );
    const onServer = new Map(theirs.map((x) => [x.id, x] as const));
    const here = new Set(mine.map((x) => x.id));
    const out: Row[] = [];
    for (const row of mine) {
      if (before.get(row.id) === row) {
        const fresh = onServer.get(row.id);
        if (fresh) out.push(fresh);
        else {
          (missing[k] ??= []).push(row);
          missingCount += 1;
        }
      } else {
        out.push(row);
      }
    }
    for (const row of theirs) {
      if (!here.has(row.id) && !before.has(row.id)) out.push(row);
    }
    (doc as Record<string, unknown>)[k] = out;
  }

  for (const k of ["chats", "nodePositions"] as const) {
    const mine = (local[k] ?? {}) as Record<string, unknown>;
    const theirs = (server[k] ?? {}) as Record<string, unknown>;
    const before = (base?.[k] ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(mine)) {
      if (key in before && before[key] === v) {
        if (key in theirs) out[key] = theirs[key];
      } else {
        out[key] = v;
      }
    }
    for (const [key, v] of Object.entries(theirs)) {
      if (!(key in mine) && !(key in before)) out[key] = v;
    }
    (doc as Record<string, unknown>)[k] = out;
  }

  return { doc, missing, missingCount };
}

/**
 * Give `doc` the same row objects as `base` wherever the two are equal.
 *
 * Sync diffs by object identity, and identity does not survive a round trip
 * through the local cache — a document and its baseline read back from JSON
 * share nothing. Without this every row would look edited.
 */
function relink(doc: PersistedData, base: PersistedData): PersistedData {
  const out: PersistedData = { ...doc };
  const same = (a: unknown, b: unknown) =>
    a === b || JSON.stringify(a) === JSON.stringify(b);
  if (same(doc.me, base.me)) out.me = base.me;
  for (const k of ID_COLLECTIONS) {
    const rows = doc[k] as Row[] | undefined;
    const prev = base[k] as Row[] | undefined;
    if (!Array.isArray(rows) || !Array.isArray(prev)) continue;
    const byId = new Map(prev.map((x) => [x.id, x] as const));
    (out as Record<string, unknown>)[k] = rows.map((r) => {
      const b = byId.get(r.id);
      return b && same(r, b) ? b : r;
    });
  }
  for (const k of ["chats", "nodePositions"] as const) {
    const rows = { ...(doc[k] ?? {}) } as Record<string, unknown>;
    const prev = (base[k] ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(rows)) {
      if (key in prev && same(rows[key], prev[key])) rows[key] = prev[key];
    }
    (out as Record<string, unknown>)[k] = rows;
  }
  return out;
}

const RECOVERY_KEY = (userId: string) => `recovery:${userId}`;

type RecoveryStash = { savedAt: string; rows: MissingRows };

/**
 * Keep rows a refresh is about to drop, and offer them back.
 *
 * After the sync bugs of August/September the local copy on some device may be
 * the only place a week of meeting prep still exists. A row that is on this
 * device, untouched here, and gone from the server is *usually* a delete made
 * elsewhere — but it is exactly what lost work looks like too, and asking once
 * costs nothing next to guessing wrong.
 */
function offerRecovery(userId: string, missing: MissingRows, count: number) {
  const prev = storage.load<RecoveryStash>(RECOVERY_KEY(userId));
  const rows: MissingRows = { ...(prev?.rows ?? {}) };
  for (const [k, list] of Object.entries(missing) as [keyof PersistedData, Row[]][]) {
    const have = new Set((rows[k] ?? []).map((r) => r.id));
    rows[k] = [...(rows[k] ?? []), ...list.filter((r) => !have.has(r.id))];
  }
  storage.save<RecoveryStash>(RECOVERY_KEY(userId), {
    savedAt: new Date().toISOString(),
    rows,
  });
  const topicCount = missing.topics?.length ?? 0;
  const what =
    topicCount === count
      ? `${count} topic${count === 1 ? "" : "s"}`
      : `${count} item${count === 1 ? "" : "s"}`;
  toast({
    tone: "error",
    message: `This device had ${what} the cloud doesn't — deleted elsewhere, or lost in an old sync.`,
    action: { label: "Restore", onAction: () => restoreRecovery(userId) },
  });
}

/** Put stashed rows back. They sync as new rows on the next write. */
export function restoreRecovery(userId: string): number {
  const stash = storage.load<RecoveryStash>(RECOVERY_KEY(userId));
  const state = useStore.getState();
  if (!stash || state.userId !== userId) return 0;
  const patch: Record<string, unknown> = {};
  let restored = 0;
  for (const [k, list] of Object.entries(stash.rows) as [keyof PersistedData, Row[]][]) {
    const current = state[k] as unknown as Row[];
    if (!Array.isArray(current) || !list?.length) continue;
    const have = new Set(current.map((r) => r.id));
    const back = list.filter((r) => !have.has(r.id));
    if (!back.length) continue;
    patch[k] = [...current, ...back];
    restored += back.length;
  }
  if (restored) {
    useStore.setState(patch as Partial<Store>);
    toast({ message: `Restored ${restored} item${restored === 1 ? "" : "s"}.` });
  }
  storage.remove(RECOVERY_KEY(userId));
  return restored;
}

/**
 * A failed sync used to cache `extractData` without `tags` / `followUps`.
 * Reloading that snapshot as a pending full push would migrate the holes to
 * `[]` and delete the server's rows. Overlay the cache's present keys onto
 * the server copy so edits survive and missing tables stay intact.
 */
async function recoverIncompletePendingWrite(
  userId: string,
  email: string | null,
  cachedRaw: PersistedData,
  hydrate: Store["hydrate"]
): Promise<void> {
  try {
    const server = await repo.loadAll(userId);
    if (!server) {
      // Nothing on the server to protect — push what we have.
      repo.clearBaseline();
      fullSyncPending = true;
      void runSync(userId);
      return;
    }
    const merged: PersistedData = { ...server };
    for (const k of PERSISTED_KEYS) {
      if (cachedRaw[k] !== undefined) {
        (merged as Record<string, unknown>)[k] = cachedRaw[k];
      }
    }
    hydrate(merged, userId, email);
    repo.clearBaseline();
    fullSyncPending = true;
    void runSync(userId);
  } catch (e) {
    console.error("Polarch: could not repair incomplete pending cache", e);
    // Do not full-push the incomplete doc — that is how the wipe happens.
    // Keep the local paint and retry when connectivity returns via revalidate.
    void revalidate(userId, email);
  }
}

/**
 * One-time migration: if this browser still holds data from the old
 * localStorage-only version, adopt it as the new user's starting document so
 * nothing is lost. Returns null when there's nothing to import.
 */
function importLegacyLocalData(): PersistedData | null {
  const saved = storage.load<PersistedData>(DATA_KEY);
  if (!saved || !saved.capacities) return null;
  return {
    ...saved,
    me: emptyMe({
      name: saved.me?.name ?? "",
      title: saved.me?.title,
      photo: saved.me?.photo,
      assessments: saved.me?.assessments,
      strengths: saved.me?.strengths,
      watchOuts: saved.me?.watchOuts,
      howToLead: saved.me?.howToLead,
      customModalities: saved.me?.customModalities,
    }),
    chats: saved.chats ?? {},
    nodePositions: saved.nodePositions ?? {},
    arcs: [],
    takeaways: [],
    sharedNotes: [],
    glossary: [],
    fixtures: [],
    knowledge: [],
    domains: saved.domains ?? seedDomains,
    managers: saved.managers ?? [],
    wins: saved.wins ?? [],
    prayers: saved.prayers ?? [],
    teamActions: saved.teamActions ?? [],
    teamGoals: saved.teamGoals ?? [],
    teamNotes: saved.teamNotes ?? [],
    actions: migrateActions(saved.actions ?? []),
    meetings: saved.meetings ?? [],
    sessions: migrateSessions(saved.sessions ?? []),
    capacities: saved.capacities.some((c) => c.id === capUp.id)
      ? saved.capacities
      : [...saved.capacities, capUp],
  };
}

function initialDark(): boolean {
  const saved = storage.load<boolean>("dark");
  if (saved !== null) return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * How wide the entity panel sits beside the canvas, as a percentage of the
 * split. The panel is the working surface — the canvas is the index — so the
 * default gives it the larger share, and dragging the divider is remembered.
 */
export const PANEL_PCT_DEFAULT = 62;
export const PANEL_PCT_MIN = 35;
export const PANEL_PCT_MAX = 80;

export function clampPanelPct(pct: number): number {
  return Math.min(PANEL_PCT_MAX, Math.max(PANEL_PCT_MIN, Math.round(pct)));
}

function initialPanelPct(): number {
  const saved = storage.load<number>("panelPct");
  return typeof saved === "number" ? clampPanelPct(saved) : PANEL_PCT_DEFAULT;
}

/**
 * The team in context: the one selected outright, or the team of the person
 * who is. Derived rather than stored so it stays right no matter what order
 * the route and the cloud data arrive in.
 */
export function useActiveTeamId(): string | null {
  return useStore((s) =>
    s.selectedPersonId
      ? (s.people.find((p) => p.id === s.selectedPersonId)?.teamId ?? null)
      : s.selectedTeamId
  );
}

/** The one entity the current route points at. A person outranks their team. */
function currentSelection(s: UIState): Selection | null {
  const sessionId = s.sessionId ?? undefined;
  if (s.selectedPersonId)
    return {
      kind: "person",
      id: s.selectedPersonId,
      section: s.section ?? undefined,
      sessionId,
    };
  if (s.selectedTeamId)
    return {
      kind: "team",
      id: s.selectedTeamId,
      section: s.section ?? undefined,
      sessionId,
    };
  if (s.selectedManagerId)
    return {
      kind: "manager",
      id: s.selectedManagerId,
      section: s.section ?? undefined,
      sessionId,
    };
  if (s.selectedMeetingId)
    return {
      kind: "meeting",
      id: s.selectedMeetingId,
      section: s.section ?? undefined,
      sessionId,
    };
  if (s.selectedMe)
    return { kind: "me", id: "", section: s.section ?? undefined, sessionId };
  return null;
}

/**
 * Navigate to a tab surface, optionally switching tabs on the way. A focus
 * route names no tab, so `s.tab` is the one behind it — falling back to Today
 * here is what made X from a full page land somewhere you had never been.
 */
function goTab(
  s: UIState,
  sel: Selection | null,
  tab?: Tab,
  opts?: { replace?: boolean }
) {
  go(routePath({ view: "tab", tab: tab ?? s.tab, peek: sel }), opts);
}

/**
 * Where an entity with no remembered origin goes on leaving: a deep link or a
 * cold start. A full page you landed on cold has no tab behind it, so it falls
 * to the list its kind belongs to rather than to Today.
 */
function homeFor(s: UIState, sel: Selection | null): Tab {
  if (!s.focused || s.tab !== DEFAULT_TAB) return s.tab;
  if (sel?.kind === "meeting") return "meetings";
  return sel && sel.kind !== "me" ? "table" : DEFAULT_TAB;
}

/**
 * Back, X and Esc: return to the page the open entity was opened from. The one
 * place that rule lives — the controls differ only in how they look.
 */
function leave(s: UIState) {
  const trail = nav?.trail() ?? NO_TRAIL;
  const to =
    trail.origin ??
    routePath({
      view: "tab",
      tab: homeFor(s, currentSelection(s)),
      peek: null,
    });
  if (nav) nav.pop(trail.origin === null ? 0 : trail.depth, to);
  else go(to, { replace: true });
}

/**
 * Navigate keeping whichever surface we're already on — a peek stays a peek,
 * focus stays focus. Clearing the selection always lands back on a tab.
 */
function goTo(s: UIState, sel: Selection | null, opts?: { replace?: boolean }) {
  if (s.focused && sel) {
    go(routePath({ view: "focus", target: sel }), opts);
    return;
  }
  goTab(s, sel, undefined, opts);
}

export const useStore = create<Store>((set, get) => ({
  ...blankData(),
  phase: "loading",
  loadError: null,
  syncStatus: "idle",
  userId: null,
  userEmail: null,
  tab: DEFAULT_TAB,
  treeDomainId: null,
  healthScan: [],
  prayerScan: [],
  treeMode: "plan",
  selectedPersonId: null,
  selectedTeamId: null,
  selectedManagerId: null,
  selectedMeetingId: null,
  selectedMe: false,
  focused: false,
  section: null,
  sessionId: null,
  collapsedTeams: [],
  dark: initialDark(),
  panelPct: initialPanelPct(),
  paletteOpen: false,
  helpOpen: false,
  shares: [],
  sharedWithMe: [],
  modal: null,
  settingsOpen: false,

  setTab: (tab) => {
    const s = get();
    goTab(s, currentSelection(s), tab);
  },
  goToTab: (tab) => goTab(get(), null, tab),
  // Filtering the canvas drops any selection that just left the view.
  setTreeDomainId: (id) => {
    const s = get();
    set({ treeDomainId: id });
    if (!id) return;
    const sel = currentSelection(s);
    if (!sel) return;
    const teamInDomain = (teamId: string | null | undefined) =>
      Boolean(teamId) &&
      s.teams.find((t) => t.id === teamId)?.domainId === id;

    const survives =
      sel.kind === "team"
        ? teamInDomain(sel.id)
        : sel.kind === "person"
          ? (() => {
              const person = s.people.find((p) => p.id === sel.id);
              // A direct report carries their own domain tag — there's no team
              // to inherit one from.
              return person ? personDomainId(person, s.teams) === id : false;
            })()
          : sel.kind === "manager"
            ? s.managers.find((m) => m.id === sel.id)?.domainId === id
            : true;
    if (!survives) leave(s);
  },
  toggleHealthScan: (value) =>
    set((s) => ({
      healthScan: s.healthScan.includes(value)
        ? s.healthScan.filter((v) => v !== value)
        : [...s.healthScan, value],
    })),
  setHealthScan: (values) => set({ healthScan: values }),
  togglePrayerScan: (value) =>
    set((s) => ({
      prayerScan: s.prayerScan.includes(value)
        ? s.prayerScan.filter((v) => v !== value)
        : [...s.prayerScan, value],
    })),
  setPrayerScan: (values) => set({ prayerScan: values }),
  // Switching mode deliberately leaves the scans alone. They're shared with
  // the table so a scan follows you between the two surfaces, and dropping one
  // every time you changed mode would break that. The canvas just stops
  // *applying* a scan its mode doesn't own — see MODE_SCAN.
  setTreeMode: (mode) => set({ treeMode: mode }),
  // Closing is always `leave`: back to the page it was opened from. Stepping
  // up to the team here made Esc land somewhere the X and Back never did; the
  // breadcrumb is the way up.
  selectPerson: (id, section) => {
    const s = get();
    if (!id) return leave(s);
    goTo(s, { kind: "person", id, section });
  },
  selectTeam: (id, section) => {
    const s = get();
    if (!id) return leave(s);
    goTo(s, { kind: "team", id, section });
  },
  // Opens where you are. It used to jump to the Tree tab ("a manager stands
  // above me on the canvas") — fine from the canvas, a surprise from Today,
  // Prayer or the palette, and closing left you there.
  selectManager: (id, section) => {
    const s = get();
    if (!id) return leave(s);
    goTo(s, { kind: "manager", id, section });
  },
  // A meeting is reached from Home, the Meetings tab or its subject's profile,
  // and there's no canvas node for it — so it always opens in focus, where the
  // agenda and the planner have the width they need. No section means Plan
  // ahead — the board of today's meeting and the ones after it.
  selectMeeting: (id, section) => {
    const s = get();
    if (!id) return leave(s);
    go(
      routePath({
        view: "focus",
        target: { kind: "meeting", id, section },
      })
    );
  },
  selectMe: (open) => {
    const s = get();
    if (!open) return leave(s);
    goTo(s, { kind: "me", id: "" });
  },
  openMe: () =>
    go(routePath({ view: "focus", target: { kind: "me", id: "" } })),
  clearSelection: () => leave(get()),
  // Sideways to a sibling: same kind, same section, and no new history entry —
  // Back should leave the entity, not walk back through everyone you paged past.
  pageTo: (id) => {
    const s = get();
    const sel = currentSelection(s);
    if (!sel || sel.kind === "me") return;
    goTo(s, { kind: sel.kind, id, section: sel.section }, { replace: true });
  },
  // Sub-page moves replace history: back should leave the entity, not walk tabs.
  setSection: (section) => {
    const s = get();
    const sel = currentSelection(s);
    if (!sel) return;
    goTo(s, { ...sel, section: section ?? undefined, sessionId: undefined }, {
      replace: true,
    });
  },
  openSession: (sessionId) => {
    const s = get();
    const session = s.sessions.find((o) => o.id === sessionId);
    if (!session) return;
    const meeting = s.meetings.find((m) => m.id === session.meetingId);
    if (!meeting) return;

    // Where the editor sits in the URL only decides what a *cold* link shows
    // behind it. Closing returns to the page it was opened from (`opener`), so
    // opening from the planner lands back on the board, from a peek on the
    // peek, and from Today on Today.
    let target: Selection;
    if (resolveMeetingKey(s, s.selectedMeetingId ?? "") === meeting.id) {
      target = { kind: "meeting", id: meeting.id, section: "notes", sessionId };
    } else {
      const kind =
        meeting.subjectKind === "person" || meeting.subjectKind === "manager"
          ? meeting.subjectKind
          : "team";
      target = { kind, id: meeting.subjectId, section: "sessions", sessionId };
    }
    go(routePath({ view: "focus", target }), { opener: true });
  },
  closeSession: () => {
    const s = get();
    const sel = currentSelection(s);
    if (!sel?.sessionId) return;
    // Opened from somewhere: it is the entry right behind this one.
    const { opener } = nav?.trail() ?? NO_TRAIL;
    if (nav && opener !== null) {
      nav.pop(1, opener);
      return;
    }
    // A cold link, or a write-up that vanished under us: the entity it's on.
    const { sessionId: _removed, ...rest } = sel;
    // Teams embed meetings on the main profile — no sessions sub-page to land on.
    const target =
      rest.kind === "team"
        ? { kind: rest.kind, id: rest.id }
        : rest.kind === "meeting"
          ? { ...rest, section: rest.section ?? "notes" }
          : { ...rest, section: rest.section ?? "sessions" };
    go(routePath({ view: "focus", target }), { replace: true });
  },
  openFocus: () => {
    const sel = currentSelection(get());
    if (sel) go(routePath({ view: "focus", target: sel }));
  },
  closeFocus: () => {
    const s = get();
    goTab(s, currentSelection(s), s.tab);
  },
  applyRoute: (route) =>
    set((s) => {
      const sel = route.view === "focus" ? route.target : route.peek;
      const next = {
        // Focus routes don't name a tab — keep the one we'll return to.
        tab: route.view === "focus" ? s.tab : route.tab,
        focused: route.view === "focus",
        section: sel?.section ?? null,
        sessionId: sel?.sessionId ?? null,
        selectedPersonId: null as string | null,
        selectedTeamId: null as string | null,
        selectedManagerId: null as string | null,
        selectedMeetingId: null as string | null,
        selectedMe: false,
      };
      if (!sel) return next;
      // A person's team is derived at read time (useActiveTeamId), not stored:
      // a deep link applies its route before the cloud data has loaded, so any
      // lookup done here would resolve against an empty store.
      if (sel.kind === "person") next.selectedPersonId = sel.id;
      else if (sel.kind === "team") next.selectedTeamId = sel.id;
      else if (sel.kind === "manager") next.selectedManagerId = sel.id;
      // The URL may carry a slug. Resolve it when the data is here; before
      // it loads the slug stands in, and App re-applies the route once ready.
      else if (sel.kind === "meeting")
        next.selectedMeetingId = resolveMeetingKey(s, sel.id);
      else next.selectedMe = true;
      return next;
    }),
  toggleTeamCollapsed: (teamId) =>
    set((s) => ({
      collapsedTeams: s.collapsedTeams.includes(teamId)
        ? s.collapsedTeams.filter((t) => t !== teamId)
        : [...s.collapsedTeams, teamId],
    })),
  toggleDark: () => {
    const dark = !get().dark;
    storage.save("dark", dark);
    set({ dark });
  },
  setPanelPct: (pct) => {
    const next = clampPanelPct(pct);
    if (next === get().panelPct) return;
    storage.save("panelPct", next);
    set({ panelPct: next });
  },
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  setHelpOpen: (open) => set({ helpOpen: open }),
  openModal: (modal) => set({ modal }),
  closeModal: () => set({ modal: null }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),

  setNodePosition: (id, pos) =>
    set((s) => ({ nodePositions: { ...s.nodePositions, [id]: pos } })),
  resetLayout: () => set({ nodePositions: {} }),

  updateMe: (patch) =>
    set((s) => ({
      me: {
        ...s.me,
        ...patch,
        assessments:
          patch.assessments !== undefined
            ? patch.assessments
            : s.me.assessments,
      },
    })),

  addDomain: (domain) => {
    const id = uid();
    set((s) => ({ domains: [...s.domains, { ...domain, id }] }));
    return id;
  },
  updateDomain: (id, patch) =>
    set((s) => ({
      domains: s.domains.map((d) => (d.id === id ? { ...d, ...patch } : d)),
    })),
  deleteDomain: (id) =>
    set((s) => ({
      domains: s.domains.filter((d) => d.id !== id),
      // Untag anything that pointed at this domain.
      teams: s.teams.map((t) =>
        t.domainId === id ? { ...t, domainId: undefined } : t
      ),
      people: s.people.map((p) =>
        p.domainId === id ? { ...p, domainId: undefined } : p
      ),
      managers: s.managers.map((m) =>
        m.domainId === id ? { ...m, domainId: undefined } : m
      ),
      treeDomainId: s.treeDomainId === id ? null : s.treeDomainId,
    })),

  addManager: (manager) =>
    set((s) => ({ managers: [...s.managers, { ...manager, id: uid() }] })),
  updateManager: (id, patch) =>
    set((s) => ({
      managers: s.managers.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    })),
  updateManagerLeadUp: (id, patch) =>
    set((s) => ({
      managers: s.managers.map((m) =>
        m.id === id ? { ...m, leadUp: { ...m.leadUp, ...patch } } : m
      ),
    })),
  deleteManager: (id) => {
    const before = get();
    set((s) => {
      const { [`mgr:${id}`]: _pos, ...nodePositions } = s.nodePositions;
      return {
        managers: s.managers.filter((m) => m.id !== id),
        ...withoutMeetingsFor(s, "manager", new Set([id])),
        // Topics, notes and wins are all keyed by subject id, managers
        // included — leading up shares the person tables.
        actions: s.actions.filter((a) => a.personId !== id),
        notes: s.notes.filter((n) => n.personId !== id),
        wins: s.wins.filter((w) => w.personId !== id),
        prayers: s.prayers.filter(
          (e) => !(e.subjectKind === "manager" && e.subjectId === id)
        ),
        nodePositions,
      };
    });
    if (before.selectedManagerId === id) leave(before);
  },

  /**
   * One writer for both subject kinds. Every change re-stamps `ratedOn`: the
   * date is what separates a current read from a memory, and it would go stale
   * silently if editing the level left it alone.
   */
  setHealth: (kind, id, level) =>
    set((s) => {
      const apply = <T extends { id: string; health?: Team["health"] }>(x: T): T =>
        x.id !== id
          ? x
          : {
              ...x,
              health: level
                ? { level, note: x.health?.note, ratedOn: todayISO() }
                : undefined,
            };
      return kind === "team"
        ? { teams: s.teams.map(apply) }
        : { people: s.people.map(apply) };
    }),
  setHealthNote: (kind, id, note) =>
    set((s) => {
      const text = note.trim();
      const apply = <T extends { id: string; health?: Team["health"] }>(x: T): T =>
        x.id !== id || !x.health
          ? x
          : { ...x, health: { ...x.health, note: text || undefined } };
      return kind === "team"
        ? { teams: s.teams.map(apply) }
        : { people: s.people.map(apply) };
    }),

  setPrayer: (kind, id, carrying) =>
    set((s) =>
      patchPrayer(s, kind, id, (prayer) =>
        // Already carrying? Taking them up again must not reset the clock —
        // how long you've held someone is the whole point of the date.
        carrying ? (prayer ?? { since: todayISO() }) : undefined
      )
    ),
  setPrayerFocus: (kind, id, focus) =>
    set((s) =>
      patchPrayer(s, kind, id, (prayer) => {
        const text = focus.trim();
        // Writing the focus for someone you weren't carrying takes them up —
        // the sentence is the decision.
        return { ...(prayer ?? { since: todayISO() }), focus: text || undefined };
      })
    ),
  markPrayed: (kind, id) =>
    set((s) =>
      patchPrayer(s, kind, id, (prayer) => {
        const today = todayISO();
        const base = prayer ?? { since: today };
        // Twice in a day is still one day. The count is a record of days held,
        // not a tally to run up.
        if (base.lastPrayedOn === today) return base;
        return { ...base, lastPrayedOn: today, times: (base.times ?? 0) + 1 };
      })
    ),
  addPrayerEntry: (kind, subjectId, text, entryKind = "burden") => {
    const id = uid();
    set((s) => ({
      prayers: [
        ...s.prayers,
        {
          id,
          subjectKind: kind,
          subjectId,
          date: todayISO(),
          kind: entryKind,
          text: text.trim(),
        },
      ],
      // Writing something down for someone starts carrying them. Refusing
      // until a switch had been flipped first would be pure ceremony.
      ...patchPrayer(s, kind, subjectId, (prayer) => prayer ?? { since: todayISO() }),
    }));
    return id;
  },
  updatePrayerEntry: (id, patch) =>
    set((s) => ({
      prayers: s.prayers.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    })),
  answerPrayerEntry: (id, note) =>
    set((s) => ({
      prayers: s.prayers.map((e) =>
        e.id === id
          ? {
              ...e,
              answeredOn: e.answeredOn ?? todayISO(),
              answerNote: note?.trim() || e.answerNote,
            }
          : e
      ),
    })),
  reopenPrayerEntry: (id) =>
    set((s) => ({
      prayers: s.prayers.map((e) =>
        e.id === id ? { ...e, answeredOn: undefined, answerNote: undefined } : e
      ),
    })),
  deletePrayerEntry: (id) =>
    set((s) => ({ prayers: s.prayers.filter((e) => e.id !== id) })),

  addTeam: (team) =>
    set((s) => ({
      teams: [
        ...s.teams,
        {
          ...team,
          id: uid(),
          order: s.teams.length,
          ...(team.parentId || team.leaderId
            ? { direction: "down" as const }
            : null),
        },
      ],
    })),
  updateTeam: (id, patch) =>
    set((s) => {
      let next: Partial<Team> = { ...patch };
      // No self-parent or cycles; nested teams always sit below me.
      if (next.parentId === id) next = { ...next, parentId: undefined };
      if (next.parentId && isDescendant(s.teams, id, next.parentId)) {
        next = { ...next, parentId: undefined };
      }
      if (next.parentId) next = { ...next, direction: "down" };
      if (next.direction === "up") next = { ...next, parentId: undefined };
      // A team hangs off exactly one thing: a parent team, a direct report, or
      // me. Handing it to someone lifts it out of any parent team, and it can
      // never be a team I report up to.
      if (next.leaderId) {
        next = { ...next, parentId: undefined, direction: "down" };
      }
      if (next.parentId || next.direction === "up") {
        next = { ...next, leaderId: undefined };
      }
      return {
        teams: s.teams.map((t) => (t.id === id ? { ...t, ...next } : t)),
      };
    }),
  deleteTeam: (id) => {
    const before = get();
    set((s) => {
      const peopleIds = new Set(
        s.people.filter((p) => p.teamId === id).map((p) => p.id)
      );
      const { [`team:${id}`]: _chat, ...chats } = s.chats;
      const { [id]: _pos, ...nodePositions } = s.nodePositions;
      return {
        // Orphan sub-teams rather than cascade-delete them. Teams led by
        // someone on this roster come back to me rather than vanishing with
        // their leader.
        teams: s.teams
          .filter((t) => t.id !== id)
          .map((t) => {
            const orphaned = t.parentId === id;
            const lost = t.leaderId ? peopleIds.has(t.leaderId) : false;
            if (!orphaned && !lost) return t;
            return {
              ...t,
              ...(orphaned ? { parentId: undefined } : null),
              ...(lost ? { leaderId: undefined } : null),
            };
          }),
        people: s.people.filter((p) => p.teamId !== id),
        actions: s.actions.filter((a) => !peopleIds.has(a.personId)),
        ...(() => {
          const viaPeople = withoutMeetingsFor(s, "person", peopleIds);
          const doomed = new Set(
            s.meetings
              .filter((m) => m.subjectKind === "team" && m.subjectId === id)
              .map((m) => m.id)
          );
          return {
            meetings: viaPeople.meetings.filter((m) => !doomed.has(m.id)),
            sessions: viaPeople.sessions.filter((o) => !doomed.has(o.meetingId)),
          };
        })(),
        goals: s.goals.filter((g) => !peopleIds.has(g.personId)),
        notes: s.notes.filter((n) => !peopleIds.has(n.personId)),
        wins: s.wins.filter((w) => !peopleIds.has(w.personId)),
        prayers: s.prayers.filter((e) =>
          e.subjectKind === "team"
            ? e.subjectId !== id
            : !(e.subjectKind === "person" && peopleIds.has(e.subjectId))
        ),
        teamActions: s.teamActions.filter((a) => a.teamId !== id),
        teamGoals: s.teamGoals.filter((g) => g.teamId !== id),
        teamNotes: s.teamNotes.filter((n) => n.teamId !== id),
        chats,
        nodePositions,
        collapsedTeams: s.collapsedTeams.filter((t) => t !== id),
      };
    });
    const hitPerson = before.people.some(
      (p) => p.teamId === id && p.id === before.selectedPersonId
    );
    if (before.selectedTeamId === id || hitPerson) leave(before);
  },

  addTeamAction: (teamId, text, dueDate) =>
    set((s) => ({
      teamActions: [
        ...s.teamActions,
        { id: uid(), teamId, text, done: false, dueDate },
      ],
    })),
  updateTeamAction: (id, patch) =>
    set((s) => ({
      teamActions: s.teamActions.map((a) =>
        a.id === id ? { ...a, ...patch } : a
      ),
    })),
  toggleTeamAction: (id) =>
    set((s) => ({
      teamActions: s.teamActions.map((a) =>
        a.id === id ? { ...a, done: !a.done } : a
      ),
    })),
  deleteTeamAction: (id) =>
    set((s) => ({ teamActions: s.teamActions.filter((a) => a.id !== id) })),
  restoreTeamAction: (action) =>
    set((s) => ({ teamActions: [...s.teamActions, action] })),

  addTeamGoal: (teamId, title) =>
    set((s) => ({
      teamGoals: [...s.teamGoals, { id: uid(), teamId, title, progress: 0 }],
    })),
  updateTeamGoal: (id, patch) =>
    set((s) => ({
      teamGoals: s.teamGoals.map((g) => (g.id === id ? { ...g, ...patch } : g)),
    })),
  deleteTeamGoal: (id) =>
    set((s) => ({ teamGoals: s.teamGoals.filter((g) => g.id !== id) })),
  restoreTeamGoal: (goal) =>
    set((s) => ({ teamGoals: [...s.teamGoals, goal] })),

  addTeamNote: (teamId, body) =>
    set((s) => ({
      teamNotes: [
        ...s.teamNotes,
        { id: uid(), teamId, body, date: new Date().toISOString().slice(0, 10) },
      ],
    })),
  deleteTeamNote: (id) =>
    set((s) => ({ teamNotes: s.teamNotes.filter((n) => n.id !== id) })),

  addPerson: (person) => {
    const id = uid();
    set((s) => ({
      people: [
        ...s.people,
        {
          assessments: {},
          strengths: [],
          watchOuts: [],
          customModalities: [],
          ...person,
          id,
        },
      ],
    }));
    return id;
  },
  updatePerson: (id, patch) =>
    set((s) => ({
      people: s.people.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    })),
  updateLeadUp: (personId, patch) =>
    set((s) => ({
      people: s.people.map((p) =>
        p.id === personId ? { ...p, leadUp: { ...p.leadUp, ...patch } } : p
      ),
    })),
  deletePerson: (id) => {
    const before = get();
    set((s) => {
      const { [`person:${id}`]: _pos, ...nodePositions } = s.nodePositions;
      return {
        people: s.people.filter((p) => p.id !== id),
        // Teams they led come back to me — losing the leader must not lose
        // the team.
        teams: s.teams.map((t) =>
          t.leaderId === id ? { ...t, leaderId: undefined } : t
        ),
        actions: s.actions.filter((a) => a.personId !== id),
        ...withoutMeetingsFor(s, "person", new Set([id])),
        goals: s.goals.filter((g) => g.personId !== id),
        notes: s.notes.filter((n) => n.personId !== id),
        wins: s.wins.filter((w) => w.personId !== id),
        prayers: s.prayers.filter(
          (e) => !(e.subjectKind === "person" && e.subjectId === id)
        ),
        nodePositions,
      };
    });
    // Same as closing their panel: back to where it was opened from.
    if (before.selectedPersonId === id) leave(before);
  },
  movePerson: (personId, teamId) =>
    set((s) => ({
      people: s.people.map((p) => (p.id === personId ? { ...p, teamId } : p)),
    })),

  addAction: (personId, text, dueDate, column = "backlog") =>
    set((s) => ({
      actions: [
        ...s.actions,
        {
          id: uid(),
          personId,
          text,
          done: column === "done",
          dueDate,
          column,
        },
      ],
    })),
  updateAction: (id, patch) =>
    set((s) => ({
      actions: s.actions.map((a) => {
        if (a.id !== id) return a;
        const next = { ...a, ...patch };
        if (patch.column !== undefined) {
          next.done = patch.column === "done";
        } else if (patch.done !== undefined) {
          next.column = patch.done ? "done" : a.column === "done" ? "backlog" : a.column;
        }
        return next;
      }),
    })),
  setActionColumn: (id, column) =>
    set((s) => ({
      actions: s.actions.map((a) =>
        a.id === id ? { ...a, column, done: column === "done" } : a
      ),
    })),
  toggleAction: (id) =>
    set((s) => ({
      actions: s.actions.map((a) => {
        if (a.id !== id) return a;
        const done = !a.done;
        return {
          ...a,
          done,
          column: done ? "done" : a.column === "done" ? "backlog" : a.column,
        };
      }),
    })),
  deleteAction: (id) =>
    set((s) => ({ actions: s.actions.filter((a) => a.id !== id) })),

  addTopic: (meetingId, text, opts = {}) => {
    const id = uid();
    set((s) => {
      const last = s.topics
        .filter((t) => t.meetingId === meetingId)
        .reduce((max, t) => Math.max(max, t.order), -1);
      return {
        topics: [
          ...s.topics,
          {
            id,
            meetingId,
            text,
            status: "open",
            lane: opts.lane ?? "backlog",
            sessionId: opts.sessionId,
            slotId: opts.slotId,
            tagIds: slotTagIds(s.meetings, meetingId, opts.tagIds ?? [], opts.slotId),
            carried: 0,
            carriedFrom: [],
            dueDate: opts.dueDate,
            createdOn: todayISO(),
            order: last + 1,
          },
        ],
      };
    });
    return id;
  },
  updateTopic: (id, patch) =>
    set((s) => ({
      topics: s.topics.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })),
  placeTopic: (id, target) =>
    set((s) => ({
      topics: s.topics.map((t) => {
        if (t.id !== id) return t;
        // Dragging a covered card back onto the board reopens it — the board
        // only ever shows what's still live, so being there means it is.
        const reopened = { ...t, status: "open" as const, closedOn: undefined };
        const tagIds = slotTagIds(
          s.meetings,
          t.meetingId,
          t.tagIds,
          target.slotId,
          t.slotId ?? ""
        );
        if ("sessionId" in target) {
          return {
            ...reopened,
            sessionId: target.sessionId,
            slotId: target.slotId,
            tagIds,
          };
        }
        // Parked is defer-not-now; the tag stays so it returns to the same
        // skeleton cell when it comes back.
        if (target.lane === "parked") {
          return { ...reopened, lane: "parked", sessionId: undefined };
        }
        return {
          ...reopened,
          lane: target.lane,
          sessionId: undefined,
          slotId: target.slotId,
          tagIds,
        };
      }),
    })),
  placeTopicAt: (id, target, index) =>
    set((s) => {
      const placed = placement(s, id, target);
      if (!placed) return {};
      return {
        sessions: placed.sessions,
        topics: reorderInto(s.topics, placed.moved, index),
      };
    }),
  placeTopicsAt: (ids, target, index) =>
    set((s) => {
      // Threaded through `sessions`: the first topic onto a projected week books
      // it, and the rest must find that booking instead of making their own.
      let sessions = s.sessions;
      const moved: Topic[] = [];
      for (const id of ids) {
        const placed = placement({ ...s, sessions }, id, target);
        if (!placed) continue;
        sessions = placed.sessions;
        moved.push(placed.moved);
      }
      if (!moved.length) return {};
      return { sessions, topics: reorderManyInto(s.topics, moved, index) };
    }),
  revertTopics: (snapshot) =>
    set((s) => {
      const byId = new Map(snapshot.map((t) => [t.id, t]));
      return { topics: s.topics.map((t) => byId.get(t.id) ?? t) };
    }),

  captureTopics: (raw, target, index) => {
    const created: string[] = [];
    set((s) => {
      const lines = splitCaptureLines(raw);
      if (!lines.length) return {};

      let tags = s.tags;
      let topics = s.topics;
      let sessions = s.sessions;

      /*
       * Where the capture box was: a real occurrence, or a projected one the
       * board is only drawing from the rhythm.
       *
       * Projected columns used to fall through to `undefined` here, so typing
       * into next Friday quietly filed the topic in the idea bucket instead —
       * the card simply wasn't where it had just been typed. Book the
       * occurrence on the way in, exactly as dropping a card there does.
       */
      let targetSession: string | undefined;
      if (target?.kind === "session") {
        targetSession = target.sessionId;
      } else if (target?.kind === "projected" && target.meetingId) {
        const meeting = s.meetings.find((m) => m.id === target.meetingId);
        const booked = bookOccurrence(
          sessions,
          meeting,
          { meetingId: target.meetingId, date: target.date },
          s.topics,
          "placement"
        );
        sessions = booked.sessions;
        targetSession = booked.sessionId;
      }
      const sessionMeeting = targetSession
        ? sessions.find((o) => o.id === targetSession)?.meetingId
        : undefined;

      // `@frontier` should match what the user sees, which is the meeting's
      // own name when it has one and the subject's otherwise.
      const labelOf = (m: TrackedMeeting) =>
        m.name ??
        (m.subjectKind === "person"
          ? s.people.find((x) => x.id === m.subjectId)?.name
          : m.subjectKind === "team"
            ? s.teams.find((x) => x.id === m.subjectId)?.name
            : s.managers.find((x) => x.id === m.subjectId)?.name) ??
        "";

      for (const line of lines) {
        const parsed = parseCapture(line);
        if (!parsed.text) continue;

        const tagIds: string[] = [];
        for (const label of parsed.tagLabels) {
          const found = findTag(label, tags);
          if (found) {
            tagIds.push(found.id);
            continue;
          }
          const tag: Tag = {
            id: uid(),
            label: label.charAt(0).toUpperCase() + label.slice(1),
            color: tags.length % 6,
            order: tags.length,
          };
          tags = [...tags, tag];
          tagIds.push(tag.id);
        }

        let meetingId = target?.meetingId;
        if (parsed.meetingQuery) {
          const m = findMeeting(parsed.meetingQuery, s.meetings, labelOf);
          if (m) meetingId = m.id;
        }

        const id = uid();
        created.push(id);
        // An explicit `@other-meeting` overrules the column it was typed into,
        // so it must not keep this meeting's occurrence.
        const sessionId =
          sessionMeeting && sessionMeeting === meetingId ? targetSession : undefined;
        const topic: Topic = {
          id,
          meetingId,
          text: parsed.text,
          status: "open",
          lane: target?.kind === "lane" ? target.lane : "backlog",
          sessionId,
          slotId: target?.slotId,
          tagIds: slotTagIds(s.meetings, meetingId, tagIds, target?.slotId),
          urgent: parsed.urgent || undefined,
          carried: 0,
          carriedFrom: [],
          createdOn: todayISO(),
          order: 0,
        };
        topics = reorderInto([...topics, topic], topic, index);
      }
      // Nothing captured ⇒ nothing booked. Returning `{}` drops the projected
      // occurrence we speculatively created above.
      return created.length ? { tags, topics, sessions } : {};
    });
    return created;
  },

  returnTopic: (id) =>
    set((s) => {
      const topic = s.topics.find((t) => t.id === id);
      if (!topic?.sessionId) return {};
      const session = s.sessions.find((o) => o.id === topic.sessionId);
      const moved: Topic = {
        ...topic,
        sessionId: undefined,
        lane: "backlog",
        carried: topic.carried + 1,
        carriedFrom: [...(topic.carriedFrom ?? []), topic.sessionId],
        returnedOn: todayISO(),
        returnedFromDate: session?.date,
      };
      return {
        sessions: s.sessions.map((o) =>
          o.id === session?.id
            ? {
                ...o,
                uncovered: [...new Set([...(o.uncovered ?? []), topic.text])],
              }
            : o
        ),
        topics: reorderInto(s.topics, moved, 0),
      };
    }),

  /*
   * Hand back anything an occurrence passed without covering — onto the next
   * occurrence of the same meeting, not into the backlog. A topic that keeps
   * sliding says so right on the card (`rollTopic` stamps the trail); landing
   * back on the board is what makes that visible without forcing a re-triage
   * decision every single week. Only a meeting with nowhere left to project
   * (paused, or no rhythm at all) falls back to the backlog, same as the
   * manual roll-forward already does.
   */
  sweepReturns: () => {
    const today = todayISO();
    const due = get().topics.filter((t) => {
      if (t.status !== "open" || !t.sessionId) return false;
      const session = get().sessions.find((o) => o.id === t.sessionId);
      return Boolean(session && session.date < today);
    });
    for (const topic of due) {
      const session = get().sessions.find((o) => o.id === topic.sessionId);
      const meeting = session
        ? get().meetings.find((m) => m.id === session.meetingId)
        : undefined;
      let nextSessionId: string | undefined;
      if (meeting) {
        const slots = plannedSlots(meeting, get().sessions, get().topics, today);
        const next = nextSlotAfter(slots, topic.sessionId);
        if (next) {
          nextSessionId =
            next.sessionId ??
            get().addSession({ meetingId: meeting.id, date: next.date });
        }
      }
      get().rollTopic(topic.id, nextSessionId);
    }
    return due.length;
  },

  addTag: (label) => {
    const trimmed = label.trim();
    if (!trimmed) return "";
    const id = uid();
    set((s) => ({
      tags: [
        ...s.tags,
        { id, label: trimmed, color: s.tags.length % 6, order: s.tags.length },
      ],
    }));
    return id;
  },
  updateTag: (id, patch) =>
    set((s) => ({
      tags: s.tags.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })),
  deleteTag: (id) =>
    set((s) => ({
      tags: s.tags.filter((t) => t.id !== id),
      topics: s.topics.map((t) =>
        t.tagIds.includes(id)
          ? { ...t, tagIds: t.tagIds.filter((x) => x !== id) }
          : t
      ),
      // A slot or a target pointing at a dead tag would silently stop working.
      meetings: s.meetings.map((m) => ({
        ...m,
        curriculum: m.curriculum?.map((c) =>
          c.tagId === id ? { ...c, tagId: undefined } : c
        ),
        coverageTargets: m.coverageTargets?.filter((c) => c.tagId !== id),
      })),
    })),

  tagTopics: (ids, tagId, on) =>
    set((s) => {
      const set_ = new Set(ids);
      return {
        topics: s.topics.map((t) => {
          if (!set_.has(t.id)) return t;
          const has = (t.tagIds ?? []).includes(tagId);
          if (has === on) return t;
          return {
            ...t,
            tagIds: on
              ? [...t.tagIds, tagId]
              : t.tagIds.filter((x) => x !== tagId),
          };
        }),
      };
    }),
  assignTopics: (ids, meetingId) =>
    set((s) => {
      const set_ = new Set(ids);
      return {
        topics: s.topics.map((t) =>
          set_.has(t.id)
            ? { ...t, meetingId: meetingId ?? undefined, slotId: undefined }
            : t
        ),
      };
    }),
  parkTopics: (ids, parked) =>
    set((s) => {
      const set_ = new Set(ids);
      return {
        topics: s.topics.map((t) =>
          set_.has(t.id) ? { ...t, lane: parked ? "parked" : "backlog" } : t
        ),
      };
    }),
  deleteTopics: (ids) =>
    set((s) => {
      const set_ = new Set(ids);
      return { topics: s.topics.filter((t) => !set_.has(t.id)) };
    }),

  addFollowUp: (subjectKind, subjectId, text, opts = {}) => {
    const trimmed = text.trim();
    if (!trimmed) return "";
    const id = uid();
    set((s) => ({
      followUps: [
        ...s.followUps,
        {
          id,
          subjectKind,
          subjectId,
          meetingId: opts.meetingId,
          text: trimmed,
          status: "open",
          openedOn: todayISO(),
          sourceSessionId: opts.sourceSessionId,
          order: s.followUps.length,
        },
      ],
    }));
    return id;
  },
  toggleFollowUp: (id) =>
    set((s) => ({
      followUps: s.followUps.map((f) => {
        if (f.id !== id) return f;
        const done = f.status === "open";
        return {
          ...f,
          status: done ? "done" : "open",
          closedOn: done ? todayISO() : undefined,
        };
      }),
    })),
  updateFollowUp: (id, patch) =>
    set((s) => ({
      followUps: s.followUps.map((f) => (f.id === id ? { ...f, ...patch } : f)),
    })),
  deleteFollowUp: (id) =>
    set((s) => ({ followUps: s.followUps.filter((f) => f.id !== id) })),

  addGlossaryTerm: (meant, heard) => {
    const m = meant.trim();
    const h = heard?.trim() || undefined;
    if (!m || (h && h.toLowerCase() === m.toLowerCase())) return "";
    const same = (g: GlossaryTerm) =>
      h ? g.heard?.toLowerCase() === h.toLowerCase() : !g.heard && g.meant.toLowerCase() === m.toLowerCase();
    const existing = get().glossary.find(same);
    if (existing) {
      if (existing.meant !== m) {
        set((s) => ({ glossary: s.glossary.map((g) => (g.id === existing.id ? { ...g, meant: m } : g)) }));
      }
      return existing.id;
    }
    const id = uid();
    set((s) => ({ glossary: [...s.glossary, { id, heard: h, meant: m, createdOn: todayISO() }] }));
    return id;
  },
  deleteGlossaryTerm: (id) => set((s) => ({ glossary: s.glossary.filter((g) => g.id !== id) })),

  addFixture: (subjectKind, subjectId, title, opts = {}) => {
    const t = title.trim();
    if (!t) return "";
    const id = uid();
    set((s) => ({
      fixtures: [
        ...s.fixtures,
        {
          id,
          subjectKind,
          subjectId,
          title: t,
          owner: opts.owner?.trim() || undefined,
          cadence: opts.cadence ?? "monthly",
          notes: opts.notes?.trim() || undefined,
          lastTouchedOn: opts.lastTouchedOn,
          createdOn: todayISO(),
          order: s.fixtures.length,
        },
      ],
    }));
    return id;
  },
  updateFixture: (id, patch) =>
    set((s) => ({ fixtures: s.fixtures.map((f) => (f.id === id ? { ...f, ...patch } : f)) })),
  deleteFixture: (id) => set((s) => ({ fixtures: s.fixtures.filter((f) => f.id !== id) })),

  addKnowledge: (subjectKind, subjectId, kind, text, opts = {}) => {
    const t = text.trim();
    if (!t) return "";
    const id = uid();
    set((s) => ({
      knowledge: [
        ...s.knowledge,
        { id, subjectKind, subjectId, kind, text: t, sessionId: opts.sessionId, notedOn: opts.notedOn ?? todayISO() },
      ],
    }));
    return id;
  },
  updateKnowledge: (id, patch) =>
    set((s) => ({ knowledge: s.knowledge.map((k) => (k.id === id ? { ...k, ...patch } : k)) })),
  deleteKnowledge: (id) => set((s) => ({ knowledge: s.knowledge.filter((k) => k.id !== id) })),

  addArc: (input) => {
    const id = uid();
    set((s) => ({
      arcs: [
        ...s.arcs,
        {
          ...input,
          id,
          status: input.status ?? "active",
          createdOn: todayISO(),
          order: s.arcs.filter((a) => a.meetingId === input.meetingId).length,
        },
      ],
    }));
    return id;
  },
  updateArc: (id, patch) =>
    set((s) => ({ arcs: s.arcs.map((a) => (a.id === id ? { ...a, ...patch } : a)) })),
  deleteArc: (id) =>
    set((s) => ({
      arcs: s.arcs.filter((a) => a.id !== id),
      takeaways: s.takeaways.filter((t) => t.arcId !== id),
    })),
  markArcStep: (arcId, stepId, sessionId, mark) =>
    set((s) => {
      const arc = s.arcs.find((a) => a.id === arcId);
      const step = arc?.steps.find((x) => x.id === stepId);
      if (!arc || !step) return {};
      const meeting = s.meetings.find((m) => m.id === arc.meetingId);
      const next = markStep(arc, stepId, sessionId, mark);
      // Read → Talk → Try: the practice is what changes people, so it opens
      // the next meeting as "Since last time" — owned by both chairs.
      const text = practiceText(step);
      const practice =
        mark === "done" &&
        step.practice &&
        meeting &&
        !s.followUps.some((f) => f.meetingId === meeting.id && f.text === text)
          ? [
              {
                id: uid(),
                subjectKind: meeting.subjectKind,
                subjectId: meeting.subjectId,
                meetingId: meeting.id,
                text,
                status: "open" as const,
                openedOn: todayISO(),
                sourceSessionId: sessionId,
                order: s.followUps.length,
                owner: "both" as const,
              },
            ]
          : [];
      return {
        arcs: s.arcs.map((a) => (a.id === arcId ? next : a)),
        ...(practice.length ? { followUps: [...s.followUps, ...practice] } : {}),
      };
    }),
  unmarkArcStep: (arcId, stepId, sessionId) =>
    set((s) => {
      const arc = s.arcs.find((a) => a.id === arcId);
      const step = arc?.steps.find((x) => x.id === stepId);
      if (!arc || !step) return {};
      // The practice it opened goes too, unless it was already ticked off —
      // that would be undoing something that happened.
      const text = practiceText(step);
      return {
        arcs: s.arcs.map((a) => (a.id === arcId ? unmarkStep(a, stepId, sessionId) : a)),
        followUps: s.followUps.filter(
          (f) =>
            !(
              f.meetingId === arc.meetingId &&
              f.text === text &&
              f.sourceSessionId === sessionId &&
              f.status === "open"
            )
        ),
      };
    }),
  passArc: (arcId, sessionId) =>
    set((s) => ({
      arcs: s.arcs.map((a) =>
        a.id === arcId && !a.passedIn?.includes(sessionId)
          ? { ...a, passedIn: [...(a.passedIn ?? []), sessionId] }
          : a
      ),
    })),
  moveArcSteps: (arcId, wait, unwait) => {
    const s = get();
    const arc = s.arcs.find((a) => a.id === arcId);
    if (!arc) return () => {};
    const created: Session[] = wait
      .filter((w) => !w.sessionId)
      .map((w) => ({ id: uid(), meetingId: arc.meetingId, date: w.date }));
    const waitIds = [
      ...wait.filter((w) => w.sessionId).map((w) => w.sessionId as string),
      ...created.map((o) => o.id),
    ];
    const before = arc.passedIn;
    const next = [...(arc.passedIn ?? []).filter((id) => !unwait.includes(id)), ...waitIds];
    set((st) => ({
      sessions: [...st.sessions, ...created],
      arcs: st.arcs.map((a) => (a.id === arcId ? { ...a, passedIn: next.length ? next : undefined } : a)),
    }));
    return () =>
      set((st) => {
        const createdIds = new Set(created.map((o) => o.id));
        const used = new Set(st.topics.map((t) => t.sessionId).filter(Boolean));
        return {
          sessions: st.sessions.filter((o) => !createdIds.has(o.id) || used.has(o.id)),
          arcs: st.arcs.map((a) => (a.id === arcId ? { ...a, passedIn: before } : a)),
        };
      });
  },
  setTakeaway: (arcId, stepId, text) =>
    set((s) => {
      const id = takeawayId(stepId, "owner");
      const trimmed = text.trim();
      const rest = s.takeaways.filter((t) => t.id !== id);
      if (!trimmed) return { takeaways: rest };
      const prev = s.takeaways.find((t) => t.id === id);
      if (prev?.text === text) return {};
      return {
        takeaways: [...rest, { id, arcId, stepId, by: "owner", text, on: todayISO() }],
      };
    }),
  setSharedNote: (meetingId, sessionId, body) =>
    set((s) => {
      const id = sharedNoteId(sessionId, "owner");
      const rest = s.sharedNotes.filter((n) => n.id !== id);
      if (!body.trim()) return { sharedNotes: rest };
      return {
        sharedNotes: [
          ...rest,
          { id, meetingId, sessionId, by: "owner", body, updatedOn: todayISO() },
        ],
      };
    }),

  loadShares: async () => {
    if (DEMO || get().phase !== "ready") return;
    try {
      const [shares, sharedWithMe] = await Promise.all([
        sharesApi.listShares(),
        sharesApi.listSharedWithMe(),
      ]);
      set({ shares, sharedWithMe });
    } catch (e) {
      // Sharing is additive: the workspace works without knowing who else
      // sits at a meeting, so a failed read never interrupts anything.
      console.error("Polarch: could not load shares", e);
    }
  },
  createShare: async (input) => {
    const share = await sharesApi.createShare(input);
    set((s) => ({ shares: [...s.shares.filter((x) => x.id !== share.id), share] }));
    return share;
  },
  revokeShare: async (id) => {
    await sharesApi.revokeShare(id);
    set((s) => ({ shares: s.shares.filter((x) => x.id !== id) }));
  },
  promoteToFollowUp: (topicId) =>
    set((s) => {
      const topic = s.topics.find((t) => t.id === topicId);
      const meeting = topic?.meetingId
        ? s.meetings.find((m) => m.id === topic.meetingId)
        : undefined;
      if (!topic || !meeting) return {};
      return {
        followUps: [
          ...s.followUps,
          {
            id: uid(),
            subjectKind: meeting.subjectKind,
            subjectId: meeting.subjectId,
            meetingId: meeting.id,
            text: topic.text,
            status: "open" as const,
            openedOn: todayISO(),
            sourceSessionId: topic.sessionId,
            order: s.followUps.length,
          },
        ],
        topics: s.topics.map((t) =>
          t.id === topicId
            ? { ...t, status: "dropped" as const, closedOn: todayISO() }
            : t
        ),
      };
    }),

  coverTopic: (id, covered = true) =>
    set((s) => ({
      topics: s.topics.map((t) =>
        t.id === id
          ? covered
            ? { ...t, status: "covered", closedOn: todayISO() }
            : { ...t, status: "open", closedOn: undefined }
          : t
      ),
    })),
  quickCloseMeeting: (sessionId, dispositions, notes) =>
    set((s) => {
      const closed = applyQuickClose(
        {
          meetings: s.meetings,
          sessions: s.sessions,
          topics: s.topics,
          followUps: s.followUps,
          tags: s.tags,
        },
        { uid, today: todayISO() },
        { sessionId, dispositions, notes }
      );
      return {
        meetings: closed.meetings,
        sessions: closed.sessions,
        topics: closed.topics,
      };
    }),
  rollTopic: (id, sessionId) =>
    set((s) => {
      const topic = s.topics.find((t) => t.id === id);
      const from = topic?.sessionId
        ? s.sessions.find((o) => o.id === topic.sessionId)
        : undefined;
      return {
        // The session being left keeps an honest ledger of what it didn't
        // cover, independent of wherever the topic lands next.
        sessions: from
          ? s.sessions.map((o) =>
              o.id === from.id
                ? {
                    ...o,
                    uncovered: [
                      ...new Set([...(o.uncovered ?? []), topic!.text]),
                    ],
                  }
                : o
            )
          : s.sessions,
        topics: s.topics.map((t) =>
          t.id === id
            ? {
                ...t,
                status: "open",
                closedOn: undefined,
                sessionId,
                // The count is the honest signal: a topic pushed three times is
                // telling you something a due date never would.
                carried: t.carried + 1,
                carriedFrom: from
                  ? [...(t.carriedFrom ?? []), from.id]
                  : t.carriedFrom,
                returnedOn: from ? todayISO() : t.returnedOn,
                returnedFromDate: from ? from.date : t.returnedFromDate,
              }
            : t
        ),
      };
    }),
  deleteTopic: (id) =>
    set((s) => ({ topics: s.topics.filter((t) => t.id !== id) })),
  // The board sorts by `order`, so the card comes back in its own place
  // rather than at the end of the lane.
  restoreTopic: (topic) => set((s) => ({ topics: [...s.topics, topic] })),
  moveTopic: (id, direction) => {
    const topic = get().topics.find((t) => t.id === id);
    if (!topic) return null;

    // "Beside it" is what the user can see: the same section of the same week
    // on the board, or the same lane. Reordering against the whole meeting
    // would move a card past rows that aren't on screen, and the card would
    // visibly refuse to budge.
    const curriculum =
      get().meetings.find((m) => m.id === topic.meetingId)?.curriculum ?? [];
    const row = effectiveSlotId(topic, curriculum);
    const siblings = get()
      .topics.filter(
        (t) =>
          t.meetingId === topic.meetingId &&
          t.sessionId === topic.sessionId &&
          (t.sessionId ? true : t.lane === topic.lane) &&
          effectiveSlotId(t, curriculum) === row &&
          (topic.status === "open" ? t.status === "open" : t.status !== "open")
      )
      .sort((a, b) => a.order - b.order);

    const at = siblings.findIndex((t) => t.id === id);
    const to = at + direction;
    if (at === -1 || to < 0 || to >= siblings.length) return null;

    // Renumber the whole run rather than swapping two values. Seeded and
    // migrated topics can share an `order`, and swapping equal numbers moves
    // nothing — the row would visibly refuse to budge.
    const reordered = [...siblings];
    const [moved] = reordered.splice(at, 1);
    reordered.splice(to, 0, moved);
    const orderById = new Map(reordered.map((t, i) => [t.id, i]));

    set((s) => ({
      topics: s.topics.map((t) =>
        orderById.has(t.id) ? { ...t, order: orderById.get(t.id)! } : t
      ),
    }));
    return { index: to, total: siblings.length };
  },

  trackMeeting: (subjectKind, subjectId, rhythm, patch) => {
    const existing = get().meetings.find(
      (m) => m.subjectKind === subjectKind && m.subjectId === subjectId
    );
    if (existing) {
      get().updateMeeting(existing.id, { rhythm, ...patch });
      return existing.id;
    }
    return get().createMeeting(subjectKind, subjectId, { rhythm, ...patch });
  },
  createMeeting: (subjectKind, subjectId, patch) => {
    const id = uid();
    const curriculum = patch?.curriculum ?? defaultCurriculum(subjectKind);
    set((s) => ({
      meetings: [
        ...s.meetings,
        {
          id,
          subjectKind,
          subjectId,
          rhythm: "weekly",
          ...patch,
          curriculum: curriculum.length ? curriculum : undefined,
        },
      ],
      // Tracking answers the opt-in question, so the decision flag is moot.
      ...clearNoMeeting(s, subjectKind, subjectId),
    }));
    return id;
  },
  updateMeeting: (id, patch) =>
    set((s) => ({
      meetings: s.meetings.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    })),
  setCurriculum: (meetingId, curriculum) => {
    const slots = curriculum?.filter((s) => s.label.trim()) ?? [];
    const ids = new Set(slots.map((s) => s.id));
    set((s) => ({
      meetings: s.meetings.map((m) =>
        m.id === meetingId
          ? { ...m, curriculum: slots.length ? slots : undefined }
          : m
      ),
      topics: s.topics.map((t) =>
        t.meetingId === meetingId && t.slotId && !ids.has(t.slotId)
          ? { ...t, slotId: undefined }
          : t
      ),
    }));
  },
  moveOccurrence: (meetingId, from, to, scope) => {
    if (scope === "series") {
      const weekday = weekdayOf(to);
      get().setMeetingWeekday(meetingId, weekday);
      // Re-anchoring carries booked weeks along within their week. When that
      // already put this occurrence on the requested day, we're done.
      const landed = get().sessions.find(
        (o) => o.meetingId === meetingId && o.date === to && o.kind !== "skipped"
      );
      if (landed) return landed.id;
      let sameWeek = addDaysISO(from.date, weekday - weekdayOf(from.date));
      if (sameWeek < todayISO()) sameWeek = addDaysISO(sameWeek, 7);
      if (!from.sessionId && sameWeek === to) {
        // The new rhythm draws this date itself; just make it real.
        return get().addSession({ meetingId, date: to });
      }
      // Otherwise it was asked to go to a different week as well: fall through
      // and move this one on top of the new rhythm.
      if (from.sessionId) {
        const moved = get().sessions.find((o) => o.id === from.sessionId);
        if (moved) from = { sessionId: moved.id, date: moved.date };
      } else {
        from = { sessionId: null, date: sameWeek };
      }
    }
    let result = "";
    set((s) => {
      let sessions = s.sessions;
      let topics = s.topics;
      const current = from.sessionId
        ? sessions.find((o) => o.id === from.sessionId)
        : sessions.find(
            (o) => o.meetingId === meetingId && o.date === from.date && o.kind !== "skipped"
          );
      const seriesDate =
        current?.kind === "extra"
          ? undefined
          : (current?.seriesDate ?? current?.date ?? from.date);
      const clash = sessions.find(
        (o) =>
          o.meetingId === meetingId &&
          o.date === to &&
          o.kind !== "skipped" &&
          o.id !== current?.id
      );
      if (clash) {
        // Something is already on that day: the two become one meeting.
        if (current) {
          topics = topics.map((t) =>
            t.sessionId === current.id ? { ...t, sessionId: clash.id } : t
          );
          // Keep any prep written on the one being folded in.
          const extraNotes = current.notes?.trim();
          sessions = sessions
            .filter((o) => o.id !== current.id)
            .map((o) =>
              o.id === clash.id && extraNotes && extraNotes !== o.notes?.trim()
                ? { ...o, notes: [o.notes?.trim(), extraNotes].filter(Boolean).join("\n\n") }
                : o
            );
        }
        result = clash.id;
        return { sessions, topics };
      }
      const fields = {
        date: to,
        seriesDate: seriesDate && seriesDate !== to ? seriesDate : undefined,
      };
      if (current) {
        sessions = sessions.map((o) => (o.id === current.id ? { ...o, ...fields } : o));
        result = current.id;
      } else {
        result = uid();
        sessions = [...sessions, { id: result, meetingId, ...fields }];
      }
      return { sessions, topics };
    });
    return result;
  },
  skipOccurrence: (meetingId, from) =>
    set((s) => {
      const current = from.sessionId
        ? s.sessions.find((o) => o.id === from.sessionId)
        : s.sessions.find((o) => o.meetingId === meetingId && o.date === from.date);
      // A past meeting that was written up happened. Nothing to skip.
      if (current?.notes?.trim() && current.date < todayISO()) return {};
      const topics = current
        ? s.topics.map((t) =>
            t.sessionId === current.id
              ? { ...t, sessionId: undefined, lane: "backlog" as const }
              : t
          )
        : s.topics;
      if (current?.kind === "extra") {
        // A one-off that isn't happening simply isn't there.
        return { topics, sessions: s.sessions.filter((o) => o.id !== current.id) };
      }
      const seriesDate = current?.seriesDate ?? current?.date ?? from.date;
      const skipped = { date: seriesDate, seriesDate, kind: "skipped" as const };
      return {
        topics,
        sessions: current
          ? s.sessions.map((o) => (o.id === current.id ? { ...o, ...skipped } : o))
          : [...s.sessions, { id: uid(), meetingId, ...skipped }],
      };
    }),
  restoreOccurrence: (sessionId) =>
    set((s) => {
      const o = s.sessions.find((x) => x.id === sessionId);
      if (!o) return {};
      if (o.kind === "skipped") {
        return { sessions: s.sessions.filter((x) => x.id !== sessionId) };
      }
      if (!o.seriesDate) return {};
      const clash = s.sessions.find(
        (x) => x.meetingId === o.meetingId && x.date === o.seriesDate && x.id !== o.id
      );
      if (clash) return {};
      return {
        sessions: s.sessions.map((x) =>
          x.id === sessionId ? { ...x, date: o.seriesDate!, seriesDate: undefined } : x
        ),
      };
    }),
  pushBack: (meetingId, from, { skip }) => {
    const s = get();
    const meeting = s.meetings.find((m) => m.id === meetingId);
    if (!meeting) return null;
    const plan = pushBackPlan(meeting, s.sessions, s.topics, from.date);
    const fromHeld =
      (from.sessionId && s.sessions.find((o) => o.id === from.sessionId)) ||
      s.sessions.find((o) => o.meetingId === meetingId && o.date === from.date && o.kind !== "skipped");

    // Weeks that aren't booked yet are booked to hold what lands in them.
    const created: Session[] = [];
    const sessionOn = (date: string, existing: string | null) => {
      if (existing) return existing;
      const made = created.find((o) => o.date === date);
      if (made) return made.id;
      if (occurrenceGuardOn()) {
        const held = s.sessions.find(
          (o) => o.meetingId === meetingId && o.date === date && o.kind !== "skipped"
        );
        if (held) return held.id;
      }
      const o: Session = { id: uid(), meetingId, date };
      created.push(o);
      return o.id;
    };
    const to = new Map(plan.moves.map((m) => [m.topicId, sessionOn(m.toDate, m.toSessionId)]));
    const was = new Map(plan.moves.map((m) => [m.topicId, s.topics.find((t) => t.id === m.topicId)?.sessionId]));

    // A week that still happens but is pushed: its arc steps wait a week too.
    // (A skipped week isn't an occurrence at all, so arcs slide on their own.)
    const arcsToPass = skip ? [] : liveArcs(s.arcs, meetingId).filter((a) => a.status === "active");
    const fromId = arcsToPass.length ? sessionOn(from.date, fromHeld?.id ?? null) : fromHeld?.id ?? null;
    const passed = arcsToPass.filter((a) => fromId && !a.passedIn?.includes(fromId)).map((a) => a.id);

    const sessionsBefore = new Set(s.sessions.map((o) => o.id));
    set((st) => ({
      topics: st.topics.map((t) => (to.has(t.id) ? { ...t, sessionId: to.get(t.id) } : t)),
      sessions: [...st.sessions, ...created],
      arcs: passed.length
        ? st.arcs.map((a) => (passed.includes(a.id) ? { ...a, passedIn: [...(a.passedIn ?? []), fromId!] } : a))
        : st.arcs,
    }));
    if (skip) get().skipOccurrence(meetingId, { sessionId: fromHeld?.id ?? null, date: from.date });

    const undo = () =>
      set((st) => {
        const createdIds = new Set(created.map((o) => o.id));
        const topics = st.topics.map((t) =>
          to.has(t.id) && t.sessionId === to.get(t.id) ? { ...t, sessionId: was.get(t.id) } : t
        );
        // Weeks booked for the push go again, unless something else has been put in them since.
        const stillUsed = new Set(topics.map((t) => t.sessionId).filter(Boolean));
        let sessions = st.sessions.filter((o) => !createdIds.has(o.id) || stillUsed.has(o.id));
        if (skip) {
          sessions = fromHeld
            ? sessions.map((o) => (o.id === fromHeld.id ? fromHeld : o))
            : sessions.filter(
                (o) => sessionsBefore.has(o.id) || !(o.meetingId === meetingId && o.kind === "skipped" && o.seriesDate === from.date)
              );
        }
        const arcs = passed.length
          ? st.arcs.map((a) =>
              passed.includes(a.id) ? { ...a, passedIn: (a.passedIn ?? []).filter((id) => id !== fromId) } : a
            )
          : st.arcs;
        return { topics, sessions, arcs };
      });
    return { moved: plan.moves.length, weeks: plan.weeks, arcs: passed.length, undo };
  },
  addExtraOccurrence: (meetingId, date) => {
    const existing = get().sessions.find(
      (o) => o.meetingId === meetingId && o.date === date && o.kind !== "skipped"
    );
    if (existing) return existing.id;
    const id = uid();
    set((s) => ({ sessions: [...s.sessions, { id, meetingId, date, kind: "extra" }] }));
    return id;
  },
  setMeetingWeekday: (meetingId, weekday) =>
    set((s) => {
      const meeting = s.meetings.find((m) => m.id === meetingId);
      if (!meeting) return {};
      const today = todayISO();
      // A one-off booking on the old day would keep overriding the new one.
      const nextDate =
        weekday !== undefined &&
        meeting.nextDate &&
        meeting.nextDate >= today &&
        weekdayOf(meeting.nextDate) !== weekday
          ? undefined
          : meeting.nextDate;
      const meetings = s.meetings.map((m) =>
        m.id === meetingId ? { ...m, anchorWeekday: weekday, nextDate } : m
      );
      if (weekday === undefined) return { meetings };

      // Only upcoming occurrences; a past meeting happened on the day it did.
      // Notes on a future one are prep (opening a week seeds an agenda), so
      // they travel with it.
      // Moved one-offs and extras are deliberate exceptions and stay put.
      const movable = s.sessions.filter(
        (o) =>
          o.meetingId === meetingId &&
          o.date >= today &&
          !o.kind &&
          !o.seriesDate &&
          weekdayOf(o.date) !== weekday
      );

      const shift = (d: string) => {
        let next = addDaysISO(d, weekday - weekdayOf(d));
        if (next < today) next = addDaysISO(next, 7);
        return next;
      };
      // Exceptions name a series date; the series just moved, so follow it —
      // a skipped Monday becomes a skipped Tuesday, not a stray Tuesday meeting.
      let sessions = s.sessions.map((o) => {
        if (o.meetingId !== meetingId || !o.seriesDate || o.seriesDate < today) return o;
        const seriesDate = shift(o.seriesDate);
        if (seriesDate === o.seriesDate) return o;
        return o.kind === "skipped"
          ? { ...o, date: seriesDate, seriesDate }
          : { ...o, seriesDate: seriesDate === o.date ? undefined : seriesDate };
      });
      if (!movable.length) return { meetings, sessions };

      let topics = s.topics;
      for (const o of movable) {
        // Same week, new day; never into the past.
        let date = addDaysISO(o.date, weekday - weekdayOf(o.date));
        if (date < today) date = addDaysISO(date, 7);
        const clash = sessions.find(
          (x) => x.meetingId === meetingId && x.id !== o.id && x.date === date
        );
        if (clash) {
          // The target day is already booked: fold this one's topics into it.
          topics = topics.map((t) =>
            t.sessionId === o.id ? { ...t, sessionId: clash.id } : t
          );
          const extraNotes = o.notes?.trim();
          sessions = sessions
            .filter((x) => x.id !== o.id)
            .map((x) =>
              x.id === clash.id && extraNotes && extraNotes !== x.notes?.trim()
                ? { ...x, notes: [x.notes?.trim(), extraNotes].filter(Boolean).join("\n\n") }
                : x
            );
        } else {
          sessions = sessions.map((x) => (x.id === o.id ? { ...x, date } : x));
        }
      }
      return { meetings, sessions, topics };
    }),
  addMeetingRow: (meetingId, label) => {
    const text = label.trim();
    if (!text) return undefined;
    const meeting = get().meetings.find((m) => m.id === meetingId);
    if (!meeting) return undefined;
    const curriculum = meeting.curriculum ?? [];
    const lower = text.toLowerCase();
    const existing = curriculum.find((c) => c.label.trim().toLowerCase() === lower);
    if (existing) return existing.id;

    const slotId = uid();
    set((s) => {
      let tags = s.tags;
      let tag = tags.find((t) => t.label.trim().toLowerCase() === lower);
      if (!tag) {
        tag = { id: uid(), label: text, color: tags.length % 6, order: tags.length };
        tags = [...tags, tag];
      }
      const tagId = tag.id;
      return {
        tags,
        meetings: s.meetings.map((m) =>
          m.id === meetingId
            ? {
                ...m,
                curriculum: [...(m.curriculum ?? []), { id: slotId, label: tag.label, tagId }],
              }
            : m
        ),
        // Already tagged this? Then it already belongs in the row.
        topics: s.topics.map((t) =>
          t.meetingId === meetingId && !t.slotId && t.tagIds.includes(tagId)
            ? { ...t, slotId }
            : t
        ),
      };
    });
    return slotId;
  },
  untrackMeeting: (id) =>
    set((s) => ({
      meetings: s.meetings.filter((m) => m.id !== id),
      sessions: s.sessions.filter((o) => o.meetingId !== id),
      topics: s.topics.filter((t) => t.meetingId !== id),
    })),
  setNoMeeting: (subjectKind, subjectId, value) =>
    set((s) => {
      const flag = value ? true : undefined;
      if (subjectKind === "person") {
        return {
          people: s.people.map((p) =>
            p.id === subjectId ? { ...p, noMeeting: flag } : p
          ),
        };
      }
      if (subjectKind === "team") {
        return {
          teams: s.teams.map((t) =>
            t.id === subjectId ? { ...t, noMeeting: flag } : t
          ),
        };
      }
      return {
        managers: s.managers.map((m) =>
          m.id === subjectId ? { ...m, noMeeting: flag } : m
        ),
      };
    }),

  addSession: (o) => {
    let sessionId = "";
    set((s) => {
      const meeting = s.meetings.find((m) => m.id === o.meetingId);
      const booked = bookOccurrence(s.sessions, meeting, o, s.topics, "addSession");
      sessionId = booked.sessionId;
      if (booked.sessions === s.sessions) return {};
      return { sessions: booked.sessions };
    });
    return sessionId;
  },
  updateSession: (id, patch) =>
    set((s) => ({
      sessions: s.sessions.map((o) => (o.id === id ? { ...o, ...patch } : o)),
    })),
  deleteSession: (id) =>
    set((s) => ({
      sessions: s.sessions.filter((o) => o.id !== id),
      // Anything planned for it goes back to the backlog rather than vanishing
      // into a slot that no longer exists.
      topics: s.topics.map((t) =>
        t.sessionId === id ? { ...t, sessionId: undefined } : t
      ),
    })),

  addGoal: (g) => set((s) => ({ goals: [...s.goals, { ...g, id: uid() }] })),
  updateGoal: (id, patch) =>
    set((s) => ({
      goals: s.goals.map((g) => (g.id === id ? { ...g, ...patch } : g)),
    })),
  deleteGoal: (id) =>
    set((s) => ({ goals: s.goals.filter((g) => g.id !== id) })),
  restoreGoal: (goal) => set((s) => ({ goals: [...s.goals, goal] })),

  addNote: (personId, body) => {
    const id = uid();
    set((s) => ({
      notes: [
        ...s.notes,
        {
          id,
          personId,
          body,
          date: new Date().toISOString().slice(0, 10),
        },
      ],
    }));
    return id;
  },
  updateNote: (id, patch) =>
    set((s) => ({
      notes: s.notes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
    })),
  deleteNote: (id) =>
    set((s) => ({ notes: s.notes.filter((n) => n.id !== id) })),

  addWin: (win) =>
    set((s) => ({
      wins: [
        ...s.wins,
        {
          ...win,
          id: uid(),
          date: win.date ?? new Date().toISOString().slice(0, 10),
        },
      ],
    })),
  updateWin: (id, patch) =>
    set((s) => ({
      wins: s.wins.map((w) => (w.id === id ? { ...w, ...patch } : w)),
    })),
  deleteWin: (id) =>
    set((s) => ({ wins: s.wins.filter((w) => w.id !== id) })),

  appendChat: (key, msg) =>
    set((s) => ({
      chats: { ...s.chats, [key]: [...(s.chats[key] ?? []), msg] },
    })),
  clearChat: (key) =>
    set((s) => ({ chats: { ...s.chats, [key]: [] } })),

  // --- auth / lifecycle -----------------------------------------------------
  /**
   * Resolve the current session and load (or seed) the user's cloud data.
   * Called once at startup and again whenever auth state changes.
   */
  bootstrap: async () => {
    if (DEMO) {
      // The sample org, moved to this week. Nothing to sign in to or load.
      if (get().phase === "ready") return;
      get().hydrate(toThisWeek(seedData(), todayISO()), "demo", "demo@polarch.day", {
        fromCache: true,
      });
      return;
    }
    const session = await getSession();
    if (!session) {
      repo.clearBaseline(); // clear any prior baseline
      set({ phase: "anon", userId: null, userEmail: null, shares: [], sharedWithMe: [], ...blankData() });
      return;
    }
    const userId = session.id;
    const email = session.email ?? null;
    // Avoid redundant reloads if we're already ready for this user.
    if (get().phase === "ready" && get().userId === userId) return;

    // Paint the local copy first when there is one. The full-screen skeleton
    // is then reserved for the case where there is genuinely nothing to show,
    // instead of being the cost of every return visit.
    const cached = loadDoc(userId);
    // Only a document painted from this device's copy can hold rows the
    // server has lost; a fresh network load has nothing to compare.
    firstRefresh = Boolean(cached);
    if (cached) {
      const base =
        cached.pendingWrite &&
        cached.base &&
        !isIncompletePersistedDoc(cached.doc) &&
        !isIncompletePersistedDoc(cached.base)
          ? rescueOrphanTopics(migrateDoc(cached.base))
          : null;
      let painted = rescueOrphanTopics(migrateDoc(cached.doc));
      if (base) painted = relink(painted, base);
      get().hydrate(painted, userId, email, {
        fromCache: true,
        premigrated: true,
        baseline: base ?? undefined,
      });
      if (cached.pendingWrite && base) {
        // Offline edits with a record of what the server had: push exactly
        // those rows, then fold in whatever happened elsewhere meanwhile.
        void runSync(userId).then(() => revalidate(userId, email));
      } else if (cached.pendingWrite) {
        // These edits were made without a connection. The server has never
        // seen this document, so there is nothing to refresh *from* — drop the
        // baseline and push the whole thing up instead.
        //
        // Exception: a buggy extract once cached docs that omitted newer
        // collections (`tags`, `followUps`). Migrating those holes to `[]` and
        // full-pushing would wipe the server tables. Repair against the
        // server first.
        if (isIncompletePersistedDoc(cached.doc)) {
          void recoverIncompletePendingWrite(
            userId,
            email,
            cached.doc,
            get().hydrate
          );
        } else {
          repo.clearBaseline();
          fullSyncPending = true;
          // Push first so the offline edits are safe, then read the server so
          // this device stops being the only one that knows what it holds.
          // Without the refresh it would never reconcile, and so would spend
          // the whole session unable to propagate a deletion.
          void runSync(userId).then(() => revalidate(userId, email));
        }
      } else {
        void revalidate(userId, email);
      }
      return;
    }

    set({ phase: "loading" });
    try {
      let doc = await repo.loadAll(userId);
      if (!doc) {
        // Brand-new account: adopt legacy local data if present, else seed.
        doc = importLegacyLocalData() ?? seedData();
        await repo.writeAll(userId, doc);
      }
      get().hydrate(doc, userId, email);
    } catch (e) {
      console.error("Polarch: failed to load cloud data", e);
      // A dropped connection is not a failed sign-in. Keep the session and
      // offer a retry — dropping to the login screen mid-commute was
      // indistinguishable from being signed out.
      set({
        phase: "error",
        loadError:
          e instanceof Error && e.message
            ? e.message
            : "We couldn't reach your data.",
      });
      scheduleBootstrapRetry();
    }
  },

  retryBootstrap: async () => {
    clearBootstrapRetry();
    bootstrapAttempts = 0;
    set({ phase: "loading", loadError: null });
    await get().bootstrap();
  },

  hydrate: (rawDoc, userId, email, opts) => {
    clearBootstrapRetry();
    bootstrapAttempts = 0;
    // Every load path lands here — cache, network, import, refresh — so this is
    // the one place a stale shape has to be made safe.
    const migrated = opts?.premigrated ? rawDoc : migrateDoc(rawDoc);
    const doc = opts?.premigrated ? rawDoc : rescueOrphanTopics(migrated);
    // Record the baseline BEFORE the doc lands in the store, so the resulting
    // change event syncs exactly the difference. The baseline is the doc
    // *before* orphan rescue, so rescued topics are written back — otherwise
    // they stay stranded on the server and get rescued again on every load.
    repo.setBaseline(opts?.baseline ?? migrated);
    // Keep the local copy level with whatever we just adopted, so the next
    // cold open has something to paint. Skipped when this *is* that copy —
    // re-serializing it would put the cost back on the boot path.
    if (!opts?.fromCache) saveDoc(userId, doc, { pendingWrite: false });
    set({
      ...doc,
      userId,
      userEmail: email,
      phase: "ready",
      loadError: null,
      // Selection is not cleared: the URL survives sign-in, so a deep link
      // opens the entity it named. App drops the selection if the id is stale.
    });

    /*
     * Hand back anything an occurrence passed without covering.
     *
     * Done on load rather than on a schedule because there is no server-side
     * job to run it, and "when you next open the app" is exactly when the
     * answer matters. It is idempotent — a topic leaves its session the first
     * time and has nothing to return from afterwards — so a second hydrate
     * from the cache-then-network path is a no-op.
     */
    get().sweepReturns();
    void get().loadShares();
  },

  signOut: async () => {
    // Flush any pending debounced write first — otherwise a delete/edit in the
    // last ~600ms is lost when we clear the session.
    await flushPendingSync();
    const userId = get().userId;
    await authSignOut();
    // The local copy outlives the session unless we say otherwise, and the
    // next person to open this browser is not necessarily the same person.
    // The search index and what it was recently asked for are that same copy,
    // held in another shape.
    if (userId) {
      clearDoc(userId);
      clearRecents(userId);
    }
    clearIndex();
    clearUndo();
    repo.clearBaseline();
    fullSyncPending = false;
    set({ phase: "anon", userId: null, userEmail: null, shares: [], sharedWithMe: [], ...blankData() });
  },

  resetToSeed: async () => {
    const userId = get().userId;
    if (!userId) return;
    const doc = seedData();
    await repo.wipeUser(userId);
    await repo.writeAll(userId, doc);
    get().hydrate(doc, userId, get().userEmail);
  },
}));

/* Every meeting link the app writes goes through `routePath`, which can't see
   the data; this hands it the current id → slug mapping on demand. */
setMeetingSlugResolver(
  (id) => meetingSlugs(useStore.getState()).slugById.get(id)
);


// Persist data changes to the Worker / Neon, debounced. UI state stays session-only
// (dark mode persists to localStorage in toggleDark). repo.syncData compares
// each collection by reference against the last baseline and writes only the
// tables that actually changed. PERSISTED_KEYS is declared with the document
// helpers above so bootstrap and extractData share one list.


/** The next refresh is the first since boot — the one that may find lost rows. */
let firstRefresh = true;
let refreshing: Promise<void> | null = null;
let lastRefreshAt = 0;

/**
 * Fold the server's current document into the one on screen.
 *
 * Runs after a cache paint, when the tab comes back into view, and on a slow
 * timer while it stays open — a tab left open for a week must see what was
 * captured on the phone before it is allowed to edit next to it. Quiet by
 * design: the app is already usable, so nothing here may take it away.
 */
function revalidate(userId: string, email: string | null): Promise<void> {
  if (DEMO) return Promise.resolve();
  if (refreshing) return refreshing;
  const job = (async () => {
    lastRefreshAt = Date.now();
    try {
      // A write in flight when the read starts may or may not be in the
      // response. Let it land, so `base` describes what the server holds.
      if (syncInFlight) await syncInFlight;
      const base = repo.getBaseline();
      const server = await repo.loadAll(userId);
      // Nothing on the server for this user — an account wiped elsewhere, or a
      // cache that outlived its data. Leave what's on screen alone.
      if (!server) return;
      if (syncInFlight) await syncInFlight;
      const state = useStore.getState();
      if (state.userId !== userId || state.phase !== "ready") return;
      const serverDoc = migrateDoc(server);
      const fresh = rescueOrphanTopics(serverDoc);
      const { doc, missing, missingCount } = mergeServer(
        extractData(state),
        base,
        fresh
      );
      const offer = firstRefresh && missingCount > 0;
      firstRefresh = false;
      // Baseline is the server as stored (pre-rescue), so repairs get written.
      state.hydrate(doc, userId, email, { baseline: serverDoc, premigrated: true });
      if (offer) offerRecovery(userId, missing, missingCount);
    } catch (e) {
      // There is a document on screen and the app works. A failed refresh is
      // not an error screen — the write path surfaces connectivity on its own.
      console.error("Polarch: background refresh failed", e);
    }
  })().finally(() => {
    if (refreshing === job) refreshing = null;
  });
  refreshing = job;
  return job;
}

/** Refresh if the last one is old enough to be worth a round trip. */
function refreshIfStale(minAgeMs: number) {
  const state = useStore.getState();
  if (state.phase !== "ready" || !state.userId) return;
  if (Date.now() - lastRefreshAt < minAgeMs) return;
  void revalidate(state.userId, state.userEmail);
}

/**
 * A shared meeting is on screen, and the other chair may be adding to it right
 * now. Same three-way merge as every refresh — only sooner.
 */
export function refreshShared(): void {
  refreshIfStale(12_000);
}

/** Exponential backoff for a failed initial load, capped so it keeps trying. */
let bootstrapAttempts = 0;
let bootstrapRetryTimer: ReturnType<typeof setTimeout> | null = null;

function clearBootstrapRetry() {
  if (bootstrapRetryTimer) {
    clearTimeout(bootstrapRetryTimer);
    bootstrapRetryTimer = null;
  }
}

function scheduleBootstrapRetry() {
  clearBootstrapRetry();
  bootstrapAttempts += 1;
  const delay = Math.min(30_000, 1_000 * 2 ** (bootstrapAttempts - 1));
  bootstrapRetryTimer = setTimeout(() => {
    bootstrapRetryTimer = null;
    if (useStore.getState().phase === "error") {
      void useStore.getState().bootstrap();
    }
  }, delay);
}

let syncTimer: ReturnType<typeof setTimeout> | null = null;
let syncInFlight: Promise<void> | null = null;
/**
 * A cache holding unsynced edits was adopted at boot. There is no baseline
 * that reflects what the server has, so the next sync must write every table
 * rather than diff against one. `syncData` already does exactly that when the
 * baseline is null — this flag is what keeps the usual "nothing loaded yet, so
 * don't write" guard from swallowing it.
 */
let fullSyncPending = false;

/** Whether a write is allowed: we've loaded, or we're pushing a cached doc. */
function canSync(): boolean {
  if (DEMO) return false;
  return repo.hasBaseline() || fullSyncPending;
}

/** Edits exist that the server hasn't confirmed — pending, retrying, or in flight. */
function hasUnsyncedEdits(): boolean {
  return Boolean(syncTimer || syncRetryTimer || syncInFlight || fullSyncPending);
}
/** More edits arrived while a sync was writing — coalesce another pass. */
let syncQueued = false;
/** Consecutive failed writes, driving the retry backoff. */
let syncFailures = 0;
let syncRetryTimer: ReturnType<typeof setTimeout> | null = null;

function clearSyncRetry() {
  if (syncRetryTimer) {
    clearTimeout(syncRetryTimer);
    syncRetryTimer = null;
  }
}

function scheduleSyncRetry(userId: string) {
  clearSyncRetry();
  syncFailures += 1;
  const delay = Math.min(30_000, 1_000 * 2 ** (syncFailures - 1));
  syncRetryTimer = setTimeout(() => {
    syncRetryTimer = null;
    void runSync(userId);
  }, delay);
}

function extractData(state: Store): PersistedData {
  return Object.fromEntries(
    PERSISTED_KEYS.map((k) => [k, state[k]])
  ) as PersistedData;
}

/**
 * Persist the latest store to the Worker. Overlapping syncs are serialized and
 * coalesced so a slow earlier write cannot upsert a stale people list after a
 * delete/move (which was resurrecting removed pod members on reload).
 */
function runSync(userId: string): Promise<void> {
  if (syncInFlight) {
    syncQueued = true;
    return syncInFlight;
  }

  const job = (async () => {
    do {
      syncQueued = false;
      const latest = useStore.getState();
      if (latest.phase !== "ready" || latest.userId !== userId || !canSync()) {
        return;
      }
      try {
        useStore.setState({ syncStatus: "saving" });
        const written = extractData(latest);
        await repo.syncData(userId, written);
        syncFailures = 0;
        fullSyncPending = false;
        clearSyncRetry();
        // Cache exactly what the server now holds. Marking it clean is what
        // lets the next cold open refresh from the server instead of pushing
        // this document back up.
        saveDoc(userId, written, { pendingWrite: false });
        useStore.setState({ syncStatus: "idle" });
      } catch (e) {
        console.error("Polarch: cloud sync failed", e);
        scheduleSyncRetry(userId);
        // The edits are real and the server doesn't have them. Keep them where
        // a hard quit can't take them, and mark them as still owed.
        saveDoc(userId, extractData(useStore.getState()), {
          pendingWrite: true,
          base: repo.getBaseline(),
        });
        // Not "idle" — a retry is pending and the edit is not on the server
        // yet. Reporting that as saved is the one lie the UI cannot afford.
        useStore.setState({ syncStatus: "error" });
        return;
      }
    } while (syncQueued);
  })().finally(() => {
    if (syncInFlight === job) syncInFlight = null;
  });

  syncInFlight = job;
  return job;
}

/** Write the current store immediately (cancels a pending debounce). */
async function flushPendingSync(): Promise<void> {
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  const latest = useStore.getState();
  if (latest.phase !== "ready" || !latest.userId || !canSync()) {
    if (syncInFlight) await syncInFlight;
    return;
  }
  // Mark dirty so an in-flight sync loops with the latest snapshot instead of
  // racing a second parallel upsert.
  await runSync(latest.userId);
}

function scheduleSync(userId: string): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void runSync(userId);
  }, 600);
}

useStore.subscribe((state, prev) => {
  if (state.phase !== "ready" || !state.userId) return;
  if (!PERSISTED_KEYS.some((k) => state[k] !== prev[k])) return;
  if (!canSync()) return;
  scheduleSync(state.userId);
});

// Flush pending cloud writes when the tab is backgrounded or closed so a
// quick refresh / OAuth redirect doesn't drop the last edit.
if (typeof window !== "undefined") {
  const flush = () => {
    // Local copy first, and synchronously. The cloud write below is an async
    // `fetch` that a backgrounded tab is entirely free to abandon — iOS
    // reclaiming the tab is the normal case, not the edge case — but by the
    // time this line returns, the last 600ms of edits are on disk. The cloud
    // write then gets its chance, and the retry machinery covers the rest.
    const state = useStore.getState();
    if (state.phase === "ready" && state.userId && hasUnsyncedEdits()) {
      saveDoc(state.userId, extractData(state), {
        pendingWrite: true,
        base: repo.getBaseline(),
      });
    }
    void flushPendingSync();
  };
  window.addEventListener("pagehide", flush);

  /**
   * Connectivity came back, or the user returned to a backgrounded tab. Retry
   * whatever stalled — a failed load and a failed write are both recoverable
   * without a reload, which is the normal case on a phone.
   */
  const recover = () => {
    const state = useStore.getState();
    if (state.phase === "error") {
      void state.retryBootstrap();
      return;
    }
    if (state.userId && (syncRetryTimer || syncTimer)) {
      clearSyncRetry();
      syncFailures = 0;
      void runSync(state.userId);
    }
    // Whatever happened on other devices while this tab sat in the background.
    refreshIfStale(15_000);
  };

  window.addEventListener("online", recover);
  window.addEventListener("focus", () => refreshIfStale(15_000));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
    else recover();
  });
  // An open, visible tab still drifts: poll gently.
  setInterval(() => {
    if (document.visibilityState === "visible") refreshIfStale(90_000);
  }, 30_000);
}

// Re-run bootstrap on sign-in / sign-out / first session read.
onAuthChange((event) => {
  if (event === "SIGNED_OUT") {
    // Covers the sign-outs the store didn't initiate — an expired session,
    // a sign-out in another tab. The local copy must not outlive the
    // session that was allowed to read it.
    const { userId } = useStore.getState();
    if (userId) {
      clearDoc(userId);
      clearRecents(userId);
    }
    clearIndex();
    clearUndo();
    repo.clearBaseline();
    fullSyncPending = false;
    useStore.setState({
      phase: "anon",
      userId: null,
      userEmail: null,
      shares: [],
      sharedWithMe: [],
      ...blankData(),
    });
    return;
  }
  if (event === "SIGNED_IN" || event === "INITIAL_SESSION") {
    setTimeout(() => void useStore.getState().bootstrap(), 0);
  }
});

void hydrateAuth();
