import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Eye,
  EyeOff,
  Search,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { projectGradesQuery, useSaveProjectGrades } from "./api/queries.ts";
import type { GradeRow, ProjectGradeValue } from "./api/types.ts";
import {
  GRADE_TONE,
  gradeLabel,
  PROJECT_GRADES,
  searchRows,
  shortCourse,
  sortRows,
  trackTone,
  type SearchBy,
  type Sort,
  type SortKey,
} from "./grades.ts";
import { trackLabel } from "./labels.ts";
import { Rotations } from "./rotations.tsx";
import { useOffering } from "./router.tsx";

/**
 * Notas (F47, F48): the rotation's roster with each student's Proyecto grade
 * and whether they can see it. Only the grade and its visibility are
 * editable; every change saves at once.
 */
export function Notas() {
  const offering = useOffering();
  const query = useQuery(projectGradesQuery(offering.offeringId));
  const save = useSaveProjectGrades(offering.offeringId);
  const [by, setBy] = useState<SearchBy>("student");
  const [text, setText] = useState("");
  const [sort, setSort] = useState<Sort>({ key: "surname", dir: "asc" });

  const shown = useMemo(
    () => sortRows(searchRows(query.data?.rows ?? [], by, text), sort),
    [query.data, by, text, sort],
  );
  const locked = query.data?.locked ?? false;
  const graded = shown.filter((row) => row.grade !== null);
  const hidden = graded.filter((row) => !row.grade!.visible);
  const visible = graded.filter((row) => row.grade!.visible);

  const flip = (rows: GradeRow[], to: boolean) =>
    save.mutate(
      rows.map((row) => ({
        studentId: row.studentId,
        value: row.grade!.value,
        visible: to,
      })),
    );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-4">
        <div className="mr-auto">
          <p className="text-sm text-ink-muted">
            {offering.subjectName} · {offering.year}
          </p>
          <h1 className="mt-1 text-2xl font-semibold sm:text-3xl">Notas</h1>
        </div>
        <Rotations />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="relative">
          <span className="sr-only">Buscar por</span>
          <select
            value={by}
            onChange={(event) => setBy(event.target.value as SearchBy)}
            className="appearance-none rounded-xl border border-line bg-card py-2 pr-8 pl-3 text-sm font-medium"
          >
            <option value="student">Estudiante</option>
            <option value="project">Proyecto</option>
          </select>
          <ChevronDown
            className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-ink-muted"
            aria-hidden
          />
        </label>
        <label className="relative min-w-48 flex-1">
          <span className="sr-only">Buscar</span>
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-faint"
            aria-hidden
          />
          <input
            type="search"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={
              by === "student" ? "Buscar un estudiante" : "Buscar un proyecto"
            }
            className="w-full rounded-xl border border-line bg-card py-2 pr-3 pl-9 text-sm"
          />
        </label>
        {!locked && (
          <div className="flex gap-2">
            <BulkButton
              disabled={hidden.length === 0 || save.isPending}
              onClick={() => flip(hidden, true)}
            >
              <Eye className="size-4" aria-hidden /> Mostrar {hidden.length}
            </BulkButton>
            <BulkButton
              disabled={visible.length === 0 || save.isPending}
              onClick={() => flip(visible, false)}
            >
              <EyeOff className="size-4" aria-hidden /> Ocultar {visible.length}
            </BulkButton>
          </div>
        )}
      </div>

      {save.isError && (
        <p
          role="alert"
          className="rounded-2xl bg-grade-diciembre px-4 py-3 text-sm text-grade-diciembre-ink"
        >
          No se guardó: {save.error.message}
        </p>
      )}
      {locked && (
        <p className="rounded-2xl border border-line bg-card px-4 py-3 text-sm text-ink-muted">
          Este año ya cerró: las notas se ven pero no se cambian.
        </p>
      )}

      {query.isPending ? (
        <div className="h-96 animate-pulse rounded-2xl bg-card" />
      ) : query.isError ? (
        <p className="rounded-2xl border border-line bg-card p-6 text-ink-muted">
          {query.error.message}
        </p>
      ) : (
        // The reference's table (`../Reference/`, Payments): tall rows on
        // hairlines, the key column dark and the rest muted — under a black
        // header band, the kit's dark panels, rather than its tinted one.
        <div className="overflow-hidden rounded-2xl border border-line bg-card">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm whitespace-nowrap">
              <thead>
                <tr className="bg-onyx text-xs text-white/75">
                  <Header sort={sort} setSort={setSort} column="surname" sticky>
                    Apellido
                  </Header>
                  <Header sort={sort} setSort={setSort} column="name">
                    Nombre
                  </Header>
                  <Header sort={sort} setSort={setSort} column="course">
                    Curso
                  </Header>
                  <Header sort={sort} setSort={setSort} column="project">
                    Proyecto
                  </Header>
                  <Header sort={sort} setSort={setSort} column="track">
                    Rol
                  </Header>
                  <th scope="col" className="px-5 py-3 font-normal">
                    Nota
                  </th>
                  <th scope="col" className="px-5 py-3 font-normal">
                    Visible
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => (
                  <Row
                    key={row.studentId}
                    row={row}
                    locked={locked}
                    busy={save.isPending}
                    onSave={(entry) => save.mutate([entry])}
                  />
                ))}
                {shown.length === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-4 py-8 text-center text-ink-muted"
                    >
                      {text
                        ? "Nadie coincide con la búsqueda."
                        : "No hay estudiantes."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="border-t border-line px-5 py-3 text-xs text-ink-muted">
            {shown.length === query.data.rows.length
              ? count(shown.length, "estudiante", "estudiantes")
              : `${shown.length} de ${count(query.data.rows.length, "estudiante", "estudiantes")}`}{" "}
            · {count(graded.length, "con nota", "con nota")} ·{" "}
            {count(visible.length, "visible", "visibles")}
          </p>
        </div>
      )}
    </div>
  );
}

/** `1 visible` / `3 visibles`: both forms spelled out, since Spanish plurals
 *  are not always a trailing `s`. */
const count = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

function BulkButton(props: {
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      {...props}
      className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-card px-3 py-2 text-sm font-medium hover:bg-lilac-50 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-card"
    />
  );
}

function Header({
  column,
  sort,
  setSort,
  sticky,
  children,
}: {
  column: SortKey;
  sort: Sort;
  setSort: (sort: Sort) => void;
  sticky?: boolean;
  children: string;
}) {
  const active = sort.key === column;
  const Arrow = sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th
      scope="col"
      aria-sort={
        active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"
      }
      className={`px-5 py-3 font-normal ${sticky ? "sticky left-0 bg-onyx" : ""}`}
    >
      <button
        type="button"
        onClick={() =>
          setSort({
            key: column,
            dir: active && sort.dir === "asc" ? "desc" : "asc",
          })
        }
        className={`inline-flex items-center gap-1 hover:text-white ${active ? "font-medium text-white" : ""}`}
      >
        {children}
        <Arrow
          className={`size-3.5 ${active ? "" : "invisible"}`}
          aria-hidden
        />
      </button>
    </th>
  );
}

function Row({
  row,
  locked,
  busy,
  onSave,
}: {
  row: GradeRow;
  locked: boolean;
  busy: boolean;
  onSave: (
    entry:
      | { studentId: number; value: null }
      | { studentId: number; value: ProjectGradeValue; visible: boolean },
  ) => void;
}) {
  const who = [row.name, row.surname].filter(Boolean).join(" ") || "—";
  const grade = row.grade;
  return (
    <tr className="group border-b border-line last:border-0 hover:bg-lilac-50">
      <td className="sticky left-0 bg-card px-5 py-4 font-semibold group-hover:bg-lilac-50">
        {row.surname ?? "—"}
        {!row.enrolled && (
          <span className="ml-2 text-xs font-normal text-ink-faint">
            ya no cursa
          </span>
        )}
      </td>
      <td className="px-5 py-4">{row.name ?? "—"}</td>
      <td className="px-5 py-4 text-ink-muted tabular-nums">
        {shortCourse(row.course)}
      </td>
      <td className="px-5 py-4">
        {row.projects.map((project) => project.name).join(", ")}
      </td>
      <td className="px-5 py-4">
        <div className="flex flex-wrap gap-1">
          {row.projects.map((project) => (
            <span
              key={project.name}
              className={`rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap ${trackTone(project.track)}`}
            >
              {trackLabel(project.track)}
            </span>
          ))}
        </div>
      </td>
      <td className="px-5 py-4">
        {locked ? (
          grade ? (
            <span
              className={`inline-block rounded-md px-2 py-1 text-xs font-semibold ${GRADE_TONE[grade.value]}`}
            >
              {gradeLabel(grade.value)}
            </span>
          ) : (
            <span className="text-ink-faint">—</span>
          )
        ) : (
          <label
            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold focus-within:outline-2 focus-within:outline-lilac-500 ${
              grade
                ? GRADE_TONE[grade.value]
                : "bg-card text-ink-muted ring-1 ring-line ring-inset"
            }`}
          >
            <select
              value={grade?.value ?? ""}
              aria-label={`Nota de ${who}`}
              onChange={(event) => {
                const value = event.target.value as ProjectGradeValue | "";
                if (value === "") {
                  // A clear deletes the grade's whole history (F46).
                  if (window.confirm(`¿Borrar la nota de ${who}?`)) {
                    onSave({ studentId: row.studentId, value: null });
                  }
                  return;
                }
                onSave({
                  studentId: row.studentId,
                  value,
                  visible: grade?.visible ?? false,
                });
              }}
              className="cursor-pointer appearance-none bg-transparent outline-none"
            >
              <option value="">Sin nota</option>
              {PROJECT_GRADES.map((value) => (
                <option key={value} value={value}>
                  {gradeLabel(value)}
                </option>
              ))}
            </select>
            <ChevronDown className="size-3.5 shrink-0 opacity-70" aria-hidden />
          </label>
        )}
      </td>
      <td className="px-5 py-4">
        <button
          type="button"
          disabled={!grade || locked || busy}
          aria-pressed={grade?.visible ?? false}
          aria-label={`${grade?.visible ? "Ocultar" : "Mostrar"} la nota de ${who}`}
          title={
            !grade
              ? "Sin nota"
              : grade.visible
                ? "La ve el estudiante"
                : "Oculta para el estudiante"
          }
          onClick={() =>
            grade &&
            onSave({
              studentId: row.studentId,
              value: grade.value,
              visible: !grade.visible,
            })
          }
          className={`grid size-8 place-items-center rounded-full hover:bg-lilac-100 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent ${
            grade?.visible ? "text-lilac-700" : "text-ink-faint"
          }`}
        >
          {grade?.visible ? (
            <Eye className="size-4" aria-hidden />
          ) : (
            <EyeOff className="size-4" aria-hidden />
          )}
        </button>
      </td>
    </tr>
  );
}
