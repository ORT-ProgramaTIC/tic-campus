import {
  index,
  integer,
  numeric,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { campus } from "./_schema.js";
import { directoryUserTable } from "./directory.js";
import { offeringScaleLevel } from "./gradebook.js";
import { offeringArticle } from "./offering-article.js";

/**
 * What a student did on one activity, and what they got for it (F38).
 *
 * **It carries no course, on purpose.** A result records that this person did
 * this activity and got this; a student who changes course in April does not
 * change that fact. The absence is the feature — there is no composite key to
 * maintain and no history to rewrite when a roster does. The gradebook joins
 * the roster live, the way every other read does.
 *
 * **Enrolment is checked when a result is created, and never again.** F38 says
 * so in two sentences that are easy to collapse into one gate and get wrong: a
 * blanket "the student must be enrolled" would refuse the teacher fixing a mark
 * for somebody who transferred out in April, and would drop them out of the
 * grid entirely, mark and all. So the writable set is *enrolled, plus whoever
 * already carries a row here*, and the grid lists a departed student flagged
 * rather than hidden.
 *
 * **One numeric `value`, and it is `NOT NULL`.** Done is 1, not done is 0, a
 * scale level is the number that level maps to, and that single aggregatable
 * column is what keeps F20's evaluator from branching per type. There is no
 * blank result: F20's "blank" already means *a missing row*, so clearing a cell
 * deletes this one, and a nullable value would be a second spelling of the same
 * thing for the evaluator to branch on. `scaleLevel` keeps what the teacher
 * actually picked, for display.
 *
 * **`recordedBy` answers who set this value, and when — per row.** The table
 * is append-only (F41, slice 12): changing a mark inserts a new row, and the
 * current mark is the pair's newest by `recorded_at`, then `id`. The row it
 * supersedes stays, with the marker and the moment it was set, so "who put the
 * 4" is still answerable after somebody changes it to a 7 — which is exactly
 * when F29 asks it. Only a clear deletes, and it deletes the pair's whole
 * history: a cleared mark is one that should never have existed.
 */
export const result = campus.table(
  "result",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studentId: integer("student_id")
      .notNull()
      .references(() => directoryUserTable.id),
    offeringArticleId: uuid("offering_article_id")
      .notNull()
      .references(() => offeringArticle.id),
    /** See the note on `offering_scale_level.value` for why `mode: "number"`. */
    value: numeric("value", {
      precision: 4,
      scale: 2,
      mode: "number",
    }).notNull(),
    /** Only for a `scale` activity, and only for display — `value` already
     *  carries what the formula will read. */
    scaleLevelId: uuid("scale_level_id").references(
      () => offeringScaleLevel.id,
    ),
    /** The teacher's comment on this mark, which the student reads with it
     *  (F24) and which F29's revision request argues with. */
    feedback: text("feedback"),
    recordedBy: integer("recorded_by")
      .notNull()
      .references(() => directoryUserTable.id),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    /**
     * **Not unique** since slice 12: a pair has one row per time it was marked.
     * The columns go the gradebook's way round — every query here starts from
     * a home's activities and collects their rows, never from a student — and
     * the trailing `recorded_at DESC` is what makes "the pair's newest row" a
     * range scan instead of a sort.
     */
    index("result_article_student_idx").on(
      t.offeringArticleId,
      t.studentId,
      t.recordedAt.desc(),
    ),
  ],
);
