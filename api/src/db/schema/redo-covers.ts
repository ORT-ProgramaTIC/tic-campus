import { index, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { offeringArticle } from "./offering-article.js";
import { campus } from "./_schema.js";

/**
 * Which activities a redo replaces (F23) — the `Recuperatorio` sheet, which was
 * one redo covering several TPs.
 *
 * **A redo is an activity like any other**, an `offering_article` with a
 * `value_type`, and what makes it a redo is rows in here. There is no `is_redo`
 * flag: the flag would be a second thing to keep true, and "covers nothing" and
 * "is not a redo" are the same fact. The cheap reading also means a redo carries
 * a term, a group, a due date and a publish date without any of that being
 * special-cased — it is graded, published and marked through the same routes.
 *
 * **Both columns point at the same table**, which is why the pair is unique
 * rather than either column alone: one redo covers many TPs, and a TP may be
 * covered by more than one redo (a second recuperatorio in December). What the
 * api refuses is a redo covering *itself* or covering another redo — with no
 * chains there is nothing to resolve recursively, so `resolveRedos` is one pass
 * in `position` order and cannot loop.
 * ponytail: no chains; the day somebody wants a redo of a redo this needs a
 * topological pass and a cycle check, and neither is worth writing for a case
 * nobody has asked for.
 *
 * **Coverage is per offering because the use is.** The same TP is redone in one
 * offering and not in another, and next year's offering makes its own decision
 * against its own rows.
 */
export const redoCovers = campus.table(
  "redo_covers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The activity that replaces. */
    redoId: uuid("redo_id")
      .notNull()
      .references(() => offeringArticle.id),
    /** The activity being replaced. */
    coveredId: uuid("covered_id")
      .notNull()
      .references(() => offeringArticle.id),
  },
  (t) => [
    /** Saying it twice is a teacher clicking twice. */
    uniqueIndex("redo_covers_redo_covered_idx").on(t.redoId, t.coveredId),
    /** `removeUse` deletes by either side, and the grid's read collects by the
     *  covered one as often as by the redo. */
    index("redo_covers_covered_idx").on(t.coveredId),
  ],
);
