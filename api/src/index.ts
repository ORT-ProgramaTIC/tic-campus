import { createServer } from "node:http";
import { count } from "drizzle-orm";
import { loadConfig } from "./config.js";
import { createDb, createPool } from "./db/client.js";
import { bundledMigrationCount } from "./db/migrate.js";
import { campus } from "./db/schema/_schema.js";
import { directorySubject } from "./db/schema/directory.js";

const config = loadConfig();
const pool = createPool(config);
const db = createDb(pool);

// How many migrations this build carries. Read once: it is a property of the
// build, not of the request, and it comes off the filesystem.
const carried = bundledMigrationCount();

/**
 * Can this process reach the database as `campus_svc`, and does the directory
 * contract answer?
 *
 * `directory.subject` rather than `select 1`: the connection proves the
 * password, and only a read of a view proves the grants — USAGE on the schema
 * plus SELECT on the view, which are granted separately and forgotten
 * separately (tic-auth `0005`). It deliberately does NOT touch `public.*`:
 * campus holds `REFERENCES` there and no SELECT at all, so a read would fail,
 * correctly.
 */
async function directoryReadable(): Promise<{ ok: boolean; detail: string }> {
  try {
    const rows = await db.select({ n: count() }).from(directorySubject);
    return { ok: true, detail: `directory.subject: ${rows[0]?.n ?? 0}` };
  } catch (cause) {
    return {
      ok: false,
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/**
 * Is the database's schema the one this build was written against?
 *
 * Boot does not migrate and cannot — the container connects as `campus_svc`,
 * which holds CREATE nowhere — so a container serving against a schema older
 * than its own code is a state that exists: `make migrate` is a step an
 * operator can skip or watch fail. Without this check its first symptom is a
 * 500 from whichever route happens to touch the missing table, attributed to
 * that route.
 *
 * Counted rather than compared by hash: what an operator needs to know is
 * whether `make migrate` has been run against this build. A missing table
 * answers the same question by throwing, which is why the read is not guarded
 * beyond the catch.
 */
async function schemaCurrent(): Promise<{
  ok: boolean;
  applied: number | null;
  carried: number;
  detail?: string;
}> {
  try {
    const { rows } = await pool.query<{ applied: number }>(
      `select count(*)::int as applied from ${campus.schemaName}."__drizzle_migrations"`,
    );
    const applied = rows[0]?.applied ?? 0;
    return { ok: applied === carried, applied, carried };
  } catch (cause) {
    return {
      ok: false,
      applied: null,
      carried,
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

const server = createServer((req, res) => {
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  // Liveness, and deliberately database-free: the healthcheck restarts this
  // container, and restarting it does not fix a database that is down.
  if (req.url === "/api/health") return json(200, { status: "ok" });
  if (req.url === "/api/readyz") {
    // Both facts, each under its own key, because they fail for different
    // reasons and are fixed by different people: `db` is tic-platform's
    // database and this stack's secrets, `migrations` is `make migrate`.
    // `bin/doctor.py` reads one key each, so a stale schema does not get
    // reported as an unreachable database.
    void Promise.all([directoryReadable(), schemaCurrent()]).then(
      ([db, migrations]) => {
        const ok = db.ok && migrations.ok;
        json(ok ? 200 : 503, {
          status: ok ? "ok" : "error",
          db,
          migrations,
        });
      },
    );
    return;
  }
  res.writeHead(404).end();
});

server.listen(config.port, () =>
  console.log(`tic-campus-api on :${config.port}`),
);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => void pool.end().then(() => process.exit(0)));
  });
}
