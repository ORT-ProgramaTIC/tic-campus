import { request } from "undici";
import type { AuthConfig } from "../config.js";

/**
 * Everything campus's backend says to tic-auth: exchange a code, renew a grant,
 * give one back. MEV's `api/src/auth/token-client.ts`, copied with its reasons.
 *
 * **undici and not global `fetch`, for `jwks.ts`'s reason.** Node's `fetch`
 * silently drops a `Host` header — it is a forbidden header name there — and
 * tic-proxy dispatches on exactly that. Dropping it does not error: nginx serves
 * whatever its default server answers, so the first symptom is a JSON parse
 * failure several layers from the cause. That finding cost MEV a day; this is
 * the second module in this repository that has to honour it.
 *
 * **The outage/refusal split is the contract's** (`CLIENTS.md` §5), and getting
 * it backwards is the expensive mistake: a 5xx or a dead socket keeps a session
 * alive on cached claims, and only a 4xx ends it. The other reading signs the
 * whole school out of campus whenever tic-auth restarts.
 */

export class TokenEndpointError extends Error {
  /** `unavailable` is a 5xx or a dead socket, which keeps a session; anything
   *  else is a refusal, which ends it. */
  constructor(
    message: string,
    readonly unavailable = false,
  ) {
    super(message);
    this.name = "TokenEndpointError";
  }
}

export interface TokenSet {
  accessToken: string;
  /** Absent when this client is not registered for the refresh grant, which is a
   *  working state: the session then lasts its own TTL and never renews. */
  refreshToken: string | null;
  /** Seconds the *grant* is good for, per tic-auth — `min(session expiry,
   *  refresh TTL)`, and not in the RFC. Not a constant of ours: trusting the
   *  server's number is what keeps a campus session from outliving the SSO
   *  session behind it. */
  refreshExpiresIn: number | null;
}

export interface TokenClient {
  exchange(code: string, verifier: string): Promise<TokenSet>;
  refresh(refreshToken: string): Promise<TokenSet>;
  revoke(refreshToken: string): Promise<void>;
}

export function createTokenClient(config: AuthConfig): TokenClient {
  const base = config.internalBaseUrl.replace(/\/$/, "");
  const host = new URL(config.issuer).host;

  async function post(
    path: string,
    form: Record<string, string>,
  ): Promise<unknown> {
    let response;
    try {
      response = await request(`${base}${path}`, {
        method: "POST",
        headers: {
          host,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(form).toString(),
      });
    } catch (cause) {
      throw new TokenEndpointError(
        `no se pudo hablar con tic-auth: ${String(cause)}`,
        true,
      );
    }
    if (response.statusCode >= 500) {
      throw new TokenEndpointError(
        `tic-auth contestó ${response.statusCode}`,
        true,
      );
    }
    const body = await response.body.text();
    if (response.statusCode === 200) {
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw new TokenEndpointError("la respuesta de tic-auth no es JSON");
      }
    }
    // Every 4xx here is `invalid_grant` in effect — a revoked session, a revoked
    // family, an expired grant, a code already spent — and tic-auth answers all
    // of them with one fixed sentence on purpose. Treating the class as one is
    // not laziness, it is the same rule read from this side.
    throw new TokenEndpointError(
      `tic-auth rechazó el pedido (${response.statusCode})`,
    );
  }

  function toTokenSet(payload: unknown): TokenSet {
    const body = (payload ?? {}) as Record<string, unknown>;
    const accessToken =
      typeof body.access_token === "string" ? body.access_token : "";
    if (!accessToken) {
      throw new TokenEndpointError(
        "la respuesta de tic-auth no trae access_token",
      );
    }
    return {
      accessToken,
      refreshToken:
        typeof body.refresh_token === "string" ? body.refresh_token : null,
      refreshExpiresIn:
        typeof body.refresh_expires_in === "number" &&
        body.refresh_expires_in > 0
          ? body.refresh_expires_in
          : null,
    };
  }

  return {
    async exchange(code, verifier) {
      return toTokenSet(
        await post("/token", {
          grant_type: "authorization_code",
          code,
          // The same URI the code was issued for, matched byte for byte a second
          // time here — `/authorize` is not the only place it is compared.
          redirect_uri: config.redirectUri,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code_verifier: verifier,
        }),
      );
    },
    async refresh(refreshToken) {
      return toTokenSet(
        await post("/token", {
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: config.clientId,
          client_secret: config.clientSecret,
        }),
      );
    },
    async revoke(refreshToken) {
      // Best effort, always. Nothing here may fail a logout: the session is
      // cleared either way, and somebody who pressed "Salir" is not owed an
      // error about a credential they never saw.
      try {
        await post("/revoke", {
          token: refreshToken,
          token_type_hint: "refresh_token",
          client_id: config.clientId,
          client_secret: config.clientSecret,
        });
      } catch {
        return;
      }
    },
  };
}
