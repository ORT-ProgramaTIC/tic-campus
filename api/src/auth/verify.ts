import { jwtVerify, type JWTVerifyGetKey } from "jose";

/**
 * Verifying a tic-auth access token. Campus mints nothing and asks nobody (F3).
 *
 * Modelled on MEV's `api/src/auth/verify.ts`, itself modelled on tic-auth's own
 * `scripts/verify_token_externally.py` — which is deliberately written against
 * no shared library, because the claim being tested is that any application can
 * verify a token with a published URL and an off-the-shelf implementation. There
 * is no SDK on purpose: `tic-auth/docs/CONSISTENCY.md` rejects one at this size,
 * since the hard part was never the loop, it is the contract.
 *
 * This is **not OIDC**, whatever the vocabulary elsewhere suggests: no discovery
 * document, no ID token, no `/userinfo`. The only `.well-known` route tic-auth
 * serves is the JWKS, and `directory.*` plays the userinfo role — over SQL, not
 * over HTTP (F5).
 */

/** The claims campus reads. Everything else in the token is tic-auth's business. */
export interface TicAuthClaims {
  /** The decimal `public."user".id`, so it joins straight onto the foreign keys
   *  campus already holds. */
  sub: string;
  roles?: unknown;
  email?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  /** How much the credential is worth: `strong` for a real login, `campus` for
   *  the deprecated relay. */
  acr?: string;
  amr?: unknown;
}

export class AcrError extends Error {}

export interface VerifierOptions {
  issuer: string;
  /** Stated here, and **never read out of the token**. The per-audience claim is
   *  what stops a token minted for another app being replayed against this one. */
  audience: string;
  keySource: JWTVerifyGetKey;
}

export type Verifier = (token: string) => Promise<TicAuthClaims>;

export function createVerifier(options: VerifierOptions): Verifier {
  // A token that fails verification throws — jose's own error, or `AcrError`.
  // It is a REFUSAL, not a fault, and must not reach an error handler as a 500,
  // so both callers, the login callback and the renewer, catch it and refuse.
  // Neither needs to know why.
  return async (token) => {
    const { payload } = await jwtVerify(token, options.keySource, {
      // Pinned, never read from the token's own header. One defence, two
      // attacks: `alg: none` asks the verifier to accept an unsigned token, and
      // `HS256` asks it to treat the RSA *public* key — published at a URL, to
      // everybody — as an HMAC secret. Not a default worth overriding.
      algorithms: ["RS256"],
      issuer: options.issuer,
      audience: options.audience,
      // Lab machines are frozen images whose clocks are set by whatever they
      // last synced with, so a small skew is normal rather than suspicious. It
      // is also the 60 in 840 = 900 − 60, the renewal threshold.
      clockTolerance: 60,
      requiredClaims: ["sub", "exp", "iat", "iss", "aud"],
    });

    const claims = payload as unknown as TicAuthClaims;

    // **`acr` gates the credential's worth, and `roles` does not.** The
    // deprecated campus relay mints `acr=campus` — it proves only that a browser
    // carried a live campus.ort session, and it must never open an app that was
    // not written for it (`tic-auth/docs/CLIENTS.md` §3 and §9). Two values and
    // deliberately not a ladder, so this is `!==` and never a comparison.
    //
    // It lives here rather than in the middleware because campus gates on being
    // signed in and on nothing else (F3; roles are F5's), so this is the only
    // place a credential is judged at all.
    if (claims.acr !== "strong") {
      throw new AcrError(
        `el token trae acr=${String(claims.acr)} y campus sólo acepta "strong"`,
      );
    }

    return claims;
  };
}
