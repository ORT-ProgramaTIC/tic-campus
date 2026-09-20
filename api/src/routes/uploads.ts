import { Router } from "express";
import type { Db } from "../db/client.js";
import { isUuid } from "../library/program.js";
import {
  contentDisposition,
  pathFor,
  readUpload,
  serveAs,
} from "../library/uploads.js";
import { ApiError } from "../middleware/errors.js";

/**
 * The bytes of an upload (F9).
 *
 * **Public, and with no session middleware at all** — not even
 * `optionalSession`. An article's images are `<img>` tags on a page anybody may
 * read (F4), and reading and renewing a session for each one would put a
 * database write on the path of every picture on the site.
 *
 * Which is to say the uuid *is* the credential. That is F9's decision and its
 * reasoning is there: the api cannot know which articles reference a file
 * without parsing Markdown (F7, F44), and the check F37 asked for would only
 * have stopped somebody guessing an id.
 *
 * Mounted on its own prefix rather than under `/api/subjects/:id/uploads`,
 * because that router is `guard`ed as a whole and this is the one read that
 * must not be.
 */
export function createUploadRoutes(db: Db, uploadsDir: string): Router {
  const router = Router();

  router.get("/:id", (req, res, next) => {
    void (async () => {
      try {
        const id = String(req.params.id);
        // Checked before it reaches `pathFor`: a path is built from this.
        if (!isUuid(id)) throw notFound();

        const found = await readUpload(db, id);
        if (!found) throw notFound();

        const { contentType, disposition } = serveAs(found.mediaType);
        res.sendFile(
          pathFor(uploadsDir, id),
          {
            // `sendFile` would otherwise guess a type from the path, which has
            // no extension. These are applied as the response goes out, so this
            // decision wins over its guess.
            headers: {
              "Content-Type": contentType,
              "Content-Disposition": contentDisposition(
                found.filename,
                disposition,
              ),
              // Belt and braces with `serveAs`: never let a browser sniff an
              // octet-stream back into something it will execute.
              "X-Content-Type-Options": "nosniff",
            },
            // The bytes at an id never change — a new file is a new id.
            maxAge: "1y",
            immutable: true,
          },
          (cause?: Error) => {
            // A row with no file is a lost volume, not a missing page: it is
            // worth a 500 in the log rather than a quiet 404 that looks like
            // the teacher never uploaded it.
            if (cause) next(cause);
          },
        );
      } catch (cause) {
        next(cause);
      }
    })();
  });

  return router;
}

function notFound(): ApiError {
  return new ApiError(404, "not_found", "No encontramos ese archivo.");
}
