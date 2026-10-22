/**
 * The small screens; the shell, the student page and the Cronograma have
 * their own files.
 */

/** `/proyecto` when no Proyecto offering is activated this year. */
export function NoProyecto() {
  return (
    <p className="rounded-3xl border border-line bg-card p-6 text-ink-muted">
      Todavía no hay Proyecto este año.
    </p>
  );
}
