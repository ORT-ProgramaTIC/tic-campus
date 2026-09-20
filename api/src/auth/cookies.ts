import type { Config } from "../config.js";

/**
 * The session cookie's name and flags, decided once. MEV's
 * `api/src/auth/cookies.ts`, renamed.
 *
 * **Two names rather than one flag**, which is tic-auth's own rule: `__Host-` is
 * refused by browsers unless the cookie is `Secure`, `Path=/` and carries no
 * `Domain`, and a browser also refuses it over plain http, which is what local
 * development is. Using a different name in development keeps the production
 * guarantee absolute instead of downgrading it to "usually" — there is no
 * configuration that could serve the weaker form on a real origin, because the
 * weaker name is never read there.
 *
 * **`Secure` is a boot-time boolean and not derived from `X-Forwarded-Proto`.**
 * Deriving it fails *open*: nginx and tic-proxy both stand in front of this
 * process, and a missing header would silently produce a cookie without `Secure`
 * on an origin the browser reached over TLS. A static `true` in production fails
 * closed — the cookie simply does not set, which is loud. tic-auth spent a week
 * in the fail-open state before measuring what FortiWeb actually sends.
 *
 * **`SameSite=Lax`, not Strict.** Strict withholds the cookie on the top-level
 * navigation *back from* `/api/auth/callback`, which is the last hop of every
 * login: the session would be set and then not sent, and campus would look like
 * it signed nobody in.
 *
 * `SameSite` is also not a CSRF defence here, and that is not this file's
 * oversight — see `middleware/session.ts`.
 */
export interface CookieSpec {
  name: string;
  secure: boolean;
}

/** `__Host-tic_campus_session` / `tic_campus_session_dev`, and the same two for
 *  the pre-session login flow. */
export function cookieSpec(
  config: Pick<Config, "production">,
  kind: "session" | "login",
): CookieSpec {
  return {
    name: config.production
      ? `__Host-tic_campus_${kind}`
      : `tic_campus_${kind}_dev`,
    secure: config.production,
  };
}

/** Serialize a cookie. Hand-rolled rather than a dependency: four attributes,
 *  all constants, and the values here are base64url ids that need no escaping. */
export function serialize(
  spec: CookieSpec,
  value: string,
  maxAgeSeconds: number,
): string {
  const parts = [
    `${spec.name}=${value}`,
    "Path=/",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (spec.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clear(spec: CookieSpec): string {
  return serialize(spec, "", 0);
}

/**
 * Read one cookie out of a request header.
 *
 * A parser rather than `cookie-parser`: this process reads exactly two cookies,
 * both of which it set itself, both base64url. A dependency here would be more
 * surface than the problem.
 */
export function read(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const pair of header.split(";")) {
    const index = pair.indexOf("=");
    if (index < 0) continue;
    if (pair.slice(0, index).trim() !== name) continue;
    return pair.slice(index + 1).trim() || null;
  }
  return null;
}
