// An ad-hoc HTTP pass over slice 11 (F29): the routes, over a real socket,
// against a throwaway Postgres carrying tic-auth's real shape. It is not part
// of `pnpm test` and it is not meant to be — `make test-db` proves the queries
// and `revisions.test.mjs` proves the checkers; this proves the payloads and
// the refusals.
//
// It matters more here than in the slices before it: this is the **first row a
// student writes**, so it is the first time the student side of `guard`'s CSRF
// check and `seeOwnMarks`-as-a-write-gate run at all. Neither has a caller
// anywhere else, and neither is reachable from `make test-db`.
//
// Run it from inside `api/` (the workspace's node_modules is not visible from
// outside), with docker available:
//
//     node scripts/harness-revisions.mjs
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

const CONTAINER = "tic-campus-harness-revisions";
// 55432 is `tic-ai-postgres`'s on this machine; docker's "port is already
// allocated" only shows up if `sh` is checked, which `run` below does.
const PORT = 55440;
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

  const secretFile = join(tmpdir(), "harness-revisions-secret");
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
  const secretArticle = await article("tp-oculto", "TP sin publicar");

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
  // Marks not out: the one activity a student may see and may not dispute.
  assert.equal(
    (await use(secretArticle, { position: 1, resultsPublishedAt: null }))
      .status,
    200,
  );

  const activities = (await call(teacher, "GET", `${home}/gradebook`)).body
    .activities;
  const tpId = activities.find((a) => a.slug === "tp-sql").id;
  const secretId = activities.find((a) => a.slug === "tp-oculto").id;

  const mark = async (studentId, activityId, value) => {
    const saved = await call(teacher, "PUT", `${home}/results`, {
      entries: [{ studentId, activityId, value }],
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  };
  await mark(ids.student, tpId, 4);
  await mark(ids.student, secretId, 4);

  /* ── The student's own payload carries what the dialog needs ───────────── */

  const mine = async () => call(student, "GET", `${home}/results/mine`);
  const first = await mine();
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.revisions, [], "sin pedidos todavía");
  assert.equal(
    typeof first.body.results[0].value,
    "number",
    "la nota llega como número y no como string",
  );
  // F29's group filing needs a partner picker, and nothing else in campus ever
  // told a student who is in their class.
  assert.ok(
    first.body.classmates.some((s) => s.id === ids.student),
    "classmates incluye a quien pregunta",
  );
  assert.ok(
    first.body.classmates.every((s) => s.enrolled !== false),
    "y solo a quien cursa",
  );

  /* ── Filing, and every refusal on the way ──────────────────────────────── */

  const file = (who, body) => call(who, "POST", `${home}/revisions`, body);
  const REASON = "Entregué la segunda parte y no está contada.";

  const teacherFiles = await file(teacher, {
    activityId: tpId,
    studentIds: [ids.teacher],
    reason: REASON,
  });
  assert.equal(teacherFiles.status, 403, "el profe no cursa esta materia");
  assert.equal(code(teacherFiles), "forbidden");

  const unpublished = await file(student, {
    activityId: secretId,
    studentIds: [ids.student],
    reason: REASON,
  });
  assert.equal(
    unpublished.status,
    400,
    "sin notas publicadas no hay qué pedir",
  );
  assert.equal(code(unpublished), "unknown_activity");

  const elsewhere = await file(student, {
    activityId: randomUUID(),
    studentIds: [ids.student],
    reason: REASON,
  });
  assert.equal(elsewhere.status, 400, "la actividad de otra materia no entra");
  assert.equal(code(elsewhere), "unknown_activity");

  const notMine = await file(student, {
    activityId: tpId,
    studentIds: [ids.teacher],
    reason: REASON,
  });
  assert.equal(notMine.status, 403, "no se pide por otro solo");
  assert.equal(code(notMine), "forbidden");

  const stranger2 = await file(student, {
    activityId: tpId,
    studentIds: [ids.student, ids.orphanStudent],
    reason: REASON,
  });
  assert.equal(stranger2.status, 400, "un compañero que no cursa, tampoco");
  assert.equal(code(stranger2), "not_enrolled");

  const empty = await file(student, {
    activityId: tpId,
    studentIds: [ids.student],
    reason: "   ",
  });
  assert.equal(empty.status, 400, "un motivo en blanco no es un motivo");
  assert.equal(code(empty), "invalid_body");

  const filed = await file(student, {
    activityId: tpId,
    studentIds: [ids.student],
    reason: REASON,
    bonusTasks: "Hice los ejercicios 4 a 9.",
  });
  assert.equal(filed.status, 201, JSON.stringify(filed.body));

  const again = await file(student, {
    activityId: tpId,
    studentIds: [ids.student],
    reason: "otra vez",
  });
  assert.equal(again.status, 409, "uno abierto por nota, y lo dice Postgres");
  assert.equal(code(again), "revision_open");

  /* ── It shows up on both screens ───────────────────────────────────────── */

  const mineNow = await mine();
  assert.equal(mineNow.body.revisions.length, 1);
  assert.equal(mineNow.body.revisions[0].activityId, tpId);
  assert.equal(
    mineNow.body.revisions[0].bonusTasks,
    "Hice los ejercicios 4 a 9.",
  );
  assert.equal(mineNow.body.revisions[0].answeredAt, null);

  const inbox = await call(teacher, "GET", `${home}/revisions`);
  assert.equal(inbox.status, 200);
  assert.equal(inbox.body.revisions.length, 1);
  const row = inbox.body.revisions[0];
  assert.equal(row.studentId, ids.student);
  assert.equal(row.requestedBy, ids.student, "quién lo pidió va en la fila");
  assert.equal(row.slug, "tp-sql");
  assert.equal(row.reason, REASON);

  // F6's count, on "Mis materias", and it is a number rather than a bigint
  // rendered as a string.
  const cards = await call(teacher, "GET", "/api/offerings/mine");
  assert.equal(cards.status, 200);
  const card = cards.body.find((o) => o.offeringId === ids.current);
  assert.equal(card.openRevisions, 1);
  assert.equal(typeof card.openRevisions, "number");
  const studentCards = await call(student, "GET", "/api/offerings/mine");
  assert.equal(
    studentCards.body.find((o) => o.offeringId === ids.current).openRevisions,
    0,
    "un estudiante no ve la cola de nadie",
  );

  /* ── Answering ─────────────────────────────────────────────────────────── */

  const answerAt = (who, id, answer) =>
    call(who, "POST", `${home}/revisions/${id}/answer`, { answer });

  const byStudent = await answerAt(student, row.id, "me la subo yo");
  assert.equal(byStudent.status, 403, "responder es del profe");
  assert.equal(code(byStudent), "forbidden");

  // `mustManage` refuses on the offering in the path, before the id is looked
  // up at all — so this is a 403 and not a 404. That the *id* is also scoped to
  // the home (the condition lives in the UPDATE's `where`) is proved in
  // `db.test.mjs`, which has a second activated offering to answer from.
  const byStranger = await answerAt(stranger, row.id, "mía ahora");
  assert.equal(byStranger.status, 403, "ni del profe de otra materia");
  assert.equal(code(byStranger), "forbidden");

  const ghost = await answerAt(teacher, randomUUID(), "a nadie");
  assert.equal(ghost.status, 404, "un pedido que no existe");

  const blank = await answerAt(teacher, row.id, "  ");
  assert.equal(blank.status, 400);
  assert.equal(code(blank), "invalid_body");

  const answered = await answerAt(teacher, row.id, "Tenías razón: va 7.");
  assert.equal(answered.status, 200, JSON.stringify(answered.body));

  const closed = (await call(teacher, "GET", `${home}/revisions`)).body
    .revisions[0];
  assert.notEqual(closed.answeredAt, null);
  assert.equal(closed.answeredBy, ids.teacher);
  assert.match(closed.answer, /va 7/);
  assert.equal(
    (await mine()).body.revisions[0].answer,
    "Tenías razón: va 7.",
    "y el estudiante lo lee",
  );
  assert.equal(
    (await call(teacher, "GET", "/api/offerings/mine")).body.find(
      (o) => o.offeringId === ids.current,
    ).openRevisions,
    0,
    "contestado sale de la cola",
  );

  // The mark change is a second call on purpose: `saveResults` is the one write
  // path for a result (F38), so answering writes no marks.
  assert.equal(
    (await mine()).body.results.find((r) => r.activityId === tpId).value,
    4,
    "responder no tocó la nota",
  );
  await mark(ids.student, tpId, 7);
  assert.equal(
    (await mine()).body.results.find((r) => r.activityId === tpId).value,
    7,
  );

  // Answered unblocks the next one — the index is partial, not total.
  const second = await file(student, {
    activityId: tpId,
    studentIds: [ids.student],
    reason: "Gracias, pero falta la parte 3.",
  });
  assert.equal(second.status, 201, "contestado el anterior, se puede de nuevo");

  /* ── Who may not ───────────────────────────────────────────────────────── */

  // The first student write in campus is the first exercise of both of these.
  const noCsrf = await fetch(`${API}${home}/revisions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Cookie: `tic_campus_session_dev=${student.secret}`,
    },
    body: JSON.stringify({
      activityId: tpId,
      studentIds: [ids.student],
      reason: "x",
    }),
  });
  assert.equal(noCsrf.status, 403);
  assert.equal((await noCsrf.json()).error.code, "csrf_failed");

  const noSession = await fetch(`${API}${home}/revisions`, { method: "POST" });
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
