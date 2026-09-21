import { sql } from "drizzle-orm";
import {
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { campus } from "./_schema.js";
import { directoryUserTable } from "./directory.js";
import { offeringArticle } from "./offering-article.js";

/**
 * A student asks for a mark to be looked at again, and a teacher answers (F29)
 * — the old `RevisionRequest` model, which ran on an activity id string with no
 * foreign key behind it.
 *
 * **It names the mark by `(offering_article_id, student_id)`, not by
 * `result.id`.** F29's own sentence says it references the result row, and this
 * is a deliberate reversal recorded there. A request is always about a mark that
 * exists — it is never filed against an unmarked activity — so either key is
 * populatable, and this one wins on three counts. The body is keyed this way
 * regardless, because a student may only ever read their *own* result and so
 * cannot name a partner's row id. The teacher's inbox reads home → activities →
 * requests, one join shorter than going through `result`, and the same direction
 * `result_article_student_idx` is ordered for. And clearing a cell *deletes* the
 * result row (F38), so a `result_id` here would be a foreign key onto something
 * a teacher can remove: no FK in this schema sets `onDelete`, so an emptied cell
 * inside a bulk save would be a 500, and a clear-then-retype would silently mint
 * a new id and orphan the conversation.
 *
 * **`answered_at IS NULL` is the whole of "open".** No `resolved` boolean: it
 * would be a second thing to keep true, the argument `redo_covers` makes against
 * an `is_redo` flag. The partial unique index below is therefore F29's "one open
 * request per result" said once, in the only place that can enforce it — F18
 * puts a value domain in the api and uniqueness across concurrent writers in
 * Postgres, and two tabs are two writers.
 *
 * **`requested_by` is not `student_id`.** Filing is a group flow: a student
 * files for themselves *and* the partners they worked with, as the old dialog
 * did. So the person who wrote the words is not always the person whose mark it
 * is, and both reads carry both — without that the inbox renders one student's
 * text under another's name, to the teacher who grades them.
 */
export const revisionRequest = campus.table(
  "revision_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Half the natural key: *which mark*. */
    offeringArticleId: uuid("offering_article_id")
      .notNull()
      .references(() => offeringArticle.id),
    /** The other half: *whose*. */
    studentId: integer("student_id")
      .notNull()
      .references(() => directoryUserTable.id),
    /** Who filed it, which is the student themselves or a partner of theirs. */
    requestedBy: integer("requested_by")
      .notNull()
      .references(() => directoryUserTable.id),
    reason: text("reason").notNull(),
    /** Extra work the student offers in exchange, kept from the old model.
     *  Optional there and optional here. */
    bonusTasks: text("bonus_tasks"),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** The teacher's comment. F29's answer is a comment and nothing else — a
     *  mark change goes through `saveResults`, which is the one write path for
     *  a result (F38), so there is no second place that branches on
     *  `value_type`. */
    answer: text("answer"),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    answeredBy: integer("answered_by").references(() => directoryUserTable.id),
  },
  (t) => [
    /**
     * F29's "one open request per result". **Partial, unlike every other unique
     * index here** — `offering_home`'s says "total, never partial" because it is
     * an `ON CONFLICT (offering_id)` target, and a partial index is a perfectly
     * good target too as long as the predicate is supplied with it
     * (`targetWhere`). `fileRequests` does exactly that, which is what makes the
     * insert race-free without a pre-`SELECT`.
     */
    uniqueIndex("revision_request_open_idx")
      .on(t.offeringArticleId, t.studentId)
      .where(sql`answered_at is null`),
    /** The student's own read goes the other way round, from a person to their
     *  requests, which the unique index above cannot serve as a prefix. */
    index("revision_request_student_idx").on(t.studentId),
  ],
);
