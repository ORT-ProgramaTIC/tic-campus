import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { article } from "../db/schema/article.js";
import { directoryEnrollment, directoryUser } from "../db/schema/directory.js";
import { offeringScaleLevel } from "../db/schema/gradebook.js";
import { offeringArticle } from "../db/schema/offering-article.js";
import { offeringHome } from "../db/schema/offering-home.js";
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
    roster(db, offeringId, ids),
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
  // `valueType` is nullable in the schema and not in an Activity: the `where`
  // above is what narrows it, and TypeScript cannot see that.
  return rows as Activity[];
}

/**
 * Everyone the grid has a column for: the enrolled, **plus whoever already
 * carries a mark** on one of these activities (F38's "a student no longer in
 * the offering rather than hiding it").
 *
 * Two queries and a merge rather than a SQL `UNION` with a flag — the flag is
 * what the merge computes, and the second query returns nothing at all until
 * somebody actually leaves.
 *
 * **`id`, `name`, `surname` — not `dni`.** `directory.user` publishes it and
 * campus is a full reader of that view, but nothing on this screen needs it, so
 * it does not go into a payload. F27's import is where matching on a DNI
 * belongs.
 */
export async function roster(
  db: Db,
  offeringId: number,
  activityIds: string[],
): Promise<Student[]> {
  const enrolled = await db
    .select({
      id: directoryUser.id,
      name: directoryUser.name,
      surname: directoryUser.surname,
    })
    .from(directoryEnrollment)
    .innerJoin(
      directoryUser,
      eq(directoryUser.id, directoryEnrollment.studentId),
    )
    .where(eq(directoryEnrollment.offeringId, offeringId));

  const byId = new Map<number, Student>(
    enrolled.map((row) => [row.id, { ...row, enrolled: true }]),
  );

  if (activityIds.length > 0) {
    const marked = await db
      .selectDistinct({
        id: directoryUser.id,
        name: directoryUser.name,
        surname: directoryUser.surname,
      })
      .from(result)
      .innerJoin(directoryUser, eq(directoryUser.id, result.studentId))
      .where(inArray(result.offeringArticleId, activityIds));
    for (const row of marked) {
      if (!byId.has(row.id)) byId.set(row.id, { ...row, enrolled: false });
    }
  }

  return [...byId.values()].sort(
    (a, b) =>
      (a.surname ?? "").localeCompare(b.surname ?? "", "es") ||
      (a.name ?? "").localeCompare(b.name ?? "", "es"),
  );
}

async function readMarks(db: Db, activityIds: string[]): Promise<Mark[]> {
  if (activityIds.length === 0) return [];
  return db
    .select({
      activityId: result.offeringArticleId,
      studentId: result.studentId,
      value: result.value,
      scaleLevelId: result.scaleLevelId,
      feedback: result.feedback,
      recordedBy: result.recordedBy,
      recordedAt: result.recordedAt,
    })
    .from(result)
    .where(inArray(result.offeringArticleId, activityIds));
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
  const rows = await db
    .select({
      activityId: offeringArticle.id,
      slug: article.slug,
      title: article.title,
      groupId: offeringArticle.offeringGroupId,
      termId: offeringArticle.offeringTermId,
      valueType: offeringArticle.valueType,
      dueAt: offeringArticle.dueAt,
      value: result.value,
      scaleLevel: offeringScaleLevel.name,
      feedback: result.feedback,
      position: offeringArticle.position,
    })
    .from(result)
    .innerJoin(
      offeringArticle,
      and(
        eq(offeringArticle.id, result.offeringArticleId),
        eq(offeringArticle.offeringHomeId, homeId),
        isNotNull(offeringArticle.valueType),
        isNotNull(offeringArticle.resultsPublishedAt),
        sql`${offeringArticle.resultsPublishedAt} <= ${now}`,
      ),
    )
    .innerJoin(article, eq(article.id, offeringArticle.articleId))
    .leftJoin(
      offeringScaleLevel,
      eq(offeringScaleLevel.id, result.scaleLevelId),
    )
    .where(eq(result.studentId, studentId))
    .orderBy(offeringArticle.position);
  return rows.map(({ position: _position, ...row }) => row as MyResult);
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
 * Then **one** `insert … on conflict do update` for everything set and **one**
 * `delete` for everything cleared, whatever the size of the batch. See
 * `gradebook()` for why a loop here is not an option.
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
  const writable = await writableStudents(db, homeId, [...activities.keys()]);

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

  if (rows.length > 0) {
    await db
      .insert(result)
      .values(rows)
      .onConflictDoUpdate({
        target: [result.offeringArticleId, result.studentId],
        // Raw `excluded`, because drizzle-orm 0.45 ships no helper for it — and
        // **never** interpolate a column into one of these: `${result.value}`
        // renders `excluded."result"."value"`, which is not a thing.
        set: {
          value: sql`excluded."value"`,
          scaleLevelId: sql`excluded."scale_level_id"`,
          feedback: sql`excluded."feedback"`,
          recordedBy: sql`excluded."recorded_by"`,
          // `defaultNow()` only fires on insert, and an overwritten mark is a
          // mark somebody set today.
          recordedAt: sql`now()`,
        },
      });
  }

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

/** Enrolled now, or already marked here — F38's create-only enrolment rule,
 *  read as a set rather than as a gate. */
async function writableStudents(
  db: Db,
  homeId: string,
  activityIds: string[],
): Promise<Set<number>> {
  const [enrolled, marked] = await Promise.all([
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
    activityIds.length === 0
      ? []
      : db
          .selectDistinct({ id: result.studentId })
          .from(result)
          .where(inArray(result.offeringArticleId, activityIds)),
  ]);
  return new Set([...enrolled, ...marked].map((row) => row.id));
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
  return entries.map((raw_entry) => {
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
