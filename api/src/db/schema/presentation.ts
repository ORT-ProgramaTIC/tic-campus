import { sql } from "drizzle-orm";
import {
  date,
  index,
  integer,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { campus } from "./_schema.js";
import { offeringHome } from "./offering-home.js";

/**
 * A block on a date given over to presentations (F45) — 2025's `Fechas` sheet,
 * one row per date and block, now holding its own slots instead of a bare
 * `N Grupos`.
 *
 * **The id comes from the client.** The schedule is saved whole, in one `PUT`,
 * and a team can be pinned to a block created in that same body — so the body
 * has to be able to name a block before Postgres has seen it. A uuid the
 * client mints with `crypto.randomUUID()` is that name, and the upsert keys on
 * it. There is no `defaultRandom()` for the same reason: a row inserted without
 * one is a bug in the writer, not a row to invent an id for.
 *
 * `block` is the block number, 1–6, and `date` plus `block` must be one of the
 * offering's weekly modules (`directory.offering_time_slot`) — checked in the
 * api, because the rule spans tic-registry's tables and a constraint here
 * cannot see them.
 *
 * **Slots are a count and an array of overrides, not rows.** `slot_starts`
 * holds one `HH:MM` per slot, or `null` for "where the even split puts it", and
 * its length is `slot_count`. Rows per slot would leave stale times behind
 * every time a teacher changed the count; this way changing it re-splits, and
 * the only thing that can dangle is a pin past the new count, which the save
 * refuses. A pin names a slot by its 1-based number for the same reason.
 */
export const presentationBlock = campus.table(
  "presentation_block",
  {
    id: uuid("id").primaryKey(),
    offeringHomeId: uuid("offering_home_id")
      .notNull()
      .references(() => offeringHome.id),
    /** 2025's `Instancia`: the first round, the second chance, and so on. */
    round: integer("round").notNull(),
    /** A calendar day in Buenos Aires, not an instant — `mode: "string"` keeps
     *  it `YYYY-MM-DD` end to end, with no `Date` to shift it across midnight. */
    date: date("date", { mode: "string" }).notNull(),
    block: integer("block").notNull(),
    slotCount: integer("slot_count").notNull().default(3),
    slotStarts: text("slot_starts").array().$type<(string | null)[]>(),
    /** Slot numbers struck on this date — an event took them. Numbers, not
     *  times, so the slots after a struck one keep their number and a pin on
     *  slot 3 still means slot 3. Past `slot_count` is refused on save. */
    skippedSlots: integer("skipped_slots").array().notNull().default([]),
  },
  (t) => [
    /** A block on a date is given to one round, once. Also the order the home's
     *  read wants, so it doubles as that index. */
    uniqueIndex("presentation_block_home_date_block_idx").on(
      t.offeringHomeId,
      t.date,
      t.block,
    ),
  ],
);

/**
 * One team in one round's queue (F45) — 2025's `Presentacion` sheet.
 *
 * **`project_id` is not a foreign key**, and that is a gap rather than a
 * choice: the team is a tic-registry project, and `public.project` is not in
 * `REFERENCEABLE_TABLES`, so campus may not reference it. `saveSchedule`
 * checks every id against `directory.project_member` on write instead.
 * ponytail: unenforced integer — the upgrade is a tic-registry migration adding
 * `public.project` to that list (as `0016` did for `subject`) and a
 * `.references()` here.
 *
 * **`position` orders the queue within a round** and, as on `program_unit`,
 * carries no unique constraint: the save writes the array index, so two equal
 * positions only happen by hand, and they sort next to each other.
 *
 * **`state` is text checked in the api**, no `CHECK` and no enum (F18). Its
 * default is what a team added to the queue is.
 *
 * **A pin is two nullable columns, both or neither.** The api is the only
 * writer and enforces the pair; the database enforces the one rule two writers
 * can race on — see the partial index below.
 */
export const presentation = campus.table(
  "presentation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    offeringHomeId: uuid("offering_home_id")
      .notNull()
      .references(() => offeringHome.id),
    projectId: integer("project_id").notNull(),
    round: integer("round").notNull(),
    position: integer("position").notNull(),
    state: text("state").notNull().default("pending"),
    pinnedBlockId: uuid("pinned_block_id").references(
      () => presentationBlock.id,
    ),
    /** 1-based, at most the block's `slot_count`. */
    pinnedSlot: integer("pinned_slot"),
  },
  (t) => [
    /** A team is in a round's queue once — and the upsert's conflict target,
     *  which is what lets a save keep each row's `state`. Total, never partial,
     *  for that reason (`offering_home`'s note). */
    uniqueIndex("presentation_home_round_project_idx").on(
      t.offeringHomeId,
      t.round,
      t.projectId,
    ),
    /** Two teams cannot hold one slot. Partial, like
     *  `revision_request_open_idx`: an unpinned team holds nothing. */
    uniqueIndex("presentation_pin_idx")
      .on(t.pinnedBlockId, t.pinnedSlot)
      .where(sql`pinned_block_id is not null`),
    /** Deleting a block has to find the pins on it. */
    index("presentation_pinned_block_idx").on(t.pinnedBlockId),
  ],
);
