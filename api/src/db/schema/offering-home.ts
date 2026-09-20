import { integer, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { campus } from "./_schema.js";
import { directoryOfferingTable, directoryUserTable } from "./directory.js";

/**
 * An offering's presence in campus — and **the row's existence is the
 * activation** (F34).
 *
 * The directory knows about every offering the school teaches. Campus teaches
 * some of them: a subject that is not TIC's, an offering nobody ever filled in,
 * a course that was planned and dropped. Without this table each of those would
 * show up as an empty home with a working URL, which is worse than not existing
 * — a student who lands on one cannot tell it apart from a home their teacher
 * has not written yet. So an admin says which offerings are ours, and campus's
 * every public read joins through here.
 *
 * **It carries the activation and nothing else yet.** F37 describes it as
 * "activation, section list and order, links list, slug fallback": the sections
 * and the links are F14's and have no reader, and the slug fallback is F32's
 * answer to a collision that does not exist. Each arrives with the feature that
 * reads it, in its own migration.
 *
 * Deactivation is a `DELETE` rather than a flag: there is nothing under a home
 * to orphan yet. When F14 hangs sections and links here, that stops being true
 * and `archivedAt` (F36) is what it becomes — which is why the F35 year lock
 * will want rows pointing at this id, and why the primary key is a uuid of its
 * own even though `offeringId` is already unique.
 */
export const offeringHome = campus.table(
  "offering_home",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** One home per offering. The unique index is what makes activation
     *  idempotent — `ON CONFLICT DO NOTHING` needs something to conflict on. */
    offeringId: integer("offering_id")
      .notNull()
      .references(() => directoryOfferingTable.id),
    activatedAt: timestamp("activated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Who said this offering is ours. Not nullable, and not an audit row: F41's
     *  log is for what changes, and this changes once. */
    activatedBy: integer("activated_by")
      .notNull()
      .references(() => directoryUserTable.id),
  },
  (t) => [uniqueIndex("offering_home_offering_idx").on(t.offeringId)],
);
