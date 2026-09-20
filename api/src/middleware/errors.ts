import type { NextFunction, Request, Response } from "express";

/**
 * One error envelope, and one place that writes it:
 *
 * ```json
 * { "error": { "code": "snake_case", "message": "en castellano" } }
 * ```
 *
 * Success responses carry the resource directly — there is no data envelope
 * (MEV's `api/src/middleware/errors.ts`, which this is a port of. Its
 * body-parser cases came back with slice 5, where campus started parsing
 * bodies, and its streaming case with slice 6: `GET /api/uploads/:id` hands a
 * file to `res.sendFile`, so "campus streams nothing" stopped being true —
 * which is why `headersSent` below is load-bearing now and not just careful.)
 *
 * **Slice 3 had no handler at all.** Its two routes wrote the envelope by hand
 * and a thrown error reached Express 5's default, which answers with an HTML
 * page and, outside production, the stack trace in it. `session.ts` keeps its
 * two literals — they are the same envelope — and its `next(cause)` now lands
 * here.
 *
 * Messages are user-facing Spanish, because they are read by students and
 * teachers; codes are what a client branches on and never change with the
 * wording.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function notFound(_req: Request, res: Response): void {
  res
    .status(404)
    .json({ error: { code: "not_found", message: "No encontrado." } });
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // Something already began answering. There is nothing useful to say in-band
  // and a second `res.json` would throw on top of the first failure.
  if (res.headersSent) {
    res.end();
    return;
  }

  if (err instanceof ApiError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message },
    });
    return;
  }

  const fromBody = bodyParserError(err) ?? multerError(err);
  if (fromBody) {
    res.status(fromBody.status).json({
      error: { code: fromBody.code, message: fromBody.message },
    });
    return;
  }

  // Unexpected, so it is logged here and nowhere else: a route that both logs
  // and rethrows produces two records of one failure. `console` rather than
  // pino because nothing in this process has a logger yet — Vercel is not where
  // this runs and `docker logs tic-campus-api` reads stdout fine.
  console.error("unhandled error", err);
  res.status(500).json({
    error: {
      code: "internal_error",
      message: "Algo se rompió de nuestro lado.",
    },
  });
}

/**
 * `express.json()` throws its own errors, and none of them are `ApiError` —
 * so without this a teacher whose browser sent a truncated body would be told
 * campus broke, in a 500, and the failure would be logged as unexplained.
 *
 * They carry `status` and a `type` string rather than a class to match on
 * (body-parser sets both), and slice 5 is the first to parse a body at all.
 */
function bodyParserError(
  err: unknown,
): { status: number; code: string; message: string } | null {
  if (typeof err !== "object" || err === null) return null;
  const { type, status } = err as { type?: unknown; status?: unknown };

  if (type === "entity.too.large") {
    return {
      status: 413,
      code: "body_too_large",
      message: "Eso es demasiado grande para mandar de una.",
    };
  }
  if (type === "encoding.unsupported" || type === "charset.unsupported") {
    return {
      status: 415,
      code: "unsupported_encoding",
      message: "No entendemos esa codificación.",
    };
  }
  if (err instanceof SyntaxError && status === 400 && "body" in err) {
    return {
      status: 400,
      code: "invalid_json",
      message: "El cuerpo del pedido no es JSON válido.",
    };
  }
  return null;
}

/**
 * multer's refusals (F9), which are neither `ApiError` nor body-parser's — so
 * without this a 21 MB file is a 500 logged as something unexplained, and the
 * teacher is told campus broke when campus worked exactly as designed.
 *
 * Matched on `name` rather than `instanceof MulterError`, so this file keeps
 * importing nothing: it is the one place that answers for everybody, and it
 * should not depend on whichever parser a route happens to use.
 */
function multerError(
  err: unknown,
): { status: number; code: string; message: string } | null {
  if (typeof err !== "object" || err === null) return null;
  const { name, code } = err as { name?: unknown; code?: unknown };
  if (name !== "MulterError") return null;

  if (code === "LIMIT_FILE_SIZE") {
    return {
      status: 413,
      code: "file_too_large",
      message: "El archivo pasa los 20 MB. Si es un video, va a YouTube.",
    };
  }
  return {
    status: 400,
    code: "invalid_upload",
    message: "No pudimos leer el archivo — mandá uno solo, en el campo «file».",
  };
}
