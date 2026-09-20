// The step between rows and a number (F20, F21, F24): which activities and
// which results feed the formula, and the two views the grid shows side by
// side. The language itself is `formula.test.mjs`; the queries that load these
// rows are `db.test.mjs`.
//
// The bug this file exists to prevent: the student's number and the teacher's
// number quietly becoming the same number, which means either a leak or a
// wrong mark on somebody's page.
import assert from "node:assert/strict";
import test from "node:test";
import {
  computeBothViews,
  computeMarks,
  publishedOnly,
} from "../dist/offerings/marks.js";

const PUBLISHED = new Date("2027-04-01T00:00:00Z");
const NOW = new Date("2027-06-01T00:00:00Z");
const LATER = new Date("2027-11-01T00:00:00Z");

/** An activity is a use with a `value_type` (F18); the rest of `Activity` is
 *  what the grid draws and what no formula can reach. */
function activity(id, termId, groupId, valueType, resultsPublishedAt) {
  return {
    id,
    articleId: `article-${id}`,
    slug: id,
    title: id,
    groupId,
    termId,
    valueType,
    scaleId: null,
    dueAt: null,
    resultsPublishedAt,
    position: 0,
  };
}

const mark = (activityId, studentId, value) => ({
  activityId,
  studentId,
  value,
});

const SETUP = {
  groups: [
    { id: "g-tps", name: "tps" },
    { id: "g-clase", name: "clase" },
  ],
  terms: [
    {
      id: "t1",
      name: "1er",
      formula: "0.7*avg(tps) + 0.3*10*done_ratio(clase)",
    },
    { id: "t2", name: "2do", formula: "avg(tps)" },
  ],
  finalFormula: 'avg("1er", "2do")',
};

// Two TPs and two class activities in the first term, one TP in the second.
// `tp2` and `clase2` are marked but NOT published, which is the whole point.
const ACTIVITIES = [
  activity("tp1", "t1", "g-tps", "numeric", PUBLISHED),
  activity("tp2", "t1", "g-tps", "numeric", null),
  activity("clase1", "t1", "g-clase", "done", PUBLISHED),
  activity("clase2", "t1", "g-clase", "done", null),
  activity("tp3", "t2", "g-tps", "numeric", PUBLISHED),
  // Filed under no group: an activity the formula ignores (F18).
  activity("suelta", "t1", null, "numeric", PUBLISHED),
];

const RESULTS = [
  mark("tp1", 1, 6),
  mark("tp2", 1, 10),
  mark("clase1", 1, 1),
  mark("clase2", 1, 1),
  mark("tp3", 1, 8),
  mark("suelta", 1, 1),
];

function near(got, expected, message) {
  assert.ok(
    typeof got.value === "number" && Math.abs(got.value - expected) < 1e-9,
    `${message ?? ""} — esperábamos ${expected}, vino ${JSON.stringify(got)}`,
  );
}

/* ── What the teacher sees ───────────────────────────────────────────────── */

test("a term's formula runs over that term's activities only", () => {
  // The bug this prevents: pooling every group's activities across terms, so
  // the first trimester quietly includes the second's TPs.
  const marks = computeMarks(SETUP, ACTIVITIES, RESULTS, [1]).get(1);
  // avg(tps) in t1 is (6+10)/2 = 8, done_ratio(clase) is 2/2 = 1.
  near(marks.terms.t1, 0.7 * 8 + 3, "el primero no ve tp3");
  near(marks.terms.t2, 8, "el segundo no ve tp1 ni tp2");
});

test("an activity in no group is one the formula ignores", () => {
  // `suelta` carries a 1. If it leaked into `tps` the first term would drop.
  const marks = computeMarks(SETUP, ACTIVITIES, RESULTS, [1]).get(1);
  near(marks.terms.t1, 8.6);
});

test("the final is a second formula over the term results", () => {
  const marks = computeMarks(SETUP, ACTIVITIES, RESULTS, [1]).get(1);
  near(marks.final, (8.6 + 8) / 2);
});

test("a term with no formula computes nothing, which is not sin nota", () => {
  // Absent rather than `{value: null}`: there is nothing to show, which reads
  // differently from "hay fórmula y todavía no hay nota".
  const noFormula = {
    groups: SETUP.groups,
    terms: [{ id: "t1", name: "1er", formula: null }],
    finalFormula: null,
  };
  const marks = computeMarks(noFormula, ACTIVITIES, RESULTS, [1]).get(1);
  assert.deepEqual(marks.terms, {});
  assert.equal(marks.final, null, "sin final_formula no hay final");
});

test("a term with no formula is still a name the final can spell", () => {
  // The bug this prevents, and it was found by running it: skipping the term
  // left its name out of the final's scope, so a teacher who wrote the final
  // before the third trimester's formula got «3ro» ya no existe instead of a
  // mark over the two terms that are ready.
  const half = {
    ...SETUP,
    terms: [
      { id: "t1", name: "1er", formula: "avg(tps)" },
      { id: "t2", name: "2do", formula: null },
    ],
  };
  const marks = computeMarks(half, ACTIVITIES, RESULTS, [1]).get(1);
  near(marks.final, 8, "el promedio del trimestre que sí tiene fórmula");
  assert.deepEqual(
    computeMarks(
      { ...half, finalFormula: '("1er" + "2do") / 2' },
      ACTIVITIES,
      RESULTS,
      [1],
    ).get(1).final,
    { value: null },
    "y con + y / sigue siendo sin nota, como cualquier otro blanco",
  );
});

test("a student with no marks at all gets sin nota, not zero and not a crash", () => {
  const marks = computeMarks(SETUP, ACTIVITIES, RESULTS, [99]).get(99);
  // No TPs marked, so avg is sin nota and the arithmetic around it follows;
  // done_ratio is 0 of 2 rather than sin nota, because a blank done is not done.
  assert.deepEqual(marks.terms.t1, { value: null });
  assert.deepEqual(marks.terms.t2, { value: null });
});

/* ── The two views (F24) ─────────────────────────────────────────────────── */

test("the published view drops unpublished activities from the numerator", () => {
  const [student] = computeBothViews(SETUP, ACTIVITIES, RESULTS, [1], NOW);
  // Teacher: avg(6,10)=8, done 2/2. Student: only tp1 and clase1 exist, so
  // avg(6)=6 and done 1/1.
  near(student.terms.t1.all, 0.7 * 8 + 3);
  near(student.terms.t1.published, 0.7 * 6 + 3);
});

test("and out of done_ratio's denominator, or the mark leaks that it exists", () => {
  // The leak this prevents: leaving `clase2` in the denominator while its
  // result is hidden makes the student's ratio 1/2 instead of 1/1 — a number
  // that tells them there is an activity they cannot see.
  const nobody = [mark("clase1", 1, 1)];
  const [student] = computeBothViews(
    {
      ...SETUP,
      terms: [{ id: "t1", name: "1er", formula: "done_ratio(clase)" }],
    },
    ACTIVITIES,
    nobody,
    [1],
    NOW,
  );
  near(student.terms.t1.all, 0.5, "el docente ve dos actividades");
  near(student.terms.t1.published, 1, "el estudiante ve una, y la hizo");
});

test("a publish date in the future is not published yet", () => {
  // `resultsVisible` compares against `now`, and this is the assertion that
  // fails if somebody replaces it with a not-null check.
  const scheduled = [activity("tp1", "t1", "g-tps", "numeric", LATER)];
  assert.deepEqual(publishedOnly(scheduled, NOW), []);
  assert.equal(publishedOnly(scheduled, new Date("2027-12-01")).length, 1);
});

test("both views come from one evaluator, so a broken formula breaks both", () => {
  const broken = {
    ...SETUP,
    terms: [{ id: "t1", name: "1er", formula: "avg(" }],
  };
  const [student] = computeBothViews(broken, ACTIVITIES, RESULTS, [1], NOW);
  assert.ok("error" in student.terms.t1.all);
  assert.ok("error" in student.terms.t1.published);
});

test("a formula that no longer parses is a cell with a message, not a 500", () => {
  // The grid still has to render: a teacher whose formula broke needs to see
  // which term broke, and needs the rest of the screen to fix it from.
  const broken = {
    ...SETUP,
    terms: [
      { id: "t1", name: "1er", formula: "avg(tps" },
      { id: "t2", name: "2do", formula: "avg(tps)" },
    ],
  };
  const marks = computeMarks(broken, ACTIVITIES, RESULTS, [1]).get(1);
  assert.ok("error" in marks.terms.t1);
  near(marks.terms.t2, 8, "el trimestre sano sigue dando un número");
});

test("everybody asked for gets a row, marked or not", () => {
  const all = computeBothViews(SETUP, ACTIVITIES, RESULTS, [1, 2, 3], NOW);
  assert.deepEqual(
    all.map((student) => student.studentId),
    [1, 2, 3],
  );
  assert.deepEqual(all[1].terms.t1.all, { value: null });
});
