import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { parseIntoClientConfig } from "pg-connection-string";
import type { Config } from "../config.js";
import * as schema from "./schema/index.js";

/**
 * The pool, as `campus_svc`. It holds no CREATE anywhere: migrations connect as
 * `campus_owner` instead, which is the asymmetry that makes tic-auth's grant
 * matrix real rather than decorative (`tic-auth/docs/CONSISTENCY.md`).
 *
 * **NOT `new Pool({ connectionString, password })`**, which is the obvious form
 * and is silently wrong — the failure below is MEV's, measured, and copied here
 * rather than rediscovered. pg's `connection-parameters.js` does
 * `Object.assign({}, config, parse(config.connectionString))`, and `parse` on a
 * password-free URL returns an OWN `password: ''`. The parsed empty string
 * overwrites the password passed beside it, `val('password')` sees '' (falsy),
 * falls through to PGPASSWORD and then to pg's defaults, and the first query
 * fails with `password authentication failed for user "campus_svc"` — which
 * points at the credential rather than at the merge order. Passing a password
 * *function* does not help: the same assign discards it.
 *
 * Parsing here and handing pg discrete fields leaves no `connectionString` key
 * for it to re-parse, so there is no merge order to lose to. A quieter second
 * win: a discrete `password` is hidden behind a non-enumerable property, so an
 * accidental dump of `pool.options` no longer carries the credential.
 */
export function createPool(config: Config): Pool {
  return new Pool({
    // The spread also normalizes the parser's null-prototype object.
    ...parseIntoClientConfig(config.databaseUrl),
    // Spread-if-present, never `password: config.databasePassword`: an explicit
    // `undefined` would overwrite the password a local-dev URL does carry.
    ...(config.databasePassword ? { password: config.databasePassword } : {}),
    // tic-platform caps campus_svc at 15 connections (bin/limits.sh). Staying
    // under it here means a leak shows up as a slow request rather than as
    // "too many connections for role", which is a database-wide symptom.
    max: 10,
  });
}

export type Db = NodePgDatabase<typeof schema>;

/** A transaction on that pool. The write paths that must land together take
 *  `Db | Tx`, so a caller can put two of them in one transaction (F27). */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The ORM over that pool, still as `campus_svc`. It is handed the same barrel
 * `drizzle.config.ts` generates migrations from, so what the queries know about
 * and what the database was given cannot drift.
 *
 * `directory.ts` is not in that barrel and is imported where it is read —
 * listing it would put `CREATE TABLE "public"."user"` in a campus migration.
 */
export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema });
}
