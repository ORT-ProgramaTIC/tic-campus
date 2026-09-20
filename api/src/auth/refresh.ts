import type { AuthConfig } from "../config.js";
import type { SessionRecord, SessionStore } from "./session-store.js";
import { TokenEndpointError, type TokenClient } from "./token-client.js";
import { claimsFrom } from "./claims.js";
import type { Verifier } from "./verify.js";

/**
 * Keeping a campus session in step with tic-auth. MEV's
 * `api/src/auth/refresh.ts`, with its role ladder removed — campus gates on
 * being signed in and on nothing else (F3; roles are F5's).
 *
 * Every renewal re-reads the person's claims and re-checks that the SSO session
 * is live, so a central logout or a deactivated account reaches campus within
 * one access-token TTL instead of never. "Never" is what a session is when it is
 * a snapshot taken at login, which is what the old campus's JWT was.
 *
 * Three outcomes, and each is a decision rather than an accident:
 *
 * - **Renewed.** New tokens, new `claimsAt`, and the expiry tightened if the
 *   grant now ends sooner. The CSRF token and the session id are untouched, so
 *   every open tab keeps working.
 * - **Refused** (`invalid_grant`) — the session is over. It is destroyed, the
 *   request 401s, and the browser starts a login: with a live SSO session that
 *   is one invisible round trip.
 * - **Unavailable** — tic-auth could not be reached. The session is *kept* and a
 *   backoff recorded. An outage is not a revocation, and the bound that still
 *   applies is the session's own expiry, which an outage cannot extend.
 *
 * **One renewal per refresh token, however many requests hold it.** tic-auth
 * rotates on every use and answers a replay by revoking the family, so a page
 * firing six calls at once against a session whose claims just went stale would
 * sign itself out — under load, and never in a test. The in-flight map is what
 * stops that: the second caller awaits the first's promise rather than
 * presenting a token that no longer exists.
 *
 * ponytail: the map is per process, which is enough while there is one
 * `tic-campus-api` container — a session's requests all reach the process
 * holding it. A second replica needs the lock in the database instead:
 * `SELECT … FOR UPDATE` on the session row, which is why the session is a table
 * and not a sealed cookie. tic-host reached the same conclusion for the same
 * reason (`tic/webapp/refresh.py`, `RefreshCoordinator`).
 */

export type Renewer = ReturnType<typeof createRenewer>;

export function createRenewer({
  config,
  store,
  tokens,
  verify,
}: {
  config: AuthConfig;
  store: SessionStore;
  tokens: TokenClient;
  verify: Verifier;
}) {
  const inFlight = new Map<string, Promise<SessionRecord | null>>();
  const maxAgeMs = config.claimsMaxAgeSeconds * 1000;
  const retryMs = config.refreshRetrySeconds * 1000;

  async function renew(
    id: string,
    current: SessionRecord,
  ): Promise<SessionRecord | null> {
    const now = Date.now();
    let next;
    try {
      next = await tokens.refresh(current.refreshToken!);
    } catch (cause) {
      if (cause instanceof TokenEndpointError && cause.unavailable) {
        const kept = { ...current, retryAfter: now + retryMs };
        await store.write(id, kept);
        return kept;
      }
      await store.destroy(id);
      return null;
    }

    let claims;
    try {
      claims = await verify(next.accessToken);
    } catch {
      // tic-auth minted something this deployment will not accept — a rotated
      // key it cannot fetch, a changed audience, an `acr` that is not `strong`.
      // Ending the session is right: the alternative is serving claims we have
      // just been told are no longer authoritative.
      await store.destroy(id);
      return null;
    }

    const renewed: SessionRecord = {
      ...current,
      claims: claimsFrom(claims),
      // Rotation-tolerant: tic-auth always sends a new one, and a client that
      // assumed so and was wrong would spend a token it no longer has.
      refreshToken: next.refreshToken ?? current.refreshToken,
      claimsAt: now,
      expiresAt: next.refreshExpiresIn
        ? Math.min(current.expiresAt, now + next.refreshExpiresIn * 1000)
        : current.expiresAt,
      retryAfter: undefined,
    };
    await store.write(id, renewed);
    return renewed;
  }

  return {
    async ensureFresh(
      id: string,
      current: SessionRecord,
    ): Promise<SessionRecord | null> {
      const now = Date.now();
      if (now >= current.expiresAt) {
        await store.destroy(id);
        return null;
      }
      if (!current.refreshToken) return current;
      if (now < current.claimsAt + maxAgeMs) return current;
      if (current.retryAfter && now < current.retryAfter) return current;

      // **No `await` between the `get` and the `set`.** One suspension point
      // here and two concurrent requests both start a renewal, which is exactly
      // the replay tic-auth answers by revoking the family.
      const running = inFlight.get(id);
      if (running) return running;
      const attempt = renew(id, current).finally(() => inFlight.delete(id));
      inFlight.set(id, attempt);
      return attempt;
    },
  };
}
