import {
  keepPreviousData,
  QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api, rememberCsrf } from "./client.ts";
import type {
  Me,
  MyOffering,
  OfferingSummary,
  PresentationState,
  PresentationsPayload,
  PreviewPayload,
  ResolvedOffering,
  ScheduleBody,
} from "./types.ts";

/**
 * Every read is a `queryOptions` object as well as a hook, so a route loader
 * can `ensureQueryData` the same key a screen then reads with no second
 * request (`router.tsx`).
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // An `ApiError` is a decision the api already made — a 403 does not get
      // better on the third try.
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

/* ── Reads ──────────────────────────────────────────────────────────────── */

export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: async () => {
    const me = await api<Me>("GET", "/api/me");
    rememberCsrf(me.csrf_token);
    return me;
  },
  staleTime: Infinity,
});

export const myOfferingsQuery = queryOptions({
  queryKey: ["offerings", "mine"],
  queryFn: () => api<MyOffering[]>("GET", "/api/offerings/mine"),
});

/** Every activated offering of the current year (F6). */
export const offeringsQuery = queryOptions({
  queryKey: ["offerings", "current"],
  queryFn: () => api<OfferingSummary[]>("GET", "/api/offerings"),
});

export const offeringQuery = (
  year: string,
  subject: string,
  offering: string,
) =>
  queryOptions({
    queryKey: ["offering", year, subject, offering],
    queryFn: () =>
      api<ResolvedOffering>(
        "GET",
        `/api/offerings/${encodeURIComponent(year)}/${encodeURIComponent(subject)}/${encodeURIComponent(offering)}`,
      ),
  });

/** Refetched every minute: estimates move as teams present, and the api
 *  computes them against its own clock on every read (F45). */
export const presentationsQuery = (offeringId: number) =>
  queryOptions({
    queryKey: ["presentations", offeringId],
    queryFn: () =>
      api<PresentationsPayload>(
        "GET",
        `/api/homes/${offeringId}/presentations`,
      ),
    refetchInterval: 60_000,
  });

export const useMe = () => useQuery(meQuery);
export const useMyOfferings = () => useQuery(myOfferingsQuery);
export const useOfferings = () => useQuery(offeringsQuery);
export const usePresentations = (offeringId: number) =>
  useQuery(presentationsQuery(offeringId));

/**
 * Where every team would land if `body` were saved; `null` asks nothing. The
 * previous answer stays on screen while the next one is on its way, so the
 * Cronograma does not flash empty on every edit.
 */
export function usePreview(offeringId: number, body: ScheduleBody | null) {
  return useQuery({
    queryKey: ["preview", offeringId, body],
    queryFn: () =>
      api<PreviewPayload>(
        "POST",
        `/api/homes/${offeringId}/presentations/preview`,
        body,
      ),
    enabled: body !== null,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
  });
}

/* ── Writes ─────────────────────────────────────────────────────────────── */

/**
 * Save the schedule whole. A `409 stale_schedule` arrives as an `ApiError`
 * with that `code`: the screen offers a reload, which is refetching
 * `presentationsQuery` and dropping its local edits.
 */
export function useSaveSchedule(offeringId: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: ScheduleBody) =>
      api<{ savedAt: string }>(
        "PUT",
        `/api/homes/${offeringId}/presentations`,
        body,
      ),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: ["presentations", offeringId] }),
  });
}

/**
 * One team's state, applied to the cache before the api answers and rolled
 * back if it refuses. The refetch afterwards brings the moved estimates —
 * a team marked done frees its slot for the rest.
 */
export function useSetState(offeringId: number) {
  const client = useQueryClient();
  const key = ["presentations", offeringId];
  return useMutation({
    mutationFn: ({ id, state }: { id: string; state: PresentationState }) =>
      api<{ state: PresentationState }>(
        "PATCH",
        `/api/homes/${offeringId}/presentations/${id}/state`,
        { state },
      ),
    onMutate: async ({ id, state }) => {
      await client.cancelQueries({ queryKey: key });
      const before = client.getQueryData<PresentationsPayload>(key);
      if (before) {
        client.setQueryData<PresentationsPayload>(key, {
          ...before,
          presentations: before.presentations.map((one) =>
            one.id === id ? { ...one, state } : one,
          ),
        });
      }
      return { before };
    },
    onError: (_error, _vars, context) => {
      if (context?.before) client.setQueryData(key, context.before);
    },
    // The preview reads states from the database too: an open Cronograma's
    // estimates move with them.
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: key }),
        client.invalidateQueries({ queryKey: ["preview", offeringId] }),
      ]),
  });
}

/** Revoke the session here, then end it at tic-auth too. */
export function useLogout() {
  return useMutation({
    mutationFn: () =>
      api<{ idp_logout_url: string }>("POST", "/api/auth/logout"),
    onSuccess: ({ idp_logout_url }) => window.location.assign(idp_logout_url),
  });
}
