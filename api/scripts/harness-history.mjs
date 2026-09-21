// An ad-hoc HTTP pass over slices 12 and 17 (F41): `result` became
// append-only in 12, `official_grade` in 17, and 17 added the two history
// routes. Slice 12's own summary: `result` became append-only, so a
// re-mark inserts a row instead of overwriting one, and the two readers that
// read a mark's value take the pair's newest through a `DISTINCT ON` subquery.
// It is not part of `pnpm test` — `make test-db` proves the history; this
// proves that **no payload moved**, which is the actual risk of this slice:
// the grid and `/results/mine` must still carry one row per cell, the computed
// mark must be computed from the newest row alone, and the numeric must still
// arrive as a number down a query path it never travelled before.
//
// Run it from inside `api/` (the workspace's node_modules is not visible from
// outside), with docker available:
//
//     node scripts/harness-history.mjs
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

const CONTAINER = "tic-campus-harness-history";
// 55432 is `tic-ai-postgres`'s on this machine; docker's "port is already
// allocated" only shows up if `sh` is checked, which `run` below does.
const PORT = 55441;
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

  const secretFile = join(tmpdir(), "harness-history-secret");
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
      UPLOADS_DIR: join(tmpdir(), "harness-history-uploads"),
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

  /* ── Setup: a term, a group, a published TP with marks ─────────────────── */

  const home = `/api/homes/${ids.current}`;
  const setup = await call(teacher, "PUT", `${home}/gradebook`, {
    groups: [{ name: "tps" }],
    terms: [{ name: "1er", formula: "avg(tps)" }],
    scales: [],
  });
  assert.equal(setup.status, 200);
  const groupId = setup.body.groups[0].id;
  const termId = setup.body.terms[0].id;

  const article = async (slug, title) => {
    const created = await call(
      teacher,
      "POST",
      `/api/subjects/${ids.subject}/articles`,
      { slug, title },
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body.id ?? created.body.article?.id;
  };
  const tpArticle = await article("tp-sql", "TP SQL");

  const ago = new Date(Date.now() - 86_400_000).toISOString();
  const use = (articleId, extra) =>
    call(teacher, "PUT", `${home}/articles/${articleId}`, {
      position: 0,
      publishedAt: ago,
      offeringGroupId: groupId,
      offeringTermId: termId,
      valueType: "numeric",
      resultsPublishedAt: ago,
      ...extra,
    });
  assert.equal((await use(tpArticle, {})).status, 200);

  const activities = (await call(teacher, "GET", `${home}/gradebook`)).body
    .activities;
  const tpId = activities.find((a) => a.slug === "tp-sql").id;

  const mark = async (studentId, activityId, value) => {
    const saved = await call(teacher, "PUT", `${home}/results`, {
      entries: [{ studentId, activityId, value }],
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  };
  await mark(ids.student, tpId, 4);

  /* ── The payloads keep their shape ──────────────────────────────────────── */

  const grid = async () => call(teacher, "GET", `${home}/gradebook`);
  const mine = async () => call(student, "GET", `${home}/results/mine`);
  const keys = (row) => Object.keys(row).sort();
  // `Mark` and `MyResult`, key for key. If either moves, the slice is wrong.
  const MARK = [
    "activityId",
    "feedback",
    "recordedAt",
    "recordedBy",
    "scaleLevelId",
    "studentId",
    "value",
  ];
  const MY_RESULT = [
    "activityId",
    "covers",
    "dueAt",
    "feedback",
    "groupId",
    "scaleLevel",
    "slug",
    "termId",
    "title",
    "value",
    "valueType",
  ];
  // `locked` since slice 14 (F35).
  const MINE = [
    "classmates",
    "computed",
    "locked",
    "official",
    "results",
    "revisions",
  ];

  const check = async (expected, marker) => {
    const g = await grid();
    assert.equal(g.status, 200);
    const cells = g.body.results.filter(
      (r) => r.activityId === tpId && r.studentId === ids.student,
    );
    assert.equal(cells.length, 1, "una fila por celda en el boletín");
    assert.deepEqual(keys(cells[0]), MARK);
    assert.equal(cells[0].value, expected, "gana la fila más nueva");
    assert.equal(typeof cells[0].value, "number", "número, no string");
    assert.equal(cells[0].recordedBy, marker);

    const m = await mine();
    assert.equal(m.status, 200);
    assert.deepEqual(Object.keys(m.body).sort(), MINE);
    const own = m.body.results.filter((r) => r.activityId === tpId);
    assert.equal(own.length, 1, "una nota por actividad para el estudiante");
    assert.deepEqual(keys(own[0]), MY_RESULT);
    assert.equal(own[0].value, expected);
    assert.equal(typeof own[0].value, "number", "número, no string");
    // The one that matters: a second row reaching the evaluator averages the
    // old mark in, and avg(4, 7) is a 5.5 nobody gave.
    assert.equal(
      m.body.computed.terms[termId].value,
      expected,
      "la nota calculada sale solo de la fila más nueva",
    );
  };

  await check(4, ids.teacher);

  /* ── A re-mark over the wire ───────────────────────────────────────────── */

  const admin = await login(ids.admin, ["admin"]);
  const remark = await call(admin, "PUT", `${home}/results`, {
    entries: [{ studentId: ids.student, activityId: tpId, value: 7 }],
  });
  assert.equal(remark.status, 200, JSON.stringify(remark.body));
  await check(7, ids.admin);

  const history = (
    await root.query(
      `select value::float8 as value, recorded_by from campus.result
        where offering_article_id = $1 and student_id = $2
        order by recorded_at, id`,
      [tpId, ids.student],
    )
  ).rows;
  assert.deepEqual(
    history,
    [
      { value: 4, recorded_by: ids.teacher },
      { value: 7, recorded_by: ids.admin },
    ],
    "el 4 sigue ahí, y dice quién lo puso",
  );

  /* ── The same cell twice in one body: the last one, once ─────────────────── */

  const twice = await call(teacher, "PUT", `${home}/results`, {
    entries: [
      { studentId: ids.student, activityId: tpId, value: 5 },
      { studentId: ids.student, activityId: tpId, value: 8 },
    ],
  });
  assert.equal(twice.status, 200, JSON.stringify(twice.body));
  await check(8, ids.teacher);
  const count = async () =>
    Number(
      (
        await root.query(
          "select count(*) from campus.result where offering_article_id = $1 and student_id = $2",
          [tpId, ids.student],
        )
      ).rows[0].count,
    );
  assert.equal(await count(), 3, "una fila por el cuerpo, no dos");

  /* ── The history over the wire (slice 17) ────────────────────────────────── */

  const VERSION = [
    "feedback",
    "recordedAt",
    "recordedBy",
    "recordedByName",
    "recordedBySurname",
    "scaleLevelId",
    "value",
  ];
  const markHistory = `${home}/results/${tpId}/${ids.student}/history`;
  const read = await call(teacher, "GET", markHistory);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual(keys(read.body.history[0]), VERSION);
  assert.deepEqual(
    read.body.history.map((h) => [h.value, h.recordedBy, h.recordedByName]),
    [
      [8, ids.teacher, "Ana"],
      [7, ids.admin, "Eve"],
      [4, ids.teacher, "Ana"],
    ],
    "la más nueva primero, con quién la puso",
  );
  // Staff of *this* offering only: the student, and a teacher of last year's.
  assert.equal(code(await call(student, "GET", markHistory)), "forbidden");
  const other = await login(ids.otherTeacher, ["teacher"]);
  assert.equal(code(await call(other, "GET", markHistory)), "forbidden");
  assert.equal(
    (await call(teacher, "GET", `${home}/results/nope/${ids.student}/history`))
      .status,
    404,
  );

  /* ── The boletín grade keeps its history too (slice 17) ────────────────── */

  const official = (who, value, observation) =>
    call(who, "PUT", `${home}/official-grades`, {
      entries: [{ studentId: ids.student, termId, value, observation }],
    });
  assert.equal((await official(teacher, 4, null)).status, 200);
  // Same number, new words: a new row, because the row is the whole record.
  assert.equal(
    (await official(admin, 4, "Faltó a la integradora.")).status,
    200,
  );
  // The same cell twice in one body: the last one, once.
  const twiceGraded = await call(teacher, "PUT", `${home}/official-grades`, {
    entries: [
      { studentId: ids.student, termId, value: 5 },
      { studentId: ids.student, termId, value: 6, observation: "Mejoró." },
    ],
  });
  assert.equal(twiceGraded.status, 200, JSON.stringify(twiceGraded.body));

  const graded = (await grid()).body.officialGrades.filter(
    (g) => g.termId === termId && g.studentId === ids.student,
  );
  assert.equal(graded.length, 1, "una nota del boletín por celda");
  assert.deepEqual(keys(graded[0]), [
    "observation",
    "recordedAt",
    "recordedBy",
    "studentId",
    "suggestion",
    "termId",
    "value",
  ]);
  assert.deepEqual([graded[0].value, graded[0].observation], [6, "Mejoró."]);
  const ownGrade = (await mine()).body.official;
  assert.equal(ownGrade.length, 1);
  assert.deepEqual(keys(ownGrade[0]), [
    "observation",
    "suggestion",
    "termId",
    "value",
  ]);
  assert.equal(ownGrade[0].value, 6);
  assert.equal(typeof ownGrade[0].value, "number", "número, no string");

  const gradeHistory = `${home}/official-grades/${termId}/${ids.student}/history`;
  const past = await call(teacher, "GET", gradeHistory);
  assert.equal(past.status, 200, JSON.stringify(past.body));
  assert.deepEqual(
    past.body.history.map((h) => [h.value, h.observation, h.recordedBy]),
    [
      [6, "Mejoró.", ids.teacher],
      [4, "Faltó a la integradora.", ids.admin],
      [4, null, ids.teacher],
    ],
    "tres filas: el cuerpo repetido dejó una sola",
  );
  assert.equal(code(await call(student, "GET", gradeHistory)), "forbidden");

  const clearedGrade = await official(teacher, null, null);
  assert.equal(clearedGrade.status, 200);
  assert.deepEqual((await call(teacher, "GET", gradeHistory)).body.history, []);

  /* ── A clear takes the history with it ─────────────────────────────────── */

  const cleared = await call(teacher, "PUT", `${home}/results`, {
    entries: [{ studentId: ids.student, activityId: tpId, value: null }],
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal(await count(), 0, "borrar la nota borra todas sus filas");
  const blank = await mine();
  assert.deepEqual(
    blank.body.results.filter((r) => r.activityId === tpId),
    [],
    "y la celda queda en blanco",
  );
  assert.equal(
    (await grid()).body.results.some(
      (r) => r.activityId === tpId && r.studentId === ids.student,
    ),
    false,
  );

  await Promise.all([root.end(), owner.end()]);
}

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
  // Enrolled nowhere: what makes the `not_enrolled` refusal attributable to the
  // roster and not to a malformed id.
  const orphanStudent = await user("suelte@ort.edu.ar", "Dani", "Suelte");
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
    orphanStudent,
    admin,
  };
}
