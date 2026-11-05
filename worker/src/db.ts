import postgres from "postgres";
import { isLoopbackHostname } from "./authUrl.ts";
import type { Env } from "./env.ts";
import { databaseUrl } from "./env.ts";

export type Sql = postgres.Sql;

export const CONNECT_TIMEOUT_SECONDS = 5;
export const CONNECT_TIMEOUT_MS = CONNECT_TIMEOUT_SECONDS * 1000;

const PLACEHOLDER_HYPERDRIVE = "00000000000000000000000000000000";

export function raceTimeout<T>(
  promise: PromiseLike<T>,
  ms: number,
  message = "connect timeout",
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** True when the Worker will use the Hyperdrive binding (not the preview placeholder). */
export function usesHyperdrive(env: Pick<Env, "HYPERDRIVE">): boolean {
  const from = env.HYPERDRIVE?.connectionString?.trim() ?? "";
  return Boolean(from) && !from.includes(PLACEHOLDER_HYPERDRIVE);
}

/** Parsed hostname only — never a substring of user, database, or query. */
export function isHyperdriveHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "hyperdrive.local" || host.endsWith(".hyperdrive.local");
}

/**
 * TLS from the URL's sslmode, not a substring of the connection string.
 * Cloudflare Hyperdrive (`*.hyperdrive.local`) is already TLS to origin —
 * client TLS to Hyperdrive hangs, so it is always off.
 * Remote DATABASE_URL (Neon): always TLS. sslmode=prefer/allow/disable
 * must not open a cleartext client to a public host.
 */
export function postgresSsl(connectionString: string): false | "require" {
  try {
    const parsed = new URL(connectionString);
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    if (isHyperdriveHostname(host)) return false;
    if (isLoopbackHostname(host)) {
      const mode = (parsed.searchParams.get("sslmode") ?? "").toLowerCase();
      if (mode === "require" || mode === "verify-ca" || mode === "verify-full") {
        return "require";
      }
      return false;
    }
    return "require";
  } catch {
    return "require";
  }
}

export function clientSsl(
  env: Pick<Env, "HYPERDRIVE">,
  connectionString: string,
): false | "require" {
  if (usesHyperdrive(env)) return false;
  return postgresSsl(connectionString);
}

/**
 * Drop `sslmode` so node-pg / postgres.js cannot re-enable TLS from the
 * URL after we decided `ssl: false` (Hyperdrive bindings often append
 * `?sslmode=require`).
 */
export function stripSslMode(connectionString: string): string {
  try {
    const parsed = new URL(connectionString);
    if (!parsed.searchParams.has("sslmode")) return connectionString;
    parsed.searchParams.delete("sslmode");
    return parsed.toString();
  } catch {
    return connectionString;
  }
}

export function clientConnection(
  env: Pick<Env, "HYPERDRIVE">,
  connectionString: string,
): { connectionString: string; ssl: false | "require" } {
  const ssl = clientSsl(env, connectionString);
  return {
    connectionString: stripSslMode(connectionString),
    ssl,
  };
}

/**
 * node-pg Pool option. Always pass this — never omit `ssl` after stripping
 * sslmode, or a remote host opens cleartext. `true` for every non-loopback,
 * non-Hyperdrive host.
 */
export function poolSsl(ssl: false | "require"): boolean {
  return ssl === "require";
}

/**
 * Postgres `date` as the plain "YYYY-MM-DD" it is, not a JS Date.
 *
 * postgres.js turns `date` into a Date by default, and a Date serializes to
 * "2026-11-05T00:00:00.000Z". The one `date` column is `one_on_ones.series_date`,
 * and the app compares it to plain dates: a moved or skipped week's series date
 * never matched, so the rhythm drew that week again after a reload. (Only OID
 * 1082 is replaced; timestamps keep their parsers.)
 */
export const DATE_AS_STRING = {
  dateAsString: {
    to: 1082,
    from: [1082],
    serialize: (x: unknown) => (x instanceof Date ? x.toISOString().slice(0, 10) : String(x)),
    parse: (x: string) => x,
  },
};

export function createSql(env: Env): Sql {
  const url = databaseUrl(env);
  if (!url) throw new Error("database is not configured (HYPERDRIVE or DATABASE_URL)");
  const { connectionString, ssl } = clientConnection(env, url);
  return postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: CONNECT_TIMEOUT_SECONDS,
    ssl,
    types: DATE_AS_STRING,
  });
}

export async function closeSql(sql: Sql): Promise<void> {
  await raceTimeout(sql.end({ timeout: CONNECT_TIMEOUT_SECONDS }), CONNECT_TIMEOUT_MS).then(
    () => undefined,
    () => undefined,
  );
}
