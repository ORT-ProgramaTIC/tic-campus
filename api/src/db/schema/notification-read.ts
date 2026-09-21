import {
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { campus } from "./_schema.js";
import { directoryUserTable } from "./directory.js";

/**
 * That a person has seen one of their notifications (F30) — and the only thing
 * F30 stores.
 *
 * **There is no `notification` table**, though F37 reserved one. Every trigger
 * is a fact another table already holds with its instant: `results_published_at`,
 * `answered_at`, `published_at` on a use whose `notify` is on. So the bell
 * derives its items on read (`offerings/notifications.ts`), and a row written
 * per trigger would be a copy of those facts fanned out over a roster — one
 * that needs a job runner for a publish dated forward, and goes stale the day
 * somebody changes course.
 *
 * **Unread is "no row here with `read_at` at or after the item's instant".**
 * Comparing instants rather than asking whether a row exists is what makes a
 * re-answered revision, or a publish moved later, unread again with no code for
 * either.
 *
 * `kind` is a value domain the api checks (`KINDS`), with no `CHECK` — the
 * argument on `offering_article.value_type`. `target` is the id the kind names,
 * which is an `offering_article` or a `revision_request` depending on it, so it
 * carries no foreign key: a receipt for something since removed is a row nobody
 * reads, and `markRead` sweeps the old ones.
 */
export const notificationRead = campus.table(
  "notification_read",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: integer("user_id")
      .notNull()
      .references(() => directoryUserTable.id),
    kind: text("kind").notNull(),
    target: uuid("target").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** One receipt per item, and `markRead`'s `ON CONFLICT` target. It leads
     *  with the person, which is the only direction anything reads it — the
     *  sweep included, since it only ever clears the caller's own. */
    uniqueIndex("notification_read_user_kind_target_idx").on(
      t.userId,
      t.kind,
      t.target,
    ),
  ],
);
