// An ad-hoc HTTP pass over slice 13 (F14, F15): an offering configures its
// home — sections, links, and its own order and hiding of the library's units —
// and the one public read carries it. It is not part of `pnpm test`; `make
// test-db` proves the reads and writes. This proves the **wire**: the public
// payload's top-level keys, that an anonymous caller never receives a hidden
// unit, that `javascript:` is refused before it can become an href, and that
// the write is `manageOffering`'s.
//
// Run it from inside `api/` (the workspace's node_modules is not visible from
// outside), with docker available:
//
//     node scripts/harness-home.mjs
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

const CONTAINER = "tic-campus-harness-home";
// 55432 is `tic-ai-postgres`'s on this machine; docker's "port is already
// allocated" only shows up if `sh` is checked, which `run` below does.
const PORT = 55442;
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

  const secretFile = join(tmpdir(), "harness-home-secret");
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
      UPLOADS_DIR: join(tmpdir(), "harness-home-uploads"),
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
  const page = "/api/offerings/2027/bases-de-datos/nr5a";
  const anon = async () => {
    const res = await fetch(API + page);
    return { status: res.status, body: await res.json() };
  };

  /* ── Never configured: the default, and the same shape for anybody ─────── */

  const first = await anon();
  assert.equal(first.status, 200, JSON.stringify(first.body));
  for (const key of ["sections", "links", "program", "articles"]) {
    assert.ok(key in first.body, `falta ${key} en la portada`);
  }
  assert.deepEqual(first.body.sections, [
    "program",
    "articles",
    "links",
    "marks",
  ]);
  assert.deepEqual(first.body.links, []);

  /* ── The teacher arranges it ──────────────────────────────────────────── */

  const program = await call(
    teacher,
    "PUT",
    `/api/subjects/${ids.subject}/program`,
    {
      units: [
        { title: "Consultas", contents: "" },
        { title: "Normalización", contents: "" },
        { title: "Transacciones", contents: "" },
      ],
    },
  );
  assert.equal(program.status, 200, JSON.stringify(program.body));
  const [u1, u2, u3] = program.body.map((unit) => unit.id);

  const config = {
    sections: ["links", "program", "articles"],
    links: [
      { title: "Grupo", url: "https://chat.whatsapp.com/abc" },
      { title: "Cheatsheets", url: "http://example.com/cs.pdf" },
    ],
    unitOrder: [u3, u1],
    hiddenUnits: [u2],
  };
  const saved = await call(teacher, "PUT", `${home}/home`, config);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body, config);

  const after = (await anon()).body;
  assert.deepEqual(after.sections, config.sections);
  assert.deepEqual(after.links, config.links);
  assert.deepEqual(
    after.program.map((unit) => unit.id),
    [u3, u1],
    "en el orden de la materia, sin la oculta",
  );
  assert.ok(
    after.program.every((unit) => unit.hidden === false),
    "un visitante nunca ve `hidden: true`",
  );

  // Staff read the same URL and get the hidden unit back, flagged, so the
  // configuration screen can offer to show it again.
  const staff = (await call(teacher, "GET", page)).body;
  assert.deepEqual(
    staff.program.map((unit) => [unit.id, unit.hidden]),
    [
      [u3, false],
      [u1, false],
      [u2, true],
    ],
  );

  /* ── Refusals ─────────────────────────────────────────────────────────── */

  const xss = await call(teacher, "PUT", `${home}/home`, {
    ...config,
    links: [{ title: "Grupo", url: "javascript:alert(document.cookie)" }],
  });
  assert.equal(xss.status, 400);
  assert.equal(code(xss), "invalid_body");
  assert.deepEqual((await anon()).body.links, config.links, "nada se guardó");

  const unknown = await call(teacher, "PUT", `${home}/home`, {
    ...config,
    hiddenUnits: [randomUUID()],
  });
  assert.equal(unknown.status, 400);
  assert.equal(code(unknown), "unknown_unit");

  const byStudent = await call(student, "PUT", `${home}/home`, config);
  assert.equal(byStudent.status, 403, JSON.stringify(byStudent.body));
  assert.equal(code(byStudent), "forbidden");

  const other = await login(ids.otherTeacher, ["teacher"]);
  const byOther = await call(other, "PUT", `${home}/home`, config);
  assert.equal(byOther.status, 403, "otra comisión de la misma materia");

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
