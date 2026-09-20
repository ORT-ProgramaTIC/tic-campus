import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { offeringHome } from "../db/schema/offering-home.js";

/**
 * An admin says which of the directory's offerings are campus's (F34).
 *
 * Both operations are **idempotent**, and that is the whole design: an admin
 * who clicks twice, or who activates something a colleague already did, has not
 * made a mistake, and a `409` would be a state a client has to interpret before
 * it can decide the person's action succeeded. Activating what is already
 * activated changes nothing and keeps the original `activated_by`, which is the
 * honest answer to who decided this.
 */

/** `false` when there was already a home — the caller's own action was a no-op. */
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
  return inserted.length > 0;
}

/**
 * A `DELETE`, because there is nothing under a home to orphan yet. When F14
 * hangs sections and links here that stops being true, and this becomes
 * `archived_at` (F36) — see the note on the table.
 */
export async function deactivate(db: Db, offeringId: number): Promise<boolean> {
  const removed = await db
    .delete(offeringHome)
    .where(eq(offeringHome.offeringId, offeringId))
    .returning({ id: offeringHome.id });
  return removed.length > 0;
}
