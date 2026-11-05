import type { GradeRow, ProjectGradeValue } from "./api/types.ts";
import { trackLabel } from "./labels.ts";
import { matches } from "./text.ts";

/** The Proyecto grades (F46–F50): what they are called, how they look, and the
 *  staff table's search and sort, kept out of the screens so they are tested. */

export const PROJECT_GRADES: readonly ProjectGradeValue[] = [
  "10",
  "9",
  "8",
  "7",
  "6",
  "pia",
  "diciembre",
];

export const gradeLabel = (value: ProjectGradeValue) =>
  value === "pia" ? "PIA" : value === "diciembre" ? "DICIEMBRE" : value;

/** The staff table's scale (F47): 10 green to 6 yellow, PIA orange,
 *  DICIEMBRE red. Literal class names, so Tailwind finds them. */
export const GRADE_TONE: Record<ProjectGradeValue, string> = {
  "10": "bg-grade-10 text-grade-10-ink",
  "9": "bg-grade-9 text-grade-9-ink",
  "8": "bg-grade-8 text-grade-8-ink",
  "7": "bg-grade-7 text-grade-7-ink",
  "6": "bg-grade-6 text-grade-6-ink",
  pia: "bg-grade-pia text-grade-pia-ink",
  diciembre: "bg-grade-diciembre text-grade-diciembre-ink",
};

/** The student's own page (F50): every number green, only PIA and DICIEMBRE
 *  apart — passed or not is the distinction that matters there. */
export const studentGradeTone = (value: ProjectGradeValue) =>
  value === "pia" || value === "diciembre"
    ? GRADE_TONE[value]
    : GRADE_TONE["10"];

/**
 * A track's chip (F49): tic-registry's `subjectColor`
 * (`web/src/lib/timetableColors.ts`), keyed by label because track labels are
 * the seminar subject names. Unmapped tracks (Fullstack) take a stable hashed
 * fallback, as there.
 */
const TRACK_TONE: Record<string, string> = {
  Hardware: "bg-tag-hardware text-white",
  Frontend: "bg-subject-frontend text-white",
  Backend: "bg-tag-app text-tag-ink",
  TIMI: "bg-tag-arte text-tag-ink",
  IA: "bg-tag-ia text-tag-ink",
  "Desarrollo de Videojuegos": "bg-tag-juegos text-tag-ink",
  IOT: "bg-tag-iot text-tag-ink",
  "UX/UI": "bg-tag-impacto-social text-white",
  "Arte de Videojuegos": "bg-tag-rv text-tag-ink",
};
const FALLBACK_TONE = [
  "bg-tag-satelite text-tag-ink",
  "bg-tag-blockchain text-white",
  "bg-tag-3d text-white",
];

export function trackTone(track: string): string {
  const label = trackLabel(track);
  const known = TRACK_TONE[label];
  if (known) return known;
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  }
  return FALLBACK_TONE[hash % FALLBACK_TONE.length]!;
}

/* ── The staff table ─────────────────────────────────────────────────────── */

export type SearchBy = "student" | "project";

export function searchRows(
  rows: GradeRow[],
  by: SearchBy,
  query: string,
): GradeRow[] {
  return rows.filter((row) =>
    matches(
      by === "student"
        ? `${row.name ?? ""} ${row.surname ?? ""}`
        : row.projects.map((project) => project.name).join(" "),
      query,
    ),
  );
}

export type SortKey = "surname" | "name" | "course" | "project" | "track";
export type Sort = { key: SortKey; dir: "asc" | "desc" };

const sortValue = (row: GradeRow, key: SortKey): string | null => {
  switch (key) {
    case "surname":
      return row.surname;
    case "name":
      return row.name;
    case "course":
      return row.course;
    case "project":
      return row.projects[0]?.name ?? null;
    case "track":
      return row.projects[0] ? trackLabel(row.projects[0].track) : null;
  }
};

/** One column, either way, **blanks last in both directions**; ties fall back
 *  to surname then name so the order never jumps. */
export function sortRows(rows: GradeRow[], { key, dir }: Sort): GradeRow[] {
  const sign = dir === "asc" ? 1 : -1;
  const byName = (a: GradeRow, b: GradeRow) =>
    (a.surname ?? "").localeCompare(b.surname ?? "", "es") ||
    (a.name ?? "").localeCompare(b.name ?? "", "es");
  return [...rows].sort((a, b) => {
    const x = sortValue(a, key) || null;
    const y = sortValue(b, key) || null;
    if (x === null || y === null) {
      if (x !== y) return x === null ? 1 : -1;
      return byName(a, b);
    }
    return sign * x.localeCompare(y, "es") || byName(a, b);
  });
}

/** `NR4A` → `4A`, `rotationName`'s rule. */
export const shortCourse = (course: string | null) =>
  course ? course.slice(-2) : "";
