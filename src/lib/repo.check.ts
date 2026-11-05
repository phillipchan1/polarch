import type { CurriculumSlot } from "../types";
import { parseCurriculum } from "./repo";

/**
 * Run with `npm run test:repo`.
 *
 * What comes back from the database has to be what went in. A section's
 * `tagId` and `minutes` were once dropped on every load, which broke tag
 * stamping and coverage after a reload and — worse — erased both from the
 * database on the next save.
 */

const fails: string[] = [];
let checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  if (!cond) fails.push(msg);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// --- a saved agenda reads back whole ----------------------------------------
const saved: CurriculumSlot[] = [
  { id: "sec-lowdown", label: "Lowdown", tagId: "tag-lowdown", minutes: 10 },
  { id: "sec-training", label: "Training", tagId: "tag-training", minutes: 20 },
  { id: "sec-prayer", label: "Prayer", tagId: "tag-prayer" },
  { id: "sec-announce", label: "Announcements", minutes: 5 },
  { id: "sec-open", label: "Open" },
];
// Through JSON, the way the Worker hands a jsonb column to the browser.
const reloaded = parseCurriculum(JSON.parse(JSON.stringify(saved)));
ok(same(reloaded, saved), "every section reads back exactly as saved");
ok(reloaded?.[0].tagId === "tag-lowdown", "a section keeps its tag");
ok(reloaded?.[0].minutes === 10, "a section keeps its minutes");
ok(reloaded?.[2].minutes === undefined, "a section saved without minutes has none");
ok(reloaded?.[3].tagId === undefined, "a section saved without a tag has none");
ok(reloaded !== undefined && Object.keys(reloaded[4]).join() === "id,label", "no empty keys are invented");

// Save → load → save is a fixed point, so a later save can't erase anything.
ok(same(parseCurriculum(reloaded), saved), "loading twice changes nothing");

// A row saved while the Worker encoded json twice holds the sections as one
// JSON string. Reading that as "no sections" hid them, and the next save
// wrote null over them.
ok(same(parseCurriculum(JSON.stringify(saved)), saved), "sections stored as a JSON string still read back");
ok(parseCurriculum("not json") === undefined, "a string that isn't JSON is no sections, not a crash");

// --- rows from before tags and minutes existed -------------------------------
const legacy = [
  { id: "a", label: "One" },
  { id: "b", label: "Two" },
];
ok(same(parseCurriculum(legacy), legacy), "label-only sections load unchanged");

// --- a damaged row never throws and never invents data -----------------------
ok(parseCurriculum(null) === undefined, "null is no agenda");
ok(parseCurriculum("[]") === undefined, "a string is no agenda");
ok(parseCurriculum([]) === undefined, "an empty list is no agenda");
ok(parseCurriculum({ id: "a", label: "x" }) === undefined, "an object is no agenda");

const messy = parseCurriculum([
  null,
  "text",
  { id: "ok", label: "  Kept  ", tagId: "t1", minutes: 15 },
  { id: "blank", label: "   " },
  { id: 7, label: "numeric id" },
  { label: "no id" },
  { id: "badtag", label: "Bad tag", tagId: 42, minutes: "ten" },
  { id: "neg", label: "Negative", minutes: -5 },
  { id: "zero", label: "Zero", minutes: 0 },
  { id: "nan", label: "Not a number", minutes: Number.NaN },
  { id: "emptytag", label: "Empty tag", tagId: "" },
]);
ok(
  same(messy?.map((s) => s.id), ["ok", "badtag", "neg", "zero", "nan", "emptytag"]),
  "only well-formed sections survive",
);
ok(messy?.[0].label === "Kept", "labels are trimmed");
ok(messy?.[0].tagId === "t1" && messy?.[0].minutes === 15, "good values on a messy list survive");
ok(
  (messy ?? []).slice(1).every((s) => s.tagId === undefined && s.minutes === undefined),
  "a malformed tag or minutes is dropped, the section kept",
);

if (fails.length) {
  console.error(`repo check FAILED (${fails.length}/${checks}):\n- ${fails.join("\n- ")}`);
  process.exit(1);
}
console.log(`repo check: ${checks} checks passed`);
