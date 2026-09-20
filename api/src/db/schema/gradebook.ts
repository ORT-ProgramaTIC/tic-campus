import {
  index,
  integer,
  numeric,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { campus } from "./_schema.js";
import { offeringHome } from "./offering-home.js";

/**
 * **The rows an offering names** (F39): the buckets its activities fall into,
 * the terms they belong to, and the scales they are marked on. Four tables in
 * one file because they are one screen and one save — `offerings/gradebook.ts`
 * reads and writes them together, and a scale is meaningless without its
 * levels.
 *
 * **They live here and not in `offering-article.ts`**, which imports them:
 * putting them beside the table that references them would be a circular
 * import, and the levels reach `result` from here too.
 *
 * The first three are the same five columns three times, spelled out rather
 * than shared through one object. A drizzle column builder carries its own
 * config and is consumed when a table is built, so one `name: text("name")`
 * handed to three `campus.table()` calls is one object three tables disagree
 * about — the kind of saving that costs a day.
 *
 * Each row is a **name and a position**, and an activity references it **by
 * id** — so renaming a group moves nothing. F39 also says renaming touches
 * neither the activities *nor the formula*, and the second half is **not true
 * yet**: F20's formula spells `avg(tps)`, by name, and there is no immutable
 * key column here to spell instead. The obligation is recorded under F39 for
 * F20's slice to settle, either with a `key` column backfilled from these
 * names or with a rename that rewrites the offering's formula text.
 *
 * **`offering_term` carries neither dates nor a formula.** F21 lets a teacher
 * date a term and F40 puts the formula source on it; neither has a reader yet,
 * and a column arrives with the feature that reads it — the rule
 * `offering_article` already follows for `offeringUnitId`.
 *
 * **`name` is unique per offering, and that is the database's job** rather than
 * the api's: two concurrent saves cannot both check-then-insert. It is not the
 * same question as `value_type`, which is a value domain one writer can check
 * alone — see the note there. The cost is that swapping two names is two
 * UPDATEs and one of them raises `23505`, which `writeSetup` turns into a `409`
 * telling the teacher to save it in two steps.
 *
 * `position` carries no unique constraint, for the reason
 * `program_unit.position` gives: two rows claiming position 3 sort next to each
 * other, which is what a teacher who dragged one there meant. It is the array
 * index of the whole-list save and is never sent by a client.
 */

/** A teacher-named bucket — `tps`, `clase`, `evals` (F18, F20). The formula
 *  aggregates over these; an activity in none of them is one it ignores. */
export const offeringGroup = campus.table(
  "offering_group",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    offeringHomeId: uuid("offering_home_id")
      .notNull()
      .references(() => offeringHome.id),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("offering_group_home_name_idx").on(t.offeringHomeId, t.name),
    index("offering_group_home_position_idx").on(t.offeringHomeId, t.position),
  ],
);

/**
 * A term of this offering, named by its teacher (F21) — **per offering and not
 * per school year**, which is what lets a semester OPTIONAL offering or
 * Proyecto have terms that are not trimestres. tic-auth's own
 * `offering.term_id` is a different thing, and campus branches on neither.
 */
export const offeringTerm = campus.table(
  "offering_term",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    offeringHomeId: uuid("offering_home_id")
      .notNull()
      .references(() => offeringHome.id),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("offering_term_home_name_idx").on(t.offeringHomeId, t.name),
    index("offering_term_home_position_idx").on(t.offeringHomeId, t.position),
  ],
);

/** A named ordered scale (F19), seeded from a preset or typed by hand. The
 *  presets are constants in `offerings/gradebook.ts` and not rows of their own
 *  (F42) — what lands here is the copy this offering owns and may rename. */
export const offeringScale = campus.table(
  "offering_scale",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    offeringHomeId: uuid("offering_home_id")
      .notNull()
      .references(() => offeringHome.id),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("offering_scale_home_name_idx").on(t.offeringHomeId, t.name),
    index("offering_scale_home_position_idx").on(t.offeringHomeId, t.position),
  ],
);

/**
 * One step of a scale: what the teacher picks, and the number it means.
 *
 * **`value` is what makes F19's third type aggregatable.** A result records the
 * level for display and the level's number in its own column, so the evaluator
 * never branches per type (F38). The consequence is that the number is copied
 * at write time — so `writeSetup` rewrites the results recorded against a level
 * whose number changed, in the same transaction. Without that, moving `MB` from
 * 8 to 9 would change the display and not the mark.
 *
 * **Levels are add-and-rename-only.** The whole-list save never deletes (F15's
 * rule), so a level a result points at cannot vanish under it. A scale nothing
 * uses can be deleted whole and retyped; once an activity uses it, a spare
 * level stays in the dropdown.
 * ponytail: no per-level delete; add one the day a teacher complains, with the
 * same `409` the other three deletes use.
 */
export const offeringScaleLevel = campus.table(
  "offering_scale_level",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    offeringScaleId: uuid("offering_scale_id")
      .notNull()
      .references(() => offeringScale.id),
    /** `MB`, `Aprobado` — as the teacher spells it, and what a student reads. */
    name: text("name").notNull(),
    /**
     * `mode: "number"` and not the default: node-postgres hands `numeric` back
     * as a **string**, always, and without this every mark would reach the
     * client quoted. It changes no SQL and no migration, so it is a code-only
     * edit later. The mapping belongs to the *column*, so F20's future
     * `avg(...)` comes back a string regardless of what is written here.
     *
     * Not `doublePrecision`: a stored `7.3` that reads back `7.299999999` is
     * not a thing to explain to a teacher.
     */
    value: numeric("value", {
      precision: 4,
      scale: 2,
      mode: "number",
    }).notNull(),
    position: integer("position").notNull(),
  },
  (t) => [
    uniqueIndex("offering_scale_level_scale_name_idx").on(
      t.offeringScaleId,
      t.name,
    ),
    index("offering_scale_level_scale_position_idx").on(
      t.offeringScaleId,
      t.position,
    ),
  ],
);
