import type { NextFunction, Request, Response } from "express";

/**
 * One error envelope, and one place that writes it:
 *
 * ```json
 * { "error": { "code": "snake_case", "message": "en castellano" } }
 * ```
 *
 * Success responses carry the resource directly — there is no data envelope
 * (MEV's `api/src/middleware/errors.ts`, which this is a port of, minus its
 * body-parser and streaming cases: campus parses no bodies and streams
 * nothing).
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
