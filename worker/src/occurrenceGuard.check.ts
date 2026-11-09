import { PGlite } from "@electric-sql/pglite";
import { applyOccurrence } from "../../src/lib/occurrenceGuard.ts";
import type { TrackedMeeting } from "../../src/types.ts";
import { applySchema } from "./isolationDb.ts";
import { pgliteAsSql } from "./pgliteSql.ts";
import { applySync } from "./store.ts";
import { createShare, guestAddTopic, memberByToken } from "./shares.ts";

/**
 * Run with `npm run test:worker` (occurrenceGuard.check).
 *
 * Local PGlite repro for issue #26: the table accepts two rows on one
 * meeting+date (what `addSession` used to write), and the guard stops a
 * second book — same-date and consecutive-day — from inserting another.
 */

const fails: string[] = [];
let checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  if (!cond) fails.push(msg);
}

const phil = "11111111-1111-1111-1111-111111111111";
const weekly: TrackedMeeting = {
  id: "m-meghan",
  subjectKind: "person",
  subjectId: "p1",
  name: "Meghan 1:1",
  rhythm: "weekly",
  anchorWeekday: 4,
};

const db = new PGlite();
await applySchema(db);
const sql = pgliteAsSql(db);

await applySync(sql, phil, {
  profile: { name: "Phil Chan" },
  upserts: {
    people: [{ id: "p1", name: "Meghan Lee" }],
    meetings: [
      {
        id: weekly.id,
        subject_kind: "person",
        subject_id: "p1",
        name: "Meghan 1:1",
        rhythm: "weekly",
        anchor_weekday: 4,
      },
    ],
  },
});

async function sessionDates(): Promise<string[]> {
  const rows = (await sql.unsafe(
    `SELECT id, date FROM one_on_ones WHERE user_id = $1 AND meeting_id = $2 ORDER BY date, id`,
    [phil, weekly.id],
  )) as unknown as { id: string; date: string }[];
  return rows.map((r) => String(r.date).slice(0, 10));
}

// ── schema hole: the old addSession path persists both rows ──────────────
await sql.unsafe(
  `INSERT INTO one_on_ones (user_id, id, person_id, meeting_id, date)
   VALUES ($1, $2, $3, $4, $5), ($1, $6, $3, $4, $5)`,
  [phil, "dup-a", "p1", weekly.id, "2026-10-23", "dup-b"],
);
ok(
  (await sessionDates()).filter((d) => d === "2026-10-23").length === 2,
  "PGlite: one_on_ones has no unique (meeting, date) — two Oct 23 rows both persist (the old addSession write)"
);

await sql.unsafe(`DELETE FROM one_on_ones WHERE user_id = $1 AND meeting_id = $2`, [phil, weekly.id]);

// ── flag off vs on, same-date, through the same helper the store uses ───
{
  let n = 0;
  const uid = () => `new-${++n}`;
  const spec = { meetingId: weekly.id, date: "2026-10-23" };
  const first = applyOccurrence([], weekly, spec, uid, { guard: false, today: "2026-10-23" });
  const twice = applyOccurrence(first.sessions, weekly, spec, uid, { guard: false, today: "2026-10-23" });
  ok(twice.sessions.length === 2, "flag off: two books on Oct 23 stay two rows");

  const a = applyOccurrence([], weekly, spec, uid, { guard: true, today: "2026-10-23" });
  const b = applyOccurrence(a.sessions, weekly, spec, uid, { guard: true, today: "2026-10-23" });
  ok(b.sessions.length === 1 && b.sessionId === a.sessionId, "flag on: the second Oct 23 book is folded");

  const last = [{ id: "oct22", meetingId: weekly.id, date: "2026-10-22" }];
  const missed = applyOccurrence(
    last,
    weekly,
    { meetingId: weekly.id, date: "2026-10-29" },
    uid,
    { guard: true, today: "2026-11-09" },
  );
  ok(
    missed.sessions.some((o) => o.date === "2026-10-29") &&
      !missed.sessions.some((o) => o.date > "2026-11-09"),
    "flag on: logging past Thursday Oct 29 stays Oct 29 (does not snap after today)",
  );
}

// ── consecutive-day: guest booking Wednesday after a Tuesday session ─────
await sql.unsafe(
  `INSERT INTO one_on_ones (user_id, id, person_id, meeting_id, date)
   VALUES ($1, $2, $3, $4, $5)`,
  [phil, "tue", "p1", weekly.id, "2026-10-06"],
);

const share = await createShare(sql, phil, {
  meetingId: weekly.id,
  email: "meghan@example.com",
  name: "Meghan Lee",
  personId: "p1",
});
const member = await memberByToken(sql, share.token);
const now = new Date("2026-10-07T16:00:00Z");

const ungarded = await guestAddTopic(
  sql,
  member!,
  { text: "Off-rhythm Wednesday", date: "2026-10-07" },
  now,
  { guard: false },
);
ok(ungarded.sessionId !== "tue", "flag off: a guest topic on Wednesday inserts a new occurrence");
ok(
  (await sessionDates()).join() === "2026-10-06,2026-10-07",
  "flag off: Tuesday + Wednesday sit next to each other in PGlite"
);

await sql.unsafe(`DELETE FROM one_on_ones WHERE user_id = $1 AND id = $2`, [phil, ungarded.sessionId]);
await sql.unsafe(`DELETE FROM topics WHERE user_id = $1 AND id = $2`, [phil, ungarded.id]);

const guarded = await guestAddTopic(
  sql,
  member!,
  { text: "Should land on Thursday", date: "2026-10-07" },
  now,
  { guard: true },
);
const after = await sessionDates();
ok(!after.includes("2026-10-07"), "flag on: Wednesday is not inserted");
ok(after.includes("2026-10-08") && after.includes("2026-10-06"), "flag on: the book snaps onto this week's Thursday");
ok(guarded.sessionId !== "tue", "flag on: Thursday is a new occurrence, not Tuesday's leftover");

if (fails.length) {
  console.error(`occurrenceGuard.check: ${fails.length}/${checks} failed`);
  for (const f of fails) console.error("  -", f);
  process.exit(1);
}
console.log(`occurrenceGuard.check: ${checks} checks passed`);
