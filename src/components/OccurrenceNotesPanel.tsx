import { useEffect, useMemo, useState } from "react";
import { pushBackWeek } from "./pushBack";
import type { Session, TrackedMeeting } from "../types";
import {
  RHYTHM_LABEL,
  daysBetween,
  meetingSubjectName,
  meetingTitle,
  todayISO,
} from "../lib/readiness";
import { startMeeting } from "../lib/liveMeeting";
import { cx } from "@/utils/cx";
import { useStore } from "../store/useStore";
import { parseColumnKey, plannedSlots } from "../lib/topics";
import { happenedTodayAvailable, occurrenceGuardOn } from "../lib/occurrenceGuard";
import { SessionAgenda } from "./SessionAgenda";
import { SessionEditor } from "./SessionEditor";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Calendar, Expand01, Play, X } from "@untitledui/icons";

const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { ...opts, timeZone: "UTC" });

/**
 * The occurrence a key names: the session it points at, or whatever is on the
 * books for that date. A skipped week still resolves — to its skipped
 * session — so the panel can say so and offer it back.
 */
function resolveSession(
  meetingId: string,
  slotKey: string,
  sessions: Session[]
): { session: Session | null; date: string | null } {
  const target = parseColumnKey(slotKey);
  if (target.kind === "session") {
    const session = sessions.find((s) => s.id === target.sessionId) ?? null;
    return { session, date: session?.date ?? null };
  }
  if (target.kind === "projected") {
    const onDay = sessions.filter((s) => s.meetingId === meetingId && s.date === target.date);
    const session = onDay.find((s) => s.kind !== "skipped") ?? onDay[0] ?? null;
    return { session, date: target.date };
  }
  return { session: null, date: null };
}

/**
 * One occurrence: when it is, what's on it, and the write-up.
 *
 * Opening a week only looks at it. Nothing is booked until something goes in
 * — a topic, a note, a start — at which point `ensure` makes the occurrence
 * real and tells the host its new key.
 */
export function OccurrenceNotesPanel({
  meeting,
  slotKey,
  onClose,
  onOpenFullEditor,
  onMaterialized,
}: {
  meeting: TrackedMeeting;
  slotKey: string;
  onClose?: () => void;
  onOpenFullEditor?: (sessionId: string) => void;
  /** The occurrence just became a real session. */
  onMaterialized?: (sessionId: string, date: string) => void;
}) {
  const sessions = useStore((s) => s.sessions);
  const topics = useStore((s) => s.topics);
  const people = useStore((s) => s.people);
  const teams = useStore((s) => s.teams);
  const managers = useStore((s) => s.managers);
  const updateSession = useStore((s) => s.updateSession);
  const addSession = useStore((s) => s.addSession);
  const addExtraOccurrence = useStore((s) => s.addExtraOccurrence);
  const today = todayISO();

  const { session, date } = useMemo(
    () => resolveSession(meeting.id, slotKey, sessions),
    [meeting.id, slotKey, sessions]
  );

  // Is this date one the rhythm draws? If not, writing into it logs a one-off.
  const onRhythm = useMemo(
    () =>
      Boolean(date) &&
      plannedSlots(meeting, sessions, topics, today, 26).some((s) => s.date === date),
    [meeting, sessions, topics, today, date]
  );

  const [notes, setNotes] = useState(session?.notes ?? "");
  useEffect(() => {
    setNotes(session?.notes ?? "");
  }, [session?.id, session?.notes]);

  if (!date) return null;

  const ensure = (): string => {
    if (session && session.kind !== "skipped") return session.id;
    const id = onRhythm
      ? addSession({ meetingId: meeting.id, date })
      : addExtraOccurrence(meeting.id, date);
    onMaterialized?.(id, date);
    return id;
  };

  const skipped = session?.kind === "skipped";
  const subjectName = meetingSubjectName(meeting, { people, teams, managers });
  const title = meetingTitle(meeting, subjectName);

  return (
    <div className="occurrence-notes-panel flex h-full min-h-0 flex-col bg-primary">
      <OccurrenceWhen
        meeting={meeting}
        title={title}
        session={session}
        date={date}
        onRhythm={onRhythm}
        onGone={onClose}
        onClose={onClose}
        onStart={
          onOpenFullEditor && !skipped
            ? () => {
                const id = ensure();
                // Today's or ahead is starting it; a past week is its notes.
                if (date >= todayISO()) startMeeting(id);
                onOpenFullEditor(id);
              }
            : undefined
        }
      />

      {skipped ? (
        <div className="flex flex-col items-start gap-1.5 px-5 py-8">
          <p className="font-serif text-[19px] text-secondary italic">This week isn't happening.</p>
          <p className="text-[13px] text-tertiary">
            Anything planned for it went back to Ideas.
          </p>
        </div>
      ) : (
        <div className="scroll-contain min-h-0 flex-1 overflow-y-auto">
          <div className="px-5 py-5">
            <SessionAgenda session={session} meeting={meeting} ensureSession={ensure} />
          </div>
          <div className="flex flex-col gap-2 border-t border-secondary px-5 pt-4 pb-6">
            <span className="eyebrow">Notes</span>
            <div className="occurrence-notes-editor">
              <SessionEditor
                value={notes}
                onChange={(value) => {
                  setNotes(value);
                  const id = value.trim() || session ? ensure() : null;
                  if (id) updateSession(id, { notes: value.trim() || undefined });
                }}
                // Keyed by the occurrence, not the session, so the first
                // keystroke that books the week doesn't remount the editor.
                sessionId={`${meeting.id}:${date}`}
                placeholder="What did you cover? Type / for headings, lists and to-dos."
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * When this occurrence is, and changing it the way a calendar does: move just
 * this one, or the series from here on; skip a week; add or remove a one-off.
 */
function OccurrenceWhen({
  meeting,
  title,
  session,
  date,
  onRhythm,
  onGone,
  onClose,
  onStart,
}: {
  meeting: TrackedMeeting;
  title: string;
  session: Session | null;
  date: string;
  onRhythm: boolean;
  onGone?: () => void;
  onClose?: () => void;
  onStart?: () => void;
}) {
  const moveOccurrence = useStore((s) => s.moveOccurrence);
  const skipOccurrence = useStore((s) => s.skipOccurrence);
  const restoreOccurrence = useStore((s) => s.restoreOccurrence);
  const logHappenedToday = useStore((s) => s.logHappenedToday);
  const happenedTodaySessionId = useStore((s) => s.happenedTodaySessionId);
  const [editing, setEditing] = useState(false);
  const [to, setTo] = useState(date);
  const today = todayISO();

  useEffect(() => {
    setTo(date);
    setEditing(false);
  }, [session?.id, date]);

  const recurring = meeting.rhythm !== "as_needed";
  const extra = session?.kind === "extra" || (!session && !onRhythm);
  const skipped = session?.kind === "skipped";
  const moved = Boolean(session?.seriesDate && session.seriesDate !== session.date && !skipped);
  // A future meeting is always movable; a past one only while nothing was
  // written, because a written-up meeting happened on the day it did.
  const upcoming = date >= today;
  const changeable = upcoming || !session?.notes?.trim();
  const offerHappenedToday = session
    ? happenedTodayAvailable(
        occurrenceGuardOn(),
        happenedTodaySessionId,
        session.id,
        session.date,
        today
      )
    : false;
  const from = { sessionId: session?.id ?? null, date };

  const days = daysBetween(today, date);
  const when =
    days === 0
      ? "Today"
      : days === 1
        ? "Tomorrow"
        : days === -1
          ? "Yesterday"
          : days > 0
            ? `In ${days} days`
            : `${-days} days ago`;
  const detail = skipped
    ? "Skipped"
    : extra
      ? session
        ? "One-off"
        : "Not a regular date"
      : moved
        ? `Moved from ${fmt(session!.seriesDate!, { weekday: "short", month: "short", day: "numeric" })}`
        : recurring
          ? `${RHYTHM_LABEL[meeting.rhythm]} · ${session ? "booked" : "not booked yet"}`
          : session
            ? "Booked"
            : "Not booked yet";

  const apply = (scope: "one" | "series") => {
    if (!to || to === date) {
      setEditing(false);
      return;
    }
    moveOccurrence(meeting.id, from, to, scope);
    setEditing(false);
  };

  const quiet =
    "inline-flex h-9 items-center gap-1.5 rounded-[9px] px-2.5 text-[13px] font-semibold text-secondary transition-colors hover:bg-secondary hover:text-primary touch:min-h-11";

  return (
    <div className="flex shrink-0 flex-col gap-3.5 border-b border-secondary px-5 pt-5 pb-4">
      <div className="flex items-start gap-1">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate font-mono text-[11px] text-quaternary uppercase">
            {fmt(date, { weekday: "long" })} · {title}
          </span>
          <h2
            className={cx(
              "font-serif text-[30px] leading-[34px]",
              skipped && "text-quaternary line-through"
            )}
          >
            {fmt(date, { month: "long", day: "numeric" })}
          </h2>
          <span className="text-[13px] text-secondary">
            {when} · {detail}
          </span>
        </div>
        {onStart && (
          <ButtonUtility
            size="sm"
            color="tertiary"
            icon={Expand01}
            tooltip="Open as a full page"
            onClick={onStart}
          />
        )}
        {onClose && (
          <ButtonUtility size="sm" color="tertiary" icon={X} tooltip="Close" onClick={onClose} />
        )}
      </div>

      {editing ? (
        <div className="flex flex-col gap-2.5 rounded-[12px] bg-secondary p-3">
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-semibold text-secondary">Move it to</span>
            <input
              type="date"
              aria-label="New date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              autoFocus
              onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
              className="h-9 rounded-[9px] border border-primary bg-primary px-2.5 font-mono text-[12.5px] text-primary outline-none focus:border-teal-400"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            {recurring && !extra ? (
              <>
                <button
                  type="button"
                  onClick={() => apply("one")}
                  disabled={to === date}
                  className="h-9 rounded-[9px] bg-teal-600 px-3 text-[13px] font-semibold text-white disabled:opacity-50 dark:bg-teal-500 dark:text-stone-950"
                >
                  Just this one
                </button>
                <button
                  type="button"
                  onClick={() => apply("series")}
                  disabled={to === date}
                  className="h-9 rounded-[9px] border border-primary bg-primary px-3 text-[13px] font-semibold text-primary disabled:opacity-50"
                >
                  This and every one after
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => apply("one")}
                disabled={to === date}
                className="h-9 rounded-[9px] bg-teal-600 px-3 text-[13px] font-semibold text-white disabled:opacity-50 dark:bg-teal-500 dark:text-stone-950"
              >
                Move
              </button>
            )}
            <button type="button" onClick={() => setEditing(false)} className={quiet}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {skipped ? (
            <button
              type="button"
              onClick={() => session && restoreOccurrence(session.id)}
              className="inline-flex h-9 items-center gap-2 rounded-[9px] bg-teal-600 px-3.5 text-[13px] font-semibold text-white dark:bg-teal-500 dark:text-stone-950"
            >
              Restore this week
            </button>
          ) : (
            <>
              {onStart && (
                <button
                  type="button"
                  onClick={onStart}
                  className="inline-flex h-9 items-center gap-2 rounded-[9px] bg-teal-600 px-3.5 text-[13px] font-semibold text-white shadow-xs transition-colors hover:bg-teal-700 touch:min-h-11 dark:bg-teal-500 dark:text-stone-950"
                >
                  <Play aria-hidden className="size-3.5" />
                  {upcoming ? "Start meeting" : "Open write-up"}
                </button>
              )}
              {offerHappenedToday && session && (
                <button
                  type="button"
                  onClick={() => logHappenedToday(session.id)}
                  className="inline-flex h-9 items-center rounded-[9px] border border-primary bg-primary px-3.5 text-[13px] font-semibold text-primary hover:bg-secondary touch:min-h-11"
                >
                  It happened today
                </button>
              )}
              {changeable && (
                <button type="button" onClick={() => setEditing(true)} className={quiet}>
                  <Calendar aria-hidden className="size-4 text-tertiary" />
                  Reschedule
                </button>
              )}
              {moved && changeable && session && (
                <button
                  type="button"
                  onClick={() => restoreOccurrence(session.id)}
                  className={quiet}
                >
                  Move back
                </button>
              )}
              {changeable && (
                <button
                  type="button"
                  onClick={() => pushBackWeek(meeting.id, from, false)}
                  className={quiet}
                  title="This week's items move to the next meeting, and every later week's move along one"
                >
                  Push back a week
                </button>
              )}
              {changeable && recurring && !extra && (
                <button
                  type="button"
                  onClick={() => pushBackWeek(meeting.id, from, true)}
                  className={quiet}
                  title="Not meeting this week: its items, and every later week's, move along one"
                >
                  Skip this week
                </button>
              )}
              {extra && session && changeable && (
                <button
                  type="button"
                  onClick={() => {
                    skipOccurrence(meeting.id, from);
                    onGone?.();
                  }}
                  className={quiet}
                >
                  Remove one-off
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
