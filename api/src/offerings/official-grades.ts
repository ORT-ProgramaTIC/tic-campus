import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.js";
import { offeringTerm } from "../db/schema/gradebook.js";
import { officialGrade } from "../db/schema/official-grade.js";
import { isUuid } from "../library/program.js";
import { ApiError } from "../middleware/errors.js";
import { checkMark } from "./gradebook.js";
import { writableStudents } from "./results.js";

/**
 * The official grade (F22): the number a teacher **types** next to the one
 * campus computes, per student per term, with the observation and the
 * suggestion that go with it on the boletín.
 *
 * **It is visible the moment it exists** — see the note on the table for why
 * there is no third publish date, and why `resultsVisible` is not consulted.
 * That is the whole of the visibility rule here, which is why this file has no
 * equivalent of it: staff read it through `manageOffering` on the grid, a
 * student reads their own and nobody else's.
 *
 * **The save is the `result` shape and not the setup one.** Groups, terms and
 * scales are whole lists that never delete (F15's rule) because a client that
 * loaded a stale panel would otherwise wipe a colleague's row. This is a cell a
 * teacher touched, one student and one term at a time, so it follows
 * `saveResults`: entries nobody sent are untouched, and `value: null` is the
 * only way to empty one.
 */

export interface OfficialGrade {
  termId: string;
  studentId: number;
  value: number;
  observation: string | null;
  suggestion: string | null;
  recordedBy: number;
  recordedAt: Date;
}

/** Every official grade of the offering, for the grid — one query, joined to
 *  the home through its terms, never one per term or per student. */
export async function readOfficialGrades(
  db: Db,
  homeId: string,
): Promise<OfficialGrade[]> {
  return db
    .select({
      termId: officialGrade.offeringTermId,
      studentId: officialGrade.studentId,
      value: officialGrade.value,
      observation: officialGrade.observation,
      suggestion: officialGrade.suggestion,
      recordedBy: officialGrade.recordedBy,
      recordedAt: officialGrade.recordedAt,
    })
    .from(officialGrade)
    .innerJoin(
      offeringTerm,
      and(
        eq(offeringTerm.id, officialGrade.offeringTermId),
        eq(offeringTerm.offeringHomeId, homeId),
      ),
    )
    .orderBy(offeringTerm.position);
}

export interface MyOfficialGrade {
  termId: string;
  value: number;
  observation: string | null;
  suggestion: string | null;
}

/**
 * One student's own, in term order. **No publish filter, because there is no
 * publish date** — the row's existence is the decision (F22).
 *
 * No `recordedBy` and no `studentId`, the shape `myResults` already has: who
 * typed it is the teacher's column, and whose it is the student already knows.
 */
export async function myOfficialGrades(
  db: Db,
  homeId: string,
  studentId: number,
): Promise<MyOfficialGrade[]> {
  return db
    .select({
      termId: officialGrade.offeringTermId,
      value: officialGrade.value,
      observation: officialGrade.observation,
      suggestion: officialGrade.suggestion,
    })
    .from(officialGrade)
    .innerJoin(
      offeringTerm,
      and(
        eq(offeringTerm.id, officialGrade.offeringTermId),
        eq(offeringTerm.offeringHomeId, homeId),
      ),
    )
    .where(eq(officialGrade.studentId, studentId))
    .orderBy(offeringTerm.position);
}

/* ── Writing ─────────────────────────────────────────────────────────────── */

export interface GradeInput {
  studentId: number;
  termId: string;
  /** `value: null` — the only spelling of "empty this cell", and it takes the
   *  observation and the suggestion with it (see the note on the table). */
  clear: boolean;
  value?: number;
  observation: string | null;
  suggestion: string | null;
}

/**
 * The boletín column's save (F22), in the shape `saveResults` already has.
 *
 * Two things are checked before anything is written, and both are trust
 * boundaries rather than tidiness:
 *
 * - **every term is one of *this* home's.** The route gates `manageOffering` on
 *   the offering in the path; the term ids come from the body. Without this, a
 *   teacher of any offering writes boletín grades onto any other offering's
 *   term — the same hole `saveResults` closes for activity ids.
 * - **every student is enrolled or already carries something here**, which is
 *   `writableStudents` and not a second copy of F38's rule.
 *
 * Then **one** upsert and **one** delete, whatever the size of the batch.
 */
export async function saveOfficialGrades(
  db: Db | Tx,
  homeId: string,
  entries: GradeInput[],
  recordedBy: number,
): Promise<void> {
  if (entries.length === 0) return;

  const terms = await db
    .select({ id: offeringTerm.id })
    .from(offeringTerm)
    .where(
      and(
        eq(offeringTerm.offeringHomeId, homeId),
        inArray(
          offeringTerm.id,
          entries.map((entry) => entry.termId),
        ),
      ),
    );
  const known = new Set(terms.map((term) => term.id));
  for (const entry of entries) {
    if (!known.has(entry.termId)) {
      throw new ApiError(
        400,
        "unknown_term",
        "Algún trimestre no es de esta materia. Recargá el boletín.",
      );
    }
  }

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
    rows.push({
      studentId: entry.studentId,
      offeringTermId: entry.termId,
      value: entry.value!,
      observation: entry.observation,
      suggestion: entry.suggestion,
      recordedBy,
    });
  }

  if (rows.length > 0) {
    await db
      .insert(officialGrade)
      .values(rows)
      .onConflictDoUpdate({
        target: [officialGrade.offeringTermId, officialGrade.studentId],
        // Raw `excluded` for the reason `saveResults` gives: drizzle-orm 0.45
        // ships no helper, and interpolating a column renders
        // `excluded."official_grade"."value"`, which is not a thing.
        set: {
          value: sql`excluded."value"`,
          observation: sql`excluded."observation"`,
          suggestion: sql`excluded."suggestion"`,
          recordedBy: sql`excluded."recorded_by"`,
          // `defaultNow()` only fires on insert, and an overwritten grade is a
          // grade somebody set today.
          recordedAt: sql`now()`,
        },
      });
  }

  if (clears.length > 0) {
    await db
      .delete(officialGrade)
      .where(
        or(
          ...clears.map((entry) =>
            and(
              eq(officialGrade.offeringTermId, entry.termId),
              eq(officialGrade.studentId, entry.studentId),
            ),
          ),
        ),
      );
  }
}

/* ── What is accepted ────────────────────────────────────────────────────── */

export const MAX_TEXT = 2000;

/**
 * Bodies are client-supplied; this is the whole of what is accepted.
 *
 * **`value` must be present**, as a number or as `null`. An entry without it is
 * refused rather than read as "text only": an observation cannot outlive its
 * grade (see the note on the table), so a body that carried one alone would be
 * either a silent no-op or a lost grade, and both are worse than a `400`.
 */
export function checkGrades(raw: unknown): GradeInput[] {
  if (typeof raw !== "object" || raw === null) {
    throw new ApiError(400, "invalid_body", "Esperábamos un objeto.");
  }
  const { entries } = raw as Record<string, unknown>;
  if (!Array.isArray(entries)) {
    throw new ApiError(400, "invalid_body", "Esperábamos una lista de notas.");
  }
  // A boletín is students × terms, so this is far looser than it needs to be;
  // `express.json`'s 1 MB limit is the real bound, as it is for `PUT …/results`.
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
    if (!isUuid(entry.termId)) {
      throw new ApiError(400, "invalid_body", "Falta el id de un trimestre.");
    }
    const base = {
      studentId,
      termId: entry.termId,
      observation: checkText(entry.observation, "La observación"),
      suggestion: checkText(entry.suggestion, "La sugerencia"),
    };
    if (!("value" in entry)) {
      throw new ApiError(
        400,
        "invalid_body",
        "Cada nota lleva `value` — y `value: null` para borrarla.",
      );
    }
    if (entry.value === null) return { ...base, clear: true };
    return { ...base, clear: false, value: checkMark(entry.value) };
  });
}

/** The house text field: absent or `null` becomes `null`, anything else is a
 *  string of at most `MAX_TEXT`. Exported because F29's `reason` and
 *  `bonusTasks` are the same field, and `checkFeedback` in `results.ts` is
 *  already a second copy of it. */
export function checkText(raw: unknown, what: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || raw.length > MAX_TEXT) {
    throw new ApiError(
      400,
      "invalid_body",
      `${what} es texto de hasta ${MAX_TEXT} caracteres.`,
    );
  }
  return raw;
}
