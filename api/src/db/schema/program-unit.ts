import { index, integer, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { campus } from "./_schema.js";
import { directorySubjectTable } from "./directory.js";

/**
 * A unit of the subject's program: a title and Markdown contents, in order
 * (F15). **It lives in the library**, beside the articles and for the same
 * reason — an offering starts from it every year and may reorder or hide units
 * for itself, so a fix to the program reaches every year's offerings rather
 * than the one it was typed into.
 *
 * The same units group the offering's articles (F13), which is why they are
 * typed once here instead of once as a program and again as a table of
 * contents.
 *
 * `position` is a plain integer with no unique constraint, and that is
 * deliberate: reordering a list under `UNIQUE (subject_id, position)` needs
 * either a deferred constraint or a shuffle through a free range, and it buys
 * nothing — two units claiming position 3 sort next to each other, which is
 * what a teacher who dragged one there meant.
 */
export const programUnit = campus.table(
  "program_unit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectId: integer("subject_id")
      .notNull()
      .references(() => directorySubjectTable.id),
    title: text("title").notNull(),
    contents: text("contents").notNull(),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("program_unit_subject_position_idx").on(t.subjectId, t.position),
  ],
);
