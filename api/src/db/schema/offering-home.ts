import {
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { campus } from "./_schema.js";
import { directoryOfferingTable, directoryUserTable } from "./directory.js";

/** One entry of F14's links list. The url is `http:` or `https:` — `checkHome`
 *  is the only door in, and it is a trust boundary: this is rendered as an
 *  `href` for every student of the offering. */
export interface HomeLink {
  title: string;
  url: string;
}

/**
 * An offering's presence in campus — and **the row's existence is the
 * activation** (F34).
 *
 * The directory knows about every offering the school teaches. Campus teaches
 * some of them: a subject that is not TIC's, an offering nobody ever filled in,
 * a course that was planned and dropped. Without this table each of those would
 * show up as an empty home with a working URL, which is worse than not existing
 * — a student who lands on one cannot tell it apart from a home their teacher
 * has not written yet. So an admin says which offerings are ours, and campus's
 * every public read joins through here.
 *
 * **It carries the activation, the final formula and — since slice 13 — the
 * home's configuration (F14)**: which sections show and in what order, the
 * links list, and the offering's own order and hiding of the library's units
 * (F15). Those are four columns and not tables because nothing points at any
 * of them: a link has no history and no dependants, and a unit override named
 * by `program_unit.id` inside an array keeps `unitId` one kind of id forever —
 * a unit added to the library later simply is not in the array yet, and one
 * deleted from it matches nothing. F37's slug fallback is still F32's answer to
 * a collision that does not exist.
 *
 * **Deactivation is `archivedAt`, not a `DELETE`** (F36), since slice 5 —
 * `offering_article` now hangs off this id, and both `result` and
 * `revision_request` hang off that. A `DELETE` behind an idempotent admin button
 * would take a teacher's work with it, and a cascade would eventually take
 * students' marks. Archiving is also why the primary key is a uuid of its own
 * even though `offeringId` is already unique, and what the F35 year lock will
 * point its rows at.
 */
export const offeringHome = campus.table(
  "offering_home",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** One home per offering. The unique index is what makes activation
     *  idempotent — `ON CONFLICT DO NOTHING` needs something to conflict on. */
    offeringId: integer("offering_id")
      .notNull()
      .references(() => directoryOfferingTable.id),
    activatedAt: timestamp("activated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Who said this offering is ours, as of the last time somebody did. Not
     *  nullable, and not an audit row: F41's log is for what changes. */
    activatedBy: integer("activated_by")
      .notNull()
      .references(() => directoryUserTable.id),
    /** Deactivated, keeping what is under it (F36). Every public read filters
     *  on this being null; the row stays so an admin can undo it. */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    /**
     * The offering's final mark, as **source text** (F40, F21) — a *second*
     * formula, over the **term** names rather than the group names, because the
     * final is computed from the term results and not from the activities
     * again. `avg("1er trimestre", "2do trimestre", "3er trimestre")`.
     *
     * It lives here rather than on a row of its own for the reason it is saved
     * in the gradebook's one body: an offering has exactly one, and the save
     * that renames a term has to be able to fix it in the same statement.
     */
    finalFormula: text("final_formula"),
    /**
     * What a redo's result does to the marks it covers (F23): `replace`, `max`
     * or `average`. Per offering and not per school, because it is a teacher's
     * call and not an admin's — which is what keeps it off F42's list of
     * constants that live in code, and puts it here beside the other
     * per-offering setting the gradebook's one `PUT` writes.
     *
     * **The default is `max`, not `replace`.** F23's own sentence says a redo's
     * result replaces the original, and it stays available as a policy — but a
     * default is what an offering gets when nobody decided, and "a redo can
     * only help" is the answer that is wrong in the student's favour. A teacher
     * who wants a redo to be able to lower a mark says so.
     *
     * `text` with the three values checked in the api, and **no `CHECK` and no
     * `pgEnum`** — the reason is the one `offering_article.value_type` gives.
     */
    redoPolicy: text("redo_policy").notNull().default("max"),
    /**
     * The home's sections, in order, as the api's names (F14) — **null is
     * "never configured"** and reads as `DEFAULT_SECTIONS`, so an offering
     * nobody touched picks up a section added later. A value domain, so no
     * `CHECK` (F18); `checkHome` is the checker.
     */
    sections: text("sections").array(),
    /** F14's links, whole list, in order. Removing one is saving without it. */
    links: jsonb("links").$type<HomeLink[]>().notNull().default([]),
    /** F15's per-offering half: library unit ids in this offering's order.
     *  Units not listed go after, in the library's order. */
    unitOrder: uuid("unit_order").array().notNull().default([]),
    /** Library units this offering hides from its students. */
    hiddenUnits: uuid("hidden_units").array().notNull().default([]),
  },
  // Total, never partial: `ON CONFLICT (offering_id)` needs this as its target,
  // and a `WHERE archived_at IS NULL` index is not one.
  (t) => [uniqueIndex("offering_home_offering_idx").on(t.offeringId)],
);
