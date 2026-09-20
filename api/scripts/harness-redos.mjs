// An ad-hoc HTTP pass over slice 10 (F23): the routes, over a real socket,
// against a throwaway Postgres carrying tic-auth's real shape. It is not part
// of `pnpm test` and it is not meant to be — `make test-db` proves the queries
// and `redos.test.mjs` proves the arithmetic; this proves the payloads, which
// is where slice 8's two bugs were.
//
// Run it from inside `api/` (the workspace's node_modules is not visible from
// outside), with docker available:
//
//     node scripts/harness-redos.mjs
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

const CONTAINER = "tic-campus-harness-redos";
// 55432 is `tic-ai-postgres`'s on this machine; docker's "port is already
// allocated" only shows up if `sh` is checked, which `run` below does.
const PORT = 55439;
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
  const stranger = await login(ids.otherTeacher, ["teacher"]);

  const secretFile = join(tmpdir(), "harness-redos-secret");
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
      UPLOADS_DIR: join(tmpdir(), "harness-redos-uploads"),
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

  /* ── Setup: a term, a group, a TP and a redo ───────────────────────────── */

  const home = `/api/homes/${ids.current}`;
  const setup = await call(teacher, "PUT", `${home}/gradebook`, {
    groups: [{ name: "tps" }],
    terms: [{ name: "1er", formula: "avg(tps)" }],
    scales: [],
  });
  assert.equal(setup.status, 200);
  assert.equal(setup.body.redoPolicy, "max", "el default llega en el payload");
  const groupId = setup.body.groups[0].id;
  const termId = setup.body.terms[0].id;

  const article = async (slug, title) => {
    const created = await call(
      teacher,
      "POST",
      `/api/subjects/${ids.subject}/articles`,
      {
        slug,
        title,
      },
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body.id ?? created.body.article?.id;
  };
  const tpArticle = await article("tp-sql", "TP SQL");
  const redoArticle = await article("recuperatorio-sql", "Recuperatorio");

  const use = (articleId, extra) =>
    call(teacher, "PUT", `${home}/articles/${articleId}`, {
      position: 0,
      publishedAt: new Date(Date.now() - 86_400_000).toISOString(),
      offeringGroupId: groupId,
      offeringTermId: termId,
      valueType: "numeric",
      resultsPublishedAt: new Date(Date.now() - 86_400_000).toISOString(),
      ...extra,
    });
  assert.equal((await use(tpArticle, {})).status, 200);

  const grid = async (who = teacher) => call(who, "GET", `${home}/gradebook`);
  const tpId = (await grid()).body.activities.find(
    (a) => a.slug === "tp-sql",
  ).id;

  /* ── covers round-trips, and the refusals do too ───────────────────────── */

  const bad = await use(redoArticle, { covers: [randomUUID()] });
  assert.equal(bad.status, 404, "otra materia");
  assert.equal(code(bad), "not_found");

  const mismatched = await use(redoArticle, {
    covers: [tpId],
    valueType: "done",
  });
  assert.equal(mismatched.status, 400);
  assert.equal(code(mismatched), "invalid_body");

  const notAList = await use(redoArticle, { covers: "tp" });
  assert.equal(notAList.status, 400);

  assert.equal((await use(redoArticle, { covers: [tpId] })).status, 200);
  const withRedo = (await grid()).body;
  const redo = withRedo.activities.find((a) => a.slug === "recuperatorio-sql");
  assert.deepEqual(redo.covers, [tpId], "covers sale por el mismo payload");
  assert.deepEqual(
    withRedo.activities.find((a) => a.slug === "tp-sql").covers,
    [],
  );

  const self = await use(redoArticle, { covers: [tpId, redo.id] });
  assert.equal(self.status, 400, "ni a sí misma");

  /* ── The marks, both numbers, over the wire ────────────────────────────── */

  const mark = (activityId, value) =>
    call(teacher, "PUT", `${home}/results`, {
      entries: [{ studentId: ids.student, activityId, value, feedback: null }],
    });
  assert.equal((await mark(tpId, 8)).status, 200);
  assert.equal((await mark(redo.id, 4)).status, 200);

  const termOf = (payload) =>
    payload.computed.find((c) => c.studentId === ids.student).terms[termId];
  const underMax = termOf((await grid()).body);
  assert.equal(underMax.all.value, 8, "max: el 4 no baja el 8");
  assert.equal(
    typeof underMax.all.value,
    "number",
    "numeric llega como número y no como string entre comillas",
  );

  const policy = await call(teacher, "PUT", `${home}/gradebook`, {
    groups: [],
    terms: [],
    scales: [],
    redoPolicy: "replace",
  });
  assert.equal(policy.status, 200);
  assert.equal(policy.body.redoPolicy, "replace");
  assert.equal(termOf((await grid()).body).all.value, 4, "replace sí baja");

  const bogus = await call(teacher, "PUT", `${home}/gradebook`, {
    groups: [],
    terms: [],
    scales: [],
    redoPolicy: "lo que sea",
  });
  assert.equal(bogus.status, 400);
  assert.equal(code(bogus), "invalid_body");

  /* ── The student's own page ────────────────────────────────────────────── */

  const mine = await call(student, "GET", `${home}/results/mine`);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.computed.terms[termId].value, 4);
  assert.deepEqual(
    mine.body.results.find((r) => r.slug === "recuperatorio-sql").covers,
    [tpId],
    "el estudiante sabe qué reemplaza su recuperatorio (F44)",
  );

  // Unpublished, and the student's number goes back to the 8 while the
  // teacher's stays 4 — the publishing rule, over the wire (F24).
  assert.equal(
    (await use(redoArticle, { covers: [tpId], resultsPublishedAt: null }))
      .status,
    200,
  );
  const hidden = await call(student, "GET", `${home}/results/mine`);
  assert.equal(hidden.body.computed.terms[termId].value, 8);
  assert.equal(termOf((await grid()).body).all.value, 4);

  /* ── Who may not ───────────────────────────────────────────────────────── */

  const byStudent = await use(redoArticle, { covers: [] });
  assert.equal(byStudent.status, 200, "el docente sí");
  const studentWrites = await call(
    student,
    "PUT",
    `${home}/articles/${redoArticle}`,
    { position: 0, covers: [tpId] },
  );
  assert.equal(studentWrites.status, 403);
  assert.equal(code(studentWrites), "forbidden");

  const otherTeacherWrites = await call(
    stranger,
    "PUT",
    `${home}/articles/${redoArticle}`,
    { position: 0, covers: [tpId] },
  );
  assert.equal(
    otherTeacherWrites.status,
    403,
    "otra oferta de la misma materia no alcanza",
  );

  const noCsrf = await fetch(`${API}${home}/articles/${redoArticle}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      Cookie: `tic_campus_session_dev=${teacher.secret}`,
    },
    body: "{}",
  });
  assert.equal(noCsrf.status, 403);
  assert.equal((await noCsrf.json()).error.code, "csrf_failed");

  const noSession = await fetch(`${API}${home}/gradebook`);
  assert.equal(noSession.status, 401);

  await Promise.all([root.end(), owner.end()]);
}

/** The inserts out of `db.test.mjs`'s `seed()`, which is known to apply against
 *  the committed stand-ins — `academic_year.starts_on`, `course.specialty` and
 *  `user.dni`'s check all bite a hand-rolled one, in that order. */
async function seed(root) {
  const one = async (sql, values) => (await root.query(sql, values)).rows[0];
  const year = await one(
    `insert into academic_year (year, starts_on, ends_on, is_current)
     values (2027, '2027-03-01', '2027-12-15', true) returning id`,
  );
  const term = await one(
    `insert into term (academic_year_id, kind, starts_on, ends_on)
     values ($1, 'full', '2027-03-01', '2027-12-15') returning id`,
    [year.id],
  );
  const subject = await one(
    `insert into subject (name, marks) values ('Bases de Datos', true) returning id`,
  );
  const course = await one(
    `insert into course (name, specialty, academic_year_id)
     values ('NR5A', 'Informática', $1) returning id`,
    [year.id],
  );
  const user = async (email, name, surname) =>
    (
      await one(
        `insert into "user" (email, name, surname) values ($1, $2, $3) returning id`,
        [email, name, surname],
      )
    ).id;
  const teacher = await user("profe@ort.edu.ar", "Ana", "Docente");
  const otherTeacher = await user("otro@ort.edu.ar", "Beto", "Docente");
  const student = await user("alu@ort.edu.ar", "Cami", "Alumne");
  const admin = await user("admin@ort.edu.ar", "Eve", "Admin");
  const offering = async (termId) =>
    (
      await one(
        `insert into offering (subject_id, term_id, kind, name)
         values ($1, $2, 'mandatory', null) returning id`,
        [subject.id, termId],
      )
    ).id;
  const current = await offering(term.id);
  // Another offering of the SAME subject, last year: enough for the library,
  // not for the gradebook. It is what makes the 403 below attributable to
  // `manageOffering` rather than to not teaching at all.
  const past = await one(
    `insert into academic_year (year, starts_on, ends_on, is_current)
     values (2026, '2026-03-01', '2026-12-15', false) returning id`,
  );
  const pastTerm = await one(
    `insert into term (academic_year_id, kind, starts_on, ends_on)
     values ($1, 'full', '2026-03-01', '2026-12-15') returning id`,
    [past.id],
  );
  const pastYear = await offering(pastTerm.id);
  await root.query(
    `insert into offering_course (offering_id, course_id) values ($1, $2)`,
    [current, course.id],
  );
  await root.query(
    `insert into teacher_offering (teacher_id, offering_id) values ($1, $2)`,
    [teacher, current],
  );
  await root.query(
    `insert into teacher_offering (teacher_id, offering_id) values ($1, $2)`,
    [otherTeacher, pastYear],
  );
  await root.query(
    `insert into student_course (student_id, course_id) values ($1, $2)`,
    [student, course.id],
  );
  // The offering has to be activated, or every route here is a 404 (F34).
  const { activate } = await import("../dist/offerings/activation.js");
  const { createDb } = await import("../dist/db/client.js");
  const svc = new Pool({ connectionString: urlFor(BASE, "campus_svc") });
  await activate(createDb(svc), current, admin);
  await svc.end();
  return {
    subject: subject.id,
    current,
    teacher,
    otherTeacher,
    student,
    admin,
  };
}
