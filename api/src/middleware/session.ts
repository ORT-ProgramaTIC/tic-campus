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
export function requireSession(deps: SessionDeps): RequestHandler {
  const resolve = sessionResolver(deps);
  return (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      try {
        const resolved = await resolve(req);
        // The two are the same refusal and not the same sentence: somebody who
        // never signed in is being told what to do, and somebody whose session
        // died is being told why the page stopped working.
        if (resolved === "anonymous") {
          unauthorized(res, "No iniciaste sesión.");
          return;
        }
        if (resolved === "stale") {
          unauthorized(res, "Tu sesión expiró. Iniciá sesión de nuevo.");
          return;
        }
        req.session = resolved;
        const { record } = resolved;

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

/**
 * The same read, for a route that serves anonymous visitors too (F4).
 *
 * It never refuses: no cookie, a cookie naming a session that is gone, a
 * renewal tic-auth would not grant — all three are simply *not signed in*, and
 * a public offering page still answers 200. There is no CSRF check because
 * there is nothing to protect: this is only ever mounted on reads.
 */
export function optionalSession(deps: SessionDeps): RequestHandler {
  const resolve = sessionResolver(deps);
  return (req: Request, _res: Response, next: NextFunction): void => {
    void (async () => {
      try {
        const resolved = await resolve(req);
        if (typeof resolved !== "string") req.session = resolved;
        next();
      } catch (cause) {
        next(cause);
      }
    })();
  };
}

/**
 * The cookie, the row, and the freshness rule — the part both guards share.
 * The rule runs while answering, so the claims a route acts on are the ones
 * tic-auth will still stand behind.
 *
 * `'anonymous'` is *no cookie was presented* and `'stale'` is *one was, and it
 * names nothing we still hold*. The public reads treat them identically; the
 * guard does not, because they are different sentences to a person.
 */
function sessionResolver({ config, store, renewer }: SessionDeps) {
  const cookie = cookieSpec(config, "session");
  return async (
    req: Request,
  ): Promise<RequestSession | "anonymous" | "stale"> => {
    const secret = readCookie(req.header("cookie"), cookie.name);
    if (!secret) return "anonymous";
    const id = idFor(secret);
    const stored = await store.read(id);
    if (!stored) return "stale";
    const record = await renewer.ensureFresh(id, stored);
    return record ? { id, record } : "stale";
  };
}

function unauthorized(res: Response, message: string): void {
  res.status(401).json({ error: { code: "no_session", message } });
}
