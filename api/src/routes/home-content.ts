import { Router, type Request } from "express";
import type { Db } from "../db/client.js";
import { isUuid } from "../library/program.js";
import { ApiError } from "../middleware/errors.js";
import { actorFrom } from "../offerings/access.js";
import { manageableHome, removeUse, useArticle } from "../offerings/content.js";
import { checkHome, writeHome } from "../offerings/home.js";
import { isValueType, type ValueType } from "../offerings/results.js";

/**
 * What an offering shows, and how (F4, F8, F13, F18).
 *
 * **Its own prefix, and not `/api/offerings/:offeringId/…`.** That router owns
 * `GET /:year/:subject/:offering`, and Express matches in mount order: the
 * first staff `GET` hung under it would be read as a public URL and answer
 * `400 invalid_year` before anything got the chance to 404. Nothing collides
 * today only because these two routes are a PUT and a DELETE, which is a
 * coincidence and not a design. So: **`/api/offerings` segments are a public
 * URL, `/api/homes` segments are ids.**
 *
 * **The session guard is on the mount, not in here** (`index.ts`), because
 * `gradebook.ts` hangs off the same prefix: a guard per router would read and
 * renew the session once per router a request walks past, which is twice for
 * everything the other one serves.
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

export function createHomeContentRoutes(db: Db): Router {
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
   * The offering uses a library article, or changes how it does (F8) — and
   * since slice 7, whether it is an activity and how it is marked (F18).
   *
   * Idempotent on `(home, article)` like activation, so a teacher who saves the
   * same panel twice has not made a mistake. `publishedAt` null keeps it
   * staff-only, which is how an article written a week early stays unseen;
   * `restricted` is F4's "enrolled students and staff only"; and
   * `resultsPublishedAt` is F24's separate answer for the marks.
   *
   * **A whole row goes in.** Everything absent takes its default, which for
   * the grading fields is "this is not an activity" — so the panel that saves
   * an activity sends the grading fields back with it. `useArticle` refuses the
   * one case that cannot be undone by saving again.
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
            publishedAt: dateFrom(body.publishedAt, "publishedAt"),
            restricted: body.restricted === true,
            offeringGroupId: idFrom(body.offeringGroupId, "offeringGroupId"),
            offeringTermId: idFrom(body.offeringTermId, "offeringTermId"),
            valueType: valueTypeFrom(body.valueType),
            offeringScaleId: idFrom(body.offeringScaleId, "offeringScaleId"),
            dueAt: dateFrom(body.dueAt, "dueAt"),
            resultsPublishedAt: dateFrom(
              body.resultsPublishedAt,
              "resultsPublishedAt",
            ),
            covers: coversFrom(body.covers),
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

  /**
   * The home's configuration, whole (F14, F15): sections and their order, the
   * links, and this offering's order and hiding of the library's units. The
   * public home read carries it back; there is no staff `GET` of its own.
   */
  router.put("/:offeringId/home", (req, res, next) => {
    void (async () => {
      try {
        const { homeId, subjectId } = await mustManage(req);
        const saved = await writeHome(
          db,
          homeId,
          subjectId,
          checkHome(req.body),
        );
        res.status(200).json(saved);
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

/** F23's list, shape only — whether these ids are activities of this home, and
 *  of the right kind, is `checkCovers`'s question and not the body's. Absent is
 *  an empty list, which is what "not a redo" is. */
function coversFrom(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 100) {
    throw new ApiError(
      400,
      "invalid_body",
      "`covers` es una lista de hasta 100 actividades.",
    );
  }
  return raw.map((id) => {
    if (!isUuid(id)) {
      throw new ApiError(400, "invalid_body", "`covers` lleva ids válidos.");
    }
    return id;
  });
}

function idFrom(raw: unknown, field: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (!isUuid(raw)) {
    throw new ApiError(400, "invalid_body", `\`${field}\` no es válido.`);
  }
  return raw;
}

/** F19's three, checked here rather than by a constraint — see the note on
 *  `offering_article.valueType`. Null is "not an activity". */
function valueTypeFrom(raw: unknown): ValueType | null {
  if (raw === undefined || raw === null) return null;
  if (!isValueType(raw)) {
    throw new ApiError(
      400,
      "invalid_body",
      "`valueType` es `numeric`, `done` o `scale`.",
    );
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
function dateFrom(raw: unknown, field: string): Date | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw new ApiError(400, "invalid_body", `\`${field}\` es una fecha ISO.`);
  }
  const when = new Date(raw);
  if (Number.isNaN(when.getTime())) {
    throw new ApiError(400, "invalid_body", `\`${field}\` no es una fecha.`);
  }
  return when;
}
