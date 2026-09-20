import { Router, type RequestHandler, type Request } from "express";
import multer from "multer";
import type { Db } from "../db/client.js";
import {
  archiveArticle,
  checkSlug,
  createArticle,
  listLibrary,
  publishArticle,
  readArticle,
  readVersion,
  saveDraft,
} from "../library/articles.js";
import {
  checkUnits,
  deleteUnit,
  isUuid,
  readProgram,
  writeProgram,
} from "../library/program.js";
import {
  checkFilename,
  checkMediaType,
  listUploads,
  saveUpload,
} from "../library/uploads.js";
import { ApiError } from "../middleware/errors.js";
import { actorFrom, teachesSubject } from "../offerings/access.js";

/**
 * F9's 20 MB, on its own parser. `index.ts` keeps JSON at 1 MB.
 *
 * **`defParamCharset` is not optional here.** busboy's default is `latin1`, and
 * these are Spanish filenames: `Guía de TPs.pdf` arrives as `GuÃ­a de TPs.pdf`,
 * is stored that way, and comes back out of the database mojibaked forever.
 * Measured against multer 2.4.0 before it was set.
 */
const multipart = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  defParamCharset: "utf8",
});

/**
 * A subject's library: its articles and its program (F7, F8, F11, F15).
 *
 * **Scoped to a subject, not to an offering**, because that is what the library
 * is. Editing it is `editLibrary` (F5): teaching *any* offering of the subject,
 * in any year. A teacher fixing a typo in a 2026 article does not have to
 * still be teaching 2026.
 *
 * Nothing here reads or writes an offering. What an offering *does* with an
 * article — where it sits, when it appears, who may read it — is `/api/homes`.
 */

/** A `directory.subject` id: tic-auth's integers, same shape as an offering's. */
function subjectIdFrom(raw: string): number {
  if (!/^\d{1,9}$/.test(raw)) {
    throw new ApiError(404, "not_found", "No encontrado.");
  }
  return Number(raw);
}

function uuidFrom(raw: string): string {
  if (!isUuid(raw)) throw new ApiError(404, "not_found", "No encontrado.");
  return raw;
}

/** A slug in the path is matched, not created, so it is not `checkSlug`'d. */
function slugFrom(raw: string): string {
  if (!/^[a-z0-9-]{1,80}$/.test(raw)) {
    throw new ApiError(404, "not_found", "No encontrado.");
  }
  return raw;
}

function bodyText(raw: unknown, what: string): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new ApiError(400, "invalid_body", `Falta ${what}.`);
  }
  if (raw.length > 200) {
    throw new ApiError(400, "invalid_body", `${what} es demasiado largo.`);
  }
  return raw;
}

export function createLibraryRoutes(
  db: Db,
  guard: RequestHandler,
  uploadsDir: string,
): Router {
  const router = Router();
  router.use(guard);

  /**
   * Every route here answers for one subject, so the gate is one helper rather
   * than a middleware: `req.params.subjectId` is the router's own parameter and
   * a middleware would have to re-parse it to say anything useful.
   *
   * 403 and never 401 — the person is signed in and refused.
   */
  async function mustEdit(req: Request): Promise<number> {
    const subjectId = subjectIdFrom(String(req.params.subjectId));
    const { record } = req.session!;
    const may = await teachesSubject(
      db,
      actorFrom(record.userId, record.claims),
      subjectId,
    );
    if (!may) {
      throw new ApiError(
        403,
        "forbidden",
        "Esto lo edita quien da esta materia.",
      );
    }
    return subjectId;
  }

  router.get("/:subjectId/articles", (req, res, next) => {
    void (async () => {
      try {
        res.status(200).json(await listLibrary(db, await mustEdit(req)));
      } catch (cause) {
        next(cause);
      }
    })();
  });

  /**
   * The slug is set once and becomes the last segment of a public URL (F32),
   * so it is the caller's to choose and this is the only place it is written.
   * Re-creating an archived article under its own slug brings that one back —
   * the unique index is total, so otherwise a typo would burn the URL forever.
   */
  router.post("/:subjectId/articles", (req, res, next) => {
    void (async () => {
      try {
        const subjectId = await mustEdit(req);
        const body = (req.body ?? {}) as Record<string, unknown>;
        const created = await createArticle(
          db,
          subjectId,
          checkSlug(body.slug),
          bodyText(body.title, "el título"),
        );
        res.status(201).json(created);
      } catch (cause) {
        next(cause);
      }
    })();
  });

  // The draft, the published pointer, and the history to restore from (F11).
  // The revisions come inline: without them there is nothing to restore *from*,
  // and they are a handful of rows over an index that already exists.
  router.get("/:subjectId/articles/:slug", (req, res, next) => {
    void (async () => {
      try {
        const subjectId = await mustEdit(req);
        const found = await readArticle(
          db,
          subjectId,
          slugFrom(req.params.slug),
        );
        if (!found) {
          throw new ApiError(404, "not_found", "No encontramos ese artículo.");
        }
        res.status(200).json(found);
      } catch (cause) {
        next(cause);
      }
    })();
  });

  /**
   * One revision's body. **Restoring is this plus a `PUT …/draft`** — a verb of
   * its own would be a name for something the client already has two calls for.
   */
  router.get(
    "/:subjectId/articles/:slug/versions/:versionId",
    (req, res, next) => {
      void (async () => {
        try {
          const subjectId = await mustEdit(req);
          const version = await readVersion(
            db,
            subjectId,
            slugFrom(req.params.slug),
            uuidFrom(req.params.versionId),
          );
          if (!version) {
            throw new ApiError(404, "not_found", "No encontramos esa versión.");
          }
          res.status(200).json(version);
        } catch (cause) {
          next(cause);
        }
      })();
    },
  );

  // `baseVersionId` is the draft this edit started from. Saving against a stale
  // one is refused, naming who moved it (F12) — retrying wins.
  router.put("/:subjectId/articles/:slug/draft", (req, res, next) => {
    void (async () => {
      try {
        const subjectId = await mustEdit(req);
        const body = (req.body ?? {}) as Record<string, unknown>;
        if (typeof body.body !== "string") {
          throw new ApiError(
            400,
            "invalid_body",
            "Falta el texto del artículo.",
          );
        }
        const base = body.baseVersionId ?? null;
        if (base !== null && !isUuid(base)) {
          throw new ApiError(
            400,
            "invalid_body",
            "`baseVersionId` no es válido.",
          );
        }
        res
          .status(200)
          .json(
            await saveDraft(
              db,
              subjectId,
              slugFrom(req.params.slug),
              req.session!.record.userId,
              body.body,
              base,
            ),
          );
      } catch (cause) {
        next(cause);
      }
    })();
  });

  // Moving the pointer, which reaches every offering using the article at once,
  // past years included (F8). No deploy, and no per-offering copy to update.
  router.post("/:subjectId/articles/:slug/publish", (req, res, next) => {
    void (async () => {
      try {
        const subjectId = await mustEdit(req);
        res
          .status(200)
          .json(await publishArticle(db, subjectId, slugFrom(req.params.slug)));
      } catch (cause) {
        next(cause);
      }
    })();
  });

  router.delete("/:subjectId/articles/:slug", (req, res, next) => {
    void (async () => {
      try {
        const subjectId = await mustEdit(req);
        await archiveArticle(db, subjectId, slugFrom(req.params.slug));
        res.status(200).json({ archived: true });
      } catch (cause) {
        next(cause);
      }
    })();
  });

  router.get("/:subjectId/program", (req, res, next) => {
    void (async () => {
      try {
        res.status(200).json(await readProgram(db, await mustEdit(req)));
      } catch (cause) {
        next(cause);
      }
    })();
  });

  /**
   * The whole list in one call: array order is the order (F15).
   *
   * **It never deletes.** A teacher saving a list they loaded before a
   * colleague added a unit would otherwise wipe that unit, and with it every
   * article filed under it — silently, and with no version history to recover
   * from. Removing one is the `DELETE` below.
   */
  router.put("/:subjectId/program", (req, res, next) => {
    void (async () => {
      try {
        const subjectId = await mustEdit(req);
        const body = (req.body ?? {}) as Record<string, unknown>;
        res
          .status(200)
          .json(await writeProgram(db, subjectId, checkUnits(body.units)));
      } catch (cause) {
        next(cause);
      }
    })();
  });

  router.delete("/:subjectId/program/:unitId", (req, res, next) => {
    void (async () => {
      try {
        const subjectId = await mustEdit(req);
        await deleteUnit(db, subjectId, uuidFrom(req.params.unitId));
        res.status(200).json({ deleted: true });
      } catch (cause) {
        next(cause);
      }
    })();
  });

  /**
   * The subject's files (F9). Here rather than in a router of their own
   * because an upload is library — the same subject, the same `editLibrary`
   * gate, the same `mustEdit`. Only *serving* them is elsewhere, and only
   * because that read must not be behind `guard`.
   *
   * **There is no `DELETE`.** Nothing here knows which articles reference a
   * file — the reference is Markdown, which the api does not parse (F7, F44) —
   * so a delete would break articles silently and with nothing to restore
   * from, unlike an article's own version history (F11). It waits for an
   * editor that can show a teacher where a file is used.
   */
  router.get("/:subjectId/uploads", (req, res, next) => {
    void (async () => {
      try {
        res.status(200).json(await listUploads(db, await mustEdit(req)));
      } catch (cause) {
        next(cause);
      }
    })();
  });

  /**
   * `multipart/form-data`, field `file`, **20 MB** (F9) — a different parser
   * and a different limit from the 1 MB `express.json()` in `index.ts`, and
   * deliberately so: that cap is for an article's Markdown.
   *
   * The parser is mounted on this one route and never with `router.use`, so no
   * other route in this file grows a multipart body.
   *
   * ponytail: `memoryStorage` buffers the whole 20 MB before it is written.
   * One file at a time from a handful of teachers is nothing; move to
   * `diskStorage` if that stops being true.
   */
  router.post(
    "/:subjectId/uploads",
    multipart.single("file"),
    (req, res, next) => {
      void (async () => {
        try {
          const subjectId = await mustEdit(req);
          const file = req.file;
          if (!file) {
            throw new ApiError(
              400,
              "invalid_upload",
              "Falta el archivo — mandalo en el campo «file».",
            );
          }
          const { record } = req.session!;
          res.status(201).json(
            await saveUpload(db, uploadsDir, subjectId, record.userId, {
              filename: checkFilename(file.originalname),
              mediaType: checkMediaType(file.mimetype),
              bytes: file.buffer,
            }),
          );
        } catch (cause) {
          next(cause);
        }
      })();
    },
  );

  return router;
}
