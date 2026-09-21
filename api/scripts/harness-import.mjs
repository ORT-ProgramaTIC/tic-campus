// An ad-hoc HTTP pass over slice 16 (F27): the gradebook goes out as a CSV
// file and comes back in. It is not part of `pnpm test`; the unit tests pin
// the dialect and the diff, and `make test-db` the one transaction. This
// proves the **wire**: the export's headers, the raw `text/csv` body on its own
// parser, the dry run that writes nothing, the apply that writes only what
// changed, the `400 import_invalid` that carries the diff, and the lock (a dry
// run is a read and passes it; applying is a write and does not).
//
// Run it from inside `api/` (the workspace's node_modules is not visible from
// outside), with docker available:
//
//     node scripts/harness-import.mjs
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

const CONTAINER = "tic-campus-harness-import";
// 55432 is `tic-ai-postgres`'s on this machine; docker's "port is already
// allocated" only shows up if `sh` is checked, which `run` below does.
const PORT = 55445;
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

  const secretFile = join(tmpdir(), "harness-import-secret");
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
      UPLOADS_DIR: join(tmpdir(), "harness-import-uploads"),
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

  /** A CSV body: the raw file, labelled by hand the way a screen would. */
  const upload = async (who, path, text, type = "text/csv") => {
    const res = await fetch(API + path, {
      method: "POST",
      headers: {
        "content-type": type,
        Cookie: `tic_campus_session_dev=${who.secret}`,
        "X-CSRF-Token": who.csrf,
      },
      body: text,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  /* ── Setup: a term and a numeric TP in 2027 ───────────────────────────── */

  const home = `/api/homes/${ids.current}`;
  const setup = await call(teacher, "PUT", `${home}/gradebook`, {
    groups: [{ name: "tps" }],
    terms: [{ name: "1er" }],
    scales: [],
  });
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
  const created = await call(
    teacher,
    "POST",
    `/api/subjects/${ids.subject}/articles`,
    { slug: "tp-sql", title: "TP SQL" },
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const used = await call(
    teacher,
    "PUT",
    `${home}/articles/${created.body.id ?? created.body.article?.id}`,
    {
      position: 0,
      offeringGroupId: setup.body.groups[0].id,
      offeringTermId: setup.body.terms[0].id,
      valueType: "numeric",
    },
  );
  assert.equal(used.status, 200, JSON.stringify(used.body));

  /* ── Out ──────────────────────────────────────────────────────────────── */

  const exported = await fetch(`${API}${home}/gradebook/export`, {
    headers: { Cookie: `tic_campus_session_dev=${teacher.secret}` },
  });
  assert.equal(exported.status, 200);
  assert.equal(exported.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.match(
    exported.headers.get("content-disposition"),
    /^attachment; filename\*=UTF-8''boletin-\d+\.csv$/,
  );
  const bytes = new Uint8Array(await exported.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], "a BOM");
  // `TextDecoder` drops the BOM on its own, which is what an importer sees.
  const csv = new TextDecoder().decode(bytes);
  assert.equal(
    csv,
    "Id;DNI;Apellido;Nombre;TP SQL [tp-sql];1er [nota oficial]\r\n" +
      `${ids.student};30111222;Alumne;Cami;;\r\n`,
  );
  const byStudent = await fetch(`${API}${home}/gradebook/export`, {
    headers: { Cookie: `tic_campus_session_dev=${student.secret}` },
  });
  assert.equal(byStudent.status, 403, "the class list is the teacher's");

  /* ── In: dry run, then apply ──────────────────────────────────────────── */

  // Latin-1, `,` and a decimal point: an older Excel, and still read.
  const edited = Buffer.from(
    `DNI,TP [tp-sql],1er [nota oficial]\n30.111.222,7.5,8\n`,
    "latin1",
  );
  const dry = await upload(
    teacher,
    `${home}/gradebook/import?dryRun=true`,
    edited,
  );
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.equal(dry.body.applied, false);
  assert.deepEqual(
    dry.body.changes.map((c) => [c.column.kind, c.from, c.to]),
    [
      ["activity", null, "7,5"],
      ["official", null, "8"],
    ],
  );
  const grid = async () =>
    (await call(teacher, "GET", `${home}/gradebook`)).body;
  assert.deepEqual((await grid()).results, [], "the dry run wrote nothing");

  const applied = await upload(teacher, `${home}/gradebook/import`, edited);
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.applied, true);
  const after = await grid();
  assert.deepEqual(
    after.results.map((r) => r.value),
    [7.5],
  );
  assert.deepEqual(
    after.officialGrades.map((g) => g.value),
    [8],
  );

  // The same file again is no change at all.
  const again = await upload(teacher, `${home}/gradebook/import`, edited);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body.changes, []);
  assert.equal(again.body.unchanged, 2);

  /* ── Refusals ─────────────────────────────────────────────────────────── */

  const bad = await upload(
    teacher,
    `${home}/gradebook/import`,
    `Id;TP [tp-sql];Otra [nada]\n${ids.student};11;\n`,
  );
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  assert.equal(code(bad), "import_invalid");
  assert.deepEqual(
    bad.body.problems.map((p) => p.code),
    ["unknown_column", "bad_value"],
    "the diff rides beside the error",
  );

  const json = await upload(
    teacher,
    `${home}/gradebook/import`,
    JSON.stringify({ entries: [] }),
    "application/json",
  );
  assert.equal(json.status, 415, JSON.stringify(json.body));

  const noCsrf = await fetch(`${API}${home}/gradebook/import`, {
    method: "POST",
    headers: {
      "content-type": "text/csv",
      Cookie: `tic_campus_session_dev=${teacher.secret}`,
    },
    body: edited,
  });
  assert.equal(noCsrf.status, 403);

  // 2025 is locked: a dry run is a read, applying is not.
  const past = `/api/homes/${ids.past}/gradebook/import`;
  const pastDry = await upload(teacher, `${past}?dryRun=true`, "Id\n");
  assert.equal(pastDry.status, 200, JSON.stringify(pastDry.body));
  const pastApply = await upload(teacher, past, "Id\n");
  assert.equal(pastApply.status, 409, JSON.stringify(pastApply.body));
  assert.equal(code(pastApply), "locked");

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
  await root.query(`update "user" set dni = '30111222' where id = $1`, [
    student,
  ]);
  const admin = await user("admin@ort.edu.ar", "Eve", "Admin");
  // One offering per year, the same teacher and the same student, so the
  // 2025 refusal below is the lock's and not the roster's.
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
  for (const { courseId } of [current, past]) {
    await root.query(
      `insert into student_course (student_id, course_id) values ($1, $2)`,
      [student, courseId],
    );
  }
  // Both have to be activated, or every route here is a 404 (F34).
  const { activate } = await import("../dist/offerings/activation.js");
  const { createDb } = await import("../dist/db/client.js");
  const svc = new Pool({ connectionString: urlFor(BASE, "campus_svc") });
  await activate(createDb(svc), current.id, admin);
  await activate(createDb(svc), past.id, admin);
  await svc.end();
  return {
    current: current.id,
    past: past.id,
    subject: subject.id,
    teacher,
    student,
    admin,
  };
}
