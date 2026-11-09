/**
 * Run with `npm run test:guard` (flags.check). The shared flag module:
 * both flags default off, and a production build ignores `?flag=` and
 * localStorage `polarch:v1:flags`.
 */
import {
  FLAG_DEFAULTS,
  FLAG_STORAGE_KEY,
  FLAGS,
  flagFromEnv,
  flagOn,
  flagsAllowRuntimeOverride,
  flagsFromQuery,
} from "./flags";

const fails: string[] = [];
let checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  if (!cond) fails.push(msg);
}

ok(FLAG_DEFAULTS.quickClose === false, "quickClose defaults off");
ok(FLAG_DEFAULTS.singleOccurrenceGuard === false, "singleOccurrenceGuard defaults off");
ok(FLAGS === FLAG_DEFAULTS, "FLAGS is the same defaults object");
ok(flagOn("quickClose") === false, "flagOn(quickClose) is off with no override");
ok(flagOn("singleOccurrenceGuard") === false, "flagOn(singleOccurrenceGuard) is off with no override");
ok(FLAG_STORAGE_KEY === "polarch:v1:flags", "storage key is polarch:v1:flags");

ok(flagsAllowRuntimeOverride(true) === true, "dev builds allow ?flag= / localStorage");
ok(flagsAllowRuntimeOverride(false) === false, "prod builds do not allow runtime overrides");
ok(flagsAllowRuntimeOverride(undefined) === false, "an unset DEV flag is treated as prod");

const allOn = {
  getItem: () => JSON.stringify({ quickClose: true, singleOccurrenceGuard: true }),
};

ok(
  flagOn("quickClose", undefined, { dev: false, search: "?flag=quickClose" }) === false,
  "prod ignores ?flag=quickClose",
);
ok(
  flagOn("singleOccurrenceGuard", undefined, { dev: false, search: "?flag=singleOccurrenceGuard" }) === false,
  "prod ignores ?flag=singleOccurrenceGuard",
);
ok(
  flagOn("quickClose", undefined, { dev: false, storage: allOn }) === false,
  "prod ignores localStorage quickClose",
);
ok(
  flagOn("singleOccurrenceGuard", undefined, { dev: false, storage: allOn }) === false,
  "prod ignores localStorage singleOccurrenceGuard",
);
ok(
  flagOn("quickClose", undefined, {
    dev: false,
    search: "?flag=quickClose",
    storage: allOn,
  }) === false,
  "prod ignores ?flag= and localStorage together",
);
ok(
  flagOn("singleOccurrenceGuard", undefined, {
    dev: false,
    search: "?flags=quickClose,singleOccurrenceGuard",
    storage: allOn,
  }) === false,
  "prod ignores both flags from query and storage together",
);

ok(
  flagOn("quickClose", undefined, { dev: true, search: "?flag=quickClose" }) === true,
  "dev honors ?flag=quickClose",
);
ok(
  flagOn("singleOccurrenceGuard", undefined, { dev: true, search: "?flag=singleOccurrenceGuard" }) === true,
  "dev honors ?flag=singleOccurrenceGuard",
);
ok(
  flagOn("quickClose", undefined, { dev: true, storage: allOn }) === true,
  "dev honors localStorage flags",
);
ok(
  flagsFromQuery("?flag=quickClose").quickClose === true &&
    flagsFromQuery("?flag=singleOccurrenceGuard").singleOccurrenceGuard === true,
  "?flag= parses each named flag",
);

ok(flagFromEnv(undefined) === false, "unset env is off");
ok(flagFromEnv("1") === true, "env 1 is on");
ok(flagOn("quickClose", { quickClose: true }) === true, "an explicit on override still wins");

if (fails.length) {
  console.error(`flags.check: ${fails.length}/${checks} failed`);
  for (const f of fails) console.error("  -", f);
  process.exit(1);
}
console.log(`flags.check: ${checks} checks passed`);
