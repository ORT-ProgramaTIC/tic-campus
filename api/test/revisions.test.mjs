import assert from "node:assert/strict";
import test from "node:test";
import { checkAnswer, checkRequest } from "../dist/offerings/revisions.js";

// F29's body checkers on their own. The table, the grant, the partial index and
// the four trust boundaries in `fileRequests` are in `db.test.mjs` and in
// `scripts/harness-revisions.mjs`; what is a decision rather than a query is
// here.
//
// This matters more than usual: it is the first body a **student** sends, so
// the checker is the whole of what stands between a student's keyboard and a
// row. A test that called `fileRequests` with a bad value would not see a 400 —
// there is nothing there to throw one.

const ACTIVITY = "11111111-2222-3333-4444-555555555555";

test("a request is an activity, the people it is about, and a reason", () => {
  assert.deepEqual(
    checkRequest({
      activityId: ACTIVITY,
      studentIds: [7],
      reason: "Entregué la segunda parte y no está contada.",
    }),
    {
      activityId: ACTIVITY,
      studentIds: [7],
      reason: "Entregué la segunda parte y no está contada.",
      bonusTasks: null,
    },
  );
});

test("bonus tasks are optional and survive", () => {
  // Kept from the old model: the extra work a student offers in exchange.
  const input = checkRequest({
    activityId: ACTIVITY,
    studentIds: [7],
    reason: "Para mejorar nota.",
    bonusTasks: "Hice los ejercicios 4 a 9 de la guía.",
  });
  assert.equal(input.bonusTasks, "Hice los ejercicios 4 a 9 de la guía.");
});

test("a group files together", () => {
  // The old dialog let you name the partners you worked with, and that survives
  // (F29, re-opened in slice 11). Who may actually be named is `fileRequests`'
  // question, against the enrolled roster — this only says the shape is a list.
  const input = checkRequest({
    activityId: ACTIVITY,
    studentIds: [7, 9, 11],
    reason: "Lo hicimos entre los tres.",
  });
  assert.deepEqual(input.studentIds, [7, 9, 11]);
});

test("a reason is required, and blank is not a reason", () => {
  // Unlike every other text field here. `reason` is NOT NULL and it is the
  // whole point of the request: a request with nothing in it is one a teacher
  // cannot answer.
  assert.throws(
    () => checkRequest({ activityId: ACTIVITY, studentIds: [7] }),
    /motivo/i,
  );
  assert.throws(
    () =>
      checkRequest({ activityId: ACTIVITY, studentIds: [7], reason: "   " }),
    /motivo/i,
  );
});

test("a reason is trimmed", () => {
  const input = checkRequest({
    activityId: ACTIVITY,
    studentIds: [7],
    reason: "  Estaba sin hacer.  ",
  });
  assert.equal(input.reason, "Estaba sin hacer.");
});

test("nobody named is refused, and so is a crowd", () => {
  assert.throws(
    () => checkRequest({ activityId: ACTIVITY, studentIds: [], reason: "x" }),
    /alguien/i,
  );
  assert.throws(
    () =>
      checkRequest({
        activityId: ACTIVITY,
        studentIds: Array.from({ length: 101 }, (_, at) => at + 1),
        reason: "x",
      }),
    /demasiados/i,
  );
});

test("ids that are not ids do not reach a query", () => {
  assert.throws(
    () => checkRequest({ activityId: "tp-sql", studentIds: [7], reason: "x" }),
    /actividad/i,
  );
  assert.throws(
    () => checkRequest({ activityId: ACTIVITY, studentIds: [0], reason: "x" }),
    /id/i,
  );
  assert.throws(
    () =>
      checkRequest({ activityId: ACTIVITY, studentIds: ["7"], reason: "x" }),
    /id/i,
  );
});

test("the texts are capped at the house 2000", () => {
  const long = "a".repeat(2001);
  assert.throws(
    () => checkRequest({ activityId: ACTIVITY, studentIds: [7], reason: long }),
    /2000/,
  );
  assert.throws(
    () =>
      checkRequest({
        activityId: ACTIVITY,
        studentIds: [7],
        reason: "x",
        bonusTasks: long,
      }),
    /2000/,
  );
});

test("an answer is text, and an empty one is not an answer", () => {
  assert.equal(
    checkAnswer({ answer: "  Tenías razón, va 7.  " }),
    "Tenías razón, va 7.",
  );
  assert.throws(() => checkAnswer({ answer: "" }), /respuesta/i);
  assert.throws(() => checkAnswer({}), /respuesta/i);
  assert.throws(() => checkAnswer({ answer: 7 }), /respuesta/i);
});

test("a body that is not an object is refused before anything else", () => {
  for (const raw of [null, "tp-sql", 7, undefined]) {
    assert.throws(() => checkRequest(raw), /objeto/i);
    assert.throws(() => checkAnswer(raw), /objeto/i);
  }
});
