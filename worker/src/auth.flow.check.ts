/**
 * Prove magic-link rate limits, waitUntil mail, CF-Connecting-IP keying,
 * allowlist-before-email-counter, email+IP and email+prefix, silent 200/hr
 * soft cap, closeAuth-vs-skip hang, invalid-IP prefix bucket, send-failure
 * logs, and no password auth.
 */
import { PGlite } from "@electric-sql/pglite";
import { closeAuth, createAuth, handleAuthRequest, type AuthDatabase } from "./auth.ts";
import { applySchema } from "./isolationDb.ts";
import {
  AUTH_IP_PREFIX_INVALID,
  consumeEmailMagicLinkLimit,
  emailIpPrefixMagicLinkRateLimitKey,
  emailSoftMagicLinkRateLimitKey,
  MAGIC_LINK_EMAIL_PREFIX_MAX,
  MAGIC_LINK_EMAIL_SOFT_MAX,
  MAGIC_LINK_SEND_MAX,
  MAGIC_LINK_VERIFY_MAX,
} from "./rateLimit.ts";

const fails: string[] = [];
let checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  if (!cond) fails.push(msg);
}

function pgliteAsPool(db: PGlite): AuthDatabase {
  return {
    async connect() {
      return {
        async query(sql: string, parameters: readonly unknown[] = []) {
          const result = await db.query(sql, parameters as never[]);
          return {
            command: "SELECT",
            rowCount: result.affectedRows ?? result.rows.length,
            rows: result.rows,
          };
        },
        release() {},
      };
    },
    async end() {
      /* PGlite is closed by the test */
    },
    options: {},
  };
}

type CfSend = { from: unknown; to: unknown; subject?: string; text?: string; html?: string };
const cfSends: CfSend[] = [];
function emailBinding(opts: { delayMs?: number; fail?: boolean } = {}): SendEmail {
  return {
    async send(message: CfSend) {
      if (opts.fail) throw new Error("boom to phil@example.com");
      if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
      cfSends.push(message);
      return { messageId: "m1" };
    },
  } as unknown as SendEmail;
}

const env = {
  BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long",
  BETTER_AUTH_URL: "http://localhost:8787",
  ENVIRONMENT: "local" as const,
  ALLOWED_EMAILS: "phil@example.com,pat@example.com",
  EMAIL: emailBinding({ delayMs: 180 }),
};

const origin = "http://localhost:8787";
const db = new PGlite();
await applySchema(db);
const pool = pgliteAsPool(db);
const background: Promise<unknown>[] = [];
const auth = createAuth(env, pool, {
  waitUntil: (task) => {
    background.push(task);
  },
});

function magicLinkHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers({
    origin,
    "content-type": "application/json",
    "cf-connecting-ip": "203.0.113.10",
    ...extra,
  });
}

async function sendLink(
  email: string,
  extra: Record<string, string> = {},
  instance = auth,
  requestOrigin = origin,
): Promise<Response> {
  return handleAuthRequest(
    instance,
    new Request(`${requestOrigin}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: magicLinkHeaders({ origin: requestOrigin, ...extra }),
      body: JSON.stringify({ email, callbackURL: `${requestOrigin}/signin` }),
    }),
  );
}

async function verifyBad(token: string): Promise<Response> {
  return handleAuthRequest(
    auth,
    new Request(`${origin}/api/auth/magic-link/verify?token=${token}&callbackURL=${origin}/signin`, {
      method: "GET",
      headers: { origin, "cf-connecting-ip": "203.0.113.10" },
    }),
  );
}

async function flushMail(): Promise<void> {
  const pending = background.splice(0);
  await Promise.all(pending);
}

async function keysMatching(pattern: string): Promise<string[]> {
  const result = await db.query("SELECT key FROM rate_limit WHERE key LIKE $1", [pattern]);
  return (result.rows as { key: string }[]).map((row) => row.key);
}

try {
  const tAllowed = Date.now();
  const allowed = await sendLink("phil@example.com");
  const allowedMs = Date.now() - tAllowed;
  const allowedBody = (await allowed.json()) as { status?: boolean };
  ok(allowed.status === 200, `allowlisted send is 200 (got ${allowed.status})`);
  ok(allowedBody.status === true, "allowlisted send returns {status:true}");
  ok(allowedMs < 120, `allowlisted response does not wait on Cloudflare Email (${allowedMs}ms)`);
  ok(cfSends.length === 0, "Cloudflare Email has not finished before waitUntil flush");

  const tDenied = Date.now();
  const denied = await sendLink("stranger@example.com");
  const deniedMs = Date.now() - tDenied;
  const deniedBody = (await denied.json()) as { status?: boolean };
  ok(denied.status === 200, `non-allowlisted send is 200 (got ${denied.status})`);
  ok(deniedBody.status === true, "non-allowlisted send returns {status:true}");
  ok(deniedMs < 120, `non-allowlisted response is equally fast (${deniedMs}ms)`);

  await flushMail();
  ok(cfSends.length === 1, `waitUntil sent exactly one email (got ${cfSends.length})`);
  ok(
    cfSends.every((c) => c.to === "phil@example.com"),
    "Cloudflare Email is not called for a non-allowlisted address",
  );

  await db.query("DELETE FROM rate_limit");
  cfSends.length = 0;
  const strangerStatuses: number[] = [];
  for (let i = 0; i < 20; i++) {
    strangerStatuses.push(
      (await sendLink("stranger@example.com", { "cf-connecting-ip": `198.51.100.${i + 1}` })).status,
    );
  }
  await flushMail();
  ok(
    strangerStatuses.every((s) => s === 200),
    "non-allowlisted floods still return 200 (not 429 on email)",
  );
  ok(
    (await keysMatching("%phil@example.com%")).length === 0,
    "stranger floods do not charge Phil's email buckets",
  );
  ok(cfSends.length === 0, "stranger floods do not call Cloudflare Email");

  const prefixCap: number[] = [];
  for (let i = 1; i <= MAGIC_LINK_EMAIL_PREFIX_MAX + 1; i++) {
    prefixCap.push(
      (await sendLink("phil@example.com", { "cf-connecting-ip": `198.51.100.${i}` })).status,
    );
  }
  await flushMail();
  ok(
    prefixCap.slice(0, MAGIC_LINK_EMAIL_PREFIX_MAX).every((s) => s === 200),
    `first ${MAGIC_LINK_EMAIL_PREFIX_MAX} from one /24 are 200 (got ${prefixCap.join(",")})`,
  );
  ok(
    prefixCap[MAGIC_LINK_EMAIL_PREFIX_MAX] === 429,
    `11th from the same /24 is 429 (got ${prefixCap[MAGIC_LINK_EMAIL_PREFIX_MAX]})`,
  );
  ok(
    cfSends.length === MAGIC_LINK_EMAIL_PREFIX_MAX,
    `per-prefix hourly cap holds at ${MAGIC_LINK_EMAIL_PREFIX_MAX} real sends (got ${cfSends.length})`,
  );
  ok(
    (await keysMatching("email|/sign-in/magic-link|%")).length === 0,
    "no rate-limit key is email-only",
  );

  await db.query("DELETE FROM rate_limit");
  cfSends.length = 0;
  const philFlood: number[] = [];
  for (let i = 1; i <= 25; i++) {
    philFlood.push(
      (await sendLink("phil@example.com", { "cf-connecting-ip": `203.0.${i}.10` })).status,
    );
  }
  await flushMail();
  ok(
    philFlood.every((s) => s === 200),
    `25-prefix Phil flood is all 200 (got ${philFlood.join(",")})`,
  );
  ok(cfSends.length === 25, `25 prefixes each get a real send (got ${cfSends.length})`);
  cfSends.length = 0;
  const freshPrefix = await sendLink("phil@example.com", { "cf-connecting-ip": "198.51.200.1" });
  ok(freshPrefix.status === 200, "Phil from a fresh prefix still gets 200 after a 25-prefix flood");
  await flushMail();
  ok(cfSends.length === 1, "fresh prefix gets a real send, not a silent 200");

  await db.query("DELETE FROM rate_limit");
  cfSends.length = 0;
  const invalidConsumes: boolean[] = [];
  for (let i = 1; i <= MAGIC_LINK_EMAIL_PREFIX_MAX + 1; i++) {
    invalidConsumes.push(
      (await consumeEmailMagicLinkLimit(pool, "phil@example.com", `not-an-ip-${i}`)).allowed,
    );
  }
  ok(
    invalidConsumes.slice(0, MAGIC_LINK_EMAIL_PREFIX_MAX).every(Boolean),
    `first ${MAGIC_LINK_EMAIL_PREFIX_MAX} unparseable IPs share the invalid prefix (got ${invalidConsumes.join(",")})`,
  );
  ok(
    invalidConsumes[MAGIC_LINK_EMAIL_PREFIX_MAX] === false,
    "11th unparseable IP is denied on the shared invalid prefix",
  );
  ok(
    (await keysMatching(emailIpPrefixMagicLinkRateLimitKey("phil@example.com", AUTH_IP_PREFIX_INVALID)))
      .length === 1,
    "unparseable IPs write a single invalid prefix key",
  );

  await db.query("DELETE FROM rate_limit");
  cfSends.length = 0;
  const softWindowStart = Date.now() - 1000;
  await db.query(
    "INSERT INTO rate_limit (id, key, count, last_request, window_start) VALUES ($1, $2, $3, $4, $5)",
    [
      crypto.randomUUID(),
      emailSoftMagicLinkRateLimitKey("phil@example.com"),
      MAGIC_LINK_EMAIL_SOFT_MAX,
      softWindowStart,
      softWindowStart,
    ],
  );
  const softLogs: unknown[][] = [];
  const realSoftError = console.error;
  console.error = (...args: unknown[]) => {
    softLogs.push(args);
  };
  try {
    const tSoft = Date.now();
    const soft = await sendLink("phil@example.com", { "cf-connecting-ip": "203.0.50.1" });
    const softMs = Date.now() - tSoft;
    const softBody = (await soft.json()) as { status?: boolean };
    ok(soft.status === 200, `soft cap still returns 200 (got ${soft.status})`);
    ok(softBody.status === true, "soft cap returns {status:true}");
    ok(softMs < 120, `soft-cap response has the same fast timing (${softMs}ms)`);
    ok(cfSends.length === 0, "capped path does not await Cloudflare Email");
    await flushMail();
    ok(cfSends.length === 0, "soft cap skips the send");
    const skipLog = softLogs.find((args) => {
      const detail = args[1] as { kind?: string } | undefined;
      return detail?.kind === "soft_cap";
    });
    ok(Boolean(skipLog), "soft cap logs once with kind soft_cap");
    ok(!JSON.stringify(skipLog ?? []).includes("phil@example.com"), "soft-cap log has no email");

    softLogs.length = 0;
    const tSoft2 = Date.now();
    const soft2 = await sendLink("phil@example.com", { "cf-connecting-ip": "203.0.51.1" });
    const soft2Ms = Date.now() - tSoft2;
    ok(soft2.status === 200, `second soft-cap send is still 200 (got ${soft2.status})`);
    ok(soft2Ms < 120, `second soft-cap send stays fast (${soft2Ms}ms)`);
    await flushMail();
    ok(cfSends.length === 0, "second soft-cap send is also skipped");
    ok(
      !softLogs.some((args) => (args[1] as { kind?: string } | undefined)?.kind === "soft_cap"),
      "soft cap does not log again",
    );
  } finally {
    console.error = realSoftError;
  }

  const noWaitAuth = createAuth(env, pool);
  try {
    await db.query("DELETE FROM rate_limit");
    cfSends.length = 0;
    const noWaitCapStart = Date.now();
    await db.query(
      "INSERT INTO rate_limit (id, key, count, last_request, window_start) VALUES ($1, $2, $3, $4, $5)",
      [
        crypto.randomUUID(),
        emailSoftMagicLinkRateLimitKey("phil@example.com"),
        MAGIC_LINK_EMAIL_SOFT_MAX,
        noWaitCapStart,
        noWaitCapStart,
      ],
    );
    const noWaitLogs: unknown[][] = [];
    const realNoWaitError = console.error;
    console.error = (...args: unknown[]) => {
      noWaitLogs.push(args);
    };
    try {
      const tNoWaitCap = Date.now();
      const noWaitCap = await sendLink(
        "phil@example.com",
        { "cf-connecting-ip": "203.0.80.2" },
        noWaitAuth,
      );
      const noWaitCapMs = Date.now() - tNoWaitCap;
      ok(noWaitCap.status === 200, `capped without waitUntil is 200 (got ${noWaitCap.status})`);
      ok(noWaitCapMs < 120, `capped without waitUntil does not await extra work (${noWaitCapMs}ms)`);
      ok(cfSends.length === 0, "capped without waitUntil does not await Cloudflare Email");
      await new Promise((resolve) => setTimeout(resolve, 50));
      ok(cfSends.length === 0, "capped without waitUntil dispatches a no-op, not Cloudflare Email");
      ok(
        noWaitLogs.some((args) => (args[1] as { kind?: string } | undefined)?.kind === "soft_cap"),
        "capped without waitUntil still logs in the background",
      );
    } finally {
      console.error = realNoWaitError;
    }

    await db.query("DELETE FROM rate_limit");
    cfSends.length = 0;
    const tNoWaitSend = Date.now();
    const noWaitSend = await sendLink(
      "phil@example.com",
      { "cf-connecting-ip": "203.0.80.1" },
      noWaitAuth,
    );
    const noWaitSendMs = Date.now() - tNoWaitSend;
    ok(noWaitSend.status === 200, "uncapped without waitUntil is 200");
    ok(
      noWaitSendMs < 120,
      `uncapped without waitUntil does not await Cloudflare Email (${noWaitSendMs}ms)`,
    );
    ok(cfSends.length === 0, "uncapped without waitUntil has not finished Cloudflare Email yet");
    await new Promise((resolve) => setTimeout(resolve, 250));
    ok(cfSends.length === 1, "uncapped without waitUntil still dispatches the send");
  } finally {
    await closeAuth(noWaitAuth);
  }

  {
    const hangDb = new PGlite();
    await applySchema(hangDb);
    let ended = false;
    const hangPool: AuthDatabase = {
      async connect() {
        if (ended) return new Promise(() => {});
        return {
          async query(sql: string, parameters: readonly unknown[] = []) {
            if (ended) return new Promise(() => {});
            const result = await hangDb.query(sql, parameters as never[]);
            return {
              command: "SELECT",
              rowCount: result.affectedRows ?? result.rows.length,
              rows: result.rows,
            };
          },
          release() {},
        };
      },
      async end() {
        ended = true;
      },
      options: {},
    };
    const hangBg: Promise<unknown>[] = [];
    const hangAuth = createAuth(env, hangPool, {
      waitUntil: (task) => {
        hangBg.push(task);
      },
      closeDatabase: true,
    });
    const hangStart = Date.now();
    await hangDb.query(
      "INSERT INTO rate_limit (id, key, count, last_request, window_start) VALUES ($1, $2, $3, $4, $5)",
      [
        crypto.randomUUID(),
        emailSoftMagicLinkRateLimitKey("phil@example.com"),
        MAGIC_LINK_EMAIL_SOFT_MAX,
        hangStart,
        hangStart,
      ],
    );
    const hangLogs: unknown[][] = [];
    const realHangError = console.error;
    console.error = (...args: unknown[]) => {
      hangLogs.push(args);
    };
    try {
      const hangRes = await sendLink(
        "phil@example.com",
        { "cf-connecting-ip": "203.0.90.1" },
        hangAuth,
      );
      ok(hangRes.status === 200, `hang-repro send is 200 (got ${hangRes.status})`);
      const closed = Promise.all([closeAuth(hangAuth), ...hangBg]);
      const outcome = await Promise.race([
        closed.then(() => "ok" as const),
        new Promise<"hang">((resolve) => {
          setTimeout(() => resolve("hang"), 1000);
        }),
      ]);
      ok(
        outcome === "ok",
        "closeAuth awaits the skip task before pool.end() (no hang, log not lost)",
      );
      ok(
        hangLogs.some((args) => (args[1] as { kind?: string } | undefined)?.kind === "soft_cap"),
        "magic-link send skipped log survives closeAuth",
      );
    } finally {
      console.error = realHangError;
      await hangDb.close();
    }
  }

  await db.query("DELETE FROM rate_limit");
  cfSends.length = 0;
  const sendStatuses: number[] = [];
  for (let i = 0; i < 20; i++) {
    sendStatuses.push((await sendLink("phil@example.com")).status);
  }
  await flushMail();
  const sendOk = sendStatuses.filter((s) => s === 200).length;
  const sendLimited = sendStatuses.filter((s) => s === 429).length;
  ok(cfSends.length <= MAGIC_LINK_SEND_MAX, `20 sends produce ≤${MAGIC_LINK_SEND_MAX} Cloudflare Email sends (got ${cfSends.length})`);
  ok(sendLimited >= 20 - MAGIC_LINK_SEND_MAX, `20 sends produce 429s after the cap (got ${sendLimited} 429s, statuses=${sendStatuses.join(",")})`);
  ok(sendOk <= MAGIC_LINK_SEND_MAX, `20 sends produce ≤${MAGIC_LINK_SEND_MAX} successes (got ${sendOk})`);

  const verifyStatuses: number[] = [];
  for (let i = 0; i < 40; i++) {
    verifyStatuses.push((await verifyBad(`bad-token-${i}`)).status);
  }
  const verifyLimited = verifyStatuses.filter((s) => s === 429).length;
  ok(verifyLimited > 0, `40 bad verifies hit 429 (got ${verifyLimited}; statuses=${verifyStatuses.join(",")})`);
  ok(
    verifyLimited >= 40 - MAGIC_LINK_VERIFY_MAX,
    `verify 429s match the tight cap (got ${verifyLimited}, cap ${MAGIC_LINK_VERIFY_MAX})`,
  );

  const prodEnv = {
    ...env,
    ENVIRONMENT: undefined,
    BETTER_AUTH_URL: "https://polarch.day",
  };
  const prodBg: Promise<unknown>[] = [];
  const prodAuth = createAuth(prodEnv, pool, { waitUntil: (task) => prodBg.push(task) });
  await db.query("DELETE FROM rate_limit");
  const ipA = { "cf-connecting-ip": "198.51.100.10", "x-forwarded-for": "8.8.8.8", "x-real-ip": "1.1.1.1" };
  const ipASpoof = {
    "cf-connecting-ip": "198.51.100.10",
    "x-forwarded-for": "9.9.9.9",
    "x-real-ip": "2.2.2.2",
  };
  const ipB = { "cf-connecting-ip": "198.51.100.11", "x-forwarded-for": "8.8.8.8", "x-real-ip": "1.1.1.1" };
  for (let i = 0; i < 3; i++) {
    ok(
      (await sendLink("phil@example.com", i === 0 ? ipA : ipASpoof, prodAuth, "https://polarch.day"))
        .status === 200,
      `prod IP A send ${i + 1} succeeds`,
    );
  }
  ok(
    (await sendLink("pat@example.com", ipASpoof, prodAuth, "https://polarch.day")).status === 429,
    "prod: same CF-Connecting-IP is one bucket even when XFF/X-Real-IP change",
  );
  ok(
    (await sendLink("pat@example.com", ipB, prodAuth, "https://polarch.day")).status === 200,
    "prod: a new CF-Connecting-IP is a separate bucket (XFF match is ignored)",
  );
  await Promise.all(prodBg.splice(0));
  await closeAuth(prodAuth);

  const signup = await handleAuthRequest(
    auth,
    new Request(`${origin}/api/auth/sign-up/email`, {
      method: "POST",
      headers: magicLinkHeaders(),
      body: JSON.stringify({
        email: "phil@example.com",
        password: "a-long-enough-password",
        name: "Phil",
      }),
    }),
  );
  ok(signup.status >= 400, `email/password sign-up is disabled (got ${signup.status})`);
  const signin = await handleAuthRequest(
    auth,
    new Request(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: magicLinkHeaders(),
      body: JSON.stringify({
        email: "phil@example.com",
        password: "a-long-enough-password",
      }),
    }),
  );
  ok(signin.status >= 400, `email/password sign-in is disabled (got ${signin.status})`);

  await db.query("DELETE FROM rate_limit");
  const failLogs: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    failLogs.push(args);
  };
  try {
    const missingBg: Promise<unknown>[] = [];
    const missingAuth = createAuth(
      { ...env, EMAIL: undefined },
      pool,
      { waitUntil: (task) => missingBg.push(task) },
    );
    const missing = await sendLink(
      "phil@example.com",
      { "cf-connecting-ip": "203.0.113.80" },
      missingAuth,
    );
    ok(missing.status === 200, `missing mail env still returns 200 (got ${missing.status})`);
    await Promise.all(missingBg);
    const missingLog = failLogs.find((args) => {
      const detail = args[1] as { kind?: string } | undefined;
      return detail?.kind === "missing_env";
    });
    ok(Boolean(missingLog), "missing EMAIL binding logs kind missing_env");
    const missingBlob = JSON.stringify(missingLog ?? []);
    ok(!missingBlob.includes("phil@example.com"), "missing_env log has no email");
    ok(!/"token"/.test(missingBlob) && !missingBlob.includes("visible"), "missing_env log has no token");
    await closeAuth(missingAuth);

    failLogs.length = 0;
    const cfFailBg: Promise<unknown>[] = [];
    const failAuth = createAuth(
      { ...env, EMAIL: emailBinding({ fail: true }) },
      pool,
      { waitUntil: (task) => cfFailBg.push(task) },
    );
    const cfFail = await sendLink(
      "phil@example.com",
      { "cf-connecting-ip": "203.0.113.81" },
      failAuth,
    );
    ok(cfFail.status === 200, `Cloudflare Email throw still returns 200 (got ${cfFail.status})`);
    await Promise.all(cfFailBg);
    const httpLog = failLogs.find((args) => {
      const detail = args[1] as { kind?: string } | undefined;
      return detail?.kind === "cf_email";
    });
    ok(Boolean(httpLog), "Cloudflare Email throw logs kind cf_email");
    const httpBlob = JSON.stringify(httpLog ?? []);
    ok(!httpBlob.includes("phil@example.com"), "cf_email log has no email");
    ok(!/"token"/.test(httpBlob) && !httpBlob.includes("visible"), "cf_email log has no token");
    await closeAuth(failAuth);
  } finally {
    console.error = realError;
  }
} finally {
  await closeAuth(auth);
  await db.close();
}

if (fails.length) {
  console.error(`${fails.length}/${checks} failed`);
  for (const f of fails) console.error("  -", f);
  process.exit(1);
}
console.log(`auth.flow.check: ${checks} ok`);
