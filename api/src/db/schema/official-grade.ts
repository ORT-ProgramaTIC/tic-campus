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
import { offeringTerm } from "./gradebook.js";

/**
 * The number a teacher **types** on the boletín, beside the one campus computes
 * (F22) — value, observation and suggestion, per student per term. It replaces
 * the `Notas Fijas` sheet, whose single cell held all three as
 * `Nota - Observación - Sugerencia` and was parsed by splitting on a dash.
 *
 * **It hangs off the term and not the offering**, which is what makes it the
 * *other* number: the computed one is a formula over activities, this one is a
 * person's judgement over the same period, and the two are compared on the same
 * row of the same screen.
 *
 * **An official grade is visible the moment it exists**, and there is no third
 * publish date. F24's `results_published_at` is a column of `offering_article`
 * and cannot answer for a term, and the honest reading of the alternative is
 * that a teacher types the boletín grade *when the boletín is due* — a draft
 * state here would be a flag nobody flips, standing between a student and a
 * grade that is already decided. `resultsVisible` stays the rule for *results*
 * and deliberately does not grow a third meaning.
 * ponytail: no draft state; add a `published_at` here the day a teacher asks
 * for one, and it is a nullable column and one clause in `myOfficialGrades`.
 *
 * **`value` is `NOT NULL` and clearing deletes the row**, the rule `result`
 * already follows (F38): a blank is an absent row, and a nullable value would
 * be a second spelling of the same thing. The consequence is that an
 * observation cannot outlive its grade, which is right — the text explains a
 * number, and on its own it is a comment with no home.
 *
 * **`recordedBy` answers who set this grade, and when — per row.** The table
 * is append-only (F41, slice 17), the way `result` has been since slice 12: a
 * change inserts a new row, and the current grade is the pair's newest by
 * `recorded_at`, then `id`. The row is the whole record, not only the number,
 * so changing the observation alone is a new row too. Only a clear deletes,
 * and it deletes the pair's whole history, for `result`'s reason.
 */
export const officialGrade = campus.table(
  "official_grade",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studentId: integer("student_id")
      .notNull()
      .references(() => directoryUserTable.id),
    offeringTermId: uuid("offering_term_id")
      .notNull()
      .references(() => offeringTerm.id),
    /** 1 to 10 with two decimals, checked by `checkMark`. `mode: "number"` for
     *  the reason every other mark column gives: node-postgres hands `numeric`
     *  back as a **string** without it. */
    value: numeric("value", {
      precision: 4,
      scale: 2,
      mode: "number",
    }).notNull(),
    /** What the teacher says about the term, which the student reads. */
    observation: text("observation"),
    /** What to do about it next term. The old sheet's third field. */
    suggestion: text("suggestion"),
    recordedBy: integer("recorded_by")
      .notNull()
      .references(() => directoryUserTable.id),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    /** **Not unique** since slice 17: a pair has one row per time it was
     *  graded. Term first, for the reason `result_article_student_idx` gives —
     *  every read here starts from an offering's terms — and the trailing
     *  `recorded_at DESC` makes "the pair's newest row" a range scan. */
    index("official_grade_term_student_idx").on(
      t.offeringTermId,
      t.studentId,
      t.recordedAt.desc(),
    ),
  ],
);
