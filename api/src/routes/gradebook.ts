import { Router, type Request } from "express";
import type { Db } from "../db/client.js";
import { isUuid } from "../library/program.js";
import { ApiError } from "../middleware/errors.js";
import { actorFrom, capabilitiesFor } from "../offerings/access.js";
import { activeHome, manageableHome } from "../offerings/content.js";
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
  myResults,
  saveResults,
} from "../offerings/results.js";

/**
 * The gradebook (F18, F19, F24, F26, F38, F39).
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
 * the only thing in this slice a student can reach.
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

export function createGradebookRoutes(db: Db): Router {
  const router = Router();

  function mustManage(req: Request) {
    const { record } = req.session!;
    return manageableHome(
      db,
      offeringIdFrom(String(req.params.offeringId)),
      actorFrom(record.userId, record.claims),
    );
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
        const { homeId } = await mustManage(req);
        const offeringId = offeringIdFrom(String(req.params.offeringId));
        const [setup, grid] = await Promise.all([
          readSetup(db, homeId),
          gradebook(db, homeId, offeringId),
        ]);
        res
          .status(200)
          .json({ ...setup, scalePresets: SCALE_PRESETS, ...grid });
      } catch (cause) {
        next(cause);
      }
    })();
  });

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
        const { homeId } = await mustManage(req);
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
        const { homeId } = await mustManage(req);
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
        const { homeId } = await mustManage(req);
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
        const { homeId } = await mustManage(req);
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
        const { homeId } = await mustManage(req);
        const { record } = req.session!;
        await saveResults(db, homeId, checkEntries(req.body), record.userId);
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
        res.status(200).json(await myResults(db, home.homeId, record.userId));
      } catch (cause) {
        next(cause);
      }
    })();
  });

  return router;
}
