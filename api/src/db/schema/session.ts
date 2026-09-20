import { integer, jsonb, text, timestamp } from "drizzle-orm/pg-core";
import { campus } from "./_schema.js";
import { directoryUserTable } from "./directory.js";

/**
 * Campus's own sessions, and the ten minutes of state that precede one (F3).
 *
 * **What the browser holds is an id, and nothing else.** The tokens live here,
 * on the server, behind an HttpOnly cookie — `tic-auth/docs/CLIENTS.md` §4's
 * shape, and the whole reason the old campus's URL-fragment JWT, its
 * `jwtSecureCode` rotation and its student token are all gone.
 *
 * **A table rather than Redis or a sealed cookie**, both of which §4 also
 * allows. Redis would be a container to back up and monitor for one feature;
 * this stack has a Postgres already, its migrator grants the runtime role DML on
 * whatever is in the schema barrel, and tic-platform's dump already covers it. A
 * sealed cookie would need a fourth hand-placed secret and its rotation story,
 * and would make the 60 s memo of a rotated refresh token mandatory rather than
 * optional — the request that never received its `Set-Cookie` otherwise presents
 * a spent token, and tic-auth answers that by revoking the family.
 *
 * The cost accepted is one read per authenticated request against a pool of ten,
 * of `campus_svc`'s fifteen (`tic-platform/bin/limits.sh`, whose doctor warns at
 * twelve).
 */

/** The mapped claims, as `/api/me` will hand them out. A jsonb column rather
 *  than a column each: nothing queries by them, F5 will add fields, and a
 *  migration per claim is a migration for a shape tic-auth owns. */
export interface SessionClaims {
  /** Every role key tic-auth sent, kept whole. Campus gates on being signed in
   *  and on nothing else today (F3) — F5 is what reads these. */
  roles: string[];
  email: string | null;
  name: string | null;
  givenName: string | null;
  familyName: string | null;
  /** Always `strong`; `verify.ts` refuses anything else. Stored because a
   *  session that predates a change to that rule should be legible. */
  acr: string | null;
  amr: string[];
}

export const session = campus.table("session", {
  /**
   * **`sha256(cookie value)`, never the cookie value itself.** The value is a
   * live credential and this table is in tic-platform's nightly `pg_dump`; a
   * hash is enough to tell two sessions apart, and a dump then hands over no
   * session anybody can use. The refresh token beside it is the one credential
   * that cannot be hashed — it has to be presentable — and it dies in twelve
   * hours, in a dump that is age-encrypted.
   */
  id: text("id").primaryKey(),
  /** A real foreign key into tic-auth's `public."user"`, like
   *  `article_version.author_id`: campus owns no roster (F5). */
  userId: integer("user_id")
    .notNull()
    .references(() => directoryUserTable.id),
  claims: jsonb("claims").$type<SessionClaims>().notNull(),
  /** `null` once a session has no grant to spend — it then simply expires. */
  refreshToken: text("refresh_token"),
  /** When the claims above were last read from tic-auth. Older than
   *  `claimsMaxAgeSeconds` is what makes the next request renew them. */
  claimsAt: timestamp("claims_at", { withTimezone: true }).notNull(),
  /** The hard cap: `now + min(campus's own maximum, refresh_expires_in)`, never
   *  longer than the SSO session behind it, and the one bound an outage cannot
   *  extend. */
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  /** Set when tic-auth could not be reached, so the next request does not try
   *  again immediately. An outage is not a revocation. */
  retryAfter: timestamp("retry_after", { withTimezone: true }),
  /** Per session, handed out by `/api/me` and required on every write.
   *  Preserved across a renewal, so open tabs keep working. */
  csrf: text("csrf").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * The `state` and the PKCE verifier, between `/api/auth/login` and the callback.
 *
 * It has to survive exactly one redirect this service does not control, and
 * nothing else: 600 s, tic-auth's own `login_state_ttl_seconds`. There is no
 * session to put it in yet, which is why it is a second table and not a column.
 */
export const loginFlow = campus.table("login_flow", {
  /** Hashed like `session.id`, and for the same reason. */
  id: text("id").primaryKey(),
  state: text("state").notNull(),
  verifier: text("verifier").notNull(),
  /** A path inside this app, sanitised on the way IN so the callback's redirect
   *  needs no second check. */
  next: text("next").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
