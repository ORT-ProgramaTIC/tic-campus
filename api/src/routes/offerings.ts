import { Router, type RequestHandler } from "express";
import type { Db } from "../db/client.js";
import { ApiError } from "../middleware/errors.js";
import { actorFrom, capabilitiesFor, NONE } from "../offerings/access.js";
import {
  listActivated,
  listMine,
  resolveBySlug,
} from "../offerings/catalog.js";

/**
 * The public face of an offering (F6, F32).
 *
 * All three routes are mounted whether or not a login is configured: campus's
 * content is public (F4), and `/mine` answers 401 rather than 404 because the
 * session middleware is what refuses it — an unconfigured client secret makes
 * `/api/auth/*` disappear, not these.
 */

/**
 * `?year=2027`, or nothing at all.
 *
 * Absent means the **current** school year, which `directory.*` states as
 * `is_current` — never `new Date().getFullYear()`, which is the same answer
 * until it is not, in the weeks either side of a year change.
 *
 * Four digits, validated with a regex rather than zod: it is the whole of this
 * slice's input, and MEV validates path parameters the same way.
 */
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

export interface OfferingGuards {
  /** Refuses without a session. */
  guard: RequestHandler;
  /** Attaches one if there is one, and never refuses. */
  maybeSession: RequestHandler;
}

export function createOfferingRoutes(
  db: Db,
  { guard, maybeSession }: OfferingGuards,
): Router {
  const router = Router();

  // Every offering campus has activated for a year: what an anonymous visitor
  // picks from (F6).
  router.get("/", (req, res, next) => {
    void (async () => {
      try {
        res.status(200).json(await listActivated(db, yearFrom(req.query.year)));
      } catch (cause) {
        next(cause);
      }
    })();
  });

  // Ahead of `/:year/:subject/:offering`, which would otherwise match `/mine`
  // as a year and answer 400 for it. Express routes in mount order.
  router.get("/mine", guard, (req, res, next) => {
    void (async () => {
      try {
        const { record } = req.session!;
        const actor = actorFrom(record.userId, record.claims);
        res
          .status(200)
          .json(await listMine(db, actor, yearFrom(req.query.year)));
      } catch (cause) {
        next(cause);
      }
    })();
  });

  /**
   * A public URL, resolved (F32) — with what this caller may do with it (F5).
   *
   * The capabilities ride along because every client that opens a home needs
   * them to decide what to render, and asking separately would be a second
   * round trip that can disagree with the first. Anonymous callers get all
   * three false rather than a missing key, so there is no shape to branch on.
   */
  router.get("/:year/:subject/:offering", maybeSession, (req, res, next) => {
    void (async () => {
      try {
        const year = yearFrom(req.params.year);
        if (year === undefined)
          throw new ApiError(404, "not_found", "No encontrado.");
        const offering = await resolveBySlug(
          db,
          year,
          String(req.params.subject),
          String(req.params.offering),
        );
        if (!offering) {
          throw new ApiError(
            404,
            "not_found",
            "No encontramos esa materia. Puede que le hayan cambiado el nombre.",
          );
        }
        const session = req.session;
        const can = session
          ? await capabilitiesFor(
              db,
              actorFrom(session.record.userId, session.record.claims),
              offering.offeringId,
              offering.subjectId,
            )
          : NONE;
        res.status(200).json({ ...offering, can });
      } catch (cause) {
        next(cause);
      }
    })();
  });

  return router;
}
