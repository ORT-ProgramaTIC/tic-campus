import { createHash, randomBytes } from "node:crypto";
import { eq, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  loginFlow,
  session,
  type SessionClaims,
} from "../db/schema/session.js";

/**
 * Reading and writing the two tables in `db/schema/session.ts`.
 *
 * MEV's `api/src/auth/session-store.ts` over Redis, with the same six
 * operations and the same properties — including the one that matters most,
 * `takeLogin` being single use: a login state that survived its callback would
 * let a code be presented twice, and the second presentation is what tic-auth
 * answers by revoking a family. Redis spells it `GETDEL`; SQL spells it
 * `DELETE … RETURNING`, which is the same statement doing the same thing.
 *
 * **Times are epoch milliseconds in memory and `timestamptz` in the database.**
 * The conversion lives here and nowhere else, so `refresh.ts` compares numbers
 * against `Date.now()` exactly as MEV's does.
 */

export interface SessionRecord {
  userId: number;
  claims: SessionClaims;
  refreshToken: string | null;
  /** Epoch ms. */
  claimsAt: number;
  /** Epoch ms. */
  expiresAt: number;
  csrf: string;
  /** Epoch ms. */
  retryAfter?: number;
}

export interface LoginRecord {
  state: string;
  verifier: string;
  next: string;
}

export type SessionStore = ReturnType<typeof createSessionStore>;

/** 32 bytes, like every opaque value tic-auth mints. Base64url so it survives a
 *  cookie with no escaping. This is what the browser gets. */
export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * What the database gets: the cookie value's digest.
 *
 * The two are separated on purpose. The stored id identifies the session; the
 * cookie value authenticates it. Hashing means a read of these tables — a
 * console, a restored dump — yields something nobody can present. Unsalted and
 * uniterated is right here and would not be for a password: the input is 32
 * random bytes, so there is no dictionary to run.
 */
export function idFor(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function createSessionStore(db: Db) {
  return {
    async create(id: string, record: SessionRecord): Promise<void> {
      await db.insert(session).values(toRow(id, record));
    },

    async write(id: string, record: SessionRecord): Promise<void> {
      const { id: _id, ...columns } = toRow(id, record);
      await db.update(session).set(columns).where(eq(session.id, id));
    },

    async read(id: string): Promise<SessionRecord | null> {
      const [row] = await db
        .select()
        .from(session)
        .where(eq(session.id, id))
        .limit(1);
      if (!row) return null;
      return {
        userId: row.userId,
        claims: row.claims,
        refreshToken: row.refreshToken,
        claimsAt: row.claimsAt.getTime(),
        expiresAt: row.expiresAt.getTime(),
        csrf: row.csrf,
        ...(row.retryAfter ? { retryAfter: row.retryAfter.getTime() } : {}),
      };
    },

    async destroy(id: string): Promise<void> {
      await db.delete(session).where(eq(session.id, id));
    },

    async startLogin(id: string, record: LoginRecord): Promise<void> {
      await db.insert(loginFlow).values({
        id,
        state: record.state,
        verifier: record.verifier,
        next: record.next,
        expiresAt: new Date(Date.now() + LOGIN_TTL_MS),
      });
    },

    /**
     * Single use, and the delete is what makes it so. Also the age check: a flow
     * older than 600 s is gone whether or not anybody swept it, because the
     * `WHERE` is what answers rather than a column somebody reads afterwards.
     */
    async takeLogin(id: string): Promise<LoginRecord | null> {
      const [row] = await db
        .delete(loginFlow)
        .where(eq(loginFlow.id, id))
        .returning();
      if (!row) return null;
      if (row.expiresAt.getTime() <= Date.now()) return null;
      return { state: row.state, verifier: row.verifier, next: row.next };
    },

    /**
     * Expired rows, swept on the way through a login.
     *
     * Once per login rather than on a timer or a cron there is nowhere to put:
     * logins are rare, both tables are small, and a sweep that runs while
     * somebody is signing in is a sweep that cannot be forgotten. Expiry is
     * already enforced by every read, so this is housekeeping and never a
     * security property.
     */
    async sweepExpired(): Promise<void> {
      const now = new Date();
      await db.delete(loginFlow).where(lt(loginFlow.expiresAt, now));
      await db.delete(session).where(lt(session.expiresAt, now));
    },
  };
}

/** 600 s, tic-auth's own `login_state_ttl_seconds`. */
export const LOGIN_TTL_MS = 600_000;

function toRow(id: string, record: SessionRecord) {
  return {
    id,
    userId: record.userId,
    claims: record.claims,
    refreshToken: record.refreshToken,
    claimsAt: new Date(record.claimsAt),
    expiresAt: new Date(record.expiresAt),
    retryAfter: record.retryAfter ? new Date(record.retryAfter) : null,
    csrf: record.csrf,
  };
}
