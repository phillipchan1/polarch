# Polarch

A web app that shows the teams and people you lead as a visual org-chart tree,
with an assessment-based profile (CliftonStrengths, Enneagram, MBTI) and an AI
coach for each person. **Cloud-backed** on Cloudflare Workers + Neon, with
**magic-link sign-in** (Cloudflare Email Service). Cutover steps live in **[RUNBOOK.md](RUNBOOK.md)**.

## Setup

Local Worker + Vite: copy `.env.example` → `.env.local` and `.dev.vars.example`
→ `.dev.vars`, then see **[RUNBOOK.md](RUNBOOK.md)**. Historical Supabase
notes are in **[SETUP.md](SETUP.md)**.

```sh
npm install
npm run dev
```

Open http://localhost:5173 and **Email me a sign-in link**. A brand-new
allowlisted account is seeded with starter data (teams + people, a mix of
assessed and unassessed). If you used the old localStorage version in the same
browser, that data is imported automatically on first sign-in.

## Architecture

- **Auth**: Better Auth magic link on the Worker. Sign-in and sign-up are
  allowlist-only (`ALLOWED_EMAILS`). Each user gets a private workspace.
- **Data**: normalized Postgres tables (one per entity), all scoped to the
  signed-in user. The Zustand store still works optimistically in memory; a thin
  repository layer ([`src/lib/repo.ts`](src/lib/repo.ts)) syncs changed
  collections to Neon (debounced) and hydrates on login.

## Design language: Leather & Gilt

A well-kept leather journal: a deep teal leather frames the app (the sidebar,
the phone's tab bar, the Run header), the working surface is a cool paper,
gilt marks what's worth celebrating (the mark, wins, answered prayer) and
vesper violet is prayer and nothing else. Names and anything you write are set
in **Newsreader**; everything you operate is **Instrument Sans**; time and
counts are **IBM Plex Mono**, so a column of countdowns lines up like a ticker.
All three are self-hosted, so the app still works offline.

Color only ever means one thing. Teal: you can press it. One condition ramp
(thriving → critical) is shared by health and readiness, and every state also
has a shape — the five-bar **health meter**, the **rhythm ring** (arc = how far
into the rhythm, center filled = prepped, color = state) and the **prayer
flame** (filled, outlined, dashed when gone quiet, gilt when answered).
Identity — life areas, CliftonStrengths in Gallup's own colors — is a square.

The tokens live in [`src/styles/brand.css`](src/styles/brand.css). It redefines
the `stone` and `teal` ramps every component was written against, which is how
the whole app re-skinned from one file; the glyphs are in
[`src/components/brand/glyphs.tsx`](src/components/brand/glyphs.tsx).

## Five places

| Place | Route | The question |
|---|---|---|
| **Today** (default) | `/today` | What needs me? The next move, the week, ideas waiting, who you're carrying |
| **People** | `/circles`, `/tree`, `/table` | Who do I lead, and how are they? Three views, four lenses |
| **Meetings** | `/meetings` | Am I ready to sit down? |
| **Ideas** | `/ideas` | What do I want to raise? |
| **Prayer** | `/prayer` | Who am I carrying? Opens at night |

The life-area scope (All of life, Day job, Church…) sits at the top of the
sidebar and scopes every place at once (`⇧1`–`⇧9`). **Capture** (`C`, or the
gilt + on a phone) takes a topic with the Ideas grammar — `#tag @meeting !` —
or hands off to adding a person, team or leader. `G` then `T` / `P` / `M` / `I` /
`R` jumps between places. Writing up a meeting opens **Run**: the agenda, the
write-up in the serif and the person's context side by side.

### A meeting: Ideas → Plan → Run

Every recurring meeting is a page of its own (`/m/staff-meeting`). Its header
answers three things — is the rhythm holding, what's on the next one, and which
sections of the standing agenda keep getting skipped (a coverage strip per
section over the next eight weeks). Under it:

- **Agenda** — the next occurrence as a running order (see below), the page a
  meeting opens on and the one to bookmark.
- **Plan ahead** — this meeting's ideas in a tray, its weeks as sheets beside it, one
  row per section of the standing agenda. Drag an idea onto a week, or type into
  a cell with the `#tag @meeting !` grammar. Booked weeks are solid, weeks the
  rhythm only expects are dashed, skipped weeks stay as a narrow column you can
  restore. Click a date to open that week beside the board: its agenda by
  section (with ideas offered for empty sections), its notes, and Start,
  Reschedule or Skip. **Opening a week never books it** — the first thing put
  into it does. On a phone the weeks stack and an idea is placed with two taps:
  pick it from the drawer, tap where it goes.
- **Write-ups** — every occurrence, newest first, with its first line and status.
- **Settings** — name, rhythm, the standing agenda (sections, tags, minutes).

**Ideas** (`/ideas`) is everything not yet on a week, by meeting (an inbox
first, then each meeting in the order it next happens) or by tag. Dragging
between columns files or retags; dropping on **Up next** puts an idea straight
onto that meeting's next occurrence. Parked ideas are set aside and only show
when asked for.

### Arcs and shared meetings

An **arc** is something worked through across a meeting, one step per
occurrence — a book read together in a 1:1, a study the staff works through
in Training. It stores a position and a pace, never a schedule, so a skipped
week slides it and a chapter that ran long just stays put. Each step is
Read → Talk → Try; *Try* becomes a follow-up that opens the next meeting.

A meeting can be **shared** with the people in it: they get a link to its
agenda (`/with/<token>`), can add to it, tick off what's theirs and write
their part of *Our notes*. Health, prayer, assessments, the Ideas tray, *My
notes* and anything locked never leave. See
[docs/arcs-and-sharing.md](docs/arcs-and-sharing.md).

## Navigation model

**The URL is the source of truth for what's selected.** Selection setters
navigate; [`applyRoute`](src/store/useStore.ts) writes the resulting location
back into the store. One direction only, so the back button needs no special
handling and every entity is a link you can send someone.

One entity renders on two surfaces:

- **Peek** — a fixed-width panel beside the canvas. Shows exactly *one* entity.
  Drilling into a member swaps the panel's contents and grows the breadcrumb
  rather than opening a second panel beside the first, which is what lets the
  model go as deep as the data does without running out of horizontal room.
- **Focus** — the full page for one entity, at `/team/:id`, `/person/:id/:section`,
  `/manager/:id`, `/me`. Replaces the canvas instead of covering it: promoting
  out of a peek is for room to work, so nothing competes for width or has to be
  dismissed before the app is usable again.

Promotion between them is just a route change (`⌘↵`, or the `⤢` / `⤡` buttons).
[`EntityChrome`](src/components/EntityChrome.tsx) owns the breadcrumb, the
sibling pager (`←` / `→`), close, and that promotion for every entity kind — the
profile components own content only, and render at both densities from one tree.

```
/                            Today: what needs me — the front door
/?person=p3                  a person peeked beside Today
/circles                     People, drawn as rings around you
/m/staff-meeting             that meeting's agenda for its next occurrence
/m/staff-meeting/plan        the same meeting, planned weeks ahead
/tree                        canvas, nothing open
/tree?team=t1                team peek beside the canvas
/tree?person=p3&s=sessions   person peek, 1:1s section
/person/p3/sessions          same person, same section, full page
```

## Your teams and meeting agendas

**Today** (`/`) is where the app opens, and under the next move it answers the
weekly question — *is each team I lead ready for its next meeting?* — with one
card per team, sorted by how soon it meets. Each card leads with that meeting
and the sections of its next occurrence (`Prayer 2 · Training 0 · Discussion
3`), then the team's next step and open follow-ups. A delegated team rides along
on its leader's 1:1 rather than getting a card of its own.

Every card opens the meeting's **Agenda** — its default mode, and the page to
bookmark. It shows one occurrence: the four readiness checks while it's the
next one, follow-ups that outlive any single meeting, and the same cards and
ideas rail as the board, drawn as one running order. `←` / `→` step to later
occurrences, which is how you plan further out without leaving the agenda.
**Plan ahead** is the eight-week board it used to open on.

Meetings are addressed by a slug derived from their name (`/m/staff-meeting`,
or `/m/sarah-kim` for an unnamed 1:1); ids still resolve and old
`/meeting/<id>` links redirect to the slug. Each page sets its own tab title, so
a bookmark reads "Staff meeting — Polarch". Slugs aren't stored: renaming a
meeting changes its address.

Because a peek is not tied to the canvas, clicking a row in the People table
opens it in place instead of throwing you back to the tree.

## Modes

Nobody opens the org tree wanting "mandate and health and readiness." They open
it **in a mode** — and the chart used to make you assemble that mode yourself
out of eight independent layer toggles, every one of them offered at once
regardless of the question being asked.

So mode is now the only card control there is. Four of them, one per question:

| Mode | Question | Cards carry | Bar under the chips |
|---|---|---|---|
| **Plan** `1` | What is each team for, and what's next? | mandate, next step, stacked avatars | — |
| **Prep** `2` | Am I ready for the next 1:1? | readiness rail, countdown chips, roster, next step | *4 of 6 ready · 2 need prep · N undecided* |
| **Assess** `3` | Is this going well? | health chip, why-line, member health bar, roster | the **health scan** |
| **Pray** `4` | Who am I carrying? | the hand, focus line, *carrying 3 of 8 · 1 gone quiet*, roster | the **prayer scan** |

Plan is the only one that leaves the roster off: mandate and next step are
team-level answers, and a list of names under them buries the two lines that
matter. The other three are per-person signals, so they need the names.

**Mode is what you're doing; the domain filter is where.** They're orthogonal
and compose — Assess × Church answers a question neither does alone. Mode takes
the bare digits `1`–`4`; domains moved up a shift to `⇧1`–`⇧9`.

**Only the scan a mode owns applies.** The scans themselves persist across a
mode switch — they're shared with the table and have to follow you there — but
Plan and Prep put no scan bar on screen, so nothing dims in them. A mode that
can't say *why* a card faded has no business fading it. Composing health *and*
prayer at once is still the table's job, where both are columns.

The mode bar renders above the domain chips on **both** surfaces, which is how
the phone finally gets the control the canvas used to hoard. Below `lg` it
picks the outline's columns instead of the card's layers — same question, the
shape the screen can carry.

Modes live in [`src/lib/treeMode.ts`](src/lib/treeMode.ts): the four ids, the
layer set each one stamps, the scan it owns, and the columns it shows.

## Quick search (`⌘K`)

You're walking into a meeting with Meghan in ninety seconds. You don't want the
org chart, you want *her* — and the thing you said you'd follow up on.

`⌘K` is that. One field over the whole workspace, answered from memory:

| Type | You get |
|---|---|
| *nothing* | the last eight things you opened, then every command |
| `meg` | Meghan, then her meeting, then her topics, notes, write-ups and prayer entries |
| `sunday setup` | every record with **both** words, wherever they are — the snippet shows the line they're on |
| `add person` | the command, with the shortcut that would have skipped the palette |

**The unit of search is the record, not the entity.** A write-up, a topic, a
note, a banked win, a prayer entry and every profile field are each their own
document that knows the route which opens it — so searching for something you
discussed lands you *in the occurrence where you discussed it*, not on a
profile you then have to dig through. A raw meeting transcript is indexed too:
"what did she say about the budget" is answerable before anyone has written it up.

**It never touches the network.** The store is already hydrated from
[`docCache`](src/lib/docCache.ts) on a cold open and the shell is already served
by the service worker, so the index is built from memory the app has anyway.
A basement, a plane, a church hallway with two bars — search can't tell the
difference, because there is nothing for it to know.

**It's built once per document version, not per keystroke.** The index —
folded haystacks, a sorted token list, posting lists — is cached on the
identity of the store's collections and rebuilt only when one of them actually
changes. A query is a binary search over the tokens and a merge of postings;
only the survivors get scored. Building it happens a frame *after* the palette
paints, so the field is live before the corpus is read. On a workspace at the
ceiling of what the offline cache can hold (~3 MB of prose, ~3,000 write-ups)
that build is ~100 ms once, and a keystroke is single-digit milliseconds.

Ranking is four terms, in [`src/lib/search.ts`](src/lib/search.ts): how well the
text matches (prefix > word-start > mid-word > initials), which field matched
(a name outranks where it lives, which outranks the prose), how recent the
record is, and how recently you opened it. That last one is why `m` puts *your*
Meghan above three M-names you've never touched.

## Plan with Claude or ChatGPT (MCP)

Polarch is an [MCP](https://modelcontextprotocol.io) server at `/mcp`. Connect
Claude or ChatGPT (or make a token in Settings for a bot that takes a URL and a
key) and ask it what's coming up this week, to plan the next meeting, file and
tag ideas, spread what's waiting across the coming weeks, skip a week, start an
arc for a book, or close out a meeting. It reads and rearranges the same agendas
you do, a row at a time, and every change can be undone. By default it sees
names, roles and your agendas; your health, prayer and assessment reads, notes
and transcripts only if you tick the box for them. Setup, what it can and can't
do, and the deploy order are in [RUNBOOK.md](RUNBOOK.md#connecting-claude-and-chatgpt-mcp).

The pieces: `worker/src/mcp/` (protocol, tools, undo journal),
`worker/src/oauth/` (the sign-in that lets an assistant connect), and
`src/lib/agendaOps.ts` (the agenda rules, as pure functions).

## Stack & structure

React + TypeScript + Vite · Tailwind CSS 4 (light/dark) · Zustand · React Router · React Flow (`@xyflow/react`) · Cloudflare Workers + Neon + Better Auth. See [RUNBOOK.md](RUNBOOK.md).

The org tree is an **infinite canvas** (React Flow): pan, zoom (scroll/pinch), a minimap, and freely draggable team cards whose positions persist. Teams live on one visual rank no matter how many there are — no wrapping into rows that would falsely read as another tier. Teams marked **"Above me — I report up"** render above your node with the connector flowing down into you; their people get full profiles framed as *leading up*. The cards themselves are driven by **mode** (see below), not by a row of toggles, and mode composes with the domain filter. **Reset layout** snaps everything back to the automatic arrangement. Reassigning a person between teams is `movePerson(personId, teamId)` in the store (drag-reorg seam).

```
src/
  types.ts               # data model
  data/
    frameworks.ts        # THEME_DOMAIN (all 34), domain colors, Enneagram, MBTI
    seed.ts              # seed teams/people/goals/notes
  lib/
    routes.ts            # URL <-> selection model (peek vs focus surfaces)
    storage.ts           # persistence seam (localStorage now, API later)
    derive.ts            # coverage, domain counts, blind spots, derived "read"
    readiness.ts         # meeting prep: states, checks, roll-up, triage
    health.ts            # my own read: levels, the scan filter, roll-ups
    prayer.ts            # who I'm carrying: states, silence, the scan filter
    orgTable.ts          # rows, outline, sorting + grouping for the table view
    treeMode.ts          # the four chart modes: layers, scan and columns each owns
    search.ts            # the offline quick-search index: documents, tokens, ranking
    recents.ts           # what you opened last — the resting list and the frecency term
    docCache.ts          # the local copy of the document, so a cold open needs no network
  store/useStore.ts      # Zustand store; persists on every data change
  components/
    App shell: App.tsx (header, tabs, route sync)
    Surfaces: EntitySurface.tsx (peek), FocusView.tsx (page), EntityChrome.tsx
    Tree: OrgTree.tsx, StatsBar.tsx, StrengthsDonut.tsx, Avatar.tsx
    Profile: PersonProfile.tsx, AssessmentEditor.tsx
    Shared records: TopicKanban.tsx, NotesPanel.tsx    # keyed by subject id — people and managers alike
    Leading up: ManagerProfile.tsx, LeadUpManual.tsx, WinsLedger.tsx
    Readiness: PrepPanel.tsx, MeetingEditor.tsx (Run), TriageModal.tsx
    Meetings: MeetingProfile.tsx, MeetingPlanner.tsx, TopicBoard.tsx (desktop plan),
              PhonePlan.tsx, OccurrenceNotesPanel.tsx (a week), SessionAgenda.tsx,
              MeetingCalendar.tsx, SessionHistoryTable.tsx (write-ups), IdeasBoard.tsx
    Health: Health.tsx   # the property control, at every density
    Prayer: Prayer.tsx   # the mark, the log, the mode — people, teams and managers alike
    Table: TableView.tsx # the canvas's correlated view
    Other tabs: Overview.tsx, PeopleTable.tsx
    forms.tsx, ui.tsx    # modals + small primitives
```

## Data model

```ts
type Capacity = { id: string; label: string; color: string };   // Manager (teal) / Leader (purple) / Influence (amber) / Report up (blue)
type HealthLevel = "thriving" | "solid" | "watch" | "strained" | "critical";
type Health   = { level: HealthLevel; note?: string; ratedOn?: string };  // my own read

type Team     = { id: string; name: string; capacityId: string; description?: string; order: number;
                  health?: Health;                              // my call on how the team is doing
                  prayer?: Prayer;                              // set when I'm carrying this team
                  direction?: "up" | "down";                    // "up" = I report to this team; renders above me
                  parentId?: string;                            // sub-team, nests under a broader team
                  leaderId?: string };                          // a direct report runs it — hangs under them, not me

// Who I'm carrying. Presence = actively praying; there is no level and no score.
type Prayer      = { since: string; focus?: string; lastPrayedOn?: string; times?: number };
type PrayerEntry = { id: string; subjectKind: "person" | "team" | "manager"; subjectId: string;
                     date: string; kind: "burden" | "scripture"; text: string;
                     answeredOn?: string; answerNote?: string };   // answered, never "done"

type Domain = "Executing" | "Influencing" | "Relationship Building" | "Strategic Thinking";
type Assessments = { cliftonTop5?: string[]; enneagram?: string; mbti?: string };

type MeetingRhythm = "weekly" | "biweekly" | "monthly" | "quarterly" | "as_needed";

// A meeting I've opted into being ready for. Points at a person (1:1), a team
// (staff meeting, practice session) or a manager (check-in).
type TrackedMeeting = {
  id: string; subjectKind: "person" | "team" | "manager"; subjectId: string;
  name?: string;                        // "Practice meeting"; defaults to the subject's name
  rhythm: MeetingRhythm;
  floorDays?: number;                   // as_needed only — a tolerance, not a rhythm
  nextDate?: string;                    // an explicit booking always wins
  role?: "convene" | "attend";
  trackerUrl?: string;                  // notes live outside Polarch (Notion, a Word doc…)
  trackerName?: string;                 // what to call it; derived from the link otherwise
};

type Person = {
  id: string; name: string; role?: string;
  teamId?: string;                      // undefined = a direct report: their own node under me, no team
  domainId?: string;                    // life area, only for a direct report (others inherit the team's)
  photo?: string;                       // base64 data URL (downscaled on upload)
  relationshipType?: string;
  health?: Health;                      // my call on how they're doing
  prayer?: Prayer;                      // set when I'm carrying them
  noMeeting?: boolean;                  // "I deliberately don't sit down with them"
  assessments: Assessments;
  strengths: string[]; watchOuts: string[]; howToLead?: string;
};
type Action   = { id: string; personId: string; text: string; done: boolean; dueDate?: string };
type Session  = { id: string; meetingId: string; date: string; point?: string; notes?: string; nextDate?: string };  // one occurrence
type Goal     = { id: string; personId: string; title: string; progress: number; targetDate?: string };
type Note     = { id: string; personId: string; date: string; body: string };
type Me       = { name: string; title?: string; photo?: string };
```

## Readiness (meeting prep)

Separate from coverage, which answers *do I know them*. Readiness answers **am I
ready for the next time we sit down** — measured against the clock, not in the
abstract.

**The meeting is the unit.** A 1:1, a staff meeting, a practice session and a
check-in with the boss all prep identically, so they're all `TrackedMeeting`s
pointing at different subjects. The same team can have a standing meeting *and*
1:1s with its members; those are separate things to be ready for.

**Rhythm, not a calendar.** A meeting's rhythm projects its next occurrence from
the last one (`~Thu · 3d`, the `~` marking a projection), so nothing has to be
scheduled for the signal to work. An explicit `nextDate` always wins.
`as_needed` promises nothing and projects nothing — give it a `floorDays`
*tolerance* instead ("if it's been 6 weeks, something's wrong") and it sits
**Dormant** until either something is booked or the floor is crossed. Metronome
for what's regular, tripwire for what isn't.

Six states, worst-first: **Drifting** (past the rhythm or floor, nothing next) →
**Loose end** (an occurrence was never written up) → **Prep due** (window open,
checklist incomplete) → **Ready** → **Resting** (met recently — nothing owed,
and that's a good state) → **Dormant**. Relationship debt deliberately outranks
paperwork debt. Prep only starts mattering inside a window of
`max(2 days, 25% of the rhythm)`. Cards roll up **worst-of, never average**.

**Nothing is measured until you opt in.** Three states per subject: tracked, a
deliberate `noMeeting` decision, or *undecided* — and only undecided is counted
at you, in a number that empties as you triage it
([`TriageModal.tsx`](src/components/TriageModal.tsx), bulk by design). That
closes the one hole opt-in creates: you can't go green by ignoring people, only
by deciding about them.

**Notes that already live somewhere else stay there.** A meeting can carry a
`trackerUrl` — the Notion page, the Word doc in OneDrive, the shared Google Doc
you and that report have used for years — and it's an *and*, not an *or*: the
rhythm, the topic board and the health read stay in Polarch, and sessions can
still be logged here alongside it. Only the write-up moves. Readiness stops
claiming to know whether the last one was written up (it can't see the page)
and says where it went instead, rather than parking that person in permanent
**Loose end**. Linking a tracker starts tracking the meeting as-needed, because
"they're in Notion" is a decision. Not every link is a URL — a path or a
`.docx` filename is kept as a pointer, and only allowlisted schemes ever become
a clickable anchor ([`src/lib/tracker.ts`](src/lib/tracker.ts)).

The engine lives in [`src/lib/readiness.ts`](src/lib/readiness.ts); layer **`R`**
on the canvas shows the rail, countdown chip and distribution bar, and
[`PrepPanel.tsx`](src/components/PrepPanel.tsx) — on people, teams and managers
alike — links each failing check straight to where it gets fixed, including into
the meeting that was never written up. Full design rationale, including what's
deliberately *not* built, in [docs/readiness.md](docs/readiness.md).

## Health (my own read)

Coverage answers *do I know them*. Readiness answers *am I ready for the next
time we sit down*. Neither answers the question you actually carry around:
**is this going well?** Nothing in the data can answer it — so health is one
property you set yourself, on any team or person:

```ts
type HealthLevel = "thriving" | "solid" | "watch" | "strained" | "critical";
type Health = { level: HealthLevel; note?: string; ratedOn?: string };
```

Five levels, strongest first, deliberately lopsided toward the weak end: "solid"
covers everything that needs nothing from you, and the three below it are the
ones worth telling apart when you're deciding where next week goes. The optional
`note` is the one line of evidence behind the call ("no weekend off since
March"), and `ratedOn` is re-stamped on every change — a read from eight months
ago is a memory, and after 90 days the chip says **stale** rather than pretending
otherwise.

Set it anywhere it's visible: the add/edit modals, the team and person profiles,
or straight from a table row. It's never derived. A team with no call of its own
shows its people's average as a hollow `~solid` chip that says so — and still
counts as *not rated* everywhere it matters, so a team can't go green because
the people on it happen to be.

**The scan** is the payoff. Layer **`H`** puts the levels on the canvas, and the
scan bar above it counts every rated subject in view. Click a level and the
canvas *dims* everything else rather than hiding it — filtering to Strained and
watching two cards stay lit inside the shape of the org tells you where the
strain is; a canvas with two cards on it doesn't. A team card stays lit when its
own rating matches **or any of its people do**, so a scan finds the person even
when the team around them reads fine. The scan is shared with the table view, so
it follows you between the two surfaces. Overview carries the boiled-down
version: the mix bar, and everything strained or critical, worst first.

## Prayer (who I'm carrying)

The fourth dimension, and the only one that isn't about them. Coverage asks *do
I know them*; readiness asks *am I ready to sit down with them*; health asks *is
this going well*. This one asks the question a lot of leaders actually carry
around: **am I praying for this person, and this team, right now.**

```ts
type Prayer = { since: string; focus?: string; lastPrayedOn?: string; times?: number };
```

**There is no scale, and there is no score.** Presence of the mark is the whole
answer — taking someone up is a deliberate act and laying them down is another,
which is why the model has a `since` date and no level. Nothing is derived
either: a team is not "prayed for" because four people on it are.

What *is* measured is the only honest signal available — **how long it's been.**
Four states, and only one of them asks for anything: **Prayed this week** →
**Carrying** → **Gone quiet** (nothing marked in 21 days) → **Not carrying**.
"Not carrying" is never counted as a gap. Praying for four people out of forty
is a true answer, and an app that nagged about the other thirty-six would be
teaching the wrong thing. "Gone quiet" is the one that surfaces: a name you took
up in January and haven't prayed for since June is exactly what goes unnoticed
without a list.

**The mode.** Pray (`4`) puts the hand on every card — the mark shows how long
since you last prayed, a team card shows its focus line and `carrying 3 of 8 ·
1 gone quiet` — and brings up the **prayer scan**: one chip per state, with
counts, dimming rather than hiding the way health's does. *Gone quiet* is the
chip that earns the bar. A count can tell you a name has gone six months
unprayed-for; only the scan puts you in front of it. The scan is shared with
the table, so it follows you between surfaces, and the marks are doors —
clicking one opens that subject's prayer tab, so a pass down the list is scan →
click → pray → mark → next. It's a mode you enter on purpose, never a column
everyone gets — which is the whole reason the canvas has modes at all.

**The log** is a tab on every person and manager (`?s=prayer`) and a section on
every team, and it deliberately does not look like a to-do list. No checkboxes,
no "+ Add" row, no hover-delete in the margin — entries are *written down*, in
serif, against a margin rule, and the controls live behind a click on the line
itself so the resting state of the panel is just the words. Two kinds of entry,
a **burden** and a **scripture**, because a third would just be the Notes tab
wearing a hat. Nothing is ever "completed": an entry is **answered**, which
keeps the words and adds a date and a line about what happened — the part worth
re-reading a year later. Laying someone down keeps the log, including every
answer.

The engine is [`src/lib/prayer.ts`](src/lib/prayer.ts) and the whole UI —
canvas mark, panel and log — is [`Prayer.tsx`](src/components/Prayer.tsx).
Overview carries the boiled-down version: who's on the list, longest silence
first, and what's been answered lately.

## Table view

The canvas's correlated view — same store, same records, same health calls, a
different question. The canvas is for shape and place ("who sits under what");
the table is for comparison ("everything strained, sorted by how long since I
met"). Clicking a row opens the same peek panel a card does, so drilling in
never means starting over on the other surface.

Teams and people share one row type on purpose: a table with two row shapes
can't sort a person above a team, and *show me everything strained, whatever it
is* is the whole point.

- **Team outline** (the default) is the tree flattened: a team, its people, then
  its sub-teams, indented — and direct reports carrying whatever they lead. Rows
  collapse; sorting reorders siblings *within* each parent rather than destroying
  the hierarchy.
- **Group by** health, domain, capacity or type flattens it into buckets with a
  count and a health mix bar per group. Unrated always sorts last.
- **Filter** by search, domain, kind (teams / people), and the shared health
  scan — plus a **Weak spots** preset for watch-or-worse. When a filter matches
  something nested, its ancestors stay as dimmed context so a person never
  floats with no team above them.
- **Edit in place**: the health dropdown and its *why* line are live in every
  row, which is what makes rating a whole org a two-minute pass rather than
  twenty panel visits.
- **Columns** toggle on and off (type, under, health, why, domain, ready, next,
  capacity, read, size).

Rows, outline, sorting and grouping live in
[`src/lib/orgTable.ts`](src/lib/orgTable.ts); the view is
[`TableView.tsx`](src/components/TableView.tsx).

## Leading up

Two shapes of "above me": people on a team marked `direction: "up"` (a board, an
elders group), and **`Manager`** nodes — one leader you answer to in a given
domain, attached straight to you.

Managing the relationship works the same either way, and the same way as leading
down: a tracked check-in, its session history, a topic board and dated notes.
Those share the person tables — `actions`, `notes` and `wins` are all keyed by
*subject* id with no foreign key, so a manager's records slot in without a
migration. What's different upward is what leads: the **operating manual**
(`LeadUpManual` — what they reward, their anxieties, their currency, what their
own boss measures them on) and the **wins ledger** (`WinsLedger` — value you've
delivered, phrased in their currency, recallable at reviews and before an ask).
Leading down you track someone else's growth; leading up you track your own
value.

The topic board is the same component pointed the other way
(`TopicKanban direction="up"`): a topic for your boss is an ask, an escalation
or a decision you need, not something you're raising *about* them — so the
queued column reads **This check-in** and the coach frames it accordingly. The
stored value is unchanged, which is what keeps the readiness engine ignorant of
direction.

A person counts as **assessed** once any framework result is recorded. The team-node metric is assessment coverage (X/Y) — deliberately pluggable so a future 0–100 leadership-readiness score can roll up through teams without a rewrite.

## THEME_DOMAIN (all 34 CliftonStrengths themes)

| Domain | Color | Themes |
|---|---|---|
| Executing | `#7C3B8B` | Achiever, Arranger, Belief, Consistency, Deliberative, Discipline, Focus, Responsibility, Restorative |
| Influencing | `#DD7B2B` | Activator, Command, Communication, Competition, Maximizer, Self-Assurance, Significance, Woo |
| Relationship Building | `#2D78BD` | Adaptability, Connectedness, Developer, Empathy, Harmony, Includer, Individualization, Positivity, Relator |
| Strategic Thinking | `#269364` | Analytical, Context, Futuristic, Ideation, Input, Intellection, Learner, Strategic |

The colors are Gallup's own, so a chip here matches every report people already have. The map lives in [src/data/frameworks.ts](src/data/frameworks.ts) and drives strength-chip coloring, team domain balance, the org donut, and blind-spot detection.

## Notes

- **Reset to seed data**: run `useStore.getState().resetToSeed()` in the browser console (the store is exposed on `window` in dev). This wipes your cloud rows and re-seeds them.
- **Persistence seam**: all cloud reads/writes go through [`src/lib/repo.ts`](src/lib/repo.ts) (normalized Supabase tables). The store hydrates on login and syncs changed collections back, debounced. `dark` mode still lives in localStorage as a device-local UI preference.
