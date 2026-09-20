import type { SessionClaims } from "../db/schema/session.js";
import type { TicAuthClaims } from "./verify.js";

/**
 * The one mapping from a verified token to what campus stores about a person.
 *
 * It is a module of its own because **two paths need it and they must not
 * disagree**: the callback maps a token once, and the renewer maps one every
 * fourteen minutes for the life of the session. Keeping them together is what
 * stops a renewal quietly deciding somebody is a different person from the one
 * who logged in. tic-host's `webapp/refresh.py` gives the same reason for
 * holding its exchange, its verification and its mapping in one file.
 *
 * Nothing relational is in here, because nothing relational is in the token:
 * no enrolments, no courses, no `dni`. Those come from `directory.*` (F5).
 */
export function claimsFrom(claims: TicAuthClaims): SessionClaims {
  return {
    roles: stringsFrom(claims.roles),
    email: claims.email ?? null,
    // `name` is absent from the token when both halves are empty, so the two
    // spellings are not interchangeable and neither is a fallback for a missing
    // person — they are what tic-auth had.
    name: claims.name ?? null,
    givenName: claims.given_name ?? null,
    familyName: claims.family_name ?? null,
    acr: claims.acr ?? null,
    amr: stringsFrom(claims.amr),
  };
}

/**
 * `public."user".id`, or `null`.
 *
 * `sub` is a decimal string for a person and the `client_id` for a machine
 * token, which is why `manage_clients` refuses an all-numeric client id: the two
 * must never be confusable. Refusing anything that is not a safe integer is this
 * side of that same rule.
 */
export function userIdFrom(sub: string): number | null {
  if (!/^\d+$/.test(sub)) return null;
  const id = Number(sub);
  return Number.isSafeInteger(id) ? id : null;
}

function stringsFrom(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
