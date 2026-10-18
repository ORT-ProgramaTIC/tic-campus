import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  directoryOfferingTimeSlot,
  directoryProject,
  directoryProjectMember,
  directoryUser,
} from "../db/schema/directory.js";
import { offeringHome } from "../db/schema/offering-home.js";
import { presentation, presentationBlock } from "../db/schema/presentation.js";
import { isUuid } from "../library/program.js";
import { ApiError } from "../middleware/errors.js";

/**
 * The order an offering's teams present in, and when each one is expected to
 * (F45) — 2025's `campus-proyecto`, on rows instead of two Google Sheets.
 *
 * **Words.** A *block* is a school module, 1–6 (`offering_time_slot.slot`). A
 * *slot* is one presentation turn inside a block. A *round* is 2025's
 * `Instancia`. A *team* is a tic-registry project, which campus reads and never
 * stores.
 *
 * **The estimate is computed on every read and never stored**, as marks are
 * (F20). `schedule` is pure — blocks, queue and a clock in, one answer per team
 * out — so the rule has a test with no database under it, and the student's
 * banner and the teacher's table cannot disagree because they are one call.
 */

/* ── The bell (F42) ─────────────────────────────────────────────────────── */

/**
 * Blocks 1–6, from the school's timetable. There is no seventh. A code
 * constant (F42): it changes when the school changes its timetable, which is a
 * deploy anyway. 2025's code had blocks 5 and 6 ten minutes early — these are
 * the real ones.
 */
export const BELL: Record<number, { start: string; end: string }> = {
  1: { start: "07:45", end: "09:05" },
  2: { start: "09:20", end: "10:40" },
  3: { start: "10:55", end: "12:15" },
  4: { start: "13:10", end: "14:30" },
  5: { start: "14:40", end: "16:00" },
  6: { start: "16:10", end: "17:30" },
};

/** 2025's six, as the api's names. Pendiente, Presentando, Presentado,
 *  Aprobado, Desaprobado, No Presentan. */
export const STATES = [
  "pending",
  "presenting",
  "presented",
  "passed",
  "failed",
  "absent",
] as const;
export type PresentationState = (typeof STATES)[number];

export function isState(raw: unknown): raw is PresentationState {
  return (STATES as readonly unknown[]).includes(raw);
}

/** Still to present, so still in the queue. */
function waiting(state: string): boolean {
  return state === "pending" || state === "presenting";
}

/* ── Slots ──────────────────────────────────────────────────────────────── */

export interface Block {
  id: string;
  round: number;
  /** `YYYY-MM-DD`, a day in Buenos Aires. */
  date: string;
  block: number;
  slotCount: number;
  /** One `HH:MM` per slot, or `null` for the even split. May be shorter than
   *  `slotCount`, or absent, which reads as all `null`. */
  slotStarts: (string | null)[] | null;
  /** Slot numbers struck on this date — an event took them. They keep their
   *  number and time, so the slots after them do not renumber. */
  skippedSlots: number[];
}

/** Where a round's queue begins (F45): the teacher's "from here on". */
export interface QueueStart {
  round: number;
  blockId: string;
  slot: number;
}

export interface Slot {
  blockId: string;
  /** 1-based. */
  slot: number;
  date: string;
  start: string;
  end: string;
  overridden: boolean;
  /** Struck: drawn crossed out, given to nobody. */
  skipped: boolean;
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
}

function hhmm(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * A block's slots: the even split of its bell time into `slotCount`, with any
 * override replacing that slot's start. A slot ends where the next one starts,
 * and the last one where the block does — so an override moves the end of the
 * slot before it, which is what a teacher who typed "11:40" meant.
 */
export function expandSlots(block: Block): Slot[] {
  const bell = BELL[block.block]!;
  const start = minutes(bell.start);
  const length = minutes(bell.end) - start;
  const starts = Array.from({ length: block.slotCount }, (_, i) => {
    const override = block.slotStarts?.[i] ?? null;
    return override === null
      ? {
          at: start + Math.round((length * i) / block.slotCount),
          overridden: false,
        }
      : { at: minutes(override), overridden: true };
  });
  return starts.map((one, i) => ({
    blockId: block.id,
    slot: i + 1,
    date: block.date,
    start: hhmm(one.at),
    end: hhmm(starts[i + 1]?.at ?? minutes(bell.end)),
    overridden: one.overridden,
    skipped: block.skippedSlots.includes(i + 1),
  }));
}

/**
 * The instant a Buenos Aires `date` + `HH:MM` names.
 * ponytail: fixed UTC−3, as `isLocked` does — Argentina has had no DST since
 * 2009. A zone database is the upgrade if that ever changes.
 */
export function instant(date: string, time: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!, 3, 0) + minutes(time) * 60_000;
}

/* ── The estimate ───────────────────────────────────────────────────────── */

export interface QueueEntry {
  id: string;
  round: number;
  position: number;
  state: string;
  pinnedBlockId: string | null;
  pinnedSlot: number | null;
}

export interface Estimate extends Slot {
  /** Holding its pinned slot, rather than placed by the queue. */
  pinned: boolean;
}

export interface Scheduled {
  estimate: Estimate | null;
  /** Pinned to a slot that ended with the team still waiting, so placed by the
   *  queue instead. The teacher's view flags it; nothing waits on them. */
  pinMissed: boolean;
}

/**
 * Every team's estimate, per round (F45):
 *
 * 1. A slot is **live** until it ends — so a team presenting right now keeps
 *    the slot it is in, and the current slot is still offered to the queue.
 * 2. A waiting team pinned to a live slot holds it.
 * 3. A waiting team pinned to a slot that has ended **falls back into the
 *    queue** at its position, flagged `pinMissed`.
 * 4. The queue — every other waiting team, by position — takes the live free
 *    slots in time order. Whoever does not fit has no estimate yet.
 * 5. A finished team has no estimate, as in 2025.
 *
 * **A struck slot is given to nobody**, queue or pin. **A round's start**, if
 * the teacher set one, is where the queue begins: earlier slots are skipped by
 * the queue even while they are still ahead — and only by the queue, so a pin
 * before the start still holds. A start naming a slot that no longer exists is
 * no start, the way `offering_home.unit_order` treats a deleted unit.
 */
export function schedule(
  blocks: readonly Block[],
  queue: readonly QueueEntry[],
  now: Date = new Date(),
  starts: readonly QueueStart[] = [],
): Map<string, Scheduled> {
  const out = new Map<string, Scheduled>();
  const at = now.getTime();

  for (const round of new Set(queue.map((entry) => entry.round))) {
    const all = blocks
      .filter((block) => block.round === round)
      .flatMap(expandSlots);
    const start = starts.find((one) => one.round === round);
    const from = all.find(
      (slot) => slot.blockId === start?.blockId && slot.slot === start?.slot,
    );
    const slots = all
      .filter((slot) => !slot.skipped && instant(slot.date, slot.end) > at)
      .sort((a, b) => instant(a.date, a.start) - instant(b.date, b.start));
    const key = (blockId: string, slot: number) => `${blockId}/${slot}`;
    const live = new Map(
      slots.map((slot) => [key(slot.blockId, slot.slot), slot]),
    );
    const taken = new Set<string>();
    const line: QueueEntry[] = [];

    const entries = queue
      .filter((entry) => entry.round === round)
      .sort((a, b) => a.position - b.position);
    for (const entry of entries) {
      if (!waiting(entry.state)) {
        out.set(entry.id, { estimate: null, pinMissed: false });
        continue;
      }
      if (entry.pinnedBlockId !== null && entry.pinnedSlot !== null) {
        const pinKey = key(entry.pinnedBlockId, entry.pinnedSlot);
        const slot = live.get(pinKey);
        if (slot) {
          taken.add(pinKey);
          out.set(entry.id, {
            estimate: { ...slot, pinned: true },
            pinMissed: false,
          });
          continue;
        }
        out.set(entry.id, { estimate: null, pinMissed: true });
      }
      line.push(entry);
    }

    const free = slots.filter(
      (slot) =>
        !taken.has(key(slot.blockId, slot.slot)) &&
        (!from ||
          instant(slot.date, slot.start) >= instant(from.date, from.start)),
    );
    line.forEach((entry, i) => {
      const slot = free[i];
      out.set(entry.id, {
        estimate: slot ? { ...slot, pinned: false } : null,
        pinMissed: out.get(entry.id)?.pinMissed ?? false,
      });
    });
  }
  return out;
}

/* ── Reads ──────────────────────────────────────────────────────────────── */

export interface Member {
  name: string | null;
  surname: string | null;
  /** The discipline (Backend, UX/UI…), as tic-registry writes it. */
  track: string;
}

export interface Team {
  projectId: number;
  name: string;
  members: Member[];
}

/**
 * The offering's teams: live projects with a member who is here through this
 * offering. **The only reader of `directory.project`** — `project_offering` is
 * not published, so `project_member.offering_id` is the one road from an
 * offering to its projects, and a project nobody has joined is not on it.
 *
 * With its members' names — not `email` or `dni`. Everyone reading this is
 * signed in and in the offering, and the timetable's popup shows who is in
 * each slot, so a student sees the other teams' members too (decided
 * 2026-10-18).
 */
export async function offeringTeams(
  db: Db,
  offeringId: number,
): Promise<Team[]> {
  const rows = await db
    .select({
      projectId: directoryProject.id,
      team: directoryProject.name,
      name: directoryUser.name,
      surname: directoryUser.surname,
      track: directoryProjectMember.track,
    })
    .from(directoryProjectMember)
    .innerJoin(
      directoryProject,
      eq(directoryProject.id, directoryProjectMember.projectId),
    )
    .innerJoin(
      directoryUser,
      eq(directoryUser.id, directoryProjectMember.userId),
    )
    .where(
      and(
        eq(directoryProjectMember.offeringId, offeringId),
        isNull(directoryProject.archivedAt),
      ),
    )
    .orderBy(
      asc(directoryProject.name),
      asc(directoryProject.id),
      asc(directoryUser.surname),
      asc(directoryUser.name),
    );

  const teams = new Map<number, Team>();
  for (const row of rows) {
    let team = teams.get(row.projectId);
    if (!team) {
      team = { projectId: row.projectId, name: row.team, members: [] };
      teams.set(row.projectId, team);
    }
    team.members.push({
      name: row.name,
      surname: row.surname,
      track: row.track,
    });
  }
  return [...teams.values()];
}

/** The caller's own teams here — the student banner's "your group". A list,
 *  because nothing upstream stops one person being on two projects. */
export async function myTeams(
  db: Db,
  offeringId: number,
  userId: number,
): Promise<number[]> {
  const rows = await db
    .select({ projectId: directoryProjectMember.projectId })
    .from(directoryProjectMember)
    .where(
      and(
        eq(directoryProjectMember.offeringId, offeringId),
        eq(directoryProjectMember.userId, userId),
      ),
    );
  return rows.map((row) => row.projectId);
}

export interface ClassBlock {
  day: string;
  block: number;
  classroom: string | null;
}

/** The offering's weekly modules — the only blocks a presentation may use. */
export async function classBlocks(
  db: Db,
  offeringId: number,
): Promise<ClassBlock[]> {
  return db
    .select({
      day: directoryOfferingTimeSlot.day,
      block: directoryOfferingTimeSlot.slot,
      classroom: directoryOfferingTimeSlot.classroom,
    })
    .from(directoryOfferingTimeSlot)
    .where(eq(directoryOfferingTimeSlot.offeringId, offeringId));
}

export interface ScheduleRows {
  blocks: Block[];
  queue: (QueueEntry & { projectId: number })[];
  queueStarts: QueueStart[];
  savedAt: Date | null;
}

export async function readSchedule(
  db: Db,
  homeId: string,
): Promise<ScheduleRows> {
  const [blocks, queue, [home]] = await Promise.all([
    db
      .select({
        id: presentationBlock.id,
        round: presentationBlock.round,
        date: presentationBlock.date,
        block: presentationBlock.block,
        slotCount: presentationBlock.slotCount,
        slotStarts: presentationBlock.slotStarts,
        skippedSlots: presentationBlock.skippedSlots,
      })
      .from(presentationBlock)
      .where(eq(presentationBlock.offeringHomeId, homeId))
      .orderBy(asc(presentationBlock.date), asc(presentationBlock.block)),
    db
      .select({
        id: presentation.id,
        projectId: presentation.projectId,
        round: presentation.round,
        position: presentation.position,
        state: presentation.state,
        pinnedBlockId: presentation.pinnedBlockId,
        pinnedSlot: presentation.pinnedSlot,
      })
      .from(presentation)
      .where(eq(presentation.offeringHomeId, homeId))
      .orderBy(asc(presentation.round), asc(presentation.position)),
    db
      .select({
        savedAt: offeringHome.scheduleSavedAt,
        queueStarts: offeringHome.queueStarts,
      })
      .from(offeringHome)
      .where(eq(offeringHome.id, homeId)),
  ]);
  return {
    blocks,
    queue,
    queueStarts: home?.queueStarts ?? [],
    savedAt: home?.savedAt ?? null,
  };
}

/* ── Writing ────────────────────────────────────────────────────────────── */

export interface ScheduleInput {
  /** The `savedAt` the dashboard loaded, or null if it never was. */
  base: Date | null;
  blocks: Block[];
  /** In order: a team's position is its index among its round's entries. */
  presentations: {
    projectId: number;
    round: number;
    pin: { blockId: string; slot: number } | null;
  }[];
  /** At most one per round. Absent is "from now". */
  queueStarts: QueueStart[];
}

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

function weekday(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()]!;
}

export interface Previewed extends Scheduled {
  /** `null` for a team this body adds; it gets one when saved. */
  id: string | null;
  projectId: number;
  round: number;
  position: number;
  state: PresentationState;
  pin: { blockId: string; slot: number } | null;
}

/**
 * Where every team would land if `input` were saved — the dashboard's live
 * view while the teacher edits (F45). Refused exactly as the save would be,
 * so a body that previews is a body that saves; only the stale check is left
 * to the save, since nothing here is written.
 *
 * A team already saved keeps its state (`setState`'s, never the body's); a new
 * one is `pending`. Same order as the body.
 */
export async function previewSchedule(
  db: Db,
  homeId: string,
  offeringId: number,
  year: number,
  input: ScheduleInput,
  now: Date = new Date(),
): Promise<Previewed[]> {
  const [teams, modules, saved] = await Promise.all([
    offeringTeams(db, offeringId),
    classBlocks(db, offeringId),
    readSchedule(db, homeId),
  ]);
  checkAgainst(
    input,
    year,
    new Set(teams.map((team) => team.projectId)),
    modules,
  );

  const existing = new Map(
    saved.queue.map((row) => [`${row.round}/${row.projectId}`, row]),
  );
  const positions = new Map<number, number>();
  const rows = input.presentations.map((entry) => {
    const position = positions.get(entry.round) ?? 0;
    positions.set(entry.round, position + 1);
    const row = existing.get(`${entry.round}/${entry.projectId}`);
    return {
      // The scheduler keys by id; a new team borrows a key no uuid can be.
      key: row?.id ?? `new/${entry.round}/${entry.projectId}`,
      id: row?.id ?? null,
      projectId: entry.projectId,
      round: entry.round,
      position,
      state: (row?.state ?? "pending") as PresentationState,
      pin: entry.pin,
    };
  });
  const placed = schedule(
    input.blocks,
    rows.map((row) => ({
      id: row.key,
      round: row.round,
      position: row.position,
      state: row.state,
      pinnedBlockId: row.pin?.blockId ?? null,
      pinnedSlot: row.pin?.slot ?? null,
    })),
    now,
    input.queueStarts,
  );
  return rows.map(({ key, ...row }) => ({ ...row, ...placed.get(key)! }));
}

/**
 * Save the schedule whole (F45): blocks, slots, order and pins, in one
 * transaction. Returns the new `savedAt`.
 *
 * **It deletes by omission**, which is the opposite of `PUT …/program`'s rule
 * (F15), and safe here for the reason that rule exists: nothing points at
 * these rows but the pins this same body rewrites, so there is no dependant to
 * lose. Two teachers are what the stale check is for.
 *
 * **It never writes `state`.** An existing team keeps whatever `setState` last
 * set, and a new one starts `pending` — so a state flipped during a
 * presentation survives a dashboard saved from a tab opened before it.
 *
 * Order matters, because of two indexes and two foreign keys: the stale check
 * first, as an `UPDATE` so it takes the row lock and two saves cannot both
 * pass; then the home's pins are cleared, so swapping two teams' pins in one
 * body does not trip `presentation_pin_idx` row by row; then the blocks left
 * out are deleted, which nothing points at any more, so a block re-added on
 * the same date and module does not trip `(home, date, block)`; then blocks
 * are upserted (a pin may name a new one), then the queue, then the
 * presentations left out are deleted.
 */
export async function saveSchedule(
  db: Db,
  homeId: string,
  offeringId: number,
  year: number,
  input: ScheduleInput,
): Promise<Date> {
  const [teams, modules] = await Promise.all([
    offeringTeams(db, offeringId),
    classBlocks(db, offeringId),
  ]);
  checkAgainst(
    input,
    year,
    new Set(teams.map((team) => team.projectId)),
    modules,
  );

  return db.transaction(async (tx) => {
    // Millisecond precision on purpose: the token goes out as a JS `Date`,
    // which has nothing finer, and comes back to be compared for equality.
    const [saved] = await tx
      .update(offeringHome)
      .set({
        scheduleSavedAt: sql`date_trunc('milliseconds', now())`,
        // In the same statement as the token: the start is part of the
        // schedule, so a stale body cannot move it either.
        queueStarts: input.queueStarts,
      })
      .where(
        and(
          eq(offeringHome.id, homeId),
          input.base === null
            ? isNull(offeringHome.scheduleSavedAt)
            : eq(offeringHome.scheduleSavedAt, input.base),
        ),
      )
      .returning({ savedAt: offeringHome.scheduleSavedAt });
    if (!saved?.savedAt) {
      throw new ApiError(
        409,
        "stale_schedule",
        "Alguien guardó el cronograma mientras lo editabas. Volvé a cargarlo.",
      );
    }

    await tx
      .update(presentation)
      .set({ pinnedBlockId: null, pinnedSlot: null })
      .where(eq(presentation.offeringHomeId, homeId));

    // Before the upsert, with nothing pinned to them any more: a block removed
    // and added back on the same date and module arrives with a fresh id, and
    // would trip `(home, date, block)` against the row it replaces.
    const blockIds = input.blocks.map((block) => block.id);
    await tx
      .delete(presentationBlock)
      .where(
        and(
          eq(presentationBlock.offeringHomeId, homeId),
          blockIds.length > 0
            ? notInArray(presentationBlock.id, blockIds)
            : undefined,
        ),
      );

    // A block id belongs to the home that created it. Without this, an id from
    // another offering's body would upsert straight over that offering's row.
    if (blockIds.length > 0) {
      const foreign = await tx
        .select({ id: presentationBlock.id })
        .from(presentationBlock)
        .where(
          and(
            inArray(presentationBlock.id, blockIds),
            ne(presentationBlock.offeringHomeId, homeId),
          ),
        );
      if (foreign.length > 0) {
        throw new ApiError(
          400,
          "invalid_body",
          "Ese bloque no es de esta materia.",
        );
      }
      await tx
        .insert(presentationBlock)
        .values(
          input.blocks.map((block) => ({ ...block, offeringHomeId: homeId })),
        )
        .onConflictDoUpdate({
          target: presentationBlock.id,
          set: {
            round: sql`excluded.round`,
            date: sql`excluded.date`,
            block: sql`excluded.block`,
            slotCount: sql`excluded.slot_count`,
            slotStarts: sql`excluded.slot_starts`,
            skippedSlots: sql`excluded.skipped_slots`,
          },
        });
    }

    const positions = new Map<number, number>();
    const rows = input.presentations.map((entry) => {
      const position = positions.get(entry.round) ?? 0;
      positions.set(entry.round, position + 1);
      return {
        offeringHomeId: homeId,
        projectId: entry.projectId,
        round: entry.round,
        position,
        pinnedBlockId: entry.pin?.blockId ?? null,
        pinnedSlot: entry.pin?.slot ?? null,
      };
    });
    const kept: string[] = [];
    if (rows.length > 0) {
      const upserted = await tx
        .insert(presentation)
        .values(rows)
        .onConflictDoUpdate({
          target: [
            presentation.offeringHomeId,
            presentation.round,
            presentation.projectId,
          ],
          set: {
            position: sql`excluded.position`,
            pinnedBlockId: sql`excluded.pinned_block_id`,
            pinnedSlot: sql`excluded.pinned_slot`,
          },
        })
        .returning({ id: presentation.id });
      kept.push(...upserted.map((row) => row.id));
    }

    await tx
      .delete(presentation)
      .where(
        and(
          eq(presentation.offeringHomeId, homeId),
          kept.length > 0 ? notInArray(presentation.id, kept) : undefined,
        ),
      );

    return saved.savedAt;
  });
}

/**
 * Everything about a body that needs the directory, before the transaction
 * opens. Each refusal names what to fix, because a teacher reads it.
 */
function checkAgainst(
  input: ScheduleInput,
  year: number,
  teams: Set<number>,
  modules: ClassBlock[],
): void {
  const meets = new Set(modules.map((one) => `${one.day}/${one.block}`));
  const byId = new Map<string, Block>();
  const used = new Set<string>();
  for (const block of input.blocks) {
    if (byId.has(block.id)) {
      throw new ApiError(
        400,
        "invalid_body",
        "Hay dos bloques con el mismo id.",
      );
    }
    byId.set(block.id, block);
    if (Number(block.date.slice(0, 4)) !== year) {
      throw new ApiError(
        400,
        "invalid_body",
        `${block.date} no es del ${year}.`,
      );
    }
    if (!meets.has(`${weekday(block.date)}/${block.block}`)) {
      throw new ApiError(
        400,
        "not_a_class_block",
        `El ${block.date} no hay ${block.block}° bloque de esta materia.`,
      );
    }
    const where = `${block.date}/${block.block}`;
    if (used.has(where)) {
      throw new ApiError(
        400,
        "invalid_body",
        `El ${block.block}° bloque del ${block.date} está dos veces.`,
      );
    }
    used.add(where);
    // The resolved starts have to land inside the block and keep their order:
    // an override that jumps a neighbour would make a slot end before it begins.
    const slots = expandSlots(block);
    const bell = BELL[block.block]!;
    slots.forEach((slot, i) => {
      if (
        minutes(slot.start) < minutes(bell.start) ||
        minutes(slot.start) >= minutes(bell.end) ||
        (i > 0 && minutes(slot.start) <= minutes(slots[i - 1]!.start))
      ) {
        throw new ApiError(
          400,
          "invalid_body",
          `Los turnos del ${block.block}° bloque del ${block.date} tienen que ir en orden, entre ${bell.start} y ${bell.end}.`,
        );
      }
    });
    // Past the count is the one way a struck list goes stale: the count
    // changed and the client kept the old list. Refused, like a `slotStarts`
    // of the wrong length, rather than trimmed behind the teacher's back.
    if (
      new Set(block.skippedSlots).size !== block.skippedSlots.length ||
      block.skippedSlots.some((slot) => slot > block.slotCount)
    ) {
      throw new ApiError(
        400,
        "invalid_body",
        `Los turnos quitados del ${block.block}° bloque del ${block.date} no coinciden con sus ${block.slotCount} turnos.`,
      );
    }
  }

  const rounds = new Set<number>();
  for (const start of input.queueStarts) {
    const block = byId.get(start.blockId);
    if (
      rounds.has(start.round) ||
      !block ||
      block.round !== start.round ||
      start.slot > block.slotCount
    ) {
      throw new ApiError(
        400,
        "invalid_body",
        "Cada ronda arranca en un turno de sus bloques, y una sola vez.",
      );
    }
    rounds.add(start.round);
  }

  const queued = new Set<string>();
  const pinned = new Set<string>();
  for (const entry of input.presentations) {
    if (!teams.has(entry.projectId)) {
      throw new ApiError(
        400,
        "unknown_team",
        "Ese grupo no es de esta materia.",
      );
    }
    const key = `${entry.round}/${entry.projectId}`;
    if (queued.has(key)) {
      throw new ApiError(
        400,
        "invalid_body",
        "Un grupo está dos veces en la misma ronda.",
      );
    }
    queued.add(key);
    if (entry.pin) {
      const block = byId.get(entry.pin.blockId);
      if (
        !block ||
        block.round !== entry.round ||
        entry.pin.slot > block.slotCount
      ) {
        throw new ApiError(
          400,
          "invalid_body",
          "Un grupo está fijado a un turno que no existe en su ronda.",
        );
      }
      if (block.skippedSlots.includes(entry.pin.slot)) {
        throw new ApiError(
          400,
          "invalid_body",
          `El turno ${entry.pin.slot} del ${block.block}° bloque del ${block.date} está quitado.`,
        );
      }
      const slot = `${entry.pin.blockId}/${entry.pin.slot}`;
      if (pinned.has(slot)) {
        throw new ApiError(
          400,
          "invalid_body",
          "Dos grupos están fijados al mismo turno.",
        );
      }
      pinned.add(slot);
    }
  }
}

/**
 * One team's state, from the presentation itself. **The home is in the
 * `where`**, so an id from another offering is a 404 and not a write —
 * `answerRequest`'s idiom. It does not move `savedAt`: see `saveSchedule`.
 */
export async function setState(
  db: Db,
  homeId: string,
  id: string,
  state: PresentationState,
): Promise<void> {
  const set = await db
    .update(presentation)
    .set({ state })
    .where(
      and(eq(presentation.id, id), eq(presentation.offeringHomeId, homeId)),
    )
    .returning({ id: presentation.id });
  if (set.length === 0) {
    throw new ApiError(
      404,
      "not_found",
      "No encontramos ese grupo en el cronograma.",
    );
  }
}

/* ── What is accepted ───────────────────────────────────────────────────── */

/** A year of presentations, generously. Only stops a garbage array. */
const MAX_BLOCKS = 200;
const MAX_ENTRIES = 500;
const MAX_ROUNDS = 9;
const MAX_SLOTS = 12;

function invalid(message: string): ApiError {
  return new ApiError(400, "invalid_body", message);
}

function intIn(raw: unknown, min: number, max: number): raw is number {
  return (
    typeof raw === "number" && Number.isInteger(raw) && raw >= min && raw <= max
  );
}

/** Shape only — what needs the directory is `checkAgainst`. */
export function checkSchedule(raw: unknown): ScheduleInput {
  if (typeof raw !== "object" || raw === null)
    throw invalid("Esperábamos un objeto.");
  const body = raw as Record<string, unknown>;

  let base: Date | null = null;
  if (body.base !== null && body.base !== undefined) {
    base = typeof body.base === "string" ? new Date(body.base) : new Date(NaN);
    if (Number.isNaN(base.getTime()))
      throw invalid("`base` es el `savedAt` que cargaste.");
  }

  if (!Array.isArray(body.blocks) || body.blocks.length > MAX_BLOCKS) {
    throw invalid(`\`blocks\` es una lista de hasta ${MAX_BLOCKS}.`);
  }
  const blocks = body.blocks.map((one): Block => {
    const block = (one ?? {}) as Record<string, unknown>;
    if (!isUuid(block.id)) throw invalid("Cada bloque lleva un `id` uuid.");
    if (!intIn(block.round, 1, MAX_ROUNDS))
      throw invalid(`\`round\` va de 1 a ${MAX_ROUNDS}.`);
    if (typeof block.date !== "string" || !isDate(block.date)) {
      throw invalid("`date` es `AAAA-MM-DD`.");
    }
    if (!intIn(block.block, 1, 6)) throw invalid("`block` va de 1 a 6.");
    const slotCount = block.slotCount ?? 3;
    if (!intIn(slotCount, 1, MAX_SLOTS))
      throw invalid(`\`slotCount\` va de 1 a ${MAX_SLOTS}.`);
    let slotStarts: (string | null)[] | null = null;
    if (block.slotStarts !== undefined && block.slotStarts !== null) {
      if (
        !Array.isArray(block.slotStarts) ||
        block.slotStarts.length !== slotCount
      ) {
        throw invalid("`slotStarts` lleva un horario (o `null`) por turno.");
      }
      slotStarts = block.slotStarts.map((start) => {
        if (start === null) return null;
        if (
          typeof start !== "string" ||
          !/^([01]\d|2[0-3]):[0-5]\d$/.test(start)
        ) {
          throw invalid("Cada horario es `HH:MM`.");
        }
        return start;
      });
      if (slotStarts.every((start) => start === null)) slotStarts = null;
    }
    const skippedSlots = block.skippedSlots ?? [];
    if (
      !Array.isArray(skippedSlots) ||
      !skippedSlots.every((slot) => intIn(slot, 1, MAX_SLOTS))
    ) {
      throw invalid("`skippedSlots` es una lista de números de turno.");
    }
    return {
      id: block.id.toLowerCase(),
      round: block.round,
      date: block.date,
      block: block.block,
      slotCount,
      slotStarts,
      skippedSlots: [...(skippedSlots as number[])].sort((a, b) => a - b),
    };
  });

  if (
    !Array.isArray(body.presentations) ||
    body.presentations.length > MAX_ENTRIES
  ) {
    throw invalid(`\`presentations\` es una lista de hasta ${MAX_ENTRIES}.`);
  }
  const presentations = body.presentations.map((one) => {
    const entry = (one ?? {}) as Record<string, unknown>;
    if (!intIn(entry.projectId, 1, 2 ** 31 - 1))
      throw invalid("Falta el `projectId`.");
    if (!intIn(entry.round, 1, MAX_ROUNDS))
      throw invalid(`\`round\` va de 1 a ${MAX_ROUNDS}.`);
    let pin: { blockId: string; slot: number } | null = null;
    if (entry.pin !== undefined && entry.pin !== null) {
      const raw = entry.pin as Record<string, unknown>;
      if (!isUuid(raw.blockId) || !intIn(raw.slot, 1, MAX_SLOTS)) {
        throw invalid("`pin` es `{ blockId, slot }`.");
      }
      pin = { blockId: raw.blockId.toLowerCase(), slot: raw.slot };
    }
    return { projectId: entry.projectId, round: entry.round, pin };
  });

  const rawStarts = body.queueStarts ?? [];
  if (!Array.isArray(rawStarts) || rawStarts.length > MAX_ROUNDS) {
    throw invalid(`\`queueStarts\` es una lista de hasta ${MAX_ROUNDS}.`);
  }
  const queueStarts = rawStarts.map((one): QueueStart => {
    const start = (one ?? {}) as Record<string, unknown>;
    if (
      !intIn(start.round, 1, MAX_ROUNDS) ||
      !isUuid(start.blockId) ||
      !intIn(start.slot, 1, MAX_SLOTS)
    ) {
      throw invalid("Cada `queueStarts` es `{ round, blockId, slot }`.");
    }
    return {
      round: start.round,
      blockId: start.blockId.toLowerCase(),
      slot: start.slot,
    };
  });

  return { base, blocks, presentations, queueStarts };
}

export function checkState(raw: unknown): PresentationState {
  const state = (raw as Record<string, unknown> | null)?.state;
  if (!isState(state)) throw invalid(`\`state\` es ${STATES.join(", ")}.`);
  return state;
}

/** A real calendar day: `2026-02-30` round-trips to March and is refused. */
function isDate(raw: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const [y, m, d] = raw.split("-").map(Number);
  const day = new Date(Date.UTC(y!, m! - 1, d!));
  return (
    day.getUTCFullYear() === y &&
    day.getUTCMonth() === m! - 1 &&
    day.getUTCDate() === d
  );
}
