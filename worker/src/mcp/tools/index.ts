import type { PromptDef, ToolDef } from "../server.ts";
import { arcTools } from "./arcs.ts";
import { meetingTools } from "./meetings.ts";
import { peopleTools } from "./people.ts";
import { readTools } from "./read.ts";
import { scheduleTools } from "./schedule.ts";
import { topicTools } from "./topics.ts";

export const TOOLS: ToolDef[] = [...readTools, ...meetingTools, ...topicTools, ...scheduleTools, ...arcTools, ...peopleTools];

/**
 * What a model is told when it connects. It is the whole mental model in a
 * page: written so that an assistant which reads only this and the tool
 * descriptions does the right thing without being taught by trial and error.
 */
export const INSTRUCTIONS = `Polarch is a leader's meeting workspace. You are helping the leader run their meetings: see what's coming up, plan and rearrange agendas, capture and file ideas, tag them, and close meetings out.

HOW IT'S ORGANISED
- Meeting: a recurring conversation — a 1:1 or a team meeting. Address one by id or by a name like "Meghan" or "Staff meeting". list_meetings lists them; create_meeting starts a new one with someone in the workspace.
- Occurrence: one date of a meeting. Upcoming dates follow the meeting's rhythm; they're only *projected* until something is planned into them, and planning into one books it. Never invent dates: read list_upcoming or get_plan and use the dates they show.
- Topic: something to discuss. It sits in the idea tray (not yet planned), parked (set aside), or placed on one occurrence, optionally inside a section (a row of the meeting's standing agenda: Check-in, Training, Prayer…). A topic can carry talking points. Ideas with no meeting wait in the inbox.
- Tag: a label on topics, shared across meetings. A section usually stamps its tag on anything placed in it, and coverage targets ("Prayer at least every 4 meetings") count tags.
- Follow-up: a commitment that outlives a meeting. Open ones start the next meeting as "since last time".
- Arc: something worked through one step per meeting — a book read together, an onboarding plan. An arc stores a position and a pace, not a schedule: skip a week and it slides on its own. Each step has Read (before), Talk (in the meeting) and Try (practise before next time; becomes a follow-up when the step is done).

WORKING WELL
- Start with list_upcoming for "what's coming up" across every meeting; get_agenda for one meeting's next occurrence; get_plan for the weeks ahead of one meeting; list_ideas for the tray.
- What goes where: move_topics places topics on a week (and section), back in the tray, or parked; tag_topics tags many at once; add_topics captures new ones, straight onto a week or into the tray.
- Dates are YYYY-MM-DD on the leader's calendar. When you know today's date, pass it as \`today\`; the default is the date in UTC.
- Prefer the gentlest tool: move or park a topic rather than delete it; skip a week rather than deleting a meeting; pause an arc rather than deleting it.
- A meeting shared with someone shows them any topic placed on a week, and any idea marked shared, unless it is private. Write results warn you when that applies; pass private:true for anything the leader wants to keep to themselves.
- Every change returns a change_id and can be reversed with undo_change. If you made a mistake, undo it and say so.
- When you're drafting an arc (say, chapters of a book), only state chapter titles and page ranges you are confident of, and tell the leader to check them against their edition.

THE PEOPLE RECORDS
- How the leader rates, prays for and assesses people — health reads, prayer, CliftonStrengths and other assessments, how to lead someone, notes, wins, goals, past write-ups and transcripts — are the people records. Only a connection the leader explicitly gave them can see them (get_person, get_session, list_prayers, update_person, save_record…). If those tools aren't in your list, you don't have them: never ask the leader to paste that information instead.
- Treat them as confidential. Quote them to the leader when it helps; never put them into a topic on a shared meeting, a follow-up the other person can see, or anything outside this conversation.`;

const L = (...lines: string[]) => lines.join("\n");

export const PROMPTS: PromptDef[] = [
  {
    name: "plan_next_meeting",
    title: "Plan the next meeting",
    description: "Look at what's waiting and propose an agenda for a meeting's next occurrence.",
    arguments: [
      { name: "meeting", description: "Meeting name or id, e.g. Meghan", required: true },
      { name: "focus", description: "Anything the leader wants this meeting to be about" },
    ],
    render: (a) =>
      L(
        `Help me plan my next meeting: ${a.meeting}.${a.focus ? ` I want it to be about: ${a.focus}.` : ""}`,
        "1. Read get_agenda for the next occurrence, list_follow_ups for this meeting, and list_ideas for what's waiting.",
        "2. Propose what should be on the agenda, by section, and what should wait — say why in a line each. Flag anything that has been carried more than once.",
        "3. Ask me before changing anything. Then make the changes with move_topics / add_topics and show me the result.",
      ),
  },
  {
    name: "plan_the_weeks_ahead",
    title: "Plan the weeks ahead",
    description: "Spread what's waiting across the upcoming weeks, balanced by section.",
    arguments: [
      { name: "meeting", description: "Meeting name or id", required: true },
      { name: "weeks", description: "How many weeks ahead (default 6)" },
    ],
    render: (a) =>
      L(
        `Help me plan the next ${a.weeks ?? "6"} weeks of ${a.meeting}.`,
        "1. Read get_plan. Note empty sections, coverage targets falling behind, and any week already overloaded.",
        "2. Propose where each idea in the tray should land, keeping weeks light enough to actually finish and the arc step for each week in mind.",
        "3. Show me the proposal as a week-by-week table first. When I approve, apply it with move_topics (one call per destination) and read get_plan again to confirm.",
      ),
  },
  {
    name: "start_an_arc",
    title: "Start an arc",
    description: "Set up a book, plan or study to work through one step per meeting.",
    arguments: [
      { name: "meeting", description: "Meeting name or id", required: true },
      { name: "title", description: "The book or plan, e.g. Crucial Conversations", required: true },
      { name: "pace", description: "How often a step lands, e.g. every meeting, every other meeting" },
    ],
    render: (a) =>
      L(
        `I want to start an arc in ${a.meeting}: "${a.title}"${a.pace ? `, ${a.pace}` : ""}.`,
        "1. Draft the steps — for a book, one per chapter with a Read, one or two Talk questions that are personal and concrete, and a small Try practice. Only state chapter titles and page ranges you're sure of, and tell me to check them against my edition.",
        "2. Show me the draft and wait for my edits.",
        "3. Create it with create_arc, then show get_arc so I can see which meeting each step lands on.",
      ),
  },
  {
    name: "after_the_meeting",
    title: "Close out a meeting",
    description: "Record what happened: covered topics, the arc step, and what to follow up.",
    arguments: [{ name: "meeting", description: "Meeting name or id", required: true }],
    render: (a) =>
      L(
        `My ${a.meeting} meeting just happened. Help me close it out.`,
        "1. Read get_agenda for today's occurrence.",
        "2. Ask me which topics we covered, which didn't get covered, and how the arc step went (done, or carry on).",
        "3. Then: set_topics_covered for what we covered; roll_topics_forward for what we didn't; mark_arc_step for the arc; add_follow_up for anything I committed to.",
      ),
  },
  {
    name: "weekly_review",
    title: "Weekly review",
    description: "Across all meetings: what needs attention this week.",
    arguments: [],
    render: () =>
      L(
        "Do a review of my meetings for the week ahead.",
        "1. list_upcoming for the next 7 days, then get_agenda for each meeting on it.",
        "2. For each: is anything planned? Any follow-ups open for more than two weeks? Topics carried repeatedly? An arc step with a Read due?",
        "3. Give me a short list of what to do first, and offer to make the changes.",
      ),
  },
];
