import { Router, type RequestHandler } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { directoryOffering } from "../db/schema/directory.js";
import { ApiError } from "../middleware/errors.js";
import { isAdmin } from "../offerings/access.js";
import { activate, deactivate } from "../offerings/activation.js";
import { listForAdmin } from "../offerings/catalog.js";

/**
 * An admin decides which of the directory's offerings are campus's (F34).
 *
 * This is the only gate in campus that is role-shaped rather than
 * resource-shaped, which is why it is written out here instead of going through
 * `capabilitiesFor`: activation is not *about* an offering the way editing it
 * is — it is about the platform, and nobody but an admin has an opinion.
 *
 * **403 and never 401.** The person is signed in and refused; a client that
 * reacted by logging in again would loop (`CLIENTS.md`, and slice 3's session
 * middleware says the same about CSRF).
 */

const requireAdmin: RequestHandler = (req, _res, next) => {
  const roles = req.session?.record.claims.roles ?? [];
  next(
    isAdmin(roles)
      ? undefined
      : new ApiError(403, "forbidden", "Esto lo hace un administrador."),
  );
};

/** tic-auth's ids are integers and never reused. Nine digits is past anything
 *  the school will issue and short of what stops being a safe integer. */
function offeringIdFrom(raw: string): number {
  if (!/^\d{1,9}$/.test(raw)) {
    throw new ApiError(404, "not_found", "No encontrado.");
  }
  return Number(raw);
}

function yearFrom(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !/^\d{4}$/.test(raw)) {
    throw new ApiError(
      400,
      "invalid_year",
      "El año tiene que ser de 4 dígitos.",
    );
  }
  return Number(raw);
}

export function createAdminOfferingRoutes(
  db: Db,
  guard: RequestHandler,
): Router {
  const router = Router();
  router.use(guard, requireAdmin);

  // The directory's offerings for a year, each saying whether campus has
  // activated it — the list an admin works from.
  router.get("/", (req, res, next) => {
    void (async () => {
      try {
        res.status(200).json(await listForAdmin(db, yearFrom(req.query.year)));
      } catch (cause) {
        next(cause);
      }
    })();
  });

  /**
   * Activation is a PUT-shaped POST and is idempotent: `created` says whether
   * this call was the one that did it, and either way the answer is 200 with
   * the same state. An admin who clicks twice has not made a mistake.
   *
   * The offering is checked against the directory first, so activating an id
   * that does not exist is a 404 about the offering rather than a foreign-key
   * violation surfaced as a 500.
   */
  router.post("/:offeringId/activation", (req, res, next) => {
    void (async () => {
      try {
        const offeringId = offeringIdFrom(req.params.offeringId);
        const [exists] = await db
          .select({ id: directoryOffering.id })
          .from(directoryOffering)
          .where(eq(directoryOffering.id, offeringId))
          .limit(1);
        if (!exists) {
          throw new ApiError(
            404,
            "not_found",
            "Esa materia no está en el directorio.",
          );
        }
        const created = await activate(
          db,
          offeringId,
          req.session!.record.userId,
        );
        res.status(200).json({ offeringId, activated: true, created });
      } catch (cause) {
        next(cause);
      }
    })();
  });

  /**
   * `archived`, not `removed`: since slice 5 the home stays and carries its
   * `offering_article` rows with it (F36), so an admin who deactivates by
   * mistake re-activates and the teacher's work is still there.
   */
  router.delete("/:offeringId/activation", (req, res, next) => {
    void (async () => {
      try {
        const offeringId = offeringIdFrom(req.params.offeringId);
        const archived = await deactivate(db, offeringId);
        res.status(200).json({ offeringId, activated: false, archived });
      } catch (cause) {
        next(cause);
      }
    })();
  });

  return router;
}
