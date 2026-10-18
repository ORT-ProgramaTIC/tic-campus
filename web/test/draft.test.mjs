import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addBlock,
  expandSlots,
  pin,
  removeBlock,
  setQueueStart,
  setSlotCount,
  setSlotStart,
  timesProblem,
  toggleSkip,
} from "../src/draft.ts";

const bell = { 3: { start: "10:55", end: "12:15" } };
const fresh = () =>
  setQueueStart(
    pin(
      pin(
        {
          ...addBlock(
            { blocks: [], queue: [], queueStarts: [] },
            { id: "b", round: 1, date: "2026-10-23", block: 3 },
          ),
          queue: [
            { projectId: 1, round: 1, pin: null },
            { projectId: 2, round: 1, pin: null },
          ],
        },
        1,
        1,
        { blockId: "b", slot: 3 },
      ),
      2,
      1,
      { blockId: "b", slot: 1 },
    ),
    1,
    { blockId: "b", slot: 2 },
  );

test("slots split like the api's, an override moving the slot before it", () => {
  // The harness's numbers for the same block.
  const block = setSlotStart(fresh(), "b", 2, "11:40").blocks[0];
  assert.deepEqual(
    expandSlots(block, bell).map((slot) => [slot.start, slot.end]),
    [
      ["10:55", "11:40"],
      ["11:40", "11:48"],
      ["11:48", "12:15"],
    ],
  );
  assert.equal(timesProblem(block, bell), null);
  const jumped = setSlotStart(fresh(), "b", 2, "11:50").blocks[0];
  assert.match(timesProblem(jumped, bell), /en orden/);
  assert.equal(
    setSlotStart(setSlotStart(fresh(), "b", 2, "11:40"), "b", 2, null).blocks[0]
      .slotStarts,
    null,
    "all back to auto is null, not [null, null, null]",
  );
});

test("a new count resets overrides and strikes, and drops what is past it", () => {
  let draft = toggleSkip(setSlotStart(fresh(), "b", 1, "11:00"), "b", 2);
  draft = setSlotCount(draft, "b", 2);
  assert.deepEqual(
    [draft.blocks[0].slotStarts, draft.blocks[0].skippedSlots],
    [null, []],
  );
  assert.deepEqual(
    draft.queue.map((entry) => entry.pin?.slot ?? null),
    [null, 1],
    "the pin on slot 3 went, the one on slot 1 stayed",
  );
  assert.deepEqual(draft.queueStarts, [{ round: 1, blockId: "b", slot: 2 }]);
  assert.deepEqual(setSlotCount(draft, "b", 1).queueStarts, []);
});

test("striking a slot unpins it; a pin takes a slot from whoever held it", () => {
  assert.equal(toggleSkip(fresh(), "b", 3).queue[0].pin, null);
  assert.deepEqual(
    toggleSkip(toggleSkip(fresh(), "b", 3), "b", 3).blocks[0].skippedSlots,
    [],
  );
  const stolen = pin(fresh(), 1, 1, { blockId: "b", slot: 1 });
  assert.deepEqual(
    stolen.queue.map((entry) => entry.pin?.slot ?? null),
    [1, null],
  );
});

test("removing a block takes its pins and its start with it", () => {
  const draft = removeBlock(fresh(), "b");
  assert.deepEqual(
    [draft.blocks, draft.queue.map((entry) => entry.pin), draft.queueStarts],
    [[], [null, null], []],
  );
});
