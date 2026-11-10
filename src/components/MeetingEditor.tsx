import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useStore } from "../store/useStore";
import { readTrail, splitPath } from "../lib/navTrail";
import { parseRoute } from "../lib/routes";
import { findMeeting, type SlugSource } from "../lib/slugs";
import { placeOf } from "./shell/places";
import { SessionEditor } from "./SessionEditor";
import { SessionAgenda } from "./SessionAgenda";
import { ArcRun } from "./arcs/ArcRun";
import { SharedNotes } from "./sharing/SharedNotes";
import { RunContext } from "./RunContext";
import { Avatar } from "./Avatar";
import { LivePill } from "./LivePill";
import { endMeeting, joinMeeting, toggleListening, useLive } from "../lib/liveMeeting";
import { canTranscribe } from "../lib/transcriber";
import { ListenStatus } from "./ListenStatus";
import { DictateButton } from "./DictateButton";
import { TranscriptField } from "./TranscriptField";
import { WrapUpSheet } from "./WrapUpSheet";
import { markWrapped, wasWrapped } from "../lib/wrapUp";
import { addDays, meetingSubjectName, meetingTitle, todayISO } from "../lib/readiness";
import { DEMO } from "../lib/demo";
import { happenedTodayAvailable, occurrenceGuardOn } from "../lib/occurrenceGuard";

import { Input } from "@/components/base/input/input";
import { confirmAction } from "./ConfirmDialog";
import { autoFocusUnlessTouch } from "../lib/pointer";
import { ArrowLeft, DotsVertical, Stars02, Trash01 } from "@untitledui/icons";
import { useMenu } from "@/hooks/use-menu";

function formatEntryDate(iso: string): string {
  if (!iso) return "Untitled entry";
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/** A page, in the words the arrow should use for it. */
function describeOpener(opener: string | null, data: SlugSource): string | null {
  if (!opener) return null;
  const { pathname, search } = splitPath(opener);
  const route = parseRoute(pathname, search);
  if (route.view === "tab" && !route.peek) return placeOf(route.tab).label;
  const sel = route.view === "focus" ? route.target : route.peek;
  if (!sel) return null;
  switch (sel.kind) {
    case "person":
      return data.people.find((p) => p.id === sel.id)?.name ?? null;
    case "team":
      return data.teams.find((t) => t.id === sel.id)?.name ?? null;
    case "manager":
      return data.managers.find((m) => m.id === sel.id)?.name ?? null;
    case "meeting": {
      const meeting = findMeeting(data, sel.id);
      return meeting
        ? meetingTitle(meeting, meetingSubjectName(meeting, data))
        : null;
    }
    case "me":
      return "your profile";
  }
}

export function MeetingEditor({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose: () => void;
}) {
  const sessions = useStore((s) => s.sessions);
  const meetings = useStore((s) => s.meetings);
  const people = useStore((s) => s.people);
  const teams = useStore((s) => s.teams);
  const managers = useStore((s) => s.managers);
  const { state: locationState } = useLocation();
  const updateSession = useStore((s) => s.updateSession);
  const deleteSession = useStore((s) => s.deleteSession);
  const logHappenedToday = useStore((s) => s.logHappenedToday);
  const happenedTodaySessionId = useStore((s) => s.happenedTodaySessionId);
  const session = sessions.find((o) => o.id === sessionId);
  const meeting = meetings.find((m) => m.id === session?.meetingId);
  const person =
    meeting?.subjectKind === "person"
      ? people.find((p) => p.id === meeting.subjectId)
      : undefined;
  const team =
    meeting?.subjectKind === "team"
      ? teams.find((t) => t.id === meeting.subjectId)
      : undefined;
  const manager =
    meeting?.subjectKind === "manager"
      ? managers.find((m) => m.id === meeting.subjectId)
      : undefined;
  const subjectName =
    person?.name ?? team?.name ?? manager?.name ?? "this meeting";
  const meetingLabel =
    meeting?.name ??
    (person ? `1:1 with ${person.name}` : (team?.name ?? manager?.name ?? "meeting"));

  const [notes, setNotes] = useState(session?.notes ?? "");
  const [point, setPoint] = useState(session?.point ?? "");
  const [transcript, setTranscript] = useState(session?.transcript ?? "");
  const [date, setDate] = useState(session?.date ?? "");
  const [nextDate, setNextDate] = useState(session?.nextDate ?? "");
  // The mic belongs to the live meeting, not this screen: leaving Run keeps
  // it running, and only Done turns it off.
  const listening = useLive((s) => s.listening && s.sessionId === sessionId);
  const isLive = useLive((s) => s.sessionId === sessionId);
  const liveError = useLive((s) => s.error);
  // Resolved once at mount so the control can say up front whether it works.
  const [speechSupported] = useState(canTranscribe);
  const [showCapture, setShowCapture] = useState(
    Boolean(session?.transcript?.trim())
  );
  const [error, setError] = useState<string | null>(null);
  const [editingMeta, setEditingMeta] = useState(false);
  const [showTools, setShowTools] = useState(listening);
  // The wrap-up sheet, and what closing it means: leaving Run (Done) or not.
  const [wrapping, setWrapping] = useState<"done" | "menu" | null>(null);

  useEffect(() => {
    if (!session) return;
    setNotes(session.notes ?? "");
    setPoint(session.point ?? "");
    setTranscript(session.transcript ?? "");
    setDate(session.date);
    setNextDate(session.nextDate ?? "");
    joinMeeting(session.id);
  }, [session?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // The mic writes into the store, sometimes after it's been turned off (the
  // last stretch is still being transcribed), so the field follows the store —
  // without eating the space you just typed, which the store trims away.
  useEffect(() => {
    const next = session?.transcript ?? "";
    setTranscript((cur) => (cur.trim() === next ? cur : next));
  }, [session?.transcript]);

  // Likewise the write-up and the point, which the wrap-up and Dictate write
  // from outside the editor. Left stale, the next keystroke would put the old
  // text back over theirs.
  useEffect(() => {
    const next = session?.notes ?? "";
    setNotes((cur) => (cur.trim() === next ? cur : next));
  }, [session?.notes]);

  useEffect(() => {
    if (!occurrenceGuardOn()) return;
    if (session?.date) setDate(session.date);
  }, [session?.date]);
  useEffect(() => {
    const next = session?.point ?? "";
    setPoint((cur) => (cur.trim() === next ? cur : next));
  }, [session?.point]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // The sheet owns Escape while it's open.
      if (e.key !== "Escape" || wrapping) return;
      if (showCapture || showTools || editingMeta) {
        e.preventDefault();
        setShowCapture(false);
        setShowTools(false);
        setEditingMeta(false);
        return;
      }
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showCapture, showTools, editingMeta, wrapping, onClose]);

  if (!session || !meeting) {
    return null;
  }

  const persist = (patch: Partial<{
    notes: string;
    point: string;
    transcript: string;
    date: string;
    nextDate: string | undefined;
  }>) => {
    const next: Partial<typeof session> = {};
    if ("notes" in patch) next.notes = patch.notes?.trim() || undefined;
    if ("point" in patch) next.point = patch.point?.trim() || undefined;
    if ("transcript" in patch)
      next.transcript = patch.transcript?.trim() || undefined;
    if ("date" in patch && patch.date) next.date = patch.date;
    if ("nextDate" in patch) next.nextDate = patch.nextDate || undefined;
    updateSession(session.id, next);
  };

  const saveNotes = (value: string) => {
    setNotes(value);
    persist({ notes: value });
  };

  const saveTranscript = (value: string) => {
    setTranscript(value);
    persist({ transcript: value });
  };

  const toggleListen = () => {
    setShowCapture(true);
    setShowTools(true);
    if (!speechSupported) {
      setError(
        "Live listen isn't supported in this browser. Paste a transcript instead."
      );
      return;
    }
    setError(null);
    toggleListening(session.id);
  };

  // Done ends the meeting. The arrow only steps out of it.
  const finish = () => {
    endMeeting(session.id);
    onClose();
  };

  /*
   * Done wraps up first when there's something to wrap up: a meeting that was
   * live or just happened, with a transcript or notes, not wrapped up before.
   * Tidying an old write-up just closes. The demo has no AI to ask.
   */
  const done = () => {
    const recent = isLive || session.date >= addDays(todayISO(), -1);
    const hasContent = Boolean(transcript.trim() || notes.trim());
    if (!DEMO && recent && hasContent && !wasWrapped(session.id)) setWrapping("done");
    else finish();
  };
  const closeWrapUp = () => {
    const leaving = wrapping === "done";
    setWrapping(null);
    if (leaving) finish();
  };

  const firstName = subjectName.split(" ")[0] ?? subjectName;
  // The arrow goes back to wherever the write-up was opened from, so that's
  // what it names — "Today" if you came from Today, not the subject's profile.
  const backLabel =
    describeOpener(readTrail(locationState).opener, {
      meetings,
      people,
      teams,
      managers,
    }) ??
    (person ? person.name : team ? team.name : manager ? manager.name : subjectName);

  const subjectPhoto = person?.photo ?? manager?.photo;
  const runTitle = meeting.name?.trim()
    ? meeting.name
    : person
      ? `1:1 with ${person.name}`
      : manager
        ? `Check-in with ${manager.name}`
        : (team?.name ?? "Meeting");
  const dayLine = date
    ? new Date(`${date}T12:00:00`)
        .toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
        .toUpperCase()
    : "";
  const offerHappenedToday = happenedTodayAvailable(
    occurrenceGuardOn(),
    happenedTodaySessionId,
    session.id,
    session.date,
    todayISO()
  );

  /*
   * Run: the meeting while it's happening. Leather across the top so it reads
   * as a different room from the rest of the app; the agenda on the left, the
   * write-up in the middle in the serif, and the person's context on the
   * right. Below lg the three stack, agenda first.
   */
  return (
    <div className="meeting-editor-fullscreen bg-secondary">
      {/* One row: the title gives way before Done does. It used to wrap, and
          on a phone Done fell onto a line of its own under a long 1:1 name. */}
      <header className="pad-safe-top flex shrink-0 items-center gap-2 bg-leather px-3 pb-2.5 text-leather-fg [--pad-safe-top:0.625rem] sm:gap-3 sm:px-5">
        <button
          type="button"
          onClick={onClose}
          aria-label={
            isLive
              ? `Step out to ${backLabel} — the meeting keeps running`
              : `Leave and go back to ${backLabel}`
          }
          title={isLive ? "Step out — the meeting keeps running" : undefined}
          className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-leather-hi text-leather-ink transition-colors hover:text-leather-fg"
        >
          <ArrowLeft className="size-4" />
        </button>
        <Avatar name={subjectName} photo={subjectPhoto} size={36} className={team ? "!rounded-[10px]" : undefined} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-serif text-[19px] leading-6">{runTitle}</span>
          <span className="truncate font-mono text-[11px] tracking-[0.02em] text-leather-ink">
            {dayLine}
            {nextDate && ` · NEXT ${new Date(`${nextDate}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }).toUpperCase()}`}
          </span>
        </div>
        {/* Another meeting still running — reading last week's notes
            mid-1:1 shouldn't lose the way back to it. */}
        <LivePill tone="run" exceptSessionId={session.id} />
        <button
          type="button"
          onClick={() => setShowTools((v) => !v)}
          aria-pressed={showTools}
          className={`h-9 shrink-0 rounded-[9px] border px-3 text-[13px] font-medium transition-colors max-sm:hidden ${
            showTools ? "border-leather-hi bg-leather-hi text-leather-fg" : "border-leather-line text-leather-ink hover:text-leather-fg"
          }`}
        >
          {listening ? "● Listening" : "Transcribe"}
        </button>
        <EntryMenu
          onWrapUp={() => setWrapping("menu")}
          onDelete={async () => {
            if (
              await confirmAction({
                title: "Delete this entry?",
                body: "The write-up and any transcript go with it.",
              })
            ) {
              deleteSession(session.id);
              onClose();
            }
          }}
        />
        <button
          type="button"
          onClick={done}
          title={isLive ? "End the meeting" : undefined}
          className="h-9 shrink-0 rounded-[9px] bg-leather-fg px-4 text-[13.5px] font-semibold text-stone-950 hover:bg-white"
        >
          Done
        </button>
      </header>

      <div className="meeting-editor-scroll">
        <div className="flex min-h-full flex-wrap items-stretch">
          {/* Agenda */}
          <aside
            aria-label="Agenda"
            className="w-full border-secondary px-4 pt-6 sm:px-6 lg:w-[340px] lg:shrink-0 lg:border-r lg:pt-8 lg:pb-8"
          >
            <div className="flex flex-col gap-6">
              <ArcRun meeting={meeting} session={session} />
              <SessionAgenda session={session} meeting={meeting} ensureSession={() => session.id} />
            </div>
          </aside>

          {/* The write-up */}
          <main className="min-w-0 flex-[999_1_480px] bg-primary px-5 py-8 sm:px-10 lg:px-14 lg:py-10">
            <div className="mx-auto flex w-full max-w-[680px] flex-col gap-6">
              <header className="flex flex-col gap-3">
                {editingMeta ? (
                  <div className="meeting-editor-meta-form">
                    <Input
                      type="date"
                      label="Date"
                      size="sm"
                      value={date}
                      autoFocus={autoFocusUnlessTouch()}
                      onChange={(value) => {
                        setDate(value);
                        persist({ date: value });
                      }}
                      onBlur={() => setEditingMeta(false)}
                    />
                    <Input
                      type="date"
                      label="Next time"
                      size="sm"
                      value={nextDate}
                      onChange={(value) => {
                        setNextDate(value);
                        updateSession(session.id, {
                          nextDate: value || undefined,
                        });
                      }}
                      onBlur={() => setEditingMeta(false)}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    className="meeting-editor-title-btn"
                    onClick={() => setEditingMeta(true)}
                    title="Edit dates"
                  >
                    <span className="eyebrow">{formatEntryDate(date)} · edit dates</span>
                  </button>
                )}
                {offerHappenedToday && (
                  <button
                    type="button"
                    className="self-start rounded-[9px] border border-primary bg-primary px-3 h-9 text-[13px] font-semibold text-primary hover:bg-secondary"
                    onClick={() => logHappenedToday(session.id)}
                  >
                    It happened today
                  </button>
                )}
                <label htmlFor="why-we-met" className="sr-only">
                  Why we met this time
                </label>
                <input
                  id="why-we-met"
                  type="text"
                  className="w-full border-0 bg-transparent p-0 font-serif text-[26px] leading-[34px] font-[450] text-primary outline-none placeholder:text-placeholder focus-visible:!outline-none"
                  placeholder="Why we met this time…"
                  value={point}
                  onChange={(e) => {
                    setPoint(e.target.value);
                    persist({ point: e.target.value });
                  }}
                />
              </header>

              {showTools && (
                <div className="meeting-editor-tools">
                  <div className="meeting-editor-tools-row">
                    {speechSupported ? (
                      <button
                        type="button"
                        className={`meeting-editor-chip ${listening ? "is-listening" : ""}`}
                        onClick={toggleListen}
                      >
                        {listening ? "● Listening…" : "Listen"}
                      </button>
                    ) : (
                      <span
                        className="meeting-editor-chip cursor-not-allowed opacity-60"
                        title="Live listen needs a microphone this browser can record from"
                      >
                        Listen unavailable — paste a transcript
                      </span>
                    )}
                    <button
                      type="button"
                      className={`meeting-editor-chip ${showCapture ? "is-active" : ""}`}
                      onClick={() => setShowCapture((v) => !v)}
                    >
                      Transcript
                    </button>
                    <ListenStatus sessionId={session.id} />
                  </div>

                  {(error ?? (isLive ? liveError : null)) && (
                    <p className="meeting-editor-error">{error ?? liveError}</p>
                  )}

                  {showCapture && (
                    <TranscriptField
                      placeholder={`Paste a transcript from ${person ? `your 1:1 with ${firstName}` : meetingLabel}, or use Listen…`}
                      value={transcript}
                      onChange={saveTranscript}
                    />
                  )}
                </div>
              )}

              <SharedNotes meeting={meeting} session={session} />

              <SessionEditor
                sessionId={session.id}
                value={notes}
                onChange={saveNotes}
                actions={
                  <DictateButton
                    meetingId={meeting.id}
                    onAppend={(text) => {
                      const cur = useStore.getState().sessions.find((o) => o.id === session.id)?.notes ?? "";
                      saveNotes(cur.trim() ? `${cur.trimEnd()}\n\n${text}` : text);
                    }}
                  />
                }
                placeholder={`What did you and ${firstName} cover?\n\n## Summary\n\n## Decisions\n- \n\n## Commitments\n- `}
                autoFocus={!notes.trim() && autoFocusUnlessTouch()}
              />

              <p className="flex flex-wrap gap-x-5 gap-y-1 border-t border-secondary pt-4 text-[12px] text-quaternary">
                <span>
                  <span className="font-mono">/</span> for headings, lists and to-dos
                </span>
                <span>Saved as you type</span>
              </p>
            </div>
          </main>

          {/* What you want in your peripheral vision */}
          <aside
            aria-label={`About ${subjectName}`}
            className="w-full border-secondary px-5 py-8 sm:px-6 xl:w-[320px] xl:shrink-0 xl:border-l"
          >
            <RunContext kind={meeting.subjectKind} id={meeting.subjectId} />
          </aside>
        </div>
      </div>

      {wrapping && (
        <WrapUpSheet
          sessionId={session.id}
          onDone={closeWrapUp}
          onSkip={() => {
            // Turned down once is an answer; Done won't ask again.
            markWrapped(session.id);
            closeWrapUp();
          }}
        />
      )}
    </div>
  );
}

/**
 * Less-used actions for the open entry, held behind one control so "Delete"
 * is never adjacent to a benign button in the topbar.
 */
function EntryMenu({ onWrapUp, onDelete }: { onWrapUp: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const { triggerProps, menuProps, close } = useMenu(open, setOpen);

  return (
    <div className="relative shrink-0">
      <button
        {...triggerProps}
        type="button"
        aria-label="Entry actions"
        onClick={() => setOpen((v) => !v)}
        className="flex size-9 items-center justify-center rounded-[9px] text-leather-ink transition-colors hover:bg-leather-hi hover:text-leather-fg touch:size-11"
      >
        <DotsVertical className="size-4.5" />
      </button>
      {open && (
        <div
          {...menuProps}
          aria-label="Entry actions"
          className="absolute right-0 z-50 mt-1 w-48 overflow-hidden rounded-xl border border-stone-200 bg-primary py-1 shadow-xl dark:border-stone-700"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close(false);
              onWrapUp();
            }}
            className="flex min-h-11 w-full items-center gap-2.5 px-4 text-left text-sm text-primary active:bg-secondary"
          >
            <Stars02 className="size-4 shrink-0 text-tertiary" />
            Wrap up with AI
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close(false);
              onDelete();
            }}
            className="flex min-h-11 w-full items-center gap-2.5 px-4 text-left text-sm text-red-600 active:bg-red-50 dark:text-red-400 dark:active:bg-red-950/40"
          >
            <Trash01 className="size-4 shrink-0" />
            Delete entry
          </button>
        </div>
      )}
    </div>
  );
}
