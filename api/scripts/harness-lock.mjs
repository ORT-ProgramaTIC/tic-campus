// An ad-hoc HTTP pass over slice 14 (F35): a past year's marks lock on F42's
// date, an admin reopens one offering for a late fix, and closes it again. It
// is not part of `pnpm test`; the unit tests pin the date arithmetic and `make
// test-db` the unlock round trip. This proves the **wire**: which writes a
// lock refuses (a `409 locked`, teacher's and student's), which it leaves
// alone (the home, every read), and that the grid says `locked` so a screen
// can go read-only before anybody types into it.
//
// Run it from inside `api/` (the workspace's node_modules is not visible from
// outside), with docker available:
//
//     node scripts/harness-lock.mjs
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

const CONTAINER = "tic-campus-harness-lock";
// 55432 is `tic-ai-postgres`'s on this machine; docker's "port is already
// allocated" only shows up if `sh` is checked, which `run` below does.
const PORT = 55443;
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

  const secretFile = join(tmpdir(), "harness-lock-secret");
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
      UPLOADS_DIR: join(tmpdir(), "harness-lock-uploads"),
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

  const admin = await login(ids.admin, ["admin"]);
  const home = `/api/homes/${ids.past}`;
  const unlock = `/api/admin/offerings/${ids.past}/unlock`;
  const marks = { entries: [] };

  /* ── 2025 is over: the marks are closed, to the teacher and the student ─ */

  const results = await call(teacher, "PUT", `${home}/results`, marks);
  assert.equal(results.status, 409, JSON.stringify(results.body));
  assert.equal(code(results), "locked");
  for (const [path, body] of [
    ["official-grades", { entries: [] }],
    ["gradebook", { groups: [], terms: [], scales: [] }],
  ]) {
    const res = await call(teacher, "PUT", `${home}/${path}`, body);
    assert.equal(res.status, 409, `${path}: ${JSON.stringify(res.body)}`);
  }
  const asked = await call(student, "POST", `${home}/revisions`, {});
  assert.equal(asked.status, 409, JSON.stringify(asked.body));
  assert.equal(code(asked), "locked");

  // Reads stay open, and say so.
  const grid = await call(teacher, "GET", `${home}/gradebook`);
  assert.equal(grid.status, 200, JSON.stringify(grid.body));
  assert.equal(grid.body.locked, true);
  const mine = await call(student, "GET", `${home}/results/mine`);
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal(mine.body.locked, true);

  // Marks only: the home is still the teacher's.
  const config = await call(teacher, "PUT", `${home}/home`, {
    sections: ["program"],
    links: [],
  });
  assert.equal(config.status, 200, JSON.stringify(config.body));

  /* ── An admin reopens it for a late fix, and closes it again ──────────── */

  const byTeacher = await call(teacher, "POST", unlock);
  assert.equal(byTeacher.status, 403, "desbloquear es de un admin");

  const opened = await call(admin, "POST", unlock);
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.deepEqual(opened.body, {
    offeringId: ids.past,
    unlocked: true,
    changed: true,
  });
  assert.equal((await call(admin, "POST", unlock)).body.changed, false);

  const fixed = await call(teacher, "PUT", `${home}/results`, marks);
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  assert.equal(
    (await call(teacher, "GET", `${home}/gradebook`)).body.locked,
    false,
  );

  const closed = await call(admin, "DELETE", unlock);
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.unlocked, false);
  assert.equal(
    (await call(teacher, "PUT", `${home}/results`, marks)).status,
    409,
  );

  // The current year is not locked by any of this.
  const current = await call(
    teacher,
    "PUT",
    `/api/homes/${ids.current}/results`,
    marks,
  );
  assert.equal(current.status, 200, JSON.stringify(current.body));

  // Not activated is nothing to unlock.
  const nowhere = await call(
    admin,
    "POST",
    `/api/admin/offerings/999999/unlock`,
  );
  assert.equal(nowhere.status, 404);

  await Promise.all([root.end(), owner.end()]);
}

async function seed(root) {
  const one = async (sql, values) => (await root.query(sql, values)).rows[0];
  // 2025, not 2026: the lock reads the real clock, and 2026 only closes on
  // 1 January 2027.
  const year = async (y, current) => {
    const row = await one(
      `insert into academic_year (year, starts_on, ends_on, is_current)
       values ($1, $2, $3, $4) returning id`,
      [y, `${y}-03-01`, `${y}-12-15`, current],
    );
    const term = await one(
      `insert into term (academic_year_id, kind, starts_on, ends_on)
       values ($1, 'full', $2, $3) returning id`,
      [row.id, `${y}-03-01`, `${y}-12-15`],
    );
    return { yearId: row.id, termId: term.id };
  };
  const y2027 = await year(2027, true);
  const y2025 = await year(2025, false);
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
  // One offering per year, the same teacher and — for 2025 — the same student,
  // so every refusal below is the lock's and not the roster's.
  const offering = async ({ yearId, termId }, courseName) => {
    const course = await one(
      `insert into course (name, specialty, academic_year_id)
       values ($1, 'Informática', $2) returning id`,
      [courseName, yearId],
    );
    const { id } = await one(
      `insert into offering (subject_id, term_id, kind, name)
       values ($1, $2, 'mandatory', null) returning id`,
      [subject.id, termId],
    );
    await root.query(
      `insert into offering_course (offering_id, course_id) values ($1, $2)`,
      [id, course.id],
    );
    await root.query(
      `insert into teacher_offering (teacher_id, offering_id) values ($1, $2)`,
      [teacher, id],
    );
    return { id, courseId: course.id };
  };
  const current = await offering(y2027, "NR5A");
  const past = await offering(y2025, "NR4A");
  await root.query(
    `insert into student_course (student_id, course_id) values ($1, $2)`,
    [student, past.courseId],
  );
  // Both have to be activated, or every route here is a 404 (F34).
  const { activate } = await import("../dist/offerings/activation.js");
  const { createDb } = await import("../dist/db/client.js");
  const svc = new Pool({ connectionString: urlFor(BASE, "campus_svc") });
  await activate(createDb(svc), current.id, admin);
  await activate(createDb(svc), past.id, admin);
  await svc.end();
  return { current: current.id, past: past.id, teacher, student, admin };
}
