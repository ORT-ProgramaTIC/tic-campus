import {
  createBrowserRouter,
  Outlet,
  redirect,
  useRouteLoaderData,
  type LoaderFunctionArgs,
} from "react-router";
import { ApiError } from "./api/client.ts";
import {
  meQuery,
  myOfferingsQuery,
  offeringQuery,
  queryClient,
  useMyOfferings,
} from "./api/queries.ts";
import type { MyOffering, ResolvedOffering } from "./api/types.ts";
import { Cronograma, NoProyecto, Presentaciones, Shell } from "./screens.tsx";

/**
 * The 2026 slice of the web (`../presentations-gui.md`): the shell with only
 * Proyecto live, and F45's two screens. Routes and data only — every element
 * comes from `screens.tsx`, which is the GUI's (F44).
 *
 * Loaders `ensureQueryData` the same keys the screens read with hooks, so a
 * screen never fetches what its route already did.
 */

/**
 * Which offerings are Proyecto.
 * ponytail: matched by subject name, which F17 says no code should do — there
 * are no special subjects. The upgrade is `/api/offerings/mine` carrying each
 * home's `sections` and the header listing those with `presentations` on.
 */
export function isProyecto(offering: MyOffering): boolean {
  return offering.subjectName === "Proyecto";
}

/** The rotation switcher's list: every Proyecto offering of the caller's. */
export function useProyectoOfferings(): MyOffering[] {
  return (useMyOfferings().data ?? []).filter(isProyecto);
}

/** The offering the current URL names, resolved by its layout route — with
 *  `can` (does the teacher page show) and `sections`. */
export function useOffering(): ResolvedOffering {
  return useRouteLoaderData("offering") as ResolvedOffering;
}

function resolve({ params }: LoaderFunctionArgs) {
  return queryClient.ensureQueryData(
    offeringQuery(params.year!, params.subject!, params.offering!),
  );
}

export const router = createBrowserRouter([
  {
    id: "root",
    element: <Shell />,
    // Signed in or off to the login: every route below needs a session, and
    // asking once here is what makes the 401 a redirect rather than a screen.
    loader: async () => {
      try {
        return await queryClient.ensureQueryData(meQuery);
      } catch (cause) {
        // `api()` already sent the browser to the login. Never settle, so
        // nothing renders an error for the moment the page is still here.
        if (cause instanceof ApiError && cause.status === 401) {
          return new Promise<never>(() => {});
        }
        throw cause;
      }
    },
    children: [
      // The only live header item this year.
      { index: true, loader: () => redirect("/proyecto") },
      {
        path: "proyecto",
        element: <NoProyecto />,
        // One offering, or the first of a teacher's rotations (the switcher
        // has the rest): straight to its presentations. None: `NoProyecto`.
        loader: async () => {
          const mine = await queryClient.ensureQueryData(myOfferingsQuery);
          const first = mine.find(isProyecto);
          return first ? redirect(`${first.path}/presentaciones`) : null;
        },
      },
      {
        id: "offering",
        path: ":year/:subject/:offering",
        element: <Outlet />,
        loader: resolve,
        children: [
          { path: "presentaciones", element: <Presentaciones /> },
          {
            path: "presentaciones/cronograma",
            element: <Cronograma />,
            // Staff of this offering only; anyone else gets the student page
            // rather than a refusal, since that is what they came for.
            loader: async (args) => {
              const offering = await resolve(args);
              return offering.can.manageOffering
                ? null
                : redirect(`${offering.path}/presentaciones`);
            },
          },
        ],
      },
    ],
  },
]);
