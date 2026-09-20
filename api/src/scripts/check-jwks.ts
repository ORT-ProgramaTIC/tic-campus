import { assertKeySetUsable } from "../auth/jwks.js";
import { loadConfig } from "../config.js";

/**
 * Can this process read tic-auth's key set, through tic-proxy, with the `Host`
 * header that makes tic-proxy answer as tic-auth?
 *
 * **One probe, two callers** — `make smoke` and `bin/doctor.py`'s
 * `auth-reachable` — so the smoke test, the doctor and the application cannot
 * disagree about what "reachable" means. MEV's `make smoke-local` once asked
 * this with an inline `node -e` calling global `fetch`, which drops the `Host`
 * header: it would have failed on deploy day naming tic-auth when the cause was
 * its own HTTP client.
 *
 * It prints the `kid`s it found, because that is the thing being asserted. A
 * status is not: a request that lost its `Host` header gets a 200 from nginx's
 * default server, with a body that is not a key set.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.auth) {
    // Thrown rather than printed, so every failure leaves the same JSON on
    // stdout: `bin/doctor.py` parses it, and a message on stderr would read to
    // it as a check that answered nothing.
    throw new Error(
      "no hay configuración de tic-auth (falta TIC_AUTH_CLIENT_SECRET_FILE), " +
        "así que nadie puede iniciar sesión",
    );
  }
  const { kids } = await assertKeySetUsable({
    url: config.auth.jwksUrl,
    hostHeader: config.auth.jwksHostHeader,
  });
  console.log(
    JSON.stringify({ ok: true, url: config.auth.jwksUrl, kids }, null, 2),
  );
}

void main().catch((cause: unknown) => {
  console.log(
    JSON.stringify({
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
    }),
  );
  process.exit(1);
});
