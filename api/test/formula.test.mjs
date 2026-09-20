// F20's expression language on its own: the parser, the evaluator, and the
// blank rules that decide what a missing row does to a mark. No database — a
// formula is arithmetic over values, and what builds those values from rows is
// `marks.test.mjs`. The save-time refusals around it are in `db.test.mjs`.
//
// The property every test here defends: a mark that is wrong is worse than a
// page that is down. Nothing in this file may produce NaN, Infinity, or a
// number where an error was the honest answer.
import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_FORMULA,
  checkFormula,
  evaluateFormula,
  formulaNames,
  parseFormula,
} from "../dist/offerings/formula.js";

/** A group of marks: what a student got, plus the done/not-done tally. */
function group(xs, done = 0, doneTotal = 0) {
  return { kind: "group", xs, done, doneTotal };
}

const NUMBER = (n) => ({ kind: "number", n });
const NOTHING = { kind: "null" };

/** Four TPs marked, two class activities of which one is done. */
const SCOPE = {
  tps: group([8, 6, 10, 4]),
  clase: group([], 1, 2),
  vacío: group([]),
};

function value(text, scope = SCOPE) {
  return evaluateFormula(parseFormula(text), scope);
}

/** Floats: 0.7*8 + 0.3*10*0.5 does not land on 7.1 exactly. */
function near(got, expected, message) {
  assert.ok(
    typeof got.value === "number" && Math.abs(got.value - expected) < 1e-9,
    `${message ?? ""} — esperábamos ${expected}, vino ${JSON.stringify(got)}`,
  );
}

const refused = (cause) =>
  cause.status === 400 && cause.code === "formula_invalid";

/* ── Arithmetic ──────────────────────────────────────────────────────────── */

test("F20's own example computes", () => {
  // avg(tps) is 7, done_ratio(clase) is 0.5 → 0.7*7 + 0.3*10*0.5 = 6.4
  near(value("0.7*avg(tps) + 0.3*10*done_ratio(clase)"), 6.4);
});

test("multiplication binds tighter than addition, and parens win", () => {
  near(value("1 + 2 * 3"), 7);
  near(value("(1 + 2) * 3"), 9);
  // Left associativity, which subtraction is the only one that notices.
  near(value("10 - 3 - 2"), 5);
  near(value("100 / 10 / 2"), 5);
});

test("unary minus applies to what follows it, not to the whole sum", () => {
  near(value("-2 + 10"), 8);
  near(value("-(2 + 10)"), -12);
  near(value("- -3"), 3);
});

test("a division by zero is an error, not a blank", () => {
  // The bug this prevents: returning null here would read as "todavía no hay
  // nota" on the boletín, hiding a formula the teacher has to go fix. And
  // returning Infinity would print as a mark.
  const got = value("10 / 0");
  assert.ok("error" in got, "esperábamos un error");
  assert.match(got.error, /cero/);
});

test("a formula that ends in a group says so instead of printing an object", () => {
  const got = value("tps");
  assert.ok("error" in got);
  assert.match(got.error, /avg/, "el mensaje tiene que decir qué hacer");
});

test("a group in the middle of arithmetic is an error, not a coercion", () => {
  // The bug this prevents: JavaScript would happily turn an object into NaN
  // here and carry it all the way to a report card.
  const got = value("tps + 1");
  assert.ok("error" in got);
  assert.match(got.error, /grupo/);
});

test("the binary floating point noise is rounded off the result", () => {
  // The bug this prevents, and it was found by reading a real response:
  // 0.7*avg + 0.3*10*done_ratio came back 7.199999999999999, which prints as
  // that on a boletín — and makes a threshold a teacher wrote miss by 1e-16.
  assert.deepEqual(value("0.7*6 + 0.3*10*1"), { value: 7.2 });
  assert.deepEqual(value("0.1 + 0.2"), { value: 0.3 });
  near(value("if(0.7*7 + 0.3*10 >= 7.9, 10, 1)"), 10, "el umbral no se pierde");
  // And it does not round the mark itself: two decimals still survive, which
  // is the precision `checkMark` accepts.
  assert.deepEqual(value("avg(g)", { g: group([8.25, 8.75]) }), { value: 8.5 });
  assert.deepEqual(value("avg(g)", { g: group([7.33, 7.34]) }), {
    value: 7.335,
  });
});

/* ── The aggregates ──────────────────────────────────────────────────────── */

test("avg, min and max read the marks that exist", () => {
  near(value("avg(tps)"), 7);
  near(value("min(tps)"), 4);
  near(value("max(tps)"), 10);
});

test("a blank is left out of the aggregates rather than counted as a zero", () => {
  // F20's decision, and the whole reason `result` has no nullable value: a
  // missing row is a mark nobody gave, and averaging it in as 0 would fail a
  // student for an activity their teacher has not marked yet.
  near(value("avg(tps)", { tps: group([8, 6]) }), 7);
  near(value("avg(tps)", { tps: group([8, 6, 10, 4]) }), 7);
});

test("an aggregate over nothing is sin nota, and sin nota is not zero", () => {
  assert.deepEqual(value("avg(vacío)"), { value: null });
  assert.deepEqual(value("min(vacío)"), { value: null });
  assert.deepEqual(value("max(vacío)"), { value: null });
});

test("aggregates pool every argument, so the same avg serves both formulas", () => {
  // One rule covering a group of marks and a list of term marks: this is what
  // lets the final formula (F21) use the same evaluator as a term's.
  near(value("avg(t1, t2)", { t1: NUMBER(8), t2: NUMBER(6) }), 7);
  near(
    value("avg(tps, otros)", { tps: group([8, 6]), otros: group([10, 4]) }),
    7,
  );
});

test("drop_lowest drops the lowest, and one by default", () => {
  near(value("avg(drop_lowest(tps))"), 8); // 4 gone: (8+6+10)/3
  near(value("avg(drop_lowest(tps, 2))"), 9); // 4 and 6 gone
});

test("drop_lowest over one mark leaves nothing, and nothing is sin nota", () => {
  // The bug this prevents: slicing past the end of the array and averaging an
  // empty list into NaN.
  assert.deepEqual(value("avg(drop_lowest(uno))", { uno: group([7]) }), {
    value: null,
  });
  assert.deepEqual(value("avg(drop_lowest(tps, 99))"), { value: null });
});

/* ── done_ratio, where a blank means the opposite ────────────────────────── */

test("a missing done counts as not done, which is what makes it a ratio", () => {
  // The denominator is how many `done` ACTIVITIES the group has, not how many
  // results exist — the one place a blank is not simply skipped (F20). If this
  // read the rows instead, a class where nobody was marked would be 100%.
  near(value("done_ratio(clase)"), 0.5, "una hecha de dos");
  near(value("done_ratio(g)", { g: group([], 0, 4) }), 0, "ninguna de cuatro");
  near(value("done_ratio(g)", { g: group([], 4, 4) }), 1);
});

test("done_ratio with no done activities at all is sin nota, not zero", () => {
  assert.deepEqual(value("done_ratio(vacío)"), { value: null });
});

test("done_ratio needs a group, which is why the final formula cannot use it", () => {
  // In the final formula a name is a term's own mark, and there is no activity
  // list behind it to be a denominator.
  const got = value("done_ratio(t1)", { t1: NUMBER(8) });
  assert.ok("error" in got);
  assert.match(got.error, /grupo/);
});

/* ── Sin nota: propagates through arithmetic, skipped by aggregates ──────── */

test("sin nota propagates through arithmetic", () => {
  // A term nobody has marked is not a zero, so anything built on it is also
  // sin nota rather than a number a student would read as a failure.
  assert.deepEqual(value("avg(vacío) + 1", SCOPE), { value: null });
  assert.deepEqual(value("2 * avg(vacío)", SCOPE), { value: null });
  assert.deepEqual(value("-avg(vacío)", SCOPE), { value: null });
  assert.deepEqual(value("(t1 + t2) / 2", { t1: NUMBER(8), t2: NOTHING }), {
    value: null,
  });
});

test("but an n-ary aggregate skips it, and the two rules differ on purpose", () => {
  // The same "a blank is left out of the aggregates" rule, one level up: a
  // third trimester nobody has marked yet does not drag the final down, while
  // spelling the same thing with + and / deliberately does give sin nota.
  const partial = { t1: NUMBER(8), t2: NUMBER(6), t3: NOTHING };
  near(value("avg(t1, t2, t3)", partial), 7, "el promedio de los dos que hay");
  assert.deepEqual(value("(t1 + t2 + t3) / 3", partial), { value: null });
});

/* ── round and if ────────────────────────────────────────────────────────── */

test("round takes an optional number of digits", () => {
  near(value("round(7.456)"), 7);
  near(value("round(7.456, 1)"), 7.5);
  near(value("round(7.444, 2)"), 7.44);
  assert.deepEqual(value("round(avg(vacío))", SCOPE), { value: null });
});

test("if picks a branch on a comparison", () => {
  near(value("if(avg(tps) >= 4, avg(tps), 1)"), 7);
  near(value("if(avg(tps) > 9, 10, 1)"), 1);
  near(value("if(1 != 2, 10, 1)"), 10);
  near(value("if(1 == 2, 10, 1)"), 1);
});

test("if does not evaluate the branch it rejects", () => {
  // The bug this prevents: a guard is written precisely to keep the bad branch
  // from running, so evaluating both eagerly makes `if` useless for the one
  // thing anybody reaches for it.
  near(value("if(n > 0, 10 / n, 0)", { n: NUMBER(0) }), 0);
  near(value("if(n > 0, 10 / n, 0)", { n: NUMBER(2) }), 5);
});

test("if on sin nota is sin nota, and does not silently take the else", () => {
  assert.deepEqual(value("if(avg(vacío) >= 4, 10, 1)", SCOPE), { value: null });
});

/* ── Names ───────────────────────────────────────────────────────────────── */

test("a name is a call only when a parenthesis follows, so nothing is reserved", () => {
  // A teacher may call a group `min`. Reserving the seven function names would
  // mean a save that refuses a name the group panel already accepted.
  near(value("min", { min: NUMBER(3) }), 3);
  near(value("min(min)", { min: group([5, 9]) }), 5);
});

test("a name with a space or an accent is quoted, and an accent alone is not", () => {
  // `offering_group.name` is free text up to 80 chars, which is the whole
  // reason a formula names groups instead of carrying its own key column (F39).
  near(
    value('avg("Trabajos Prácticos")', { "Trabajos Prácticos": group([8]) }),
    8,
  );
  near(value("avg(física)", { física: group([9]) }), 9);
  // A quoted name is never a call, even when it spells one.
  near(value('"avg" + 1', { avg: NUMBER(1) }), 2);
});

test("formulaNames reports what a save has to check, deduplicated", () => {
  assert.deepEqual(
    formulaNames(
      parseFormula("0.7*avg(tps) + 0.3*done_ratio(clase) + avg(tps)"),
    ),
    ["tps", "clase"],
  );
});

test("checkFormula refuses a name the offering does not have", () => {
  assert.doesNotThrow(() => checkFormula("avg(tps)", ["tps", "clase"]));
  assert.throws(() => checkFormula("avg(parciales)", ["tps"]), refused);
  // The noun is what the message calls it, since the final formula names terms.
  assert.throws(
    () => checkFormula("avg(t9)", ["t1"], "trimestre"),
    (cause) => refused(cause) && /trimestre/.test(cause.message),
  );
});

test("a name that vanished between save and read is an error, not undefined", () => {
  // Only reachable through a race — the save refuses a formula naming nothing
  // and the delete refuses while a formula names it. Handled anyway, because
  // the alternative is arithmetic on undefined.
  const got = value("avg(tps)", {});
  assert.ok("error" in got);
  assert.match(got.error, /tps/);
});

/* ── What the parser refuses ─────────────────────────────────────────────── */

test("a syntax error is refused with a position a caret can use", () => {
  for (const bad of [
    "1 +",
    "1 + + 2",
    "(1 + 2",
    "1 + 2)",
    "avg(",
    "avg(tps",
    "avg tps)",
    "1 $ 2",
    '"sin cerrar',
    "1.",
    "",
    "   ",
  ]) {
    assert.throws(
      () => parseFormula(bad),
      refused,
      `«${bad}» tendría que fallar`,
    );
  }
  assert.match(
    (() => {
      try {
        parseFormula("1 + $");
      } catch (cause) {
        return cause.message;
      }
    })(),
    /posición 5/,
  );
});

test("an unknown function is refused at parse time, with its name", () => {
  assert.throws(
    () => parseFormula("mediana(tps)"),
    (cause) => refused(cause) && /mediana/.test(cause.message),
  );
});

test("the wrong number of arguments is refused at parse time", () => {
  // Caught here rather than per student, so an editor gets one refusal.
  assert.throws(() => parseFormula("if(1, 2)"), refused);
  assert.throws(() => parseFormula("done_ratio(a, b)"), refused);
  assert.throws(() => parseFormula("round(1, 2, 3)"), refused);
  assert.throws(() => parseFormula("avg()"), refused);
});

test("a formula cannot name an activity, because there is no syntax for one", () => {
  // F20's promise that renaming or adding an activity can never break a
  // formula is kept by the grammar: a name resolves against groups and nothing
  // else, and this is the test that fails if a subscript is ever added.
  assert.deepEqual(formulaNames(parseFormula("avg(tps)")), ["tps"]);
  assert.throws(() => parseFormula("tps[0]"), refused);
  assert.throws(() => parseFormula("tps.tp1"), refused);
});

test("the length and nesting caps hold, so the parse is bounded", () => {
  assert.throws(() => parseFormula("1 + ".repeat(MAX_FORMULA) + "1"), refused);
  assert.doesNotThrow(() =>
    parseFormula("(".repeat(30) + "1" + ")".repeat(30)),
  );
  assert.throws(
    () => parseFormula("(".repeat(40) + "1" + ")".repeat(40)),
    refused,
  );
});
