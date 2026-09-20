import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Standing tic-auth up in a throwaway Postgres, so campus's queries can be run
 * against the shape they will meet in production.
 *
 * Two halves, and they fail for different reasons:
 *
 *  1. **The schema** — `standins.generated.sql`, read from the committed file
 *     and never regenerated here. Regenerating needs Python and a tic-auth
 *     checkout, and `make test-db` must work without either;
 *     `pnpm db:stubs:check` is what proves the file still matches upstream.
 *  2. **The privilege shape** — the campus half of tic-auth's `0005`, plus the
 *     two LOGIN roles an operator creates by hand at install time (F31).
 *
 * The second half is a second spelling of somebody else's migration, which is a
 * real cost, and it is worth paying because it is what moves three failures off
 * the box:
 *
 *  - `campus_owner` holds `CREATE` inside `campus` and nowhere else, so a
 *    migration that lands a table in `public` — or a drizzle-kit that starts
 *    emitting `CREATE SCHEMA` again — fails here rather than on deploy day;
 *  - nothing grants `campus_app` DML on campus's own tables except
 *    `db/migrate.ts`'s `grantRuntimeRole`, whose `to_regrole('campus_app')`
 *    branch is otherwise never taken by any test;
 *  - a `directory.*` read that campus forgot to declare a grant for fails as
 *    `permission denied` rather than passing as the superuser it was written by.
 */

const STANDINS = path.join(import.meta.dirname, "standins.generated.sql");

/** Test-only and deliberately boring. In production both come from
 *  `openssl rand -hex 32` into a root-owned 0600 file (`.env.example`). */
export const HARNESS_PASSWORD = "harness-only-not-a-secret";

export async function applyDirectoryStandins(pool) {
  await pool.query(readFileSync(STANDINS, "utf8"));
}

/**
 * The four roles of F31, in tic-auth's own shape: two NOLOGIN group roles it
 * creates in `0005`, and the two LOGIN members an operator adds at install time.
 *
 * `campus` owns the schema and holds `REFERENCES`; `campus_app` holds the
 * directory reads and, from the first migration on, the DML. Neither logs in.
 * `campus_owner` runs migrations, `campus_svc` serves requests, and the whole
 * point is that the second holds no `CREATE` anywhere.
 */
export async function applyCampusRoles(pool) {
  await pool.query(`
    CREATE ROLE campus NOLOGIN;
    CREATE ROLE campus_app NOLOGIN;
    CREATE ROLE campus_owner LOGIN PASSWORD '${HARNESS_PASSWORD}' IN ROLE campus;
    CREATE ROLE campus_svc   LOGIN PASSWORD '${HARNESS_PASSWORD}' IN ROLE campus_app;

    GRANT USAGE ON SCHEMA public TO campus, campus_app;
    CREATE SCHEMA campus AUTHORIZATION campus;
    GRANT USAGE ON SCHEMA campus TO campus_app;

    -- REFERENCES to the OWNER and never to the runtime role: adding a
    -- constraint is a migration. campus_app ends up holding nothing at all on
    -- these tables while its inserts are still checked against them.
    GRANT REFERENCES ON public."user" TO campus;
    GRANT REFERENCES ON public.course TO campus;
    GRANT REFERENCES ON public.offering TO campus;
    GRANT REFERENCES ON public.subject TO campus;

    -- The grant that gets forgotten. Without USAGE the SELECTs below are inert,
    -- and the error names the schema rather than the missing privilege.
    GRANT USAGE ON SCHEMA directory TO campus_app;
    GRANT SELECT ON directory."user" TO campus_app;
    GRANT SELECT ON directory.course TO campus_app;
    GRANT SELECT ON directory.subject TO campus_app;
    GRANT SELECT ON directory.offering TO campus_app;
    GRANT SELECT ON directory.offering_course TO campus_app;
    GRANT SELECT ON directory.teacher_offering TO campus_app;
    GRANT SELECT ON directory.enrollment TO campus_app;
  `);
}

/** The same URL as a different role — `campus_owner` migrates, `campus_svc`
 *  serves, and a test that used one for both would prove neither. */
export function urlFor(base, role) {
  const url = new URL(base);
  url.username = role;
  url.password = HARNESS_PASSWORD;
  return url.toString();
}
