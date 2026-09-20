import { boolean, integer, pgSchema, pgTable, text } from "drizzle-orm/pg-core";

/**
 * tic-auth's half of the database, declared so campus can reference it and read
 * it (F31, Group J). **Nothing here is ours**, nothing here is created by a
 * campus migration, and `drizzle.config.ts`'s `schemaFilter: ['campus']` is
 * what keeps `pnpm db:generate` from trying.
 *
 * **The file has two halves because a view cannot be a foreign-key target.**
 * That single fact is why the four roles exist:
 *
 * ```sql
 * GRANT SELECT     ON directory.subject TO campus_app;  -- reads
 * GRANT REFERENCES ON public.subject    TO campus;      -- migrations
 * ```
 *
 * `REFERENCES` is a distinct privilege and **does not imply `SELECT`**. The
 * runtime role holds nothing at all on the base tables below and its inserts
 * are still checked against them, because the referential check belongs to the
 * system rather than to the caller. So constraints name `public.*` and every
 * read names `directory.*`, and mixing the two up produces a permission error
 * blaming the wrong half.
 */

/* ── Foreign-key targets: `public.*`, referenced and never selected ────────── */

/**
 * Two of the four tables `tic-auth/tic_auth/settings_db.py`'s
 * `REFERENCEABLE_TABLES` grants `campus` `REFERENCES` on. `public.course` and
 * `public.offering` are on that list and deliberately absent here: nothing in
 * the article library points at them, and a declaration nothing points at reads
 * as a dependency that does not exist.
 *
 * Widening the list itself is a negotiation, not a change here — a table added
 * to it is a table tic-auth may then never drop, so it is argued in the open
 * (`tic-auth/docs/CONSISTENCY.md`). `public.subject` was the fourth, added in
 * tic-auth's `0016`.
 *
 * Only `id` is declared. A wider declaration would read like something campus
 * may select, and it may not: `has_table_privilege('campus_svc',
 * 'public."user"', 'SELECT')` is false.
 *
 * The ids are **`integer`**, because tic-auth's are (`0001`): its `user.id` is
 * what teacher-owned spreadsheets key on, so the whole directory stayed on
 * preserved integers rather than moving to uuids. Ours are uuids (F36) and the
 * two do not meet — Postgres refuses an int↔uuid foreign key outright, which is
 * the cheap way to find out you declared the wrong one.
 *
 * **`pgTable`, not `pgSchema('public')`**, which drizzle refuses outright:
 * *"You can't specify 'public' as schema name. Postgres is using public schema
 * by default."* So these read as unqualified tables, and what keeps
 * `pnpm db:generate` from emitting a `CREATE TABLE` for them is
 * `schemaFilter: ['campus']` — the foreign keys still resolve, because
 * drizzle-kit takes a constraint's target from the referenced column's own
 * table rather than from the set it is generating.
 */
export const directoryUserTable = pgTable("user", {
  id: integer("id").primaryKey(),
});

/** The abstract subject, which the library belongs to (F8). Distinct from
 *  `directorySubject` below, and the distinction is the whole reason both
 *  exist: this one is pointed at and never read, that one is read and never
 *  pointed at. */
export const directorySubjectTable = pgTable("subject", {
  id: integer("id").primaryKey(),
});

/* ── Read surface: `directory.*`, selected and never referenced ────────────── */

const directory = pgSchema("directory");

/**
 * Declared in full, because the grant is table-wide: tic-auth's `0005` narrows
 * only the views carrying a `dni`, and campus is a full reader. A partial
 * declaration would imply a restriction that does not exist and would mislead
 * whoever next widens it.
 *
 * `marks` is upstream's own flag for whether the subject is graded. Nothing
 * reads it yet; it is declared because the view publishes it.
 */
export const directorySubject = directory
  .view("subject", {
    id: integer("id").notNull(),
    name: text("name").notNull(),
    specialty: text("specialty"),
    marks: boolean("marks").notNull(),
  })
  .existing();
