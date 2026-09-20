import type { NextFunction, Request, RequestHandler, Response } from "express";
import { cookieSpec, read as readCookie } from "../auth/cookies.js";
import type { Renewer } from "../auth/refresh.js";
import {
  idFor,
  type SessionRecord,
  type SessionStore,
} from "../auth/session-store.js";
import type { Config } from "../config.js";

/**
 * Reads campus's own session cookie and puts the session on the request.
 *
 * **There is no bearer path, and there never was one here.** The browser holds a
 * `__Host-` cookie naming a session this process keeps; the tokens never leave
 * the server. The old campus's `Authorization: Bearer <jwt>` in a URL fragment,
 * its `X-Student-Token` header and its student cookie are all gone with the
 * embed (F3) — and accepting one of them beside this would be a downgrade with
 * no way to notice, since anything that could still present a bearer would be a
 * page that kept one.
 *
 * **No JWT verification and no directory lookup per request.** The claims come
 * from the session row, renewed against tic-auth on a clock (`auth/refresh.ts`)
 * rather than re-read per request. `verify()` runs twice in a session's life:
 * at the callback, and on each renewal.
 */
export interface RequestSession {
  id: string;
  record: SessionRecord;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: RequestSession;
    }
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface SessionDeps {
  config: Config;
  store: SessionStore;
  renewer: Renewer;
}

/**
 * Also the CSRF check, on every request that changes something.
 *
 * **`SameSite=Lax` is not enough on its own**, and the reason is ORT's DNS:
 * SameSite is same-***site***, and every `*.ort.edu.ar` host is same-site with
 * this one — including `proyectos.ort.edu.ar`, which serves student-authored
 * code by design. A page there could otherwise make a browser POST here with the
 * session cookie attached.
 *
 * **403 and never 401, and only once the session is known.** The person is
 * signed in; a client that reacted to this by logging in again would loop. A
 * request with no session at all gets the 401 first — which is the answer the
 * browser acts on. It is inside this handler rather than a second middleware
 * because every authenticated route needs both, in that order, and a separate
 * one could be mounted without the other.
 */
export function requireSession({
  config,
  store,
  renewer,
}: SessionDeps): RequestHandler {
  const cookie = cookieSpec(config, "session");
  return (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      const secret = readCookie(req.header("cookie"), cookie.name);
      if (!secret) {
        unauthorized(res, "No iniciaste sesión.");
        return;
      }
      try {
        const id = idFor(secret);
        const stored = await store.read(id);
        if (!stored) {
          unauthorized(res, "Tu sesión expiró. Iniciá sesión de nuevo.");
          return;
        }
        // The freshness rule runs while answering, so the claims a route acts on
        // are the ones tic-auth will still stand behind.
        const record = await renewer.ensureFresh(id, stored);
        if (!record) {
          unauthorized(res, "Tu sesión expiró. Iniciá sesión de nuevo.");
          return;
        }
        req.session = { id, record };

        const presented = req.header("x-csrf-token") ?? "";
        if (!SAFE_METHODS.has(req.method) && presented !== record.csrf) {
          res.status(403).json({
            error: {
              code: "csrf_failed",
              message: "Falta el token CSRF o no es válido.",
            },
          });
          return;
        }
        next();
      } catch (cause) {
        next(cause);
      }
    })();
  };
}

function unauthorized(res: Response, message: string): void {
  res.status(401).json({ error: { code: "no_session", message } });
}
