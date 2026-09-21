import express, { Router, type Request } from "express";
import type { YearLock } from "../config.js";
import type { Db } from "../db/client.js";
import { contentDisposition } from "../library/uploads.js";
import { isUuid } from "../library/program.js";
import { ApiError } from "../middleware/errors.js";
import { actorFrom, capabilitiesFor } from "../offerings/access.js";
import {
  activeHome,
  assertUnlocked,
  isLocked,
  manageableHome,
} from "../offerings/content.js";
import {
  checkSetup,
  deleteGroup,
  deleteScale,
  deleteTerm,
  readSetup,
  SCALE_PRESETS,
  writeSetup,
} from "../offerings/gradebook.js";
import {
  checkEntries,
  gradebook,
  listActivities,
  myResults,
  roster,
  saveResults,
} from "../offerings/results.js";
import { importGradebook, readExport } from "../offerings/gradebook-csv.js";
import {
  answerRequest,
  checkAnswer,
  checkRequest,
  fileRequests,
  listRequests,
  myRevisions,
} from "../offerings/revisions.js";
import {
  checkGrades,
  myOfficialGrades,
  readOfficialGrades,
  saveOfficialGrades,
} from "../offerings/official-grades.js";
import { MAX_FORMULA, checkFormula } from "../offerings/formula.js";
import {
  computeBothViews,
  computeMarks,
  publishedOnly,
} from "../offerings/marks.js";

/**
 * The gradebook (F18, F19, F22, F24, F26, F38, F39).
 *
 * **Same prefix as `home-content.ts`, and the guard is on the mount.** Two
 * routers under `/api/homes` is one prefix doing one job — ids, not public URL
 * segments — split by subject matter. What must not happen is two
 * `router.use(guard)`s: a request for anything here would walk the other
 * router's guard first, find nothing, and read and renew the session a second
 * time on the way through this one.
 *
 * **Everything staff is `manageOffering`** — teaching *this* offering (F5).
 * `editLibrary` is the subject's library and is the wrong gate for a class's
 * marks: a teacher of last year's offering of the same subject may fix a typo
 * in an article and may not read who got a 4.
 *
 * `/results/mine` is the exception and is not staff at all: it is the enrolled
 * student's own marks, gated on `seeOwnMarks` and F24's publish date, and it is
 * the only thing here a student can reach. It carries their official grades too
 * (F22), which have no publish date of their own — a third key on that payload
 * rather than a fourth route, because the boletín reads both numbers or
 * neither.
 *
 * **The student can also write here, and this is the only place they can.**
 * `POST /:offeringId/revisions` is F29: asking for a mark to be looked at
 * again. It is the first non-`GET` any student reaches in campus, so it is the
 * first exercise of the student side of `guard`'s CSRF check and the first time
 * `seeOwnMarks` gates a write rather than a read. It lives on this router and
 * not one of its own for the reason above — a third router under the same
 * prefix is a third walk through the mount's `guard`.
 */

function offeringIdFrom(raw: string): number {
  if (!/^\d{1,9}$/.test(raw)) {
    throw new ApiError(404, "not_found", "No encontrado.");
  }
  return Number(raw);
}

function uuidFrom(raw: string): string {
  if (!isUuid(raw)) throw new ApiError(404, "not_found", "No encontrado.");
  return raw;
}

export function createGradebookRoutes(db: Db, yearLock: YearLock): Router {
  const router = Router();

  function mustManage(req: Request) {
    const { record } = req.session!;
    return manageableHome(
      db,
      offeringIdFrom(String(req.params.offeringId)),
      actorFrom(record.userId, record.claims),
    );
  }

  /** `mustManage`, for a write that changes a mark — refused once the year
   *  has locked (F35). */
  async function mustWrite(req: Request) {
    const home = await mustManage(req);
    assertUnlocked(home, yearLock);
    return home;
  }

  /**
   * The whole grid in one read: what the offering names, what it grades, who is
   * in it and what they got.
   *
   * **One payload and not five**, the way `GET /:year/:subject/:offering`
   * already answers with the offering, the capabilities, the program and the
   * articles together — the grid cannot draw a column header without the groups
   * and terms, and a second round trip is a second thing that can disagree with
   * the first.
   *
   * `scalePresets` rides along as a **constant, not a resource** (F42): it is
   * what a client offers as "arrancá con ésta" before POSTing the copy this
   * offering will own. There is deliberately no `GET /api/scale-presets`.
   */
  router.get("/:offeringId/gradebook", (req, res, next) => {
    void (async () => {
      try {
        const home = await mustManage(req);
        const { homeId } = home;
        const offeringId = offeringIdFrom(String(req.params.offeringId));
        const [setup, grid, officialGrades] = await Promise.all([
          readSetup(db, homeId),
          gradebook(db, homeId, offeringId),
          readOfficialGrades(db, homeId),
        ]);
        res.status(200).json({
          ...setup,
          // F35: the grid still opens after the year closes, read-only, and
          // says so rather than letting a teacher type into a save that 409s.
          locked: isLocked(home, yearLock),
          scalePresets: SCALE_PRESETS,
          ...grid,
          // The *other* number (F22): typed, not computed, and it rides in this
          // payload for the reason everything else here does — the boletín
          // draws both on one row and cannot do it in two round trips.
          officialGrades,
          // Computed here and not stored anywhere (F20, F40), from rows the
          // read above already has — no query, and nothing to invalidate when a
          // result, a formula or a publish changes.
          computed: computeBothViews(
            setup,
            grid.activities,
            grid.results,
            grid.students.map((student) => student.id),
          ),
        });
      } catch (cause) {
        next(cause);
      }
    })();
  });

  /**
   * The grid as a CSV file (F27): activity marks and official grades of the
   * enrolled, with their DNI. A read, so it still works on a locked year.
   */
  router.get("/:offeringId/gradebook/export", (req, res, next) => {
    void (async () => {
      try {
        const { homeId } = await mustManage(req);
        const offeringId = offeringIdFrom(String(req.params.offeringId));
        const csv = await readExport(db, homeId, offeringId);
        res
          .status(200)
          .type("text/csv; charset=utf-8")
          .set(
            "Content-Disposition",
            contentDisposition(`boletin-${offeringId}.csv`, "attachment"),
          )
          .send(csv);
      } catch (cause) {
        next(cause);
      }
    })();
  });

  /**
   * A CSV back in (F27). `?dryRun=true` answers the diff and writes nothing,
   * so it is a read and passes the lock; without it the same file is applied.
   * Nothing is kept between the two calls: what is applied is what was sent.
   *
   * **The body is the file itself**, `Content-Type: text/csv`, on its own
   * parser: one file and no fields is not worth multipart. A client sets the
   * header by hand, since a browser labels a `.csv` whatever the OS says.
   *
   * **All or nothing**: any problem makes applying a `400 import_invalid`
   * with the diff beside the error, so the screen can show what to fix.
   */
  router.post(
    "/:offeringId/gradebook/import",
    express.raw({ type: "text/csv", limit: "1mb" }),
    (req, res, next) => {
      void (async () => {
        try {
          const dryRun = req.query.dryRun === "true";
          const { homeId } = dryRun
            ? await mustManage(req)
            : await mustWrite(req);
          if (!Buffer.isBuffer(req.body)) {
            throw new ApiError(
              415,
              "unsupported_media_type",
              "Mandá el archivo como `Content-Type: text/csv`.",
            );
          }
          const outcome = await importGradebook(
            db,
            homeId,
            offeringIdFrom(String(req.params.offeringId)),
            req.body,
            dryRun ? null : req.session!.record.userId,
          );
          if (dryRun || outcome.applied) {
            res.status(200).json(outcome);
            return;
          }
          res.status(400).json({
            error: {
              code: "import_invalid",
              message:
                "El archivo tiene problemas y no se aplicó nada. Corregilos y volvé a subirlo.",
            },
            ...outcome,
          });
        } catch (cause) {
          next(cause);
        }
      })();
    },
  );

  /**
   * Groups, terms and scales, as one list each (F39).
   *
   * **It never deletes**, for the reason `PUT …/program` never does (F15): a
   * teacher who loaded the panel and saves it after a colleague added a term
   * would otherwise wipe it, and by foreign key every activity filed under it.
   * Removing one is its own `DELETE`, which says no while it is in use.
   */
  router.put("/:offeringId/gradebook", (req, res, next) => {
    void (async () => {
      try {
        const { homeId } = await mustWrite(req);
        res
          .status(200)
          .json(await writeSetup(db, homeId, checkSetup(req.body)));
      } catch (cause) {
        next(cause);
      }
    })();
  });

  router.delete("/:offeringId/gradebook/groups/:rowId", (req, res, next) => {
    void (async () => {
      try {
        const { homeId } = await mustWrite(req);
        await deleteGroup(db, homeId, uuidFrom(req.params.rowId));
        res.status(200).json({ deleted: true });
      } catch (cause) {
        next(cause);
      }
    })();
  });

  router.delete("/:offeringId/gradebook/terms/:rowId", (req, res, next) => {
    void (async () => {
      try {
        const { homeId } = await mustWrite(req);
        await deleteTerm(db, homeId, uuidFrom(req.params.rowId));
        res.status(200).json({ deleted: true });
      } catch (cause) {
        next(cause);
      }
    })();
  });

  /** A scale goes with its levels, which nothing outside it can reference. */
  router.delete("/:offeringId/gradebook/scales/:rowId", (req, res, next) => {
    void (async () => {
      try {
        const { homeId } = await mustWrite(req);
        await deleteScale(db, homeId, uuidFrom(req.params.rowId));
        res.status(200).json({ deleted: true });
      } catch (cause) {
        next(cause);
      }
    })();
  });

  /**
   * The grid's save: every cell the teacher touched, in one call (F26, F38).
   *
   * Entries nobody sent are untouched — this is not the whole-list `PUT` above,
   * and there is no delete by omission. Emptying a cell is `value: null`, said
   * out loud, because the alternative is a falsy check that eats a legitimate
   * *not done* and a legitimate zero.
   */
  router.put("/:offeringId/results", (req, res, next) => {
    void (async () => {
      try {
        const { homeId } = await mustWrite(req);
        const { record } = req.session!;
        await saveResults(db, homeId, checkEntries(req.body), record.userId);
        res.status(200).json({ saved: true });
      } catch (cause) {
        next(cause);
      }
    })();
  });

  /**
   * The boletín's other column (F22): the grade a teacher types per student per
   * term, with its observation and suggestion.
   *
   * **Touched entries, like `PUT …/results`** and unlike the whole-list saves
   * next to it — this is a cell, not a panel. `value: null` empties one, and it
   * takes the two texts with it.
   *
   * There is no publish date and no `POST …/official-grades/publish`: a grade
   * here is visible the moment it exists. See the note on the table.
   */
  router.put("/:offeringId/official-grades", (req, res, next) => {
    void (async () => {
      try {
        const { homeId } = await mustWrite(req);
        const { record } = req.session!;
        await saveOfficialGrades(
          db,
          homeId,
          checkGrades(req.body),
          record.userId,
        );
        res.status(200).json({ saved: true });
      } catch (cause) {
        next(cause);
      }
    })();
  });

  /**
   * A student's own marks, published only (F24).
   *
   * **Ahead of nothing and under `/results`**, which is safe because the other
   * `/results` route is a PUT. It is an id path rather than the public URL a
   * student arrives on, and that costs them nothing: `GET
   * /api/offerings/:year/:subject/:offering` already hands back the
   * `offeringId` they would need.
   *
   * The gate is `seeOwnMarks` — a row in `directory.enrollment` (F5), never
   * `roles[]`. A teacher enrolled in their own offering has it and gets their
   * own marks from it, which is exactly right.
   */
  router.get("/:offeringId/results/mine", (req, res, next) => {
    void (async () => {
      try {
        const offeringId = offeringIdFrom(String(req.params.offeringId));
        const home = await activeHome(db, offeringId);
        if (!home) {
          throw new ApiError(404, "not_found", "Esa materia no está activada.");
        }
        const { record } = req.session!;
        const can = await capabilitiesFor(
          db,
          actorFrom(record.userId, record.claims),
          offeringId,
          home.subjectId,
        );
        if (!can.seeOwnMarks) {
          throw new ApiError(
            403,
            "forbidden",
            "Estas son las notas de quien cursa esta materia.",
          );
        }
        // Three reads rather than one: the marks, plus the setup and the
        // activity list the formula needs. `done_ratio`'s denominator is how
        // many done activities the group has, so the rows alone cannot answer
        // it — and the list is filtered to what this student may see, or an
        // unpublished activity would drag their own mark down and tell them it
        // is there.
        const [results, setup, activities, official, revisions, classmates] =
          await Promise.all([
            myResults(db, home.homeId, record.userId),
            readSetup(db, home.homeId),
            listActivities(db, home.homeId),
            // A third key here and not a fourth route (F22): the boletín is one
            // screen, and the two numbers are read together or not at all.
            myOfficialGrades(db, home.homeId, record.userId),
            // F29, and the same argument a third time. A flat list rather than a
            // key on each mark: a request outlives the row it argues with, so
            // hanging it off `results` would drop exactly the ones still owed an
            // answer.
            myRevisions(db, home.homeId, record.userId),
            // Who else is in the class, which F29's group filing needs and
            // nothing else in campus has ever told a student. **This is a real
            // widening**: every enrolled student now learns the full class list
            // with ids. It is what the old campus shipped — the dialog let you
            // name the partners you worked with — and it is written down here
            // rather than arriving by accident. Names only; no marks of anybody
            // else's ride along.
            // ponytail: `roster` is three queries and the filter below throws
            // two of them away — they find the departed students it flags for
            // the grid, which a classmate picker does not want. Reused anyway
            // rather than opening a fourth reader of `directory.enrollment`
            // (F38 keeps that answer in one place). If this read gets hot, the
            // move is to export the enrolled half of `roster`, not to inline a
            // copy of it here.
            roster(db, offeringId, home.homeId),
          ]);
        const computed = computeMarks(
          setup,
          publishedOnly(activities),
          // One student's own rows, which is all `myResults` loaded.
          results.map((row) => ({
            activityId: row.activityId,
            studentId: record.userId,
            value: row.value,
          })),
          [record.userId],
        );
        res.status(200).json({
          results,
          computed: computed.get(record.userId)!,
          official,
          revisions,
          classmates: classmates.filter((student) => student.enrolled),
          // Whether a revision can still be asked for (F35).
          locked: isLocked(home, yearLock),
        });
      } catch (cause) {
        next(cause);
      }
    })();
  });

  /**
   * A student asks for a mark to be looked at again (F29), for themselves and
   * for the partners they worked with.
   *
   * **The gate is `/results/mine`'s, not `mustManage`'s** — the same three
   * steps, because the question is the same one: is this person enrolled here.
   * Everything past it is `fileRequests`', including the one check that cannot
   * live in a body checker, that the activity belongs to this home and has its
   * marks out.
   *
   * CSRF is already enforced by the mount's `guard`, which is worth saying out
   * loud: this is the first non-`GET` a student can reach, so it is the first
   * request that needs `X-CSRF-Token` from somebody who has never sent one.
   */
  router.post("/:offeringId/revisions", (req, res, next) => {
    void (async () => {
      try {
        const offeringId = offeringIdFrom(String(req.params.offeringId));
        const home = await activeHome(db, offeringId);
        if (!home) {
          throw new ApiError(404, "not_found", "Esa materia no está activada.");
        }
        const { record } = req.session!;
        const can = await capabilitiesFor(
          db,
          actorFrom(record.userId, record.claims),
          offeringId,
          home.subjectId,
        );
        if (!can.seeOwnMarks) {
          throw new ApiError(
            403,
            "forbidden",
            "Esto lo pide quien cursa esta materia.",
          );
        }
        assertUnlocked(home, yearLock);
        await fileRequests(
          db,
          offeringId,
          home.homeId,
          checkRequest(req.body),
          record.userId,
        );
        res.status(201).json({ filed: true });
      } catch (cause) {
        next(cause);
      }
    })();
  });

  /** The teacher's inbox for this offering (F29). Per offering and not per
   *  teacher: F5 scopes a teacher to the offerings they teach, and F6 asks for
   *  the cross-offering number as a **count** on "Mis materias". */
  router.get("/:offeringId/revisions", (req, res, next) => {
    void (async () => {
      try {
        const { homeId } = await mustManage(req);
        res.status(200).json({ revisions: await listRequests(db, homeId) });
      } catch (cause) {
        next(cause);
      }
    })();
  });

  /**
   * The teacher answers (F29).
   *
   * **It writes no mark.** F29 says the teacher can change it from the request
   * itself; F38 says `saveResults` is the one write path for a result, and a
   * second one here would be a second place branching on `value_type`. So a
   * teacher who agrees sends `PUT …/results` as well, and the two calls are
   * independently meaningful in either order.
   */
  router.post("/:offeringId/revisions/:rowId/answer", (req, res, next) => {
    void (async () => {
      try {
        const { homeId } = await mustWrite(req);
        const { record } = req.session!;
        await answerRequest(
          db,
          homeId,
          uuidFrom(req.params.rowId),
          checkAnswer(req.body),
          record.userId,
        );
        res.status(200).json({ answered: true });
      } catch (cause) {
        next(cause);
      }
    })();
  });

  /**
   * A draft formula, against this offering's real students (F20's live
   * preview).
   *
   * **This is what the slice owes F44**, and it stops here: the editor is a
   * screen and a screen is a person's job. Nothing is saved — the formula in
   * the body is evaluated and thrown away, which is also why a syntax error is
   * a `400` a teacher reads rather than anything that touches a row.
   *
   * `termId: null` means the final, whose names are the terms rather than the
   * groups. Both go through the same evaluator as the grid, so a preview that
   * agrees with the saved formula is not a coincidence.
   */
  router.post("/:offeringId/gradebook/preview", (req, res, next) => {
    void (async () => {
      try {
        const { homeId } = await mustManage(req);
        const offeringId = offeringIdFrom(String(req.params.offeringId));
        const { formula, termId } = checkPreview(req.body);
        const [setup, grid] = await Promise.all([
          readSetup(db, homeId),
          gradebook(db, homeId, offeringId),
        ]);
        if (
          termId !== null &&
          !setup.terms.some((term) => term.id === termId)
        ) {
          throw new ApiError(
            400,
            "unknown_term",
            "Ese trimestre no es de esta materia. Recargá el boletín.",
          );
        }
        // Parsed once here so a broken draft is one 400 with a position in it,
        // rather than the same message repeated in every student's cell.
        checkFormula(
          formula,
          termId === null
            ? setup.terms.map((term) => term.name)
            : setup.groups.map((group) => group.name),
          termId === null ? "trimestre" : "grupo",
        );
        const draft: typeof setup =
          termId === null
            ? { ...setup, finalFormula: formula }
            : {
                ...setup,
                terms: setup.terms.map((term) =>
                  term.id === termId ? { ...term, formula } : term,
                ),
              };
        res.status(200).json({
          students: computeBothViews(
            draft,
            grid.activities,
            grid.results,
            grid.students.map((student) => student.id),
          ).map((student) => ({
            studentId: student.studentId,
            computed:
              termId === null ? student.final : (student.terms[termId] ?? null),
          })),
        });
      } catch (cause) {
        next(cause);
      }
    })();
  });

  return router;
}

/** The preview body, by the house rules: hand-written, explicit caps, `400
 *  invalid_body` with a Spanish message. */
function checkPreview(raw: unknown): {
  formula: string;
  termId: string | null;
} {
  if (typeof raw !== "object" || raw === null) {
    throw new ApiError(400, "invalid_body", "Esperábamos un objeto.");
  }
  const { formula, termId } = raw as Record<string, unknown>;
  if (typeof formula !== "string" || formula.length > MAX_FORMULA) {
    throw new ApiError(
      400,
      "invalid_body",
      `La fórmula tiene que ser texto de hasta ${MAX_FORMULA} caracteres.`,
    );
  }
  if (termId !== null && termId !== undefined && !isUuid(termId)) {
    throw new ApiError(400, "invalid_body", "Ese id no es válido.");
  }
  return { formula, termId: typeof termId === "string" ? termId : null };
}
