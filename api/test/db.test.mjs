import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { createDb } from "../dist/db/client.js";
import { runMigrations } from "../dist/db/migrate.js";
import { activate, deactivate } from "../dist/offerings/activation.js";
import { capabilitiesFor, NONE } from "../dist/offerings/access.js";
import {
  activeHome,
  homeContent,
  readableArticle,
  useArticle,
} from "../dist/offerings/content.js";
import {
  archiveArticle,
  createArticle,
  listLibrary,
  publishArticle,
  readArticle,
  readVersion,
  saveDraft,
} from "../dist/library/articles.js";
import {
  deleteUnit,
  readProgram,
  writeProgram,
} from "../dist/library/program.js";
import {
  listUploads,
  pathFor,
  readUpload,
  saveUpload,
} from "../dist/library/uploads.js";
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

    // --- slice 5: the library, and what an offering does with it -------------
    // A publish date already past, so `mayRead` lets an anonymous visitor in;
    // relative to now because a literal year eventually stops being the past.
    const PUBLISHED = new Date(Date.now() - 86_400_000);

    // Ordered before the deactivation below, which archives `ids.current` and
    // is what every subtest above depends on not having happened yet.

    await t.test("a library article is written, then published", async () => {
      const created = await createArticle(db, ids.subject, "tp-sql", "TP SQL");
      assert.equal(created.published, false);
      assert.equal(created.hasUnpublishedDraft, false);

      const draft = await saveDraft(
        db,
        ids.subject,
        "tp-sql",
        ids.teacher,
        ":::callout\nOjo con el JOIN\n:::\n",
        null,
      );
      // A second author saving against the draft they loaded is fine; saving
      // against the one *before* it is F12's warning, and it names the author.
      await assert.rejects(
        () => saveDraft(db, ids.subject, "tp-sql", ids.otherTeacher, "x", null),
        /Ana Docente/,
      );
      const second = await saveDraft(
        db,
        ids.subject,
        "tp-sql",
        ids.otherTeacher,
        "# TP SQL\n",
        draft.id,
      );
      assert.notEqual(second.id, draft.id, "every save keeps a revision (F11)");

      const before = await readArticle(db, ids.subject, "tp-sql");
      assert.equal(before.hasUnpublishedDraft, true);
      assert.equal(before.versions.length, 2, "the history to restore from");
      assert.equal(before.versions[0].authorName, "Beto Docente");

      await publishArticle(db, ids.subject, "tp-sql");
      const after = await readArticle(db, ids.subject, "tp-sql");
      assert.equal(after.published, true);
      assert.equal(after.hasUnpublishedDraft, false);

      // Restoring is reading a revision and saving it again — there is no verb.
      const old = await readVersion(db, ids.subject, "tp-sql", draft.id);
      assert.match(old.body, /callout/);
    });

    await t.test("an offering uses it, and a visitor reads it", async () => {
      const [unit] = await writeProgram(db, ids.subject, [
        { title: "Consultas", contents: "# SELECT" },
      ]);
      const home = await activeHome(db, ids.current);
      assert.ok(home, "activated above");
      assert.equal(home.subjectId, ids.subject);

      const article = (await listLibrary(db, ids.subject)).find(
        (a) => a.slug === "tp-sql",
      );
      // This write is the only thing that proves `campus_app` was granted DML
      // on `offering_article` — the barrel is what earns the grant, and a table
      // missing from it typechecks fine and fails here.
      await useArticle(db, home.homeId, ids.subject, article.id, {
        programUnitId: unit.id,
        position: 0,
        publishedAt: null,
        restricted: false,
      });

      // Filed but not published *here*: the teacher sees it, nobody else does.
      const anonHidden = await homeContent(db, ids.current, ids.subject, NONE);
      assert.deepEqual(anonHidden.articles, []);
      assert.equal(anonHidden.program.length, 1, "the program is public");

      const teacherCan = await capabilitiesFor(
        db,
        actor(ids.teacher, ["teacher"]),
        ids.current,
        ids.subject,
      );
      const staffView = await homeContent(
        db,
        ids.current,
        ids.subject,
        teacherCan,
      );
      assert.equal(staffView.articles.length, 1);
      assert.equal(staffView.articles[0].public, false, "flagged, not hidden");

      await useArticle(db, home.homeId, ids.subject, article.id, {
        programUnitId: unit.id,
        position: 0,
        publishedAt: PUBLISHED,
        restricted: false,
      });
      const open = await homeContent(db, ids.current, ids.subject, NONE);
      assert.equal(open.articles.length, 1, "idempotent on (home, article)");
      assert.equal(open.articles[0].unitId, unit.id);

      const read = await readableArticle(db, ids.current, "tp-sql", NONE);
      assert.match(
        read.body,
        /# TP SQL/,
        "the published version, not the draft",
      );
    });

    await t.test("restricted is the enrolled and the staff", async () => {
      const home = await activeHome(db, ids.current);
      const article = (await listLibrary(db, ids.subject)).find(
        (a) => a.slug === "tp-sql",
      );
      await useArticle(db, home.homeId, ids.subject, article.id, {
        programUnitId: null,
        position: 0,
        publishedAt: PUBLISHED,
        restricted: true,
      });

      // Absent, not forbidden: a 403 would confirm the solution is there.
      assert.equal(
        await readableArticle(db, ids.current, "tp-sql", NONE),
        null,
      );

      const studentCan = await capabilitiesFor(
        db,
        actor(ids.student, ["student"]),
        ids.current,
        ids.subject,
      );
      assert.equal(studentCan.seeOwnMarks, true, "enrolment, not roles[]");
      const forClass = await readableArticle(
        db,
        ids.current,
        "tp-sql",
        studentCan,
      );
      assert.match(forClass.body, /# TP SQL/);

      // The student of no offering: enrolled in a course nothing is served to.
      const orphanCan = await capabilitiesFor(
        db,
        actor(ids.orphanStudent, ["student"]),
        ids.current,
        ids.subject,
      );
      assert.equal(
        await readableArticle(db, ids.current, "tp-sql", orphanCan),
        null,
      );
    });

    await t.test(
      "a unit in use cannot be deleted out from under it",
      async () => {
        const [unit] = await readProgram(db, ids.subject);
        const home = await activeHome(db, ids.current);
        const article = (await listLibrary(db, ids.subject)).find(
          (a) => a.slug === "tp-sql",
        );
        await useArticle(db, home.homeId, ids.subject, article.id, {
          programUnitId: unit.id,
          position: 0,
          publishedAt: PUBLISHED,
          restricted: false,
        });
        // A foreign-key violation would be a 500 about nothing the teacher did.
        await assert.rejects(
          () => deleteUnit(db, ids.subject, unit.id),
          /artículos/,
        );

        // And the whole-list PUT does not delete: a colleague's unit added after
        // this teacher loaded the page survives being left out of their save.
        const kept = await writeProgram(db, ids.subject, [
          { id: unit.id, title: "Consultas", contents: "# SELECT" },
        ]);
        assert.equal(kept.length, 1);
        const another = await writeProgram(db, ids.subject, [
          { id: unit.id, title: "Consultas", contents: "# SELECT" },
          { title: "Índices", contents: "" },
        ]);
        assert.equal(another.length, 2);
        assert.deepEqual(
          (await writeProgram(db, ids.subject, [])).map((u) => u.title),
          ["Consultas", "Índices"],
          "an empty save removes nothing",
        );
      },
    );

    await t.test(
      "an archived article stops being served everywhere",
      async () => {
        await archiveArticle(db, ids.subject, "tp-sql");
        assert.equal(
          await readableArticle(db, ids.current, "tp-sql", NONE),
          null,
        );
        assert.deepEqual(await listLibrary(db, ids.subject), []);

        // The slug is not burned: the unique index is total, so creating it again
        // revives the same row rather than colliding with it forever.
        const back = await createArticle(
          db,
          ids.subject,
          "tp-sql",
          "TP SQL (v2)",
        );
        assert.equal(back.title, "TP SQL (v2)");
        assert.equal(
          back.published,
          true,
          "its published version came back too",
        );
        // A live one is still a conflict.
        await assert.rejects(
          () => createArticle(db, ids.subject, "tp-sql", "otra vez"),
          /Ya hay un artículo/,
        );
      },
    );

    // F9. The only place the new table's GRANT is exercised at all: every call
    // below goes through `campus_svc`, and a table missing from the schema
    // barrel fails here with `permission denied` rather than at typecheck.
    await t.test("a file is written to the volume and indexed", async () => {
      const dir = await mkdtemp(join(tmpdir(), "campus-uploads-"));
      t.after(() => rm(dir, { recursive: true, force: true }));
      const bytes = Buffer.from("%PDF-1.4 no es un PDF, pero alcanza\n");

      const saved = await saveUpload(db, dir, ids.subject, ids.teacher, {
        filename: "Guía de TPs.pdf",
        mediaType: "application/pdf",
        bytes,
      });
      assert.equal(saved.size, bytes.byteLength);
      assert.equal(
        saved.sha256,
        createHash("sha256").update(bytes).digest("hex"),
      );
      assert.deepEqual(await readFile(pathFor(dir, saved.id)), bytes);
      assert.deepEqual(
        await readdir(dir),
        [saved.id],
        "the staging file is renamed, not left beside it",
      );

      assert.deepEqual(await readUpload(db, saved.id), {
        filename: "Guía de TPs.pdf",
        mediaType: "application/pdf",
      });
      assert.equal(
        await readUpload(db, "00000000-0000-4000-8000-000000000000"),
        null,
      );

      // Subject-scoped (F9): another subject's library does not list it.
      assert.deepEqual(
        (await listUploads(db, ids.subject)).map((u) => u.id),
        [saved.id],
      );
      assert.deepEqual(await listUploads(db, ids.proyecto), []);
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
        // Archiving, not deleting (F36): the article the offering was using is
        // still filed, and the home is still there to come back to. Nothing
        // else exercises `listForAdmin`'s archived-is-not-activated expression,
        // because every other read joins the home inner.
        assert.deepEqual(
          (await listForAdmin(db, 2027))
            .map((o) => [o.offeringId, o.activated])
            .sort((a, b) => a[0] - b[0]),
          [
            [ids.current, false],
            [ids.optional, false],
          ].sort((a, b) => a[0] - b[0]),
        );
        assert.equal(
          await readableArticle(db, ids.current, "tp-sql", NONE),
          null,
          "an archived home serves nothing",
        );

        assert.equal(await activate(db, ids.current, ids.admin), true);
        assert.deepEqual(
          (await listActivated(db, 2027)).map((o) => o.offeringId),
          [ids.current],
          "re-activating brings the same home back",
        );
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
