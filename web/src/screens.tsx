/**
 * The screens still to build (F45): `shell.tsx` and `presentaciones.tsx` are
 * done. Data, from `api/queries.ts` and `router.tsx`: `usePresentations`,
 * `useSaveSchedule`, `useSetState`, `useOffering`.
 */

/** `/proyecto` for someone who takes no Proyecto this year. */
export function NoProyecto() {
  return (
    <p className="rounded-3xl border border-line bg-card p-6 text-ink-muted">
      No tenés Proyecto este año.
    </p>
  );
}

/** The teacher page: blocks, slots, the queue, the save bar. */
export function Cronograma() {
  return null;
}
