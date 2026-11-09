import {
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Dialog,
  Modal as SysModal,
  ModalOverlay,
} from "@/components/application/modals/modal";
import { useStore } from "../store/useStore";
import { useOverlayGuard, useShortcutList } from "@/hooks/use-shortcut";
import { keysOf } from "@/lib/shortcuts";
import { TREE_MODES } from "../lib/treeMode";
import {
  getIndex,
  highlight,
  queryTokens,
  score,
  search,
  type SearchDoc,
  type SearchIndex,
  type SearchSource,
  type SearchTarget,
} from "../lib/search";
import { loadRecents, recentRank, recordRecent } from "../lib/recents";
import { todayISO } from "../lib/readiness";
import { ensureSessionId, plannedSlots } from "../lib/topics";
import { startMeeting, useLive } from "../lib/liveMeeting";
import { useMeetingsByNext } from "@/hooks/use-meetings-by-next";
import { flagOn } from "@/lib/flags";
import { quickCloseCommands } from "@/lib/quickClose";
import { Avatar } from "./Avatar";
import { cx } from "@/utils/cx";
import { SearchLg } from "@untitledui/icons";

/**
 * ⌘K — one place to reach anything, answered from memory.
 *
 * Polarch earns a palette: five tabs, five tree modes, four entity kinds that
 * each number in the dozens, and a set of create actions scattered across three
 * surfaces. Without it, "open Dana's 1:1" is a tab switch, a scan and a click;
 * with it, it's four keystrokes from anywhere.
 *
 * Two kinds of result share one list. **Commands** come from the shortcut
 * registry plus a handful of navigation entries, so a command that has a
 * shortcut shows it — the palette teaches the shortcut that would have skipped
 * the palette. **Documents** come from [`lib/search`](../lib/search.ts): not
 * just the entities, but every write-up, topic, note, win and prayer entry in
 * the workspace, so the half-remembered thing you discussed is as reachable as
 * the person you discussed it with.
 *
 * Three things make it feel instant, and all three are deliberate:
 *
 *   - **The index is built off the paint.** Opening the palette shows recents
 *     and commands immediately; the index lands a frame later, from an effect.
 *     A cold build over a large workspace is tens of milliseconds, and none of
 *     them are spent with an empty box on screen.
 *   - **Results are deferred, the field is not.** `useDeferredValue` lets React
 *     keep the caret ahead of the list, so a long query never stutters.
 *   - **Nothing is fetched.** The store is already hydrated from the local
 *     document cache, so this works with no signal at all — which is exactly
 *     when you need to pull someone up before walking into the room.
 */

type Row = {
  id: string;
  label: string;
  /** Right-aligned context — a role, a date, whose write-up this is. */
  hint?: string;
  chord?: string;
  group: string;
  photo?: string;
  /** A line of the body, around the match. Only on documents. */
  snippet?: string;
  run: () => void;
};

/**
 * Rows clustered by group, groups in order of first appearance. Listed as
 * they come, groups interleave and their headings repeat: two "Go to"s and
 * two "Create"s at rest, three "People"s in a ten-row search.
 */
function clusterByGroup(rows: Row[]): Row[] {
  const order: string[] = [];
  const byGroup = new Map<string, Row[]>();
  for (const row of rows) {
    if (!byGroup.has(row.group)) {
      byGroup.set(row.group, []);
      order.push(row.group);
    }
    byGroup.get(row.group)!.push(row);
  }
  return order.flatMap((g) => byGroup.get(g)!);
}

/** Rows shown before anything is typed. Enough to scan, not enough to read. */
const RESTING_LIMIT = 30;
const RECENT_LIMIT = 8;

export function CommandPalette({ onClose }: { onClose: () => void }) {
  useOverlayGuard();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const shortcuts = useShortcutList();
  const userId = useStore((s) => s.userId);
  const me = useStore((s) => s.me);
  const people = useStore((s) => s.people);
  const teams = useStore((s) => s.teams);
  const managers = useStore((s) => s.managers);
  const meetings = useStore((s) => s.meetings);
  const sessions = useStore((s) => s.sessions);
  const topics = useStore((s) => s.topics);
  const notes = useStore((s) => s.notes);
  const teamNotes = useStore((s) => s.teamNotes);
  const wins = useStore((s) => s.wins);
  const prayers = useStore((s) => s.prayers);
  const setTab = useStore((s) => s.setTab);
  // "Go to" leaves what's open behind, like the sidebar and the g shortcuts.
  // `setTab` keeps it as a peek on the new tab — on a phone that peek fills the
  // screen, so the palette looked like it had done nothing.
  const goToTab = useStore((s) => s.goToTab);
  const selectPerson = useStore((s) => s.selectPerson);
  const selectTeam = useStore((s) => s.selectTeam);
  const selectManager = useStore((s) => s.selectManager);
  const selectMeeting = useStore((s) => s.selectMeeting);
  const selectMe = useStore((s) => s.selectMe);
  const openSession = useStore((s) => s.openSession);
  const setTreeMode = useStore((s) => s.setTreeMode);
  const openModal = useStore((s) => s.openModal);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const toggleDark = useStore((s) => s.toggleDark);
  const dark = useStore((s) => s.dark);
  const addSession = useStore((s) => s.addSession);
  const byNext = useMeetingsByNext();
  const liveSessionId = useLive((s) => s.sessionId);

  const source = useMemo<SearchSource>(
    () => ({
      me,
      people,
      teams,
      managers,
      meetings,
      sessions,
      topics,
      notes,
      teamNotes,
      wins,
      prayers,
    }),
    [me, people, teams, managers, meetings, sessions, topics, notes, teamNotes, wins, prayers]
  );

  /**
   * Built after the first paint, never during it. `getIndex` caches on the
   * document's identity, so this is a map lookup on every open but the first
   * after an edit.
   */
  const [index, setIndex] = useState<SearchIndex | null>(null);
  useEffect(() => {
    // A frame's grace so the overlay and the focused field are on screen
    // before a large workspace is folded and tokenized.
    const id = requestAnimationFrame(() => setIndex(getIndex(source)));
    return () => cancelAnimationFrame(id);
  }, [source]);

  // Read once per open. The list is rewritten as rows are run, and re-reading
  // it mid-session would reorder the results under the user's cursor.
  const [recents] = useState(() => loadRecents(userId));
  const ranks = useMemo(() => recentRank(recents), [recents]);

  const openTarget = useCallback(
    (target: SearchTarget) => {
      // A write-up opens as the full-screen editor for that occurrence; the
      // store's own route handling knows which surface that is.
      if (target.sessionId) {
        openSession(target.sessionId);
        return;
      }
      switch (target.kind) {
        case "person":
          selectPerson(target.id, target.section);
          break;
        case "team":
          selectTeam(target.id, target.section);
          break;
        case "manager":
          selectManager(target.id, target.section);
          break;
        case "meeting":
          selectMeeting(target.id, target.section);
          break;
        case "me":
          selectMe(true);
          break;
        case "ideas":
          goToTab("ideas");
          break;
      }
    },
    [
      openSession,
      selectPerson,
      selectTeam,
      selectManager,
      selectMeeting,
      selectMe,
      goToTab,
    ]
  );

  /** Close, remember, then go. In that order — navigation unmounts this. */
  const runRow = useCallback(
    (id: string, go: () => void) => {
      onClose();
      recordRecent(userId, id);
      go();
    },
    [onClose, userId]
  );

  const docRow = useCallback(
    (doc: SearchDoc, snippet?: string): Row => ({
      id: doc.id,
      label: doc.title,
      hint: doc.context,
      group: doc.group,
      photo: doc.photo,
      snippet,
      run: () => runRow(doc.id, () => openTarget(doc.target)),
    }),
    [openTarget, runRow]
  );

  const commands = useMemo<Row[]>(() => {
    const go = (id: string, fn: () => void) => () => runRow(id, fn);

    const nav: Row[] = [
      { id: "go:today", label: "Go to Today", group: "Go to", hint: "G then T", run: go("go:today", () => goToTab("today")) },
      { id: "go:tree", label: "Go to People · Tree", group: "Go to", hint: "G then C", run: go("go:tree", () => goToTab("tree")) },
      { id: "go:table", label: "Go to People · List", group: "Go to", hint: "G then B", run: go("go:table", () => goToTab("table")) },
      { id: "go:meetings", label: "Go to Meetings", group: "Go to", hint: "G then M", run: go("go:meetings", () => goToTab("meetings")) },
      { id: "go:ideas", label: "Go to Ideas", group: "Go to", hint: "G then I", run: go("go:ideas", () => goToTab("ideas")) },
      { id: "go:prayer", label: "Go to Prayer", group: "Go to", hint: "G then R", run: go("go:prayer", () => goToTab("prayer")) },
      { id: "new:capture", label: "Capture a topic", group: "Create", hint: "C", run: go("new:capture", () => openModal({ kind: "capture" })) },
      { id: "go:me", label: "Open my profile", group: "Go to", run: go("go:me", () => selectMe(true)) },

      { id: "new:team", label: "Add team", group: "Create", run: go("new:team", () => openModal({ kind: "team" })) },
      { id: "new:person", label: "Add person", group: "Create", run: go("new:person", () => openModal({ kind: "person", teamId: null })) },
      { id: "new:manager", label: "Add manager", group: "Create", run: go("new:manager", () => openModal({ kind: "manager" })) },
      { id: "new:domain", label: "Manage domains", group: "Create", run: go("new:domain", () => openModal({ kind: "domains" })) },

      ...TREE_MODES.map((m) => ({
        id: `mode:${m.id}`,
        label: `Tree mode — ${m.label}`,
        hint: m.question,
        chord: m.key,
        group: "Org tree",
        run: go(`mode:${m.id}`, () => {
          setTab("tree");
          setTreeMode(m.id);
        }),
      })),

      { id: "app:settings", label: "Open settings", group: "App", run: go("app:settings", () => setSettingsOpen(true)) },
      {
        id: "app:theme",
        label: dark ? "Switch to light mode" : "Switch to dark mode",
        group: "App",
        run: go("app:theme", toggleDark),
      },
    ];

    // Anything bound to a chord is offered here too, so the palette is a
    // complete index of what the app can do rather than a second, shorter list.
    const bound: Row[] = shortcuts
      .filter((s) => s.group !== "Writing")
      .map((s) => ({
        id: `key:${s.id}`,
        label: s.label,
        chord: keysOf(s),
        group: s.group,
        run: () => runRow(`key:${s.id}`, () => s.run(new KeyboardEvent("keydown"))),
      }));

    return [...nav, ...bound];
  }, [
    shortcuts,
    dark,
    runRow,
    setTab,
    selectMe,
    setTreeMode,
    openModal,
    setSettingsOpen,
    toggleDark,
  ]);

  /**
   * Meetings as verbs: back into the one you're in, start one, or pick the
   * notes back up on one that's been. At rest it's only what's live, what's
   * today and the last few write-ups; typed, any meeting starts by name.
   */
  const meetingRows = useMemo<(Row & { resting: boolean })[]>(() => {
    const today = todayISO();
    const go = (id: string, fn: () => void) => () => runRow(id, fn);
    const titleOf = new Map(byNext.map((r) => [r.meeting.id, r.title]));
    const live = liveSessionId ? sessions.find((o) => o.id === liveSessionId) : undefined;
    const rows: (Row & { resting: boolean })[] = [];

    if (live && titleOf.has(live.meetingId)) {
      rows.push({
        id: "meet:live",
        label: `Back to ${titleOf.get(live.meetingId)}`,
        hint: "In progress",
        group: "Meetings",
        resting: true,
        run: go("meet:live", () => openSession(live.id)),
      });
    }

    for (const { meeting, title, readiness } of byNext) {
      const next = plannedSlots(meeting, sessions, topics, today, 2).find((s) => !s.past);
      if (!next || (live && next.sessionId === live.id)) continue;
      // When it's due is readiness's answer, the same the sidebar gives. The
      // board projects a meeting with no day yet onto today as a placeholder;
      // it can be started by name, but it isn't on today.
      const due = readiness.nextDate;
      const id = `meet:start:${meeting.id}`;
      rows.push({
        id,
        label: `Start ${title}`,
        hint:
          !due || readiness.daysUntil === null
            ? "No date yet"
            : readiness.daysUntil < 0
              ? "Overdue"
              : readiness.daysUntil === 0
                ? "Today"
                : dayLabel(due),
        group: "Meetings",
        resting: readiness.daysUntil === 0,
        run: go(id, () => {
          const latest = useStore.getState().sessions;
          const sessionId = ensureSessionId(meeting.id, next, latest, addSession);
          startMeeting(sessionId);
          openSession(sessionId);
        }),
      });
    }

    sessions
      .filter((o) => o.kind !== "skipped" && o.date <= today && titleOf.has(o.meetingId))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 12)
      .forEach((o, i) => {
        const id = `meet:notes:${o.id}`;
        rows.push({
          id,
          label: `Notes — ${titleOf.get(o.meetingId)}`,
          hint: o.date === today ? "Today" : dayLabel(o.date),
          group: "Meetings",
          resting: i < 3 && o.id !== live?.id,
          run: go(id, () => openSession(o.id)),
        });
      });

    quickCloseCommands(
      flagOn("quickClose"),
      byNext.map((r) => ({ meetingId: r.meeting.id, title: r.title, readiness: r.readiness })),
    ).forEach((cmd, i) => {
      const id = `meet:quick-close:${cmd.sessionId}`;
      rows.push({
        id,
        label: `Quick close — ${cmd.title}`,
        hint: "No recording",
        group: "Meetings",
        resting: i < 2,
        run: go(id, () => openModal({ kind: "quickClose", sessionId: cmd.sessionId })),
      });
    });

    return rows;
  }, [byNext, sessions, topics, liveSessionId, runRow, openSession, addSession, openModal]);

  // The list lags the field by at most a frame under load, so typing is never
  // gated on scoring a workspace's worth of prose.
  const deferred = useDeferredValue(query);
  const trimmed = deferred.trim();
  const tokens = useMemo(() => queryTokens(trimmed), [trimmed]);

  const results = useMemo<Row[]>(() => {
    if (!trimmed) {
      // At rest: what you opened last, then what the app can do. Sixty names
      // are not an answer to a question nobody has asked yet.
      const recentRows = index
        ? recents
            .map((id) => index.byId.get(id))
            .filter((d): d is SearchDoc => !!d)
            .slice(0, RECENT_LIMIT)
            .map((doc) => ({ ...docRow(doc), group: "Recent" }))
        : [];
      const meetingNow = meetingRows.filter((r) => r.resting);
      return clusterByGroup([...meetingNow, ...recentRows, ...commands]).slice(0, RESTING_LIMIT);
    }

    const commandHits = [
      ...commands.map((row) => ({
        row,
        // A match on the subtitle counts, but never beats one on the name.
        s: Math.max(score(trimmed, row.label), score(trimmed, row.hint ?? "") - 400),
      })),
      // "start sarah" means "Start 1:1 with Sarah Kim": each word has to land,
      // not the phrase in one piece.
      ...meetingRows.map((row) => ({
        row,
        s: Math.max(score(trimmed, row.label), everyWord(trimmed, row.label) - 100),
      })),
    ]
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s);

    const docHits = index
      ? search(index, trimmed, { recentRank: ranks }).map((hit) => ({
          row: docRow(hit.doc, hit.snippet),
          s: hit.score,
        }))
      : [];

    const scored = [...commandHits, ...docHits]
      .sort((a, b) => b.s - a.s)
      .slice(0, 40);

    return clusterByGroup(scored.map(({ row }) => row));
  }, [commands, meetingRows, docRow, index, ranks, recents, trimmed]);

  // A new query invalidates the highlight — otherwise Enter runs whatever
  // happened to be at index 4 in the previous result set.
  useEffect(() => setActive(0), [trimmed]);

  useEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active, results]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      setActive((i) => (results.length ? (i + 1) % results.length : 0));
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      setActive((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(Math.max(0, results.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      results[active]?.run();
    }
  };

  return (
    <ModalOverlay
      isOpen
      isDismissable
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      // The top inset goes through the variable the modal's max height is
      // measured against; set as plain padding, the list ran off the bottom.
      className="fixed inset-0 z-50 flex min-h-dvh w-full items-end justify-center bg-overlay/70 px-0 backdrop-blur-[6px] [--modal-pt:16px] sm:items-start sm:px-8 sm:[--modal-pt:12vh]"
    >
      <SysModal className="max-w-xl">
        <Dialog aria-label="Command palette" className="flex max-h-[inherit] flex-col">
          <div className="flex shrink-0 items-center gap-2.5 border-b border-secondary px-4 py-3">
            <SearchLg className="size-4 shrink-0 text-stone-400" aria-hidden />
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search people, notes, write-ups and commands…"
              aria-label="Search people, notes, write-ups and commands"
              aria-controls={listId}
              aria-expanded
              aria-activedescendant={
                results[active] ? `${listId}-${results[active].id}` : undefined
              }
              role="combobox"
              aria-autocomplete="list"
              className="min-w-0 flex-1 bg-transparent text-base text-ellipsis outline-none placeholder:text-stone-400 dark:placeholder:text-stone-500"
            />
            <kbd className="hidden shrink-0 rounded bg-tertiary px-1.5 py-0.5 font-mono text-caption text-quaternary sm:inline">
              Esc
            </kbd>
          </div>

          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label="Results"
            className="scroll-contain min-h-0 flex-1 overflow-y-auto py-1.5"
          >
            {results.length === 0 && (
              <p className="px-4 py-8 text-center text-sm text-quaternary">
                {index
                  ? `Nothing matches “${trimmed}”.`
                  : "Searching your workspace…"}
              </p>
            )}
            {results.map((item, i) => {
              const first = i === 0 || results[i - 1].group !== item.group;
              return (
                <div key={item.id}>
                  {first && (
                    <div className="px-4 pt-2 pb-1 text-caption font-semibold tracking-widest text-stone-400 uppercase dark:text-stone-500">
                      {item.group}
                    </div>
                  )}
                  {/* Not a <button>: the input keeps focus so typing never
                      stops, and the active row is named by aria-activedescendant. */}
                  <div
                    id={`${listId}-${item.id}`}
                    role="option"
                    aria-selected={i === active}
                    data-active={i === active}
                    onMouseMove={() => setActive(i)}
                    onClick={item.run}
                    className={cx(
                      "cursor-pointer px-4 py-2 text-sm",
                      i === active
                        ? "bg-teal-50 text-teal-900 dark:bg-teal-950/50 dark:text-teal-100"
                        : "text-stone-700 dark:text-stone-200"
                    )}
                  >
                    <div className="flex items-center gap-2.5">
                      {item.photo !== undefined && (
                        <Avatar name={item.label} photo={item.photo} size={22} />
                      )}
                      <span className="min-w-0 flex-1 truncate">
                        <Marked text={item.label} tokens={tokens} />
                      </span>
                      {item.hint && (
                        <span className="hidden shrink-0 truncate text-xs text-stone-400 sm:inline dark:text-stone-500">
                          {item.hint}
                        </span>
                      )}
                      {item.chord && (
                        <kbd className="shrink-0 rounded bg-tertiary px-1.5 py-0.5 font-mono text-caption text-quaternary">
                          {item.chord}
                        </kbd>
                      )}
                    </div>
                    {/* The line the match was actually on. Without it, a hit
                        inside a 2,000-word write-up is a row you have to open
                        to find out why it's there. */}
                    {item.snippet && (
                      <p className="mt-0.5 truncate pl-0 text-xs text-stone-400 dark:text-stone-500">
                        <Marked text={item.snippet} tokens={tokens} />
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="pad-safe-bottom flex shrink-0 items-center gap-3 border-t border-secondary px-4 py-2 text-caption text-quaternary [--pad-safe-bottom:0.5rem]">
            <span>
              <kbd className="font-mono">↑↓</kbd> move
            </span>
            <span>
              <kbd className="font-mono">↵</kbd> open
            </span>
            <span>
              <kbd className="font-mono">?</kbd> all shortcuts
            </span>
          </div>
        </Dialog>
      </SysModal>
    </ModalOverlay>
  );
}

/** The weakest of each word's match, or 0 when any word misses. */
function everyWord(query: string, text: string): number {
  const words = query.split(/\s+/).filter(Boolean);
  if (words.length < 2) return 0;
  let worst = Infinity;
  for (const w of words) {
    const s = score(w, text);
    if (!s) return 0;
    worst = Math.min(worst, s);
  }
  return worst;
}

/** "Thu, Oct 30" — a date short enough for the hint column. */
function dayLabel(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** What you typed, picked out of what was found. */
function Marked({ text, tokens }: { text: string; tokens: string[] }) {
  if (!tokens.length) return <>{text}</>;
  return (
    <>
      {highlight(text, tokens).map((part, i) =>
        part.hit ? (
          <mark
            key={i}
            className="bg-transparent font-semibold text-current underline decoration-teal-500/60 decoration-2 underline-offset-2"
          >
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        )
      )}
    </>
  );
}
