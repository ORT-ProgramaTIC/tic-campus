import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  directoryCourse,
  directoryEnrollment,
  directoryOffering,
  directoryOfferingCourse,
  directorySubject,
  directoryTeacherOffering,
} from "../db/schema/directory.js";
import { offeringArticle } from "../db/schema/offering-article.js";
import { offeringHome } from "../db/schema/offering-home.js";
import { revisionRequest } from "../db/schema/revision-request.js";
import type { Actor } from "./access.js";
import { offeringPath } from "./slug.js";

/**
 * Listing offerings, and turning a public URL back into one (F6, F32, F34).
 *
 * Every read here joins `campus.offering_home`, because an offering the
 * directory knows about and an admin has not activated has no campus presence
 * at all (F34) — not an empty home, not a 200 with nothing in it. The admin
 * listing is the one exception and joins it `left`, since its whole job is to
 * show what is *not* activated yet.
 *
 * **The year defaults to `is_current`, never to a clock.** Which year is
 * current is tic-auth's fact, flattened onto the views
 * (`tic-auth/docs/CONSISTENCY.md`); a campus that derived it from `new Date()`
 * would disagree with the directory every January and blame the database.
 */

export interface OfferingSummary {
  offeringId: number;
  subjectId: number;
  subjectName: string;
  /** Nullable and display-only: it tells two offerings of one subject apart. */
  offeringName: string | null;
  courseNames: string[];
  year: number;
  /** F32's URL, and the only thing a link should be built from. */
  path: string;
}

/** The caller's relationship to an offering in "Mis materias" (F6). Both, for
 *  the teacher who is also enrolled in something they teach. */
export type MyRole = "student" | "teacher";

export interface MyOffering extends OfferingSummary {
  roles: MyRole[];
  /** Open revision requests waiting on you here (F6, F29) — **0 unless you
   *  teach this one**, never a peek at what your own classmates have asked. */
  openRevisions: number;
}

/**
 * The offering's courses, aggregated in the database rather than joined out and
 * regrouped in memory: one row per offering is what every caller wants, and a
 * join would multiply them by course.
 *
 * **`directory.offering_course` and not `DISTINCT` over `enrollment`** — the
 * latter reports only the course/offering pairs that already have a student, so
 * a freshly created offering would come back with no courses and therefore no
 * slug (tic-auth's `0010`).
 */
const courseNames = sql<string[]>`coalesce((
  select array_agg(${directoryCourse.name} order by ${directoryCourse.name})
  from ${directoryOfferingCourse}
  join ${directoryCourse} on ${directoryCourse.id} = ${directoryOfferingCourse.courseId}
  where ${directoryOfferingCourse.offeringId} = ${directoryOffering.id}
), '{}')`;

const COLUMNS = {
  offeringId: directoryOffering.id,
  subjectId: directoryOffering.subjectId,
  subjectName: directorySubject.name,
  offeringName: directoryOffering.name,
  year: directoryOffering.year,
  courseNames,
};

type Row = {
  offeringId: number;
  subjectId: number;
  subjectName: string;
  offeringName: string | null;
  year: number;
  courseNames: string[];
};

function summarize(row: Row): OfferingSummary {
  return {
    ...row,
    path: offeringPath(
      row.year,
      row.subjectName,
      row.offeringName,
      row.courseNames,
    ),
  };
}

/** `undefined` means the current school year, which the views already state. */
export function yearFilter(year: number | undefined): SQL {
  return year === undefined
    ? eq(directoryOffering.isCurrent, true)
    : eq(directoryOffering.year, year);
}

function activated(db: Db, where: SQL) {
  return db
    .select(COLUMNS)
    .from(directoryOffering)
    .innerJoin(
      offeringHome,
      and(
        eq(offeringHome.offeringId, directoryOffering.id),
        isNull(offeringHome.archivedAt),
      ),
    )
    .innerJoin(
      directorySubject,
      eq(directorySubject.id, directoryOffering.subjectId),
    )
    .where(where)
    .orderBy(directorySubject.name, directoryOffering.id);
}

/** Every activated offering of a year — the anonymous visitor's picker (F6). */
export async function listActivated(
  db: Db,
  year: number | undefined,
): Promise<OfferingSummary[]> {
  const rows = await activated(db, yearFilter(year));
  return rows.map(summarize);
}

/**
 * "Mis materias" (F6): what this person teaches, and what they are taking.
 *
 * **Which half runs is decided by `roles[]`, not by what the tables return.**
 * The directory snapshot has an `admin` holding an enrolment, and staff carry
 * them too — so a teacher would otherwise see a subject of theirs listed as
 * something they study. The token already states whether somebody is a student;
 * asking `directory.user_role` for it would be a second source of one fact.
 *
 * Both halves in one statement, as two `EXISTS` subqueries: a person with one
 * of each gets one row carrying both roles, rather than the same offering
 * twice for a client to merge.
 */
export async function listMine(
  db: Db,
  actor: Actor,
  year: number | undefined,
): Promise<MyOffering[]> {
  const asTeacher = actor.roles.includes("teacher") || actor.isAdmin;
  const asStudent = actor.roles.includes("student");
  if (!asTeacher && !asStudent) return [];

  // `sql`false`` rather than an omitted branch: the shape of the row stays the
  // same either way, so the mapping below has no case to miss.
  const teaches = asTeacher
    ? sql<boolean>`exists (
        select 1 from ${directoryTeacherOffering}
        where ${directoryTeacherOffering.teacherId} = ${actor.userId}
          and ${directoryTeacherOffering.offeringId} = ${directoryOffering.id})`
    : sql<boolean>`false`;
  const studies = asStudent
    ? sql<boolean>`exists (
        select 1 from ${directoryEnrollment}
        where ${directoryEnrollment.studentId} = ${actor.userId}
          and ${directoryEnrollment.offeringId} = ${directoryOffering.id})`
    : sql<boolean>`false`;

  // F6's count, paid by F29. One correlated subquery in the same statement and
  // never a query per offering — `campus_svc` is capped at 15 connections and
  // the pool is 10.
  //
  // **Gated on `teaches`, the per-row expression, and not on `asTeacher`.** A
  // teacher who is also enrolled in something has `asTeacher === true` for every
  // row they get back, so gating on it would print the count of their own
  // classmates' open disputes on the card for the subject they *study*.
  //
  // `::int` because `count(*)` is a `bigint` and node-postgres hands those back
  // as strings — the same trap `{ mode: "number" }` exists for on the mark
  // columns.
  const openRevisions = asTeacher
    ? sql<number>`case when ${teaches} then (
        select count(*)::int from ${revisionRequest}
        join ${offeringArticle}
          on ${offeringArticle.id} = ${revisionRequest.offeringArticleId}
        where ${offeringArticle.offeringHomeId} = ${offeringHome.id}
          and ${revisionRequest.answeredAt} is null) else 0 end`
    : sql<number>`0`;

  const rows = await db
    .select({ ...COLUMNS, teaches, studies, openRevisions })
    .from(directoryOffering)
    .innerJoin(
      offeringHome,
      and(
        eq(offeringHome.offeringId, directoryOffering.id),
        isNull(offeringHome.archivedAt),
      ),
    )
    .innerJoin(
      directorySubject,
      eq(directorySubject.id, directoryOffering.subjectId),
    )
    .where(and(yearFilter(year), or(teaches, studies)))
    .orderBy(directorySubject.name, directoryOffering.id);

  return rows.map(
    ({ teaches: t, studies: s, openRevisions: open, ...row }) => ({
      ...summarize(row),
      openRevisions: open,
      roles: [
        ...(t ? (["teacher"] as const) : []),
        ...(s ? (["student"] as const) : []),
      ],
    }),
  );
}

/**
 * A public URL back to the offering it names (F32).
 *
 * The slugs are derived, so this cannot be a `WHERE`: it loads the year's
 * activated offerings, derives their slugs and matches in memory.
 *
 * ponytail: O(offerings activated in a year) per resolve — dozens, and the
 * query is the same one the picker runs. A `slug` column on `offering_home`,
 * written at activation, is the upgrade if a year ever stops fitting in a
 * request.
 *
 * **An ambiguous URL resolves to nothing.** Two offerings of one subject in one
 * year, both unnamed, whose course sets slugify the same, would each be a
 * plausible answer — and serving one teacher's offering under the other's URL
 * is worse than "no encontrado", which at least says what happened.
 */
export async function resolveBySlug(
  db: Db,
  year: number,
  subjectSlug: string,
  offeringSlug: string,
): Promise<OfferingSummary | null> {
  const wanted = `/${year}/${subjectSlug}/${offeringSlug}`;
  const matches = (await listActivated(db, year)).filter(
    (offering) => offering.path === wanted,
  );
  return matches.length === 1 ? matches[0]! : null;
}

export interface AdminOffering extends OfferingSummary {
  activated: boolean;
}

/**
 * Every offering the *directory* has for a year, with whether campus has
 * activated it (F34) — the list an admin activates from, and the only read here
 * that does not require a home.
 */
export async function listForAdmin(
  db: Db,
  year: number | undefined,
): Promise<AdminOffering[]> {
  const rows = await db
    .select({
      ...COLUMNS,
      // Archived counts as not activated, but the join stays plain: filtering
      // archived rows out of the `leftJoin` itself would lose the home an admin
      // needs to re-activate, and this list exists to offer exactly that.
      activated: sql<boolean>`${offeringHome.id} is not null and ${offeringHome.archivedAt} is null`,
    })
    .from(directoryOffering)
    .leftJoin(offeringHome, eq(offeringHome.offeringId, directoryOffering.id))
    .innerJoin(
      directorySubject,
      eq(directorySubject.id, directoryOffering.subjectId),
    )
    .where(yearFilter(year))
    .orderBy(directorySubject.name, directoryOffering.id);

  return rows.map(({ activated: isActive, ...row }) => ({
    ...summarize(row),
    activated: isActive,
  }));
}
