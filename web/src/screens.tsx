import { Outlet } from "react-router";

/**
 * The GUI's slots (F44) — **yours to replace**, each one mounted by
 * `router.tsx`. They hold no markup on purpose: the shell, the student page
 * and the teacher page are designed by hand, and the brand is still open
 * (F43). `../presentations-gui.md` says what each one shows and which data
 * it reads.
 *
 * Data, from `api/queries.ts` and `router.tsx`: `useMe`, `useLogout`,
 * `useProyectoOfferings` (the rotation switcher), `useOffering` (the URL's
 * offering, with `can`), `usePresentations(offeringId)`, `useSaveSchedule`,
 * `useSetState`.
 *
 * Errors a loader throws (a 403 or 404 from the api, as an `ApiError`) land
 * on React Router's default error element until a route grows its own
 * `errorElement`.
 */

/** The thin header (Proyecto, profile) and the local nav. Keep the
 *  `<Outlet />`: it is where the page renders. */
export function Shell() {
  return <Outlet />;
}

/** `/proyecto` for someone who takes no Proyecto this year. */
export function NoProyecto() {
  return null;
}

/** The student page: the banner and the order. */
export function Presentaciones() {
  return null;
}

/** The teacher page: blocks, slots, the queue, the save bar. */
export function Cronograma() {
  return null;
}
