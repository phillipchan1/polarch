import { useMemo, useState } from "react";
import { RhythmRing, STATE_TEXT } from "./brand/glyphs";
import { cx } from "@/utils/cx";
import { useStore } from "../store/useStore";
import type { MeetingSubjectKind, TrackedMeeting } from "../types";
import {
  RHYTHM_LABEL,
  STATE_LABEL,
  formatCountdown,
  meetingSubjectName,
  meetingTitle,
  readinessOf,
  type Readiness,
} from "../lib/readiness";
import { looseTopics, topicsFor } from "../lib/topics";
import { RUNWAY_DAYS, runwayOf, type Runway } from "../lib/runway";
import { RunwayCover, RunwayTrack, runwayTitle } from "./RunwayTrack";
import { Card } from "./ui";
import { Th } from "./Th";
import { Input } from "@/components/base/input/input";
import { NativeSelect } from "@/components/base/select/select-native";
import { NewMeetingRow } from "./NewMeetingRow";
import { MeetingsSwitch } from "./shell/MeetingsSwitch";
import { ChevronDown, Plus, SearchLg } from "@untitledui/icons";
import { tableRowActivationProps } from "@/lib/rowActivation";
import { useSearchShortcut } from "@/hooks/use-search-shortcut";
import { flagOn } from "@/lib/flags";
import { quickCloseAvailable } from "@/lib/quickClose";

type SortKey = "next" | "name" | "runway" | "state";

type Row = {
  meeting: TrackedMeeting;
  title: string;
  subjectName?: string;
  readiness: Readiness;
  /** Open topics on the board, whether or not they're slotted yet. */
  open: number;
  /** Open topics slotted into an occurrence that's already gone. */
  loose: number;
  /** How far ahead it's already planned. */
  runway: Runway;
};

const KIND_FILTERS: { label: string; value: "" | MeetingSubjectKind }[] = [
  { label: "Everything", value: "" },
  { label: "People", value: "person" },
  { label: "Teams", value: "team" },
  { label: "Managers", value: "manager" },
];

/**
 * Every recurring meeting in one list — the thing that was missing.
 *
 * Opting into a meeting used to be buried in the readiness panel of whichever
 * profile it hung off, so there was no answer to "what do I actually run?".
 * This is that answer, sorted by what's next, with the two numbers that decide
 * whether you're ready: what's planned, and what got dropped.
 *
 * Readiness is the only color on a row. How far ahead it's planned is a grey
 * count, with the twelve-week track under the pointer; meetings that have
 * never met fold under "Not started" so they don't stand in the queue.
 */
export function MeetingsTable() {
  const { meetings, sessions, topics, people, teams, managers, selectMeeting, openModal } =
    useStore();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"" | MeetingSubjectKind>("");
  const [sortKey, setSortKey] = useState<SortKey>("next");
  const [asc, setAsc] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showDormant, setShowDormant] = useState(false);
  const searchRef = useSearchShortcut();

  const rows = useMemo<Row[]>(() => {
    const enriched = meetings.map((meeting) => {
      const subjectName = meetingSubjectName(meeting, {
        people,
        teams,
        managers,
      });
      const mine = topicsFor(topics, meeting.id);
      return {
        meeting,
        // A 1:1 is called by the person's name; "Meeting · Sarah Kim" says
        // the same thing with more words.
        title: meeting.name?.trim() || subjectName || meetingTitle(meeting, subjectName),
        subjectName,
        readiness: readinessOf(meeting, { meetings, sessions, topics }),
        open: mine.filter((t) => t.status === "open").length,
        loose: looseTopics(topics, sessions, meeting.id).length,
        runway: runwayOf(meeting, sessions, topics),
      };
    });

    const q = query.trim().toLowerCase();
    const filtered = enriched.filter(
      (r) =>
        (!kind || r.meeting.subjectKind === kind) &&
        (!q ||
          r.title.toLowerCase().includes(q) ||
          r.subjectName?.toLowerCase().includes(q))
    );

    const dir = asc ? 1 : -1;
    return filtered.sort((x, y) => {
      switch (sortKey) {
        case "name":
          return dir * x.title.localeCompare(y.title);
        case "runway":
          // Shortest cover first when ascending: the leadership block works
          // down the list from the meeting that will catch you soonest.
          // As-needed has no runway and sorts last either way.
          if ((x.runway.level === "none") !== (y.runway.level === "none")) {
            return x.runway.level === "none" ? 1 : -1;
          }
          return dir * (x.runway.days - y.runway.days || x.runway.ahead - y.runway.ahead);
        case "state":
          // Worst first when ascending — the list is a to-do, not an index.
          return (
            dir *
            (STATE_RANK[y.readiness.state] - STATE_RANK[x.readiness.state])
          );
        default:
          // No next date sorts last either way: it's unknown, not imminent.
          return (
            dir * (x.readiness.nextDate ?? "9999").localeCompare(
              y.readiness.nextDate ?? "9999"
            )
          );
      }
    });
  }, [meetings, sessions, topics, people, teams, managers, query, kind, sortKey, asc]);

  const sortBy = (key: SortKey) => {
    if (key === sortKey) setAsc(!asc);
    else {
      setSortKey(key);
      setAsc(true);
    }
  };

  const sortedAs = (key: SortKey): "asc" | "desc" | undefined =>
    sortKey === key ? (asc ? "asc" : "desc") : undefined;

  // A search looks everywhere; otherwise the never-met wait below the fold.
  const searching = query.trim() !== "";
  const active = searching ? rows : rows.filter((r) => r.readiness.state !== "dormant");
  const dormant = searching ? [] : rows.filter((r) => r.readiness.state === "dormant");
  const totalLoose = rows.reduce((n, r) => n + r.loose, 0);
  const short = rows.filter((r) => r.runway.level === "bare" || r.runway.level === "thin").length;

  return (
    <div className="scroll-contain min-h-0 flex-1 overflow-y-auto">
      {/* The route already pads its pane; padding here too set Meetings in
          from every other place's gutter. */}
      <div className="flex flex-col gap-4">
        <MeetingsSwitch current="meetings" />
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-[34px] leading-10 font-medium tracking-[-0.01em]">Meetings</h1>
          <p className="text-[13.5px] text-tertiary">
            {rows.length} recurring
            {short > 0 && (
              <>
                {" · "}
                <button
                  type="button"
                  onClick={() => {
                    setSortKey("runway");
                    setAsc(true);
                  }}
                  className="cursor-pointer hover:text-primary"
                  title="Sort by runway, shortest first"
                >
                  {short} planned less than a month out
                </button>
              </>
            )}
            {totalLoose > 0 && (
              <>
                {" · "}
                <span className="text-cond-watch-ink">{totalLoose} planned and never covered</span>
              </>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Input
            size="sm"
            className="w-full sm:w-64"
            icon={SearchLg}
            ref={searchRef}
            placeholder="Find a meeting…"
            aria-label="Find a meeting"
            value={query}
            onChange={setQuery}
          />
          <NativeSelect
            size="sm"
            className="w-auto"
            aria-label="Filter by kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as "" | MeetingSubjectKind)}
            options={KIND_FILTERS}
          />
          <button
            type="button"
            onClick={() => setCreating((v) => !v)}
            aria-pressed={creating}
            aria-label="New recurring meeting"
            title="New recurring meeting"
            className={cx(
              "inline-flex size-9 items-center justify-center rounded-[9px] text-tertiary hover:bg-secondary hover:text-primary touch:size-11",
              creating && "bg-secondary text-primary"
            )}
          >
            <Plus aria-hidden className={cx("size-5 transition-transform duration-[var(--dur-base)]", creating && "rotate-45")} />
          </button>
        </div>

        {creating && <NewMeetingRow onDone={() => setCreating(false)} />}

        {rows.length === 0 ? (
          <Card className="p-6 text-center text-sm text-quaternary">
            {meetings.length === 0
              ? "No recurring meetings yet. Add the ones you actually run — a 1:1 per person, a staff meeting per team."
              : "Nothing matches that."}
          </Card>
        ) : (
          <>
            {/* Below sm the table becomes cards: four columns can't hold a
                date, a countdown and two counts on a phone. */}
            <ul className="flex flex-col gap-2 sm:hidden">
              {active.map((r) => (
                <MeetingCard
                  key={r.meeting.id}
                  row={r}
                  onOpen={() => selectMeeting(r.meeting.id)}
                  onQuickClose={quickCloseFor(r, openModal)}
                />
              ))}
              {dormant.length > 0 && (
                <li>
                  <NotStartedToggle count={dormant.length} open={showDormant} onToggle={() => setShowDormant((v) => !v)} />
                </li>
              )}
              {showDormant &&
                dormant.map((r) => (
                  <MeetingCard
                    key={r.meeting.id}
                    row={r}
                    onOpen={() => selectMeeting(r.meeting.id)}
                    onQuickClose={quickCloseFor(r, openModal)}
                  />
                ))}
            </ul>

            <div className="hidden overflow-hidden rounded-xl border border-secondary sm:block">
              <table className="w-full text-sm">
                <thead className="text-left text-[12.5px] text-quaternary">
                  <tr>
                    <Th sorted={sortedAs("name")} onClick={() => sortBy("name")}>
                      Meeting
                    </Th>
                    <Th>Rhythm</Th>
                    <Th sorted={sortedAs("next")} onClick={() => sortBy("next")}>
                      Next
                    </Th>
                    <Th sorted={sortedAs("runway")} onClick={() => sortBy("runway")}>
                      <span title={`Planned ahead over the next ${Math.round(RUNWAY_DAYS / 7)} weeks`}>Runway</span>
                    </Th>
                    <Th sorted={sortedAs("state")} onClick={() => sortBy("state")}>
                      Readiness
                    </Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-secondary border-t border-secondary">
                  {active.map((r) => (
                    <MeetingRow
                      key={r.meeting.id}
                      row={r}
                      onOpen={() => selectMeeting(r.meeting.id)}
                      onQuickClose={quickCloseFor(r, openModal)}
                    />
                  ))}
                  {dormant.length > 0 && (
                    <tr>
                      <td colSpan={5} className="px-2 py-1.5">
                        <NotStartedToggle count={dormant.length} open={showDormant} onToggle={() => setShowDormant((v) => !v)} />
                      </td>
                    </tr>
                  )}
                  {showDormant &&
                    dormant.map((r) => (
                      <MeetingRow
                        key={r.meeting.id}
                        row={r}
                        onOpen={() => selectMeeting(r.meeting.id)}
                        onQuickClose={quickCloseFor(r, openModal)}
                      />
                    ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function MeetingCard({
  row: r,
  onOpen,
  onQuickClose,
}: {
  row: Row;
  onOpen: () => void;
  onQuickClose?: () => void;
}) {
  return (
    <li className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={onOpen}
        className="w-full rounded-xl border border-secondary bg-primary p-3 text-left touch:min-h-11"
      >
        <div className="flex items-center gap-2">
          <RhythmRing reading={r.readiness} size={18} />
          <span className="min-w-0 flex-1 truncate font-serif text-[17px] text-primary">{r.title}</span>
          <span className="shrink-0 font-mono text-caption text-secondary tabular-nums">{formatCountdown(r.readiness)}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 pl-[26px] text-caption text-quaternary">
          <span>{kindLabel(r)}</span>
          <span>·</span>
          <span>{RHYTHM_LABEL[r.meeting.rhythm]}</span>
          {r.loose > 0 && <LooseBadge count={r.loose} />}
        </div>
        {r.runway.level !== "none" && (
          <div className="mt-2 flex items-center gap-2.5 pl-[26px]" title={runwayTitle(r.runway)}>
            <RunwayTrack runway={r.runway} className="min-w-0 flex-1" />
            <RunwayCover runway={r.runway} />
          </div>
        )}
      </button>
      {onQuickClose && (
        <button
          type="button"
          onClick={onQuickClose}
          className="self-end px-1 text-[13px] font-semibold text-primary"
        >
          Quick close
        </button>
      )}
    </li>
  );
}

function MeetingRow({
  row: r,
  onOpen,
  onQuickClose,
}: {
  row: Row;
  onOpen: () => void;
  onQuickClose?: () => void;
}) {
  return (
    <tr
      {...tableRowActivationProps(onOpen, { label: `Open ${r.title}` })}
      className="group cursor-pointer transition-colors duration-[var(--dur-quick)] hover:bg-secondary focus-visible:bg-secondary"
    >
      <td className="px-4 py-3">
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-serif text-[17px] leading-[22px] text-primary">{r.title}</span>
          <span className="truncate text-[12.5px] text-quaternary">{kindLabel(r)}</span>
        </div>
      </td>
      <td className="px-4 py-2 text-xs text-quaternary">{RHYTHM_LABEL[r.meeting.rhythm]}</td>
      <td className="px-4 py-2">
        <span className="font-mono text-xs text-secondary tabular-nums">{formatCountdown(r.readiness)}</span>
      </td>
      <td className="px-4 py-2">
        <div className="flex items-center gap-2.5" title={runwayTitle(r.runway)}>
          {r.runway.level === "none" ? (
            <span className="text-xs text-quaternary">As needed</span>
          ) : (
            <>
              {/* Always drawn: the point is scanning down the column and seeing
                  which bars are short, without pointing at each row. */}
              <RunwayTrack runway={r.runway} className="w-[168px] shrink-0" />
              <RunwayCover runway={r.runway} />
            </>
          )}
          {r.loose > 0 && <LooseBadge count={r.loose} />}
        </div>
      </td>
      <td className="px-4 py-2">
        <span className="inline-flex items-center gap-3">
          <span className={cx("inline-flex items-center gap-2 text-[13px] font-medium", STATE_TEXT[r.readiness.state])}>
            <RhythmRing reading={r.readiness} size={18} />
            {STATE_LABEL[r.readiness.state]}
          </span>
          {onQuickClose && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onQuickClose();
              }}
              className="text-[13px] font-semibold text-primary hover:underline"
            >
              Quick close
            </button>
          )}
        </span>
      </td>
    </tr>
  );
}

/** The meetings that have never met, folded so the queue is only what's live. */
function NotStartedToggle({ count, open, onToggle }: { count: number; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-tertiary hover:bg-secondary hover:text-primary touch:min-h-11"
    >
      <ChevronDown aria-hidden className={cx("size-4 transition-transform duration-[var(--dur-base)]", !open && "-rotate-90")} />
      Not started
      <span className="text-quaternary tabular-nums">{count}</span>
    </button>
  );
}

const STATE_RANK: Record<string, number> = {
  drifting: 5,
  loose_end: 4,
  prep_due: 3,
  ready: 2,
  resting: 1,
  dormant: 0,
};

/** Who a meeting is with, in one word or name: "1:1", the team, "Check-in". */
function kindLabel(r: { meeting: { subjectKind: string; name?: string }; subjectName?: string }) {
  if (r.meeting.subjectKind === "person") return "1:1";
  if (r.meeting.subjectKind === "manager") return r.meeting.name ? `Check-in · ${r.subjectName ?? ""}` : "Check-in";
  return r.meeting.name ? (r.subjectName ?? "Team") : "Team meeting";
}

function quickCloseFor(
  r: Row,
  openModal: (modal: { kind: "quickClose"; sessionId: string }) => void,
): (() => void) | undefined {
  const sessionId = quickCloseAvailable(flagOn("quickClose"), r.readiness);
  if (!sessionId) return undefined;
  return () => openModal({ kind: "quickClose", sessionId });
}

function LooseBadge({ count }: { count: number }) {
  return (
    <span className="text-caption font-medium text-cond-watch-ink" title="Planned into a meeting that's already been and gone">
      {count} loose
    </span>
  );
}
