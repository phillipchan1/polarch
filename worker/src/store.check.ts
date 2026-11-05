import { PGlite } from "@electric-sql/pglite";
import { applySchema } from "./isolationDb.ts";
import { pgliteAsSql } from "./pgliteSql.ts";
import { applySync, loadTables, wipeUser } from "./store.ts";

const fails: string[] = [];
let checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  if (!cond) fails.push(msg);
}

const a = "11111111-1111-1111-1111-111111111111";
const b = "22222222-2222-2222-2222-222222222222";

const db = new PGlite();
await applySchema(db);
const sql = pgliteAsSql(db);

await applySync(sql, a, {
  profile: { name: "Phil", title: "Lead" },
  upserts: {
    teams: [{ id: "t1", name: "Frontier", capacity_id: "c1", sort_order: 0 }],
    people: [{ id: "p1", name: "Ada", team_id: "t1", clifton_top5: ["Learner"] }],
  },
});

const loadedA = await loadTables(sql, a);
ok(loadedA.profile?.name === "Phil", "owner can read their profile");
ok(loadedA.tables.teams?.length === 1, "owner sees their team");
ok(loadedA.tables.people?.[0]?.name === "Ada", "owner sees their person");

const loadedB = await loadTables(sql, b);
ok(loadedB.profile == null, "other user has no profile");
ok((loadedB.tables.teams ?? []).length === 0, "other user cannot see teams");
ok((loadedB.tables.people ?? []).length === 0, "other user cannot see people");

await applySync(sql, b, {
  deletes: { teams: ["t1"], people: ["p1"] },
});
const stillA = await loadTables(sql, a);
ok(stillA.tables.teams?.length === 1, "other user cannot delete owner rows");

await applySync(sql, a, {
  upserts: { teams: [{ id: "t1", name: "Frontier II", capacity_id: "c1", sort_order: 1 }] },
  deletes: { people: ["p1"] },
});
const after = await loadTables(sql, a);
ok(after.tables.teams?.[0]?.name === "Frontier II", "owner upsert updates the row");
ok((after.tables.people ?? []).length === 0, "owner delete removes the person");

// json/jsonb columns store the value, not a JSON string of it. The Worker once
// stringified before postgres.js stringified again, so a meeting's sections
// were stored as one string the app read as "no sections".
const sections = [{ id: "s1", label: "Prayer", tagId: "tg1" }, { id: "s2", label: "Training" }];
await applySync(sql, a, {
  upserts: {
    meetings: [
      { id: "m1", subject_kind: "team", subject_id: "t1", rhythm: "weekly", curriculum: sections },
      // An older tab sending back the string it read, encoded once or twice.
      { id: "m2", subject_kind: "team", subject_id: "t1", rhythm: "weekly", curriculum: JSON.stringify(sections) },
      { id: "m3", subject_kind: "team", subject_id: "t1", rhythm: "weekly", curriculum: JSON.stringify(JSON.stringify(sections)) },
    ],
    people: [{ id: "p2", name: "Grace", team_id: "t1", strengths: ["Focus"] }],
  },
});
const typed = (await db.query<{ id: string; t: string; same: boolean }>(
  `SELECT id, jsonb_typeof(curriculum) AS t, curriculum = $1::jsonb AS same FROM meetings WHERE user_id = $2 ORDER BY id`,
  [JSON.stringify(sections), a],
)).rows;
ok(typed.length === 3 && typed.every((r) => r.t === "array" && r.same), `sections are stored as an array: ${JSON.stringify(typed)}`);
const strengths = (await db.query<{ t: string }>(`SELECT jsonb_typeof(strengths) AS t FROM people WHERE id = 'p2'`)).rows[0];
ok(strengths?.t === "array", "a person's strengths are stored as an array");
const reread = await loadTables(sql, a);
const m1 = reread.tables.meetings?.find((m) => m.id === "m1");
ok(Array.isArray(m1?.curriculum) && (m1?.curriculum as unknown[]).length === 2, "sections load back as an array");
await applySync(sql, a, { deletes: { meetings: ["m1", "m2", "m3"], people: ["p2"] } });

let unknownThrew = false;
try {
  await applySync(sql, a, { upserts: { not_a_table: [{ id: "x" }] } });
} catch {
  unknownThrew = true;
}
ok(unknownThrew, "unknown table is rejected");

await wipeUser(sql, b);
const afterWipeB = await loadTables(sql, a);
ok(afterWipeB.tables.teams?.length === 1, "wiping another user leaves owner data");

await wipeUser(sql, a);
const empty = await loadTables(sql, a);
ok(empty.profile == null, "wipe removes profile");
ok((empty.tables.teams ?? []).length === 0, "wipe removes teams");

if (fails.length) {
  console.error(`${fails.length}/${checks} failed`);
  for (const f of fails) console.error("  -", f);
  process.exit(1);
}
console.log(`store.check: ${checks} ok`);
