import { count } from "drizzle-orm";
import express, { type RequestHandler } from "express";
import { createRemoteKeySource } from "./auth/jwks.js";
import { createRenewer } from "./auth/refresh.js";
import { createSessionStore } from "./auth/session-store.js";
import { createTokenClient } from "./auth/token-client.js";
import { createVerifier } from "./auth/verify.js";
import { loadConfig } from "./config.js";
import { createDb, createPool } from "./db/client.js";
import { bundledMigrationCount } from "./db/migrate.js";
import { campus } from "./db/schema/_schema.js";
import { directorySubject } from "./db/schema/directory.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { optionalSession, requireSession } from "./middleware/session.js";
import { createAdminOfferingRoutes } from "./routes/admin-offerings.js";
import { createAuthRoutes, createMeRoute } from "./routes/auth.js";
import { createOfferingRoutes } from "./routes/offerings.js";

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

const app = express();

// Liveness, and deliberately database-free: the healthcheck restarts this
// container, and restarting it does not fix a database that is down.
app.get("/api/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/api/readyz", (_req, res, next) => {
  // Both facts, each under its own key, because they fail for different reasons
  // and are fixed by different people: `db` is tic-platform's database and this
  // stack's secrets, `migrations` is `make migrate`. `bin/doctor.py` reads one
  // key each, so a stale schema does not get reported as an unreachable
  // database. tic-auth is deliberately NOT a third key — see `auth/jwks.ts`.
  void Promise.all([directoryReadable(), schemaCurrent()])
    .then(([db, migrations]) => {
      const ok = db.ok && migrations.ok;
      res.status(ok ? 200 : 503).json({
        status: ok ? "ok" : "error",
        db,
        migrations,
      });
    })
    .catch(next);
});

/**
 * The login, mounted **only when there is a client secret to log in with**.
 *
 * Unconfigured, the four routes simply do not exist and Express answers 404 —
 * not 401 and not 503, either of which advertises a login that cannot complete
 * and invites a client to keep trying it (`CLIENTS.md` §8). In production there
 * is no such state: `loadConfig` refuses to return without the secret.
 */
/**
 * With no login configured there are no sessions to read, so the two guards
 * below stand in for the real ones: a route that needs a session answers the
 * same 401 it would with one, and a route that merely *offers* one carries on
 * with nobody signed in. The alternative — mounting the public offering routes
 * only when a client secret exists — would make campus's content disappear
 * because its login is misconfigured, which is exactly backwards (F4).
 */
let guard: RequestHandler = (_req, res) => {
  res
    .status(401)
    .json({ error: { code: "no_session", message: "No iniciaste sesión." } });
};
let maybeSession: RequestHandler = (_req, _res, next) => next();

if (config.auth) {
  const store = createSessionStore(db);
  const verify = createVerifier({
    issuer: config.auth.issuer,
    audience: config.auth.audience,
    keySource: createRemoteKeySource({
      url: config.auth.jwksUrl,
      hostHeader: config.auth.jwksHostHeader,
    }),
  });
  const tokens = createTokenClient(config.auth);
  const renewer = createRenewer({
    config: config.auth,
    store,
    tokens,
    verify,
  });
  // One guard, built once and shared: it carries the freshness rule and the CSRF
  // check, and two of them would be two chances to mount a route with only one.
  guard = requireSession({ config, store, renewer });
  maybeSession = optionalSession({ config, store, renewer });

  app.use(
    "/api/auth",
    createAuthRoutes(config, config.auth, guard, { store, verify, tokens }),
  );
  app.get("/api/me", guard, createMeRoute(config.auth));
}

// Public (F4), so mounted whatever the login's state. The two guards go in
// together because one route inside needs a session and one merely offers it —
// applying `maybeSession` to the whole router instead would read and renew the
// session twice for `/mine`.
app.use("/api/offerings", createOfferingRoutes(db, { guard, maybeSession }));
app.use("/api/admin/offerings", createAdminOfferingRoutes(db, guard));

// Last, and in this order: anything that reached here matched no route, and
// anything thrown by one of them lands in the handler.
app.use(notFound);
app.use(errorHandler);

const server = app.listen(config.port, () =>
  console.log(`tic-campus-api on :${config.port}`),
);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => void pool.end().then(() => process.exit(0)));
  });
}
