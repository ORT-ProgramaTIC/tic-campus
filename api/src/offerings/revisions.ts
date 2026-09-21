import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "../db/client.js";
import { article } from "../db/schema/article.js";
import { directoryUser } from "../db/schema/directory.js";
import { offeringArticle } from "../db/schema/offering-article.js";
import { result } from "../db/schema/result.js";
import { revisionRequest } from "../db/schema/revision-request.js";
import { isUuid } from "../library/program.js";
import { ApiError } from "../middleware/errors.js";
import { publishedOnly } from "./marks.js";
import { checkText, MAX_TEXT } from "./official-grades.js";
import { listActivities, roster } from "./results.js";

/**
 * A student asks for a mark to be looked at again, and the teacher who gave it
 * answers (F29). The old campus called this a *solicitud de reentrega*.
 *
 * **Filing is a group flow.** A student files for themselves and for the
 * partners they worked with, which is what the old dialog did and what this
 * keeps. One `POST` writes one row per student, so `requested_by` and
 * `student_id` are different columns and both reads carry both — see the note
 * on the table.
 *
 * **A request is always about a mark that exists.** It is never filed against
 * an unmarked activity: *"estaba sin hacer"* is a teacher's non-passing mark for
 * work not handed in, not an absent row. So `fileRequests` refuses a student
 * with no `result` for the activity, which is F29's "only a published result"
 * read literally.
 *
 * **Answering is a comment and nothing else.** F29 says the teacher can change
 * the mark from the request itself; F38 says `saveResults` is the one write path
 * for a `result`, and a second one here would be a second place that branches on
 * `value_type`. So the screen makes two calls and this file writes no marks.
 *
 * **There is no request window.** The old controller refused outside March to
 * November; F29 dropped it, and `activeHome` already refuses an archived home.
 * Do not re-add one.
 */

export interface Revision {
  id: string;
  activityId: string;
  slug: string;
  title: string;
  studentId: number;
  studentName: string | null;
  studentSurname: string | null;
  /** Who filed it. Equal to `studentId` unless a partner filed for them, and
   *  the inbox has to say so — otherwise one student's words are rendered under
   *  another's name, to the person who grades them. */
  requestedBy: number;
  requestedByName: string | null;
  requestedBySurname: string | null;
  reason: string;
  bonusTasks: string | null;
  requestedAt: Date;
  answer: string | null;
  answeredAt: Date | null;
  answeredBy: number | null;
}

/** The teacher's inbox for one offering — F5 scopes a teacher to the offering
 *  they teach, and F6 puts the cross-offering number on "Mis materias" as a
 *  count, so there is deliberately no inbox that fans out over everything. */
export async function listRequests(
  db: Db,
  homeId: string,
): Promise<Revision[]> {
  // `directory.user` twice, for the two people on the row. Aliased because the
  // same table cannot be joined twice under one name.
  const filer = alias(directoryUser, "filer");
  return (
    db
      .select({
        id: revisionRequest.id,
        activityId: revisionRequest.offeringArticleId,
        slug: article.slug,
        title: article.title,
        studentId: revisionRequest.studentId,
        studentName: directoryUser.name,
        studentSurname: directoryUser.surname,
        requestedBy: revisionRequest.requestedBy,
        requestedByName: filer.name,
        requestedBySurname: filer.surname,
        reason: revisionRequest.reason,
        bonusTasks: revisionRequest.bonusTasks,
        requestedAt: revisionRequest.requestedAt,
        answer: revisionRequest.answer,
        answeredAt: revisionRequest.answeredAt,
        answeredBy: revisionRequest.answeredBy,
      })
      .from(revisionRequest)
      // The join *is* the scoping: `revision_request` carries no home column, the
      // way `official_grade` carries none either.
      .innerJoin(
        offeringArticle,
        and(
          eq(offeringArticle.id, revisionRequest.offeringArticleId),
          eq(offeringArticle.offeringHomeId, homeId),
        ),
      )
      .innerJoin(article, eq(article.id, offeringArticle.articleId))
      .innerJoin(directoryUser, eq(directoryUser.id, revisionRequest.studentId))
      .innerJoin(filer, eq(filer.id, revisionRequest.requestedBy))
      // Oldest first: an inbox is a queue, and `id` breaks ties so two requests
      // filed in the same statement do not swap places between reads.
      .orderBy(asc(revisionRequest.requestedAt), asc(revisionRequest.id))
  );
}

export interface MyRevision {
  id: string;
  activityId: string;
  requestedBy: number;
  reason: string;
  bonusTasks: string | null;
  requestedAt: Date;
  answer: string | null;
  answeredAt: Date | null;
}

/**
 * One student's own requests, for `/results/mine`.
 *
 * It is a list beside the marks rather than a key on each one: a request
 * outlives the row it argues with — a teacher who empties the cell leaves the
 * conversation standing — so hanging it off `MyResult` would silently drop
 * exactly the ones somebody still owes an answer for.
 */
export async function myRevisions(
  db: Db,
  homeId: string,
  studentId: number,
): Promise<MyRevision[]> {
  return db
    .select({
      id: revisionRequest.id,
      activityId: revisionRequest.offeringArticleId,
      requestedBy: revisionRequest.requestedBy,
      reason: revisionRequest.reason,
      bonusTasks: revisionRequest.bonusTasks,
      requestedAt: revisionRequest.requestedAt,
      answer: revisionRequest.answer,
      answeredAt: revisionRequest.answeredAt,
    })
    .from(revisionRequest)
    .innerJoin(
      offeringArticle,
      and(
        eq(offeringArticle.id, revisionRequest.offeringArticleId),
        eq(offeringArticle.offeringHomeId, homeId),
      ),
    )
    .where(eq(revisionRequest.studentId, studentId))
    .orderBy(asc(revisionRequest.requestedAt), asc(revisionRequest.id));
}

/* ── Writing ─────────────────────────────────────────────────────────────── */

export interface RequestInput {
  activityId: string;
  studentIds: number[];
  reason: string;
  bonusTasks: string | null;
}

/**
 * File one request per named student (F29).
 *
 * Four checks before anything is written, and every one is a trust boundary —
 * this is the first row a student writes, so the body is as hostile as any
 * teacher's and reaches further:
 *
 * - **the activity is one of *this* home's, is graded, and its marks are out.**
 *   `listActivities` is already scoped to the home and already drops
 *   `value_type is null`, and `publishedOnly` is F24's rule with a student's
 *   view hardcoded — so one expression closes three holes. Without the first,
 *   the `offering_article` foreign key would happily accept another offering's
 *   activity and land a student's free text in a stranger's inbox, which is the
 *   hole `saveResults` names first in its own comment. Without the last, an
 *   enrolled *teacher* could file against their own unpublished activity.
 * - **the filer is one of the students named.** You may ask about your own mark
 *   and the marks of people you worked with, never somebody else's alone.
 * - **every other student is enrolled here**, which is `roster` filtered to
 *   `enrolled`. Deliberately **not** `writableStudents`: that set is *enrolled
 *   plus anyone who already carries a mark*, which exists so a teacher can fix
 *   the grade of somebody who left in April. Borrowed here it would let a
 *   student file for a classmate who is gone, and — worse — it would turn this
 *   refusal into an oracle over sequential tic-auth ids: "did this user ever
 *   hold a mark in this offering" is not a student's question to ask.
 * - **every named student already has a mark for it**, because a request argues
 *   with a number that exists.
 *
 * Then **one** insert. `onConflictDoNothing` against the *partial* unique index
 * — supplying its predicate as `targetWhere`, which is what makes a partial
 * index a legal conflict target — so "one open request per result" is enforced
 * by Postgres rather than by a `SELECT` two concurrent tabs would both pass.
 * What comes back from `returning` is what landed; the difference is the set
 * that already had one open.
 */
export async function fileRequests(
  db: Db,
  offeringId: number,
  homeId: string,
  input: RequestInput,
  requestedBy: number,
): Promise<void> {
  const activities = publishedOnly(await listActivities(db, homeId));
  const activity = activities.find((one) => one.id === input.activityId);
  if (!activity) {
    throw new ApiError(
      400,
      "unknown_activity",
      "Esa actividad no es de esta materia, o todavía no tiene notas publicadas.",
    );
  }

  const studentIds = [...new Set(input.studentIds)];
  if (!studentIds.includes(requestedBy)) {
    throw new ApiError(
      403,
      "forbidden",
      "Solo podés pedir revisión de una nota que sea tuya también.",
    );
  }

  const classmates = new Map(
    (await roster(db, offeringId, homeId))
      .filter((student) => student.enrolled)
      .map((student) => [student.id, student]),
  );
  for (const studentId of studentIds) {
    if (!classmates.has(studentId)) {
      throw new ApiError(
        400,
        "not_enrolled",
        "Alguien de esa lista no cursa esta materia.",
      );
    }
  }

  const marked = new Set(
    (
      await db
        .select({ studentId: result.studentId })
        .from(result)
        .where(
          and(
            eq(result.offeringArticleId, input.activityId),
            inArray(result.studentId, studentIds),
          ),
        )
    ).map((row) => row.studentId),
  );
  const unmarked = studentIds.filter((studentId) => !marked.has(studentId));
  if (unmarked.length > 0) {
    throw new ApiError(
      400,
      "not_marked",
      `Todavía no hay nota para ${names(unmarked, classmates)} en esta actividad.`,
    );
  }

  // In a transaction so the refusal below rolls the landed rows back: a partial
  // insert would leave some of the group asking and the rest not, with no way
  // for the screen to say which.
  await db.transaction(async (tx) => {
    const filed = await tx
      .insert(revisionRequest)
      .values(
        studentIds.map((studentId) => ({
          offeringArticleId: input.activityId,
          studentId,
          requestedBy,
          reason: input.reason,
          bonusTasks: input.bonusTasks,
        })),
      )
      .onConflictDoNothing({
        target: [revisionRequest.offeringArticleId, revisionRequest.studentId],
        // `where` here is the *index predicate*, not a row filter: drizzle
        // renders it as `on conflict (cols) where … do nothing`, which is the
        // position Postgres needs to infer the partial index. On
        // `onConflictDoUpdate` the same thing is spelled `targetWhere`.
        where: sql`answered_at is null`,
      })
      .returning({ studentId: revisionRequest.studentId });

    const landed = new Set(filed.map((row) => row.studentId));
    const already = studentIds.filter((studentId) => !landed.has(studentId));
    if (already.length > 0) {
      throw new ApiError(
        409,
        "revision_open",
        `Ya hay un pedido sin responder para ${names(already, classmates)}.`,
      );
    }
  });
}

/** Names for a refusal, from the roster we already loaded. Naming them leaks
 *  nothing the filer did not just assert: they picked these partners. */
function names(
  ids: number[],
  classmates: Map<number, { name: string | null; surname: string | null }>,
): string {
  return ids
    .map((id) => {
      const student = classmates.get(id);
      if (!student) return String(id);
      return [student.name, student.surname].filter(Boolean).join(" ").trim();
    })
    .join(", ");
}

/**
 * The teacher's answer (F29).
 *
 * **The home is in the `where`, not in a read before it.** `mustManage` gates
 * the offering in the *path*, and the request id is a bare uuid from the same
 * path — without this condition any teacher answers any request by id. An empty
 * `returning` is the 404, which is `activation.ts`'s idiom.
 *
 * **Answering twice is allowed.** A teacher fixing a typo in their own answer
 * is real, and re-answering shows the student nothing they could not already
 * see. The partial unique index only cares that the request is closed, so the
 * student's next one is unblocked either way.
 */
export async function answerRequest(
  db: Db,
  homeId: string,
  requestId: string,
  answer: string,
  answeredBy: number,
): Promise<void> {
  const answered = await db
    .update(revisionRequest)
    .set({ answer, answeredBy, answeredAt: sql`now()` })
    .where(
      and(
        eq(revisionRequest.id, requestId),
        // A correlated exists rather than a join: `UPDATE … FROM` would need
        // the home on the row, and it is one hop away on the activity.
        sql`exists (select 1 from ${offeringArticle}
              where ${offeringArticle.id} = ${revisionRequest.offeringArticleId}
                and ${offeringArticle.offeringHomeId} = ${homeId})`,
      ),
    )
    .returning({ id: revisionRequest.id });
  if (answered.length === 0) {
    throw new ApiError(404, "not_found", "No encontramos ese pedido.");
  }
}

/* ── What is accepted ────────────────────────────────────────────────────── */

/** A working group, not a class. Every id has to be in the enrolled roster
 *  anyway, so this only stops a garbage array reaching that lookup — it is
 *  `checkNamed`'s number for the same reason. */
const MAX_STUDENTS = 100;

export function checkRequest(raw: unknown): RequestInput {
  if (typeof raw !== "object" || raw === null) {
    throw new ApiError(400, "invalid_body", "Esperábamos un objeto.");
  }
  const body = raw as Record<string, unknown>;
  if (!isUuid(body.activityId)) {
    throw new ApiError(400, "invalid_body", "Falta el id de la actividad.");
  }
  if (!Array.isArray(body.studentIds) || body.studentIds.length === 0) {
    throw new ApiError(
      400,
      "invalid_body",
      "Hay que elegir al menos a alguien.",
    );
  }
  if (body.studentIds.length > MAX_STUDENTS) {
    throw new ApiError(400, "invalid_body", "Son demasiados estudiantes.");
  }
  for (const studentId of body.studentIds) {
    if (
      typeof studentId !== "number" ||
      !Number.isInteger(studentId) ||
      studentId < 1
    ) {
      throw new ApiError(400, "invalid_body", "Falta el id de alguien.");
    }
  }
  return {
    activityId: body.activityId,
    studentIds: body.studentIds as number[],
    // `reason` is `NOT NULL` and the whole point of the request, so unlike every
    // other text field here an empty one is a refusal rather than a `null`.
    reason: required(checkText(body.reason, "El motivo"), "El motivo"),
    bonusTasks: checkText(body.bonusTasks, "Las tareas extra"),
  };
}

export function checkAnswer(raw: unknown): string {
  if (typeof raw !== "object" || raw === null) {
    throw new ApiError(400, "invalid_body", "Esperábamos un objeto.");
  }
  const { answer } = raw as Record<string, unknown>;
  return required(checkText(answer, "La respuesta"), "La respuesta");
}

/** `checkText` accepts `""` and `null`, which is right for a field that may be
 *  empty and wrong for these two. One line rather than a fourth text checker. */
function required(text: string | null, what: string): string {
  const trimmed = (text ?? "").trim();
  if (trimmed.length === 0) {
    throw new ApiError(
      400,
      "invalid_body",
      `${what} no puede quedar vacío (hasta ${MAX_TEXT} caracteres).`,
    );
  }
  return trimmed;
}
