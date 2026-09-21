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
  removeUse,
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
  deleteGroup,
  deleteScale,
  deleteTerm,
  readSetup,
  SCALE_PRESETS,
  writeSetup,
} from "../dist/offerings/gradebook.js";
import {
  gradebook,
  listActivities,
  myResults,
  saveResults,
} from "../dist/offerings/results.js";
import {
  answerRequest,
  fileRequests,
  listRequests,
  myRevisions,
} from "../dist/offerings/revisions.js";
import {
  computeBothViews,
  computeMarks,
  publishedOnly,
} from "../dist/offerings/marks.js";
import {
  myOfficialGrades,
  readOfficialGrades,
  saveOfficialGrades,
} from "../dist/offerings/official-grades.js";
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

    // A use with no grading metadata: a theory note, which is what every
    // article was before slice 7 (F18). `useArticle` writes the whole row, so
    // the half that is absent has to be spelled out rather than left off.
    const NOT_GRADED = {
      offeringGroupId: null,
      offeringTermId: null,
      valueType: null,
      offeringScaleId: null,
      dueAt: null,
      resultsPublishedAt: null,
      // F23, and it grew here for the reason this object exists: TypeScript
      // enforces the ten-field `UseInput` and a `.mjs` test does not, so a new
      // grading column that nobody spells out here reaches `useArticle` as
      // `undefined` and fails somewhere less obvious.
      covers: [],
    };

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
        ...NOT_GRADED,
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
        ...NOT_GRADED,
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
        ...NOT_GRADED,
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
          ...NOT_GRADED,
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

    // --- slice 7: the gradebook floor ----------------------------------------
    // What the slices above left here: `tp-sql` exists (archived and revived,
    // so it is published), the offering uses it under the "Consultas" unit with
    // `publishedAt` in the past, and it is not an activity — no `valueType`.
    //
    // Every call below writes through `campus_svc`, which is the only thing
    // that proves `campus_app` was granted DML on the five new tables: the
    // schema barrel is what earns the grant, and a table missing from it
    // typechecks fine and fails here with `permission denied`.
    //
    // Still ordered before the deactivation below.

    /** The offering's own setup, re-read fresh, since most subtests want it. */
    const setupNow = async () => {
      const home = await activeHome(db, ids.current);
      return { home, setup: await readSetup(db, home.homeId) };
    };

    await t.test("an offering names its groups, terms and scales", async () => {
      const home = await activeHome(db, ids.current);
      const written = await writeSetup(db, home.homeId, {
        groups: [{ name: "tps" }, { name: "clase" }],
        terms: [{ name: "Primer trimestre" }],
        scales: [SCALE_PRESETS[0]],
      });

      assert.deepEqual(
        written.groups.map((g) => [g.name, g.position]),
        [
          ["tps", 0],
          ["clase", 1],
        ],
        "array order is position, and it is never client-supplied",
      );
      assert.equal(written.scales[0].name, "B / MB / E");
      assert.deepEqual(
        written.scales[0].levels.map((l) => l.name),
        ["B", "MB", "E"],
      );
      // `numeric` comes back from node-postgres as a string unless the column
      // says otherwise. This is the assertion that catches losing `mode`.
      assert.equal(typeof written.scales[0].levels[0].value, "number");
      assert.equal(written.scales[0].levels[1].value, 8.5);

      // It never deletes (F15's rule): a teacher who loaded the panel before a
      // colleague added the term saves without it, and it survives.
      const after = await writeSetup(db, home.homeId, {
        groups: [{ id: written.groups[0].id, name: "trabajos prácticos" }],
        terms: [],
        scales: [],
      });
      assert.equal(after.terms.length, 1, "the term nobody sent is still here");
      assert.equal(after.scales.length, 1);
      assert.equal(
        after.groups.find((g) => g.id === written.groups[0].id).name,
        "trabajos prácticos",
        "renamed in place: the id an activity points at does not move",
      );
      assert.equal(after.groups.length, 2);

      // An id from another offering would otherwise be reparented by the
      // update, which is how a teacher renames somebody else's group.
      await assert.rejects(
        () =>
          writeSetup(db, home.homeId, {
            groups: [
              { id: "00000000-0000-4000-8000-000000000000", name: "ajeno" },
            ],
            terms: [],
            scales: [],
          }),
        /no es de esta materia/,
      );
    });

    await t.test("two names cannot be swapped in one save", async () => {
      // `(offering_home_id, name)` is unique, and the database checks each
      // UPDATE as it lands — so a swap raises on the first of the two. The
      // answer is a 409 that says what to do, not a rename through a temporary
      // name campus invented.
      const { home, setup } = await setupNow();
      const [first, second] = setup.groups;
      await assert.rejects(
        () =>
          writeSetup(db, home.homeId, {
            groups: [
              { id: first.id, name: second.name },
              { id: second.id, name: first.name },
            ],
            terms: [],
            scales: [],
          }),
        /en dos pasos/,
      );
      const rolled = await readSetup(db, home.homeId);
      assert.deepEqual(
        rolled.groups.map((g) => g.name),
        setup.groups.map((g) => g.name),
        "the whole save is one transaction, so a refusal changes nothing",
      );
    });

    await t.test(
      "an activity is an article with grading metadata",
      async () => {
        const { home, setup } = await setupNow();
        const article = (await listLibrary(db, ids.subject)).find(
          (a) => a.slug === "tp-sql",
        );

        // A theory note is an article without the metadata (F18), so a half-filled
        // row is refused rather than stored as a third thing.
        await assert.rejects(
          () =>
            useArticle(db, home.homeId, ids.subject, article.id, {
              programUnitId: null,
              position: 0,
              publishedAt: PUBLISHED,
              restricted: false,
              ...NOT_GRADED,
              valueType: "numeric",
            }),
          /trimestre/,
          "every activity belongs to a term (F21)",
        );
        await assert.rejects(
          () =>
            useArticle(db, home.homeId, ids.subject, article.id, {
              programUnitId: null,
              position: 0,
              publishedAt: PUBLISHED,
              restricted: false,
              ...NOT_GRADED,
              valueType: "scale",
              offeringTermId: setup.terms[0].id,
            }),
          /escala/,
          "a scaled activity needs its scale",
        );

        await useArticle(db, home.homeId, ids.subject, article.id, {
          programUnitId: null,
          position: 0,
          publishedAt: PUBLISHED,
          restricted: false,
          ...NOT_GRADED,
          offeringGroupId: setup.groups[0].id,
          offeringTermId: setup.terms[0].id,
          valueType: "numeric",
          dueAt: PUBLISHED,
        });

        const grid = await gradebook(db, home.homeId, ids.current);
        assert.equal(grid.activities.length, 1);
        assert.equal(grid.activities[0].valueType, "numeric");
        assert.equal(grid.activities[0].articleId, article.id);
        assert.equal(
          grid.activities[0].resultsPublishedAt,
          null,
          "the statement is out; the marks are a separate date (F24)",
        );
        // The enrolled, and only them, until somebody leaves.
        assert.deepEqual(
          grid.students.map((s) => [s.surname, s.enrolled]),
          [
            ["Alumne", true],
            ["Docente", true],
          ],
          "the teacher is enrolled in their own offering too",
        );
        assert.deepEqual(grid.results, []);
      },
    );

    await t.test(
      "a group, term or scale in use cannot be deleted",
      async () => {
        const { home, setup } = await setupNow();
        // A foreign-key violation would be a 500 about nothing the teacher did.
        await assert.rejects(
          () => deleteGroup(db, home.homeId, setup.groups[0].id),
          /actividades/,
        );
        await assert.rejects(
          () => deleteTerm(db, home.homeId, setup.terms[0].id),
          /actividades/,
        );

        // One nothing points at goes, which is also the DELETE grant.
        const spare = setup.groups.find((g) => g.name === "clase");
        await deleteGroup(db, home.homeId, spare.id);
        const left = await readSetup(db, home.homeId);
        assert.equal(left.groups.length, 1);
        await assert.rejects(
          () => deleteGroup(db, home.homeId, spare.id),
          /No encontramos/,
        );
      },
    );

    await t.test("a result is one row per student and activity", async () => {
      const { home, setup } = await setupNow();
      const grid = await gradebook(db, home.homeId, ids.current);
      const activity = grid.activities[0].id;
      const cell = { studentId: ids.student, activityId: activity };

      await saveResults(
        db,
        home.homeId,
        [{ ...cell, clear: false, value: 8.5, feedback: "muy bien" }],
        ids.teacher,
      );
      let marks = (await gradebook(db, home.homeId, ids.current)).results;
      assert.equal(marks.length, 1);
      assert.equal(typeof marks[0].value, "number", "numeric mode again");
      assert.equal(marks[0].value, 8.5);
      assert.equal(marks[0].recordedBy, ids.teacher);

      // Unique on (activity, student): saving again overwrites, it does not
      // accumulate, and the marker becomes whoever set it last.
      await saveResults(
        db,
        home.homeId,
        [{ ...cell, clear: false, value: 9, feedback: null }],
        ids.admin,
      );
      marks = (await gradebook(db, home.homeId, ids.current)).results;
      assert.equal(marks.length, 1);
      assert.equal(marks[0].value, 9);
      assert.equal(marks[0].feedback, null);
      assert.equal(marks[0].recordedBy, ids.admin);

      // A cleared cell is a row that is not there (F20's "blank"), not a row
      // with a null in it.
      await saveResults(
        db,
        home.homeId,
        [{ ...cell, clear: true, feedback: null }],
        ids.teacher,
      );
      assert.deepEqual(
        (await gradebook(db, home.homeId, ids.current)).results,
        [],
      );

      // Put it back for the subtests below.
      await saveResults(
        db,
        home.homeId,
        [{ ...cell, clear: false, value: 9, feedback: "muy bien" }],
        ids.teacher,
      );
      assert.ok(setup.terms[0]);
    });

    await t.test("a result refuses what is not this offering's", async () => {
      const { home } = await setupNow();
      const grid = await gradebook(db, home.homeId, ids.current);
      const activity = grid.activities[0].id;

      // Enrolment is checked when a result is created (F38). NR5E is served by
      // no offering, so this student is enrolled in nothing at all.
      await assert.rejects(
        () =>
          saveResults(
            db,
            home.homeId,
            [
              {
                studentId: ids.orphanStudent,
                activityId: activity,
                clear: false,
                value: 8,
                feedback: null,
              },
            ],
            ids.teacher,
          ),
        /no cursa/,
      );

      // The route gates the offering in the path; the activity ids come from
      // the body. Without this a teacher writes marks onto another offering's
      // activity.
      await assert.rejects(
        () =>
          saveResults(
            db,
            home.homeId,
            [
              {
                studentId: ids.student,
                activityId: "00000000-0000-4000-8000-000000000000",
                clear: false,
                value: 8,
                feedback: null,
              },
            ],
            ids.teacher,
          ),
        /no es de esta materia/,
      );

      // And the value has to be the kind the activity asks for.
      await assert.rejects(
        () =>
          saveResults(
            db,
            home.homeId,
            [
              {
                studentId: ids.student,
                activityId: activity,
                clear: false,
                done: true,
                feedback: null,
              },
            ],
            ids.teacher,
          ),
        /1 a 10/,
      );
    });

    await t.test(
      "done and a scale land in the same numeric column",
      async () => {
        const { home, setup } = await setupNow();
        const scale = setup.scales[0];
        const term = setup.terms[0];

        const asistencia = await createArticle(
          db,
          ids.subject,
          "clase-3",
          "Clase 3",
        );
        const oral = await createArticle(db, ids.subject, "oral", "Oral");
        const use = (articleId, extra) =>
          useArticle(db, home.homeId, ids.subject, articleId, {
            programUnitId: null,
            position: 1,
            publishedAt: PUBLISHED,
            restricted: false,
            ...NOT_GRADED,
            offeringTermId: term.id,
            ...extra,
          });
        await use(asistencia.id, { valueType: "done" });
        await use(oral.id, { valueType: "scale", offeringScaleId: scale.id });

        const grid = await gradebook(db, home.homeId, ids.current);
        const bySlug = new Map(grid.activities.map((a) => [a.slug, a]));
        const mb = scale.levels.find((l) => l.name === "MB");

        await saveResults(
          db,
          home.homeId,
          [
            {
              studentId: ids.student,
              activityId: bySlug.get("clase-3").id,
              clear: false,
              done: false,
              feedback: null,
            },
            {
              studentId: ids.student,
              activityId: bySlug.get("oral").id,
              clear: false,
              scaleLevelId: mb.id,
              feedback: null,
            },
          ],
          ids.teacher,
        );

        const marks = new Map(
          (await gradebook(db, home.homeId, ids.current)).results.map((r) => [
            r.activityId,
            r,
          ]),
        );
        assert.equal(
          marks.get(bySlug.get("clase-3").id).value,
          0,
          "not done is 0, and a 0 is a row: the falsy reading would delete it",
        );
        assert.equal(marks.get(bySlug.get("oral").id).value, 8.5);
        assert.equal(
          marks.get(bySlug.get("oral").id).scaleLevelId,
          mb.id,
          "the level is kept for display; the number is what aggregates (F38)",
        );

        // A level from another scale is not a level of this activity's scale.
        await assert.rejects(
          () =>
            saveResults(
              db,
              home.homeId,
              [
                {
                  studentId: ids.student,
                  activityId: bySlug.get("oral").id,
                  clear: false,
                  scaleLevelId: "00000000-0000-4000-8000-000000000000",
                  feedback: null,
                },
              ],
              ids.teacher,
            ),
          /no es de la escala/,
        );

        // Moving what a level is worth moves the marks given on it. Without this
        // the display changes and the mark does not, because a result stores the
        // number and not the level.
        await writeSetup(db, home.homeId, {
          groups: [],
          terms: [],
          scales: [
            {
              id: scale.id,
              name: scale.name,
              levels: scale.levels.map((l) =>
                l.id === mb.id ? { ...l, value: 9.5 } : l,
              ),
            },
          ],
        });
        const moved = (
          await gradebook(db, home.homeId, ids.current)
        ).results.find((r) => r.activityId === bySlug.get("oral").id);
        assert.equal(moved.value, 9.5);
        assert.equal(moved.scaleLevelId, mb.id, "still the same level");
      },
    );

    await t.test("a class sees its marks only once published", async () => {
      const { home, setup } = await setupNow();
      const grid = await gradebook(db, home.homeId, ids.current);
      const tp = grid.activities.find((a) => a.slug === "tp-sql");

      assert.deepEqual(
        await myResults(db, home.homeId, ids.student),
        [],
        "the statement is out and the marks are not (F24)",
      );

      const publish = (resultsPublishedAt) =>
        useArticle(db, home.homeId, ids.subject, tp.articleId, {
          programUnitId: null,
          position: 0,
          publishedAt: PUBLISHED,
          restricted: false,
          ...NOT_GRADED,
          offeringGroupId: setup.groups[0].id,
          offeringTermId: setup.terms[0].id,
          valueType: "numeric",
          dueAt: PUBLISHED,
          resultsPublishedAt,
        });

      await publish(new Date(Date.now() + 86_400_000));
      assert.deepEqual(
        await myResults(db, home.homeId, ids.student),
        [],
        "a date that has not arrived has not arrived",
      );

      await publish(PUBLISHED);
      const mine = await myResults(db, home.homeId, ids.student);
      const tpMine = mine.find((r) => r.slug === "tp-sql");
      assert.equal(tpMine.value, 9);
      assert.equal(tpMine.feedback, "muy bien");
      assert.equal(tpMine.scaleLevel, null, "a numeric mark names no level");
      assert.deepEqual(
        await myResults(db, home.homeId, ids.orphanStudent),
        [],
        "these are one student's own marks and nobody else's",
      );

      // Hiding the statement again does not take back the marks (F24). A
      // student watching them vanish could not tell that from a mistake.
      await useArticle(db, home.homeId, ids.subject, tp.articleId, {
        programUnitId: null,
        position: 0,
        publishedAt: null,
        restricted: false,
        ...NOT_GRADED,
        offeringGroupId: setup.groups[0].id,
        offeringTermId: setup.terms[0].id,
        valueType: "numeric",
        dueAt: PUBLISHED,
        resultsPublishedAt: PUBLISHED,
      });
      assert.equal(
        (await myResults(db, home.homeId, ids.student)).length,
        mine.length,
      );
      assert.equal(
        await readableArticle(db, ids.current, "tp-sql", NONE),
        null,
        "and the statement really is hidden",
      );
    });

    await t.test("an activity with marks cannot be un-graded", async () => {
      const { home, setup } = await setupNow();
      const tp = (
        await gradebook(db, home.homeId, ids.current)
      ).activities.find((a) => a.slug === "tp-sql");
      const theoryNote = {
        programUnitId: null,
        position: 0,
        publishedAt: PUBLISHED,
        restricted: false,
        ...NOT_GRADED,
      };

      // The article editor saves the panel it knows about and leaves the
      // grading half off. The row is written whole, so this would strand the
      // marks on something that is no longer an activity — and unlike an
      // article (F11) there is no version history to bring them back.
      await assert.rejects(
        () =>
          useArticle(db, home.homeId, ids.subject, tp.articleId, theoryNote),
        /ya tiene notas/,
      );
      await assert.rejects(
        () =>
          useArticle(db, home.homeId, ids.subject, tp.articleId, {
            ...theoryNote,
            offeringTermId: setup.terms[0].id,
            valueType: "done",
          }),
        /ya tiene notas/,
        "changing the type is the same problem",
      );

      // Nor can it be removed from the offering: that is a real DELETE, and the
      // foreign key would surface as a 500 about nothing the teacher did.
      await assert.rejects(
        () => removeUse(db, home.homeId, tp.articleId),
        /tiene notas/,
      );

      // An activity nobody has marked is still a teacher's to change.
      const oral = (
        await gradebook(db, home.homeId, ids.current)
      ).activities.find((a) => a.slug === "oral");
      await saveResults(
        db,
        home.homeId,
        [
          {
            studentId: ids.student,
            activityId: oral.id,
            clear: true,
            feedback: null,
          },
        ],
        ids.teacher,
      );
      await useArticle(db, home.homeId, ids.subject, oral.articleId, {
        ...theoryNote,
        position: 1,
      });
      assert.equal(
        (await gradebook(db, home.homeId, ids.current)).activities.some(
          (a) => a.slug === "oral",
        ),
        false,
        "no value type, no activity (F18)",
      );
    });

    await t.test("a student who left still has their marks", async () => {
      // F38 says a result carries no course and a later unenrolment leaves it
      // standing. The grid has to keep showing them, or the teacher cannot see
      // — let alone fix — the mark of somebody who transferred out in April.
      // Last of this block: it changes the roster for everything after it.
      const { home } = await setupNow();
      const tp = (
        await gradebook(db, home.homeId, ids.current)
      ).activities.find((a) => a.slug === "tp-sql");
      await saveResults(
        db,
        home.homeId,
        [
          {
            studentId: ids.teacher,
            activityId: tp.id,
            clear: false,
            value: 7,
            feedback: null,
          },
        ],
        ids.admin,
      );

      await root.query(
        `delete from student_course where student_id = $1 and course_id = $2`,
        [ids.teacher, ids.nr5a],
      );

      const grid = await gradebook(db, home.homeId, ids.current);
      assert.deepEqual(
        grid.students.map((s) => [s.surname, s.enrolled]),
        [
          ["Alumne", true],
          ["Docente", false],
        ],
        "flagged, not hidden",
      );
      assert.equal(
        grid.results.filter((r) => r.studentId === ids.teacher).length,
        1,
      );

      // And the mark is still writable, which is the half a plain enrolment
      // gate would have refused.
      await saveResults(
        db,
        home.homeId,
        [
          {
            studentId: ids.teacher,
            activityId: tp.id,
            clear: false,
            value: 8,
            feedback: null,
          },
        ],
        ids.admin,
      );
      assert.equal(
        (await gradebook(db, home.homeId, ids.current)).results.find(
          (r) => r.studentId === ids.teacher,
        ).value,
        8,
      );
    });

    // --- slice 8: a mark is computed (F20, F40) ------------------------------
    //
    // The group here is called `trabajos prácticos` by now, renamed by the
    // first subtest of slice 7 — a space and an accent, which is exactly the
    // name F39's settled answer has to survive, and the reason a formula can
    // quote a name instead of carrying a key column for it.
    //
    // Still ordered before the deactivation below. The roster is already down
    // to one enrolled student, because the subtest above un-enrolled the other.

    await t.test(
      "a formula is text on the term, and it survives a save",
      async () => {
        const { home, setup } = await setupNow();
        const written = await writeSetup(db, home.homeId, {
          groups: [],
          terms: [
            {
              id: setup.terms[0].id,
              name: setup.terms[0].name,
              formula: 'avg("trabajos prácticos")',
            },
          ],
          scales: [],
          finalFormula: 'round(avg("Primer trimestre"), 2)',
        });
        assert.equal(written.terms[0].formula, 'avg("trabajos prácticos")');
        assert.equal(written.finalFormula, 'round(avg("Primer trimestre"), 2)');

        // The whole-list save never deletes, and a formula is no exception: a
        // client that does not know about formulas must not wipe one by saving
        // the panel it does know about.
        const after = await writeSetup(db, home.homeId, {
          groups: [],
          terms: [{ id: setup.terms[0].id, name: setup.terms[0].name }],
          scales: [],
        });
        assert.equal(after.terms[0].formula, 'avg("trabajos prácticos")');
        assert.equal(after.finalFormula, 'round(avg("Primer trimestre"), 2)');
      },
    );

    await t.test("the grid computes a mark, and two of them", async () => {
      const { home, setup } = await setupNow();
      const grid = await gradebook(db, home.homeId, ids.current);
      const [student] = computeBothViews(setup, grid.activities, grid.results, [
        ids.student,
      ]);
      // `numeric` mode again, one level up: a string 9 would make this "99".
      assert.equal(student.terms[setup.terms[0].id].all.value, 9);
      assert.equal(student.final.all.value, 9);

      // Nothing was stored (F40). The mark is gone the moment nobody computes
      // it, which is what keeps a publish from having to invalidate anything.
      const columns = await svc.query(
        `select column_name from information_schema.columns
         where table_schema = 'campus' and column_name like '%mark%'`,
      );
      assert.deepEqual(columns.rows, [], "no hay columna de nota calculada");
    });

    await t.test(
      "the student's mark counts published activities only",
      async () => {
        const { home, setup } = await setupNow();
        const tp = (
          await gradebook(db, home.homeId, ids.current)
        ).activities.find((a) => a.slug === "tp-sql");
        const publish = (resultsPublishedAt) =>
          useArticle(db, home.homeId, ids.subject, tp.articleId, {
            programUnitId: null,
            position: 0,
            publishedAt: PUBLISHED,
            restricted: false,
            ...NOT_GRADED,
            offeringGroupId: setup.groups[0].id,
            offeringTermId: setup.terms[0].id,
            valueType: "numeric",
            dueAt: PUBLISHED,
            resultsPublishedAt,
          });

        await publish(null);
        const grid = await gradebook(db, home.homeId, ids.current);
        const [student] = computeBothViews(
          setup,
          grid.activities,
          grid.results,
          [ids.student],
        );
        // The leak this prevents: one evaluator over one activity list would show
        // the student a mark for a TP whose results are not out yet.
        assert.equal(student.terms[setup.terms[0].id].all.value, 9);
        assert.deepEqual(student.terms[setup.terms[0].id].published, {
          value: null,
        });

        // And the student's own page agrees, because it is the same evaluator
        // over the same filter rather than a second rule.
        const activities = await listActivities(db, home.homeId);
        assert.deepEqual(publishedOnly(activities), []);

        await publish(PUBLISHED);
        const mine = await myResults(db, home.homeId, ids.student);
        const computed = computeMarks(
          setup,
          publishedOnly(await listActivities(db, home.homeId)),
          mine.map((row) => ({
            activityId: row.activityId,
            studentId: ids.student,
            value: row.value,
          })),
          [ids.student],
        ).get(ids.student);
        assert.equal(computed.terms[setup.terms[0].id].value, 9);
      },
    );

    await t.test("a rename that orphans a formula is refused", async () => {
      // **F39's open half, closed.** A formula names a group, so a rename can
      // strand one — and the answer is a refusal rather than a mark that turns
      // into an error message on somebody's boletín.
      const { home, setup } = await setupNow();
      await assert.rejects(
        () =>
          writeSetup(db, home.homeId, {
            groups: [{ id: setup.groups[0].id, name: "tps" }],
            terms: [],
            scales: [],
          }),
        /ya no existe/,
      );
      const rolled = await readSetup(db, home.homeId);
      assert.equal(
        rolled.groups[0].name,
        "trabajos prácticos",
        "the whole save is one transaction, so a refusal changes nothing",
      );

      // Renaming the term the final names is the same rule, one level up.
      await assert.rejects(
        () =>
          writeSetup(db, home.homeId, {
            groups: [],
            terms: [{ id: setup.terms[0].id, name: "Trimestre 1" }],
            scales: [],
          }),
        /ya no existe/,
      );

      // And the 409 is avoidable in one save, which is the whole reason the
      // formulas travel in this body: rename the group and fix the formula
      // together.
      const fixed = await writeSetup(db, home.homeId, {
        groups: [{ id: setup.groups[0].id, name: "tps" }],
        terms: [
          {
            id: setup.terms[0].id,
            name: "Primer trimestre",
            formula: "avg(tps)",
          },
        ],
        scales: [],
      });
      assert.equal(fixed.groups[0].name, "tps");
      assert.equal(fixed.terms[0].formula, "avg(tps)");
    });

    await t.test(
      "a formula that does not parse never reaches a row",
      async () => {
        const { home, setup } = await setupNow();
        await assert.rejects(
          () =>
            writeSetup(db, home.homeId, {
              groups: [],
              terms: [
                {
                  id: setup.terms[0].id,
                  name: setup.terms[0].name,
                  formula: "avg(tps",
                },
              ],
              scales: [],
            }),
          /posición/,
        );
        assert.equal(
          (await readSetup(db, home.homeId)).terms[0].formula,
          "avg(tps)",
          "the stored formula is untouched",
        );
      },
    );

    await t.test("a group a formula names cannot be deleted", async () => {
      // The delete's half of the same rule. Without it a teacher could remove
      // the group from the panel and leave the formula pointing at nothing.
      const { home } = await setupNow();
      const withExtra = await writeSetup(db, home.homeId, {
        groups: [],
        terms: [],
        scales: [],
      });
      const created = await writeSetup(db, home.homeId, {
        groups: [
          ...withExtra.groups.map((g) => ({ id: g.id, name: g.name })),
          { name: "orales" },
        ],
        terms: [],
        scales: [],
      });
      const extra = created.groups.find((g) => g.name === "orales");

      // Nothing uses it yet, so it is deletable — that is the control.
      await writeSetup(db, home.homeId, {
        groups: [],
        terms: [
          {
            id: created.terms[0].id,
            name: created.terms[0].name,
            formula: "0.8*avg(tps) + 0.2*avg(orales)",
          },
        ],
        scales: [],
      });
      await assert.rejects(
        () => deleteGroup(db, home.homeId, extra.id),
        /fórmula/,
      );

      // Out of the formula, and now it goes.
      await writeSetup(db, home.homeId, {
        groups: [],
        terms: [
          {
            id: created.terms[0].id,
            name: created.terms[0].name,
            formula: "avg(tps)",
          },
        ],
        scales: [],
      });
      await deleteGroup(db, home.homeId, extra.id);
      assert.equal(
        (await readSetup(db, home.homeId)).groups.find(
          (g) => g.name === "orales",
        ),
        undefined,
      );
    });

    // --- slice 9: the other number on the boletín (F22) ---------------------
    //
    // Still ordered before the deactivation below. `ids.teacher` is the
    // departed student by now, carrying a result and no enrolment.

    await t.test(
      "an official grade is typed, changed and cleared",
      async () => {
        // **Insert, update and delete as `campus_svc`** — a subtest that only
        // read would prove nothing about the grant a new table needs, and the
        // symptom of a missing one is `permission denied` here and a green
        // typecheck everywhere else.
        const { home, setup } = await setupNow();
        const term = setup.terms[0].id;
        const grade = (value, extra = {}) => ({
          studentId: ids.student,
          termId: term,
          clear: value === null,
          ...(value === null ? {} : { value }),
          observation: null,
          suggestion: null,
          ...extra,
        });

        await saveOfficialGrades(
          db,
          home.homeId,
          [
            grade(7, {
              observation: "Mejoró mucho en el segundo tramo.",
              suggestion: "Repasar consultas anidadas.",
            }),
          ],
          ids.admin,
        );
        const [written] = await readOfficialGrades(db, home.homeId);
        // `numeric` mode again: a string 7 would compare equal to nothing useful
        // and would reach a boletín quoted.
        assert.equal(typeof written.value, "number");
        assert.equal(written.value, 7);
        assert.equal(written.suggestion, "Repasar consultas anidadas.");
        assert.equal(written.recordedBy, ids.admin);

        // The student sees it at once, and that is the whole visibility rule
        // (F22): there is no third publish date, and `resultsVisible` is not
        // consulted here. The computed mark for the same term is 9.
        const mine = await myOfficialGrades(db, home.homeId, ids.student);
        assert.deepEqual(
          mine.map((row) => [row.termId, row.value]),
          [[term, 7]],
        );

        // Update: the upsert, not a second row.
        await saveOfficialGrades(db, home.homeId, [grade(8.5)], ids.admin);
        const after = await readOfficialGrades(db, home.homeId);
        assert.equal(after.length, 1, "one row per student per term");
        assert.equal(after[0].value, 8.5);
        assert.equal(
          after[0].suggestion,
          null,
          "the texts are the cell's, so a save without them clears them",
        );

        // A term of another offering — or of none — never reaches a row, the
        // same hole `saveResults` closes for activity ids.
        await assert.rejects(
          () =>
            saveOfficialGrades(
              db,
              home.homeId,
              [{ ...grade(6), termId: "99999999-9999-4999-8999-999999999999" }],
              ids.admin,
            ),
          /trimestre/,
        );

        // Somebody who does not cursa this materia, and never did: F38's writable
        // set, shared with `saveResults` rather than restated.
        await assert.rejects(
          () =>
            saveOfficialGrades(
              db,
              home.homeId,
              [{ ...grade(6), studentId: ids.orphanStudent }],
              ids.admin,
            ),
          /cursa/,
        );

        // The departed student is still writable, which is the half a plain
        // enrolment gate would refuse — and the grid has a row for them.
        await saveOfficialGrades(
          db,
          home.homeId,
          [{ ...grade(6), studentId: ids.teacher }],
          ids.admin,
        );
        assert.equal((await readOfficialGrades(db, home.homeId)).length, 2);

        // Delete: `value: null`, and the row goes rather than turning blank.
        await saveOfficialGrades(
          db,
          home.homeId,
          [grade(null), { ...grade(null), studentId: ids.teacher }],
          ids.admin,
        );
        assert.deepEqual(await readOfficialGrades(db, home.homeId), []);
        assert.deepEqual(
          await myOfficialGrades(db, home.homeId, ids.student),
          [],
        );
      },
    );

    // --- slice 10: a redo replaces what it covers (F23) ----------------------
    //
    // Still ordered before the deactivation below. `tp-sql` is a published
    // numeric activity by now, worth 9 for `ids.student` and 8 for the departed
    // `ids.teacher`, and `official_grade` is empty again — slice 9 cleaned up
    // after itself. This block does too, so the archive subtest still sees what
    // it expects.

    await t.test(
      "a redo covers an activity and replaces its mark",
      async () => {
        // **Insert, update and delete as `campus_svc`**, the rule every new table
        // gets: a subtest that only read would prove nothing about the grant, and
        // the symptom of a missing one is `permission denied` here and a green
        // typecheck everywhere else.
        const { home, setup } = await setupNow();
        const tp = (await listActivities(db, home.homeId)).find(
          (a) => a.slug === "tp-sql",
        );

        /** The mark the grid computes for the student, both ways. */
        const marks = async () => {
          const fresh = await readSetup(db, home.homeId);
          const grid = await gradebook(db, home.homeId, ids.current);
          const [student] = computeBothViews(
            fresh,
            grid.activities,
            grid.results,
            [ids.student],
          );
          return student.terms[fresh.terms[0].id];
        };
        assert.equal((await marks()).all.value, 9, "el punto de partida");

        const recu = await createArticle(
          db,
          ids.subject,
          "recuperatorio-sql",
          "Recuperatorio TP SQL",
        );
        const useRedo = (extra) =>
          useArticle(db, home.homeId, ids.subject, recu.id, {
            programUnitId: null,
            position: 9,
            publishedAt: PUBLISHED,
            restricted: false,
            ...NOT_GRADED,
            offeringGroupId: setup.groups[0].id,
            offeringTermId: setup.terms[0].id,
            valueType: "numeric",
            covers: [tp.id],
            ...extra,
          });

        // The refusals first, while nothing is written: the ids come from a body,
        // so each of these is a trust boundary and not tidiness.
        await assert.rejects(
          () => useRedo({ covers: ["99999999-9999-4999-8999-999999999999"] }),
          /no es de esta materia/,
          "another offering's activity is not coverable",
        );
        await assert.rejects(
          () => useRedo({ valueType: "done", covers: [tp.id] }),
          /mismo tipo de nota/,
          "a numeric TP is not recovered by a done redo",
        );
        await assert.rejects(
          () =>
            useArticle(db, home.homeId, ids.subject, recu.id, {
              programUnitId: null,
              position: 9,
              publishedAt: PUBLISHED,
              restricted: false,
              ...NOT_GRADED,
              covers: [tp.id],
            }),
          /no recupera nada/,
          "without a value type it is not an activity, so it recovers nothing",
        );

        // Written, and unmarked: the original stands (F38's blank rule), and the
        // redo is not a second TP in the average either.
        await useRedo({ resultsPublishedAt: null });
        const activities = await listActivities(db, home.homeId);
        const redo = activities.find((a) => a.slug === "recuperatorio-sql");
        assert.deepEqual(redo.covers, [tp.id]);
        assert.deepEqual(
          activities.find((a) => a.slug === "tp-sql").covers,
          [],
          "covers is the redo's, not the covered one's",
        );
        assert.equal((await marks()).all.value, 9, "un recuperatorio sin nota");

        // Marked, and lower than the original. The default policy is `max`, so it
        // does not pull the mark down — and the redo's marks are not published,
        // so the student's own number does not move at all.
        await saveResults(
          db,
          home.homeId,
          [
            {
              studentId: ids.student,
              activityId: redo.id,
              clear: false,
              value: 4,
              feedback: null,
            },
          ],
          ids.admin,
        );
        const underMax = await marks();
        assert.equal(underMax.all.value, 9, "max: un recuperatorio sólo sube");
        assert.equal(underMax.published.value, 9);

        // The same rows under `replace`, which is the behaviour `max` refuses.
        await writeSetup(db, home.homeId, {
          groups: [],
          terms: [],
          scales: [],
          redoPolicy: "replace",
        });
        const underReplace = await marks();
        assert.equal(underReplace.all.value, 4, "replace: sí baja");
        assert.equal(
          underReplace.published.value,
          9,
          "y el estudiante sigue viendo el 9 hasta que se publique (F24)",
        );

        // Published, and now it is the student's number too — and their own read
        // carries what the mark replaces, or the screen cannot say so (F44).
        await useRedo({ resultsPublishedAt: PUBLISHED });
        assert.equal((await marks()).published.value, 4);
        const mine = await myResults(db, home.homeId, ids.student);
        assert.deepEqual(
          mine.find((r) => r.slug === "recuperatorio-sql").covers,
          [tp.id],
        );

        // A redo of a redo is refused, which is what keeps resolution one pass.
        const second = await createArticle(
          db,
          ids.subject,
          "recuperatorio-2",
          "Segundo recuperatorio",
        );
        await assert.rejects(
          () =>
            useArticle(db, home.homeId, ids.subject, second.id, {
              programUnitId: null,
              position: 10,
              publishedAt: PUBLISHED,
              restricted: false,
              ...NOT_GRADED,
              offeringTermId: setup.terms[0].id,
              valueType: "numeric",
              covers: [redo.id],
            }),
          /No se recupera un recuperatorio/,
        );
        await assert.rejects(
          () => useRedo({ covers: [tp.id, redo.id] }),
          /sí misma/,
          "nor itself",
        );

        // The update: the coverage is written whole, so an empty list is a use
        // that has stopped being a redo — and the mark goes back up by itself.
        await useRedo({ covers: [] });
        assert.deepEqual(
          (await listActivities(db, home.homeId)).find(
            (a) => a.slug === "recuperatorio-sql",
          ).covers,
          [],
        );
        assert.equal(
          (await marks()).all.value,
          6.5,
          "ya no reemplaza: el 4 es una nota más del grupo",
        );

        // The delete, and the cleanup this block owes the subtests after it: the
        // coverage rows go with the use on both sides, or the foreign key turns
        // `removeUse` into a 500.
        await useRedo({ covers: [tp.id] });
        await saveResults(
          db,
          home.homeId,
          [
            {
              studentId: ids.student,
              activityId: redo.id,
              clear: true,
              feedback: null,
            },
          ],
          ids.admin,
        );
        assert.equal(await removeUse(db, home.homeId, recu.id), true);
        assert.equal(
          (await listActivities(db, home.homeId)).some(
            (a) => a.slug === "recuperatorio-sql",
          ),
          false,
        );
        await writeSetup(db, home.homeId, {
          groups: [],
          terms: [],
          scales: [],
          redoPolicy: "max",
        });
        assert.equal((await marks()).all.value, 9, "todo como estaba");
      },
    );

    // --- slice 11: a mark is disputed, and somebody answers (F29) -----------
    //
    // Still ordered before the deactivation below. By here `tp-sql` is a
    // published numeric activity worth 9 for `ids.student`, `ids.teacher` is
    // un-enrolled from NR5A but still carries an 8 on it, and slice 10 has put
    // its redo away again. This block cleans up after itself too, so the archive
    // subtest still sees what it expects.

    await t.test(
      "a student disputes a mark, and a teacher answers",
      async () => {
        // **Insert, update and delete as `campus_svc`**, the rule every new table
        // gets: a subtest that only read would prove nothing about the grant, and
        // the symptom of a missing one is `permission denied` here and a green
        // typecheck everywhere else.
        const home = await activeHome(db, ids.current);
        const tp = (await listActivities(db, home.homeId)).find(
          (a) => a.slug === "tp-sql",
        );

        const file = (extra) =>
          fileRequests(
            db,
            ids.current,
            home.homeId,
            {
              activityId: tp.id,
              studentIds: [ids.student],
              reason: "Entregué la segunda parte.",
              bonusTasks: null,
              ...extra,
            },
            ids.student,
          );

        // The refusals first, while nothing is written. Each is a trust boundary:
        // this is the first row a *student* writes, so every id in the body is
        // somebody's keyboard.
        await assert.rejects(
          () => file({ activityId: "99999999-9999-4999-8999-999999999999" }),
          /no es de esta materia/,
          "another offering's activity is not disputable",
        );
        await assert.rejects(
          () => file({ studentIds: [ids.orphanStudent, ids.student] }),
          /no cursa esta materia/,
          "you may not file for somebody who is not in the class",
        );
        await assert.rejects(
          () => file({ studentIds: [ids.teacher] }),
          /sea tuya/,
          "and not for somebody else alone, even a classmate",
        );

        // INSERT. One row per student named, and the filer is on it.
        await file({});
        const [open] = await listRequests(db, home.homeId);
        assert.equal(open.studentId, ids.student);
        assert.equal(open.requestedBy, ids.student);
        assert.equal(open.slug, "tp-sql");
        assert.equal(
          open.answeredAt,
          null,
          "sin responder es answered_at null",
        );
        assert.deepEqual(
          (await myRevisions(db, home.homeId, ids.student)).map((r) => r.id),
          [open.id],
        );

        // The **partial** unique index, which is the whole of "one open request
        // per result" and the only thing in this schema that is partial.
        await assert.rejects(
          () => file({}),
          /sin responder/,
          "one open at a time",
        );

        // UPDATE.
        await answerRequest(
          db,
          home.homeId,
          open.id,
          "Mirado de nuevo: la segunda parte no estaba. Queda.",
          ids.admin,
        );
        const [answered] = await listRequests(db, home.homeId);
        assert.notEqual(answered.answeredAt, null);
        assert.equal(answered.answeredBy, ids.admin);
        assert.match(answered.answer, /Queda/);

        // Answered unblocks the next one — that is what makes the index partial
        // rather than total.
        await file({ reason: "Encontré el commit." });
        assert.equal((await listRequests(db, home.homeId)).length, 2);

        // Another offering's teacher cannot answer by id: the home is in the
        // UPDATE's `where`, not in a read before it.
        const elsewhere = await activeHome(db, ids.pastYear);
        await assert.rejects(
          () =>
            answerRequest(
              db,
              elsewhere.homeId,
              open.id,
              "mío ahora",
              ids.teacher,
            ),
          /No encontramos/,
        );

        // A mark this request argues with can still be emptied: nothing points at
        // the `result` row, which is why the key is `(activity, student)`.
        await saveResults(
          db,
          home.homeId,
          [
            {
              studentId: ids.student,
              activityId: tp.id,
              clear: true,
              feedback: null,
            },
          ],
          ids.admin,
        );
        assert.equal(
          (await listRequests(db, home.homeId)).length,
          2,
          "borrar la nota no se lleva la conversación",
        );

        // DELETE, and the cleanup this block owes the subtests after it — the
        // mark included, which slice 10 left at 9.
        await svc.query("delete from campus.revision_request");
        assert.deepEqual(await listRequests(db, home.homeId), []);
        await saveResults(
          db,
          home.homeId,
          [
            {
              studentId: ids.student,
              activityId: tp.id,
              clear: false,
              value: 9,
              feedback: null,
            },
          ],
          ids.admin,
        );
        assert.equal(
          (await myResults(db, home.homeId, ids.student)).find(
            (r) => r.activityId === tp.id,
          ).value,
          9,
          "todo como estaba",
        );
      },
    );

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
    nr5a,
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
