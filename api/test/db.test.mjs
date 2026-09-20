import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { createDb } from "../dist/db/client.js";
import { runMigrations } from "../dist/db/migrate.js";
import { activate, deactivate } from "../dist/offerings/activation.js";
import { capabilitiesFor } from "../dist/offerings/access.js";
import {
  listActivated,
  listForAdmin,
  listMine,
  resolveBySlug,
} from "../dist/offerings/catalog.js";
import {
  applyCampusRoles,
  applyDirectoryStandins,
  urlFor,
} from "./support/directory/apply.mjs";

/**
 * The half of slice 4 no unit test can reach: the joins, and the grants.
 *
 * Everything here is one SQL statement away from being subtly wrong in a way
 * that typechecks — `enrollment` where `student_course` was meant, a `left` join
 * where an `inner` one hides an unactivated offering, a view campus reads and
 * nobody granted. So it runs against a real Postgres carrying tic-auth's real
 * shape, as the two roles production uses.
 *
 * **Skipped when `TEST_DATABASE_URL` is unset**, which is what keeps `pnpm test`
 * a thing that needs no database. `make test-db` is what sets it, around a
 * throwaway container it removes afterwards.
 */

const BASE = process.env.TEST_DATABASE_URL;

test(
  "the directory read layer, against a real database",
  { skip: BASE ? false : "set TEST_DATABASE_URL (or run `make test-db`)" },
  async (t) => {
    const root = new Pool({ connectionString: BASE });
    const owner = new Pool({ connectionString: urlFor(BASE, "campus_owner") });
    const svc = new Pool({ connectionString: urlFor(BASE, "campus_svc") });
    const db = createDb(svc);
    t.after(async () => {
      await Promise.all([root.end(), owner.end(), svc.end()]);
    });

    await applyDirectoryStandins(root);
    await applyCampusRoles(root);
    // As `campus_owner`, exactly as `make migrate` does. If a generated
    // migration ever tries to create something outside `campus`, this is where
    // it stops being a deploy-day discovery.
    await runMigrations(owner);

    const ids = await seed(root);

    await t.test("the runtime role got its DML from the migrator", async () => {
      // `grantRuntimeRole` skips itself where `campus_app` does not exist, which
      // is every laptop — so this assertion is the only thing that ever takes
      // the branch production takes.
      assert.equal(await activate(db, ids.current, ids.admin), true);
      assert.equal(
        await activate(db, ids.current, ids.admin),
        false,
        "idempotent",
      );
      assert.equal(await activate(db, ids.pastYear, ids.admin), true);
    });

    await t.test("an unactivated offering has no campus presence", async () => {
      const activated = await listActivated(db, 2027);
      assert.deepEqual(
        activated.map((o) => o.offeringId),
        [ids.current],
        "the optional offering was never activated, so it is not here",
      );
    });

    await t.test(
      "the year defaults to is_current, not to a clock",
      async () => {
        const current = await listActivated(db, undefined);
        assert.deepEqual(
          current.map((o) => o.offeringId),
          [ids.current],
          "2026 is activated too, and is not the current year",
        );
        const past = await listActivated(db, 2026);
        assert.deepEqual(
          past.map((o) => o.offeringId),
          [ids.pastYear],
        );
      },
    );

    await t.test(
      "courses come from offering_course, and make the slug",
      async () => {
        const [offering] = await listActivated(db, 2027);
        assert.deepEqual(offering.courseNames, ["NR5A", "NR5B"]);
        assert.equal(offering.path, "/2027/bases-de-datos/nr5a-nr5b");
        assert.equal(offering.subjectName, "Bases de Datos");
      },
    );

    await t.test(
      "a public URL resolves, and a wrong one does not",
      async () => {
        const found = await resolveBySlug(
          db,
          2027,
          "bases-de-datos",
          "nr5a-nr5b",
        );
        assert.equal(found?.offeringId, ids.current);
        assert.equal(
          await resolveBySlug(db, 2027, "bases-de-datos", "nr5z"),
          null,
        );
        assert.equal(
          await resolveBySlug(db, 2025, "bases-de-datos", "nr5a-nr5b"),
          null,
        );
      },
    );

    await t.test(
      "a teacher sees what teacher_offering says they teach",
      async () => {
        const mine = await listMine(db, actor(ids.teacher, ["teacher"]), 2027);
        assert.deepEqual(
          mine.map((o) => [o.offeringId, o.roles]),
          [[ids.current, ["teacher"]]],
        );
      },
    );

    await t.test(
      "a student sees what enrollment says they are taking",
      async () => {
        const mine = await listMine(db, actor(ids.student, ["student"]), 2027);
        assert.deepEqual(
          mine.map((o) => [o.offeringId, o.roles]),
          [[ids.current, ["student"]]],
        );
      },
    );

    await t.test(
      "a student whose course has no offering_course sees nothing",
      async () => {
        // tic-auth's `0006` measured this on the real roster: 129 of 356 current
        // students were in courses with no `offering_course` rows. It is a
        // directory row to add, and campus must not paper over it with a UNION
        // against `student_course`.
        const mine = await listMine(
          db,
          actor(ids.orphanStudent, ["student"]),
          2027,
        );
        assert.deepEqual(mine, []);
      },
    );

    await t.test(
      "which half runs is decided by roles[], not by the tables",
      async () => {
        // The teacher is enrolled in their own offering, as the real snapshot has
        // an admin enrolled in one. Holding no `student` role, they still see it
        // as something they teach and not as something they study.
        const mine = await listMine(db, actor(ids.teacher, ["teacher"]), 2027);
        assert.deepEqual(mine[0].roles, ["teacher"]);
        const both = await listMine(
          db,
          actor(ids.teacher, ["teacher", "student"]),
          2027,
        );
        assert.deepEqual(both[0].roles, ["teacher", "student"]);
      },
    );

    await t.test("capabilities come from the directory (F5)", async () => {
      // This teacher is also enrolled in their own offering, and `seeOwnMarks`
      // is true for exactly that reason: it asks whether a row names them, not
      // whether the token calls them a student. `listMine` makes the opposite
      // call for the opposite question — see the note on `Capabilities`.
      const teacher = await capabilitiesFor(
        db,
        actor(ids.teacher, ["teacher"]),
        ids.current,
        ids.subject,
      );
      assert.deepEqual(teacher, {
        editLibrary: true,
        manageOffering: true,
        seeOwnMarks: true,
      });

      // The same person on an offering they neither teach nor take.
      const elsewhere = await capabilitiesFor(
        db,
        actor(ids.teacher, ["teacher"]),
        ids.optional,
        ids.proyecto,
      );
      assert.deepEqual(elsewhere, {
        editLibrary: false,
        manageOffering: false,
        seeOwnMarks: false,
      });

      // Teaches no offering of this subject, and is enrolled in one of them.
      const student = await capabilitiesFor(
        db,
        actor(ids.student, ["student"]),
        ids.current,
        ids.subject,
      );
      assert.deepEqual(student, {
        editLibrary: false,
        manageOffering: false,
        seeOwnMarks: true,
      });

      // Teaches another offering of the same subject and none of this one: the
      // library is the subject's, the gradebook is the offering's.
      const other = await capabilitiesFor(
        db,
        actor(ids.otherTeacher, ["teacher"]),
        ids.current,
        ids.subject,
      );
      assert.deepEqual(other, {
        editLibrary: true,
        manageOffering: false,
        seeOwnMarks: false,
      });

      // `admin-hosting` is tic-hosting's operators and grants nothing here.
      const hosting = await capabilitiesFor(
        db,
        actor(ids.admin, ["admin-hosting"]),
        ids.current,
        ids.subject,
      );
      assert.deepEqual(hosting, {
        editLibrary: false,
        manageOffering: false,
        seeOwnMarks: false,
      });
    });

    await t.test(
      "the admin listing shows what is not activated yet",
      async () => {
        const all = await listForAdmin(db, 2027);
        assert.deepEqual(
          all
            .map((o) => [o.offeringId, o.activated])
            .sort((a, b) => a[0] - b[0]),
          [
            [ids.current, true],
            [ids.optional, false],
          ].sort((a, b) => a[0] - b[0]),
        );
        assert.equal(await deactivate(db, ids.current), true);
        assert.equal(await deactivate(db, ids.current), false, "idempotent");
        assert.deepEqual(await listActivated(db, 2027), []);
      },
    );
  },
);

function actor(userId, roles) {
  return { userId, roles, isAdmin: roles.includes("admin") };
}

/**
 * One subject taught to two courses in 2027 and one in 2026, a teacher of each,
 * a student in one of the courses, and a student in a course no offering is
 * served to. Small on purpose: every row here exists to make one assertion
 * above possible.
 */
async function seed(root) {
  const one = async (sql, values) => (await root.query(sql, values)).rows[0];

  const y2027 = await one(
    `insert into academic_year (year, starts_on, ends_on, is_current)
     values (2027, '2027-03-01', '2027-12-15', true) returning id`,
  );
  const y2026 = await one(
    `insert into academic_year (year, starts_on, ends_on, is_current)
     values (2026, '2026-03-01', '2026-12-15', false) returning id`,
  );
  const term = async (yearId, kind) =>
    (
      await one(
        `insert into term (academic_year_id, kind, starts_on, ends_on)
         values ($1, $2, '2027-03-01', '2027-12-15') returning id`,
        [yearId, kind],
      )
    ).id;

  const subject = await one(
    `insert into subject (name, marks) values ('Bases de Datos', true) returning id`,
  );
  const proyecto = await one(
    `insert into subject (name, marks) values ('Proyecto', false) returning id`,
  );

  const course = async (name, yearId) =>
    (
      await one(
        `insert into course (name, specialty, academic_year_id)
         values ($1, 'Informática', $2) returning id`,
        [name, yearId],
      )
    ).id;
  const nr5a = await course("NR5A", y2027.id);
  const nr5b = await course("NR5B", y2027.id);
  // The course tic-auth's `0006` is about: real students, no offering serves it.
  const nr5e = await course("NR5E", y2027.id);
  const old = await course("NR4A", y2026.id);

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
  const orphanStudent = await user("huerfane@ort.edu.ar", "Dani", "Alumne");
  const admin = await user("admin@ort.edu.ar", "Eve", "Admin");

  const offering = async (subjectId, termId, kind, name = null) =>
    (
      await one(
        `insert into offering (subject_id, term_id, kind, name)
         values ($1, $2, $3, $4) returning id`,
        [subjectId, termId, kind, name],
      )
    ).id;
  const t2027 = await term(y2027.id, "full");
  const t2026 = await term(y2026.id, "full");
  const current = await offering(subject.id, t2027, "mandatory");
  const optional = await offering(proyecto.id, t2027, "optional");
  const pastYear = await offering(subject.id, t2026, "mandatory");

  const serves = (offeringId, courseId) =>
    root.query(
      `insert into offering_course (offering_id, course_id) values ($1, $2)`,
      [offeringId, courseId],
    );
  await serves(current, nr5a);
  await serves(current, nr5b);
  await serves(optional, nr5a);
  await serves(pastYear, old);

  const teaches = (teacherId, offeringId) =>
    root.query(
      `insert into teacher_offering (teacher_id, offering_id) values ($1, $2)`,
      [teacherId, offeringId],
    );
  await teaches(teacher, current);
  // Another offering of the SAME subject: enough for the library, not for the
  // gradebook.
  await teaches(otherTeacher, pastYear);

  const enrolls = (studentId, courseId) =>
    root.query(
      `insert into student_course (student_id, course_id) values ($1, $2)`,
      [studentId, courseId],
    );
  await enrolls(student, nr5a);
  await enrolls(orphanStudent, nr5e);
  // The teacher is in the course too, which is what makes the roles[] gate
  // observable: `enrollment` will report them and `listMine` must not.
  await enrolls(teacher, nr5a);

  return {
    subject: subject.id,
    proyecto: proyecto.id,
    current,
    optional,
    pastYear,
    teacher,
    otherTeacher,
    student,
    orphanStudent,
    admin,
  };
}
