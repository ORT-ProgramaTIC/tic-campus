import { defineConfig } from "drizzle-kit";

/**
 * `schemaFilter: ['campus']` is what makes `src/db/schema/directory.ts` safe to
 * import. That file declares tic-auth's `public.*` base tables so campus's
 * columns can reference them, and its `directory.*` views so routes can read
 * them — none of which campus creates, and all of which drizzle-kit would
 * otherwise try to generate a `CREATE` for. The filter narrows what drizzle-kit
 * *owns* without narrowing what it can point a foreign key at. The views
 * additionally carry `.existing()`.
 *
 * It is necessary and **not sufficient**: anything re-exported from the barrel
 * gets a `CREATE TABLE` regardless of the filter, which is why `directory.ts`
 * is kept out of `schema/index.ts` and imported directly.
 *
 * `migrations.schema` keeps the bookkeeping table inside `campus` rather than
 * in a `drizzle` schema of its own, because `campus_owner` cannot create a
 * schema — see the long note in `src/db/migrate.ts` about why that is necessary
 * and not sufficient either.
 *
 * drizzle-kit 0.31.10 emits no `CREATE SCHEMA` of its own, so there is nothing
 * to strip by hand after a generate. `test/migrations.test.mjs` guards its
 * *return* on a dependency bump: tic-auth's `0005` already created `campus`
 * `AUTHORIZATION campus`, and `campus_owner` may not create another, so a
 * generate that started emitting one would produce a migration that cannot
 * apply.
 *
 * What *is* done by hand is the name: `drizzle-kit generate` takes no `--name`,
 * so the emitted `NNNN_two_random_words.sql` is renamed, along with its `tag`
 * in `meta/_journal.json`. The snapshot is keyed by index and needs no rename.
 */
export default defineConfig({
  // The BARREL, not the directory. Pointing at the directory makes drizzle-kit
  // import every file AND `index.ts`, so each view is collected twice and it
  // exits with "We've found duplicated view name" — views are keyed by
  // `schema.name` with no identity check, unlike tables. Naming the barrel is
  // also the more accurate spelling: it is the same object `db/client.ts`
  // passes to `drizzle()`, so what gets generated and what the ORM knows about
  // cannot drift.
  schema: "./src/db/schema/index.ts",
  out: "./drizzle/migrations",
  dialect: "postgresql",
  schemaFilter: ["campus"],
  migrations: { schema: "campus" },
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
