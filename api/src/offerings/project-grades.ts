import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  directoryCourse,
  directoryEnrollment,
  directoryProject,
  directoryProjectMember,
  directoryUser,
} from "../db/schema/directory.js";
import { projectGrade } from "../db/schema/project-grade.js";
import { ApiError } from "../middleware/errors.js";

/**
 * The Proyecto grade (F46, F47, F50): one per student per rotation, with a
 * per-student `visible` flag. See the note on the table for why it is not
 * `official_grade`.
 */

/** What a grade may be, best first. PIA and DICIEMBRE are labels only. */
export const PROJECT_GRADES = [
  "10",
  "9",
  "8",
  "7",
  "6",
  "pia",
  "diciembre",
] as const;
export type ProjectGradeValue = (typeof PROJECT_GRADES)[number];

export interface ProjectRef {
  name: string;
  /** tic-registry's track slug (`ux-ui`). */
  track: string;
}

export interface GradeRow {
  studentId: number;
  name: string | null;
  surname: string | null;
  /** The enrolment's course name (`NR4A`); `null` for someone who left. */
  course: string | null;
  /** By name. Empty for a student on no project; two is possible upstream. */
  projects: ProjectRef[];
  /** `false`: left the offering but still holds a grade here (F38's rule). */
  enrolled: boolean;
  grade: { value: ProjectGradeValue; visible: boolean } | null;
}

/** Each student's current grade in a home: the pair's newest row (F41). */
function currentGrades(db: Db, homeId: string, studentId?: number) {
  return db
    .selectDistinctOn([projectGrade.studentId], {
      studentId: projectGrade.studentId,
      value: projectGrade.value,
      visible: projectGrade.visible,
    })
    .from(projectGrade)
    .where(
      and(
        eq(projectGrade.offeringHomeId, homeId),
        studentId === undefined
          ? undefined
          : eq(projectGrade.studentId, studentId),
      ),
    )
    .orderBy(
      projectGrade.studentId,
      desc(projectGrade.recordedAt),
      desc(projectGrade.id),
    );
}

/** Live projects per member of this offering — `offeringTeams`' road, keyed
 *  by person. */
async function projectsByStudent(
  db: Db,
  offeringId: number,
  studentIds?: number[],
): Promise<Map<number, ProjectRef[]>> {
  const rows = await db
    .select({
      userId: directoryProjectMember.userId,
      name: directoryProject.name,
      track: directoryProjectMember.track,
    })
    .from(directoryProjectMember)
    .innerJoin(
      directoryProject,
      eq(directoryProject.id, directoryProjectMember.projectId),
    )
    .where(
      and(
        eq(directoryProjectMember.offeringId, offeringId),
        isNull(directoryProject.archivedAt),
        studentIds
          ? inArray(directoryProjectMember.userId, studentIds)
          : undefined,
      ),
    )
    .orderBy(asc(directoryProject.name), asc(directoryProject.id));
  const out = new Map<number, ProjectRef[]>();
  for (const row of rows) {
    const list = out.get(row.userId) ?? [];
    list.push({ name: row.name, track: row.track });
    out.set(row.userId, list);
  }
  return out;
}

/**
 * The staff table (F47): the enrolled, plus anyone who left but still holds a
 * grade here, each with their course, projects and current grade. Sorted by
 * surname then name; the screen re-sorts.
 */
export async function readProjectGrades(
  db: Db,
  offeringId: number,
  homeId: string,
): Promise<GradeRow[]> {
  const [enrolled, grades, projects] = await Promise.all([
    db
      .select({
        studentId: directoryUser.id,
        name: directoryUser.name,
        surname: directoryUser.surname,
        course: directoryCourse.name,
      })
      .from(directoryEnrollment)
      .innerJoin(
        directoryUser,
        eq(directoryUser.id, directoryEnrollment.studentId),
      )
      .innerJoin(
        directoryCourse,
        eq(directoryCourse.id, directoryEnrollment.courseId),
      )
      .where(eq(directoryEnrollment.offeringId, offeringId)),
    currentGrades(db, homeId),
    projectsByStudent(db, offeringId),
  ]);

  const gradeOf = new Map(grades.map((row) => [row.studentId, row]));
  const rows = new Map<number, GradeRow>();
  const row = (
    person: { studentId: number; name: string | null; surname: string | null },
    course: string | null,
    isEnrolled: boolean,
  ): GradeRow => {
    const grade = gradeOf.get(person.studentId);
    return {
      ...person,
      course,
      projects: projects.get(person.studentId) ?? [],
      enrolled: isEnrolled,
      grade: grade
        ? { value: grade.value as ProjectGradeValue, visible: grade.visible }
        : null,
    };
  };
  for (const person of enrolled) {
    rows.set(person.studentId, row(person, person.course, true));
  }
  const departed = grades
    .map((grade) => grade.studentId)
    .filter((id) => !rows.has(id));
  if (departed.length > 0) {
    const people = await db
      .select({
        studentId: directoryUser.id,
        name: directoryUser.name,
        surname: directoryUser.surname,
      })
      .from(directoryUser)
      .where(inArray(directoryUser.id, departed));
    for (const person of people) {
      rows.set(person.studentId, row(person, null, false));
    }
  }
  return [...rows.values()].sort(
    (a, b) =>
      (a.surname ?? "").localeCompare(b.surname ?? "", "es") ||
      (a.name ?? "").localeCompare(b.name ?? "", "es"),
  );
}

/**
 * The student's own (F50): their grade **only when visible**, else `null` —
 * hidden and ungraded must read the same, or the eye leaks. With their
 * projects, which the tab shows as context.
 */
export async function myProjectGrade(
  db: Db,
  offeringId: number,
  homeId: string,
  studentId: number,
): Promise<{ grade: ProjectGradeValue | null; projects: ProjectRef[] }> {
  const [[current], projects] = await Promise.all([
    currentGrades(db, homeId, studentId),
    projectsByStudent(db, offeringId, [studentId]),
  ]);
  return {
    grade:
      current && current.visible ? (current.value as ProjectGradeValue) : null,
    projects: projects.get(studentId) ?? [],
  };
}

/* ── Writing ─────────────────────────────────────────────────────────────── */

export type ProjectGradeInput =
  | { studentId: number; clear: true }
  | {
      studentId: number;
      clear: false;
      value: ProjectGradeValue;
      visible: boolean;
    };

/**
 * One request for a cell and for a bulk flip (F47): entries nobody sent are
 * untouched, `value: null` clears. Students must be enrolled or already hold
 * a grade here — the trust boundary `saveOfficialGrades` draws, since the ids
 * come from the body. One insert and one delete, in one transaction.
 */
export async function saveProjectGrades(
  db: Db,
  offeringId: number,
  homeId: string,
  entries: ProjectGradeInput[],
  recordedBy: number,
): Promise<void> {
  if (entries.length === 0) return;
  const ids = entries.map((entry) => entry.studentId);
  const [enrolled, holders] = await Promise.all([
    db
      .select({ id: directoryEnrollment.studentId })
      .from(directoryEnrollment)
      .where(
        and(
          eq(directoryEnrollment.offeringId, offeringId),
          inArray(directoryEnrollment.studentId, ids),
        ),
      ),
    db
      .selectDistinct({ id: projectGrade.studentId })
      .from(projectGrade)
      .where(
        and(
          eq(projectGrade.offeringHomeId, homeId),
          inArray(projectGrade.studentId, ids),
        ),
      ),
  ]);
  const writable = new Set([...enrolled, ...holders].map((row) => row.id));
  if (!ids.every((id) => writable.has(id))) {
    throw new ApiError(
      400,
      "not_enrolled",
      "Alguien de esa lista no cursa esta materia.",
    );
  }

  const rows = entries.flatMap((entry) =>
    entry.clear
      ? []
      : [
          {
            offeringHomeId: homeId,
            studentId: entry.studentId,
            value: entry.value,
            visible: entry.visible,
            recordedBy,
          },
        ],
  );
  const clears = entries
    .filter((entry) => entry.clear)
    .map((entry) => entry.studentId);
  await db.transaction(async (tx) => {
    if (rows.length > 0) await tx.insert(projectGrade).values(rows);
    if (clears.length > 0) {
      await tx
        .delete(projectGrade)
        .where(
          and(
            eq(projectGrade.offeringHomeId, homeId),
            inArray(projectGrade.studentId, clears),
          ),
        );
    }
  });
}

/** The body, client-supplied: `{ entries: [{ studentId, value, visible }] }`. */
export function checkProjectGrades(raw: unknown): ProjectGradeInput[] {
  const entries = (raw as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) {
    throw new ApiError(400, "invalid_body", "Esperábamos una lista de notas.");
  }
  // A rotation is ~60 students; this is only a bound.
  if (entries.length > 1000) {
    throw new ApiError(400, "invalid_body", "Son demasiadas notas de una vez.");
  }
  const checked = entries.map((item): ProjectGradeInput => {
    const entry = (item ?? {}) as Record<string, unknown>;
    const { studentId, value, visible } = entry;
    if (
      typeof studentId !== "number" ||
      !Number.isInteger(studentId) ||
      studentId < 1
    ) {
      throw new ApiError(400, "invalid_body", "Falta el id de alguien.");
    }
    if (!("value" in entry)) {
      throw new ApiError(
        400,
        "invalid_body",
        "Cada nota lleva `value` — y `value: null` para borrarla.",
      );
    }
    if (value === null) return { studentId, clear: true };
    if (!PROJECT_GRADES.includes(value as ProjectGradeValue)) {
      throw new ApiError(
        400,
        "invalid_body",
        `La nota es una de ${PROJECT_GRADES.join(", ")}.`,
      );
    }
    if (typeof visible !== "boolean") {
      throw new ApiError(400, "invalid_body", "`visible` es true o false.");
    }
    return {
      studentId,
      clear: false,
      value: value as ProjectGradeValue,
      visible,
    };
  });
  // One entry per student, the last winning: two rows with the same `now()`
  // would be a tie nothing decides (`checkGrades`' guard).
  return [
    ...new Map(checked.map((entry) => [entry.studentId, entry])).values(),
  ];
}
