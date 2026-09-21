import {
  boolean,
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { article } from "./article.js";
import { offeringGroup, offeringScale, offeringTerm } from "./gradebook.js";
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
 * **The grading fields arrived with slice 7.** F18's group, term, type, scale
 * and due date are below, and they are on the *use* rather than on the library
 * article for the same reason the rest of this row is: the same TP is graded in
 * one offering and practice-only in another. Articles group by `programUnitId`
 * — the subject's own units, straight from the library (F13) — and there is no
 * per-offering copy of them to point at instead: an offering's order and hiding
 * of units (F15) are arrays of these same ids on `offering_home` (slice 13), so
 * a fix to a unit still reaches every offering.
 *
 * **Every grading column is nullable, and that is F18's "a theory note is an
 * article without the metadata" spelled as a schema.** `valueType is not null`
 * is the single question *is this graded*, which is what `offerings/results.ts`
 * asks to find an offering's activities.
 *
 * **This row is written whole.** `useArticle`'s upsert sets every column from
 * its input, so a client that sends half a row saves half a row — `position`
 * has reset to 0 that way since slice 5. The one place that stopped being
 * survivable is un-grading an activity that already has marks, which would
 * leave live `result` rows pointing at something that is no longer an activity,
 * with no version history to recover from (unlike F11). `useArticle` refuses
 * that with `409 results_exist` rather than growing a partial-update mode.
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
    /** F20's bucket — `tps`, `clase`. Null is a graded activity the formula
     *  ignores, which is a legitimate thing to be and not a half-filled row. */
    offeringGroupId: uuid("offering_group_id").references(
      () => offeringGroup.id,
    ),
    /** F21: every activity belongs to a term, so this is null exactly when
     *  `valueType` is. */
    offeringTermId: uuid("offering_term_id").references(() => offeringTerm.id),
    /**
     * F19's three: `numeric` (1–10 with decimals), `done` (done / not done) and
     * `scale` (a named ordered scale). **Null means this use is not an
     * activity at all.**
     *
     * `text`, with the three values checked in the api and **no `CHECK`
     * constraint and no `pgEnum`** — campus's schema holds neither. This is a
     * value domain, and a value domain is one a single writer can enforce
     * alone: every other one here already is (`checkSlug`, `checkUnits`,
     * `checkMediaType`), and a constraint would be a second place to edit the
     * day F19 gains a type. That argument does **not** extend to the unique
     * indexes in `gradebook.ts`, which are about two concurrent writers and are
     * therefore the database's.
     * ponytail: api-side domain; if a second writer ever appears (F28's results
     * API), this becomes a `CHECK` and the migration is one `ALTER TABLE`.
     */
    valueType: text("value_type"),
    /** Required exactly when `valueType` is `scale`, and it is what bounds
     *  which levels a result may name. */
    offeringScaleId: uuid("offering_scale_id").references(
      () => offeringScale.id,
    ),
    /** Display only (F25): the calendar, "vence en N días" and F30's 48 h
     *  notification. Without submissions campus cannot know when anything was
     *  turned in, so a late flag would be a guess typed in by hand. */
    dueAt: timestamp("due_at", { withTimezone: true }),
    /**
     * F24, and **not** `publishedAt`. That one decides when the *article*
     * appears; this one decides when its *marks* do. A teacher posts the TP
     * statement on Monday and marks it on Friday, so one flag cannot serve
     * both, and this replaces the old `Visible` column that was per mark row.
     *
     * A timestamp rather than a boolean, like every other one here: F36 keeps
     * *when*, and F30's "a result was published" needs an instant to fire on.
     */
    resultsPublishedAt: timestamp("results_published_at", {
      withTimezone: true,
    }),
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
