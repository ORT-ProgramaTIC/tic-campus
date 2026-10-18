import type {
  Block,
  PresentationsPayload,
  QueueStart,
  ScheduleBody,
  Slot,
} from "./api/types.ts";

/**
 * The Cronograma's unsaved schedule, and every edit to it as a pure function
 * (`draft.test.mjs`). Each edit keeps the draft one the save accepts: a pin on
 * a struck slot, a start past a block's count or a pin on a deleted block is
 * cleaned up by the edit that caused it, not refused later by the api.
 */

export type DraftBlock = Omit<Block, "slots">;

export interface DraftEntry {
  projectId: number;
  round: number;
  pin: { blockId: string; slot: number } | null;
}

export interface Draft {
  blocks: DraftBlock[];
  /** In order: position is the index among the round's entries. */
  queue: DraftEntry[];
  queueStarts: QueueStart[];
}

export type Bell = Record<string, { start: string; end: string }>;

export const MAX_SLOTS = 12;

export function fromPayload(payload: PresentationsPayload): Draft {
  return {
    blocks: payload.blocks.map(({ slots: _slots, ...block }) => block),
    queue: payload.presentations.map((row) => ({
      projectId: row.projectId,
      round: row.round,
      pin: row.pin,
    })),
    queueStarts: payload.queueStarts,
  };
}

export function toBody(draft: Draft, base: string | null): ScheduleBody {
  return {
    base,
    blocks: draft.blocks,
    presentations: draft.queue,
    queueStarts: draft.queueStarts,
  };
}

/* ── Slots: the api's `expandSlots`, so an edit redraws before the preview ── */

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
};
const hhmm = (total: number) =>
  `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;

/** Mirrors `api/src/offerings/presentations.ts`'s `expandSlots`: the even
 *  split of the bell time, overrides replacing starts, each slot ending where
 *  the next begins. */
export function expandSlots(block: DraftBlock, bell: Bell): Slot[] {
  const { start: from, end: to } = bell[block.block]!;
  const start = minutes(from);
  const length = minutes(to) - start;
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
    end: hhmm(starts[i + 1]?.at ?? minutes(to)),
    overridden: one.overridden,
    skipped: block.skippedSlots.includes(i + 1),
  }));
}

/** The save's own check on a block's times, said before the save says it. */
export function timesProblem(block: DraftBlock, bell: Bell): string | null {
  const { start, end } = bell[block.block]!;
  const slots = expandSlots(block, bell);
  const bad = slots.some(
    (slot, i) =>
      minutes(slot.start) < minutes(start) ||
      minutes(slot.start) >= minutes(end) ||
      (i > 0 && minutes(slot.start) <= minutes(slots[i - 1]!.start)),
  );
  return bad
    ? `Los turnos tienen que ir en orden, entre ${start} y ${end}.`
    : null;
}

/* ── Edits ─────────────────────────────────────────────────────────────── */

const onSlot =
  (blockId: string, keep: (slot: number) => boolean) =>
  (target: { blockId: string; slot: number } | null) =>
    target === null || target.blockId !== blockId || keep(target.slot);

/** Drop every pin and start that `keep` rejects on this block. */
function prune(
  draft: Draft,
  blockId: string,
  keep: (slot: number) => boolean,
): Draft {
  const ok = onSlot(blockId, keep);
  return {
    ...draft,
    queue: draft.queue.map((entry) =>
      ok(entry.pin) ? entry : { ...entry, pin: null },
    ),
    queueStarts: draft.queueStarts.filter(ok),
  };
}

const mapBlock = (
  draft: Draft,
  blockId: string,
  change: (block: DraftBlock) => DraftBlock,
): Draft => ({
  ...draft,
  blocks: draft.blocks.map((block) =>
    block.id === blockId ? change(block) : block,
  ),
});

export function addBlock(
  draft: Draft,
  block: { id: string; round: number; date: string; block: number },
): Draft {
  return {
    ...draft,
    blocks: [
      ...draft.blocks,
      { ...block, slotCount: 3, slotStarts: null, skippedSlots: [] },
    ],
  };
}

export function removeBlock(draft: Draft, blockId: string): Draft {
  const pruned = prune(draft, blockId, () => false);
  return {
    ...pruned,
    blocks: pruned.blocks.filter((block) => block.id !== blockId),
  };
}

/** A new count re-splits the block: overrides and strikes reset (the api
 *  refuses stale ones rather than guessing), and pins or a start past the new
 *  count go. */
export function setSlotCount(
  draft: Draft,
  blockId: string,
  count: number,
): Draft {
  const resized = mapBlock(draft, blockId, (block) => ({
    ...block,
    slotCount: count,
    slotStarts: null,
    skippedSlots: [],
  }));
  return prune(resized, blockId, (slot) => slot <= count);
}

/** One slot's start, or `null` back to the even split. */
export function setSlotStart(
  draft: Draft,
  blockId: string,
  slot: number,
  time: string | null,
): Draft {
  return mapBlock(draft, blockId, (block) => {
    const starts = Array.from(
      { length: block.slotCount },
      (_, i) => block.slotStarts?.[i] ?? null,
    );
    starts[slot - 1] = time;
    return {
      ...block,
      slotStarts: starts.every((one) => one === null) ? null : starts,
    };
  });
}

/** Strike a slot, or give it back. Striking unpins whoever held it. */
export function toggleSkip(draft: Draft, blockId: string, slot: number): Draft {
  const block = draft.blocks.find((one) => one.id === blockId)!;
  if (block.skippedSlots.includes(slot)) {
    return mapBlock(draft, blockId, (one) => ({
      ...one,
      skippedSlots: one.skippedSlots.filter((n) => n !== slot),
    }));
  }
  const struck = mapBlock(draft, blockId, (one) => ({
    ...one,
    skippedSlots: [...one.skippedSlots, slot].sort((a, b) => a - b),
  }));
  return {
    ...struck,
    queue: struck.queue.map((entry) =>
      entry.pin?.blockId === blockId && entry.pin.slot === slot
        ? { ...entry, pin: null }
        : entry,
    ),
  };
}

/** The round's queue starts here; `null` clears it (back to "from now"). */
export function setQueueStart(
  draft: Draft,
  round: number,
  at: { blockId: string; slot: number } | null,
): Draft {
  return {
    ...draft,
    queueStarts: [
      ...draft.queueStarts.filter((one) => one.round !== round),
      ...(at ? [{ round, ...at }] : []),
    ],
  };
}

/** Fix a team to a slot (`null` unfixes it). Whoever held that slot is
 *  unpinned: a slot holds one team. */
export function pin(
  draft: Draft,
  projectId: number,
  round: number,
  at: { blockId: string; slot: number } | null,
): Draft {
  return {
    ...draft,
    queue: draft.queue.map((entry) => {
      if (entry.round !== round) return entry;
      if (entry.projectId === projectId) return { ...entry, pin: at };
      return at &&
        entry.pin?.blockId === at.blockId &&
        entry.pin.slot === at.slot
        ? { ...entry, pin: null }
        : entry;
    }),
  };
}

/* ── The queue ─────────────────────────────────────────────────────────── */

/** A team joins the end of a round's queue. */
export function addTeam(draft: Draft, projectId: number, round: number): Draft {
  return {
    ...draft,
    queue: [...draft.queue, { projectId, round, pin: null }],
  };
}

/** A team leaves a round's queue; on save its row, and its state, go. */
export function removeTeam(
  draft: Draft,
  projectId: number,
  round: number,
): Draft {
  return {
    ...draft,
    queue: draft.queue.filter(
      (entry) => !(entry.projectId === projectId && entry.round === round),
    ),
  };
}

/** Move the round's `from`-th team to be its `to`-th. Only order within a
 *  round is position, so the other rounds keep their entries untouched. */
export function moveTeam(
  draft: Draft,
  round: number,
  from: number,
  to: number,
): Draft {
  const line = draft.queue.filter((entry) => entry.round === round);
  if (from === to || to < 0 || to >= line.length) return draft;
  const [moved] = line.splice(from, 1);
  line.splice(to, 0, moved!);
  return {
    ...draft,
    queue: [...draft.queue.filter((entry) => entry.round !== round), ...line],
  };
}
