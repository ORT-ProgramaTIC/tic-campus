import { inArray, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { directoryUser } from "../db/schema/directory.js";
import { checkMark, readSetup, type Setup } from "./gradebook.js";
import {
  readOfficialGrades,
  saveOfficialGrades,
  type GradeInput,
  type OfficialGrade,
} from "./official-grades.js";
import {
  gradebook,
  saveResults,
  writableStudents,
  type EntryInput,
  type Gradebook,
} from "./results.js";

/**
 * The gradebook as a CSV file, out and back in (F27).
 *
 * **Everything but the last two functions is pure**, and those two only read
 * the grid, hand it over, and write what comes back through `saveResults` and
 * `saveOfficialGrades`. There is no third write path.
 *
 * **The file is what es-AR Excel opens on a double click**: a UTF-8 BOM, `;`
 * between cells and a decimal comma. A `,` file with a decimal point is read
 * as well, and so is Latin-1, which is what an older Excel saves as "CSV".
 *
 * **Columns are matched on what is in brackets**, never on the title, so a
 * renamed activity still imports: `TP SQL [tp-sql]` is the activity whose slug
 * is `tp-sql`. An official grade is `1er trimestre [nota oficial]` — the tag
 * has a space, so it can never be a slug, and the term is named by its name,
 * which is unique per offering (F39).
 */

export const OFFICIAL_TAG = "nota oficial";
const DONE = "hecho";
const NOT_DONE = "no hecho";

/* ── Bytes and cells ─────────────────────────────────────────────────────── */

/** UTF-8 with or without a BOM, and Latin-1 when the bytes are not UTF-8. A
 *  Latin-1 file that happens to be valid UTF-8 is pure ASCII, where the two
 *  agree, so the order cannot misread one. */
export function decodeCsv(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("latin1").decode(bytes);
  }
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

/**
 * RFC 4180, with the separator taken from the header line: `;` if it has one,
 * `,` otherwise. Quoted cells may hold the separator, `""` and line breaks.
 * Blank lines are dropped — Excel leaves them at the end of a file.
 */
export function parseCsv(text: string): string[][] {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const sep = firstLine.includes(";") ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  row.push(cell);
  rows.push(row);
  return rows.filter((cells) => cells.some((value) => value.trim() !== ""));
}

/** The export's dialect: BOM, `;`, CRLF, and quotes only where needed. */
export function writeCsv(rows: string[][]): string {
  const quote = (cell: string) =>
    /[;"\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
  return (
    "\uFEFF" + rows.map((row) => row.map(quote).join(";")).join("\r\n") + "\r\n"
  );
}

/** A text cell a spreadsheet would run as a formula gets a `'` in front. Only
 *  names and titles pass through here, and the import ignores both, so the
 *  round trip never sees it. */
function inert(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

/* ── Columns ─────────────────────────────────────────────────────────────── */

export type Column =
  | { kind: "id" }
  | { kind: "dni" }
  | { kind: "ignored" }
  | { kind: "activity"; slug: string }
  | { kind: "official"; term: string };

/** What a header cell names, or `null` for one it does not recognise. */
export function parseHeader(raw: string): Column | null {
  const cell = raw.trim();
  const plain = cell.toLowerCase();
  if (plain === "id") return { kind: "id" };
  if (plain === "dni") return { kind: "dni" };
  if (plain === "apellido" || plain === "nombre") return { kind: "ignored" };
  const tagged = /^(.*?)\s*\[([^\]]*)\]$/.exec(cell);
  if (!tagged) return null;
  const [, before, inside] = tagged;
  const tag = inside.trim();
  if (tag.toLowerCase() === OFFICIAL_TAG) {
    // `inert` may have put a `'` in front of the name on the way out.
    const term = before.replace(/^'(?=[=+\-@\t\r])/, "");
    return term ? { kind: "official", term } : null;
  }
  return /^[a-z0-9-]+$/.test(tag) ? { kind: "activity", slug: tag } : null;
}

/* ── Export ──────────────────────────────────────────────────────────────── */

/**
 * The enrolled students only (F27): somebody who left is still in the grid,
 * flagged, but a file a teacher passes around is the class as it is.
 * No computed marks (F20) — they are the formula's, not the teacher's.
 */
export function exportGradebook(
  setup: Setup,
  grid: Gradebook,
  officialGrades: OfficialGrade[],
  dnis: Map<number, string | null>,
): string {
  const levelNames = levelNamesOf(setup);
  const marks = new Map(
    grid.results.map((mark) => [`${mark.studentId}:${mark.activityId}`, mark]),
  );
  const grades = new Map(
    officialGrades.map((grade) => [
      `${grade.studentId}:${grade.termId}`,
      grade,
    ]),
  );
  const header = [
    "Id",
    "DNI",
    "Apellido",
    "Nombre",
    ...grid.activities.map((a) => `${inert(a.title)} [${a.slug}]`),
    ...setup.terms.map((term) => `${inert(term.name)} [${OFFICIAL_TAG}]`),
  ];
  const rows = grid.students
    .filter((student) => student.enrolled)
    .map((student) => [
      String(student.id),
      dnis.get(student.id) ?? "",
      inert(student.surname ?? ""),
      inert(student.name ?? ""),
      ...grid.activities.map((activity) => {
        const mark = marks.get(`${student.id}:${activity.id}`);
        return mark ? spell(activity.valueType, mark, levelNames) : "";
      }),
      ...setup.terms.map((term) => {
        const grade = grades.get(`${student.id}:${term.id}`);
        return grade ? number(grade.value) : "";
      }),
    ]);
  return writeCsv([header, ...rows]);
}

function levelNamesOf(setup: Setup): Map<string, string> {
  return new Map(
    setup.scales.flatMap((scale) =>
      scale.levels.map((level) => [level.id, level.name] as const),
    ),
  );
}

function spell(
  valueType: string,
  mark: { value: number; scaleLevelId: string | null },
  levelNames: Map<string, string>,
): string {
  if (valueType === "done") return mark.value === 1 ? DONE : NOT_DONE;
  if (valueType === "scale" && mark.scaleLevelId) {
    return levelNames.get(mark.scaleLevelId) ?? number(mark.value);
  }
  return number(mark.value);
}

/** The decimal comma, which is what es-AR Excel reads as a number. */
function number(value: number): string {
  return String(value).replace(".", ",");
}

/* ── Import ──────────────────────────────────────────────────────────────── */

export interface Change {
  studentId: number;
  surname: string | null;
  name: string | null;
  column:
    | { kind: "activity"; activityId: string; slug: string; title: string }
    | { kind: "official"; termId: string; term: string };
  /** Spelled the way the file spells it, so a screen shows it as is. */
  from: string | null;
  to: string;
}

export interface Problem {
  /** The file's own line number, header included: what the spreadsheet shows
   *  in its margin. */
  row: number | null;
  column: string | null;
  code: string;
  message: string;
}

export interface ImportDiff {
  changes: Change[];
  problems: Problem[];
  /** Cells that already say what the file says. Counted and never written:
   *  `result` is append-only (F41), so a re-save would be a history row saying
   *  somebody re-marked the class. */
  unchanged: number;
  /** The write set — exactly `changes`, as the two save functions take it. */
  entries: EntryInput[];
  grades: GradeInput[];
}

/** Who a row names, so the route can look them up in one query before
 *  `diffImport` runs. */
export function studentKeys(rows: string[][]): {
  ids: number[];
  dnis: string[];
} {
  const columns = (rows[0] ?? []).map(parseHeader);
  const idAt = columns.findIndex((column) => column?.kind === "id");
  const dniAt = columns.findIndex((column) => column?.kind === "dni");
  const ids = new Set<number>();
  const dnis = new Set<string>();
  for (const row of rows.slice(1)) {
    const id = idAt >= 0 ? idOf(row[idAt] ?? "") : null;
    const dni = dniAt >= 0 ? dniOf(row[dniAt] ?? "") : null;
    if (id !== null) ids.add(id);
    if (dni !== null) dnis.add(dni);
  }
  return { ids: [...ids], dnis: [...dnis] };
}

function idOf(raw: string): number | null {
  const cell = raw.trim();
  return /^\d{1,9}$/.test(cell) ? Number(cell) : null;
}

/** Excel shows a DNI as `12.345.678` the moment somebody formats the column. */
function dniOf(raw: string): string | null {
  const cell = raw.replace(/[.\s]/g, "");
  return /^\d{7,9}$/.test(cell) ? cell : null;
}

/**
 * The file against the grid: every cell that would change, and every problem.
 * **The diff is also the write set** — an unchanged cell is counted, never
 * written — and an empty cell leaves the mark alone, because clearing deletes
 * a pair's history (F38) and stays a grid action.
 *
 * `people` is `directory.user` for every id and DNI the file names, which is
 * what tells "nobody by that id" apart from "somebody who is not in this
 * class". `writable` is `writableStudents`, the set the saves will enforce.
 */
export function diffImport(input: {
  rows: string[][];
  setup: Setup;
  grid: Gradebook;
  officialGrades: OfficialGrade[];
  people: { id: number; dni: string | null }[];
  writable: Set<number>;
}): ImportDiff {
  const { rows, setup, grid, officialGrades, people, writable } = input;
  const diff: ImportDiff = {
    changes: [],
    problems: [],
    unchanged: 0,
    entries: [],
    grades: [],
  };
  const problem = (
    row: number | null,
    column: string | null,
    code: string,
    message: string,
  ) => diff.problems.push({ row, column, code, message });

  const [header, ...body] = rows;
  if (!header) {
    problem(
      null,
      null,
      "bad_file",
      "El archivo está vacío. Esperábamos un CSV con una fila de títulos.",
    );
    return diff;
  }

  /* The header: what each column is. */
  const activities = new Map(grid.activities.map((a) => [a.slug, a]));
  const terms = new Map(setup.terms.map((term) => [term.name, term]));
  type Target =
    | { kind: "activity"; activity: Gradebook["activities"][number] }
    | { kind: "official"; term: Setup["terms"][number] };
  const targets: (Target | null)[] = [];
  let idAt = -1;
  let dniAt = -1;
  const seen = new Set<string>();
  header.forEach((cell, at) => {
    targets.push(null);
    if (cell.trim() === "") return;
    const column = parseHeader(cell);
    const key =
      column?.kind === "activity"
        ? `a:${column.slug}`
        : column?.kind === "official"
          ? `o:${column.term}`
          : (column?.kind ?? "");
    if (column && column.kind !== "ignored") {
      if (seen.has(key)) {
        problem(1, cell, "duplicate_column", "Esa columna está dos veces.");
        return;
      }
      seen.add(key);
    }
    if (column?.kind === "id") idAt = at;
    else if (column?.kind === "dni") dniAt = at;
    else if (column?.kind === "activity" && activities.has(column.slug)) {
      targets[at] = {
        kind: "activity",
        activity: activities.get(column.slug)!,
      };
    } else if (column?.kind === "official" && terms.has(column.term)) {
      targets[at] = { kind: "official", term: terms.get(column.term)! };
    } else if (column?.kind !== "ignored") {
      problem(
        1,
        cell,
        "unknown_column",
        "No reconocemos esa columna. Cada actividad va como «Título [slug]» y " +
          `cada nota oficial como «Trimestre [${OFFICIAL_TAG}]»; exportá el ` +
          "boletín de nuevo para ver los nombres de hoy.",
      );
    }
  });
  if (idAt < 0 && dniAt < 0) {
    problem(
      1,
      null,
      "no_student_key",
      "Falta la columna «Id» o «DNI»: sin ella no sabemos de quién es cada fila.",
    );
    return diff;
  }

  /* The rows: who each one is, then what each cell says. */
  const byId = new Map(people.map((person) => [person.id, person]));
  const byDni = new Map(
    people.flatMap((person) =>
      person.dni ? [[person.dni, person] as const] : [],
    ),
  );
  const students = new Map(grid.students.map((s) => [s.id, s]));
  const marks = new Map(
    grid.results.map((mark) => [`${mark.studentId}:${mark.activityId}`, mark]),
  );
  const grades = new Map(
    officialGrades.map((grade) => [
      `${grade.studentId}:${grade.termId}`,
      grade,
    ]),
  );
  const levelNames = levelNamesOf(setup);
  const levelsByScale = new Map(
    setup.scales.map((scale) => [scale.id, scale.levels]),
  );
  const rowOf = new Map<number, number>();

  body.forEach((cells, index) => {
    const line = index + 2;
    const idCell = idAt >= 0 ? (cells[idAt] ?? "").trim() : "";
    const dniCell = dniAt >= 0 ? (cells[dniAt] ?? "").trim() : "";
    let studentId: number;
    if (idCell !== "") {
      const id = idOf(idCell);
      const person = id === null ? undefined : byId.get(id);
      if (!person) {
        problem(line, "Id", "unknown_student", "No hay nadie con ese id.");
        return;
      }
      studentId = person.id;
    } else if (dniCell !== "") {
      const dni = dniOf(dniCell);
      const person = dni === null ? undefined : byDni.get(dni);
      if (!person) {
        problem(line, "DNI", "unknown_student", "No hay nadie con ese DNI.");
        return;
      }
      studentId = person.id;
    } else {
      problem(line, null, "no_student_key", "Esta fila no tiene ni Id ni DNI.");
      return;
    }
    if (!writable.has(studentId)) {
      problem(line, null, "not_writable", "Esa persona no cursa esta materia.");
      return;
    }
    const earlier = rowOf.get(studentId);
    if (earlier !== undefined) {
      problem(
        line,
        null,
        "duplicate_student",
        `Esta persona ya aparece en la fila ${earlier}.`,
      );
      return;
    }
    rowOf.set(studentId, line);
    const student = students.get(studentId);
    const who = {
      studentId,
      surname: student?.surname ?? null,
      name: student?.name ?? null,
    };

    targets.forEach((target, at) => {
      const cell = (cells[at] ?? "").trim();
      if (!target || cell === "") return;
      const bad = (message: string) =>
        problem(line, header[at], "bad_value", message);

      if (target.kind === "official") {
        const value = markOf(cell);
        if (value === null)
          return bad("La nota oficial va de 1 a 10, con hasta dos decimales.");
        const current = grades.get(`${studentId}:${target.term.id}`);
        if (current && same(current.value, value)) {
          diff.unchanged++;
          return;
        }
        diff.changes.push({
          ...who,
          column: {
            kind: "official",
            termId: target.term.id,
            term: target.term.name,
          },
          from: current ? number(current.value) : null,
          to: number(value),
        });
        // The texts are not in the file, so a changed grade keeps them.
        diff.grades.push({
          studentId,
          termId: target.term.id,
          clear: false,
          value,
          observation: current?.observation ?? null,
          suggestion: current?.suggestion ?? null,
        });
        return;
      }

      const { activity } = target;
      const current = marks.get(`${studentId}:${activity.id}`);
      let entry: EntryInput;
      let isSame: boolean;
      const base = {
        studentId,
        activityId: activity.id,
        clear: false,
        // Not in the file, so a changed mark keeps it.
        feedback: current?.feedback ?? null,
      };
      if (activity.valueType === "numeric") {
        const value = markOf(cell);
        if (value === null)
          return bad("Esa nota va de 1 a 10, con hasta dos decimales.");
        entry = { ...base, value };
        isSame = current !== undefined && same(current.value, value);
      } else if (activity.valueType === "done") {
        const said = cell.toLowerCase();
        if (said !== DONE && said !== NOT_DONE) {
          return bad(`Esa actividad va con «${DONE}» o «${NOT_DONE}».`);
        }
        const done = said === DONE;
        entry = { ...base, done };
        isSame = current !== undefined && current.value === (done ? 1 : 0);
      } else {
        const levels = levelsByScale.get(activity.scaleId ?? "") ?? [];
        const level = levels.find(
          (candidate) => candidate.name.toLowerCase() === cell.toLowerCase(),
        );
        if (!level) {
          return bad(
            `Esa actividad va con un nivel de su escala: ${levels
              .map((candidate) => `«${candidate.name}»`)
              .join(", ")}.`,
          );
        }
        entry = { ...base, scaleLevelId: level.id };
        isSame = current?.scaleLevelId === level.id;
      }
      if (isSame) {
        diff.unchanged++;
        return;
      }
      diff.changes.push({
        ...who,
        column: {
          kind: "activity",
          activityId: activity.id,
          slug: activity.slug,
          title: activity.title,
        },
        from: current ? spell(activity.valueType, current, levelNames) : null,
        to:
          entry.scaleLevelId !== undefined
            ? levelNames.get(entry.scaleLevelId)!
            : entry.done !== undefined
              ? entry.done
                ? DONE
                : NOT_DONE
              : number(entry.value!),
      });
      diff.entries.push(entry);
    });
  });

  return diff;
}

/** `7`, `7,5` or `7.5`, through `checkMark` so the bound cannot drift from
 *  the grid's. */
function markOf(cell: string): number | null {
  if (!/^\d{1,2}([.,]\d+)?$/.test(cell)) return null;
  try {
    return checkMark(Number(cell.replace(",", ".")));
  } catch {
    return null;
  }
}

/** Marks carry two decimals, so that is where two of them are equal. */
function same(a: number, b: number): boolean {
  return Math.round(a * 100) === Math.round(b * 100);
}

/* ── Against the database ────────────────────────────────────────────────── */

/** The export, read. The DNIs are one query over the grid's ids — this is the
 *  first payload that carries one, because the import matches on it. */
export async function readExport(
  db: Db,
  homeId: string,
  offeringId: number,
): Promise<string> {
  const [setup, grid, officialGrades] = await Promise.all([
    readSetup(db, homeId),
    gradebook(db, homeId, offeringId),
    readOfficialGrades(db, homeId),
  ]);
  const ids = grid.students.map((student) => student.id);
  const dnis =
    ids.length === 0
      ? []
      : await db
          .select({ id: directoryUser.id, dni: directoryUser.dni })
          .from(directoryUser)
          .where(inArray(directoryUser.id, ids));
  return exportGradebook(
    setup,
    grid,
    officialGrades,
    new Map(dnis.map((row) => [row.id, row.dni])),
  );
}

/**
 * A file against the grid, and — given who is applying it — written.
 *
 * `recordedBy: null` is the dry run. Otherwise the file is applied **only when
 * it has no problem at all**, and the two saves share one transaction, so a
 * file lands whole or not at all: a term deleted between the read and the
 * write fails `saveOfficialGrades`' own check and takes the marks back with it.
 */
export async function importGradebook(
  db: Db,
  homeId: string,
  offeringId: number,
  bytes: Uint8Array,
  recordedBy: number | null,
): Promise<Omit<ImportDiff, "entries" | "grades"> & { applied: boolean }> {
  const rows = parseCsv(decodeCsv(bytes));
  const { ids, dnis } = studentKeys(rows);
  const [setup, grid, officialGrades, writable, people] = await Promise.all([
    readSetup(db, homeId),
    gradebook(db, homeId, offeringId),
    readOfficialGrades(db, homeId),
    writableStudents(db, homeId),
    ids.length + dnis.length === 0
      ? []
      : db
          .select({ id: directoryUser.id, dni: directoryUser.dni })
          .from(directoryUser)
          .where(
            or(
              ids.length > 0 ? inArray(directoryUser.id, ids) : undefined,
              dnis.length > 0 ? inArray(directoryUser.dni, dnis) : undefined,
            ),
          ),
  ]);
  const { entries, grades, ...diff } = diffImport({
    rows,
    setup,
    grid,
    officialGrades,
    people,
    writable,
  });
  if (recordedBy === null || diff.problems.length > 0) {
    return { applied: false, ...diff };
  }
  await db.transaction(async (tx) => {
    await saveResults(tx, homeId, entries, recordedBy);
    await saveOfficialGrades(tx, homeId, grades, recordedBy);
  });
  return { applied: true, ...diff };
}
