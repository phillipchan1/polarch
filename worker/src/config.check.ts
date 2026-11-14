/**
 * wrangler.jsonc guard. `keep_vars` only keeps dashboard vars that are NOT in
 * the config. Secrets never belong in vars.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, "../../wrangler.jsonc"), "utf8");
// Strip // comments outside strings, then trailing commas.
function toJson(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      let inStr = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"' && line[i - 1] !== "\\") inStr = !inStr;
        if (!inStr && c === "/" && line[i + 1] === "/") return line.slice(0, i);
      }
      return line;
    })
    .join("\n")
    .replace(/,(\s*[}\]])/g, "$1");
}
const json = toJson(raw);

/**
 * A Google client id or secret anywhere in the config: raw text (comments
 * included) AND the parsed config re-serialized, so JSON escapes such as
 * `GOCSPX\u002d…` or `apps\u002egoogleusercontent\u002ecom` are decoded first.
 */
const GOOGLE_LEAK = /GOCSPX-|apps\.googleusercontent\.com/i;
function googleLeak(text: string): boolean {
  if (GOOGLE_LEAK.test(text)) return true;
  try {
    return GOOGLE_LEAK.test(JSON.stringify(JSON.parse(toJson(text))));
  } catch {
    return true; // unparseable config is a failure, not a pass
  }
}
type Vars = Record<string, string>;
type Cfg = {
  keep_vars?: boolean;
  vars?: Vars;
  send_email?: { name: string; allowed_sender_addresses?: string[] }[];
  hyperdrive?: { binding: string; id: string }[];
  env?: Record<string, { vars?: Vars; send_email?: Cfg["send_email"] }>;
};
const cfg = JSON.parse(json) as Cfg;

let checks = 0;
const fails: string[] = [];
function ok(cond: unknown, msg: string) {
  checks++;
  if (!cond) fails.push(msg);
}

ok(cfg.keep_vars === true, "top-level keep_vars is true");
const blocks: [string, Vars | undefined][] = [["top-level", cfg.vars]];
for (const [name, e] of Object.entries(cfg.env ?? {})) blocks.push([`env.${name}`, e.vars]);
for (const [name, vars] of blocks) {
  ok(!/BETTER_AUTH_SECRET|OPENAI_API_KEY|DATABASE_URL|GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET/.test(Object.keys(vars ?? {}).join(",")), `${name} vars hold no secrets`);
}
const senders = [cfg.send_email, ...Object.values(cfg.env ?? {}).map((e) => e.send_email)];
for (const s of senders) {
  ok(s?.length === 1 && s[0].name === "EMAIL", "send_email EMAIL binding present");
  ok(JSON.stringify(s?.[0]?.allowed_sender_addresses) === '["login@polarch.day"]', "EMAIL sender locked to login@polarch.day");
}
ok(!googleLeak(raw), "wrangler.jsonc holds no Google client id or secret");
// Self-test the scanner on escaped / commented variants.
for (const [label, text] of [
  ["plain secret", '{ "vars": { "X": "GOCSPX-abc" } }'],
  ["\\u002d secret", '{ "vars": { "X": "GOCSPX\\u002dabc" } }'],
  ["\\u002e client id", '{ "vars": { "X": "1-a.apps\\u002egoogleusercontent\\u002ecom" } }'],
  ["fully escaped G", '{ "vars": { "X": "\\u0047OCSPX-abc" } }'],
  ["comment", '{\n  // GOCSPX-abc\n  "vars": {}\n}'],
] as const) {
  ok(googleLeak(text), `googleLeak catches ${label}`);
}
ok(!googleLeak('{ "vars": { "OPENAI_MODEL": "gpt-5-mini" } }'), "googleLeak passes a clean config");
ok(cfg.hyperdrive?.[0]?.id === "c18a2c83cf664a8d9fc9f40bcba47718", "prod Hyperdrive is leadwell-neon, not the placeholder");

if (fails.length) {
  console.error(`${fails.length}/${checks} failed`);
  for (const f of fails) console.error("  -", f);
  process.exit(1);
}
console.log(`config.check: ${checks} ok`);
