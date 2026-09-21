import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { article } from "../db/schema/article.js";
import { directoryEnrollment, directoryUser } from "../db/schema/directory.js";
import { offeringScaleLevel, offeringTerm } from "../db/schema/gradebook.js";
import { offeringArticle } from "../db/schema/offering-article.js";
import { offeringHome } from "../db/schema/offering-home.js";
import { officialGrade } from "../db/schema/official-grade.js";
import { redoCovers } from "../db/schema/redo-covers.js";
import { result } from "../db/schema/result.js";
import { isUuid } from "../library/program.js";
import { ApiError } from "../middleware/errors.js";
import { checkMark } from "./gradebook.js";
import type { Capabilities } from "./access.js";

/**
 * Marks: who got what, and who may see it (F24, F38).
 *
 * **A result carries no course, on purpose** (F38) — see the note on the table.
 * Everything here joins the roster live, the way every other read does.
 *
 * **The api branches per value type exactly once, here, at write time.** Done
 * becomes 1, not done becomes 0, a scale level becomes the number that level
 * maps to, and a numeric mark is itself. What lands in `result.value` is always
 * one comparable number, which is what keeps F20's evaluator — still unbuilt —
 * from having to know any of this.
 */

/** F19's three, and the whole of what `offering_article.value_type` may be.
 *  There is no `CHECK` constraint behind this; see the note on that column. */
export const VALUE_TYPES = ["numeric", "done", "scale"] as const;
export type ValueType = (typeof VALUE_TYPES)[number];

export function isValueType(raw: unknown): raw is ValueType {
  return (
    typeof raw === "string" && (VALUE_TYPES as readonly string[]).includes(raw)
  );
}

/* ── Who may see a mark ──────────────────────────────────────────────────── */

/**
 * **The one F24 rule**, so the grid and the student's own page cannot disagree
 * about what is visible — `mayRead` in `content.ts` is its sibling and this is
 * deliberately not it.
 *
 * Two differences from `mayRead`, both load-bearing:
 *
 * - **staff here is `manageOffering` alone.** `editLibrary` is teaching *any*
 *   offering of the subject, in any year, which is the right gate for fixing a
 *   typo in an article and the wrong one for reading a class's marks.
 * - **the article's own visibility is not consulted.** A teacher who
 *   unpublishes a statement in October has not asked to take back the marks
 *   they published in September, and a student watching their marks vanish
 *   would have no way to tell that from a mistake.
 */
export function resultsVisible(
  use: { resultsPublishedAt: Date | null },
  can: Capabilities,
  now = new Date(),
): boolean {
  if (can.manageOffering) return true;
  if (!can.seeOwnMarks) return false;
  return use.resultsPublishedAt !== null && use.resultsPublishedAt <= now;
}

/* ── The grid (F26's api half) ───────────────────────────────────────────── */

export interface Activity {
  /** `offering_article.id` — what a result points at, and what the grid writes
   *  against. Not the library article's id, which is `articleId`. */
  id: string;
  /** The library article, which is what `PUT /api/homes/:id/articles/:articleId`
   *  takes and what the teacher edits the statement through. */
  articleId: string;
  slug: string;
  title: string;
  groupId: string | null;
  termId: string | null;
  valueType: ValueType;
  scaleId: string | null;
  dueAt: Date | null;
  resultsPublishedAt: Date | null;
  position: number;
  /** The activities this one **replaces** (F23), by `offering_article.id`.
   *  Empty for everything that is not a redo — which is what "is not a redo"
   *  means, since there is no flag. */
  covers: string[];
}

export interface Student {
  id: number;
  name: string | null;
  surname: string | null;
  /** False for somebody who left the offering but still carries a mark (F38).
   *  The grid shows them flagged rather than hiding them, because hiding one
   *  would hide the mark a teacher may still have to fix. */
  enrolled: boolean;
}

export interface Mark {
  activityId: string;
  studentId: number;
  value: number;
  scaleLevelId: string | null;
  feedback: string | null;
  recordedBy: number;
  recordedAt: Date;
}

export interface Gradebook {
  activities: Activity[];
  students: Student[];
  results: Mark[];
}

/**
 * The whole grid in a bounded number of queries — **never one per student and
 * never one per activity.** `campus_svc` is capped at 15 connections against a
 * pool of 10 (`db/client.ts`), and this is the first read in campus that is N
 * students × M activities: a loop here is the first thing that would turn that
 * cap from a number in a comment into an outage.
 */
export async function gradebook(
  db: Db,
  homeId: string,
  offeringId: number,
): Promise<Gradebook> {
  const activities = await listActivities(db, homeId);
  const ids = activities.map((activity) => activity.id);
  const [students, results] = await Promise.all([
    roster(db, offeringId, homeId),
    readMarks(db, ids),
  ]);
  return { activities, students, results };
}

/** An activity **is** a use with a `value_type` (F18) — that one `is not null`
 *  is the whole of "is this graded", which is why it is not a second column.
 *
 *  **Exported for the evaluator** (F20): `done_ratio`'s denominator is how many
 *  done activities a group has, not how many results exist, so computing a mark
 *  needs the activity list and not only the `result` rows. A second query for
 *  the same rows would be a second thing that can disagree with this one. */
export async function listActivities(
  db: Db,
  homeId: string,
): Promise<Activity[]> {
  const rows = await db
    .select({
      id: offeringArticle.id,
      articleId: offeringArticle.articleId,
      slug: article.slug,
      title: article.title,
      groupId: offeringArticle.offeringGroupId,
      termId: offeringArticle.offeringTermId,
      valueType: offeringArticle.valueType,
      scaleId: offeringArticle.offeringScaleId,
      dueAt: offeringArticle.dueAt,
      resultsPublishedAt: offeringArticle.resultsPublishedAt,
      position: offeringArticle.position,
    })
    .from(offeringArticle)
    .innerJoin(article, eq(article.id, offeringArticle.articleId))
    .where(
      and(
        eq(offeringArticle.offeringHomeId, homeId),
        isNotNull(offeringArticle.valueType),
      ),
    )
    .orderBy(offeringArticle.position);
  const covers = await readCovers(db, homeId);
  // `valueType` is nullable in the schema and not in an Activity: the `where`
  // above is what narrows it, and TypeScript cannot see that.
  return rows.map((row) => ({
    ...row,
    covers: covers.get(row.id) ?? [],
  })) as Activity[];
}

/**
 * Which activities each redo covers (F23), for the whole home in one query.
 *
 * **Joined to the home through the redo's own use**, because the ids in
 * `redo_covers` are `offering_article` ids and nothing else scopes them — the
 * same join `readOfficialGrades` makes through `offering_term`.
 *
 * Returned as a map rather than nested by the query: two of the three callers
 * already hold their rows and only want the list attached, and a `json_agg`
 * would be one more thing that can disagree with `listActivities`.
 */
async function readCovers(
  db: Db,
  homeId: string,
): Promise<Map<string, string[]>> {
  const rows = await db
    .select({ redoId: redoCovers.redoId, coveredId: redoCovers.coveredId })
    .from(redoCovers)
    .innerJoin(
      offeringArticle,
      and(
        eq(offeringArticle.id, redoCovers.redoId),
        eq(offeringArticle.offeringHomeId, homeId),
      ),
    );
  const byRedo = new Map<string, string[]>();
  for (const row of rows) {
    const already = byRedo.get(row.redoId);
    if (already === undefined) byRedo.set(row.redoId, [row.coveredId]);
    else already.push(row.coveredId);
  }
  return byRedo;
}

/**
 * Everyone the grid has a column for: the enrolled, **plus whoever already
 * carries a mark or an official grade** here (F38's "a student no longer in
 * the offering rather than hiding it", and F22's same question).
 *
 * Two queries and a merge rather than a SQL `UNION` with a flag — the flag is
 * what the merge computes, and the second query returns nothing at all until
 * somebody actually leaves.
 *
 * **It takes the home and not a list of activity ids**, so this and
 * `writableStudents` cannot answer differently: a student the teacher may write
 * for is a student the grid has a row for, and the alternative is a departed
 * student whose official grade nobody can reach to fix.
 *
 * **`id`, `name`, `surname` — not `dni`.** `directory.user` publishes it and
 * campus is a full reader of that view, but nothing on this screen needs it, so
 * it does not go into a payload. F27's import is where matching on a DNI
 * belongs.
 */
export async function roster(
  db: Db,
  offeringId: number,
  homeId: string,
): Promise<Student[]> {
  const NAMES = {
    id: directoryUser.id,
    name: directoryUser.name,
    surname: directoryUser.surname,
  };
  const [enrolled, marked, graded] = await Promise.all([
    db
      .select(NAMES)
      .from(directoryEnrollment)
      .innerJoin(
        directoryUser,
        eq(directoryUser.id, directoryEnrollment.studentId),
      )
      .where(eq(directoryEnrollment.offeringId, offeringId)),
    db
      .selectDistinct(NAMES)
      .from(result)
      .innerJoin(
        offeringArticle,
        and(
          eq(offeringArticle.id, result.offeringArticleId),
          eq(offeringArticle.offeringHomeId, homeId),
        ),
      )
      .innerJoin(directoryUser, eq(directoryUser.id, result.studentId)),
    db
      .selectDistinct(NAMES)
      .from(officialGrade)
      .innerJoin(
        offeringTerm,
        and(
          eq(offeringTerm.id, officialGrade.offeringTermId),
          eq(offeringTerm.offeringHomeId, homeId),
        ),
      )
      .innerJoin(directoryUser, eq(directoryUser.id, officialGrade.studentId)),
  ]);

  const byId = new Map<number, Student>(
    enrolled.map((row) => [row.id, { ...row, enrolled: true }]),
  );
  for (const row of [...marked, ...graded]) {
    if (!byId.has(row.id)) byId.set(row.id, { ...row, enrolled: false });
  }

  return [...byId.values()].sort(
    (a, b) =>
      (a.surname ?? "").localeCompare(b.surname ?? "", "es") ||
      (a.name ?? "").localeCompare(b.name ?? "", "es"),
  );
}

async function readMarks(db: Db, activityIds: string[]): Promise<Mark[]> {
  if (activityIds.length === 0) return [];
  const current = currentResults(db);
  return db
    .select({
      activityId: current.offeringArticleId,
      studentId: current.studentId,
      value: current.value,
      scaleLevelId: current.scaleLevelId,
      feedback: current.feedback,
      recordedBy: current.recordedBy,
      recordedAt: current.recordedAt,
    })
    .from(current)
    .where(inArray(current.offeringArticleId, activityIds));
}

/**
 * Each pair's current mark: its newest row. `result` is append-only (F41), so
 * a pair holds one row per time it was marked, and the two readers that read a
 * mark's *value* read it through this. Everything else that touches `result`
 * asks whether a row exists, where the extra rows do not matter.
 *
 * **A subquery, and not `selectDistinctOn` on the reader itself**, because
 * Postgres wants a `DISTINCT ON`'s leading `ORDER BY` terms to be the distinct
 * expressions, and `myResults` orders by position. Wrapped, the ordering stays
 * inside and each reader keeps its own.
 *
 * `id` breaks a tie on `recorded_at`. A uuid's order means nothing, but it is
 * *stable*, and a tie decided by the plan is the bug that shows up once in
 * production. `checkEntries` already makes a tie impossible — one batch cannot
 * carry a pair twice, and `now()` is the transaction's — so this is the floor
 * under that, not the mechanism.
 */
function currentResults(db: Db) {
  return db
    .selectDistinctOn([result.offeringArticleId, result.studentId])
    .from(result)
    .orderBy(
      result.offeringArticleId,
      result.studentId,
      desc(result.recordedAt),
      desc(result.id),
    )
    .as("current");
}

/* ── What a student sees (F24) ───────────────────────────────────────────── */

export interface MyResult {
  activityId: string;
  slug: string;
  title: string;
  groupId: string | null;
  termId: string | null;
  valueType: ValueType;
  dueAt: Date | null;
  value: number;
  /** The level's **name**, not its id: what the teacher picked, spelled the way
   *  the student reads it. The number behind it is `value`. */
  scaleLevel: string | null;
  feedback: string | null;
  /** What this result **replaces** (F23), by `activityId` — empty unless this
   *  row is a redo's. Without it a student reads «TP2: 4» and «Recuperatorio:
   *  8» as two unrelated marks and cannot tell which one their average used,
   *  and the screen that would say so (F44) has nothing to join on. */
  covers: string[];
}

/**
 * One student's own marks, published only.
 *
 * The publish filter is in the `where` and not applied afterwards, so an
 * unpublished mark is never loaded to be discarded — `resultsVisible` states
 * the same rule for the callers that hold a whole activity in hand, and the two
 * agree because there is only one thing to say: the date has to have arrived.
 *
 * F24's other half, the live computed mark, is F20's and is not here. Nothing
 * is missing from the schema for it: F40 says computed marks are never stored.
 */
export async function myResults(
  db: Db,
  homeId: string,
  studentId: number,
  now = new Date(),
): Promise<MyResult[]> {
  // ponytail: the student filter is pushed into `current`, but the home join
  // cannot be, so this collects every row the student has anywhere before
  // joining — and the index leads with the activity, so that is a scan. Fine
  // at one school's size; a lateral join from `offering_article` is the fix.
  const current = currentResults(db);
  const rows = await db
    .select({
      activityId: offeringArticle.id,
      slug: article.slug,
      title: article.title,
      groupId: offeringArticle.offeringGroupId,
      termId: offeringArticle.offeringTermId,
      valueType: offeringArticle.valueType,
      dueAt: offeringArticle.dueAt,
      value: current.value,
      scaleLevel: offeringScaleLevel.name,
      feedback: current.feedback,
      position: offeringArticle.position,
    })
    .from(current)
    .innerJoin(
      offeringArticle,
      and(
        eq(offeringArticle.id, current.offeringArticleId),
        eq(offeringArticle.offeringHomeId, homeId),
        isNotNull(offeringArticle.valueType),
        isNotNull(offeringArticle.resultsPublishedAt),
        sql`${offeringArticle.resultsPublishedAt} <= ${now}`,
      ),
    )
    .innerJoin(article, eq(article.id, offeringArticle.articleId))
    .leftJoin(
      offeringScaleLevel,
      eq(offeringScaleLevel.id, current.scaleLevelId),
    )
    .where(eq(current.studentId, studentId))
    .orderBy(offeringArticle.position);
  // The ids alone, unfiltered: a covered activity whose marks are not published
  // yet is an id this student can do nothing with, and the redo's own title
  // already says what it is a redo *of*. F24's rule is about results, and there
  // is no result here.
  const covers = await readCovers(db, homeId);
  return rows.map(
    ({ position: _position, ...row }) =>
      ({ ...row, covers: covers.get(row.activityId) ?? [] }) as MyResult,
  );
}

/* ── Writing ─────────────────────────────────────────────────────────────── */

export interface EntryInput {
  studentId: number;
  activityId: string;
  /** `value: null` — the only spelling of "empty this cell". */
  clear: boolean;
  value?: number;
  done?: boolean;
  scaleLevelId?: string;
  feedback: string | null;
}

/**
 * The grid's save: every cell the teacher touched, in one call.
 *
 * Four things are checked before anything is written, and the first two are
 * trust boundaries rather than tidiness:
 *
 * - **every activity is one of *this* home's.** The route gates
 *   `manageOffering` on the offering in the path; the activity ids come from
 *   the body. Without this, a teacher of any offering writes marks onto any
 *   other offering's activity.
 * - **every scale level belongs to its own activity's scale**, or a paste from
 *   another scale's dropdown copies a number that means something else.
 * - **every student is enrolled, or already has a mark here.** F38 checks
 *   enrolment "when a result is created" and says a later unenrolment leaves
 *   the result standing — so the second half of that set is what lets a teacher
 *   still fix the mark of somebody who transferred out in April.
 * - the value matches the activity's type.
 *
 * Then **one** `insert` for everything set and **one** `delete` for everything
 * cleared, whatever the size of the batch. See `gradebook()` for why a loop
 * here is not an option. The insert is not an upsert: a changed mark is a new
 * row (F41). The delete takes **every** row of the pair, history included —
 * a clear withdraws a mark that should never have existed, it does not change
 * a grade, and F38's blank stays one shape: no rows.
 */
export async function saveResults(
  db: Db,
  homeId: string,
  entries: EntryInput[],
  recordedBy: number,
): Promise<void> {
  if (entries.length === 0) return;

  const activities = new Map(
    (await listActivities(db, homeId)).map((activity) => [
      activity.id,
      activity,
    ]),
  );
  for (const entry of entries) {
    if (!activities.has(entry.activityId)) {
      throw new ApiError(
        400,
        "unknown_activity",
        "Alguna actividad no es de esta materia. Recargá el boletín.",
      );
    }
  }

  const levels = await levelsFor(db, [...activities.values()]);
  const writable = await writableStudents(db, homeId);

  const rows = [];
  const clears = [];
  for (const entry of entries) {
    if (!writable.has(entry.studentId)) {
      throw new ApiError(
        400,
        "not_enrolled",
        "Alguien de esa lista no cursa esta materia.",
      );
    }
    if (entry.clear) {
      clears.push(entry);
      continue;
    }
    const activity = activities.get(entry.activityId)!;
    rows.push({
      studentId: entry.studentId,
      offeringArticleId: entry.activityId,
      ...valueOf(entry, activity, levels),
      feedback: entry.feedback,
      recordedBy,
    });
  }

  // A plain insert: `result` is append-only (F41), so a changed mark is a new
  // row and the one it supersedes keeps who set it and when. The current mark
  // is the pair's newest — see `currentResults`.
  if (rows.length > 0) await db.insert(result).values(rows);

  if (clears.length > 0) {
    await db
      .delete(result)
      .where(
        or(
          ...clears.map((entry) =>
            and(
              eq(result.offeringArticleId, entry.activityId),
              eq(result.studentId, entry.studentId),
            ),
          ),
        ),
      );
  }
}

/** **The one place the value type is branched on** (F38). Everything downstream
 *  sees a number. */
function valueOf(
  entry: EntryInput,
  activity: Activity,
  levels: Map<string, { scaleId: string; value: number }>,
): { value: number; scaleLevelId: string | null } {
  if (activity.valueType === "numeric") {
    if (entry.value === undefined) throw wrongType("una nota de 1 a 10");
    return { value: entry.value, scaleLevelId: null };
  }
  if (activity.valueType === "done") {
    if (entry.done === undefined) throw wrongType("hecho o no hecho");
    return { value: entry.done ? 1 : 0, scaleLevelId: null };
  }
  if (entry.scaleLevelId === undefined)
    throw wrongType("un nivel de la escala");
  const level = levels.get(entry.scaleLevelId);
  if (!level || level.scaleId !== activity.scaleId) {
    throw new ApiError(
      400,
      "unknown_level",
      "Ese nivel no es de la escala de esa actividad.",
    );
  }
  return { value: level.value, scaleLevelId: entry.scaleLevelId };
}

function wrongType(expected: string): ApiError {
  return new ApiError(400, "invalid_body", `Esa actividad espera ${expected}.`);
}

async function levelsFor(
  db: Db,
  activities: Activity[],
): Promise<Map<string, { scaleId: string; value: number }>> {
  const scaleIds = [
    ...new Set(
      activities.flatMap((activity) =>
        activity.scaleId ? [activity.scaleId] : [],
      ),
    ),
  ];
  if (scaleIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: offeringScaleLevel.id,
      scaleId: offeringScaleLevel.offeringScaleId,
      value: offeringScaleLevel.value,
    })
    .from(offeringScaleLevel)
    .where(inArray(offeringScaleLevel.offeringScaleId, scaleIds));
  return new Map(rows.map(({ id, ...rest }) => [id, rest]));
}

/**
 * Enrolled now, or already carrying something here — F38's create-only
 * enrolment rule, read as a set rather than as a gate.
 *
 * **Exported, and it takes the home alone.** F22's official grades ask the same
 * question about the same people, and a departed student who carries one has to
 * stay writable for exactly the reason a departed student with a mark does. So
 * the "already carries" half is both tables, joined to the home rather than
 * handed a list of ids by the caller — one rule, and neither writer can drift
 * from the other by passing a different list.
 */
export async function writableStudents(
  db: Db,
  homeId: string,
): Promise<Set<number>> {
  const [enrolled, marked, graded] = await Promise.all([
    db
      .select({ id: directoryEnrollment.studentId })
      .from(directoryEnrollment)
      .innerJoin(
        offeringHome,
        and(
          eq(offeringHome.offeringId, directoryEnrollment.offeringId),
          eq(offeringHome.id, homeId),
        ),
      ),
    db
      .selectDistinct({ id: result.studentId })
      .from(result)
      .innerJoin(
        offeringArticle,
        and(
          eq(offeringArticle.id, result.offeringArticleId),
          eq(offeringArticle.offeringHomeId, homeId),
        ),
      ),
    db
      .selectDistinct({ id: officialGrade.studentId })
      .from(officialGrade)
      .innerJoin(
        offeringTerm,
        and(
          eq(offeringTerm.id, officialGrade.offeringTermId),
          eq(offeringTerm.offeringHomeId, homeId),
        ),
      ),
  ]);
  return new Set([...enrolled, ...marked, ...graded].map((row) => row.id));
}

/* ── What is accepted ────────────────────────────────────────────────────── */

/**
 * Bodies are client-supplied; this is the whole of what is accepted.
 *
 * **An entry says exactly one thing**, and which key is present is what says
 * it: `value: null` clears the cell, a `value` number marks a numeric activity,
 * a `done` boolean marks a done/not-done one, a `scaleLevelId` marks a scaled
 * one. Presence, never truthiness — `{ done: false }` is *not done*, `{ value:
 * 0 }` is a zero, and a check that treated either as "nothing here" would
 * quietly delete a mark the teacher meant to give.
 *
 * An entry with none of them is refused rather than read as a clear, so
 * "feedback only" is an error and not a lost mark.
 */
export function checkEntries(raw: unknown): EntryInput[] {
  if (typeof raw !== "object" || raw === null) {
    throw new ApiError(400, "invalid_body", "Esperábamos un objeto.");
  }
  const { entries } = raw as Record<string, unknown>;
  if (!Array.isArray(entries)) {
    throw new ApiError(400, "invalid_body", "Esperábamos una lista de notas.");
  }
  // 5000 × 7 columns is 35 000 bind parameters, under pg's 65 535 ceiling.
  // `express.json`'s 1 MB limit is the outer bound in practice.
  if (entries.length > 5000) {
    throw new ApiError(400, "invalid_body", "Son demasiadas notas de una vez.");
  }
  const checked = entries.map((raw_entry): EntryInput => {
    if (typeof raw_entry !== "object" || raw_entry === null) {
      throw new ApiError(
        400,
        "invalid_body",
        "Cada nota tiene que ser un objeto.",
      );
    }
    const entry = raw_entry as Record<string, unknown>;
    const studentId = entry.studentId;
    if (
      typeof studentId !== "number" ||
      !Number.isInteger(studentId) ||
      studentId < 1
    ) {
      throw new ApiError(400, "invalid_body", "Falta el id de alguien.");
    }
    if (!isUuid(entry.activityId)) {
      throw new ApiError(400, "invalid_body", "Falta el id de una actividad.");
    }
    const feedback = checkFeedback(entry.feedback);
    const base = { studentId, activityId: entry.activityId, feedback };

    if ("value" in entry && entry.value === null) {
      return { ...base, clear: true };
    }
    if ("value" in entry) {
      return { ...base, clear: false, value: checkMark(entry.value) };
    }
    if ("done" in entry) {
      if (typeof entry.done !== "boolean") {
        throw new ApiError(400, "invalid_body", "`done` es verdadero o falso.");
      }
      return { ...base, clear: false, done: entry.done };
    }
    if ("scaleLevelId" in entry) {
      if (!isUuid(entry.scaleLevelId)) {
        throw new ApiError(400, "invalid_body", "Ese nivel no es válido.");
      }
      return { ...base, clear: false, scaleLevelId: entry.scaleLevelId };
    }
    throw new ApiError(
      400,
      "invalid_body",
      "Cada nota lleva `value`, `done` o `scaleLevelId` — y `value: null` para borrarla.",
    );
  });
  // One entry per cell, the last one winning — what the upsert used to do. The
  // insert is plain now (F41), so a cell sent twice would be two rows with the
  // same `now()`: a tie nothing decides. Postgres used to refuse that batch on
  // its own; this is the guard that replaces it.
  return [
    ...new Map(
      checked.map((entry) => [`${entry.studentId}:${entry.activityId}`, entry]),
    ).values(),
  ];
}

function checkFeedback(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || raw.length > 2000) {
    throw new ApiError(
      400,
      "invalid_body",
      "La devolución es texto de hasta 2000 caracteres.",
    );
  }
  return raw;
}
