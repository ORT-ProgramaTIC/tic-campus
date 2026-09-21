// An ad-hoc HTTP pass over slice 15 (F30): the bell. It is not part of `pnpm
// test`; `notifications.test.mjs` pins the body checker and `make test-db`
// the three derivations and the receipts. This proves the **wire**: the bell is
// behind the session, marking read is a write and so needs the CSRF token, and
// a teacher's `notify` travels through the existing `PUT` of a use — on when
// sent, and off again when a whole-row save leaves it out.
//
// Run it from inside `api/` (the workspace's node_modules is not visible from
// outside), with docker available:
//
//     node scripts/harness-notifications.mjs
//
// Four things that cost real time if you get them wrong, all inherited:
//   - the api is spawned AFTER the migrate and the seed, or its pool points at
//     a database with no schema and the symptom is ECONNREFUSED;
//   - a fresh container every run — `applyDirectoryStandins` is not idempotent
//     and `applyCampusRoles` creates cluster-wide roles;
//   - wait on a real `select 1`, never on `pg_isready`, which answers during
//     postgres's init from a temporary server that is then shut down;
//   - the error envelope is `{ error: { code, message } }`.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { runMigrations } from "../dist/db/migrate.js";
import {
  applyCampusRoles,
  applyDirectoryStandins,
  HARNESS_PASSWORD,
  urlFor,
} from "../test/support/directory/apply.mjs";

const CONTAINER = "tic-campus-harness-notifications";
// 55432 is `tic-ai-postgres`'s on this machine; docker's "port is already
// allocated" only shows up if `sh` is checked, which `run` below does.
const PORT = 55444;
const API_PORT = 3010;
const BASE = `postgresql://postgres:${HARNESS_PASSWORD}@127.0.0.1:${PORT}/tic_auth`;
const API = `http://127.0.0.1:${API_PORT}`;

const sh = (...args) => spawnSync(args[0], args.slice(1), { encoding: "utf8" });
/** The same, but a failure is the failure rather than a 30-second wait and a
 *  `28P01` against whatever else happens to hold the port. */
const run = (...args) => {
  const out = sh(...args);
  if (out.status !== 0) {
    throw new Error(`${args.join(" ")}\n${out.stderr || out.stdout}`);
  }
  return out;
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

let api;
try {
  await main();
  console.log("\n✅  todo bien");
} finally {
  if (api) api.kill("SIGKILL");
  sh("docker", "rm", "-f", CONTAINER);
}

async function main() {
  sh("docker", "rm", "-f", CONTAINER);
  run(
    "docker",
    "run",
    "-d",
    "--rm",
    "--name",
    CONTAINER,
    "-e",
    `POSTGRES_PASSWORD=${HARNESS_PASSWORD}`,
    "-e",
    "POSTGRES_DB=tic_auth",
    "-p",
    `127.0.0.1:${PORT}:5432`,
    "postgres:17",
  );
  // A real query, not `pg_isready`: postgres answers that from the temporary
  // server it runs during init and then shuts down, and a client that connects
  // into the gap dies with `Connection terminated unexpectedly`.
  for (let at = 0; at < 60; at += 1) {
    const out = sh(
      "docker",
      "exec",
      CONTAINER,
      "psql",
      "-U",
      "postgres",
      "-d",
      "tic_auth",
      "-tAc",
      "select 1",
    );
    if (out.stdout?.trim() === "1") break;
    await sleep(500);
  }

  const root = new Pool({ connectionString: BASE });
  const owner = new Pool({ connectionString: urlFor(BASE, "campus_owner") });
  await applyDirectoryStandins(root);
  await applyCampusRoles(root);
  await runMigrations(owner);
  const ids = await seed(root);

  // The session rows, straight into `campus.session` — the four-step login is
  // `README.md` § "Off the box" and is not what this is testing.
  const login = async (userId, roles) => {
    const secret = randomUUID();
    const csrf = randomUUID();
    await root.query(
      `insert into campus.session (id, user_id, claims, claims_at, expires_at, csrf)
       values ($1, $2, $3, now(), now() + interval '1 hour', $4)`,
      [
        createHash("sha256").update(secret).digest("hex"),
        userId,
        JSON.stringify({
          roles,
          email: null,
          name: null,
          givenName: null,
          familyName: null,
          acr: "strong",
          amr: [],
        }),
        csrf,
      ],
    );
    return { secret, csrf };
  };
  const teacher = await login(ids.teacher, ["teacher"]);
  const student = await login(ids.student, ["student"]);

  const secretFile = join(tmpdir(), "harness-notifications-secret");
  writeFileSync(secretFile, "anything");
  api = spawn("node", ["dist/index.js"], {
    stdio: "inherit",
    // `api/`, not wherever this was invoked from: `dist/index.js` is relative
    // and the symptom of getting it wrong is MODULE_NOT_FOUND followed by
    // ECONNREFUSED, which reads like a port problem.
    cwd: join(import.meta.dirname, ".."),
    env: {
      ...process.env,
      PORT: String(API_PORT),
      DATABASE_URL: urlFor(BASE, "campus_svc"),
      // Without BOTH of these `config.auth` stays unset, `guard` degrades to a
      // 401 stub, and every authenticated route answers `no_session` no matter
      // what cookie is sent.
      TIC_AUTH_CLIENT_SECRET_FILE: secretFile,
      TIC_AUTH_REDIRECT_URI: `${API}/api/auth/callback`,
      UPLOADS_DIR: join(tmpdir(), "harness-notifications-uploads"),
    },
  });
  for (let at = 0; at < 60; at += 1) {
    try {
      if ((await fetch(`${API}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }

  const call = async (who, method, path, body) => {
    const res = await fetch(API + path, {
      method,
      headers: {
        "content-type": "application/json",
        Cookie: `tic_campus_session_dev=${who.secret}`,
        "X-CSRF-Token": who.csrf,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  /** The envelope is `{ error: { code, message } }`, never `{ error: code }`. */
  const code = (res) => res.body?.error?.code;

  const home = `/api/homes/${ids.current}`;
  const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString();
  const use = (extra) =>
    call(teacher, "PUT", `${home}/articles/${ids.articleId}`, {
      programUnitId: null,
      position: 0,
      publishedAt: YESTERDAY,
      ...extra,
    });

  /* ── Behind the session, and empty until something happens ─────────── */

  const anonymous = await fetch(`${API}/api/notifications`);
  assert.equal(anonymous.status, 401);
  const empty = await call(student, "GET", "/api/notifications");
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  assert.deepEqual(empty.body, { unread: 0, items: [] });

  /* ── A published article reaches the bell only when the teacher asks ──── */

  const quiet = await use({});
  assert.equal(quiet.status, 200, JSON.stringify(quiet.body));
  assert.deepEqual(
    (await call(student, "GET", "/api/notifications")).body.items,
    [],
    "notify is off unless sent",
  );

  const loud = await use({ notify: true });
  assert.equal(loud.status, 200, JSON.stringify(loud.body));
  const bell = await call(student, "GET", "/api/notifications");
  assert.equal(bell.body.unread, 1, JSON.stringify(bell.body));
  const [item] = bell.body.items;
  assert.equal(item.kind, "article_published");
  assert.equal(item.slug, "tp-sql");
  assert.equal(item.offeringId, ids.current);
  assert.equal(item.read, false);
  assert.equal(
    (await call(teacher, "GET", "/api/notifications")).body.unread,
    0,
    "the teacher is in no class",
  );

  /* ── Marking read is a write ──────────────────────────────────────────── */

  const read = { items: [{ kind: item.kind, target: item.target }] };
  const forged = await fetch(`${API}/api/notifications/read`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Cookie: `tic_campus_session_dev=${student.secret}`,
    },
    body: JSON.stringify(read),
  });
  assert.equal(forged.status, 403);
  assert.equal((await forged.json()).error.code, "csrf_failed");

  const junk = await call(student, "POST", "/api/notifications/read", {
    items: [{ kind: "due_soon", target: item.target }],
  });
  assert.equal(junk.status, 400);
  assert.equal(code(junk), "invalid_body");

  const marked = await call(student, "POST", "/api/notifications/read", read);
  assert.equal(marked.status, 204);
  const after = await call(student, "GET", "/api/notifications");
  assert.equal(after.body.unread, 0);
  assert.equal(after.body.items[0].read, true);

  /* ── A whole-row save that leaves `notify` out turns it off ───────────── */

  await use({});
  assert.deepEqual(
    (await call(student, "GET", "/api/notifications")).body.items,
    [],
  );

  await Promise.all([root.end(), owner.end()]);
}

async function seed(root) {
  const one = async (sql, values) => (await root.query(sql, values)).rows[0];
  const { yearId, termId } = await (async () => {
    const row = await one(
      `insert into academic_year (year, starts_on, ends_on, is_current)
       values (2027, '2027-03-01', '2027-12-15', true) returning id`,
    );
    const term = await one(
      `insert into term (academic_year_id, kind, starts_on, ends_on)
       values ($1, 'full', '2027-03-01', '2027-12-15') returning id`,
      [row.id],
    );
    return { yearId: row.id, termId: term.id };
  })();
  const subject = await one(
    `insert into subject (name, marks) values ('Bases de Datos', true) returning id`,
  );
  const user = async (email, name, surname) =>
    (
      await one(
        `insert into "user" (email, name, surname) values ($1, $2, $3) returning id`,
        [email, name, surname],
      )
    ).id;
  const teacher = await user("profe@ort.edu.ar", "Ana", "Docente");
  const student = await user("alu@ort.edu.ar", "Cami", "Alumne");
  const admin = await user("admin@ort.edu.ar", "Eve", "Admin");
  const course = await one(
    `insert into course (name, specialty, academic_year_id)
     values ('NR5A', 'Informática', $1) returning id`,
    [yearId],
  );
  const { id: current } = await one(
    `insert into offering (subject_id, term_id, kind, name)
     values ($1, $2, 'mandatory', null) returning id`,
    [subject.id, termId],
  );
  await root.query(
    `insert into offering_course (offering_id, course_id) values ($1, $2)`,
    [current, course.id],
  );
  await root.query(
    `insert into teacher_offering (teacher_id, offering_id) values ($1, $2)`,
    [teacher, current],
  );
  await root.query(
    `insert into student_course (student_id, course_id) values ($1, $2)`,
    [student, course.id],
  );
  // Activated, and one published library article to use (F34, F8).
  const { activate } = await import("../dist/offerings/activation.js");
  const { createArticle, publishArticle, saveDraft } =
    await import("../dist/library/articles.js");
  const { createDb } = await import("../dist/db/client.js");
  const svc = new Pool({ connectionString: urlFor(BASE, "campus_svc") });
  const db = createDb(svc);
  await activate(db, current, admin);
  const { id: articleId } = await createArticle(
    db,
    subject.id,
    "tp-sql",
    "TP SQL",
  );
  await saveDraft(db, subject.id, "tp-sql", teacher, "# TP", null);
  await publishArticle(db, subject.id, "tp-sql");
  await svc.end();
  return { current, teacher, student, admin, articleId };
}
