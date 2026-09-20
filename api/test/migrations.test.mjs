import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { readJournal } from "../dist/db/migrate.js";

// Properties of the committed SQL, asserted with no database. What a real
// Postgres proves is in the throwaway harness the deploy notes describe; what
// this catches is a regeneration that quietly changed one of the three things
// the grant matrix depends on — none of which a typecheck or a build notices.
const FOLDER = path.join(import.meta.dirname, "..", "drizzle", "migrations");
const MIGRATIONS = readJournal(FOLDER).map((entry) => ({
  tag: entry.tag,
  sql: readFileSync(path.join(FOLDER, `${entry.tag}.sql`), "utf8"),
}));

test("there is at least one migration to check", () => {
  assert.ok(MIGRATIONS.length > 0);
});

test("creates nothing outside the campus schema", () => {
  for (const { tag, sql } of MIGRATIONS) {
    for (const statement of sql.matchAll(/CREATE (?:TABLE|VIEW)[^(]*/g)) {
      assert.ok(
        statement[0].includes('"campus".'),
        `${tag}: ${statement[0].trim()} — campus_owner holds CREATE in "campus" and nowhere else`,
      );
    }
  }
});

test("does not try to create a schema", () => {
  // tic-auth's 0005 already created `campus` AUTHORIZATION campus, and
  // campus_owner may not create another: Postgres checks the privilege before
  // it checks existence, so even IF NOT EXISTS is refused. drizzle-kit 0.31.10
  // emits none; this guards its return on a dependency bump.
  for (const { tag, sql } of MIGRATIONS) {
    assert.doesNotMatch(sql, /CREATE SCHEMA/i, `${tag} creates a schema`);
  }
});

test("points its cross-schema foreign keys at referenceable tables only", () => {
  // tic-auth grants `campus` REFERENCES on public."user", course, offering and
  // subject, and on nothing else. A fifth is a negotiation with tic-auth, not a
  // change here — and the symptom of skipping it is `permission denied for
  // table <x>` during a deploy's migrate, which reads like a bug in campus.
  const REFERENCEABLE = new Set(["user", "course", "offering", "subject"]);
  const crossing = MIGRATIONS.flatMap(({ sql }) => [
    ...sql.matchAll(/REFERENCES "public"\."([^"]+)"/g),
  ]).map((match) => match[1]);

  assert.ok(
    crossing.length > 0,
    "no foreign key leaves the campus schema any more",
  );
  for (const table of crossing) {
    assert.ok(
      REFERENCEABLE.has(table),
      `public."${table}" is not referenceable`,
    );
  }
});
