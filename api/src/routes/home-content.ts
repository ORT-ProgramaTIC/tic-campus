import { Router, type Request, type RequestHandler } from "express";
import type { Db } from "../db/client.js";
import { isUuid } from "../library/program.js";
import { ApiError } from "../middleware/errors.js";
import { actorFrom, capabilitiesFor } from "../offerings/access.js";
import { activeHome, removeUse, useArticle } from "../offerings/content.js";

/**
 * What an offering shows, and how (F4, F8, F13).
 *
 * **Its own prefix, and not `/api/offerings/:offeringId/…`.** That router owns
 * `GET /:year/:subject/:offering`, and Express matches in mount order: the
 * first staff `GET` hung under it would be read as a public URL and answer
 * `400 invalid_year` before anything got the chance to 404. Nothing collides
 * today only because these two routes are a PUT and a DELETE, which is a
 * coincidence and not a design. So: **`/api/offerings` segments are a public
 * URL, `/api/homes` segments are ids.**
 *
 * The gate is `manageOffering` (F5) — teaching *this* offering, not the
 * subject. Writing the article itself is the library's, and a teacher of
 * another offering of the same subject has no say over this home.
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

export function createHomeContentRoutes(db: Db, guard: RequestHandler): Router {
  const router = Router();
  router.use(guard);

  /**
   * One query does three jobs: 404s an offering campus has not activated or has
   * archived (F34 — no presence at all, not an empty home), hands back the
   * `homeId` the writes need, and hands back the `subjectId` `capabilitiesFor`
   * takes. Checking existence before mutating is also what keeps a foreign-key
   * violation from surfacing as a 500.
   */
  async function mustManage(
    req: Request,
  ): Promise<{ homeId: string; subjectId: number }> {
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
    if (!can.manageOffering) {
      throw new ApiError(
        403,
        "forbidden",
        "Esto lo hace quien da esta materia.",
      );
    }
    return home;
  }

  /**
   * The offering uses a library article, or changes how it does (F8).
   *
   * Idempotent on `(home, article)` like activation, so a teacher who saves the
   * same panel twice has not made a mistake. `publishedAt` null keeps it
   * staff-only, which is how an article written a week early stays unseen;
   * `restricted` is F4's "enrolled students and staff only".
   */
  router.put("/:offeringId/articles/:articleId", (req, res, next) => {
    void (async () => {
      try {
        const { homeId, subjectId } = await mustManage(req);
        const body = (req.body ?? {}) as Record<string, unknown>;
        await useArticle(
          db,
          homeId,
          subjectId,
          uuidFrom(req.params.articleId),
          {
            programUnitId: unitIdFrom(body.programUnitId),
            position: positionFrom(body.position),
            publishedAt: publishedAtFrom(body.publishedAt),
            restricted: body.restricted === true,
          },
        );
        res.status(200).json({ used: true });
      } catch (cause) {
        next(cause);
      }
    })();
  });

  router.delete("/:offeringId/articles/:articleId", (req, res, next) => {
    void (async () => {
      try {
        const { homeId } = await mustManage(req);
        const removed = await removeUse(
          db,
          homeId,
          uuidFrom(req.params.articleId),
        );
        res.status(200).json({ used: false, removed });
      } catch (cause) {
        next(cause);
      }
    })();
  });

  return router;
}

function unitIdFrom(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (!isUuid(raw)) {
    throw new ApiError(400, "invalid_body", "`programUnitId` no es válido.");
  }
  return raw;
}

function positionFrom(raw: unknown): number {
  if (raw === undefined) return 0;
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < 0 ||
    raw > 9999
  ) {
    throw new ApiError(
      400,
      "invalid_body",
      "`position` tiene que ser un entero.",
    );
  }
  return raw;
}

/** An ISO date, or null for "not yet". A bad one is the teacher's to fix. */
function publishedAtFrom(raw: unknown): Date | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw new ApiError(400, "invalid_body", "`publishedAt` es una fecha ISO.");
  }
  const when = new Date(raw);
  if (Number.isNaN(when.getTime())) {
    throw new ApiError(400, "invalid_body", "`publishedAt` no es una fecha.");
  }
  return when;
}
