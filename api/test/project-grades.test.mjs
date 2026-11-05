import assert from "node:assert/strict";
import test from "node:test";
import { checkProjectGrades } from "../dist/offerings/project-grades.js";

// F46's body checker. The table, the roster and the visibility rule are in
// `db.test.mjs`.

const one = (entry) => checkProjectGrades({ entries: [entry] })[0];

test("a grade is a student, a value and a visibility", () => {
  assert.deepEqual(one({ studentId: 7, value: "8", visible: false }), {
    studentId: 7,
    clear: false,
    value: "8",
    visible: false,
  });
  assert.equal(one({ studentId: 7, value: "pia", visible: true }).value, "pia");
  assert.equal(
    one({ studentId: 7, value: "diciembre", visible: false }).value,
    "diciembre",
  );
});

test("`value: null` clears, and needs no visibility", () => {
  assert.deepEqual(one({ studentId: 7, value: null }), {
    studentId: 7,
    clear: true,
  });
});

test("only the seven values are grades", () => {
  for (const value of ["5", "11", 8, "PIA", "", "aprobado"]) {
    assert.throws(
      () => one({ studentId: 7, value, visible: false }),
      /La nota es una de/,
      String(value),
    );
  }
});

test("an entry without `value` or `visible` is refused", () => {
  assert.throws(() => one({ studentId: 7, visible: true }), /value/);
  assert.throws(() => one({ studentId: 7, value: "9" }), /visible/);
});

test("a bad student id or body is refused", () => {
  assert.throws(() => one({ studentId: 0, value: "9", visible: true }), /id/);
  assert.throws(() => one({ value: "9", visible: true }), /id/);
  assert.throws(() => checkProjectGrades(null), /lista/);
  assert.throws(() => checkProjectGrades({ entries: "x" }), /lista/);
});

test("one entry per student, the last winning", () => {
  const entries = checkProjectGrades({
    entries: [
      { studentId: 7, value: "9", visible: false },
      { studentId: 8, value: "6", visible: false },
      { studentId: 7, value: "10", visible: true },
    ],
  });
  assert.deepEqual(
    entries.map((entry) => [entry.studentId, entry.value, entry.visible]),
    [
      [7, "10", true],
      [8, "6", false],
    ],
  );
});
