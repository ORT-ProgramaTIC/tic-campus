// A redo is an activity that covers N others, and its result replaces theirs
// (F23). This file is the resolution step in front of the evaluator: what
// counts, given what was recorded. The formula language is `formula.test.mjs`,
// the rest of the step between rows and a number is `marks.test.mjs`, and the
// queries and the refusals are `db.test.mjs`.
//
// The bugs this file exists to prevent, in the order they would hurt:
//   - an unmarked recuperatorio blanking or zeroing the TP it covers;
//   - the recuperatorio counting as a fourth TP on top of replacing one;
//   - an unpublished recuperatorio reaching the student's own number.
import assert from "node:assert/strict";
import test from "node:test";
import {
  computeBothViews,
  computeMarks,
  resolveRedos,
} from "../dist/offerings/marks.js";

const PUBLISHED = new Date("2027-04-01T00:00:00Z");
const NOW = new Date("2027-06-01T00:00:00Z");

function activity(id, valueType, covers, resultsPublishedAt = PUBLISHED) {
  return {
    id,
    articleId: `article-${id}`,
    slug: id,
    title: id,
    groupId: "g-tps",
    termId: "t1",
    valueType,
    scaleId: null,
    dueAt: null,
    resultsPublishedAt,
    position: 0,
    covers,
  };
}

const setup = (redoPolicy) => ({
  groups: [{ id: "g-tps", name: "tps" }],
  terms: [{ id: "t1", name: "1er", formula: "avg(tps)" }],
  finalFormula: null,
  redoPolicy,
});

const TP1 = activity("tp1", "numeric", []);
const TP2 = activity("tp2", "numeric", []);
const REDO = activity("redo", "numeric", ["tp2"]);

/** What counts, for the one student, as a plain object. */
const counted = (recorded, activities, policy) =>
  Object.fromEntries(
    resolveRedos(new Map(Object.entries(recorded)), activities, policy),
  );

const mark = (activityId, value) => ({ activityId, studentId: 1, value });

const term = (setupOf, activities, results) =>
  computeMarks(setupOf, activities, results, [1]).get(1).terms.t1;

/* ── The policies ────────────────────────────────────────────────────────── */

test("max is the default policy, and a redo can only help under it", () => {
  const up = counted({ tp2: 4, redo: 8 }, [TP1, TP2, REDO], "max");
  assert.equal(up.tp2, 8, "8 sobre 4 sube");
  const down = counted({ tp2: 8, redo: 4 }, [TP1, TP2, REDO], "max");
  assert.equal(down.tp2, 8, "4 sobre 8 NO baja — ésa es la diferencia");
});

test("replace is the other behaviour, and it does lower a mark", () => {
  // The test that names what `max` refuses to do: same rows, one word of
  // policy, and the 8 becomes a 4. A teacher who wants this says so per
  // offering — see the note on `offering_home.redo_policy`.
  const down = counted({ tp2: 8, redo: 4 }, [TP1, TP2, REDO], "replace");
  assert.equal(down.tp2, 4);
});

test("average is the mean of the two, rounded the way the evaluator rounds", () => {
  assert.equal(
    counted({ tp2: 4, redo: 8 }, [TP1, TP2, REDO], "average").tp2,
    6,
  );
  // 4.1 and 8 is 6.050000000000001 in binary floating point, and a teacher's
  // `if(x >= 6.05, ...)` would miss it. Same ten decimals as `num()`.
  assert.equal(
    counted({ tp2: 4.1, redo: 8 }, [TP1, TP2, REDO], "average").tp2,
    6.05,
  );
});

/* ── Blanks, both ways (F20's question, asked of a redo) ─────────────────── */

test("an unmarked redo leaves the original standing", () => {
  // The blank rule (F38): an absent row is a recuperatorio that has not
  // happened. Not a zero, and not a reason to blank the TP.
  for (const policy of ["replace", "max", "average"]) {
    const out = counted({ tp2: 4 }, [TP1, TP2, REDO], policy);
    assert.equal(out.tp2, 4, policy);
    assert.equal("redo" in out, false, "y el recuperatorio no aparece solo");
  }
});

test("a redo over a blank original replaces it, in every policy", () => {
  // The other half, and the one a recuperatorio exists for: the student who
  // missed the TP is exactly who sits it. Only present values participate, so
  // the three policies cannot disagree here.
  for (const policy of ["replace", "max", "average"]) {
    assert.equal(counted({ redo: 8 }, [TP1, TP2, REDO], policy).tp2, 8, policy);
  }
});

test("neither a redo nor its original is invented out of nothing", () => {
  assert.deepEqual(counted({}, [TP1, TP2, REDO], "max"), {});
});

/* ── A redo is not a fourth TP ───────────────────────────────────────────── */

test("a redo never counts on its own, group or no group", () => {
  // The whole of what `covers.length > 0` buys in the bucket loop. Recorded: a
  // 4 on TP2 lifted to an 8, and a 10 on TP1 — the mean is 9, not the 8.67 a
  // third number would produce.
  const results = [mark("tp1", 10), mark("tp2", 4), mark("redo", 8)];
  assert.deepEqual(term(setup("max"), [TP1, TP2, REDO], results), { value: 9 });
  // And it is the coverage that excludes it, not the group: the same rows with
  // the redo filed nowhere give the same mark.
  assert.deepEqual(
    term(setup("max"), [TP1, TP2, { ...REDO, groupId: null }], results),
    { value: 9 },
  );
});

test("a done redo marks the activity it covers as done, and adds no denominator", () => {
  const done = (id, covers) => activity(id, "done", covers);
  const ratio = {
    ...setup("max"),
    terms: [{ id: "t1", name: "1er", formula: "done_ratio(tps)" }],
  };
  const activities = [done("c1", []), done("c2", []), done("redo", ["c2"])];
  // One of two done, the second one only through the redo — 2/2 and not 2/3.
  assert.deepEqual(
    term(ratio, activities, [mark("c1", 1), mark("redo", 1)]),
    { value: 1 },
    "el recuperatorio no es una tercera clase",
  );
});

/* ── Publishing, without a fourth meaning for resultsVisible ─────────────── */

test("an unpublished redo reaches the teacher's number and not the student's", () => {
  const hidden = { ...REDO, resultsPublishedAt: null };
  const [both] = computeBothViews(
    setup("max"),
    [TP1, TP2, hidden],
    [mark("tp1", 10), mark("tp2", 4), mark("redo", 8)],
    [1],
    NOW,
  );
  assert.deepEqual(both.terms.t1.all, { value: 9 }, "el docente ya lo ve");
  assert.deepEqual(
    both.terms.t1.published,
    { value: 7 },
    "el estudiante todavía ve el 4",
  );
});

test("a published redo over an unpublished original moves neither number's list", () => {
  // The covered TP is not in the student's list at all, so there is nothing to
  // replace and nothing leaks by arithmetic — the rule is the list, as it has
  // been since F24.
  const [both] = computeBothViews(
    setup("max"),
    [TP1, { ...TP2, resultsPublishedAt: null }, REDO],
    [mark("tp1", 10), mark("tp2", 4), mark("redo", 8)],
    [1],
    NOW,
  );
  assert.deepEqual(both.terms.t1.all, { value: 9 });
  assert.deepEqual(both.terms.t1.published, { value: 10 }, "solo el TP1");
});

/* ── More than one redo over the same TP ─────────────────────────────────── */

test("two redos over one activity fold in position order", () => {
  const first = { ...activity("r1", "numeric", ["tp2"]), position: 1 };
  const second = { ...activity("r2", "numeric", ["tp2"]), position: 2 };
  // `replace` is where the order is observable at all; under `max` it cannot be.
  assert.equal(
    counted({ tp2: 4, r1: 6, r2: 9 }, [TP2, first, second], "replace").tp2,
    9,
    "gana el último de la lista, que viene ordenada por position",
  );
});
