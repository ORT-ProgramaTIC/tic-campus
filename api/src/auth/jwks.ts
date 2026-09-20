import { createRemoteJWKSet, customFetch, type JWTVerifyGetKey } from "jose";
import { request } from "undici";

/**
 * The JWKS transport, and the single most load-bearing operational fact in this
 * repository. It is MEV's `api/src/auth/jwks.ts`, copied with its reasoning
 * rather than rediscovered — the family shares a contract, not a library.
 *
 * The key set is fetched from `http://tic-proxy/.well-known/jwks.json` carrying
 * `Host: tic-auth.ort.edu.ar` — **never** `https://tic-auth.ort.edu.ar`. That
 * hostname does not resolve from inside the VM: both FortiWeb addresses time
 * out, measured 2026-09-05.
 *
 * **Why this module exists at all: Node's global `fetch` silently DROPS a `Host`
 * header.** `Host` is a forbidden header name in the Fetch spec and undici
 * enforces it, so `fetch(url, {headers: {Host: …}})` sends the socket address
 * instead. That failure is invisible: tic-proxy dispatches on `Host`, so
 * omitting it does not error — nginx serves whatever its default server answers,
 * and a JSON parse failure is the first symptom, several layers from the cause.
 * tic-auth's own smoke test passed against a 404 exactly this way.
 *
 * `undici.request` does send it, so it supplies the transport and `jose` keeps
 * everything else — the cache, the cooldown, and the refetch on an unknown
 * `kid`, which is what tic-auth's rotation needs: a new key is published about
 * five minutes before it signs, and the old one stays published after the
 * switch.
 */
export interface KeySourceOptions {
  url: string;
  /** Omitting this does not error. It serves the wrong thing. */
  hostHeader?: string;
}

/**
 * A `jose` fetch implementation backed by undici, so the `Host` header survives.
 *
 * Deliberately not a general-purpose fetch: it returns only what `jose` reads off
 * the response, and nothing here should grow a second caller.
 */
const undiciFetch = (async (
  url: URL,
  options: { headers: Headers; signal: AbortSignal },
) => {
  const headers: Record<string, string> = {};
  options.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const response = await request(url, {
    method: "GET",
    headers,
    signal: options.signal,
  });
  return {
    ok: response.statusCode >= 200 && response.statusCode < 300,
    status: response.statusCode,
    // `jose` only ever calls `.json()`, and only when `ok`.
    json: () => response.body.json(),
  };
}) as never;

export function createRemoteKeySource(
  options: KeySourceOptions,
): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(options.url), {
    ...(options.hostHeader ? { headers: { host: options.hostHeader } } : {}),
    [customFetch]: undiciFetch,
  });
}

export class JwksError extends Error {}

/**
 * Fetches the key set once and refuses unless a `kid` is present.
 *
 * **Assert a `kid`, never a 200.** A request that lost its `Host` header still
 * gets a 200 — from the wrong server, with a body that is not a key set.
 * Checking the status code proves only that something answered.
 *
 * `make smoke` and `bin/doctor.py`'s `auth-reachable` are the callers, both
 * through `scripts/check-jwks.ts`, so the smoke test, the doctor and the app
 * cannot disagree about what "reachable" means. **`/api/readyz` does NOT call
 * it**, deliberately: that route is about tic-db and the migrations, and adding
 * a network hop to tic-proxy would make it fail off the box, where it is a
 * liveness answer rather than a diagnosis.
 */
export async function assertKeySetUsable(
  options: KeySourceOptions,
): Promise<{ kids: string[] }> {
  const headers: Record<string, string> = options.hostHeader
    ? { host: options.hostHeader }
    : {};

  let body: unknown;
  try {
    const response = await request(options.url, { method: "GET", headers });
    body = await response.body.json();
  } catch (cause) {
    throw new JwksError(
      `no se pudo leer un key set de ${options.url}` +
        (options.hostHeader ? ` (Host: ${options.hostHeader})` : "") +
        `: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const keys =
    typeof body === "object" &&
    body !== null &&
    "keys" in body &&
    Array.isArray(body.keys)
      ? (body.keys as { kid?: unknown }[])
      : [];
  const kids = keys
    .map((key) => key.kid)
    .filter((kid): kid is string => typeof kid === "string");

  if (kids.length === 0) {
    throw new JwksError(
      `${options.url} contestó, pero sin ninguna clave que traiga un \`kid\`. ` +
        (options.hostHeader
          ? `Lo más probable es que el header Host (${options.hostHeader}) no haya ` +
            `llegado a tic-proxy, que despacha por él y cae en su server por defecto — ` +
            `ese contesta 200 con algo que no es un key set. `
          : "") +
        `El cuerpo empieza: ${JSON.stringify(body).slice(0, 200)}`,
    );
  }

  return { kids };
}
