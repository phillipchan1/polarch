import {
  authIpAddressHeaders,
  clientAuthIp,
  existingUserForMagicLinkEmail,
  isAllowedEmail,
  PROD_AUTH_IP_HEADERS,
  scheduleAuthBackground,
} from "./auth.ts";
import { clientConnection, poolSsl } from "./db.ts";
import {
  describeMagicLinkSendFailure,
  logMagicLinkSendFailure,
  logMagicLinkSoftCapSkip,
  magicLinkEmail,
  MagicLinkSendError,
  sendMagicLinkEmail,
} from "./mail.ts";
import {
  AUTH_IP_PREFIX_INVALID,
  authIpPrefix,
  MAGIC_LINK_EMAIL_PREFIX_MAX,
  MAGIC_LINK_EMAIL_SOFT_MAX,
  MAGIC_LINK_SEND_MAX,
  MAGIC_LINK_VERIFY_MAX,
} from "./rateLimit.ts";
import { catchBackgroundTask } from "./request.ts";

const fails: string[] = [];
let checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  if (!cond) fails.push(msg);
}

ok(
  isAllowedEmail({ ALLOWED_EMAILS: "phil@example.com" }, "Phil@Example.com"),
  "allowlist is case-insensitive",
);
ok(
  !isAllowedEmail({ ALLOWED_EMAILS: "phil@example.com" }, "other@example.com"),
  "unknown email is rejected",
);
ok(!isAllowedEmail({ ALLOWED_EMAILS: "" }, "phil@example.com"), "empty allowlist admits nobody");
ok(!isAllowedEmail({ ALLOWED_EMAILS: "phil@example.com" }, ""), "blank email rejected");
ok(
  isAllowedEmail({ ALLOWED_EMAILS: "a@x.com, phil@example.com" }, "phil@example.com"),
  "comma-separated allowlist",
);

const philId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const migrated = [{ id: philId, email: "Phil@Example.com" }];
ok(
  existingUserForMagicLinkEmail(migrated, "phil@example.com")?.id === philId,
  "first magic-link sign-in lands on the migrated Supabase UUID",
);
ok(
  existingUserForMagicLinkEmail(migrated, "other@example.com") === null,
  "unknown email is not an existing user",
);
ok(
  existingUserForMagicLinkEmail([], "phil@example.com") === null,
  "empty user table would create, not adopt",
);

const mail = magicLinkEmail({ url: "https://polarch.day/api/auth/magic-link/verify?token=abc" });
ok(mail.subject === "Your Polarch sign-in link", "magic-link subject says Polarch");
ok(!/LeadWell/.test(mail.subject + mail.text + mail.html), "magic-link email no longer says LeadWell");
ok(mail.text.includes("https://polarch.day/api/auth/magic-link/verify"), "magic-link body has url");

ok(MAGIC_LINK_SEND_MAX === 3, "magic-link send is 3 per window");
ok(MAGIC_LINK_EMAIL_PREFIX_MAX === 10, "hourly cap is 10 per email+IP-prefix");
ok(MAGIC_LINK_EMAIL_SOFT_MAX === 200, "silent per-email soft cap is 200/hour");
ok(MAGIC_LINK_VERIFY_MAX === 10, "magic-link verify is tightly capped");
ok(authIpPrefix("203.0.113.45") === "203.0.113.0/24", "IPv4 prefix is /24");
ok(authIpPrefix("2001:db8:abcd:1234::1") === "2001:0db8:abcd::/48", "IPv6 prefix is /48");
ok(authIpPrefix("2001:db8::1") === "2001:0db8:0000::/48", "compressed IPv6 still /48");
ok(authIpPrefix("::ffff:203.0.113.45") === "203.0.113.0/24", "IPv4-mapped IPv6 uses /24");
ok(authIpPrefix("not-an-ip") === AUTH_IP_PREFIX_INVALID, "garbage IPv4-shaped string is invalid");
ok(authIpPrefix("::::") === AUTH_IP_PREFIX_INVALID, "broken IPv6 is invalid");
ok(authIpPrefix("2001:db8:gggg::1") === AUTH_IP_PREFIX_INVALID, "non-hex IPv6 is invalid");
ok(authIpPrefix("unknown") === AUTH_IP_PREFIX_INVALID, "sentinel unknown is invalid");
ok(
  authIpPrefix("foo") === authIpPrefix("bar") && authIpPrefix("foo") === AUTH_IP_PREFIX_INVALID,
  "unparseable IPs share one invalid bucket",
);
const softLogs: unknown[] = [];
logMagicLinkSoftCapSkip((message, detail) => {
  softLogs.push(message, detail);
});
ok(JSON.stringify(softLogs).includes("soft_cap"), "soft-cap skip logs kind soft_cap");
ok(!JSON.stringify(softLogs).includes("@"), "soft-cap skip log has no email");

ok(
  authIpAddressHeaders({}).join(",") === PROD_AUTH_IP_HEADERS.join(","),
  "prod IP limit reads only CF-Connecting-IP",
);
ok(!authIpAddressHeaders({}).includes("x-forwarded-for"), "prod ignores X-Forwarded-For");
ok(!authIpAddressHeaders({}).includes("x-real-ip"), "prod ignores X-Real-IP");
ok(
  authIpAddressHeaders({ ENVIRONMENT: "local" }).includes("x-forwarded-for"),
  "local still accepts XFF for wrangler/vite",
);
ok(
  clientAuthIp(
    new Headers({ "cf-connecting-ip": "198.51.100.10", "x-forwarded-for": "8.8.8.8" }),
    {},
  ) === "198.51.100.10",
  "prod client IP is CF-Connecting-IP",
);
ok(
  clientAuthIp(new Headers({ "x-forwarded-for": "8.8.8.8", "x-real-ip": "1.1.1.1" }), {}) ===
    "unknown",
  "prod ignores XFF/X-Real-IP when CF-Connecting-IP is absent",
);
ok(
  clientAuthIp(new Headers({ "x-forwarded-for": "8.8.8.8" }), { ENVIRONMENT: "local" }) ===
    "8.8.8.8",
  "local client IP can read XFF",
);

const neon = "postgresql://neondb@ep-prod.us-east-1.aws.neon.tech/polarch?sslmode=disable";
const loopback = "postgresql://postgres@127.0.0.1:5432/polarch";
const hyperdrive = "postgresql://u:p@abc.hyperdrive.local:5432/polarch?sslmode=require";

ok(
  poolSsl(clientConnection({}, neon).ssl) === true,
  "Better Auth pool requires TLS for remote Neon even if sslmode is stripped",
);
ok(
  poolSsl(clientConnection({}, loopback).ssl) === false,
  "Better Auth pool TLS off for loopback",
);
ok(
  poolSsl(clientConnection({ HYPERDRIVE: { connectionString: hyperdrive } }, hyperdrive).ssl) ===
    false,
  "Better Auth pool TLS off for Hyperdrive",
);

const missingEnvErr = new MagicLinkSendError("missing_env");
const cfEmailErr = new MagicLinkSendError("cf_email");
ok(
  describeMagicLinkSendFailure(missingEnvErr).kind === "missing_env" &&
    describeMagicLinkSendFailure(missingEnvErr).status === undefined,
  "missing_env failure is kind-only",
);
ok(
  describeMagicLinkSendFailure(cfEmailErr).kind === "cf_email" &&
    describeMagicLinkSendFailure(cfEmailErr).status === undefined,
  "cf_email failure is kind-only",
);

const logged: unknown[] = [];
logMagicLinkSendFailure(missingEnvErr, (message, detail) => {
  logged.push(message, detail);
});
logMagicLinkSendFailure(cfEmailErr, (message, detail) => {
  logged.push(message, detail);
});
const loggedBlob = JSON.stringify(logged);
ok(loggedBlob.includes("missing_env") && loggedBlob.includes("cf_email"), "send logs include kind");
ok(!loggedBlob.includes("@") && !loggedBlob.includes("token"), "send logs have no email or token");

try {
  await sendMagicLinkEmail(
    {} as never,
    { email: "phil@example.com", url: "https://polarch.day/x", token: "visible-token" },
  );
  ok(false, "missing mail env throws");
} catch (err) {
  ok(err instanceof MagicLinkSendError && err.kind === "missing_env", "missing mail env is missing_env");
}

const throwingEmail = {
  async send() {
    throw new Error("boom to phil@example.com");
  },
} as unknown as SendEmail;
try {
  await sendMagicLinkEmail(
    { EMAIL: throwingEmail } as never,
    { email: "phil@example.com", url: "https://polarch.day/x", token: "visible-token" },
  );
  ok(false, "Cloudflare Email throw throws");
} catch (err) {
  ok(
    err instanceof MagicLinkSendError && err.kind === "cf_email" && err.status === undefined,
    "Cloudflare Email throw is cf_email",
  );
}

let unhandled = 0;
const onUnhandled = () => {
  unhandled += 1;
};
const realError = console.error;
console.error = () => {};
process.on("unhandledRejection", onUnhandled);
catchBackgroundTask(Promise.reject(new MagicLinkSendError("cf_email")));
await Promise.resolve();
await Promise.resolve();
ok(unhandled === 0, "request.ts fallback catch does not raise unhandledRejection");
process.off("unhandledRejection", onUnhandled);
console.error = realError;

let scheduled: Promise<unknown> | undefined;
let backgroundDone = false;
const slow = new Promise<void>((resolve) => {
  setTimeout(() => {
    backgroundDone = true;
    resolve();
  }, 180);
});
const tSched = Date.now();
scheduleAuthBackground((task) => {
  scheduled = task;
}, slow);
const schedMs = Date.now() - tSched;
ok(schedMs < 50, `scheduleAuthBackground does not await the task (${schedMs}ms)`);
ok(scheduled !== undefined, "waitUntil is invoked");
ok(scheduled !== slow, "waitUntil receives the caught promise, not the raw task");
ok(!backgroundDone, "scheduled work has not finished when scheduleAuthBackground returns");
await slow;

let orphanDone = false;
const orphan = new Promise<void>((resolve) => {
  setTimeout(() => {
    orphanDone = true;
    resolve();
  }, 180);
});
const tOrphan = Date.now();
scheduleAuthBackground(undefined, orphan);
const orphanMs = Date.now() - tOrphan;
ok(orphanMs < 50, `missing waitUntil still does not await the task (${orphanMs}ms)`);
ok(!orphanDone, "missing-waitUntil path does not await Cloudflare Email or the no-op");
await orphan;

let waitUntilUnhandled = 0;
const onWaitUntilUnhandled = () => {
  waitUntilUnhandled += 1;
};
process.on("unhandledRejection", onWaitUntilUnhandled);
const rejectedSkip = Promise.reject(new MagicLinkSendError("cf_email"));
const realSkipError = console.error;
console.error = () => {};
const pendingSkips = new Set<Promise<unknown>>();
scheduleAuthBackground(
  (task) => {
    void task;
  },
  rejectedSkip,
  pendingSkips,
);
await Promise.resolve();
await Promise.resolve();
ok(waitUntilUnhandled === 0, "waitUntil skip task with a pending Set does not raise unhandledRejection");
process.off("unhandledRejection", onWaitUntilUnhandled);
console.error = realSkipError;

if (fails.length) {
  console.error(`${fails.length}/${checks} failed`);
  for (const f of fails) console.error("  -", f);
  process.exit(1);
}
console.log(`auth.check: ${checks} ok`);
