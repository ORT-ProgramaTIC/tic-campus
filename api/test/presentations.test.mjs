// F45's estimate: blocks and a queue in, one slot per waiting team out. Pure,
// so the rule is pinned down with no database — the queries that load these
// rows are `db.test.mjs`, the routes `scripts/harness-presentations.mjs`.
//
// The bug this file exists to prevent: a team told the wrong day. A pin that
// silently loses its slot, a presenting team bumped to the next one, or a
// round's teams spilling into another round's blocks.
import assert from "node:assert/strict";
import test from "node:test";
import {
  checkSchedule,
  expandSlots,
  instant,
  schedule,
} from "../dist/offerings/presentations.js";

// Friday 13 November 2026 and Tuesday 17 November 2026, in Buenos Aires.
const FRI = "2026-11-13";
const TUE = "2026-11-17";
const at = (date, time) => new Date(instant(date, time));
const BEFORE = at(FRI, "07:00");

function block(id, date, number, extra = {}) {
  return {
    id,
    round: 1,
    date,
    block: number,
    slotCount: 3,
    slotStarts: null,
    skippedSlots: [],
    ...extra,
  };
}

function team(id, position, extra = {}) {
  return {
    id,
    round: 1,
    position,
    state: "pending",
    pinnedBlockId: null,
    pinnedSlot: null,
    ...extra,
  };
}

const where = (placed, id) => {
  const estimate = placed.get(id)?.estimate;
  return estimate ? `${estimate.date} ${estimate.start}` : null;
};

test("a block splits evenly into three by default, the last slot ending with the bell", () => {
  const slots = expandSlots(block("b", FRI, 3));
  assert.deepEqual(
    slots.map((slot) => [slot.start, slot.end]),
    [
      ["10:55", "11:22"],
      ["11:22", "11:48"],
      ["11:48", "12:15"],
    ],
  );
});

test("changing the count re-splits the block", () => {
  const slots = expandSlots(block("b", FRI, 1, { slotCount: 4 }));
  assert.deepEqual(
    slots.map((slot) => slot.start),
    ["07:45", "08:05", "08:25", "08:45"],
  );
});

test("an override moves one start and the end of the slot before it", () => {
  const slots = expandSlots(
    block("b", FRI, 3, { slotStarts: [null, "11:40", null] }),
  );
  assert.deepEqual(
    slots.map((slot) => [slot.start, slot.end, slot.overridden]),
    [
      ["10:55", "11:40", false],
      ["11:40", "11:48", true],
      ["11:48", "12:15", false],
    ],
  );
});

test("the queue fills slots in time order, and whoever does not fit has no estimate", () => {
  const blocks = [
    block("tue", TUE, 1, { slotCount: 1 }),
    block("fri", FRI, 3, { slotCount: 2 }),
  ];
  const queue = [team("a", 0), team("b", 1), team("c", 2), team("d", 3)];
  const placed = schedule(blocks, queue, BEFORE);
  assert.equal(where(placed, "a"), `${FRI} 10:55`);
  assert.equal(where(placed, "b"), `${FRI} 11:35`);
  assert.equal(where(placed, "c"), `${TUE} 07:45`);
  assert.equal(where(placed, "d"), null);
});

test("a pin holds its slot and the queue flows around it", () => {
  const blocks = [block("fri", FRI, 3)];
  const queue = [
    team("a", 0),
    team("b", 1, { pinnedBlockId: "fri", pinnedSlot: 1 }),
    team("c", 2),
  ];
  const placed = schedule(blocks, queue, BEFORE);
  assert.equal(where(placed, "b"), `${FRI} 10:55`);
  assert.equal(placed.get("b").estimate.pinned, true);
  assert.equal(where(placed, "a"), `${FRI} 11:22`);
  assert.equal(where(placed, "c"), `${FRI} 11:48`);
});

test("a missed pin falls back into the queue at its position, flagged", () => {
  const blocks = [block("fri", FRI, 1), block("tue", TUE, 1)];
  const queue = [
    team("a", 0, { pinnedBlockId: "fri", pinnedSlot: 1 }),
    team("b", 1),
  ];
  // Friday's first block is over, and `a` is still pending.
  const placed = schedule(blocks, queue, at(FRI, "12:00"));
  assert.equal(placed.get("a").pinMissed, true);
  assert.equal(placed.get("a").estimate.pinned, false);
  assert.equal(where(placed, "a"), `${TUE} 07:45`);
  assert.equal(where(placed, "b"), `${TUE} 08:12`);
});

test("a team presenting right now keeps the slot it is in", () => {
  const blocks = [block("fri", FRI, 3)];
  const queue = [team("a", 0, { state: "presenting" }), team("b", 1)];
  // Ten minutes into the first slot.
  const placed = schedule(blocks, queue, at(FRI, "11:05"));
  assert.equal(where(placed, "a"), `${FRI} 10:55`);
  assert.equal(where(placed, "b"), `${FRI} 11:22`);
});

test("rounds do not borrow each other's blocks", () => {
  const blocks = [
    block("r1", FRI, 3, { slotCount: 1 }),
    block("r2", TUE, 3, { round: 2 }),
  ];
  const queue = [team("a", 0), team("b", 1), team("c", 0, { round: 2 })];
  const placed = schedule(blocks, queue, BEFORE);
  assert.equal(where(placed, "a"), `${FRI} 10:55`);
  assert.equal(where(placed, "b"), null);
  assert.equal(where(placed, "c"), `${TUE} 10:55`);
});

test("a finished team has no estimate and frees its place in the queue", () => {
  const blocks = [block("fri", FRI, 3)];
  const queue = [team("a", 0, { state: "passed" }), team("b", 1)];
  const placed = schedule(blocks, queue, BEFORE);
  assert.equal(placed.get("a").estimate, null);
  assert.equal(where(placed, "b"), `${FRI} 10:55`);
});

test("the body checker takes the shape and refuses the obvious garbage", () => {
  const id = "5f8e1c9a-2b3d-4e5f-8a9b-0c1d2e3f4a5b";
  const ok = checkSchedule({
    base: null,
    blocks: [{ id: id.toUpperCase(), round: 1, date: FRI, block: 3 }],
    presentations: [{ projectId: 7, round: 1, pin: { blockId: id, slot: 2 } }],
  });
  // Lowercased, so a pin and its block always compare equal.
  assert.equal(ok.blocks[0].id, id);
  assert.equal(ok.blocks[0].slotCount, 3);
  assert.throws(
    () =>
      checkSchedule({
        base: null,
        blocks: [{ id, round: 1, date: "2026-02-30", block: 3 }],
        presentations: [],
      }),
    { code: "invalid_body" },
  );
  assert.throws(
    () =>
      checkSchedule({
        base: null,
        blocks: [{ id, round: 1, date: FRI, block: 7 }],
        presentations: [],
      }),
    { code: "invalid_body" },
  );
  assert.throws(
    () =>
      checkSchedule({
        base: null,
        blocks: [
          {
            id,
            round: 1,
            date: FRI,
            block: 3,
            slotCount: 2,
            slotStarts: ["11:00"],
          },
        ],
        presentations: [],
      }),
    { code: "invalid_body" },
  );
});

test("a struck slot keeps its time and number, and is given to nobody", () => {
  const blocks = [block("fri", FRI, 3, { skippedSlots: [2] })];
  const slots = expandSlots(blocks[0]);
  assert.deepEqual(
    slots.map((slot) => [slot.slot, slot.start, slot.skipped]),
    [
      [1, "10:55", false],
      [2, "11:22", true],
      [3, "11:48", false],
    ],
  );
  const placed = schedule(
    blocks,
    [team("a", 0), team("b", 1), team("c", 2)],
    BEFORE,
  );
  assert.equal(where(placed, "a"), `${FRI} 10:55`);
  assert.equal(where(placed, "b"), `${FRI} 11:48`, "slot 2 is skipped");
  assert.equal(where(placed, "c"), null);
});

test("a pin on a slot struck since falls back into the queue", () => {
  const blocks = [block("fri", FRI, 3, { skippedSlots: [1] })];
  const queue = [team("a", 0, { pinnedBlockId: "fri", pinnedSlot: 1 })];
  const placed = schedule(blocks, queue, BEFORE);
  assert.equal(placed.get("a").pinMissed, true);
  assert.equal(where(placed, "a"), `${FRI} 11:22`);
});

test("the queue begins at the round's start, even with earlier slots still ahead", () => {
  const blocks = [block("fri", FRI, 3), block("tue", TUE, 1)];
  const queue = [team("a", 0), team("b", 1)];
  const starts = [{ round: 1, blockId: "fri", slot: 3 }];
  const placed = schedule(blocks, queue, BEFORE, starts);
  assert.equal(where(placed, "a"), `${FRI} 11:48`);
  assert.equal(where(placed, "b"), `${TUE} 07:45`);
});

test("a pin before the start still holds; a missed pin lands after the start", () => {
  const blocks = [block("thu", "2026-11-12", 3), block("fri", FRI, 3)];
  const queue = [
    team("early", 0, { pinnedBlockId: "fri", pinnedSlot: 1 }),
    team("missed", 1, { pinnedBlockId: "thu", pinnedSlot: 1 }),
    team("c", 2),
  ];
  const starts = [{ round: 1, blockId: "fri", slot: 2 }];
  // Thursday is over; Friday has not started.
  const placed = schedule(blocks, queue, at(FRI, "07:00"), starts);
  assert.equal(
    where(placed, "early"),
    `${FRI} 10:55`,
    "the pin ignores the start",
  );
  assert.equal(placed.get("missed").pinMissed, true);
  assert.equal(where(placed, "missed"), `${FRI} 11:22`);
  assert.equal(where(placed, "c"), `${FRI} 11:48`);
});

test("a start on a struck slot still marks the point; a dangling start is from now", () => {
  const blocks = [block("fri", FRI, 3, { skippedSlots: [2] })];
  const queue = [team("a", 0)];
  assert.equal(
    where(
      schedule(blocks, queue, BEFORE, [{ round: 1, blockId: "fri", slot: 2 }]),
      "a",
    ),
    `${FRI} 11:48`,
  );
  assert.equal(
    where(
      schedule(blocks, queue, BEFORE, [{ round: 1, blockId: "gone", slot: 1 }]),
      "a",
    ),
    `${FRI} 10:55`,
  );
});

test("the body checker takes struck slots and starts", () => {
  const id = "5f8e1c9a-2b3d-4e5f-8a9b-0c1d2e3f4a5b";
  const ok = checkSchedule({
    base: null,
    blocks: [{ id, round: 1, date: FRI, block: 3, skippedSlots: [3, 1] }],
    presentations: [],
    queueStarts: [{ round: 1, blockId: id.toUpperCase(), slot: 2 }],
  });
  assert.deepEqual(ok.blocks[0].skippedSlots, [1, 3]);
  assert.deepEqual(ok.queueStarts, [{ round: 1, blockId: id, slot: 2 }]);
  assert.deepEqual(
    checkSchedule({ base: null, blocks: [], presentations: [] }).queueStarts,
    [],
    "absent is from now",
  );
  assert.throws(
    () =>
      checkSchedule({
        base: null,
        blocks: [{ id, round: 1, date: FRI, block: 3, skippedSlots: ["2"] }],
        presentations: [],
      }),
    { code: "invalid_body" },
  );
});
