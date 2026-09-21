import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { offeringHome } from "../db/schema/offering-home.js";

/**
 * An admin says which of the directory's offerings are campus's (F34).
 *
 * Both operations are **idempotent**, and that is the whole design: an admin
 * who clicks twice, or who activates something a colleague already did, has not
 * made a mistake, and a `409` would be a state a client has to interpret before
 * it can decide the person's action succeeded.
 *
 * **Deactivation archives** (F36). It was a `DELETE` while a home held nothing
 * but its own existence; since slice 5 it has `offering_article` rows under it,
 * which are a teacher's work. Re-activating clears the flag and keeps them.
 */

/** `false` when the offering was already active — the caller's own action was a
 *  no-op. Re-activating an archived home counts as the caller's doing. */
export async function activate(
  db: Db,
  offeringId: number,
  activatedBy: number,
): Promise<boolean> {
  const inserted = await db
    .insert(offeringHome)
    .values({ offeringId, activatedBy })
    .onConflictDoNothing({ target: offeringHome.offeringId })
    .returning({ id: offeringHome.id });
  if (inserted.length > 0) return true;

  // A second statement rather than `onConflictDoUpdate`, which always returns a
  // row and would make the answer above permanently `true` — and that boolean
  // is what the route ships as `created`. The `isNotNull` is what keeps an
  // already-active home a no-op instead of a fresh activation.
  const revived = await db
    .update(offeringHome)
    .set({ archivedAt: null, activatedBy, activatedAt: sql`now()` })
    .where(
      and(
        eq(offeringHome.offeringId, offeringId),
        isNotNull(offeringHome.archivedAt),
      ),
    )
    .returning({ id: offeringHome.id });
  return revived.length > 0;
}

/**
 * `false` when it was not active to begin with.
 *
 * The `isNull` in the `WHERE` is load-bearing: without it a second call
 * re-stamps `archivedAt`, which throws away *when* the offering was archived —
 * the one fact a flag has over a `DELETE` — and answers `true` for a no-op.
 */
export async function deactivate(db: Db, offeringId: number): Promise<boolean> {
  const archived = await db
    .update(offeringHome)
    .set({ archivedAt: sql`now()` })
    .where(
      and(
        eq(offeringHome.offeringId, offeringId),
        isNull(offeringHome.archivedAt),
      ),
    )
    .returning({ id: offeringHome.id });
  return archived.length > 0;
}

/**
 * An admin reopens one offering's marks past its year's lock, for a late fix
 * (F35) — or closes them again. Idempotent like activation, and for the same
 * reason. `null` when the offering is not active: there is nothing to unlock,
 * and the route says so as a 404.
 *
 * Re-unlocking keeps the first `unlockedAt`, which is when the exception
 * started — the `isNull` in the `WHERE` is `deactivate`'s, for `deactivate`'s
 * reason.
 */
export async function setUnlocked(
  db: Db,
  offeringId: number,
  unlocked: boolean,
): Promise<boolean | null> {
  const active = and(
    eq(offeringHome.offeringId, offeringId),
    isNull(offeringHome.archivedAt),
  );
  const changed = await db
    .update(offeringHome)
    .set({ unlockedAt: unlocked ? sql`now()` : null })
    .where(
      and(
        active,
        unlocked
          ? isNull(offeringHome.unlockedAt)
          : isNotNull(offeringHome.unlockedAt),
      ),
    )
    .returning({ id: offeringHome.id });
  if (changed.length > 0) return true;
  const [home] = await db
    .select({ id: offeringHome.id })
    .from(offeringHome)
    .where(active)
    .limit(1);
  return home ? false : null;
}
