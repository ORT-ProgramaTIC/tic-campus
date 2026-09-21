import assert from "node:assert/strict";
import test from "node:test";
import { checkMark, checkSetup } from "../dist/offerings/gradebook.js";
import { checkEntries, resultsVisible } from "../dist/offerings/results.js";

// F24's visibility rule and the two body checkers, on their own — the halves
// that are decisions rather than joins. The queries around them, and every
// grant, are in `db.test.mjs`.

const ANON = { editLibrary: false, manageOffering: false, seeOwnMarks: false };
const STUDENT = { ...ANON, seeOwnMarks: true };
const TEACHER = { ...ANON, manageOffering: true };
const LIBRARIAN = { ...ANON, editLibrary: true };

const PUBLISHED = new Date("2020-01-01T00:00:00Z");
const LATER = new Date("2999-01-01T00:00:00Z");

/* ── resultsVisible (F24) ─────────────────────────────────────────────────── */

test("marks nobody published are the teacher's alone", () => {
  const unpublished = { resultsPublishedAt: null };
  assert.equal(resultsVisible(unpublished, TEACHER), true);
  assert.equal(
    resultsVisible(unpublished, STUDENT),
    false,
    "not even the class",
  );
  assert.equal(resultsVisible(unpublished, ANON), false);
});

test("a publish date in the future has not arrived", () => {
  assert.equal(resultsVisible({ resultsPublishedAt: LATER }, STUDENT), false);
  assert.equal(resultsVisible({ resultsPublishedAt: LATER }, TEACHER), true);
});

test("the class reads its marks once the date is past", () => {
  const published = { resultsPublishedAt: PUBLISHED };
  assert.equal(resultsVisible(published, STUDENT), true);
  assert.equal(
    resultsVisible(published, ANON),
    false,
    "published is not public: marks still need enrolment",
  );
});

test("editLibrary is not a key to somebody else's gradebook", () => {
  // The difference from `mayRead`, and the reason this is its own function:
  // teaching ANY offering of the subject earns the library (F5, F8), and a
  // teacher of last year's offering has no business reading this class's marks.
  const published = { resultsPublishedAt: PUBLISHED };
  assert.equal(resultsVisible(published, LIBRARIAN), false);
  assert.equal(resultsVisible({ resultsPublishedAt: null }, LIBRARIAN), false);
});

test("`now` is injectable, so the boundary is testable at all", () => {
  const use = { resultsPublishedAt: new Date("2026-03-01T12:00:00Z") };
  const before = new Date("2026-03-01T11:59:59Z");
  const after = new Date("2026-03-01T12:00:01Z");
  assert.equal(resultsVisible(use, STUDENT, before), false);
  assert.equal(resultsVisible(use, STUDENT, after), true);
});

/* ── checkEntries: which key is present is what an entry says ─────────────── */

const CELL = {
  studentId: 7,
  activityId: "11111111-2222-3333-4444-555555555555",
};

function entries(...list) {
  return checkEntries({ entries: list });
}

test("`value: null` is the only way to empty a cell", () => {
  const [entry] = entries({ ...CELL, value: null });
  assert.equal(entry.clear, true);
});

test("a zero is a mark and not an empty cell", () => {
  // The bug this exists to prevent: `!entry.value` reads 0 as "nothing here"
  // and silently deletes a mark a teacher meant to give.
  const [entry] = entries({ ...CELL, value: 1 });
  assert.equal(entry.clear, false);
  assert.equal(entry.value, 1);
});

test("`done: false` is not done, which is not the same as unmarked", () => {
  const [entry] = entries({ ...CELL, done: false });
  assert.equal(entry.clear, false, "false is a value, not an absence");
  assert.equal(entry.done, false);
});

test("an entry that says nothing is refused, not read as a delete", () => {
  // Feedback with no mark: the teacher meant to save a comment, and the
  // dangerous reading of it is "clear this cell".
  assert.throws(
    () => entries({ ...CELL, feedback: "ojo con el JOIN" }),
    (cause) => cause.status === 400 && cause.code === "invalid_body",
  );
});

test("a scale entry names a level and nothing else", () => {
  const [entry] = entries({
    ...CELL,
    scaleLevelId: "99999999-8888-7777-6666-555555555555",
  });
  assert.equal(entry.clear, false);
  assert.equal(entry.scaleLevelId, "99999999-8888-7777-6666-555555555555");
});

test("a cell sent twice is read once, and the last one wins", () => {
  // What the upsert did, and what Postgres enforced by refusing the batch.
  // With a plain insert, two rows for one cell share one `now()`: a tie.
  const got = entries(
    { ...CELL, value: 4 },
    { ...CELL, value: null },
    { ...CELL, value: 7, feedback: "revisada" },
  );
  assert.equal(got.length, 1);
  assert.equal(got[0].clear, false);
  assert.equal(got[0].value, 7);
  assert.equal(got[0].feedback, "revisada");
});

test("different cells are not deduped into each other", () => {
  const other = "22222222-3333-4444-5555-666666666666";
  const got = entries(
    { ...CELL, value: 4 },
    { ...CELL, studentId: 8, value: 5 },
    { ...CELL, activityId: other, value: 6 },
  );
  assert.deepEqual(
    got.map((e) => [e.studentId, e.activityId, e.value]),
    [
      [7, CELL.activityId, 4],
      [8, CELL.activityId, 5],
      [7, other, 6],
    ],
  );
});

test("the batch is capped short of pg's bind-parameter ceiling", () => {
  // One student each: the same cell 5000 times is one entry once it is read.
  const cells = (n) =>
    Array.from({ length: n }, (_, i) => ({
      ...CELL,
      studentId: i + 1,
      value: 8,
    }));
  assert.equal(entries(...cells(5000)).length, 5000);
  assert.throws(
    () => entries(...cells(5001)),
    (cause) => cause.status === 400,
  );
});

test("a body that is not a list of entries is refused", () => {
  assert.throws(
    () => checkEntries({}),
    (cause) => cause.status === 400,
  );
  assert.throws(
    () => checkEntries(null),
    (cause) => cause.status === 400,
  );
  assert.throws(
    () => entries({ activityId: CELL.activityId, value: 8 }),
    (cause) => cause.status === 400,
    "no student",
  );
  assert.throws(
    () => entries({ ...CELL, value: 8, feedback: "x".repeat(2001) }),
    (cause) => cause.status === 400,
    "feedback has a bound",
  );
});

/* ── checkMark: 1 to 10, two decimals (F19) ──────────────────────────────── */

test("a mark is 1 to 10 with up to two decimals", () => {
  assert.equal(checkMark(1), 1);
  assert.equal(checkMark(10), 10);
  assert.equal(checkMark(7.25), 7.25);
  for (const bad of [0, 0.9, 10.1, 11, "8", null, NaN, Infinity]) {
    assert.throws(
      () => checkMark(bad),
      (cause) => cause.status === 400,
      `${bad}`,
    );
  }
});

test("a third decimal is refused rather than rounded", () => {
  // `numeric(4, 2)` would take 7.005 and store 7.01 without saying so, which is
  // the kind of thing that becomes an argument about a boletín.
  assert.throws(
    () => checkMark(7.005),
    (cause) => cause.status === 400,
  );
});

/* ── checkSetup ──────────────────────────────────────────────────────────── */

test("a setup is three lists, and a scale has at least one level", () => {
  const setup = checkSetup({
    groups: [{ name: " tps " }],
    terms: [{ name: "Primer trimestre" }],
    scales: [{ name: "B / MB / E", levels: [{ name: "B", value: 7 }] }],
  });
  assert.equal(setup.groups[0].name, "tps", "trimmed");
  assert.equal(setup.scales[0].levels[0].value, 7);
  assert.equal("id" in setup.groups[0], false, "a new row carries no id");
});

test("a setup refuses what would not round-trip", () => {
  const ok = { groups: [], terms: [], scales: [] };
  assert.throws(
    () => checkSetup(null),
    (cause) => cause.status === 400,
  );
  assert.throws(
    () => checkSetup({ ...ok, groups: {} }),
    (cause) => cause.status === 400,
    "not a list",
  );
  assert.throws(
    () => checkSetup({ ...ok, groups: [{ name: "  " }] }),
    (cause) => cause.status === 400,
    "a name that is only spaces is no name",
  );
  assert.throws(
    () => checkSetup({ ...ok, groups: [{ id: "nope", name: "tps" }] }),
    (cause) => cause.status === 400,
    "an id that is not a uuid",
  );
  assert.throws(
    () => checkSetup({ ...ok, scales: [{ name: "vacía", levels: [] }] }),
    (cause) => cause.status === 400,
    "a scale with no levels has nothing to pick",
  );
  assert.throws(
    () =>
      checkSetup({ ...ok, scales: [{ name: "s", levels: [{ name: "B" }] }] }),
    (cause) => cause.status === 400,
    "a level with no number is not aggregatable (F38)",
  );
});

test("the redo policy is one of three words, or absent", () => {
  const ok = { groups: [], terms: [], scales: [] };
  // Absent stays absent, the rule the formulas already follow: a panel that
  // does not know about redos must not reset the policy (F23).
  assert.equal("redoPolicy" in checkSetup(ok), false);
  assert.equal(
    checkSetup({ ...ok, redoPolicy: "average" }).redoPolicy,
    "average",
  );
  for (const bad of ["lo que sea", "REPLACE", null, 1]) {
    assert.throws(
      () => checkSetup({ ...ok, redoPolicy: bad }),
      (cause) => cause.status === 400,
      String(bad),
    );
  }
});
