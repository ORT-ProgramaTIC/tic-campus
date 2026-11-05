import { Router, type Request } from "express";
import type { YearLock } from "../config.js";
import type { Db } from "../db/client.js";
import { ApiError } from "../middleware/errors.js";
import { actorFrom, capabilitiesFor } from "../offerings/access.js";
import {
  activeHome,
  assertUnlocked,
  isLocked,
  manageableHome,
} from "../offerings/content.js";
import {
  checkProjectGrades,
  myProjectGrade,
  readProjectGrades,
  saveProjectGrades,
} from "../offerings/project-grades.js";

/**
 * The Proyecto grade (F46, F47, F50), under `/api/homes` like the gradebook.
 * **The guard is on the mount** (`index.ts`). Staff is `manageOffering`; the
 * student reads their own through `seeOwnMarks`. Writes honour F35's lock.
 */

function offeringIdFrom(raw: string): number {
  if (!/^\d{1,9}$/.test(raw)) {
    throw new ApiError(404, "not_found", "No encontrado.");
  }
  return Number(raw);
}

export function createProjectGradeRoutes(db: Db, yearLock: YearLock): Router {
  const router = Router();

  function mustManage(req: Request) {
    const { record } = req.session!;
    return manageableHome(
      db,
      offeringIdFrom(String(req.params.offeringId)),
      actorFrom(record.userId, record.claims),
    );
  }

  /** The staff table: every row, and whether the year is locked so the
   *  screen can drop its controls. */
  router.get("/:offeringId/project-grades", (req, res, next) => {
    void (async () => {
      try {
        const home = await mustManage(req);
        const rows = await readProjectGrades(
          db,
          offeringIdFrom(String(req.params.offeringId)),
          home.homeId,
        );
        res.status(200).json({ rows, locked: isLocked(home, yearLock) });
      } catch (cause) {
        next(cause);
      }
    })();
  });

  /** Cells and bulk flips alike: `{ entries: [{ studentId, value, visible }] }`. */
  router.put("/:offeringId/project-grades", (req, res, next) => {
    void (async () => {
      try {
        const home = await mustManage(req);
        assertUnlocked(home, yearLock);
        const { record } = req.session!;
        await saveProjectGrades(
          db,
          offeringIdFrom(String(req.params.offeringId)),
          home.homeId,
          checkProjectGrades(req.body),
          record.userId,
        );
        res.status(200).json({ saved: true });
      } catch (cause) {
        next(cause);
      }
    })();
  });

  /** The enrolled student's own, `null` unless visible (F50). */
  router.get("/:offeringId/project-grades/mine", (req, res, next) => {
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
            "La nota la ve quien cursa esta materia.",
          );
        }
        res
          .status(200)
          .json(
            await myProjectGrade(db, offeringId, home.homeId, record.userId),
          );
      } catch (cause) {
        next(cause);
      }
    })();
  });

  return router;
}
