import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { Pool, type PoolClient } from "pg";
import { campus } from "./schema/_schema.js";
import * as schema from "./schema/index.js";

/**
 * Where the migration SQL lives, which differs between running from source and
 * running the built image, and getting it wrong is invisible until deploy day.
 *
 * The runtime image installs production dependencies and copies `dist/`, and
 * nothing else — the repo's `drizzle/` directory is NOT in it. So the build
 * copies the migrations into `dist/migrations` (`scripts/copy-migrations.mjs`)
 * and this resolves them relative to this module's own directory. The same
 * omission already cost slice 1 a deploy, as `ERR_MODULE_NOT_FOUND: pg`.
 *
 * `import.meta.dirname` rather than `__dirname`: `api` is an ESM package, so
 * there is no `__dirname` to reach for.
 *
 * Both layouts are tried and a failure names both paths, because the symptom
 * otherwise is a missing-folder stack trace out of a deploy step that has
 * nothing else wrong with it.
 */
function resolveMigrationsFolder(): string {
  const candidates = [
    // Built: dist/db/migrate.js -> dist/migrations
    path.join(import.meta.dirname, "..", "migrations"),
    // Source: src/db/migrate.ts -> drizzle/migrations
    path.join(import.meta.dirname, "..", "..", "drizzle", "migrations"),
  ];
  const found = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, "meta", "_journal.json")),
  );
  if (!found) {
    throw new Error(
      "No migrations folder found. Looked for meta/_journal.json in:\n" +
        candidates.map((candidate) => `  ${candidate}`).join("\n") +
        "\nIf this is the built image, the build did not copy drizzle/migrations into dist/.",
    );
  }
  return found;
}

interface JournalEntry {
  tag: string;
  when: number;
  breakpoints: boolean;
}

/** drizzle-kit's own journal, read rather than reimplemented — `pnpm
 *  db:generate` writes it and this only consumes it. */
export function readJournal(
  folder = resolveMigrationsFolder(),
): JournalEntry[] {
  const journal = JSON.parse(
    fs.readFileSync(path.join(folder, "meta", "_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] };
  return journal.entries;
}

/** How many migrations this build carries. `/api/readyz` compares it against
 *  how many the database has applied, so a container serving against a schema
 *  nobody migrated says so instead of failing at the first query. */
export function bundledMigrationCount(): number {
  return readJournal().length;
}

/** The bookkeeping table, in `campus` rather than in a `drizzle` schema of its
 *  own, and in drizzle's exact shape so the two stay interchangeable. */
const MIGRATIONS_TABLE = `${campus.schemaName}."__drizzle_migrations"`;

/**
 * Every table campus owns, taken from the drizzle schema object rather than a
 * list kept by hand beside it. A table added to `db/schema/` gets its grant by
 * existing; a hand-kept list would be one nobody updates, and the symptom would
 * be a permission error on a feature that works everywhere it was tested.
 */
function ownedTables(): string[] {
  // Widened before filtering: the barrel's export union is types as well as
  // values, and a `value is PgTable` predicate over it does not typecheck.
  // `is()` narrows from there, so no cast is needed after it.
  return Object.values(schema as Record<string, unknown>)
    .filter((value) => is(value, PgTable))
    .map((value) => getTableConfig(value).name)
    .sort();
}

/**
 * **tic-campus applies its own migrations, and this is not preference.**
 *
 * `drizzle-orm`'s migrator opens with an unconditional
 * `CREATE SCHEMA IF NOT EXISTS <migrationsSchema>`, and `campus_owner` cannot
 * create a schema: tic-auth's `0005` grants it `USAGE` on `public`,
 * `REFERENCES` on four tables and authorship of `campus`, and `CREATE` on the
 * database nowhere. `IF NOT EXISTS` does not save it, because Postgres checks
 * the privilege BEFORE it checks existence.
 *
 * So `migrations: { schema: 'campus' }` in `drizzle.config.ts` is necessary and
 * not sufficient: it only changes which schema the migrator fails to create.
 * The alternative was asking tic-auth to grant `CREATE ON DATABASE`, which
 * would widen the grant matrix for the convenience of one library.
 *
 * What is reimplemented here is small and deliberately drizzle-shaped: the same
 * journal, the same `--> statement-breakpoint` split, the same
 * `(id, hash, created_at)` table, the same "apply everything newer than the
 * latest recorded `created_at`" rule. `drizzle-kit generate` is untouched, so
 * switching back costs deleting this function. MEV reached the same conclusion
 * first (`MEV/api/src/db/migrate.ts`); this is its shape with the parts campus
 * has no use for yet removed.
 */
export async function runMigrations(pool: Pool): Promise<void> {
  const folder = resolveMigrationsFolder();
  const entries = readJournal(folder);

  // Inside `campus`, which is the whole reason this works: `campus_owner` holds
  // CREATE there and only there.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);

  const { rows } = await pool.query<{ created_at: string | null }>(
    `SELECT created_at FROM ${MIGRATIONS_TABLE} ORDER BY created_at DESC LIMIT 1`,
  );
  const lastApplied =
    rows[0]?.created_at == null ? null : Number(rows[0].created_at);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const entry of entries) {
      if (lastApplied !== null && lastApplied >= entry.when) continue;
      const sql = fs.readFileSync(
        path.join(folder, `${entry.tag}.sql`),
        "utf8",
      );
      for (const statement of sql.split("--> statement-breakpoint")) {
        const trimmed = statement.trim();
        if (trimmed.length > 0) await client.query(trimmed);
      }
      // Hashed over the whole file exactly as drizzle does, and stored rather
      // than checked — also as drizzle does. It is provenance, not a guard.
      await client.query(
        `INSERT INTO ${MIGRATIONS_TABLE} ("hash", "created_at") VALUES ($1, $2)`,
        [crypto.createHash("sha256").update(sql).digest("hex"), entry.when],
      );
    }
    await grantRuntimeRole(client);
    await client.query("COMMIT");
  } catch (cause) {
    await client.query("ROLLBACK");
    throw cause;
  } finally {
    client.release();
  }
}

/**
 * Grants `campus_app` what it needs on campus's own tables.
 *
 * **Nothing else does this.** tic-auth's `0005` grants it exactly
 * `GRANT USAGE ON SCHEMA campus` and stops — correctly, since these tables do
 * not exist when `0005` runs. So the grant has to happen here, and it runs on
 * every migrate rather than inside a numbered migration: a table added later
 * gets its grant from existing, which is the point of deriving the list from
 * the schema object.
 *
 * The sequence grant is not decorative either, even though every primary key
 * here is a uuid: the first table that keys on `bigserial` would otherwise get
 * `permission denied for sequence ..._id_seq` on its first insert, in
 * production, having passed every test written before it.
 */
async function grantRuntimeRole(client: PoolClient): Promise<void> {
  // **Skipped where there is no two-role split to honour**, which is every
  // developer laptop: `campus_app` is a NOLOGIN group role created by tic-auth's
  // `0005`, so it exists in production and nowhere else. Skipped rather than
  // made optional with a flag: a flag would be a thing to set wrongly, and
  // `to_regrole` asks the database the question directly.
  const { rows } = await client.query<{ present: boolean }>(
    "SELECT to_regrole('campus_app') IS NOT NULL AS present",
  );
  if (!rows[0]?.present) {
    console.log(
      "campus_app does not exist here; skipping the runtime grants (local development).",
    );
    return;
  }

  for (const table of ownedTables()) {
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${campus.schemaName}."${table}" TO campus_app`,
    );
  }
  await client.query(
    `GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${campus.schemaName} TO campus_app`,
  );
  // `/api/readyz`'s migration count reads this as the runtime role.
  await client.query(`GRANT SELECT ON ${MIGRATIONS_TABLE} TO campus_app`);
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("falta DATABASE_URL — mirá el target `migrate` del Makefile");
    process.exit(1);
  }
  // Its own pool, not `createPool()`: the owner's password arrives as
  // PGPASSWORD, which libpq and node-postgres both read, rather than from the
  // secret file mounted for `campus_svc`.
  const pool = new Pool({ connectionString: url });
  try {
    await runMigrations(pool);
    console.log("migrations applied");
  } catch (cause) {
    // The one thing a laptop is missing, named rather than left as a driver
    // error about an object nobody wrote. It is not creatable from here in
    // production — tic-auth's `0005` owns the schema and `campus_owner` holds
    // no CREATE on the database — so this is guidance, never a fallback.
    if (
      cause instanceof Error &&
      /schema "campus" does not exist/i.test(cause.message)
    ) {
      console.error(
        "The `campus` schema does not exist. In production tic-auth's",
      );
      console.error(
        "migration 0005 creates it; on a laptop, create it once by hand:",
      );
      console.error("  psql \"$DATABASE_URL\" -c 'CREATE SCHEMA campus'");
      process.exit(1);
    }
    throw cause;
  } finally {
    await pool.end();
  }
}

/**
 * Run as a script (`make migrate`) but NOT when imported — `/api/readyz`
 * imports `bundledMigrationCount` from here and does not want a migration to
 * start.
 *
 * `require.main === module` was the CommonJS spelling and it does not survive
 * ESM: `require` is not defined, so importing this module would throw before
 * any caller saw it.
 */
if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === import.meta.filename
) {
  void main().catch((cause: unknown) => {
    console.error(cause);
    process.exit(1);
  });
}
