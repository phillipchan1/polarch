import { parseFrom, sendMagicLinkEmail, MagicLinkSendError } from "./mail.ts";
import type { Env } from "./env.ts";

let checks = 0;
const fails: string[] = [];
function ok(cond: unknown, msg: string) {
  checks++;
  if (!cond) fails.push(msg);
}

type Sent = { from: unknown; to: unknown; subject: string; text?: string; html?: string };
function binding(fail = false) {
  const sent: Sent[] = [];
  return {
    sent,
    EMAIL: {
      async send(m: Sent) {
        if (fail) throw new Error("boom to phil@example.com");
        sent.push(m);
        return { messageId: "m1" };
      },
    } as unknown as SendEmail,
  };
}
const opts = { email: " Phil@Example.com ", url: "https://polarch.day/x?token=visible", token: "visible" };

ok(JSON.stringify(parseFrom("Polarch <login@polarch.day>")) === '{"email":"login@polarch.day","name":"Polarch"}', "parseFrom name+addr");
ok(parseFrom("login@polarch.day") === "login@polarch.day", "parseFrom bare addr");

// 1. Binding present: Cloudflare is used.
const b = binding();
const via = await sendMagicLinkEmail({ EMAIL: b.EMAIL } as Env, opts);
ok(via === "cloudflare", "binding path returns cloudflare");
ok(b.sent.length === 1, "one CF send");
const m = b.sent[0];
ok(JSON.stringify(m?.from) === '{"email":"login@polarch.day","name":"Polarch"}', "default from is Polarch <login@polarch.day>");
ok(m?.to === "phil@example.com", "recipient normalized");
ok(m?.subject === "Your Polarch sign-in link", "subject unchanged");
ok(Boolean(m?.text?.includes(opts.url)) && Boolean(m?.html?.includes(opts.url)), "link in text and html");

// 2. Binding throws: fail closed with cf_email; no fallback.
let cfThrew: unknown;
try {
  await sendMagicLinkEmail({ EMAIL: binding(true).EMAIL } as Env, opts);
} catch (err) {
  cfThrew = err;
}
ok(cfThrew instanceof MagicLinkSendError && cfThrew.kind === "cf_email", "binding error is cf_email");
ok(cfThrew instanceof MagicLinkSendError && cfThrew.status === undefined, "cf_email has no status");

// 3. No binding: fail closed with missing_env.
let missingThrew: unknown;
try {
  await sendMagicLinkEmail({} as Env, opts);
} catch (err) {
  missingThrew = err;
}
ok(missingThrew instanceof MagicLinkSendError && missingThrew.kind === "missing_env", "missing binding is missing_env");

if (fails.length) {
  console.error(`${fails.length}/${checks} failed`);
  for (const f of fails) console.error("  -", f);
  process.exit(1);
}
console.log(`mail.check: ${checks} ok`);
