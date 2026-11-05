import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";

/**
 * postgres.js describes each statement, learns which parameters are json/jsonb,
 * and runs every such value through JSON.stringify, strings included. PGlite
 * passes a string through untouched, so a check here once stored a
 * pre-stringified value as an array while production stored it as a JSON string
 * the app could not read. Serialize the way production does.
 */
const AS_POSTGRES_JS = {
  serializers: {
    114: (x: unknown) => JSON.stringify(x),
    3802: (x: unknown) => JSON.stringify(x),
  },
};

/** Wrap PGlite so postgres.js-style `sql.unsafe` and `sql.begin` work in Node checks. */
export function pgliteAsSql(db: PGlite): postgres.Sql {
  let self: postgres.Sql;
  const unsafe = async (text: string, params: unknown[] = []) => {
    const result = await db.query(text, params as never[], AS_POSTGRES_JS);
    return result.rows as never;
  };
  // PGlite is one connection, so BEGIN … COMMIT here is the same transaction
  // `sql.begin` gives postgres.js on a `max: 1` client.
  const begin = async <T>(fn: (tx: postgres.Sql) => Promise<T>): Promise<T> => {
    await db.exec("BEGIN");
    try {
      const out = await fn(self);
      await db.exec("COMMIT");
      return out;
    } catch (err) {
      await db.exec("ROLLBACK");
      throw err;
    }
  };
  const sql = Object.assign(
    async () => {
      throw new Error("tagged postgres.js templates are not wired in PGlite checks — use sql.unsafe");
    },
    {
      unsafe,
      begin,
      end: async () => {
        await db.close();
      },
      json: (value: unknown) => value,
      array: (value: unknown) => value,
    },
  );
  self = sql as unknown as postgres.Sql;
  return self;
}
