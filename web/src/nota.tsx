import { useQuery } from "@tanstack/react-query";
import { useMe, myProjectGradeQuery } from "./api/queries.ts";
import { gradeLabel, studentGradeTone, trackTone } from "./grades.ts";
import { trackLabel } from "./labels.ts";
import { useOffering } from "./router.tsx";

/**
 * Nota (F50): the student's own Proyecto grade. Hidden and ungraded read the
 * same — the api answers `null` for both — so the eye cannot leak. No
 * rotation select: a student is graded only in their own rotation.
 */
export function Nota() {
  const offering = useOffering();
  const me = useMe().data!.me;
  const query = useQuery(myProjectGradeQuery(offering.offeringId));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm text-ink-muted">
          {offering.subjectName} · {offering.year}
        </p>
        <h1 className="mt-1 text-2xl font-semibold sm:text-3xl">
          Tu nota, {me.given_name ?? me.name ?? ""}
        </h1>
      </div>
      {query.isPending ? (
        <div className="h-52 w-full max-w-sm animate-pulse rounded-3xl bg-card" />
      ) : query.isError ? (
        <p className="rounded-3xl border border-line bg-card p-6 text-ink-muted">
          {query.error.message}
        </p>
      ) : (
        <section className="flex w-full max-w-sm flex-col items-center gap-5 rounded-3xl border border-line bg-card px-6 py-10 text-center">
          {query.data.grade === null ? (
            <p className="rounded-full bg-canvas px-5 py-2.5 text-lg font-semibold text-ink-muted">
              Pendiente Devolución
            </p>
          ) : (
            <p
              className={`rounded-3xl px-8 py-4 text-5xl font-bold tabular-nums ${studentGradeTone(query.data.grade)}`}
            >
              {gradeLabel(query.data.grade)}
            </p>
          )}
          {query.data.projects.length > 0 && (
            <ul className="flex flex-col items-center gap-2 text-sm">
              {query.data.projects.map((project) => (
                <li key={project.name} className="flex items-center gap-2">
                  <span className="font-medium">{project.name}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${trackTone(project.track)}`}
                  >
                    {trackLabel(project.track)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
