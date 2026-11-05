import {
  boolean,
  index,
  integer,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { campus } from "./_schema.js";
import { directoryUserTable } from "./directory.js";
import { offeringHome } from "./offering-home.js";

/**
 * The Proyecto grade (F46): one per student per rotation, typed by a teacher,
 * shown to the student only once `visible`. "Project" is the subject Proyecto:
 * the row is keyed by student and offering, never by a tic-registry project.
 *
 * **Its own table, not `official_grade`** — that one hangs off a term and its
 * value is a 1–10 number, and PIA and DICIEMBRE are neither.
 *
 * **Append-only** (F41), `official_grade`'s shape: a change inserts a row, the
 * current grade is the pair's newest by `recorded_at` then `id`, and flipping
 * `visible` alone is a change too. Clearing deletes the pair's whole history.
 */
export const projectGrade = campus.table(
  "project_grade",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    offeringHomeId: uuid("offering_home_id")
      .notNull()
      .references(() => offeringHome.id),
    studentId: integer("student_id")
      .notNull()
      .references(() => directoryUserTable.id),
    /** `10`…`6`, `pia` or `diciembre`, checked by `checkProjectGrades`. */
    value: text("value").notNull(),
    visible: boolean("visible").notNull().default(false),
    recordedBy: integer("recorded_by")
      .notNull()
      .references(() => directoryUserTable.id),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("project_grade_home_student_idx").on(
      t.offeringHomeId,
      t.studentId,
      t.recordedAt.desc(),
    ),
  ],
);
