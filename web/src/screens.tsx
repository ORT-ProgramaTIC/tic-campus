/**
 * The small screens; the shell, the student page and the Cronograma have
 * their own files.
 */

/** `/proyecto` for someone who takes no Proyecto this year. */
export function NoProyecto() {
  return (
    <p className="rounded-3xl border border-line bg-card p-6 text-ink-muted">
      No tenés Proyecto este año.
    </p>
  );
}
