import assert from "node:assert/strict";
import test from "node:test";
import { checkGrades } from "../dist/offerings/official-grades.js";

// F22's body checker on its own. The table, the grant and the history are in
// `db.test.mjs`; what is a decision rather than a query is here.

const TERM = "11111111-2222-3333-4444-555555555555";
const one = (entry) => checkGrades({ entries: [entry] })[0];

test("a grade is a student, a term and a number", () => {
  assert.deepEqual(one({ studentId: 7, termId: TERM, value: 8.5 }), {
    studentId: 7,
    termId: TERM,
    clear: false,
    value: 8.5,
    observation: null,
    suggestion: null,
  });
});

test("the two texts ride with it", () => {
  const entry = one({
    studentId: 7,
    termId: TERM,
    value: 4,
    observation: "Faltó a tres clases.",
    suggestion: "Repasar consultas anidadas.",
  });
  assert.equal(entry.observation, "Faltó a tres clases.");
  assert.equal(entry.suggestion, "Repasar consultas anidadas.");
});

test("`value: null` is the one way to empty a cell", () => {
  // And it takes the texts with it — an observation cannot outlive its grade,
  // because the row is the observation's only home.
  const entry = one({
    studentId: 7,
    termId: TERM,
    value: null,
    observation: "x",
  });
  assert.equal(entry.clear, true);
  assert.equal(entry.value, undefined);
});

test("an entry with no `value` at all is refused", () => {
  // Not read as a clear and not as a no-op: a body carrying only text would
  // otherwise either lose a grade or silently do nothing, and a 400 beats both.
  assert.throws(
    () => one({ studentId: 7, termId: TERM, observation: "Muy bien." }),
    /value/,
  );
});

test("the grade is `checkMark`'s and not a second rule", () => {
  // The same 1–10, two decimals the gradebook already enforces (F22 reuses it
  // rather than restating it, so the two cannot drift).
  assert.throws(() => one({ studentId: 7, termId: TERM, value: 0 }), /1 a 10/);
  assert.throws(() => one({ studentId: 7, termId: TERM, value: 11 }), /1 a 10/);
  assert.throws(
    () => one({ studentId: 7, termId: TERM, value: 8.555 }),
    /decimales/,
  );
  assert.equal(one({ studentId: 7, termId: TERM, value: 10 }).value, 10);
});

test("ids that are not ids do not reach a query", () => {
  assert.throws(() => one({ studentId: 0, termId: TERM, value: 8 }), /id/);
  assert.throws(
    () => one({ studentId: 7, termId: "primer-trimestre", value: 8 }),
    /trimestre/,
  );
});

test("the texts are capped", () => {
  assert.throws(
    () =>
      one({
        studentId: 7,
        termId: TERM,
        value: 8,
        suggestion: "x".repeat(2001),
      }),
    /2000/,
  );
});

test("the envelope is a list, and a bounded one", () => {
  assert.deepEqual(checkGrades({ entries: [] }), []);
  assert.throws(() => checkGrades({ entries: {} }), /lista/);
  assert.throws(() => checkGrades(null), /objeto/);
  assert.throws(
    () =>
      checkGrades({
        entries: Array.from({ length: 5001 }, () => ({
          studentId: 7,
          termId: TERM,
          value: 8,
        })),
      }),
    /demasiadas/,
  );
});

test("a cell sent twice is read once, and the last one wins", () => {
  // `checkEntries`' guard (F41, slice 17): with a plain insert, two rows for
  // one cell would share one `now()`, a tie nothing decides.
  const other = "22222222-3333-4444-5555-666666666666";
  const got = checkGrades({
    entries: [
      { studentId: 7, termId: TERM, value: 4 },
      { studentId: 8, termId: TERM, value: 5 },
      { studentId: 7, termId: other, value: 6 },
      { studentId: 7, termId: TERM, value: 7, observation: "revisada" },
    ],
  });
  assert.deepEqual(
    got.map((e) => [e.studentId, e.termId, e.value, e.observation]),
    [
      [7, TERM, 7, "revisada"],
      [8, TERM, 5, null],
      [7, other, 6, null],
    ],
  );
});
