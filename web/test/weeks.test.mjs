import assert from "node:assert/strict";
import { test } from "node:test";
import { mondayOf, openingWeek, weeksOf } from "../src/weeks.ts";

const block = (date, end = "12:15") => ({ date, slots: [{ date, end }] });

test("a week starts on Monday, across a month and a year", () => {
  assert.equal(mondayOf("2026-10-23"), "2026-10-19"); // Friday
  assert.equal(mondayOf("2026-10-19"), "2026-10-19"); // Monday itself
  assert.equal(mondayOf("2026-10-25"), "2026-10-19"); // Sunday
  assert.equal(mondayOf("2026-10-01"), "2026-09-28");
  assert.equal(mondayOf("2027-01-01"), "2026-12-28");
});

test("weeks are the distinct Mondays, in order", () => {
  assert.deepEqual(
    weeksOf([block("2026-11-06"), block("2026-10-23"), block("2026-10-22")]),
    ["2026-10-19", "2026-11-02"],
  );
});

test("it opens on the first week still to come, else the last", () => {
  const blocks = [
    block("2026-10-16"),
    block("2026-10-23"),
    block("2026-10-30"),
  ];
  // Friday 23 at noon Buenos Aires: block 3 ends 12:15, so that week is still on.
  assert.equal(
    openingWeek(blocks, new Date("2026-10-23T12:00:00-03:00")),
    "2026-10-19",
  );
  // Ten minutes later it has ended; the next week is the one to come.
  assert.equal(
    openingWeek(blocks, new Date("2026-10-23T12:20:00-03:00")),
    "2026-10-26",
  );
  assert.equal(
    openingWeek(blocks, new Date("2026-12-01T00:00:00-03:00")),
    "2026-10-26",
  );
  assert.equal(openingWeek([], new Date()), undefined);
});
