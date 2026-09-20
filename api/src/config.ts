import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Everything this process reads from its environment, validated once at boot.
 *
 * A missing or empty key throws here rather than at whichever query first needs
 * it: a container that refuses to start says what is wrong in its logs, while
 * one that starts and 500s says it in whoever's browser gets there first.
 */
export interface Config {
  port: number;
  /** Decided once, at boot. It is what puts `Secure` on the session cookie and
   *  what makes a missing client secret fatal rather than a laptop. */
  production: boolean;
  /** `campus_svc`'s URL, **without** the password — see `db/client.ts`. */
  databaseUrl: string;
  /** Read from `DATABASE_PASSWORD_FILE`, the mounted secret. */
  databasePassword: string | undefined;
  /**
   * Where the bytes of an upload live (F9) — the container side of the
   * `tic-campus-uploads` compose volume. A laptop gets a directory under
   * `tmpdir()` instead, because `/var/lib` is not writable there and a default
   * that needs `sudo` to try a feature is a default nobody uses.
   */
  uploadsDir: string;
  /**
   * `undefined` when no client secret is configured, which is a laptop with no
   * tic-auth to talk to. The four `/api/auth/*` routes then answer **404** — not
   * 401 and not 503, because a client that met either would keep trying a login
   * that cannot complete. In production this is never `undefined`: `loadConfig`
   * refuses to return without it.
   */
  auth: AuthConfig | undefined;
}

/**
 * tic-campus as a confidential tic-auth client (F3, `tic-auth/docs/CLIENTS.md`).
 *
 * **Two base URLs, and they are not interchangeable.** `issuer` is where a
 * person's *browser* goes — `/authorize` and `/logout` — and it is also the
 * `iss` this process asserts byte for byte. `internalBaseUrl` is where *this
 * process* reaches `/token` and `/revoke`, which is `http://tic-proxy`, because
 * `https://tic-auth.ort.edu.ar` does not resolve from inside the VM at all:
 * both FortiWeb addresses time out, measured 2026-09-05.
 */
export interface AuthConfig {
  issuer: string;
  internalBaseUrl: string;
  jwksUrl: string;
  /** tic-proxy dispatches on it. Omitting it does not error — it serves the
   *  wrong thing, which is why every check here asserts a `kid` and not a 200. */
  jwksHostHeader: string;
  clientId: string;
  clientSecret: string;
  /** Stated by the verifier, **never read out of the token**. */
  audience: string;
  /**
   * **Static, never derived from the request.** nginx terminates at `listen 80`
   * behind two proxies, so a scheme read off a request is `http` on a page the
   * browser loaded over TLS — and tic-auth matches a redirect URI byte for byte,
   * so `http` there is an error page instead of a callback.
   */
  redirectUri: string;
  /** How long a campus session may last, capped again by whatever tic-auth says
   *  the refresh grant is good for. Twelve hours is the SSO session's own life. */
  sessionTtlSeconds: number;
  /** How stale the claims may get before the next request renews them.
   *  840 = 900 − 60: the access token's life, less one clock-skew allowance. The
   *  honest reading is "how long a revoked role keeps working here". */
  claimsMaxAgeSeconds: number;
  /** How long to serve cached claims after tic-auth could not be reached. An
   *  outage must not turn one renewal into one failing call per request. */
  refreshRetrySeconds: number;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`falta ${key} en el entorno — mirá .env.example`);
  return value;
}

function withDefault(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: string,
): string {
  return env[key]?.trim() || fallback;
}

function seconds(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} tiene que ser un entero positivo de segundos`);
  }
  return value;
}

/** A secret read from a file rather than an environment variable, so it does not
 *  show up in `docker inspect`. The same shape as the database password. */
function secretFrom(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const path = env[key]?.trim();
  if (!path) return undefined;
  let value: string;
  try {
    value = readFileSync(path, "utf8").trim();
  } catch (cause) {
    throw new Error(`no se pudo leer ${key} (${path}): ${String(cause)}`);
  }
  if (!value) throw new Error(`${path} está vacío`);
  return value;
}

function loadAuth(
  env: NodeJS.ProcessEnv,
  production: boolean,
): AuthConfig | undefined {
  const clientSecret = secretFrom(env, "TIC_AUTH_CLIENT_SECRET_FILE");
  if (!clientSecret) {
    // A confidential client with no secret is not a public client: tic-auth
    // refuses one at `/token` rather than treating it as public, which is the
    // property that makes the secret mean anything. So in production this is a
    // stack that cannot log anybody in, and it says so here.
    if (production) {
      throw new Error(
        "falta TIC_AUTH_CLIENT_SECRET_FILE — tic-campus es un cliente confidencial " +
          "de tic-auth y sin su secreto no puede canjear ningún código",
      );
    }
    return undefined;
  }

  const issuer = withDefault(
    env,
    "TIC_AUTH_ISSUER",
    "https://tic-auth.ort.edu.ar",
  );
  const jwksUrl = withDefault(
    env,
    "TIC_AUTH_JWKS_URL",
    "http://tic-proxy/.well-known/jwks.json",
  );

  // The JWKS fetched from the issuer's own hostname is the configuration that
  // times out in production and works on a laptop, which is the worst way round.
  // It is refused here rather than discovered on deploy day.
  if (production && new URL(jwksUrl).host === new URL(issuer).host) {
    throw new Error(
      `TIC_AUTH_JWKS_URL apunta a ${new URL(jwksUrl).host}, que es el host del issuer: ` +
        "desde adentro de la VM eso no resuelve. Va por http://tic-proxy con " +
        "TIC_AUTH_JWKS_HOST_HEADER.",
    );
  }

  return {
    issuer,
    internalBaseUrl: withDefault(
      env,
      "TIC_AUTH_INTERNAL_BASE_URL",
      "http://tic-proxy",
    ),
    jwksUrl,
    jwksHostHeader: withDefault(
      env,
      "TIC_AUTH_JWKS_HOST_HEADER",
      "tic-auth.ort.edu.ar",
    ),
    clientId: withDefault(env, "TIC_AUTH_CLIENT_ID", "tic-campus"),
    clientSecret,
    audience: withDefault(env, "TIC_AUTH_AUDIENCE", "tic-campus"),
    redirectUri: required(env, "TIC_AUTH_REDIRECT_URI"),
    sessionTtlSeconds: seconds(env, "SESSION_TTL_SECONDS", 43_200),
    claimsMaxAgeSeconds: seconds(env, "CLAIMS_MAX_AGE_SECONDS", 840),
    refreshRetrySeconds: seconds(env, "REFRESH_RETRY_SECONDS", 60),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // The password is mounted as a FILE rather than passed as a variable, so it
  // does not show up in `docker inspect`. `.env` names the path; compose mounts
  // the secret at it, and renaming one side only fails here with ENOENT.
  const databasePassword = secretFrom(env, "DATABASE_PASSWORD_FILE");
  const production = env.NODE_ENV === "production";

  return {
    port: Number(env.PORT ?? 3000),
    production,
    databaseUrl: required(env, "DATABASE_URL"),
    databasePassword,
    uploadsDir: withDefault(
      env,
      "UPLOADS_DIR",
      production
        ? "/var/lib/tic-campus/uploads"
        : join(tmpdir(), "tic-campus-uploads"),
    ),
    auth: loadAuth(env, production),
  };
}
