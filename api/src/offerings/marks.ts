import {
  type Computed,
  type Node,
  type Value,
  NO_MARK,
  evaluateFormula,
  markValue,
  parseFormula,
} from "./formula.js";
import type { Capabilities } from "./access.js";
import { type Activity, type Mark, resultsVisible } from "./results.js";

/**
 * **What the formula is run against** (F20, F21, F24): the step between rows
 * and a number.
 *
 * Pure — it takes the setup, the activities and the results that
 * `offerings/results.ts` already loaded and returns marks. No `db`, no queries,
 * and deliberately no second read: this is N students × M activities with
 * arithmetic on top, and the grid's read already collects exactly what is
 * needed in a bounded number of queries. `campus_svc` is capped at 15
 * connections against a pool of 10, so a query per student here is the thing
 * that turns that cap from a number in a comment into an outage.
 *
 * **The student's number and the teacher's number are different numbers**
 * (F24), and they come from *one* evaluator called twice with different
 * activity lists — never from two predicates. `resultsVisible` in `results.ts`
 * is the one rule for which side an activity falls on, and the caller applies
 * it; filtering the **activities** and not merely the results is what keeps an
 * unpublished activity out of `done_ratio`'s denominator, where it would leak
 * that it exists.
 *
 * **Groups are scoped to the term.** Inside a term's formula, `avg(tps)` is
 * that term's tps activities, because F21 runs the formula per term. The final
 * is a *second* formula whose names are the **terms**, each resolving to the
 * mark just computed for it.
 */

/**
 * A student's own capabilities, for asking `resultsVisible` what *they* would
 * see. Not a fourth state and not a second predicate — F24's rule is one
 * function and this is simply its other argument.
 */
const STUDENT_VIEW: Capabilities = {
  editLibrary: false,
  manageOffering: false,
  seeOwnMarks: true,
};

/** The activities a student may count. **The list, not just the results**: an
 *  unpublished activity left in here would sit in `done_ratio`'s denominator
 *  and leak that it exists. */
export function publishedOnly(
  activities: Activity[],
  now = new Date(),
): Activity[] {
  return activities.filter((activity) =>
    resultsVisible(activity, STUDENT_VIEW, now),
  );
}

/** Only these two land in the aggregates; `done` lands in `done_ratio` instead,
 *  because a done/not-done averaged in as 1 or 0 would wreck a mark out of 10.
 *  F20's own example only reads right this way. */
const AGGREGATED = new Set(["numeric", "scale"]);

/** The three fields a mark contributes to a formula. Narrower than `Mark` on
 *  purpose: `/results/mine` holds a student's own rows and never loaded who
 *  recorded them, and this is all the evaluator reads of either. */
export type MarkRow = Pick<Mark, "activityId" | "studentId" | "value">;

export interface Setup {
  groups: { id: string; name: string }[];
  terms: { id: string; name: string; formula: string | null }[];
  finalFormula: string | null;
}

export interface StudentMarks {
  /** By `offering_term.id`. A term with no formula is absent, not `null`: there
   *  is nothing to show, which is different from *sin nota*. */
  terms: Record<string, Computed>;
  final: Computed | null;
}

/**
 * One student's marks, per term and final.
 *
 * `activities` is the list this view is allowed to see — the caller filters it,
 * this does not re-derive the rule.
 */
export function computeMarks(
  setup: Setup,
  activities: Activity[],
  results: MarkRow[],
  studentIds: number[],
): Map<number, StudentMarks> {
  // Parsed once, evaluated N times. That is a local variable, not the compiled
  // AST column F40 refuses: nothing outlives the request, so nothing can
  // disagree with the text it came from.
  const parsed = new Map<string, Node | { error: string }>();
  const treeOf = (text: string): Node | { error: string } => {
    const already = parsed.get(text);
    if (already !== undefined) return already;
    let tree: Node | { error: string };
    try {
      tree = parseFormula(text);
    } catch (cause) {
      // A formula that no longer parses is a cell with a message, not a failed
      // request: the grid still has to render, with the broken term visible.
      tree = {
        error: cause instanceof Error ? cause.message : "Fórmula inválida.",
      };
    }
    parsed.set(text, tree);
    return tree;
  };

  const byStudent = new Map<number, Map<string, number>>();
  for (const mark of results) {
    let mine = byStudent.get(mark.studentId);
    if (mine === undefined) {
      mine = new Map();
      byStudent.set(mark.studentId, mine);
    }
    mine.set(mark.activityId, mark.value);
  }

  // Bucketed once for everybody rather than filtered per student per term.
  const buckets = new Map<string, Activity[]>();
  for (const activity of activities) {
    if (activity.groupId === null || activity.termId === null) continue;
    const key = `${activity.termId}\u0000${activity.groupId}`;
    const already = buckets.get(key);
    if (already === undefined) buckets.set(key, [activity]);
    else already.push(activity);
  }

  const marks = new Map<number, StudentMarks>();
  for (const studentId of studentIds) {
    const mine = byStudent.get(studentId) ?? new Map<string, number>();
    const terms: Record<string, Computed> = {};
    const termValues: Record<string, Value> = {};

    for (const term of setup.terms) {
      // Every term is a name the final can spell, formula or not. A term the
      // teacher has not written a formula for yet is *sin nota* there, the same
      // as one nobody has marked — not a missing name, which would make the
      // final an error until the last formula is typed.
      termValues[term.name] = NO_MARK;
      if (term.formula === null) continue;
      const scope: Record<string, Value> = {};
      for (const group of setup.groups) {
        scope[group.name] = groupValue(
          buckets.get(`${term.id}\u0000${group.id}`) ?? [],
          mine,
        );
      }
      const computed = evaluate(treeOf(term.formula), scope);
      terms[term.id] = computed;
      termValues[term.name] = markValue(
        "value" in computed ? computed.value : null,
      );
    }

    marks.set(studentId, {
      terms,
      final:
        setup.finalFormula === null
          ? null
          : evaluate(treeOf(setup.finalFormula), termValues),
    });
  }
  return marks;
}

/** Both sides of one cell: what the teacher is looking at, and what the student
 *  would see right now. */
export interface BothViews {
  all: Computed;
  published: Computed;
}

export interface StudentComputed {
  studentId: number;
  terms: Record<string, BothViews>;
  final: BothViews | null;
}

/**
 * The teacher's grid (F24): every student's marks **both ways, side by side**.
 *
 * One evaluator, called twice with different activity lists — the difference
 * between the two columns is `resultsVisible` and nothing else, so the preview
 * cannot drift from what the student's own page computes.
 */
export function computeBothViews(
  setup: Setup,
  activities: Activity[],
  results: MarkRow[],
  studentIds: number[],
  now = new Date(),
): StudentComputed[] {
  const all = computeMarks(setup, activities, results, studentIds);
  const published = computeMarks(
    setup,
    publishedOnly(activities, now),
    results,
    studentIds,
  );
  return studentIds.map((studentId) => {
    const mine = all.get(studentId)!;
    const theirs = published.get(studentId)!;
    const terms: Record<string, BothViews> = {};
    for (const [termId, computed] of Object.entries(mine.terms)) {
      terms[termId] = { all: computed, published: theirs.terms[termId]! };
    }
    return {
      studentId,
      terms,
      final:
        mine.final === null
          ? null
          : { all: mine.final, published: theirs.final! },
    };
  });
}

function evaluate(
  tree: Node | { error: string },
  scope: Record<string, Value>,
): Computed {
  if ("error" in tree) return tree;
  return evaluateFormula(tree, scope);
}

/**
 * One group, for one student, in one term.
 *
 * **A blank is an absent row and nothing else** (F38), so there is exactly one
 * shape to skip — and the two halves of F20's blank rule part ways here: a
 * missing numeric or scale result is left out of `xs`, while a missing
 * done/not-done still counts in `doneTotal` and so counts as *not done*.
 */
function groupValue(activities: Activity[], mine: Map<string, number>): Value {
  const xs: number[] = [];
  let done = 0;
  let doneTotal = 0;
  for (const activity of activities) {
    const value = mine.get(activity.id);
    if (activity.valueType === "done") {
      doneTotal += 1;
      if (value !== undefined && value !== 0) done += 1;
    } else if (AGGREGATED.has(activity.valueType) && value !== undefined) {
      xs.push(value);
    }
  }
  return { kind: "group", xs, done, doneTotal };
}
