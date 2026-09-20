import {
  boolean,
  index,
  integer,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { article } from "./article.js";
import { offeringHome } from "./offering-home.js";
import { programUnit } from "./program-unit.js";
import { campus } from "./_schema.js";

/**
 * An offering's **use** of a library article (F8).
 *
 * The article itself belongs to a subject and outlives every offering that
 * shows it; this row is one offering's decision to show it, and carries the
 * facts that differ between offerings: where it sits, when it appears, and who
 * may read it. Next year's offering inserts its own row against the same
 * `articleId`, which is what makes a fix reach every year instead of the one
 * whose copy somebody remembered.
 *
 * **The title is not here.** It lives on `article` (F37), because an offering
 * renaming a library article would be a second, invisible copy of it.
 *
 * **No `offeringUnitId`, and no grading fields.** F18's group, term and scale
 * references wait for the tables to exist. Articles group by
 * `programUnitId` — the subject's own units, straight from the library (F13) —
 * rather than through a per-offering copy of them: F15 also lets an offering
 * reorder and hide units for itself, and that control belongs to F14's home
 * configuration screen, with the `offering_unit` table it needs. Until then
 * every offering shows the library's units in the library's order, and a fix to
 * a unit reaches all of them.
 */
export const offeringArticle = campus.table(
  "offering_article",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    offeringHomeId: uuid("offering_home_id")
      .notNull()
      .references(() => offeringHome.id),
    articleId: uuid("article_id")
      .notNull()
      .references(() => article.id),
    /** Null is "no unit yet", which is where an article lands before a teacher
     *  files it — not an error, and the home renders them after the units. */
    programUnitId: uuid("program_unit_id").references(() => programUnit.id),
    /** No unique constraint, for the reason `program_unit.position` gives: two
     *  articles claiming position 3 sort next to each other, which is what a
     *  teacher who dragged one there meant. */
    position: integer("position").notNull(),
    /** Null, or in the future, means staff-only. An article is written before
     *  the class that needs it, and this is what keeps it out of sight until
     *  then — the library article can be published while this use is not. */
    publishedAt: timestamp("published_at", { withTimezone: true }),
    /**
     * F4's second value: `true` is "enrolled students and staff only", which is
     * what an exam statement or a solution needs.
     *
     * A boolean rather than a `text` status, because F4 decides exactly two
     * values and campus's own schema holds no `pgEnum` anywhere — and an
     * unconstrained `text` column is worse than a boolean on the one field that
     * decides who may read a solution.
     * ponytail: two values; a third makes this a text column with a check
     * constraint, and the migration is one `USING` expression.
     */
    restricted: boolean("restricted").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    /** An offering uses an article once. Twice is a teacher clicking twice. */
    uniqueIndex("offering_article_home_article_idx").on(
      t.offeringHomeId,
      t.articleId,
    ),
    index("offering_article_home_position_idx").on(
      t.offeringHomeId,
      t.position,
    ),
  ],
);
