import { useMemo, useState } from "react";
import { useStore } from "../store/useStore";
import { Modal } from "./ui";
import {
  DEFAULT_DISPOSITION,
  DISPOSITIONS,
  quickCloseTopics,
  type TopicDisposition,
} from "../lib/quickClose";
import { dayName, meetingSubjectName, meetingTitle } from "../lib/readiness";
import { markWrapped } from "../lib/wrapUp";
import { toast } from "../lib/toasts";
import { cx } from "@/utils/cx";

/**
 * File a meeting that wasn't recorded: Covered / Next week / Park per topic,
 * optional notes, no model. Gated by `quickClose` — this sheet is only
 * mounted when the flag is on (ModalHost).
 */
export function QuickCloseSheet({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose: () => void;
}) {
  const sessions = useStore((s) => s.sessions);
  const meetings = useStore((s) => s.meetings);
  const topics = useStore((s) => s.topics);
  const people = useStore((s) => s.people);
  const teams = useStore((s) => s.teams);
  const managers = useStore((s) => s.managers);

  const session = sessions.find((o) => o.id === sessionId);
  const meeting = meetings.find((m) => m.id === session?.meetingId);
  const asked = useMemo(
    () => (session ? quickCloseTopics(topics, session.id) : []),
    [session, topics],
  );

  const [notes, setNotes] = useState("");
  const [choice, setChoice] = useState<Record<string, TopicDisposition>>(() =>
    Object.fromEntries(asked.map((t) => [t.id, DEFAULT_DISPOSITION])),
  );

  if (!session || !meeting) return null;

  const subjectName = meetingSubjectName(meeting, { people, teams, managers });
  const title = meeting.name?.trim() || meetingTitle(meeting, subjectName);

  const apply = () => {
    useStore.getState().quickCloseMeeting(sessionId, choice, notes);
    markWrapped(sessionId);
    toast({ message: `Closed ${title}.` });
    onClose();
  };

  return (
    <Modal
      title="Quick close"
      subtitle={`${title} · ${dayName(session.date)}`}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-[10px] px-4 text-[14px] font-semibold text-tertiary hover:text-secondary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={apply}
            className="h-10 rounded-[10px] bg-teal-600 px-4 text-[14px] font-semibold text-white dark:bg-teal-500 dark:text-stone-950"
          >
            Close meeting
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-secondary">Notes</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            placeholder="What you want kept — or leave blank and the topics still file."
            className="w-full resize-y rounded-[10px] border border-secondary bg-primary px-3 py-2.5 text-[14px] leading-[20px] text-primary outline-none placeholder:text-placeholder focus:border-teal-400"
          />
        </label>

        {asked.length > 0 ? (
          <section className="flex flex-col gap-1.5">
            <h3 className="eyebrow">Topics</h3>
            <ul className="flex flex-col gap-1">
              {asked.map((t) => (
                <li
                  key={t.id}
                  className="flex flex-col gap-2 rounded-[10px] px-2 py-2 sm:flex-row sm:items-center sm:justify-between"
                >
                  <span className="min-w-0 text-[14px] leading-[20px] text-primary">{t.text}</span>
                  <div
                    role="radiogroup"
                    aria-label={`What to do with ${t.text}`}
                    className="flex shrink-0 self-start rounded-[9px] border border-secondary p-0.5 sm:self-auto"
                  >
                    {DISPOSITIONS.map((d) => {
                      const on = (choice[t.id] ?? DEFAULT_DISPOSITION) === d.id;
                      return (
                        <button
                          key={d.id}
                          type="button"
                          role="radio"
                          aria-checked={on}
                          onClick={() => setChoice((prev) => ({ ...prev, [t.id]: d.id }))}
                          className={cx(
                            "h-8 rounded-[7px] px-2.5 text-[12.5px] font-semibold whitespace-nowrap",
                            on
                              ? "bg-teal-600 text-white dark:bg-teal-500 dark:text-stone-950"
                              : "text-tertiary hover:text-secondary",
                          )}
                        >
                          {d.label}
                        </button>
                      );
                    })}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <p className="text-[14px] text-secondary">Nothing was still on this agenda. Closing files the occurrence.</p>
        )}
      </div>
    </Modal>
  );
}
