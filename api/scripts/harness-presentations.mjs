// An ad-hoc HTTP pass over F45, the presentation schedule: the routes, over a
// real socket, against a throwaway Postgres carrying tic-registry's real shape.
// Not part of `pnpm test` — `make test-db` proves the queries and
// `presentations.test.mjs` the estimate; this proves the payloads, the gates
// and the refusals.
//
// Run it from inside `api/`, with docker available:
//
//     node scripts/harness-presentations.mjs
//
// The preamble is `harness-revisions.mjs`'s, and its four warnings hold here.
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

const CONTAINER = "tic-campus-harness-presentations";
// 55432 is `tic-ai-postgres`'s on this machine; docker's "port is already
// allocated" only shows up if `sh` is checked, which `run` below does.
const PORT = 55446;
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
  const outsider = await login(ids.orphanStudent, ["student"]);

  const secretFile = join(tmpdir(), "harness-presentations-secret");
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
      UPLOADS_DIR: join(tmpdir(), "harness-presentations-uploads"),
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

  const path = `/api/homes/${ids.offering}/presentations`;

  /* ── Before anything is saved ──────────────────────────────────────────── */

  const empty = await call(teacher, "GET", path);
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  assert.equal(empty.body.savedAt, null);
  assert.deepEqual(
    empty.body.teams.map((team) => team.name),
    ["Alfa", "Beta"],
  );
  assert.deepEqual(empty.body.classBlocks, [
    { day: "friday", block: 3, classroom: "L1" },
  ]);
  assert.equal(
    empty.body.bell[3].start,
    "10:55",
    "staff get the bell to split against",
  );

  /* ── The teacher saves a schedule ─────────────────────────────────────── */

  // 2027-11-12 is a Friday, the offering's day. A year from today, so every
  // slot is live and every waiting team has an estimate.
  const fri = randomUUID();
  const schedule = (base, extra = {}) => ({
    base,
    blocks: [
      {
        id: fri,
        round: 1,
        date: "2027-11-12",
        block: 3,
        slotStarts: [null, "11:40", null],
      },
    ],
    presentations: [
      { projectId: ids.beta, round: 1, pin: { blockId: fri, slot: 3 } },
      { projectId: ids.alpha, round: 1, pin: null },
    ],
    ...extra,
  });
  const saved = await call(teacher, "PUT", path, schedule(null));
  assert.equal(saved.status, 200, JSON.stringify(saved.body));

  const stale = await call(teacher, "PUT", path, schedule(null));
  assert.equal(stale.status, 409, "a save from a tab that loaded nothing");
  assert.equal(code(stale), "stale_schedule");

  const thursday = await call(
    teacher,
    "PUT",
    path,
    schedule(saved.body.savedAt, {
      blocks: [{ id: randomUUID(), round: 1, date: "2027-11-11", block: 3 }],
      presentations: [],
    }),
  );
  assert.equal(thursday.status, 400, "the class does not meet on Thursdays");
  assert.equal(code(thursday), "not_a_class_block");

  /* ── The student sees their own team's slot ───────────────────────────── */

  const read = await call(student, "GET", path);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual(read.body.mine, [ids.alpha], "the banner's team");
  assert.equal(read.body.classBlocks, undefined, "the picker is staff-only");
  const alpha = read.body.presentations.find((p) => p.projectId === ids.alpha);
  const beta = read.body.presentations.find((p) => p.projectId === ids.beta);
  assert.equal(alpha.name, "Alfa");
  assert.deepEqual(
    [
      alpha.estimate.date,
      alpha.estimate.start,
      alpha.estimate.end,
      alpha.estimate.pinned,
    ],
    ["2027-11-12", "10:55", "11:15", false],
    "first in the queue, first free slot, 20 minutes long",
  );
  assert.deepEqual(
    [beta.estimate.start, beta.estimate.pinned],
    ["12:00", true],
  );
  assert.deepEqual(
    read.body.blocks[0].slots.map((slot) => slot.start),
    ["10:55", "11:40", "12:00"],
    "the override moves the slot after it too",
  );

  /* ── An event takes slot 1, and the queue starts at slot 2 ─────────────── */

  const restruck = await call(
    teacher,
    "PUT",
    path,
    schedule(saved.body.savedAt, {
      blocks: [
        {
          id: fri,
          round: 1,
          date: "2027-11-12",
          block: 3,
          slotStarts: [null, "11:40", null],
          skippedSlots: [1],
        },
      ],
      queueStarts: [{ round: 1, blockId: fri, slot: 2 }],
    }),
  );
  assert.equal(restruck.status, 200, JSON.stringify(restruck.body));
  const moved = await call(student, "GET", path);
  assert.deepEqual(moved.body.queueStarts, [
    { round: 1, blockId: fri, slot: 2 },
  ]);
  assert.deepEqual(
    moved.body.blocks[0].slots.map((slot) => slot.skipped),
    [true, false, false],
    "slot 1 comes back crossed out, not gone",
  );
  assert.equal(
    moved.body.presentations.find((p) => p.projectId === ids.alpha).estimate
      .start,
    "11:40",
    "Alfa moves to slot 2",
  );

  /* ── State, on the day ─────────────────────────────────────────────────── */

  const flip = await call(teacher, "PATCH", `${path}/${alpha.id}/state`, {
    state: "passed",
  });
  assert.equal(flip.status, 200, JSON.stringify(flip.body));
  const after = await call(teacher, "GET", path);
  assert.equal(
    after.body.savedAt,
    restruck.body.savedAt,
    "a state change does not stale the dashboard",
  );
  const done = after.body.presentations.find((p) => p.projectId === ids.alpha);
  assert.equal(done.state, "passed");
  assert.equal(done.estimate, null, "a finished team has no estimate");

  const badState = await call(teacher, "PATCH", `${path}/${alpha.id}/state`, {
    state: "aprobado",
  });
  assert.equal(badState.status, 400);

  /* ── Who may not ───────────────────────────────────────────────────────── */

  // A current-year schedule is every signed-in user's to read.
  const outside = await call(outsider, "GET", path);
  assert.equal(outside.status, 200, "current year: anyone signed in reads it");
  assert.deepEqual(outside.body.mine, []);
  assert.equal(outside.body.classBlocks, undefined, "the picker is staff's");

  const studentPut = await call(
    student,
    "PUT",
    path,
    schedule(saved.body.savedAt),
  );
  assert.equal(studentPut.status, 403, "saving is the teacher's");
  const studentPatch = await call(
    student,
    "PATCH",
    `${path}/${alpha.id}/state`,
    { state: "pending" },
  );
  assert.equal(studentPatch.status, 403);
  const studentPreview = await call(
    student,
    "POST",
    `${path}/preview`,
    schedule(saved.body.savedAt),
  );
  assert.equal(studentPreview.status, 403, "the preview is the editor's");

  // The teacher's preview of what is saved, sent back unchanged, places
  // every team where the read does — and writes nothing.
  const current = (await call(teacher, "GET", path)).body;
  const preview = await call(teacher, "POST", `${path}/preview`, {
    base: current.savedAt,
    blocks: current.blocks.map(({ slots, ...block }) => block),
    presentations: current.presentations.map((row) => ({
      projectId: row.projectId,
      round: row.round,
      pin: row.pin,
    })),
    queueStarts: current.queueStarts,
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const placed = (rows) =>
    rows.map((row) => [row.projectId, row.estimate, row.pinMissed]);
  assert.deepEqual(
    placed(preview.body.presentations),
    placed(current.presentations),
  );
  assert.equal(
    (await call(teacher, "GET", path)).body.savedAt,
    current.savedAt,
    "a preview saves nothing",
  );

  const targets = {
    PUT: path,
    POST: `${path}/preview`,
    PATCH: `${path}/${alpha.id}/state`,
  };
  for (const [method, target] of Object.entries(targets)) {
    const noCsrf = await fetch(`${API}${target}`, {
      method,
      headers: {
        "content-type": "application/json",
        Cookie: `tic_campus_session_dev=${teacher.secret}`,
      },
      body: JSON.stringify({ state: "pending" }),
    });
    assert.equal(noCsrf.status, 403, `${method} without CSRF`);
    assert.equal((await noCsrf.json()).error.code, "csrf_failed");
  }

  const noSession = await fetch(API + path);
  assert.equal(noSession.status, 401, "signed-in only");

  await Promise.all([root.end(), owner.end()]);
}

/** `harness-revisions.mjs`'s seed, plus a Proyecto offering's two teams and
 *  its one weekly module. */
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
    `insert into subject (name, marks) values ('Proyecto', false) returning id`,
  );
  const course = await one(
    `insert into course (name, specialty, academic_year_id)
     values ('NR4A', 'Informática', $1) returning id`,
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
  const student = await user("alu@ort.edu.ar", "Cami", "Alumne");
  const partner = await user("fede@ort.edu.ar", "Fede", "Alumne");
  const orphanStudent = await user("suelte@ort.edu.ar", "Dani", "Suelte");
  const admin = await user("admin@ort.edu.ar", "Eve", "Admin");
  const offering = (
    await one(
      `insert into offering (subject_id, term_id, kind, name)
       values ($1, $2, 'mandatory', null) returning id`,
      [subject.id, term.id],
    )
  ).id;
  await root.query(
    `insert into offering_course (offering_id, course_id) values ($1, $2)`,
    [offering, course.id],
  );
  await root.query(
    `insert into teacher_offering (teacher_id, offering_id) values ($1, $2)`,
    [teacher, offering],
  );
  for (const who of [student, partner]) {
    await root.query(
      `insert into student_course (student_id, course_id) values ($1, $2)`,
      [who, course.id],
    );
  }
  await root.query(
    `insert into offering_time_slot (offering_id, day, slot, classroom) values ($1, 'friday', 3, 'L1')`,
    [offering],
  );
  const project = async (name, slug, adGroup, member) => {
    const id = (
      await one(
        `insert into project (term_id, name, slug, ad_group_name) values ($1, $2, $3, $4) returning id`,
        [term.id, name, slug, adGroup],
      )
    ).id;
    await root.query(
      `insert into project_offering (project_id, term_id, offering_id) values ($1, $2, $3)`,
      [id, term.id, offering],
    );
    await root.query(
      `insert into project_member (project_id, offering_id, user_id, course_id, track)
       values ($1, $2, $3, $4, 'backend')`,
      [id, offering, member, course.id],
    );
    return id;
  };
  const alpha = await project("Alfa", "alfa", "proj-a", student);
  const beta = await project("Beta", "beta", "proj-b", partner);
  const { activate } = await import("../dist/offerings/activation.js");
  const { createDb } = await import("../dist/db/client.js");
  const svc = new Pool({ connectionString: urlFor(BASE, "campus_svc") });
  await activate(createDb(svc), offering, admin);
  await svc.end();
  return { offering, teacher, student, orphanStudent, alpha, beta };
}
