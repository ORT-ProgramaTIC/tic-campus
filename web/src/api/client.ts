/**
 * The one way the web talks to the api. Same origin always — nginx in
 * production, Vite's proxy in dev — so the session is an HttpOnly cookie the
 * browser sends by itself and this file never sees it.
 *
 * Three things every screen would otherwise get wrong once each:
 *
 * - **CSRF is not a cookie.** It lives in the session row and only `/api/me`
 *   hands it out, so every non-GET waits for it and sends `X-CSRF-Token`.
 * - **The error envelope is `{ error: { code, message } }`.** It becomes a
 *   thrown `ApiError` whose `message` is already written for a person.
 * - **A 401 is a login, not an error.** The page goes to `/api/auth/login`
 *   with `next` set to where it was, and comes back there.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let csrf: string | null = null;

/** `/api/me` calls this with what it got, so the first edit does not have to
 *  ask again. */
export function rememberCsrf(token: string): void {
  csrf = token;
}

async function csrfToken(): Promise<string> {
  if (csrf === null) {
    const me = await api<{ csrf_token: string }>("GET", "/api/me");
    csrf = me.csrf_token;
  }
  return csrf;
}

/** Leave for the login and come back here. `next` is same-origin by
 *  construction, which is what the api's `sanitizeNext` requires anyway. */
export function login(): never {
  const here = window.location.pathname + window.location.search;
  window.location.assign(`/api/auth/login?next=${encodeURIComponent(here)}`);
  // The page is leaving; nothing after this should run or render.
  throw new ApiError(401, "no_session", "Iniciando sesión…");
}

export async function api<T>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers["X-CSRF-Token"] = await csrfToken();

  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) login();

  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error = (payload as { error?: { code?: string; message?: string } })
      ?.error;
    // A stale token after a re-login is the one CSRF failure worth retrying:
    // forget it so the next call fetches a fresh one.
    if (error?.code === "csrf_failed") csrf = null;
    throw new ApiError(
      res.status,
      error?.code ?? "http_error",
      error?.message ?? `La api respondió ${res.status}.`,
    );
  }
  return payload as T;
}
