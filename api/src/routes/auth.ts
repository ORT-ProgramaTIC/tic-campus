import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type RequestHandler } from "express";
import { claimsFrom, userIdFrom } from "../auth/claims.js";
import {
  clear,
  cookieSpec,
  read as readCookie,
  serialize,
} from "../auth/cookies.js";
import {
  idFor,
  LOGIN_TTL_MS,
  newSecret,
  type SessionRecord,
  type SessionStore,
} from "../auth/session-store.js";
import { TokenEndpointError, type TokenClient } from "../auth/token-client.js";
import type { Verifier } from "../auth/verify.js";
import type { AuthConfig, Config } from "../config.js";

/**
 * Campus's login: four routes, and they are the OAuth client.
 *
 * `tic-auth/docs/CLIENTS.md` is the contract and §3's ordering is what
 * `/callback` implements — check the error, the presence, the state, the age,
 * then exchange, then verify, then map the claims, then establish. Each step is
 * cheaper than the next, and the one after should never run on a request the one
 * before would have refused.
 *
 * **The browser only ever talks to this origin.** It never sees a token, never
 * calls tic-auth with `fetch`, and never holds anything but an opaque cookie.
 * That is the whole of F3, and it is why none of the old campus's machinery —
 * the URL-fragment JWT, `jwtSecureCode` rotation, the student token, the Safari
 * ITP workarounds — has an equivalent here: all of it existed because of the
 * embed and a backend on another registrable domain.
 */
export interface AuthDeps {
  store: SessionStore;
  verify: Verifier;
  tokens: TokenClient;
}

function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** A path inside this app, or nothing. `//evil.test` and `/\evil.test` are the
 *  two that look like paths and are not — every browser reads both as
 *  protocol-relative authorities. Sanitised on the way IN, so the callback's
 *  redirect needs no second check. */
export function sanitizeNext(raw: unknown): string {
  const value = typeof raw === "string" ? raw : "";
  if (!value.startsWith("/")) return "";
  if (value.startsWith("//") || value.startsWith("/\\")) return "";
  return value;
}

/** Constant time, and length-safe: `timingSafeEqual` throws on a length
 *  mismatch rather than returning false. */
function sameState(presented: string, stored: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function logoutUrlFor(auth: AuthConfig): string {
  // `client_id` is the whole of it: where somebody lands after confirming comes
  // from the `home_uri` in tic-auth's registry, never from a parameter campus
  // passes.
  return `${auth.issuer.replace(/\/$/, "")}/logout?${new URLSearchParams({
    client_id: auth.clientId,
  }).toString()}`;
}

export function createAuthRoutes(
  config: Config,
  auth: AuthConfig,
  guard: RequestHandler,
  deps: AuthDeps,
): Router {
  const router = Router();
  const session = cookieSpec(config, "session");
  const login = cookieSpec(config, "login");

  /**
   * A top-level navigation, never a `fetch`: the browser has to *go* to
   * tic-auth, and an XHR to another origin would be answered with a login page
   * it cannot render.
   *
   * The `state` and the PKCE verifier live in `campus.login_flow` behind a
   * short-lived cookie rather than in the session — there is no session yet —
   * and the cookie is single use, spent by the callback either way.
   */
  router.get("/login", (req, res, next) => {
    void (async () => {
      try {
        // Swept here rather than in the callback, because this is where rows are
        // born: the route is unauthenticated and writes one per call, so an
        // abandoned flow — a closed tab, a crawler — would otherwise accumulate
        // with nothing ever deleting it. One sweep per login attempt bounds both
        // tables to what is still live.
        await deps.store.sweepExpired();
        const verifier = newSecret();
        const state = newSecret();
        const secret = newSecret();
        await deps.store.startLogin(idFor(secret), {
          state,
          verifier,
          next: sanitizeNext(req.query.next),
        });
        const query = new URLSearchParams({
          response_type: "code",
          client_id: auth.clientId,
          redirect_uri: auth.redirectUri,
          state,
          audience: auth.audience,
          code_challenge: challengeFor(verifier),
          // `plain` is refused by tic-auth and an absent method *means* `plain`,
          // so this is stated rather than defaulted. Same for `audience`: the
          // registration's order decides it otherwise, and a silent reorder
          // would mint tokens campus rejects with the cause recorded nowhere.
          code_challenge_method: "S256",
        });
        // No `scope` at all: campus registers none — it reads the directory over
        // SQL, never over tic-auth's HTTP API — and `narrow_scopes` refuses a
        // scope outside the registered set rather than dropping it quietly.
        res.setHeader(
          "Set-Cookie",
          serialize(login, secret, LOGIN_TTL_MS / 1000),
        );
        // The public issuer and never the internal base URL: this is the one URL
        // a person's browser follows, and it reaches tic-auth through FortiWeb
        // like any other public host.
        res.redirect(
          302,
          `${auth.issuer.replace(/\/$/, "")}/authorize?${query.toString()}`,
        );
      } catch (cause) {
        next(cause);
      }
    })();
  });

  /**
   * **No per-IP throttle here, which `CLIENTS.md` §3 asks for, and the reason is
   * that this callback cannot be the amplifier it describes.** Nothing reaches
   * tic-auth until `takeLogin` has found a flow row this process created and
   * matched its `state`, so a caller with no flow cookie is refused by a single
   * indexed DELETE and never leaves the box. MEV's callback took the same
   * reading. What an attacker *can* drive unauthenticated is `/login` above,
   * which writes a row rather than calling anybody — hence the sweep there. If a
   * throttle is ever added it belongs on both, and in tic-proxy rather than in
   * this process, which is where a limit can outlive a restart.
   */
  router.get("/callback", (req, res, next) => {
    void (async () => {
      // Clearing the flow cookie on every path out, because it is spent either
      // way — a login state that survived its callback would let a code be
      // presented twice, and tic-auth answers the second by revoking a family.
      const refuse = (reason: string): void => {
        res.setHeader("Set-Cookie", clear(login));
        res.redirect(302, `/?auth_error=${encodeURIComponent(reason)}`);
      };

      try {
        const secret = readCookie(req.header("cookie"), login.name);
        const code = typeof req.query.code === "string" ? req.query.code : "";
        const state =
          typeof req.query.state === "string" ? req.query.state : "";
        if (req.query.error || !code || !state || !secret) {
          refuse("unverified");
          return;
        }

        // Single use and age-checked in one statement. An expired flow (600 s)
        // and a forged one are the same answer on purpose.
        const started = await deps.store.takeLogin(idFor(secret));
        if (!started || !sameState(state, started.state)) {
          refuse("unverified");
          return;
        }

        let tokens;
        try {
          tokens = await deps.tokens.exchange(code, started.verifier);
        } catch (cause) {
          if (cause instanceof TokenEndpointError && cause.unavailable) {
            // An outage, and not this browser's fault. A distinct answer,
            // because "no pudimos verificar tu identidad" is a sentence about
            // the person.
            res.setHeader("Set-Cookie", clear(login));
            res.status(503).json({
              error: {
                code: "idp_unavailable",
                message: "El servicio de identidad no responde.",
              },
            });
            return;
          }
          refuse("unverified");
          return;
        }

        let claims;
        try {
          claims = await deps.verify(tokens.accessToken);
        } catch {
          refuse("unverified");
          return;
        }

        const userId = userIdFrom(claims.sub);
        if (userId === null) {
          refuse("unverified");
          return;
        }

        // No role gate: campus is for students, teachers and admins alike, and
        // its content is public anyway (F4). Being signed in is the whole
        // question this slice asks; F5 is what reads `claims.roles`.
        const now = Date.now();
        const record: SessionRecord = {
          userId,
          claims: claimsFrom(claims),
          refreshToken: tokens.refreshToken,
          claimsAt: now,
          // Never longer than the grant behind it: a session that outlived the
          // SSO session is exactly the stale snapshot this design removes.
          expiresAt: tokens.refreshExpiresIn
            ? Math.min(
                now + auth.sessionTtlSeconds * 1000,
                now + tokens.refreshExpiresIn * 1000,
              )
            : now + auth.sessionTtlSeconds * 1000,
          csrf: newSecret(),
        };

        const sessionSecret = newSecret();
        await deps.store.create(idFor(sessionSecret), record);
        res.setHeader("Set-Cookie", [
          clear(login),
          serialize(
            session,
            sessionSecret,
            Math.ceil((record.expiresAt - now) / 1000),
          ),
        ]);
        res.redirect(302, started.next || "/");
      } catch (cause) {
        next(cause);
      }
    })();
  });

  /**
   * Clears campus's session and **gives the refresh token back** before the
   * browser is handed to tic-auth's confirmation page. Somebody who then
   * declines it keeps their SSO session, and without the revocation campus would
   * have left a twelve-hour grant redeemable in a table for a credential it had
   * already thrown away.
   *
   * The same 200 with no session, so a browser holding a stale cookie is not
   * told anything about it.
   */
  const logout: RequestHandler = (req, res, next) => {
    void (async () => {
      try {
        const stored = req.session;
        if (stored) {
          if (stored.record.refreshToken) {
            await deps.tokens.revoke(stored.record.refreshToken);
          }
          await deps.store.destroy(stored.id);
        }
        res.setHeader("Set-Cookie", clear(session));
        res.status(200).json({ idp_logout_url: logoutUrlFor(auth) });
      } catch (cause) {
        next(cause);
      }
    })();
  };
  router.post("/logout", guard, logout);

  return router;
}

/**
 * `GET /api/me` — the browser's boot call and its re-probe.
 *
 * `requireSession` has already run the freshness rule while answering it, so a
 * session tic-auth stopped renewing — somebody pressed "Salir" in another app —
 * is a 401 here rather than a stale 200. It is the only place besides the login
 * that the CSRF token leaves the server.
 */
export function createMeRoute(auth: AuthConfig): RequestHandler {
  return (req, res) => {
    const { record } = req.session!;
    // Projected field by field rather than handing back the record: `acr` and
    // the refresh token are exactly what leaks into a contract otherwise.
    res.status(200).json({
      me: {
        id: record.userId,
        email: record.claims.email,
        name: record.claims.name,
        given_name: record.claims.givenName,
        family_name: record.claims.familyName,
        roles: record.claims.roles,
      },
      csrf_token: record.csrf,
      idp_logout_url: logoutUrlFor(auth),
    });
  };
}
